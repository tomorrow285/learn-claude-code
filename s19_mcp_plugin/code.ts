#!/usr/bin/env tsx
/**
 * s19: MCP Tools — MCPClient + tool discovery + assemble_tool_pool.
 *
 * Run:  npx tsx s19_mcp_plugin/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s18:
 *   - MCPClient class: discovers tools, calls tools via mock handler
 *   - normalize_mcp_name: normalize tool/server names
 *   - assemble_tool_pool: assembles builtin + MCP tools into one pool
 *   - connect_mcp: connect to an MCP server, discover tools
 *   - Tool naming: mcp__{server}__{tool} with normalization
 *   - MCP tools have readOnly/destructive annotations
 *   - agent_loop uses dynamic tool pool (builtin + MCP), no prompt cache
 *   - Teammate tools: complete_task, worktree cwd (from s17/s18 fixes)
 *
 * ASCII flow:
 *   connect_mcp("docs") → MCPClient discovers tools →
 *   assemble_tool_pool → [builtin... , mcp__docs__search, mcp__docs__get_version]
 *   agent_loop uses assembled pool
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

// ── Task System ──

const TASKS_DIR = path.join(WORKDIR, ".tasks");
fs.mkdirSync(TASKS_DIR, { recursive: true });

interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
  worktree: string | null;
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
    worktree: null,
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

function getTaskJson(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
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
  if (task.status !== "pending") return `Task ${taskId} is ${task.status}, cannot claim`;
  if (task.owner) return `Task ${taskId} already owned by ${task.owner}`;
  if (!canStart(taskId)) {
    const deps = task.blockedBy.filter(d => fs.existsSync(_taskPath(d)) && loadTask(d).status !== "completed");
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
  if (task.status !== "in_progress") return `Task ${taskId} is ${task.status}, cannot complete`;
  task.status = "completed";
  saveTask(task);
  const unblocked = listTasks()
    .filter(t => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map(t => t.subject);
  console.log(`  \x1b[32m[complete] ${task.subject} ✓\x1b[0m`);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length > 0) msg += `\nUnblocked: ${unblocked.join(", ")}`;
  return msg;
}

// ── Worktree System ──

const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");
fs.mkdirSync(WORKTREES_DIR, { recursive: true });

const VALID_WT_NAME = new RegExp("^[A-Za-z0-9._-]{1,64}$");

function validateWorktreeName(name: string): string | null {
  if (!name) return "Worktree name cannot be empty";
  if (name === "." || name === "..") return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) {
    return `Invalid worktree name '${name}': only letters, digits, dots, underscores, dashes (1-64 chars)`;
  }
  return null;
}

function runGit(args: string[]): [boolean, string] {
  try {
    const out = execSync(`git ${args.join(" ")}`, {
      cwd: WORKDIR, timeout: 30000, encoding: "utf-8", stdio: "pipe",
    });
    const result = out.trim();
    return [true, result ? result.slice(0, 5000) : "(no output)"];
  } catch (e: any) {
    if (e.killed || e.code === "ETIMEDOUT") return [false, "Error: git timeout"];
    const out = (e.stdout || "") + (e.stderr || "");
    return [false, out.trim().slice(0, 5000) || "(no output)"];
  }
}

function logEvent(eventType: string, worktreeName: string, taskId: string = ""): void {
  const event = { type: eventType, worktree: worktreeName, task_id: taskId, ts: Date.now() / 1000 };
  fs.appendFileSync(path.join(WORKTREES_DIR, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
}

function createWorktreeOp(name: string, taskId: string = ""): string {
  const err = validateWorktreeName(name);
  if (err) return `Error: ${err}`;
  const wtPath = path.join(WORKTREES_DIR, name);
  if (fs.existsSync(wtPath)) return `Worktree '${name}' already exists at ${wtPath}`;
  const [ok, result] = runGit(["worktree", "add", wtPath, "-b", `wt/${name}`, "HEAD"]);
  if (!ok) return `Git error: ${result}`;
  if (taskId) bindTaskToWorktree(taskId, name);
  logEvent("create", name, taskId);
  console.log(`  \x1b[33m[worktree] created: ${name} at ${wtPath}\x1b[0m`);
  return `Worktree '${name}' created at ${wtPath}`;
}

function bindTaskToWorktree(taskId: string, worktreeName: string): void {
  const task = loadTask(taskId);
  task.worktree = worktreeName;
  saveTask(task);
}

function _countWorktreeChanges(wtPath: string): [number, number] {
  try {
    const r1 = execSync("git status --porcelain", {
      cwd: wtPath, timeout: 10000, encoding: "utf-8", stdio: "pipe",
    });
    const files = r1.trim().split("\n").filter(l => l.trim()).length;
    let commits = 0;
    try {
      const r2 = execSync("git log @{push}..HEAD --oneline", {
        cwd: wtPath, timeout: 10000, encoding: "utf-8", stdio: "pipe",
      });
      commits = r2.trim().split("\n").filter(l => l.trim()).length;
    } catch { commits = 0; }
    return [files, commits];
  } catch { return [-1, -1]; }
}

function removeWorktreeOp(name: string, discardChanges: boolean = false): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  const wtPath = path.join(WORKTREES_DIR, name);
  if (!fs.existsSync(wtPath)) return `Worktree '${name}' not found`;
  if (!discardChanges) {
    const [files, commits] = _countWorktreeChanges(wtPath);
    if (files < 0) return "Cannot verify status. Use discard_changes=true to force.";
    if (files > 0 || commits > 0) {
      return `Worktree '${name}' has ${files} file(s), ${commits} commit(s). Use discard_changes=true or keep_worktree.`;
    }
  }
  const [ok1] = runGit(["worktree", "remove", wtPath, "--force"]);
  if (!ok1) return `Failed to remove worktree '${name}'`;
  runGit(["branch", "-D", `wt/${name}`]);
  logEvent("remove", name);
  console.log(`  \x1b[33m[worktree] removed: ${name}\x1b[0m`);
  return `Worktree '${name}' removed`;
}

function keepWorktreeOp(name: string): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  logEvent("keep", name);
  return `Worktree '${name}' kept for review (branch: wt/${name})`;
}

// ── Prompt Assembly ──

const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file, " +
         "create_task, list_tasks, get_task, claim_task, complete_task, " +
         "spawn_teammate, send_message, check_inbox, " +
         "request_shutdown, request_plan, review_plan, " +
         "create_worktree, remove_worktree, keep_worktree, " +
         "connect_mcp. MCP tools are prefixed mcp__{server}__{tool}.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

function assembleSystemPrompt(context: Record<string, unknown>): string {
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
  if (context["memories"]) sections.push(`Relevant memories:\n${context["memories"]}`);
  const mcpNames = Object.keys(mcpClients);
  if (mcpNames.length > 0) sections.push(`Connected MCP servers: ${mcpNames.join(", ")}`);
  return sections.join("\n\n");
}

// ── Basic Tools ──

function safePath(p: string, cwd: string | null = null): string {
  const base = cwd || WORKDIR;
  const resolved = path.resolve(base, p);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string, cwd: string | null = null): string {
  try {
    const out = execSync(command, {
      cwd: cwd || WORKDIR, timeout: 120000, encoding: "utf-8", stdio: "pipe",
    });
    const result = out.trim();
    return result ? result.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed || e.code === "ETIMEDOUT") return "Error: Timeout (120s)";
    const out = (e.stdout || "") + (e.stderr || "");
    return out.trim().slice(0, 50000) || "(no output)";
  }
}

function runRead(fp: string, limit: number | null = null, cwd: string | null = null): string {
  try {
    const lines = fs.readFileSync(safePath(fp, cwd), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runWrite(filePath: string, content: string, cwd: string | null = null): string {
  try {
    const fp = safePath(filePath, cwd);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ── MessageBus ──

const MAILBOX_DIR = path.join(WORKDIR, ".mailboxes");
fs.mkdirSync(MAILBOX_DIR, { recursive: true });

interface BusMessage {
  from: string; to: string; content: string;
  type: string; ts: number; metadata: Record<string, unknown>;
}

class MessageBus {
  send(fromAgent: string, toAgent: string, content: string,
       msgType: string = "message", metadata: Record<string, unknown> = {}): void {
    const msg: BusMessage = {
      from: fromAgent, to: toAgent, content, type: msgType,
      ts: Date.now() / 1000, metadata: metadata || {},
    };
    fs.appendFileSync(path.join(MAILBOX_DIR, `${toAgent}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    console.log(`  \x1b[33m[bus] ${fromAgent} → ${toAgent}: (${msgType}) ${content.slice(0, 50)}\x1b[0m`);
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const text = fs.readFileSync(inbox, "utf-8");
    const msgs = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as BusMessage);
    fs.unlinkSync(inbox);
    return msgs;
  }
}

const BUS = new MessageBus();
const activeTeammates: Record<string, boolean> = {};

// ── Protocol State ──

interface ProtocolState {
  request_id: string; type: string; sender: string;
  target: string; status: string; payload: string; created_at: number;
}

function createProtocolState(
  request_id: string, type: string, sender: string, target: string,
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
  if (!state) return;
  if (state.type === "shutdown" && responseType !== "shutdown_response") return;
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") return;
  state.status = approve ? "approved" : "rejected";
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

// ── Autonomous Agent ──

const IDLE_POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

function scanUnclaimedTasks(): Record<string, unknown>[] {
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
  for (let i = 0; i < Math.floor(IDLE_TIMEOUT / IDLE_POLL_INTERVAL); i++) {
    await sleep(IDLE_POLL_INTERVAL);
    const inbox = BUS.readInbox(agentName);
    if (inbox.length > 0) {
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          const reqId = (msg.metadata || {})["request_id"] as string || "";
          BUS.send(name, "lead", "Shutting down.", "shutdown_response", { request_id: reqId, approve: true });
          return "shutdown";
        }
      }
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
      return "work";
    }
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length > 0) {
      const taskData = unclaimed[0];
      const result = claimTask(taskData.id as string, agentName);
      if (result.includes("Claimed")) {
        let wtInfo = "";
        if (taskData.worktree) {
          wtInfo = `\nWork directory: ${path.join(WORKTREES_DIR, taskData.worktree as string)}`;
        }
        messages.push({ role: "user",
          content: `<auto-claimed>Task ${taskData.id}: ${taskData.subject}${wtInfo}</auto-claimed>` });
        return "work";
      }
    }
  }
  return "timeout";
}

// ── Teammate Thread ──

function spawnTeammateThread(name: string, role: string, prompt: string): string {
  if (name in activeTeammates) return `Teammate '${name}' already exists`;

  const system = `You are '${name}', a ${role}. Use tools to complete tasks. If a task has a worktree, work in that directory.`;

  function handleInboxMessage(_name: string, msg: BusMessage, messages: any[]): boolean {
    const msgType = msg.type || "message";
    const meta = msg.metadata || {};
    const reqId = meta["request_id"] as string || "";
    if (msgType === "shutdown_request") {
      BUS.send(_name, "lead", "Shutting down.", "shutdown_response", { request_id: reqId, approve: true });
      return true;
    }
    if (msgType === "plan_approval_response") {
      const approve = !!meta["approve"];
      if (approve) {
        messages.push({ role: "user", content: "[Plan approved]" });
      } else {
        messages.push({ role: "user", content: `[Plan rejected] ${msg.content}` });
      }
    }
    return false;
  }

  async function run(): Promise<void> {
    const wtCtx: { path: string | null } = { path: null };
    function _wtCwd(): string | null { return wtCtx.path; }
    function _runBash(command: string): string { return runBash(command, _wtCwd()); }
    function _runRead(fp: string): string { return runRead(fp, null, _wtCwd()); }
    function _runWrite(fp: string, content: string): string { return runWrite(fp, content, _wtCwd()); }
    function _runListTasks(): string {
      const tasks = listTasks();
      if (tasks.length === 0) return "No tasks.";
      return tasks.map(t =>
        `  ${t.id}: ${t.subject} [${t.status}]` + (t.worktree ? ` (wt:${t.worktree})` : "")
      ).join("\n");
    }
    function _runClaimTask(taskId: string): string {
      const result = claimTask(taskId, name);
      if (result.includes("Claimed")) {
        const task = loadTask(taskId);
        wtCtx.path = task.worktree ? path.join(WORKTREES_DIR, task.worktree) : null;
      }
      return result;
    }
    function _runCompleteTask(taskId: string): string {
      const result = completeTask(taskId);
      wtCtx.path = null;
      return result;
    }

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
      { name: "list_tasks", description: "List all tasks.",
        input_schema: { type: "object", properties: {}, required: [] } },
      { name: "claim_task", description: "Claim a pending task.",
        input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
      { name: "complete_task", description: "Mark an in-progress task as completed.",
        input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
    ];

    const subHandlers: Record<string, Function> = {
      bash: _runBash, read_file: _runRead, write_file: _runWrite,
      send_message: (to: string, content: string) => { BUS.send(name, to, content); return "Sent"; },
      submit_plan: (plan: string) => _teammateSubmitPlan(name, plan),
      list_tasks: _runListTasks, claim_task: _runClaimTask, complete_task: _runCompleteTask,
    };

    while (true) {
      if (messages.length <= 3) {
        messages.unshift({ role: "user",
          content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>` });
      }
      let shouldShutdown = false;
      for (let round = 0; round < 10; round++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (handleInboxMessage(name, msg, messages)) { shouldShutdown = true; break; }
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
        } catch { break; }
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
      const idleResult = await idlePoll(name, messages, name, role);
      if (idleResult === "shutdown" || idleResult === "timeout") break;
    }

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
  }

  activeTeammates[name] = true;
  setTimeout(() => { run().catch(console.error); }, 0);
  return `Teammate '${name}' spawned as ${role}`;
}

function _teammateSubmitPlan(fromName: string, plan: string): string {
  const reqId = newRequestId();
  pendingRequests[reqId] = createProtocolState(
    reqId, "plan_approval", fromName, "lead", "pending", plan);
  BUS.send(fromName, "lead", plan, "plan_approval_request", { request_id: reqId });
  return `Plan submitted (${reqId})`;
}

// ── Lead Protocol Tools ──

function runRequestShutdown(teammate: string): string {
  const reqId = newRequestId();
  pendingRequests[reqId] = createProtocolState(reqId, "shutdown", "lead", teammate, "pending", "");
  BUS.send("lead", teammate, "Shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request sent to ${teammate}`;
}

function runRequestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Submit plan for: ${task}`, "message");
  return `Asked ${teammate} to submit a plan`;
}

function runReviewPlan(requestId: string, approve: boolean, feedback: string = ""): string {
  const state = pendingRequests[requestId];
  if (!state) return `Request ${requestId} not found`;
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"),
           "plan_approval_response", { request_id: requestId, approve });
  return `Plan ${approve ? "approved" : "rejected"}`;
}

// ── MCP System (s19 new) ──

class MCPClient {
  /** Discovers and calls tools on an MCP server (mock for teaching). */
  name: string;
  tools: any[] = [];
  private _handlers: Record<string, (...args: any[]) => string> = {};

  constructor(name: string) {
    this.name = name;
  }

  register(toolDefs: any[], handlers: Record<string, (...args: any[]) => string>): void {
    this.tools = toolDefs;
    this._handlers = handlers;
  }

  callTool(toolName: string, args: Record<string, unknown>): string {
    const handler = this._handlers[toolName];
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    try {
      return handler(...Object.values(args));
    } catch (e: any) {
      return `MCP error: ${e.message}`;
    }
  }
}

const mcpClients: Record<string, MCPClient> = {};

const _DISALLOWED_CHARS = new RegExp("[^a-zA-Z0-9_-]", "g");

function normalizeMcpName(name: string): string {
  /** Replace non [a-zA-Z0-9_-] with underscore. */
  return name.replace(_DISALLOWED_CHARS, "_");
}

function _mockServerDocs(): MCPClient {
  const mcpClient = new MCPClient("docs");
  mcpClient.register(
    [
      { name: "search", description: "Search documentation. (readOnly)",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "get_version", description: "Get API version. (readOnly)",
        inputSchema: { type: "object", properties: {}, required: [] } },
    ],
    {
      search: (query: string) => `[docs] Found 3 results for '${query}'`,
      get_version: () => "[docs] API v2.1.0",
    }
  );
  return mcpClient;
}

function _mockServerDeploy(): MCPClient {
  const mcpClient = new MCPClient("deploy");
  mcpClient.register(
    [
      { name: "trigger", description: "Trigger a deployment. (destructive — requires approval in real CC)",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
      { name: "status", description: "Check deployment status. (readOnly)",
        inputSchema: { type: "object", properties: { service: { type: "string" } }, required: ["service"] } },
    ],
    {
      trigger: (service: string) => `[deploy] Triggered: ${service}`,
      status: (service: string) => `[deploy] ${service}: running (v1.4.2)`,
    }
  );
  return mcpClient;
}

const MOCK_SERVERS: Record<string, () => MCPClient> = {
  docs: _mockServerDocs,
  deploy: _mockServerDeploy,
};

function connectMcp(name: string): string {
  if (name in mcpClients) return `MCP server '${name}' already connected`;
  const factory = MOCK_SERVERS[name];
  if (!factory) {
    const available = Object.keys(MOCK_SERVERS).join(", ");
    return `Unknown server '${name}'. Available: ${available}`;
  }
  const mcpClient = factory();
  mcpClients[name] = mcpClient;
  const toolNames = mcpClient.tools.map(t => t.name);
  console.log(`  \x1b[31m[mcp] connected: ${name} → ${toolNames}\x1b[0m`);
  return `Connected to MCP server '${name}'. Discovered ${mcpClient.tools.length} tools: ${toolNames.join(", ")}`;
}

function assembleToolPool(): [any[], Record<string, Function>] {
  /** Assemble builtin tools + all MCP tools into one pool. */
  const tools = [...BUILTIN_TOOLS];
  const handlers: Record<string, Function> = { ...BUILTIN_HANDLERS };
  for (const [serverName, mcpClient] of Object.entries(mcpClients)) {
    const safeServer = normalizeMcpName(serverName);
    for (const toolDef of mcpClient.tools) {
      const safeTool = normalizeMcpName(toolDef.name);
      const prefixed = `mcp__${safeServer}__${safeTool}`;
      tools.push({
        name: prefixed,
        description: toolDef.description || "",
        input_schema: toolDef.inputSchema || {},
      });
      // Use closure capture to bind current client and tool name
      const capturedClient = mcpClient;
      const capturedToolName = toolDef.name;
      handlers[prefixed] = (...args: any[]) => {
        // The first arg would be the tool input object
        const kw: Record<string, unknown> = args[0] || {};
        return capturedClient.callTool(capturedToolName, kw);
      };
    }
  }
  return [tools, handlers];
}

// ── Lead Worktree Tools ──

function runCreateWorktree(name: string, taskId: string = ""): string {
  return createWorktreeOp(name, taskId);
}
function runRemoveWorktree(name: string, discardChanges: boolean = false): string {
  return removeWorktreeOp(name, discardChanges);
}
function runKeepWorktree(name: string): string { return keepWorktreeOp(name); }

// ── Basic tool handlers ──

function runCreateTask(subject: string, description: string = "",
                       blockedBy: string[] | null = null): string {
  const task = createTask(subject, description, blockedBy);
  const deps = blockedBy ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (tasks.length === 0) return "No tasks.";
  return tasks.map(t =>
    `  ${t.id}: ${t.subject} [${t.status}]` + (t.worktree ? ` (wt:${t.worktree})` : "")
  ).join("\n");
}

function runGetTask(taskId: string): string { return getTaskJson(taskId); }
function runClaimTask(taskId: string): string { return claimTask(taskId, "agent"); }
function runCompleteTask(taskId: string): string { return completeTask(taskId); }

function runSpawnTeammate(name: string, role: string, prompt: string): string {
  return spawnTeammateThread(name, role, prompt);
}
function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content); return `Sent to ${to}`;
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
function runConnectMcp(name: string): string { return connectMcp(name); }

// ── Tool Definitions ──

const BUILTIN_TOOLS: any[] = [
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
  { name: "get_task", description: "Get full task details.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "claim_task", description: "Claim a pending task.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "complete_task", description: "Complete an in-progress task.",
    input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "spawn_teammate", description: "Spawn an autonomous teammate.",
    input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "send_message", description: "Send message to a teammate.",
    input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
  { name: "check_inbox", description: "Check inbox for messages and protocol responses.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "request_shutdown", description: "Request a teammate to shut down.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "request_plan", description: "Ask a teammate to submit a plan.",
    input_schema: { type: "object", properties: { teammate: { type: "string" }, task: { type: "string" } }, required: ["teammate", "task"] } },
  { name: "review_plan", description: "Approve or reject a submitted plan.",
    input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "create_worktree", description: "Create an isolated git worktree.",
    input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "string" } }, required: ["name"] } },
  { name: "remove_worktree", description: "Remove a worktree. Refuses if changes exist.",
    input_schema: { type: "object", properties: { name: { type: "string" }, discard_changes: { type: "boolean" } }, required: ["name"] } },
  { name: "keep_worktree", description: "Keep a worktree for manual review.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "connect_mcp", description: "Connect to an MCP server (docs, deploy) and discover tools.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

const BUILTIN_HANDLERS: Record<string, Function> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  create_task: runCreateTask, list_tasks: runListTasks, get_task: runGetTask,
  claim_task: runClaimTask, complete_task: runCompleteTask,
  spawn_teammate: runSpawnTeammate, send_message: runSendMessage, check_inbox: runCheckInbox,
  request_shutdown: runRequestShutdown, request_plan: runRequestPlan, review_plan: runReviewPlan,
  create_worktree: runCreateWorktree, remove_worktree: runRemoveWorktree, keep_worktree: runKeepWorktree,
  connect_mcp: runConnectMcp,
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

// ── Agent Loop (s19: dynamic tool pool, no prompt cache) ──

async function agentLoop(messages: any[], context: Record<string, unknown>): Promise<void> {
  let [tools, handlers] = assembleToolPool();
  let system = assembleSystemPrompt(context);
  while (true) {
    let response: any;
    try {
      response = await client.messages.create({
        model: MODEL, system, messages, tools, max_tokens: 8000,
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
      const handler = handlers[block.name];
      const isMcp = block.name.startsWith("mcp__");
      const output = handler
        ? (isMcp ? handler(block.input) : handler(...Object.values(block.input)))
        : "Unknown";
      console.log(String(output).slice(0, 300));
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });

    if (response.content.some((b: any) => b.type === "tool_use" && b.name === "connect_mcp")) {
      [tools, handlers] = assembleToolPool();
      context = updateContext(context, messages);
      system = assembleSystemPrompt(context);
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log("s19: mcp tools");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const history: any[] = [];
  let context: Record<string, unknown> = { memories: "" };

  const ask = (): Promise<string> => new Promise(r => rl.question("\x1b[36ms19 >> \x1b[0m", r));

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
