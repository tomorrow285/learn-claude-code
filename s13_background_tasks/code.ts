#!/usr/bin/env tsx
/**
 * s13: Background Tasks — async execution + notification injection.
 *
 * Run:  tsx s13_background_tasks/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s12:
 *   - Promise-based background execution (replaces threading.Thread)
 *   - backgroundTasks map for lifecycle tracking (bg_id, command, status)
 *   - backgroundResults map + Mutex for thread-safe storage
 *   - shouldRunBackground: model explicit request via run_in_background param
 *   - isSlowOperation: fallback heuristic when model doesn't specify
 *   - startBackgroundTask: dispatch to async Promise, return bg task id
 *   - collectBackgroundResults: gather completed, return as notifications
 *   - agent_loop: slow ops -> background + placeholder, inject notifications
 *   - Notifications use <task_notification> format, not reused tool_use_id
 *
 * Note: Teaching code keeps a basic agent loop to stay focused on background
 * tasks. S11's full error recovery (RecoveryState, backoff, escalation,
 * reactive compact, fallback model) is omitted.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync, exec } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

// ── Setup ──

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const MEMORY_DIR = path.join(WORKDIR, '.memory');
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

const client = new Anthropic({
  apiKey: (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) ?? 'unused',
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;

// ── Task System (from s12, synced) ──

const TASKS_DIR = path.join(WORKDIR, '.tasks');
fs.mkdirSync(TASKS_DIR, { recursive: true });

interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;       // pending | in_progress | completed
  owner: string | null;
  blockedBy: string[];
}

function taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function createTask(
  subject: string,
  description: string = "",
  blockedBy: string[] | null = null,
): Task {
  const task: Task = {
    id: `task_${Math.floor(Date.now() / 1000)}_${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    subject,
    description,
    status: "pending",
    owner: null,
    blockedBy: blockedBy ?? [],
  };
  saveTask(task);
  return task;
}

function saveTask(task: Task): void {
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf-8');
}

function loadTask(taskId: string): Task {
  return JSON.parse(fs.readFileSync(taskPath(taskId), 'utf-8')) as Task;
}

function listTasks(): Task[] {
  const files = fs.readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith('task_') && f.endsWith('.json'))
    .sort();
  return files.map((f) =>
    JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf-8')) as Task,
  );
}

function getTask(taskId: string): string {
  const task = loadTask(taskId);
  return JSON.stringify(task, null, 2);
}

function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  for (const depId of task.blockedBy) {
    if (!fs.existsSync(taskPath(depId))) return false;
    if (loadTask(depId).status !== "completed") return false;
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
      (d) => !fs.existsSync(taskPath(d)) || loadTask(d).status !== "completed",
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
    .filter((t) => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map((t) => t.subject);
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
  tools:
    "Available tools: bash, read_file, write_file, " +
    "create_task, list_tasks, get_task, claim_task, complete_task.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

function assembleSystemPrompt(context: Record<string, unknown>): string {
  const sections = [
    PROMPT_SECTIONS["identity"],
    PROMPT_SECTIONS["tools"],
    PROMPT_SECTIONS["workspace"],
  ];
  const memories = context["memories"] as string | undefined;
  if (memories) {
    sections.push(`Relevant memories:\n${memories}`);
  }
  return sections.join("\n\n");
}

let _lastContextKey: string | null = null;
let _lastPrompt: string | null = null;

function getSystemPrompt(context: Record<string, unknown>): string {
  const key = JSON.stringify(context, Object.keys(context).sort());
  if (key === _lastContextKey && _lastPrompt) return _lastPrompt;
  _lastContextKey = key;
  _lastPrompt = assembleSystemPrompt(context);
  return _lastPrompt;
}

// ── Tools ──

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string, _runInBackground: boolean = false): string {
  // runInBackground is handled by agent_loop dispatch, not here
  try {
    const result = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const output = result.trim();
    return output.length > 50000 ? output.slice(0, 50000) : (output || "(no output)");
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) return "Error: Timeout (120s)";
    const out = ((err.stdout || '') + (err.stderr || '')).trim();
    return out.length > 50000 ? out.slice(0, 50000) : (out || "(no output)");
  }
}

function runRead(p: string, limit?: number | null): string {
  try {
    const filePath = safePath(p);
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    if (limit != null && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join('\n');
    }
    return lines.join('\n');
  } catch (e: unknown) {
    return `Error: ${String(e)}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: unknown) {
    return `Error: ${String(e)}`;
  }
}

// Task tools

function runCreateTask(
  subject: string,
  description: string = "",
  blockedBy: string[] | null = null,
): string {
  const task = createTask(subject, description, blockedBy);
  const deps = blockedBy ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (tasks.length === 0) return "No tasks. Use create_task to add some.";
  const iconMap: Record<string, string> = {
    pending: "○",
    in_progress: "●",
    completed: "✓",
  };
  return tasks
    .map((t) => {
      const icon = iconMap[t.status] ?? "?";
      const deps = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.join(", ")})` : "";
      const owner = t.owner ? ` [${t.owner}]` : "";
      return `  ${icon} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`;
    })
    .join("\n");
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

// ── Tool Definitions ──

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        run_in_background: { type: "boolean" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task with optional blockedBy dependencies.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
        blockedBy: { type: "array", items: { type: "string" } },
      },
      required: ["subject"],
    },
  },
  {
    name: "list_tasks",
    description: "List all tasks with status, owner, and dependencies.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_task",
    description: "Get full details of a specific task by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "claim_task",
    description: "Claim a pending task. Sets owner, changes status to in_progress.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "complete_task",
    description: "Complete an in-progress task. Reports unblocked downstream tasks.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
];

type ToolHandler = (input: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command as string, (input.run_in_background as boolean) ?? false),
  read_file: (input) => runRead(input.path as string, input.limit as number | null | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  create_task: (input) =>
    runCreateTask(
      input.subject as string,
      (input.description as string) ?? "",
      (input.blockedBy as string[]) ?? null,
    ),
  list_tasks: () => runListTasks(),
  get_task: (input) => runGetTask(input.task_id as string),
  claim_task: (input) => runClaimTask(input.task_id as string),
  complete_task: (input) => runCompleteTask(input.task_id as string),
};

// ── Background Tasks (s13 new) ──

// Simple Mutex — in single-threaded JS, this serves as a documentation
// pattern. Within synchronous code sections, there is no preemption.
class Mutex {
  private _locked = false;

  acquire(): void {
    if (this._locked) throw new Error("Mutex already locked");
    this._locked = true;
  }

  release(): void {
    this._locked = false;
  }

  get locked(): boolean {
    return this._locked;
  }
}

let _bgCounter = 0;

interface BgTask {
  toolUseId: string;
  command: string;
  status: string; // running | completed
}

const backgroundTasks: Record<string, BgTask> = {};
const backgroundResults: Record<string, string> = {};
const backgroundLock = new Mutex();

function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  /** Fallback heuristic: commands likely to take > 30s. */
  if (toolName !== "bash") return false;
  const cmd = String(toolInput["command"] ?? "").toLowerCase();
  const slowKeywords = [
    "install", "build", "test", "deploy", "compile",
    "docker build", "pip install", "npm install",
    "cargo build", "pytest", "make",
  ];
  return slowKeywords.some((kw) => cmd.includes(kw));
}

function shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  /** Model explicit request takes priority; fallback to heuristic. */
  if (toolInput["run_in_background"]) return true;
  return isSlowOperation(toolName, toolInput);
}

function executeToolSync(block: { name: string; input: Record<string, unknown> }): string {
  /** Execute a tool call block, return output. */
  const handler = TOOL_HANDLERS[block.name];
  if (handler) return handler(block.input);
  return `Unknown tool: ${block.name}`;
}

function execAsync(command: string): Promise<string> {
  /** Run a shell command asynchronously and return stdout. */
  return new Promise((resolve) => {
    exec(command, { cwd: WORKDIR, encoding: 'utf-8', timeout: 600000 }, (error, stdout, stderr) => {
      const out = ((stdout || '') + (stderr || '')).trim();
      const result = out.length > 50000 ? out.slice(0, 50000) : (out || "(no output)");
      resolve(result);
    });
  });
}

function startBackgroundTask(block: { name: string; input: Record<string, unknown>; id: string }): string {
  /** Run tool asynchronously. Returns background task ID. */
  _bgCounter += 1;
  const bgId = `bg_${String(_bgCounter).padStart(4, '0')}`;
  const cmd = String(block.input["command"] ?? block.name);

  // Dispatch async work
  const promise = block.name === "bash"
    ? execAsync(cmd)
    : Promise.resolve(executeToolSync(block));

  promise.then((result) => {
    backgroundLock.acquire();
    try {
      if (backgroundTasks[bgId]) {
        backgroundTasks[bgId].status = "completed";
      }
      backgroundResults[bgId] = result;
    } finally {
      backgroundLock.release();
    }
  });

  backgroundLock.acquire();
  try {
    backgroundTasks[bgId] = {
      toolUseId: block.id,
      command: cmd,
      status: "running",
    };
  } finally {
    backgroundLock.release();
  }
  console.log(`  \x1b[33m[background] dispatched ${bgId}: ${cmd.slice(0, 40)}\x1b[0m`);
  return bgId;
}

function collectBackgroundResults(): string[] {
  /** Collect completed background results as task_notification messages. */
  backgroundLock.acquire();
  const readyIds: string[] = [];
  try {
    for (const [bid, task] of Object.entries(backgroundTasks)) {
      if (task.status === "completed") readyIds.push(bid);
    }
  } finally {
    backgroundLock.release();
  }

  const notifications: string[] = [];
  for (const bgId of readyIds) {
    backgroundLock.acquire();
    let task: BgTask;
    let output: string;
    try {
      task = backgroundTasks[bgId];
      delete backgroundTasks[bgId];
      output = backgroundResults[bgId] ?? "";
      delete backgroundResults[bgId];
    } finally {
      backgroundLock.release();
    }
    const summary = output.length > 200 ? output.slice(0, 200) : output;
    notifications.push(
      `<task_notification>\n` +
      `  <task_id>${bgId}</task_id>\n` +
      `  <status>completed</status>\n` +
      `  <command>${task.command}</command>\n` +
      `  <summary>${summary}</summary>\n` +
      `</task_notification>`,
    );
    console.log(
      `  \x1b[32m[background done] ${bgId}: ${task.command.slice(0, 40)} (${output.length} chars)\x1b[0m`,
    );
  }
  return notifications;
}

// ── Context ──

function updateContext(
  _context: Record<string, unknown>,
  _messages: Anthropic.Messages.MessageParam[],
): Record<string, unknown> {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    const content = fs.readFileSync(MEMORY_INDEX, 'utf-8').trim();
    if (content) memories = content;
  }
  return {
    enabled_tools: Object.keys(TOOL_HANDLERS),
    workspace: WORKDIR,
    memories,
  };
}

// ── Agent Loop (simplified, focused on background tasks) ──

async function agentLoop(
  messages: Anthropic.Messages.MessageParam[],
  context: Record<string, unknown>,
): Promise<void> {
  let system = getSystemPrompt(context);
  while (true) {
    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        system,
        messages,
        tools: TOOLS as Anthropic.Messages.Tool[],
        max_tokens: 8000,
      });
    } catch (e: unknown) {
      const name = e instanceof Error ? e.constructor.name : String(e);
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `[Error] ${name}: ${String(e)}` }],
      });
      return;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      if (shouldRunBackground(block.name, block.input as Record<string, unknown>)) {
        const bgId = startBackgroundTask({
          name: block.name,
          input: block.input as Record<string, unknown>,
          id: block.id,
        });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            `[Background task ${bgId} started] ` +
            `Command: ${block.input["command"] ?? ''}. ` +
            `Result will be available when complete.`,
        });
      } else {
        const output = executeToolSync({
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
        console.log(String(output).slice(0, 300));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // Inject tool results + background notifications in one user message
    const userContent: Anthropic.Messages.ContentBlockParam[] = [...results];
    const bgNotifications = collectBackgroundResults();
    if (bgNotifications.length > 0) {
      for (const notif of bgNotifications) {
        userContent.push({ type: "text", text: notif });
      }
      console.log(
        `  \x1b[32m[inject] ${bgNotifications.length} background notification(s)\x1b[0m`,
      );
    }
    messages.push({ role: "user", content: userContent });
    context = updateContext(context, messages);
    system = getSystemPrompt(context);
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log("s13: background tasks");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const history: Anthropic.Messages.MessageParam[] = [];
  let context = updateContext({}, []);

  while (true) {
    let query: string;
    try {
      query = await question("\x1b[36ms13 >> \x1b[0m");
    } catch {
      break;
    }
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") break;

    history.push({ role: "user", content: query });
    await agentLoop(history, context);
    context = updateContext(context, history);

    const lastMsg = history[history.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      const content = lastMsg.content;
      if (typeof content === "string") {
        console.log(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && "type" in block) {
            const b = block as { type: string; text?: string };
            if (b.type === "text" && b.text) console.log(b.text);
          }
        }
      }
    }
    console.log();
  }
  rl.close();
}

main().catch(console.error);
