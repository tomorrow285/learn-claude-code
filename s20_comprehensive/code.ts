#!/usr/bin/env tsx
/**
 * s20: Comprehensive Agent — all teaching components in one loop.
 *
 * Run:  npx tsx s20_comprehensive/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * This final chapter intentionally puts the earlier teaching mechanisms back
 * together: dispatch, permission, hooks, todo, subagent, skills, compaction,
 * memory, prompt assembly, error recovery, task graph, background tasks, cron,
 * teams, protocols, autonomous agents, worktrees, and MCP.
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
const PRIMARY_MODEL = MODEL;
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID || "";

const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");

const DEFAULT_MAX_TOKENS = 8000;
const ESCALATED_MAX_TOKENS = 16000;
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_529 = 2;
const MAX_RECOVERY_RETRIES = 2;
const BASE_DELAY_MS = 500;
const CONTEXT_LIMIT = 50000;
const KEEP_RECENT_TOOL_RESULTS = 3;
const PERSIST_THRESHOLD = 30000;
const CONTINUATION_PROMPT = "Continue from the previous response. Do not repeat completed work.";
const PROMPT = "\x1b[36ms20 >> \x1b[0m";
let CLI_ACTIVE = false;

// readline availability tracking
let READLINE_AVAILABLE = false;
try {
  require("readline");
  READLINE_AVAILABLE = true;
} catch {
  READLINE_AVAILABLE = false;
}

function terminalPrint(text: string): void {
  // Simple print — in teaching context, main thread is CLI
  console.log(text);
}

// ── Task System ──

const TASKS_DIR = path.join(WORKDIR, ".tasks");
fs.mkdirSync(TASKS_DIR, { recursive: true });
let CURRENT_TODOS: any[] = [];

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
    return [false, ((e.stdout || "") + (e.stderr || "")).trim().slice(0, 5000) || "(no output)"];
  }
}

function logEvent(eventType: string, worktreeName: string, taskId: string = ""): void {
  const event = { type: eventType, worktree: worktreeName, task_id: taskId, ts: Date.now() / 1000 };
  fs.appendFileSync(path.join(WORKTREES_DIR, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
}

function createWorktree(name: string, taskId: string = ""): string {
  const err = validateWorktreeName(name);
  if (err) return `Error: ${err}`;
  if (taskId) {
    try { loadTask(taskId); } catch { return `Error: task ${taskId} not found`; }
  }
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

function removeWorktree(name: string, discardChanges: boolean = false): string {
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

function keepWorktree(name: string): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  logEvent("keep", name);
  return `Worktree '${name}' kept for review (branch: wt/${name})`;
}

// ── Skill Loading ──

const SKILL_REGISTRY: Record<string, { name: string; description: string; content: string }> = {};

function _parseFrontmatter(text: string): [Record<string, unknown>, string] {
  /** Simple YAML frontmatter parser using regex — no full YAML required. */
  if (!text.startsWith("---")) return [{}, text];
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [{}, text];
  const frontmatter = match[1];
  const body = text.slice(match[0].length).trim();

  // Simple key: value parser for teaching
  const meta: Record<string, unknown> = {};
  const lines = frontmatter.split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value: string = line.slice(colonIdx + 1).trim();
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }
  return [meta, body];
}

function scanSkills(): void {
  Object.keys(SKILL_REGISTRY).forEach(k => delete SKILL_REGISTRY[k]);
  if (!fs.existsSync(SKILLS_DIR)) return;
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).sort();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(manifest)) continue;
    const raw = fs.readFileSync(manifest, "utf-8");
    const [meta] = _parseFrontmatter(raw);
    const name = (meta.name as string) || entry.name;
    const desc = (meta.description as string) || raw.split("\n")[0].replace(/^#\s*/, "").trim();
    SKILL_REGISTRY[name] = { name, description: desc, content: raw };
  }
}

scanSkills();

function listSkills(): string {
  if (Object.keys(SKILL_REGISTRY).length === 0) return "(no skills found)";
  return Object.values(SKILL_REGISTRY)
    .map(skill => `- ${skill.name}: ${skill.description}`)
    .join("\n");
}

function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) {
    const available = Object.keys(SKILL_REGISTRY).join(", ") || "(none)";
    return `Skill not found: ${name}. Available: ${available}`;
  }
  return skill.content;
}

// ── Prompt Assembly ──

const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file, edit_file, glob, " +
         "todo_write, task, load_skill, compact, " +
         "create_task, list_tasks, get_task, claim_task, complete_task, " +
         "schedule_cron, list_crons, cancel_cron, " +
         "spawn_teammate, send_message, check_inbox, " +
         "request_shutdown, request_plan, review_plan, " +
         "create_worktree, remove_worktree, keep_worktree, " +
         "connect_mcp. MCP tools are prefixed mcp__{server}__{tool}.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

function assembleSystemPrompt(context: Record<string, unknown>): string {
  const sections = [PROMPT_SECTIONS.identity, PROMPT_SECTIONS.tools, PROMPT_SECTIONS.workspace];
  sections.push(`Current time: ${new Date().toISOString().replace("T", " ").slice(0, 19)}`);
  sections.push("Skills catalog:\n" + listSkills() + "\nUse load_skill(name) when a skill is relevant.");
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

function runBash(command: string, cwd: string | null = null,
                runInBackground: boolean = false): string {
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

function runRead(p: string, limit: number | null = null,
                offset: number = 0, cwd: string | null = null): string {
  try {
    let lines = fs.readFileSync(safePath(p, cwd), "utf-8").split("\n");
    offset = Math.max(offset || 0, 0);
    lines = lines.slice(offset);
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

function runEdit(filePath: string, oldText: string, newText: string,
                 cwd: string | null = null): string {
  try {
    const fp = safePath(filePath, cwd);
    const text = fs.readFileSync(fp, "utf-8");
    if (!text.includes(oldText)) return `Error: text not found in ${filePath}`;
    // Replace first occurrence
    const idx = text.indexOf(oldText);
    const newContent = text.slice(0, idx) + newText + text.slice(idx + oldText.length);
    fs.writeFileSync(fp, newContent, "utf-8");
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runGlob(pattern: string, cwd: string | null = null): string {
  try {
    const base = cwd || WORKDIR;
    // Simple glob using fs.readdirSync for teaching
    const results: string[] = [];
    function walk(dir: string, prefix: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else {
          // Simple wildcard matching
          const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
          if (regex.test(relPath) || regex.test(entry.name)) {
            results.push(relPath);
          }
        }
      }
    }
    walk(base, "");
    return results.join("\n") || "(no matches)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function callToolHandler(handler: Function | undefined, args: Record<string, unknown>, name: string): string {
  if (!handler) return `Unknown: ${name}`;
  try {
    return handler(...Object.values(args || {}));
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function _normalizeTodos(todos: unknown): [any[] | null, string | null] {
  if (typeof todos === "string") {
    try { todos = JSON.parse(todos); } catch {
      try { todos = eval(todos); } catch {
        return [null, "Error: todos must be a list or JSON array string"];
      }
    }
  }
  if (!Array.isArray(todos)) return [null, "Error: todos must be a list"];
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    if (typeof todo !== "object" || todo === null) return [null, `Error: todos[${i}] must be an object`];
    if (!("content" in todo) || !("status" in todo)) {
      return [null, `Error: todos[${i}] missing 'content' or 'status'`];
    }
    if (!["pending", "in_progress", "completed"].includes(todo.status)) {
      return [null, `Error: todos[${i}] has invalid status '${todo.status}'`];
    }
  }
  return [todos, null];
}

function runTodoWrite(todos: any[]): string {
  const [normalized, error] = _normalizeTodos(todos);
  if (error) return error;
  CURRENT_TODOS = normalized!;
  console.log(`  \x1b[33m[todo] updated ${CURRENT_TODOS.length} item(s)\x1b[0m`);
  return `Updated ${CURRENT_TODOS.length} todos`;
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
    terminalPrint(`  \x1b[33m[bus] ${fromAgent} → ${toAgent}: (${msgType}) ${content.slice(0, 50)}\x1b[0m`);
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
  request_id: string; type: string; sender: string; target: string;
  status: string; payload: string; created_at: number;
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
                        name: string, role: string,
                        worktreeContext: Record<string, unknown> | null = null): Promise<string> {
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
          const wtPath = path.join(WORKTREES_DIR, taskData.worktree as string);
          wtInfo = `\nWork directory: ${wtPath}`;
          if (worktreeContext) worktreeContext["path"] = wtPath;
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

  const protocolCtx: { waiting_plan: string | null } = { waiting_plan: null };
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
      if (reqId === protocolCtx.waiting_plan) protocolCtx.waiting_plan = null;
      messages.push({ role: "user",
        content: approve ? "[Plan approved]" : `[Plan rejected] ${msg.content}` });
    }
    return false;
  }

  async function run(): Promise<void> {
    const wtCtx: { path: string | null } = { path: null };
    function _wtCwd(): string | null { return wtCtx.path; }
    function _runBash(command: string): string { return runBash(command, _wtCwd()); }
    function _runRead(fp: string): string { return runRead(fp, null, 0, _wtCwd()); }
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
        input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["path"] } },
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
        if (protocolCtx.waiting_plan) {
          await sleep(IDLE_POLL_INTERVAL);
          continue;
        }
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
        if (!hasToolUse(response.content)) break;

        const results: any[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            if (block.name === "submit_plan") {
              output = _teammateSubmitPlan(name, block.input["plan"] || "");
              const match = output.match(/\((req_\d+)\)/);
              protocolCtx.waiting_plan = match ? match[1] : output;
            } else {
              const handler = subHandlers[block.name];
              output = callToolHandler(handler, block.input, block.name);
            }
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
            if (protocolCtx.waiting_plan) break;
          }
        }
        messages.push({ role: "user", content: results });
        if (protocolCtx.waiting_plan) break;
      }
      if (shouldShutdown) break;
      if (protocolCtx.waiting_plan) continue;
      const idleResult = await idlePoll(name, messages, name, role, wtCtx);
      if (idleResult === "shutdown" || idleResult === "timeout") break;
    }

    let summary = "Done.";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text") { summary = b.text; break; }
        }
        break;
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

// ── Hooks + Permission Pipeline ──

type HookCallback = (...args: any[]) => string | null | void;

const HOOKS: Record<string, HookCallback[]> = {
  UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [],
};

function registerHook(event: string, callback: HookCallback): void {
  HOOKS[event].push(callback);
}

function triggerHooks(event: string, ...args: any[]): string | null | undefined {
  for (const callback of HOOKS[event]) {
    const result = callback(...args);
    if (result !== null && result !== undefined) return result as string;
  }
  return null;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

function permissionHook(block: any): string | null {
  if (block.name === "bash") {
    const command: string = block.input["command"] || "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied: '${pattern}' is on the deny list`;
      }
    }
    if (DESTRUCTIVE.some(token => command.includes(token))) {
      console.log(`\n\x1b[33m[permission] destructive command\x1b[0m`);
      console.log(`  ${command}`);
      // Non-interactive fallback for teaching
      return "Permission required for destructive command";
    }
  }
  if (block.name === "write_file" || block.name === "edit_file") {
    const p: string = block.input["path"] || "";
    try { safePath(p); } catch {
      return `Permission denied: path escapes workspace: ${p}`;
    }
  }
  if (block.name.startsWith("mcp__") && block.name.includes("deploy")) {
    console.log(`\n\x1b[33m[permission] MCP destructive-looking tool: ${block.name}\x1b[0m`);
    return "Permission required for MCP deploy tool";
  }
  return null;
}

function logHook(block: any): null {
  console.log(`\x1b[90m[HOOK] ${block.name}\x1b[0m`);
  return null;
}

function largeOutputHook(block: any, output: string): null {
  if (output.length > 100000) {
    console.log(`\x1b[33m[HOOK] large output from ${block.name}: ${output.length} chars\x1b[0m`);
  }
  return null;
}

function userPromptHook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: ${WORKDIR}\x1b[0m`);
  return null;
}

function stopHook(messages: any[]): null {
  let toolCount = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      toolCount += content.filter((item: any) =>
        typeof item === "object" && item !== null && item.type === "tool_result"
      ).length;
    }
  }
  console.log(`\x1b[90m[HOOK] Stop: ${toolCount} tool result(s)\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", userPromptHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", stopHook);

// ── Subagent Tool ──

const SUB_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the task, then return a concise final summary. Do not spawn more agents.`;

const SUB_TOOLS: any[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

const SUB_HANDLERS: Record<string, Function> = {
  bash: runBash, read_file: runRead, write_file: runWrite, edit_file: runEdit, glob: runGlob,
};

function extractText(content: any): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text || "")
    .join("\n").trim();
}

function hasToolUse(content: any): boolean {
  return (Array.isArray(content) ? content : []).some((b: any) => b.type === "tool_use");
}

async function spawnSubagent(description: string): Promise<string> {
  const messages: any[] = [{ role: "user", content: description }];
  for (let i = 0; i < 30; i++) {
    const response = await client.messages.create({
      model: MODEL, system: SUB_SYSTEM, messages, tools: SUB_TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (!hasToolUse(response.content)) break;

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const blocked = triggerHooks("PreToolUse", block);
      let output: string;
      if (blocked) {
        output = String(blocked);
      } else {
        const handler = SUB_HANDLERS[block.name];
        output = callToolHandler(handler, block.input, block.name);
        triggerHooks("PostToolUse", block, output);
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const text = extractText(messages[i].content);
      if (text) return text;
    }
  }
  return "Subagent finished without a text summary.";
}

// ── Context Compaction ──

function estimateSize(messages: any[]): number {
  return JSON.stringify(messages, (key, val) => (typeof val === "function" ? String(val) : val)).length;
}

function blockType(block: any): string | undefined {
  if (typeof block === "object" && block !== null) {
    return block.type;
  }
  return undefined;
}

function messageHasToolUse(message: any): boolean {
  if (message.role !== "assistant") return false;
  return Array.isArray(message.content) && message.content.some((b: any) => blockType(b) === "tool_use");
}

function isToolResultMessage(message: any): boolean {
  if (message.role !== "user") return false;
  return Array.isArray(message.content) && message.content.some(
    (b: any) => typeof b === "object" && b !== null && b.type === "tool_result"
  );
}

function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const fp = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, output, "utf-8");
  }
  return `<persisted-output>\nFull output: ${fp}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

function snipCompact(messages: any[], maxMessages: number = 50): any[] {
  if (messages.length <= maxMessages) return messages;
  let headEnd = 3;
  let tailStart = messages.length - (maxMessages - 3);
  if (headEnd > 0 && messageHasToolUse(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) headEnd++;
  }
  if (tailStart > 0 && tailStart < messages.length &&
      isToolResultMessage(messages[tailStart]) && messageHasToolUse(messages[tailStart - 1])) {
    tailStart--;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;
  return [...messages.slice(0, headEnd),
          { role: "user", content: `[snipped ${snipped} messages]` },
          ...messages.slice(tailStart)];
}

function microCompact(messages: any[]): any[] {
  const toolResults: Array<{ block: any }> = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && block !== null && block.type === "tool_result") {
          toolResults.push({ block });
        }
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) return messages;
  for (const { block } of toolResults.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    if (String(block.content || "").length > 120) {
      block.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
  return messages;
}

function writeTranscript(messages: any[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const fp = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const content = messages.map(m => JSON.stringify(m, (k, v) =>
    typeof v === "function" ? String(v) : v
  )).join("\n");
  fs.writeFileSync(fp, content, "utf-8");
  return fp;
}

async function summarizeHistory(messages: any[]): Promise<string> {
  const conversation = JSON.stringify(messages, (k, v) =>
    typeof v === "function" ? String(v) : v
  ).slice(0, 80000);
  const prompt = "Summarize this coding-agent conversation so work can continue. " +
                 "Preserve current goal, key findings, changed files, remaining work, " +
                 "and user constraints.\n\n" + conversation;
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
  });
  return extractText(response.content) || "(empty summary)";
}

async function compactHistory(messages: any[]): Promise<any[]> {
  const transcript = writeTranscript(messages);
  console.log(`  \x1b[36m[compact] transcript saved: ${transcript}\x1b[0m`);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

async function reactiveCompact(messages: any[]): Promise<any[]> {
  const transcript = writeTranscript(messages);
  console.log(`  \x1b[31m[reactive compact] transcript saved: ${transcript}\x1b[0m`);
  let summary: string;
  try {
    summary = await summarizeHistory(messages);
  } catch {
    summary = "Earlier conversation was trimmed after a prompt-too-long error.";
  }
  let tailStart = Math.max(0, messages.length - 5);
  if (tailStart > 0 && tailStart < messages.length &&
      isToolResultMessage(messages[tailStart]) && messageHasToolUse(messages[tailStart - 1])) {
    tailStart--;
  }
  return [{ role: "user", content: `[Reactive compact]\n\n${summary}` }, ...messages.slice(tailStart)];
}

// ── Tool Result Budget ──

function toolResultBudget(messages: any[], maxBytes: number = 200000): any[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const content = last.content;
  if (last.role !== "user" || !Array.isArray(content)) return messages;
  const blocks = content
    .map((b: any, i: number) => ({ index: i, block: b }))
    .filter(({ block }: any) => typeof block === "object" && block !== null && block.type === "tool_result");
  let total = blocks.reduce((sum: number, { block }: any) => sum + String(block.content || "").length, 0);
  if (total <= maxBytes) return messages;
  blocks.sort((a: any, b: any) => String(b.block.content || "").length - String(a.block.content || "").length);
  for (const { block } of blocks) {
    if (total <= maxBytes) break;
    const text = String(block.content || "");
    block.content = persistLargeOutput(block.tool_use_id || "unknown", text);
    total = blocks.reduce((sum: number, { block: b }: any) => sum + String(b.content || "").length, 0);
  }
  return messages;
}

// ── Error Recovery ──

class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  consecutive529 = 0;
  hasAttemptedReactiveCompact = false;
  currentModel = PRIMARY_MODEL;
}

function retryDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 32000) / 1000;
  return base + Math.random() * base * 0.25;
}

async function withRetry<T>(fn: () => Promise<T>, state: RecoveryState): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e: any) {
      const name = (e.constructor?.name || "").toLowerCase();
      const msg = String(e.message || "").toLowerCase();
      if (name.includes("ratelimit") || msg.includes("429")) {
        const delay = retryDelay(attempt);
        console.log(`  \x1b[33m[429] retry ${attempt + 1}/${MAX_RETRIES} after ${delay.toFixed(1)}s\x1b[0m`);
        await sleep(delay);
        continue;
      }
      if (name.includes("overloaded") || msg.includes("529") || msg.includes("overloaded")) {
        state.consecutive529++;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529 && FALLBACK_MODEL) {
          state.currentModel = FALLBACK_MODEL;
          state.consecutive529 = 0;
          console.log(`  \x1b[31m[529] switching to ${FALLBACK_MODEL}\x1b[0m`);
        }
        const delay = retryDelay(attempt);
        console.log(`  \x1b[33m[529] retry ${attempt + 1}/${MAX_RETRIES} after ${delay.toFixed(1)}s\x1b[0m`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

function isPromptTooLongError(e: Error): boolean {
  const msg = e.message.toLowerCase();
  return (msg.includes("prompt") && msg.includes("long")) ||
         msg.includes("context_length_exceeded") ||
         msg.includes("max_context_window");
}

// ── Background Tasks ──

let _bgCounter = 0;
const backgroundTasks: Record<string, { tool_use_id: string; command: string; status: string }> = {};
const backgroundResults: Record<string, string> = {};

function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "bash") return false;
  const command = String(toolInput["command"] || "").toLowerCase();
  const slowKeywords = ["install", "build", "test", "deploy", "compile",
                        "docker build", "pip install", "npm install",
                        "cargo build", "pytest", "make"];
  return slowKeywords.some(kw => command.includes(kw));
}

function shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "bash") return false;
  return !!toolInput["run_in_background"] || isSlowOperation(toolName, toolInput);
}

function startBackgroundTask(block: any, handlers: Record<string, Function>): string {
  _bgCounter++;
  const bgId = `bg_${String(_bgCounter).padStart(4, "0")}`;
  const command = block.input["command"] || block.name;

  backgroundTasks[bgId] = { tool_use_id: block.id, command, status: "running" };

  setTimeout(() => {
    const handler = handlers[block.name];
    const result = callToolHandler(handler, block.input, block.name);
    triggerHooks("PostToolUse", block, result);
    backgroundTasks[bgId].status = "completed";
    backgroundResults[bgId] = String(result);
  }, 0);

  console.log(`  \x1b[33m[background] ${bgId}: ${String(command).slice(0, 60)}\x1b[0m`);
  return bgId;
}

function collectBackgroundResults(): string[] {
  const ready: string[] = Object.entries(backgroundTasks)
    .filter(([_, task]) => task.status === "completed")
    .map(([id]) => id);
  const notifications: string[] = [];
  for (const bgId of ready) {
    const task = backgroundTasks[bgId];
    delete backgroundTasks[bgId];
    const output = backgroundResults[bgId] || "";
    delete backgroundResults[bgId];
    const summary = output.length > 200 ? output.slice(0, 200) : output;
    notifications.push(
      `<task_notification>\n  <task_id>${bgId}</task_id>\n  <status>completed</status>\n` +
      `  <command>${task.command}</command>\n  <summary>${summary}</summary>\n</task_notification>`
    );
  }
  return notifications;
}

// ── Cron Scheduler ──

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}

const DURABLE_PATH = path.join(WORKDIR, ".scheduled_tasks.json");

const scheduledJobs: Record<string, CronJob> = {};
const cronQueue: CronJob[] = [];
const _lastFired: Record<string, string> = {};

function _cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    return step > 0 && value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some(part => _cronFieldMatches(part.trim(), value));
  }
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return lo <= value && value <= hi;
  }
  return value === parseInt(field);
}

function cronMatches(cronExpr: string, dt: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const dowVal = dt.getUTCDay(); // 0=Sun
  const m = _cronFieldMatches(minute, dt.getUTCMinutes());
  const h = _cronFieldMatches(hour, dt.getUTCHours());
  const domOk = _cronFieldMatches(dom, dt.getUTCDate());
  const monthOk = _cronFieldMatches(month, dt.getUTCMonth() + 1);
  const dowOk = _cronFieldMatches(dow, dowVal);
  if (!(m && h && monthOk)) return false;
  if (dom === "*" && dow === "*") return true;
  if (dom === "*") return dowOk;
  if (dow === "*") return domOk;
  return domOk || dowOk;
}

function _validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!/^\d+$/.test(step) || parseInt(step) <= 0) return `Invalid step: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const err = _validateCronField(part.trim(), lo, hi);
      if (err) return err;
    }
    return null;
  }
  if (field.includes("-")) {
    const [left, right] = field.split("-");
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return `Invalid range: ${field}`;
    const a = parseInt(left), b = parseInt(right);
    if (a < lo || a > hi || b < lo || b > hi) return `Range ${field} out of bounds [${lo}-${hi}]`;
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const value = parseInt(field);
  if (value < lo || value > hi) return `Value ${value} out of bounds [${lo}-${hi}]`;
  return null;
}

function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const bounds: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    const err = _validateCronField(fields[i], bounds[i][0], bounds[i][1]);
    if (err) return `${names[i]}: ${err}`;
  }
  return null;
}

function saveDurableJobs(): void {
  const durable = Object.values(scheduledJobs).filter(j => j.durable);
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2), "utf-8");
}

function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  try {
    const items = JSON.parse(fs.readFileSync(DURABLE_PATH, "utf-8"));
    for (const item of items) {
      const job: CronJob = item;
      if (!validateCron(job.cron)) {
        scheduledJobs[job.id] = job;
      }
    }
  } catch { /* ignore */ }
}

function scheduleJob(cron: string, prompt: string,
                     recurring: boolean = true, durable: boolean = true): CronJob | string {
  const err = validateCron(cron);
  if (err) return err;
  const job: CronJob = {
    id: `cron_${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`,
    cron, prompt, recurring, durable,
  };
  scheduledJobs[job.id] = job;
  if (durable) saveDurableJobs();
  return job;
}

function cancelJob(jobId: string): string {
  const job = scheduledJobs[jobId];
  if (!job) return `Job ${jobId} not found`;
  delete scheduledJobs[jobId];
  if (job.durable) saveDurableJobs();
  return `Cancelled ${jobId}`;
}

function cronSchedulerLoop(): void {
  setInterval(() => {
    const now = new Date();
    const marker = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    for (const job of Object.values(scheduledJobs)) {
      try {
        if (cronMatches(job.cron, now) && _lastFired[job.id] !== marker) {
          cronQueue.push(job);
          _lastFired[job.id] = marker;
          if (!job.recurring) {
            delete scheduledJobs[job.id];
            if (job.durable) saveDurableJobs();
          }
        }
      } catch (e: any) {
        console.log(`  \x1b[31m[cron error] ${job.id}: ${e.message}\x1b[0m`);
      }
    }
  }, 1000);
}

function consumeCronQueue(): CronJob[] {
  const fired = [...cronQueue];
  cronQueue.length = 0;
  return fired;
}

function runScheduleCron(cron: string, prompt: string,
                         recurring: boolean = true, durable: boolean = true): string {
  const result = scheduleJob(cron, prompt, recurring, durable);
  if (typeof result === "string") return `Error: ${result}`;
  return `Scheduled ${result.id}: '${cron}' -> ${prompt}`;
}

function runListCrons(): string {
  const jobs = Object.values(scheduledJobs);
  if (jobs.length === 0) return "No cron jobs.";
  return jobs.map(j =>
    `  ${j.id}: '${j.cron}' -> ${j.prompt.slice(0, 40)} ` +
    `[${j.recurring ? "recurring" : "one-shot"}, ${j.durable ? "durable" : "session"}]`
  ).join("\n");
}

function runCancelCron(jobId: string): string {
  return cancelJob(jobId);
}

loadDurableJobs();
cronSchedulerLoop();

// ── MCP System ──

class MCPClient {
  name: string;
  tools: any[] = [];
  private _handlers: Record<string, (...args: any[]) => string> = {};

  constructor(name: string) { this.name = name; }

  register(toolDefs: any[], handlers: Record<string, (...args: any[]) => string>): void {
    this.tools = toolDefs;
    this._handlers = handlers;
  }

  callTool(toolName: string, args: Record<string, unknown>): string {
    const handler = this._handlers[toolName];
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    try { return handler(...Object.values(args)); }
    catch (e: any) { return `MCP error: ${e.message}`; }
  }
}

const mcpClients: Record<string, MCPClient> = {};
const _DISALLOWED_CHARS = new RegExp("[^a-zA-Z0-9_-]", "g");

function normalizeMcpName(name: string): string {
  return name.replace(_DISALLOWED_CHARS, "_");
}

function _mockServerDocs(): MCPClient {
  const c = new MCPClient("docs");
  c.register(
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
  return c;
}

function _mockServerDeploy(): MCPClient {
  const c = new MCPClient("deploy");
  c.register(
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
  return c;
}

const MOCK_SERVERS: Record<string, () => MCPClient> = { docs: _mockServerDocs, deploy: _mockServerDeploy };

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
      const capturedClient = mcpClient;
      const capturedToolName = toolDef.name;
      handlers[prefixed] = (...args: any[]) => {
        const kw: Record<string, unknown> = args[0] || {};
        return capturedClient.callTool(capturedToolName, kw);
      };
    }
  }
  return [tools, handlers];
}

// ── Lead Worktree Tools ──

function runCreateWorktree(name: string, taskId: string = ""): string {
  return createWorktree(name, taskId);
}
function runRemoveWorktree(name: string, discardChanges: boolean = false): string {
  return removeWorktree(name, discardChanges);
}
function runKeepWorktree(name: string): string { return keepWorktree(name); }

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

function runGetTask(taskId: string): string {
  try { return getTaskJson(taskId); } catch { return `Error: task ${taskId} not found`; }
}
function runClaimTask(taskId: string): string {
  try { return claimTask(taskId, "agent"); } catch { return `Error: task ${taskId} not found`; }
}
function runCompleteTask(taskId: string): string {
  try { return completeTask(taskId); } catch { return `Error: task ${taskId} not found`; }
}

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
    input_schema: { type: "object", properties: { command: { type: "string" }, run_in_background: { type: "boolean" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "todo_write", description: "Create and manage a task list for the current session.",
    input_schema: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } },
  { name: "task", description: "Launch a focused subagent. Returns only its final summary.",
    input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
  { name: "load_skill", description: "Load the full content of a skill by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compact", description: "Summarize earlier conversation and continue with compacted context.",
    input_schema: { type: "object", properties: { focus: { type: "string" } }, required: [] } },
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
  { name: "schedule_cron", description: "Schedule a cron job. cron is 5-field: min hour dom month dow.",
    input_schema: { type: "object", properties: { cron: { type: "string" }, prompt: { type: "string" }, recurring: { type: "boolean" }, durable: { type: "boolean" } }, required: ["cron", "prompt"] } },
  { name: "list_crons", description: "List registered cron jobs.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "cancel_cron", description: "Cancel a cron job by ID.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
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
  bash: runBash, read_file: runRead, write_file: runWrite, edit_file: runEdit, glob: runGlob,
  todo_write: runTodoWrite, task: spawnSubagent, load_skill: loadSkill,
  create_task: runCreateTask, list_tasks: runListTasks, get_task: runGetTask,
  claim_task: runClaimTask, complete_task: runCompleteTask,
  schedule_cron: runScheduleCron, list_crons: runListCrons, cancel_cron: runCancelCron,
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
  return {
    memories,
    connected_mcp: Object.keys(mcpClients),
    active_teammates: Object.keys(activeTeammates),
  };
}

// ── Agent Loop ──

let roundsSinceTodo = 0;
let agentLock = false;

async function prepareContext(messages: any[]): Promise<any[]> {
  toolResultBudget(messages);
  snipCompact(messages);
  microCompact(messages);
  if (estimateSize(messages) > CONTEXT_LIMIT) {
    messages.splice(0, messages.length, ...(await compactHistory(messages)));
  }
  return messages;
}

function buildUserContent(results: any[]): any[] {
  const content = [...results];
  for (const note of collectBackgroundResults()) {
    content.push({ type: "text", text: note });
  }
  return content;
}

function injectBackgroundNotifications(messages: any[]): void {
  const notes = collectBackgroundResults();
  if (notes.length > 0) {
    messages.push({ role: "user", content: notes.map(note => ({ type: "text", text: note })) });
  }
}

async function callLlm(messages: any[], context: Record<string, unknown>,
                       tools: any[], state: RecoveryState, maxTokens: number): Promise<any> {
  const system = assembleSystemPrompt(context);
  return withRetry(
    () => client.messages.create({
      model: state.currentModel, system, messages, tools, max_tokens: maxTokens,
    }),
    state
  );
}

async function agentLoop(messages: any[], context: Record<string, unknown>): Promise<void> {
  let [tools, handlers] = assembleToolPool();
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    // Inject scheduled/background work
    const fired = consumeCronQueue();
    for (const job of fired) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      console.log(`  \x1b[35m[cron inject] ${job.prompt.slice(0, 60)}\x1b[0m`);
    }

    injectBackgroundNotifications(messages);

    if (roundsSinceTodo >= 3) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    await prepareContext(messages);
    context = updateContext(context, messages);
    [tools, handlers] = assembleToolPool();

    let response: any;
    try {
      response = await callLlm(messages, context, tools, state, maxTokens);
    } catch (e: any) {
      if (isPromptTooLongError(e) && !state.hasAttemptedReactiveCompact) {
        messages.splice(0, messages.length, ...(await reactiveCompact(messages)));
        state.hasAttemptedReactiveCompact = true;
        continue;
      }
      messages.push({ role: "assistant", content: [
        { type: "text", text: `[Error] ${e.constructor?.name || "Error"}: ${e.message}` }] });
      return;
    }

    if (response.stop_reason === "max_tokens") {
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(`  \x1b[33m[max_tokens] retry with ${maxTokens}\x1b[0m`);
        continue;
      }
      messages.push({ role: "assistant", content: response.content });
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT });
        state.recoveryCount++;
        continue;
      }
      return;
    }

    maxTokens = DEFAULT_MAX_TOKENS;
    state.hasEscalated = false;
    messages.push({ role: "assistant", content: response.content });
    if (!hasToolUse(response.content)) {
      triggerHooks("Stop", messages);
      return;
    }

    const results: any[] = [];
    let compactedNow = false;
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      if (block.name === "compact") {
        messages.splice(0, messages.length, ...(await compactHistory(messages)));
        messages.push({ role: "user", content: "[Compacted. Continue with summarized context.]" });
        compactedNow = true;
        break;
      }

      const blocked = triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(blocked) });
        continue;
      }

      if (shouldRunBackground(block.name, block.input)) {
        const bgId = startBackgroundTask(block, handlers);
        const output = `[Background task ${bgId} started] Result will arrive as a task_notification.`;
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        continue;
      }

      const handler = handlers[block.name];
      const output = callToolHandler(handler, block.input, block.name);
      triggerHooks("PostToolUse", block, output);
      console.log(String(output).slice(0, 300));

      if (block.name === "todo_write") {
        roundsSinceTodo = 0;
      } else {
        roundsSinceTodo++;
      }

      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    if (compactedNow) continue;

    messages.push({ role: "user", content: buildUserContent(results) });
  }
}

function printTurnAssistants(messages: any[], turnStart: number): void {
  for (let i = turnStart; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const content = msg.content || [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") terminalPrint(block.text);
      }
    }
  }
}

async function cronAutorunLoop(history: any[], context: Record<string, unknown>): Promise<void> {
  while (true) {
    await sleep(1);
    const fired = consumeCronQueue();
    if (fired.length === 0) continue;
    const turnStart = history.length;
    for (const job of fired) {
      history.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      terminalPrint(`  \x1b[35m[cron auto] ${job.prompt.slice(0, 60)}\x1b[0m`);
    }
    await agentLoop(history, context);
    context = updateContext(context, history);
    printTurnAssistants(history, turnStart);
  }
}

// ── Main ──

async function main(): Promise<void> {
  CLI_ACTIVE = true;
  console.log("s20: comprehensive agent");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const history: any[] = [];
  let context = updateContext({}, []);

  // Start cron autorun in background
  setTimeout(() => { cronAutorunLoop(history, context).catch(console.error); }, 0);

  const ask = (): Promise<string> => new Promise(r => rl.question(PROMPT, r));

  while (true) {
    let query: string;
    try { query = await ask(); } catch { break; }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;

    triggerHooks("UserPromptSubmit", query);
    const turnStart = history.length;
    history.push({ role: "user", content: query });

    await agentLoop(history, context);
    context = updateContext(context, history);
    printTurnAssistants(history, turnStart);

    const inbox = consumeLeadInbox(true);
    if (inbox.length > 0) {
      function inboxLabel(msg: BusMessage): string {
        const reqId = (msg.metadata || {})["request_id"] as string || "";
        const suffix = reqId ? ` req:${reqId}` : "";
        return `${msg.type || "message"}${suffix}`;
      }
      const inboxText = inbox.map(m =>
        `From ${m.from} [${inboxLabel(m)}]: ${m.content.slice(0, 200)}`
      ).join("\n");
      history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
    }
    console.log();
  }

  rl.close();
}

main().catch(console.error);
