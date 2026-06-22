#!/usr/bin/env tsx
/**
 * s15: Agent Teams — MessageBus + spawn_teammate_thread + inbox injection.
 *
 * Run:  tsx s15_agent_teams/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s14:
 *   - MessageBus class: file-based mailboxes (.mailboxes/*.jsonl)
 *   - spawnTeammateThread: creates teammate in background
 *   - Teammate runs own simplified agent_loop (bash, read, write, send_message)
 *   - Lead tools: spawn_teammate, send_message, check_inbox (3 new)
 *   - Lead inbox: teammate messages injected into history (not just printed)
 *   - Teaching version: teammates limited to 10 rounds (real CC uses idle loop)
 *
 * ASCII flow:
 *   Lead: cron_queue -> messages -> prompt -> LLM -> TOOLS ----> loop
 *                 ^                     |                        |
 *                 +-- inbox <- MessageBus <- teammate.send_message <-+
 *   Teammate: inbox -> LLM -> bash/read/write/send -> loop (max 10 turns)
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
    "get_task, create_task, list_tasks, claim_task, complete_task, " +
    "schedule_cron, list_crons, cancel_cron, " +
    "spawn_teammate, send_message, check_inbox.",
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

// ── Background Tasks (from s13, synced) ──

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
  status: string;
}

const backgroundTasks: Record<string, BgTask> = {};
const backgroundResults: Record<string, string> = {};
const backgroundLock = new Mutex();

function execAsync(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd: WORKDIR, encoding: 'utf-8', timeout: 600000 }, (_error, stdout, stderr) => {
      const out = ((stdout || '') + (stderr || '')).trim();
      resolve(out.length > 50000 ? out.slice(0, 50000) : (out || "(no output)"));
    });
  });
}

function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
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
  if (toolInput["run_in_background"]) return true;
  return isSlowOperation(toolName, toolInput);
}

// Tool handler reference — set after all handlers are defined
let _executeToolRef: ((block: { name: string; input: Record<string, unknown> }) => string) | null = null;
function executeTool(block: { name: string; input: Record<string, unknown> }): string {
  if (_executeToolRef) return _executeToolRef(block);
  return `Unknown tool: ${block.name}`;
}

function startBackgroundTask(block: { name: string; input: Record<string, unknown>; id: string }): string {
  _bgCounter += 1;
  const bgId = `bg_${String(_bgCounter).padStart(4, '0')}`;
  const cmd = String(block.input["command"] ?? block.name);

  const promise = block.name === "bash"
    ? execAsync(cmd)
    : Promise.resolve(executeTool(block));

  promise.then((result) => {
    backgroundLock.acquire();
    try {
      if (backgroundTasks[bgId]) backgroundTasks[bgId].status = "completed";
      backgroundResults[bgId] = result;
    } finally {
      backgroundLock.release();
    }
  });

  backgroundLock.acquire();
  try {
    backgroundTasks[bgId] = { toolUseId: block.id, command: cmd, status: "running" };
  } finally {
    backgroundLock.release();
  }
  console.log(`  \x1b[33m[background] dispatched ${bgId}: ${cmd.slice(0, 40)}\x1b[0m`);
  return bgId;
}

function collectBackgroundResults(): string[] {
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

// ── Cron Scheduler (from s14, synced) ──

const DURABLE_PATH = path.join(WORKDIR, '.scheduled_tasks.json');

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}

const scheduledJobs: Record<string, CronJob> = {};
const cronQueue: CronJob[] = [];
const cronLock = new Mutex();
const _lastFired: Record<string, string> = {};

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function formatTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatMinuteMarker(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

function cronDow(d: Date): number {
  return d.getDay();
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").some((f) => cronFieldMatches(f.trim(), value));
  }
  if (field.includes("-")) {
    const [loStr, hiStr] = field.split("-", 2);
    const lo = parseInt(loStr, 10);
    const hi = parseInt(hiStr, 10);
    return lo <= value && value <= hi;
  }
  return value === parseInt(field, 10);
}

function cronMatches(cronExpr: string, dt: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const dowVal = cronDow(dt);

  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const domOk = cronFieldMatches(dom, dt.getDate());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1);
  const dowOk = cronFieldMatches(dow, dowVal);

  if (!(m && h && monthOk)) return false;
  const domUnconstrained = dom === "*";
  const dowUnconstrained = dow === "*";
  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk;
}

function validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const stepStr = field.slice(2);
    if (!/^\d+$/.test(stepStr)) return `Invalid step: ${field}`;
    const step = parseInt(stepStr, 10);
    if (step <= 0) return `Step must be > 0: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const err = validateCronField(part.trim(), lo, hi);
      if (err) return err;
    }
    return null;
  }
  if (field.includes("-")) {
    const parts = field.split("-", 2);
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      return `Invalid range: ${field}`;
    }
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    if (a < lo || a > hi || b < lo || b > hi) {
      return `Range ${field} out of bounds [${lo}-${hi}]`;
    }
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const val = parseInt(field, 10);
  if (val < lo || val > hi) return `Value ${val} out of bounds [${lo}-${hi}]`;
  return null;
}

function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const bounds: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1]);
    if (err) return `${names[i]}: ${err}`;
  }
  return null;
}

function saveDurableJobs(): void {
  const durable = Object.values(scheduledJobs).filter((j) => j.durable);
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2), 'utf-8');
}

function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  try {
    const jobs: CronJob[] = JSON.parse(fs.readFileSync(DURABLE_PATH, 'utf-8'));
    for (const j of jobs) {
      const err = validateCron(j.cron);
      if (err) {
        console.log(`  \x1b[31m[cron] skipping invalid job ${j.id}: ${err}\x1b[0m`);
        continue;
      }
      scheduledJobs[j.id] = j;
    }
    const valid = jobs.filter((j) => j.id in scheduledJobs);
    if (valid.length > 0) {
      console.log(`  \x1b[35m[cron] loaded ${valid.length} durable job(s)\x1b[0m`);
    }
  } catch {
    // silently ignore corrupt file
  }
}

function scheduleJob(
  cron: string,
  prompt: string,
  recurring: boolean = true,
  durable: boolean = true,
): CronJob | string {
  const err = validateCron(cron);
  if (err) return err;
  const job: CronJob = {
    id: `cron_${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`,
    cron,
    prompt,
    recurring,
    durable,
  };
  cronLock.acquire();
  try { scheduledJobs[job.id] = job; } finally { cronLock.release(); }
  if (durable) saveDurableJobs();
  console.log(`  \x1b[35m[cron register] ${job.id} '${cron}' → ${prompt.slice(0, 40)}\x1b[0m`);
  return job;
}

function cancelJob(jobId: string): string {
  cronLock.acquire();
  let job: CronJob | undefined;
  try {
    job = scheduledJobs[jobId];
    delete scheduledJobs[jobId];
  } finally {
    cronLock.release();
  }
  if (!job) return `Job ${jobId} not found`;
  if (job.durable) saveDurableJobs();
  console.log(`  \x1b[31m[cron cancel] ${jobId}\x1b[0m`);
  return `Cancelled ${jobId}`;
}

function consumeCronQueue(): CronJob[] {
  cronLock.acquire();
  try {
    const fired = [...cronQueue];
    cronQueue.length = 0;
    return fired;
  } finally {
    cronLock.release();
  }
}

// Cron tool handlers

function runScheduleCron(
  cron: string,
  prompt: string,
  recurring: boolean = true,
  durable: boolean = true,
): string {
  const result = scheduleJob(cron, prompt, recurring, durable);
  if (typeof result === "string") return `Error: ${result}`;
  return `Scheduled ${result.id}: '${cron}' → ${prompt}`;
}

function runListCrons(): string {
  cronLock.acquire();
  let jobs: CronJob[];
  try { jobs = Object.values(scheduledJobs); } finally { cronLock.release(); }
  if (jobs.length === 0) return "No cron jobs. Use schedule_cron to add one.";
  return jobs
    .map((j) => {
      const tag = j.recurring ? "recurring" : "one-shot";
      const dur = j.durable ? "durable" : "session";
      return `  ${j.id}: '${j.cron}' → ${j.prompt.slice(0, 40)} [${tag}, ${dur}]`;
    })
    .join("\n");
}

function runCancelCron(jobId: string): string {
  return cancelJob(jobId);
}

// ── MessageBus (s15 new) ──
// Teaching version uses simple file append + unlink.
// Real CC uses proper-lockfile for concurrent write safety.

const MAILBOX_DIR = path.join(WORKDIR, '.mailboxes');
fs.mkdirSync(MAILBOX_DIR, { recursive: true });

interface BusMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
}

class MessageBus {
  /** File-based message bus. Each agent has a .jsonl inbox.
   *  Read is destructive: readFileSync + unlinkSync (consumes messages).
   *  Teaching version: no file locking; real CC uses proper-lockfile. */

  send(fromAgent: string, toAgent: string, content: string, msgType: string = "message"): void {
    const msg: BusMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type: msgType,
      ts: Date.now() / 1000,
    };
    const inbox = path.join(MAILBOX_DIR, `${toAgent}.jsonl`);
    fs.appendFileSync(inbox, JSON.stringify(msg) + "\n", 'utf-8');
    console.log(`  \x1b[33m[bus] ${fromAgent} → ${toAgent}: ${content.slice(0, 50)}\x1b[0m`);
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const text = fs.readFileSync(inbox, 'utf-8');
    const msgs = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BusMessage);
    fs.unlinkSync(inbox); // consume: read + delete
    return msgs;
  }
}

const BUS = new MessageBus();

// Track spawned teammates
const activeTeammates: Record<string, boolean> = {};

// ── Teammate Thread (s15 new) ──

function spawnTeammateThread(name: string, role: string, prompt: string): string {
  /** Spawn a teammate agent in background.
   *  Teaching version: max 10 rounds per teammate.
   *  Real CC: teammates use idle loop (wait for inbox, work, repeat)
   *  until shutdownRequest. */
  if (name in activeTeammates) {
    return `Teammate '${name}' already exists`;
  }

  const system = (
    `You are '${name}', a ${role}. ` +
    `Use tools to complete tasks. ` +
    `Send results via send_message to 'lead'.`
  );

  async function run(): Promise<void> {
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    const subTools: Anthropic.Messages.Tool[] = [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
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
        name: "send_message",
        description: "Send a message to another agent.",
        input_schema: {
          type: "object",
          properties: { to: { type: "string" }, content: { type: "string" } },
          required: ["to", "content"],
        },
      },
    ];

    interface SubHandler {
      (input: Record<string, unknown>): string;
    }

    const subHandlers: Record<string, SubHandler> = {
      bash: (input) => runBash(input.command as string),
      read_file: (input) => runRead(input.path as string),
      write_file: (input) => runWrite(input.path as string, input.content as string),
      send_message: (input) => {
        BUS.send(name, input.to as string, input.content as string);
        return "Sent";
      },
    };

    for (let round = 0; round < 10; round++) {
      const inbox = BUS.readInbox(name);
      if (inbox.length > 0) {
        messages.push({
          role: "user",
          content: `<inbox>${JSON.stringify(inbox)}</inbox>`,
        });
      }
      let response: Anthropic.Messages.Message;
      try {
        response = await client.messages.create({
          model: MODEL,
          system,
          messages: messages.slice(-20),
          tools: subTools,
          max_tokens: 8000,
        });
      } catch {
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const handler = subHandlers[block.name];
          const output = handler
            ? handler(block.input as Record<string, unknown>)
            : "Unknown";
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: String(output),
          });
        }
      }
      messages.push({ role: "user", content: results });
    }

    // Send final summary to Lead
    let summary = "Done.";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (typeof b === "object" && b !== null && "type" in b) {
            const block = b as { type: string; text?: string };
            if (block.type === "text" && block.text) {
              summary = block.text;
              break;
            }
          }
        }
        if (summary !== "Done.") break;
      }
    }
    BUS.send(name, "lead", summary, "result");
    delete activeTeammates[name];
    console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`);
  }

  activeTeammates[name] = true;
  // Launch teammate as background async task
  run().catch((e) => {
    console.log(`  \x1b[31m[teammate] ${name} error: ${String(e)}\x1b[0m`);
    delete activeTeammates[name];
  });
  console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`);
  return `Teammate '${name}' spawned as ${role}`;
}

// ── Team Tool Handlers (s15 new) ──

function runSpawnTeammate(name: string, role: string, prompt: string): string {
  return spawnTeammateThread(name, role, prompt);
}

function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

function runCheckInbox(): string {
  const msgs = BUS.readInbox("lead");
  if (msgs.length === 0) return "(inbox empty)";
  return msgs
    .map((m) => `  [${m.from}] ${m.content.slice(0, 200)}`)
    .join("\n");
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
  {
    name: "schedule_cron",
    description: "Schedule a cron job. cron is 5-field: min hour dom month dow.",
    input_schema: {
      type: "object",
      properties: {
        cron: { type: "string", description: "5-field cron expression" },
        prompt: { type: "string", description: "Message to inject when fired" },
        recurring: { type: "boolean", description: "True=recurring, False=one-shot" },
        durable: { type: "boolean", description: "True=persist to disk" },
      },
      required: ["cron", "prompt"],
    },
  },
  {
    name: "list_crons",
    description: "List all registered cron jobs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_cron",
    description: "Cancel a cron job by ID.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "spawn_teammate",
    description: "Spawn a teammate agent in a background thread.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate via MessageBus.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" } },
      required: ["to", "content"],
    },
  },
  {
    name: "check_inbox",
    description: "Check Lead's inbox for teammate messages.",
    input_schema: { type: "object", properties: {}, required: [] },
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
  schedule_cron: (input) =>
    runScheduleCron(
      input.cron as string,
      input.prompt as string,
      (input.recurring as boolean) ?? true,
      (input.durable as boolean) ?? true,
    ),
  list_crons: () => runListCrons(),
  cancel_cron: (input) => runCancelCron(input.job_id as string),
  spawn_teammate: (input) =>
    runSpawnTeammate(
      input.name as string,
      input.role as string,
      input.prompt as string,
    ),
  send_message: (input) => runSendMessage(input.to as string, input.content as string),
  check_inbox: () => runCheckInbox(),
};

// Set the executeTool reference after handlers are defined
_executeToolRef = (block: { name: string; input: Record<string, unknown> }): string => {
  const handler = TOOL_HANDLERS[block.name];
  if (handler) return handler(block.input);
  return `Unknown tool: ${block.name}`;
};

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
    enabled_tools: TOOLS.map((t) => t.name),
    workspace: WORKDIR,
    memories,
  };
}

// ── Agent Loop ──
// Teaching code keeps a basic agent loop. S11's full error recovery is omitted.
// Cron queue is consumed when agent_loop is called; real CC auto-wakes via
// queue processor (useQueueProcessor.ts) when items arrive.

async function agentLoop(
  messages: Anthropic.Messages.MessageParam[],
  context: Record<string, unknown>,
): Promise<void> {
  let system = getSystemPrompt(context);
  while (true) {
    // Consume fired cron jobs -> inject as messages
    const fired = consumeCronQueue();
    for (const job of fired) {
      messages.push({
        role: "user",
        content: `[Scheduled] ${job.prompt}`,
      });
      console.log(`  \x1b[35m[inject cron] ${job.prompt.slice(0, 50)}\x1b[0m`);
    }

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
          content: `[Background task ${bgId} started] Result will be available when complete.`,
        });
      } else {
        const output = executeTool({
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

    // Merge background tool results + notifications into one user message
    const userContent: Anthropic.Messages.ContentBlockParam[] = [...results];
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
  console.log("s15: agent teams");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  // Start cron scheduler
  loadDurableJobs();
  setInterval(() => {
    const now = new Date();
    const minuteMarker = formatMinuteMarker(now);
    cronLock.acquire();
    try {
      for (const job of Object.values(scheduledJobs)) {
        try {
          if (cronMatches(job.cron, now)) {
            if (_lastFired[job.id] !== minuteMarker) {
              cronQueue.push(job);
              _lastFired[job.id] = minuteMarker;
              console.log(`  \x1b[35m[cron fire] ${job.id} → ${job.prompt.slice(0, 40)}\x1b[0m`);
            }
            if (!job.recurring) {
              delete scheduledJobs[job.id];
              if (job.durable) saveDurableJobs();
            }
          }
        } catch (e) {
          console.log(`  \x1b[31m[cron error] ${job.id}: ${String(e)}\x1b[0m`);
        }
      }
    } finally {
      cronLock.release();
    }
  }, 1000);
  console.log(`  \x1b[35m[cron] scheduler started\x1b[0m`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const history: Anthropic.Messages.MessageParam[] = [];
  let context = updateContext({}, []);

  while (true) {
    let query: string;
    try {
      query = await question("\x1b[36ms15 >> \x1b[0m");
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

    // Check inbox for teammate results -> inject into history
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      const inboxText = inbox
        .map((m) => `From ${m.from}: ${m.content.slice(0, 200)}`)
        .join("\n");
      history.push({
        role: "user",
        content: `[Inbox]\n${inboxText}`,
      });
      console.log(`\n\x1b[33m[Inbox: ${inbox.length} messages injected]\x1b[0m`);
    }
    console.log();
  }
  rl.close();
}

main().catch(console.error);
