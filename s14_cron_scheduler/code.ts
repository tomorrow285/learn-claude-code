#!/usr/bin/env tsx
/**
 * s14: Cron Scheduler — interval-based daemon + queue processor.
 *
 * Run:  tsx s14_cron_scheduler/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s13:
 *   - CronJob interface (id, cron, prompt, recurring, durable)
 *   - cronMatches: 5-field cron expression matching with DOM/DOW OR semantics
 *   - scheduleJob / cancelJob: register/remove cron jobs (with validation)
 *   - cronSchedulerLoop: interval-based, polls every 1s
 *   - cronQueue: synchronized queue, scheduler writes, queue processor delivers
 *   - queueProcessorLoop: auto-runs agent_loop when cronQueue has work
 *   - Durable storage: .scheduled_tasks.json (survives restart)
 *   - 3 new tools: schedule_cron, list_crons, cancel_cron
 *
 * Four layers:
 *   1. Scheduler: interval checks time -> fires matching jobs
 *   2. Queue: cronQueue decouples scheduler from agent loop
 *   3. Queue processor: wakes the agent when queued work exists and it is idle
 *   4. Consumer: agent_loop consumes queued jobs and injects them into messages
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
    "create_task, list_tasks, get_task, claim_task, complete_task, " +
    "schedule_cron, list_crons, cancel_cron.",
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

// Tool handler lookup — defined after cron tools are registered
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

// ── Cron Scheduler (s14 new) ──

const DURABLE_PATH = path.join(WORKDIR, '.scheduled_tasks.json');

interface CronJob {
  id: string;
  cron: string;        // "0 9 * * *"
  prompt: string;      // message to inject when fired
  recurring: boolean;  // true = recurring, false = one-shot
  durable: boolean;    // true = persist to disk
}

const scheduledJobs: Record<string, CronJob> = {};
const cronQueue: CronJob[] = [];
const cronLock = new Mutex();
const agentLock = new Mutex();
const _lastFired: Record<string, string> = {};  // job_id -> "YYYY-MM-DD HH:MM"

// ── datetime helper ──

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
  // JavaScript getDay(): Sunday=0 ... Saturday=6
  // Cron: Sunday=0 ... Saturday=6 (same!)
  return d.getDay();
}

// ── cron matching ──

function cronFieldMatches(field: string, value: number): boolean {
  /** Match a single cron field against a value. */
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
  /** Check if a 5-field cron expression matches the given datetime.
   *  Standard cron semantics: DOM and DOW use OR when both are constrained. */
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const dowVal = cronDow(dt);

  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const domOk = cronFieldMatches(dom, dt.getDate());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1); // JS month is 0-based
  const dowOk = cronFieldMatches(dow, dowVal);

  // Minute, hour, month must all match
  if (!(m && h && monthOk)) return false;
  // DOM and DOW: if both constrained, either matching is enough (OR)
  const domUnconstrained = dom === "*";
  const dowUnconstrained = dow === "*";
  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk;
}

// ── cron validation ──

function validateCronField(field: string, lo: number, hi: number): string | null {
  /** Validate a single cron field value is within [lo, hi]. */
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
  /** Validate a cron expression. Returns error message or null. */
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

// ── durable persistence ──

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

// ── job management ──

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
  try {
    scheduledJobs[job.id] = job;
  } finally {
    cronLock.release();
  }
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

// ── Cron Tools ──

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
  try {
    jobs = Object.values(scheduledJobs);
  } finally {
    cronLock.release();
  }
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
};

// Set the executeTool reference after handlers are defined
_executeToolRef = (block: { name: string; input: Record<string, unknown> }): string => {
  const handler = TOOL_HANDLERS[block.name];
  if (handler) return handler(block.input);
  return `Unknown tool: ${block.name}`;
};

// ── Cron Scheduler Loop ──

let _schedulerInterval: ReturnType<typeof setInterval> | null = null;

function consumeCronQueue(): CronJob[] {
  cronLock.acquire();
  let fired: CronJob[];
  try {
    fired = [...cronQueue];
    cronQueue.length = 0;
  } finally {
    cronLock.release();
  }
  return fired;
}

function hasCronQueue(): boolean {
  cronLock.acquire();
  try {
    return cronQueue.length > 0;
  } finally {
    cronLock.release();
  }
}

function cronSchedulerLoop(): void {
  /** Independent interval: poll every 1s, fire matching jobs. */
  _schedulerInterval = setInterval(() => {
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
    enabled_tools: TOOLS.map((t) => t.name),
    workspace: WORKDIR,
    memories,
  };
}

// ── Agent Loop ──

async function agentLoop(
  messages: Anthropic.Messages.MessageParam[],
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let system = getSystemPrompt(context);
  while (true) {
    // Layer 4: consume fired cron jobs -> inject as messages
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
      return context;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return context;

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

// ── Session State ──

let sessionHistory: Anthropic.Messages.MessageParam[] = [];
let sessionContext = updateContext({}, []);

function printLatestAssistantText(messages: Anthropic.Messages.MessageParam[]): void {
  if (messages.length === 0) return;
  const msg = messages[messages.length - 1];
  if (!msg || msg.role !== "assistant") return;
  const content = msg.content;
  if (typeof content === "string") {
    console.log(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && "type" in block) {
        const b = block as { type: string; text?: string };
        if (b.type === "text" && b.text) console.log(b.text);
      }
    }
  }
}

async function runAgentTurnLocked(userQuery?: string | null): Promise<void> {
  /** Run one agent turn. Caller must hold agentLock. */
  if (userQuery != null) {
    sessionHistory.push({ role: "user", content: userQuery });
  }
  sessionContext = await agentLoop(sessionHistory, sessionContext);
  sessionContext = updateContext(sessionContext, sessionHistory);
  printLatestAssistantText(sessionHistory);
  console.log();
}

function queueProcessorLoop(): void {
  /** Auto-deliver fired cron jobs when the agent is idle. */
  setInterval(() => {
    if (!hasCronQueue()) return;
    // Non-blocking acquire attempt
    if (agentLock.locked) return;
    agentLock.acquire();
    try {
      if (!hasCronQueue()) return;
      console.log(`\n  \x1b[35m[queue processor] delivering scheduled work\x1b[0m`);
      runAgentTurnLocked().catch(console.error);
    } finally {
      agentLock.release();
    }
  }, 200);
}

// ── Startup ──

loadDurableJobs();
cronSchedulerLoop();
console.log(`  \x1b[35m[cron] scheduler started\x1b[0m`);

// ── Main ──

async function main(): Promise<void> {
  console.log("s14: cron scheduler");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  queueProcessorLoop();
  console.log(`  \x1b[35m[queue processor] started\x1b[0m`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    let query: string;
    try {
      query = await question("\x1b[36ms14 >> \x1b[0m");
    } catch {
      break;
    }
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") break;

    agentLock.acquire();
    try {
      await runAgentTurnLocked(query);
    } finally {
      agentLock.release();
    }
  }
  rl.close();
}

main().catch(console.error);
