#!/usr/bin/env tsx
/**
 * s17: Autonomous Agents — idle poll + auto-claim + WORK/IDLE lifecycle.
 *
 * Run:  npx tsx s17_autonomous_agents/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s16:
 *   - scan_unclaimed_tasks: find pending, unowned tasks with deps completed
 *   - idle_poll: 60s polling loop (inbox + task board), dispatches shutdown in IDLE
 *   - claim_task: owner check + return value verification
 *   - Teammate lifecycle: WORK → IDLE → SHUTDOWN
 *   - Teammate tools: + list_tasks, claim_task, complete_task (5→8)
 *   - consume_lead_inbox: unified inbox consumer for protocol + context injection
 *   - Identity re-injection after context compression
 *
 * ASCII lifecycle:
 *   WORK: inbox → LLM → tools → (tool_use? loop) → (done? → IDLE)
 *   IDLE: 5s poll → inbox? → WORK / unclaimed? → claim → WORK / 60s? → SHUTDOWN
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Anthropic } from "@anthropic-ai/sdk";
import "dotenv/config";

// ── Global Setup ──

const WORKDIR = process.cwd();
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
const MODEL = process.env.MODEL_ID!;

// ── Task System (from s12) ──

const TASKS_DIR = path.join(WORKDIR, ".tasks");
fs.mkdirSync(TASKS_DIR, { recursive: true });

interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;
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
  const task = loadTask(taskId);
  return JSON.stringify(task, null, 2);
}

function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  for (const depId of task.blockedBy) {
    if (!fs.existsSync(_taskPath(depId))) return false;
    if (loadTask(depId).status !== "completed") return false;
  }
  return true;
}

function claimTask(taskId: string, owner: string = "agent"): string {
  const task = loadTask(taskId);
  if (task.status !== "pending") {
    return `Task ${taskId} is ${task.status}, cannot claim`;
  }
  if (task.owner) {
    return `Task ${taskId} already owned by ${task.owner}`;
  }
  if (!canStart(taskId)) {
    const deps = task.blockedBy.filter(
      d => fs.existsSync(_taskPath(d)) && loadTask(d).status !== "completed"
    );
    const missing = task.blockedBy.filter(d => !fs.existsSync(_taskPath(d)));
    const parts: string[] = [];
    if (deps.length > 0) parts.push(`blocked by: ${deps}`);
    if (missing.length > 0) parts.push(`missing deps: ${missing}`);
    return "Cannot start — " + parts.join(", ");
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  console.log(`  \x1b[36m[claim] ${task.subject} → in_progress\x1b[0m`);
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
  }
  return msg;
}

// ── Prompt Assembly (from s10) ──

const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file, " +
         "create_task, list_tasks, get_task, claim_task, complete_task, " +
         "spawn_teammate, send_message, check_inbox, " +
         "request_shutdown, request_plan, review_plan.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

function assembleSystemPrompt(context: Record<string, unknown>): string {
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
  if (context["memories"]) {
    sections.push(`Relevant memories:\n${context["memories"]}`);
  }
  return sections.join("\n\n");
}

let _lastContextHash: string | null = null;
let _lastPrompt: string | null = null;

function getSystemPrompt(context: Record<string, unknown>): string {
  const h = JSON.stringify(context, Object.keys(context).sort());
  if (h === _lastContextHash && _lastPrompt) return _lastPrompt;
  _lastContextHash = h;
  _lastPrompt = assembleSystemPrompt(context);
  return _lastPrompt;
}

// ── Tools (from s15) ──

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  try {
    const out = execSync(command, {
      cwd: WORKDIR, timeout: 120000, encoding: "utf-8", stdio: "pipe",
    });
    const result = out.trim();
    return result ? result.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed || e.code === "ETIMEDOUT") return "Error: Timeout (120s)";
    const out = (e.stdout || "") + (e.stderr || "");
    return out.trim().slice(0, 50000) || "(no output)";
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
  send(fromAgent: string, toAgent: string, content: string,
       msgType: string = "message", metadata: Record<string, unknown> = {}): void {
    const msg: BusMessage = {
      from: fromAgent, to: toAgent, content, type: msgType,
      ts: Date.now() / 1000, metadata: metadata || {},
    };
    const inbox = path.join(MAILBOX_DIR, `${toAgent}.jsonl`);
    fs.appendFileSync(inbox, JSON.stringify(msg) + "\n", "utf-8");
    console.log(`  \x1b[33m[bus] ${fromAgent} → ${toAgent}: (${msgType}) ${content.slice(0, 50)}\x1b[0m`);
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const text = fs.readFileSync(inbox, "utf-8");
    const msgs = text.split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as BusMessage);
    fs.unlinkSync(inbox);
    return msgs;
  }
}

const BUS = new MessageBus();
const activeTeammates: Record<string, boolean> = {};

// ── Protocol State (from s16) ──

interface ProtocolState {
  request_id: string;
  type: string;
  sender: string;
  target: string;
  status: string;
  payload: string;
  created_at: number;
}

function createProtocolState(
  request_id: string, type: string,
  sender: string, target: string,
  status: string, payload: string,
): ProtocolState {
  return { request_id, type, sender, target, status, payload, created_at: Date.now() / 1000 };
}

const pendingRequests: Record<string, ProtocolState> = {};

function newRequestId(): string {
  return `req_${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
}

function matchResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests[requestId];
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return;
  }
  if (state.type === "shutdown" && responseType !== "shutdown_response") {
    console.log(`  \x1b[31m[protocol] type mismatch: expected shutdown_response, got ${responseType}\x1b[0m`);
    return;
  }
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") {
    console.log(`  \x1b[31m[protocol] type mismatch: expected plan_approval_response, got ${responseType}\x1b[0m`);
    return;
  }
  state.status = approve ? "approved" : "rejected";
  const icon = approve ? "✓" : "✗";
  const color = approve ? "32" : "31";
  console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId}: ${state.status})\x1b[0m`);
}

// ── Autonomous Agent (s17 new) ──

const IDLE_POLL_INTERVAL = 5;   // seconds
const IDLE_TIMEOUT = 60;         // seconds

function scanUnclaimedTasks(): Record<string, unknown>[] {
  /** Find pending, unowned tasks with all dependencies completed. */
  const unclaimed: Record<string, unknown>[] = [];
  const files = fs.readdirSync(TASKS_DIR)
    .filter(f => f.startsWith("task_") && f.endsWith(".json"))
    .sort();
  for (const f of files) {
    const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
    if (task.status === "pending" && !task.owner && canStart(task.id)) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

function sleep(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

async function idlePoll(agentName: string, messages: any[],
                        name: string, role: string): Promise<string> {
  /** Poll for 60s. Return 'work', 'shutdown', or 'timeout'. */
  for (let i = 0; i < Math.floor(IDLE_TIMEOUT / IDLE_POLL_INTERVAL); i++) {
    await sleep(IDLE_POLL_INTERVAL);

    // Check inbox — dispatch protocol messages first
    const inbox = BUS.readInbox(agentName);
    if (inbox.length > 0) {
      // Check for shutdown_request
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          const reqId = (msg.metadata || {})["request_id"] as string || "";
          BUS.send(name, "lead", "Shutting down gracefully.",
                   "shutdown_response", { request_id: reqId, approve: true });
          console.log(`  \x1b[35m[protocol] ${name} approved shutdown in idle (${reqId})\x1b[0m`);
          return "shutdown";
        }
      }

      // Non-protocol inbox: inject and resume work
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
      console.log(`  \x1b[36m[idle] ${name} found inbox messages\x1b[0m`);
      return "work";
    }

    // Scan task board
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length > 0) {
      const task = unclaimed[0];
      const result = claimTask(task.id as string, agentName);
      if (result.includes("Claimed")) {
        messages.push({ role: "user",
          content: `<auto-claimed>Task ${task.id}: ${task.subject}</auto-claimed>` });
        console.log(`  \x1b[32m[idle] ${name} auto-claimed: ${task.subject}\x1b[0m`);
        return "work";
      }
      console.log(`  \x1b[33m[idle] ${name} claim failed: ${result}\x1b[0m`);
    }
  }

  console.log(`  \x1b[31m[idle] ${name} timeout (${IDLE_TIMEOUT}s)\x1b[0m`);
  return "timeout";
}

// ── Teammate Thread (from s15 + s16 + s17) ──

function spawnTeammateThread(name: string, role: string, prompt: string): string {
  if (name in activeTeammates) {
    return `Teammate '${name}' already exists`;
  }

  const system = `You are '${name}', a ${role}. ` +
                 `Use tools to complete tasks. ` +
                 `You can list and claim tasks from the board. ` +
                 `Check inbox for protocol messages.`;

  function handleInboxMessage(name: string, msg: BusMessage, messages: any[]): boolean {
    const msgType = msg.type || "message";
    const meta = msg.metadata || {};
    const reqId = meta["request_id"] as string || "";

    if (msgType === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down gracefully.",
               "shutdown_response", { request_id: reqId, approve: true });
      console.log(`  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`);
      return true;
    }

    if (msgType === "plan_approval_response") {
      const approve = !!meta["approve"];
      if (approve) {
        messages.push({ role: "user", content: "[Plan approved] Proceed with the task." });
      } else {
        messages.push({ role: "user", content: `[Plan rejected] Feedback: ${msg.content}` });
      }
    }
    return false;
  }

  async function run(): Promise<void> {
    const messages: any[] = [{ role: "user", content: prompt }];
    const subTools: any[] = [
      { name: "bash", description: "Run a shell command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write file.",
        input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "send_message", description: "Send message to another agent.",
        input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
      { name: "submit_plan", description: "Submit a plan for Lead approval.",
        input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
      // s17 new: teammates can list, claim, and complete tasks
      { name: "list_tasks", description: "List all tasks on the board.",
        input_schema: { type: "object", properties: {}, required: [] } },
      { name: "claim_task", description: "Claim a pending task.",
        input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
      { name: "complete_task", description: "Mark an in-progress task as completed.",
        input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
    ];

    function _runListTasks(): string {
      const tasks = listTasks();
      if (tasks.length === 0) return "No tasks.";
      return tasks.map(t => `  ${t.id}: ${t.subject} [${t.status}]`).join("\n");
    }
    function _runClaimTask(taskId: string): string { return claimTask(taskId, name); }
    function _runCompleteTask(taskId: string): string { return completeTask(taskId); }

    const subHandlers: Record<string, Function> = {
      bash: runBash, read_file: runRead, write_file: runWrite,
      send_message: (to: string, content: string) => { BUS.send(name, to, content); return "Sent"; },
      submit_plan: (plan: string) => _teammateSubmitPlan(name, plan),
      list_tasks: _runListTasks, claim_task: _runClaimTask, complete_task: _runCompleteTask,
    };

    // Outer loop: WORK → IDLE cycle
    while (true) {
      // Identity re-injection (s17)
      if (messages.length <= 3) {
        messages.unshift({ role: "user",
          content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>` });
      }

      // WORK phase
      let shouldShutdown = false;
      for (let round = 0; round < 10; round++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          const stopped = handleInboxMessage(name, msg, messages);
          if (stopped) { shouldShutdown = true; break; }
        }
        if (shouldShutdown) break;
        if (inbox.length > 0 && !shouldShutdown) {
          const nonProtocol = inbox.filter(m => m.type === "message");
          if (nonProtocol.length > 0) {
            messages.push({ role: "user", content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` });
          }
        }

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
        if (response.stop_reason !== "tool_use") break;

        const results: any[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            const handler = subHandlers[block.name];
            const output = handler ? handler(...Object.values(block.input)) : "Unknown";
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: "user", content: results });
      }

      if (shouldShutdown) break;

      // IDLE phase (s17 new)
      const idleResult = await idlePoll(name, messages, name, role);
      if (idleResult === "shutdown" || idleResult === "timeout") break;
    }

    // Summary
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
  setTimeout(() => { run().catch(console.error); }, 0);
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role} (autonomous)`;
}

function _teammateSubmitPlan(fromName: string, plan: string): string {
  /** Teammate submits a plan to Lead for approval. */
  const reqId = newRequestId();
  pendingRequests[reqId] = createProtocolState(
    reqId, "plan_approval", fromName, "lead", "pending", plan);
  BUS.send(fromName, "lead", plan, "plan_approval_request", { request_id: reqId });
  return `Plan submitted (${reqId}). Waiting for approval...`;
}

// ── Lead Protocol Tools (from s16) ──

function runRequestShutdown(teammate: string): string {
  const reqId = newRequestId();
  pendingRequests[reqId] = createProtocolState(reqId, "shutdown", "lead", teammate, "pending", "");
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", { request_id: reqId });
  console.log(`  \x1b[35m[protocol] shutdown_request → ${teammate} (${reqId})\x1b[0m`);
  return `Shutdown request sent to ${teammate} (req: ${reqId})`;
}

function runRequestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Please submit a plan for: ${task}`, "message");
  return `Asked ${teammate} to submit a plan`;
}

function runReviewPlan(requestId: string, approve: boolean, feedback: string = ""): string {
  const state = pendingRequests[requestId];
  if (!state) return `Request ${requestId} not found`;
  if (state.status !== "pending") return `Request ${requestId} already ${state.status}`;
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"),
           "plan_approval_response", { request_id: requestId, approve });
  const icon = approve ? "✓" : "✗";
  console.log(`  \x1b[32m[protocol] plan ${icon} (${requestId})\x1b[0m`);
  return `Plan ${approve ? "approved" : "rejected"} (${requestId})`;
}

// ── Basic tool handlers ──

function runCreateTask(subject: string, description: string = "", blockedBy: string[] | null = null): string {
  const task = createTask(subject, description, blockedBy);
  const deps = blockedBy ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (tasks.length === 0) return "No tasks.";
  return tasks.map(t => `  ${t.id}: ${t.subject} [${t.status}]`).join("\n");
}

function runGetTask(taskId: string): string { return getTask(taskId); }
function runClaimTask(taskId: string): string { return claimTask(taskId, "agent"); }
function runCompleteTask(taskId: string): string { return completeTask(taskId); }

function runSpawnTeammate(name: string, role: string, prompt: string): string {
  return spawnTeammateThread(name, role, prompt);
}

function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

function consumeLeadInbox(routeProtocol: boolean = true): BusMessage[] {
  const msgs = BUS.readInbox("lead");
  if (routeProtocol) {
    for (const msg of msgs) {
      const meta = msg.metadata || {};
      const reqId = meta["request_id"] as string || "";
      const msgType = msg.type || "";
      if (reqId && msgType.endsWith("_response")) {
        matchResponse(msgType, reqId, !!meta["approve"]);
      }
    }
  }
  return msgs;
}

function runCheckInbox(): string {
  const msgs = consumeLeadInbox(true);
  if (msgs.length === 0) return "(inbox empty)";
  return msgs.map(m => {
    const meta = m.metadata || {};
    const reqId = meta["request_id"] as string || "";
    const tag = reqId ? ` [${m.type} req:${reqId}]` : ` [${m.type}]`;
    return `  [${m.from}]${tag} ${m.content.slice(0, 200)}`;
  }).join("\n");
}

// ── Tool Definitions ──

const TOOLS: any[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "create_task", description: "Create a task.",
    input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" }, blockedBy: { type: "array", items: { type: "string" } } }, required: ["subject"] } },
  { name: "list_tasks", description: "List all tasks.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_task", description: "Get full details of a specific task.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "claim_task", description: "Claim a pending task.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "complete_task", description: "Complete an in-progress task.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "spawn_teammate", description: "Spawn an autonomous teammate agent.",
    input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "send_message", description: "Send message to a teammate.",
    input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
  { name: "check_inbox", description: "Check inbox for messages and protocol responses.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "request_shutdown", description: "Request a teammate to shut down gracefully.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "request_plan", description: "Ask a teammate to submit a plan for review.",
    input_schema: { type: "object", properties: { teammate: { type: "string" }, task: { type: "string" } }, required: ["teammate", "task"] } },
  { name: "review_plan", description: "Approve or reject a submitted plan.",
    input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
];

const TOOL_HANDLERS: Record<string, Function> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  create_task: runCreateTask, list_tasks: runListTasks, get_task: runGetTask,
  claim_task: runClaimTask, complete_task: runCompleteTask,
  spawn_teammate: runSpawnTeammate, send_message: runSendMessage, check_inbox: runCheckInbox,
  request_shutdown: runRequestShutdown, request_plan: runRequestPlan, review_plan: runReviewPlan,
};

// ── Context ──

const MEMORY_DIR = path.join(WORKDIR, ".memory");
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

function updateContext(context: Record<string, unknown>, messages: any[]): Record<string, unknown> {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    memories = fs.readFileSync(MEMORY_INDEX, "utf-8").slice(0, 2000);
  }
  return { memories };
}

// ── Agent Loop ──

async function agentLoop(messages: any[], context: Record<string, unknown>): Promise<void> {
  let system = getSystemPrompt(context);
  while (true) {
    let response: any;
    try {
      response = await client.messages.create({
        model: MODEL, system, messages, tools: TOOLS, max_tokens: 8000,
      });
    } catch (e: any) {
      messages.push({ role: "assistant", content: [
        { type: "text", text: `[Error] ${e.constructor?.name || "Error"}: ${e.message}` }] });
      return;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(...Object.values(block.input)) : "Unknown";
      console.log(String(output).slice(0, 300));
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
    context = updateContext(context, messages);
    system = getSystemPrompt(context);
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log("s17: autonomous agents");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const history: any[] = [];
  let context: Record<string, unknown> = { memories: "" };

  const ask = (): Promise<string> => new Promise(r => rl.question("\x1b[36ms17 >> \x1b[0m", r));

  while (true) {
    let query: string;
    try { query = await ask(); } catch { break; }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

    history.push({ role: "user", content: query });
    await agentLoop(history, context);
    context = updateContext(context, history);
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") console.log(block.text);
      }
    }

    // Consume lead inbox: route protocol + inject into history
    const inbox = consumeLeadInbox(true);
    if (inbox.length > 0) {
      const inboxText = inbox
        .map(m => `From ${m.from} [${m.type || "message"}]: ${m.content.slice(0, 200)}`)
        .join("\n");
      history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
    }
    console.log();
  }

  rl.close();
}

main().catch(console.error);
