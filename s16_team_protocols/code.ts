#!/usr/bin/env tsx
/**
 * s16: Team Protocols — request-response protocol + request_id + dispatch + state machine.
 *
 * Run:  npx tsx s16_team_protocols/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s15:
 *   - ProtocolState dataclass (request_id, type, sender, status, created_at)
 *   - pending_requests dict: tracks in-flight protocol requests
 *   - dispatch_message: routes incoming messages by type to handlers
 *   - request_shutdown: Lead sends shutdown protocol request
 *   - request_plan: Lead asks teammate to submit plan
 *   - handle_shutdown_request / handle_plan_response: teammate receives & responds
 *   - match_response: Lead correlates response to request via request_id (with type validation)
 *   - Teammate idle loop: waits for inbox messages instead of exiting after 10 rounds
 *   - Unified consume_lead_inbox: protocol routing + injection into history
 *   - 3 new Lead tools: request_shutdown, request_plan, review_plan
 *   - 1 new teammate tool: submit_plan
 *
 * ASCII flow:
 *   Lead: BUS.send("shutdown_request", {request_id}) ──────→ teammate inbox
 *   Teammate: dispatch → handler → BUS.send("shutdown_response", {request_id}) ─→ Lead inbox
 *   Lead: consume_lead_inbox → match_response(request_id) → pending_requests[req_id].status = approved
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Anthropic } from "@anthropic-ai/sdk";
import "dotenv/config";

// ── Global Setup ──

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
const MODEL = process.env.MODEL_ID!;

// ── Task System (from s12, synced) ──

const TASKS_DIR = path.join(WORKDIR, ".tasks");
fs.mkdirSync(TASKS_DIR, { recursive: true });

interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;          // pending | in_progress | completed
  owner: string | null;
  blockedBy: string[];
}

function _taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function createTask(subject: string, description: string = "",
                    blockedBy: string[] | null = null): Task {
  const task: Task = {
    id: `task_${Math.floor(Date.now() / 1000)}_${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
    subject, description,
    status: "pending", owner: null,
    blockedBy: blockedBy || [],
  };
  saveTask(task);
  return task;
}

function saveTask(task: Task): void {
  fs.writeFileSync(_taskPath(task.id), JSON.stringify(task, null, 2), "utf-8");
}

function loadTask(taskId: string): Task {
  return JSON.parse(fs.readFileSync(_taskPath(taskId), "utf-8")) as Task;
}

function listTasks(): Task[] {
  const files = fs.readdirSync(TASKS_DIR)
    .filter(f => f.startsWith("task_") && f.endsWith(".json"))
    .sort();
  return files.map(f => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")) as Task);
}

function getTask(taskId: string): string {
  /** Return full task details as JSON. */
  const task = loadTask(taskId);
  return JSON.stringify(task, null, 2);
}

function canStart(taskId: string): boolean {
  /** Check if all blockedBy dependencies are completed.
   *  Missing dependencies are treated as blocked. */
  const task = loadTask(taskId);
  for (const depId of task.blockedBy) {
    if (!fs.existsSync(_taskPath(depId))) {
      return false;
    }
    if (loadTask(depId).status !== "completed") {
      return false;
    }
  }
  return true;
}

function claimTask(taskId: string, owner: string = "agent"): string {
  const task = loadTask(taskId);
  if (task.status !== "pending") {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }
  if (!canStart(taskId)) {
    const deps = task.blockedBy.filter(
      d => !fs.existsSync(_taskPath(d)) || loadTask(d).status !== "completed"
    );
    return `Blocked by: ${deps}`;
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  console.log(`  \x1b[36m[claim] ${task.subject} → in_progress (owner: ${owner})\x1b[0m`);
  return `Claimed ${task.id} (${task.subject})`;
}

function completeTask(taskId: string): string {
  const task = loadTask(taskId);
  if (task.status !== "in_progress") {
    return `Task ${taskId} is ${task.status}, cannot complete`;
  }
  task.status = "completed";
  saveTask(task);
  const unblocked = listTasks()
    .filter(t => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map(t => t.subject);
  console.log(`  \x1b[32m[complete] ${task.subject} ✓\x1b[0m`);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length > 0) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
    console.log(`  \x1b[33m[unblocked] ${unblocked.join(", ")}\x1b[0m`);
  }
  return msg;
}

// ── Prompt Assembly (from s10, synced) ──

const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file, " +
         "get_task, create_task, list_tasks, claim_task, complete_task, " +
         "spawn_teammate, send_message, check_inbox, " +
         "request_shutdown, request_plan, review_plan.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

function assembleSystemPrompt(context: Record<string, unknown>): string {
  const sections = [PROMPT_SECTIONS.identity,
                    PROMPT_SECTIONS.tools,
                    PROMPT_SECTIONS.workspace];
  const memories = context["memories"] as string || "";
  if (memories) {
    sections.push(`Relevant memories:\n${memories}`);
  }
  return sections.join("\n\n");
}

let _lastContextKey: string | null = null;
let _lastPrompt: string | null = null;

function getSystemPrompt(context: Record<string, unknown>): string {
  const key = JSON.stringify(context, Object.keys(context).sort());
  if (key === _lastContextKey && _lastPrompt) {
    return _lastPrompt;
  }
  _lastContextKey = key;
  _lastPrompt = assembleSystemPrompt(context);
  return _lastPrompt;
}

// ── Tools ──

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string, runInBackground: boolean = false): string {
  // run_in_background is handled by agent_loop dispatch, not here
  try {
    const out = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const result = out.trim();
    return result ? result.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed || e.code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    return (e.stdout || "") + (e.stderr || "") || "(no output)";
  }
}

function runRead(p: string, limit: number | null = null): string {
  try {
    const lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// Task tools

function runCreateTask(subject: string, description: string = "",
                       blockedBy: string[] | null = null): string {
  const task = createTask(subject, description, blockedBy);
  const deps = blockedBy ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (tasks.length === 0) {
    return "No tasks. Use create_task to add some.";
  }
  const icons: Record<string, string> = { pending: "○", in_progress: "●", completed: "✓" };
  return tasks.map(t => {
    const icon = icons[t.status] || "?";
    const deps = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.join(", ")})` : "";
    const owner = t.owner ? ` [${t.owner}]` : "";
    return `  ${icon} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`;
  }).join("\n");
}

function runGetTask(taskId: string): string {
  try {
    return getTask(taskId);
  } catch {
    return `Error: Task ${taskId} not found`;
  }
}

function runClaimTask(taskId: string): string {
  return claimTask(taskId, "agent");
}

function runCompleteTask(taskId: string): string {
  return completeTask(taskId);
}

// ── Background Tasks (from s13, synced) ──

let _bgCounter = 0;
const backgroundTasks: Record<string, { tool_use_id: string; command: string; status: string }> = {};
const backgroundResults: Record<string, string> = {};

// Simple mutex implementation for teaching
class Mutex {
  private _locked = false;
  private _queue: (() => void)[] = [];

  lock(): Promise<void> {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  unlock(): void {
    if (this._queue.length > 0) {
      this._queue.shift()!();
    } else {
      this._locked = false;
    }
  }

  runWith<T>(fn: () => T): T {
    // Synchronous critical section
    while (this._locked) { /* busy-wait — teaching, not production */ }
    this._locked = true;
    try {
      return fn();
    } finally {
      this.unlock();
    }
  }
}

const backgroundLock = new Mutex();

function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  /** Fallback heuristic: commands likely to take > 30s. */
  if (toolName !== "bash") return false;
  const cmd = (toolInput["command"] as string || "").toLowerCase();
  const slowKeywords = ["install", "build", "test", "deploy", "compile",
                        "docker build", "pip install", "npm install",
                        "cargo build", "pytest", "make"];
  return slowKeywords.some(kw => cmd.includes(kw));
}

function shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  /** Model explicit request takes priority; fallback to heuristic. */
  if (toolInput["run_in_background"]) return true;
  return isSlowOperation(toolName, toolInput);
}

function startBackgroundTask(block: any): string {
  /** Run tool in a background task. Returns background task ID. */
  _bgCounter += 1;
  const bgId = `bg_${String(_bgCounter).padStart(4, "0")}`;
  const cmd = block.input["command"] || block.name;

  backgroundLock.runWith(() => {
    backgroundTasks[bgId] = {
      tool_use_id: block.id,
      command: cmd,
      status: "running",
    };
  });

  // Run in background (setTimeout simulates daemon thread)
  setTimeout(() => {
    const result = executeTool(block);
    backgroundLock.runWith(() => {
      backgroundTasks[bgId].status = "completed";
      backgroundResults[bgId] = result;
    });
  }, 0);

  console.log(`  \x1b[33m[background] dispatched ${bgId}: ${cmd.slice(0, 40)}\x1b[0m`);
  return bgId;
}

function collectBackgroundResults(): string[] {
  /** Collect completed background results as task_notification messages. */
  const readyIds: string[] = [];
  backgroundLock.runWith(() => {
    for (const [bid, task] of Object.entries(backgroundTasks)) {
      if (task.status === "completed") readyIds.push(bid);
    }
  });

  const notifications: string[] = [];
  for (const bgId of readyIds) {
    let task: any, output: string;
    backgroundLock.runWith(() => {
      task = backgroundTasks[bgId];
      delete backgroundTasks[bgId];
      output = backgroundResults[bgId] || "";
      delete backgroundResults[bgId];
    });
    const summary = output.length > 200 ? output.slice(0, 200) : output;
    notifications.push(
      `<task_notification>\n` +
      `  <task_id>${bgId}</task_id>\n` +
      `  <status>completed</status>\n` +
      `  <command>${task.command}</command>\n` +
      `  <summary>${summary}</summary>\n` +
      `</task_notification>`
    );
    console.log(`  \x1b[32m[background done] ${bgId}: ` +
                `${task.command.slice(0, 40)} (${output.length} chars)\x1b[0m`);
  }
  return notifications;
}

// ── MessageBus (from s15) ──

const MAILBOX_DIR = path.join(WORKDIR, ".mailboxes");
fs.mkdirSync(MAILBOX_DIR, { recursive: true });

interface BusMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, unknown>;
}

class MessageBus {
  /** File-based message bus. Each agent has a .jsonl inbox.
   *  Read is destructive: readFile + unlink (consumes messages).
   *  Teaching version: no file locking; real CC uses proper-lockfile. */

  send(fromAgent: string, toAgent: string, content: string,
       msgType: string = "message", metadata: Record<string, unknown> = {}): void {
    const msg: BusMessage = {
      from: fromAgent, to: toAgent,
      content, type: msgType,
      ts: Date.now() / 1000, metadata: metadata || {},
    };
    const inbox = path.join(MAILBOX_DIR, `${toAgent}.jsonl`);
    fs.appendFileSync(inbox, JSON.stringify(msg) + "\n", "utf-8");
    console.log(`  \x1b[33m[bus] ${fromAgent} → ${toAgent}: ` +
                `(${msgType}) ${content.slice(0, 50)}\x1b[0m`);
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const text = fs.readFileSync(inbox, "utf-8");
    const msgs = text.split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as BusMessage);
    fs.unlinkSync(inbox);  // consume: read + delete
    return msgs;
  }
}

const BUS = new MessageBus();
const activeTeammates: Record<string, boolean> = {};

// ── Protocol State (s16 new) ──

interface ProtocolState {
  request_id: string;
  type: string;       // "shutdown" | "plan_approval"
  sender: string;
  target: string;
  status: string;     // pending | approved | rejected
  payload: string;    // plan text or shutdown reason
  created_at: number;
}

function createProtocolState(
  request_id: string, type: string,
  sender: string, target: string,
  status: string, payload: string,
): ProtocolState {
  return {
    request_id, type, sender, target,
    status, payload,
    created_at: Date.now() / 1000,
  };
}

const pendingRequests: Record<string, ProtocolState> = {};

function newRequestId(): string {
  return `req_${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
}

function matchResponse(responseType: string, requestId: string, approve: boolean): void {
  /** Correlate a response to the original request via request_id.
   *  Validates that response_type matches the request type. */
  const state = pendingRequests[requestId];
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return;
  }
  // Validate response type matches request type
  if (state.type === "shutdown" && responseType !== "shutdown_response") {
    console.log(`  \x1b[31m[protocol] type mismatch: expected shutdown_response, ` +
                `got ${responseType}\x1b[0m`);
    return;
  }
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") {
    console.log(`  \x1b[31m[protocol] type mismatch: expected plan_approval_response, ` +
                `got ${responseType}\x1b[0m`);
    return;
  }
  if (state.status !== "pending") {
    console.log(`  \x1b[33m[protocol] ${requestId} already ${state.status}, ` +
                `ignoring duplicate\x1b[0m`);
    return;
  }
  state.status = approve ? "approved" : "rejected";
  const icon = approve ? "✓" : "✗";
  const color = approve ? "32" : "31";
  console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} ` +
              `(${requestId}: ${state.status})\x1b[0m`);
}

// ── Unified Lead Inbox Consumer (s16 fix) ──
// Both check_inbox tool and main loop call this function.
// Protocol responses are routed via match_response before returning.

function consumeLeadInbox(routeProtocol: boolean = true): BusMessage[] {
  /** Read Lead's inbox. Route protocol responses, return all messages.
   *  Called by both runCheckInbox() and main loop to avoid
   *  messages being consumed without protocol routing. */
  const msgs = BUS.readInbox("lead");
  if (msgs.length === 0) return [];
  if (routeProtocol) {
    for (const msg of msgs) {
      const meta = msg.metadata || {};
      const reqId = meta["request_id"] as string || "";
      const msgType = msg.type || "";
      if (reqId && msgType.endsWith("_response")) {
        const approve = !!meta["approve"];
        matchResponse(msgType, reqId, approve);
      }
    }
  }
  return msgs;
}

// ── Teammate Thread (s16: idle loop + dispatch) ──

function spawnTeammateThread(name: string, role: string, prompt: string): string {
  /** Spawn a teammate agent in a background thread.
   *  Uses idle loop: after each LLM turn, waits for inbox messages
   *  (shutdown_request, new task) instead of exiting. */
  if (name in activeTeammates) {
    return `Teammate '${name}' already exists`;
  }

  const system = `You are '${name}', a ${role}. ` +
                 `Use tools to complete tasks. ` +
                 `Check inbox for protocol messages (shutdown_request, etc).`;

  function handleInboxMessage(name: string, msg: BusMessage, messages: any[]): boolean {
    /** Dispatch incoming protocol messages by type.
     *  Returns true if teammate should stop. */
    const msgType = msg.type || "message";
    const meta = msg.metadata || {};
    const reqId = meta["request_id"] as string || "";

    if (msgType === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down gracefully.",
               "shutdown_response",
               { request_id: reqId, approve: true });
      console.log(`  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`);
      return true;  // stop the loop
    }

    if (msgType === "plan_approval_response") {
      const approve = !!meta["approve"];
      if (approve) {
        messages.push({ role: "user",
          content: "[Plan approved] Proceed with the task." });
      } else {
        messages.push({ role: "user",
          content: `[Plan rejected] Feedback: ${msg.content}` });
      }
    }

    return false;  // continue
  }

  async function run(): Promise<void> {
    const messages: any[] = [{ role: "user", content: prompt }];
    const subTools: any[] = [
      { name: "bash", description: "Run a shell command.",
        input_schema: { type: "object",
                        properties: { command: { type: "string" } },
                        required: ["command"] } },
      { name: "read_file", description: "Read file.",
        input_schema: { type: "object",
                        properties: { path: { type: "string" } },
                        required: ["path"] } },
      { name: "write_file", description: "Write file.",
        input_schema: { type: "object",
                        properties: { path: { type: "string" },
                                      content: { type: "string" } },
                        required: ["path", "content"] } },
      { name: "send_message",
        description: "Send message to another agent.",
        input_schema: { type: "object",
                        properties: { to: { type: "string" },
                                      content: { type: "string" } },
                        required: ["to", "content"] } },
      { name: "submit_plan",
        description: "Submit a plan for Lead approval.",
        input_schema: { type: "object",
                        properties: { plan: { type: "string" } },
                        required: ["plan"] } },
    ];
    const subHandlers: Record<string, Function> = {
      bash: runBash, read_file: runRead, write_file: runWrite,
      send_message: (to: string, content: string) => {
        BUS.send(name, to, content);
        return "Sent";
      },
      submit_plan: (plan: string) => _teammateSubmitPlan(name, plan),
    };

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    let shutdownRequested = false;
    while (!shutdownRequested) {
      // Check inbox for protocol messages
      const inbox = BUS.readInbox(name);
      let shouldStop = false;
      const nonProtocol: BusMessage[] = [];
      for (const msg of inbox) {
        if (msg.type === "shutdown_request" || msg.type === "plan_approval_response") {
          shouldStop = handleInboxMessage(name, msg, messages);
          if (shouldStop) break;
        } else {
          nonProtocol.push(msg);
        }
      }
      if (shouldStop) {
        shutdownRequested = true;
        break;
      }
      if (nonProtocol.length > 0) {
        const inboxJson = JSON.stringify(nonProtocol);
        messages.push({ role: "user",
          content: `<inbox>${inboxJson}</inbox>` });
      }

      // LLM turn
      let response: any;
      try {
        response = await client.messages.create({
          model: MODEL, system, messages: messages.slice(-20),
          tools: subTools, max_tokens: 8000,
        });
      } catch {
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") {
        // Idle: wait for inbox messages instead of exiting
        while (!shutdownRequested) {
          await sleep(1000);
          const idleInbox = BUS.readInbox(name);
          if (idleInbox.length === 0) continue;
          const idleNonProtocol: BusMessage[] = [];
          for (const msg of idleInbox) {
            if (msg.type === "shutdown_request" || msg.type === "plan_approval_response") {
              const stop = handleInboxMessage(name, msg, messages);
              if (stop) {
                shutdownRequested = true;
                break;
              }
            } else {
              idleNonProtocol.push(msg);
            }
          }
          if (shutdownRequested) break;
          if (idleNonProtocol.length > 0) {
            const inboxJson = JSON.stringify(idleNonProtocol);
            messages.push({ role: "user",
              content: `<inbox>${inboxJson}</inbox>` });
            break;  // back to LLM turn with new messages
          }
        }
        continue;
      }

      // Execute tool calls
      const results: any[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const handler = subHandlers[block.name];
          const output = handler
            ? handler(...Object.values(block.input))
            : "Unknown";
          results.push({ type: "tool_result",
                         tool_use_id: block.id,
                         content: String(output) });
        }
      }
      messages.push({ role: "user", content: results });
    }

    // Send final summary to Lead
    let summary = "Done.";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        let found = false;
        for (const b of msg.content) {
          if (b.type === "text") { summary = b.text; found = true; break; }
        }
        if (found) break;
      }
    }
    BUS.send(name, "lead", summary, "result");
    delete activeTeammates[name];
    console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`);
  }

  activeTeammates[name] = true;
  // In Node.js, use setTimeout to simulate daemon thread
  setTimeout(() => { run().catch(console.error); }, 0);
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role}`;
}

function _teammateSubmitPlan(fromName: string, plan: string): string {
  /** Teammate submits a plan to Lead for approval. */
  const reqId = newRequestId();
  pendingRequests[reqId] = createProtocolState(
    reqId, "plan_approval",
    fromName, "lead",
    "pending", plan);
  BUS.send(fromName, "lead", plan,
           "plan_approval_request",
           { request_id: reqId });
  return `Plan submitted (${reqId}). Waiting for approval...`;
}

// ── Lead Protocol Tools (s16 new) ──

function runRequestShutdown(teammate: string): string {
  const reqId = newRequestId();
  pendingRequests[reqId] = createProtocolState(
    reqId, "shutdown",
    "lead", teammate,
    "pending", "");
  BUS.send("lead", teammate, "Please shut down gracefully.",
           "shutdown_request",
           { request_id: reqId });
  console.log(`  \x1b[35m[protocol] shutdown_request → ${teammate} (${reqId})\x1b[0m`);
  return `Shutdown request sent to ${teammate} (req: ${reqId})`;
}

function runRequestPlan(teammate: string, task: string): string {
  /** Lead asks a teammate to submit a plan for a task. */
  BUS.send("lead", teammate, `Please submit a plan for: ${task}`,
           "message");
  return `Asked ${teammate} to submit a plan`;
}

function runReviewPlan(requestId: string, approve: boolean, feedback: string = ""): string {
  const state = pendingRequests[requestId];
  if (!state) {
    return `Request ${requestId} not found`;
  }
  if (state.status !== "pending") {
    return `Request ${requestId} already ${state.status}`;
  }
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"),
           "plan_approval_response",
           { request_id: requestId, approve });
  const icon = approve ? "✓" : "✗";
  console.log(`  \x1b[32m[protocol] plan ${icon} (${requestId})\x1b[0m`);
  return `Plan ${approve ? "approved" : "rejected"} (${requestId})`;
}

// ── Other Lead Tool Handlers ──

function runSpawnTeammate(name: string, role: string, prompt: string): string {
  return spawnTeammateThread(name, role, prompt);
}

function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

function runCheckInbox(): string {
  /** Check Lead's inbox. Routes protocol responses via match_response. */
  const msgs = consumeLeadInbox(true);
  if (msgs.length === 0) {
    return "(inbox empty)";
  }
  return msgs.map(m => {
    const meta = m.metadata || {};
    const reqId = meta["request_id"] as string || "";
    const tag = reqId ? ` [${m.type} req:${reqId}]` : ` [${m.type}]`;
    return `  [${m.from}]${tag} ${m.content.slice(0, 200)}`;
  }).join("\n");
}

// ── Tool Dispatch ──

function executeTool(block: any): string {
  /** Execute a tool call block, return output. */
  const handlers: Record<string, Function> = {
    bash: runBash, read_file: runRead, write_file: runWrite,
    create_task: runCreateTask, list_tasks: runListTasks,
    get_task: runGetTask, claim_task: runClaimTask,
    complete_task: runCompleteTask,
    spawn_teammate: runSpawnTeammate,
    send_message: runSendMessage, check_inbox: runCheckInbox,
    request_shutdown: runRequestShutdown,
    request_plan: runRequestPlan, review_plan: runReviewPlan,
  };
  const handler = handlers[block.name];
  if (handler) {
    return handler.call(null, ...Object.values(block.input));
  }
  return `Unknown tool: ${block.name}`;
}

// ── Tool Definitions ──

const TOOLS: any[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object",
                    properties: {
                      command: { type: "string" },
                      run_in_background: { type: "boolean" } },
                    required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object",
                    properties: { path: { type: "string" },
                                  limit: { type: "integer" } },
                    required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object",
                    properties: { path: { type: "string" },
                                  content: { type: "string" } },
                    required: ["path", "content"] } },
  { name: "create_task",
    description: "Create a new task with optional blockedBy dependencies.",
    input_schema: { type: "object",
                    properties: {
                      subject: { type: "string" },
                      description: { type: "string" },
                      blockedBy: { type: "array",
                                   items: { type: "string" } } },
                    required: ["subject"] } },
  { name: "list_tasks",
    description: "List all tasks with status, owner, and dependencies.",
    input_schema: { type: "object", properties: {},
                    required: [] } },
  { name: "get_task",
    description: "Get full details of a specific task by ID.",
    input_schema: { type: "object",
                    properties: { task_id: { type: "string" } },
                    required: ["task_id"] } },
  { name: "claim_task",
    description: "Claim a pending task. Sets owner, changes status to in_progress.",
    input_schema: { type: "object",
                    properties: { task_id: { type: "string" } },
                    required: ["task_id"] } },
  { name: "complete_task",
    description: "Complete an in-progress task. Reports unblocked downstream tasks.",
    input_schema: { type: "object",
                    properties: { task_id: { type: "string" } },
                    required: ["task_id"] } },
  { name: "spawn_teammate",
    description: "Spawn a teammate agent in a background thread.",
    input_schema: { type: "object",
                    properties: {
                      name: { type: "string" },
                      role: { type: "string" },
                      prompt: { type: "string" } },
                    required: ["name", "role", "prompt"] } },
  { name: "send_message",
    description: "Send message to a teammate via MessageBus.",
    input_schema: { type: "object",
                    properties: { to: { type: "string" },
                                  content: { type: "string" } },
                    required: ["to", "content"] } },
  { name: "check_inbox",
    description: "Check Lead's inbox. Routes protocol responses automatically.",
    input_schema: { type: "object", properties: {},
                    required: [] } },
  { name: "request_shutdown",
    description: "Request a teammate to shut down gracefully.",
    input_schema: { type: "object",
                    properties: { teammate: { type: "string" } },
                    required: ["teammate"] } },
  { name: "request_plan",
    description: "Ask a teammate to submit a plan for review.",
    input_schema: { type: "object",
                    properties: { teammate: { type: "string" },
                                  task: { type: "string" } },
                    required: ["teammate", "task"] } },
  { name: "review_plan",
    description: "Approve or reject a submitted plan by request_id.",
    input_schema: { type: "object",
                    properties: {
                      request_id: { type: "string" },
                      approve: { type: "boolean" },
                      feedback: { type: "string" } },
                    required: ["request_id", "approve"] } },
];

// ── Context ──

function updateContext(context: Record<string, unknown>, messages: any[]): Record<string, unknown> {
  /** Derive context from real state. */
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    const content = fs.readFileSync(MEMORY_INDEX, "utf-8").trim();
    if (content) memories = content;
  }
  return {
    enabled_tools: TOOLS.map(t => t.name),
    workspace: WORKDIR,
    memories,
  };
}

// ── Agent Loop ──

async function agentLoop(messages: any[], context: Record<string, unknown>): Promise<void> {
  let system = getSystemPrompt(context);
  while (true) {
    let response: any;
    try {
      response = await client.messages.create({
        model: MODEL, system, messages,
        tools: TOOLS, max_tokens: 8000,
      });
    } catch (e: any) {
      messages.push({ role: "assistant", content: [
        { type: "text", text: `[Error] ${e.constructor?.name || "Error"}: ${e.message}` }] });
      return;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      if (shouldRunBackground(block.name, block.input)) {
        const bgId = startBackgroundTask(block);
        results.push({ type: "tool_result",
                       tool_use_id: block.id,
                       content: `[Background task ${bgId} started] ` +
                                `Result will be available when complete.` });
      } else {
        const output = executeTool(block);
        console.log(String(output).slice(0, 300));
        results.push({ type: "tool_result",
                       tool_use_id: block.id,
                       content: output });
      }
    }

    // Merge background tool results + notifications into one user message
    const userContent = [...results];
    const bgNotifications = collectBackgroundResults();
    if (bgNotifications.length > 0) {
      for (const notif of bgNotifications) {
        userContent.push({ type: "text", text: notif });
      }
    }
    messages.push({ role: "user", content: userContent });
    context = updateContext(context, messages);
    system = getSystemPrompt(context);
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log("s16: team protocols");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: any[] = [];
  let context = updateContext({}, []);

  const askQuestion = (): Promise<string> => {
    return new Promise(resolve => {
      rl.question("\x1b[36ms16 >> \x1b[0m", (answer) => {
        resolve(answer);
      });
    });
  };

  while (true) {
    let query: string;
    try {
      query = await askQuestion();
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
      break;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history, context);
    context = updateContext(context, history);
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") {
          console.log(block.text);
        }
      }
    }

    // Check inbox → route protocol + inject into history
    const inboxMsgs = consumeLeadInbox(true);
    if (inboxMsgs.length > 0) {
      const inboxText = inboxMsgs
        .map(m => `From ${m.from}: ${m.content.slice(0, 200)}`)
        .join("\n");
      history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
      console.log(`\n\x1b[33m[Inbox: ${inboxMsgs.length} messages injected]\x1b[0m`);
    }
    console.log();
  }

  rl.close();
}

main().catch(console.error);
