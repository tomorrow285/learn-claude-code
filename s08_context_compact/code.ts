#!/usr/bin/env tsx
/**
 * s08_context_compact.ts - Context Compact
 *
 * Four-layer compaction pipeline inserted before LLM calls:
 *
 *     L1: snip_compact      — trim middle messages when count > 50
 *     L2: micro_compact     — replace old tool_results with placeholders
 *     L3: tool_result_budget — persist large results to disk
 *     L4: compact_history   — LLM full summary (1 API call)
 *
 *     Emergency: reactive_compact — when API still returns prompt_too_long
 *
 *     ┌─────────────────────────────────────────────────────────────┐
 *     │  messages[]                                                 │
 *     │    ↓                                                        │
 *     │  L3 budget ─→ L1 snip ─→ L2 micro ─→ [token > threshold?]  │
 *     │                                      ├─ No  → LLM          │
 *     │                                      └─ Yes → L4 summary   │
 *     │                                              ↓              │
 *     │                                          LLM call           │
 *     │                                    [prompt_too_long?]        │
 *     │                                      └─ Yes → reactive      │
 *     └─────────────────────────────────────────────────────────────┘
 *
 * Core principle: cheap first, expensive last.
 * Execution order matches CC source: budget → snip → micro → auto.
 *
 * Builds on s07 (skill loading). Usage:
 *
 *     npx tsx s08_context_compact/code.ts
 *     Needs: npm install @anthropic-ai/sdk dotenv + ANTHROPIC_API_KEY in .env
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

if (process.env.ANTHROPIC_BASE_URL) {
  delete (process.env as Record<string, string | undefined>).ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
let CURRENT_TODOS: Record<string, string>[] = [];


// ═══════════════════════════════════════════════════════════
//  FROM s07: Skill loading
// ═══════════════════════════════════════════════════════════

interface SkillMeta {
  name: string;
  description: string;
  content: string;
}

const SKILL_REGISTRY: Record<string, SkillMeta> = {};

function parseFrontmatter(text: string): [Record<string, string>, string] {
  if (!text.startsWith("---")) return [{}, text];
  const parts = text.split("---", 3);
  if (parts.length < 3) return [{}, text];
  const meta: Record<string, string> = {};
  for (const line of parts[1].trim().split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx !== -1) {
      const k = line.slice(0, colonIdx).trim();
      let v = line.slice(colonIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      meta[k] = v;
    }
  }
  return [meta, parts[2].trim()];
}

function scanSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) return;
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const manifest = path.join(SKILLS_DIR, d.name, "SKILL.md");
    if (fs.existsSync(manifest)) {
      const raw = fs.readFileSync(manifest, "utf-8");
      const [meta, body] = parseFrontmatter(raw);
      const name = meta["name"] || d.name;
      const desc = meta["description"] || raw.split("\n")[0].replace(/^#\s*/, "").trim();
      SKILL_REGISTRY[name] = { name, description: desc, content: raw };
    }
  }
}

scanSkills();

function listSkills(): string {
  const entries = Object.values(SKILL_REGISTRY);
  if (entries.length === 0) return "(no skills found)";
  return entries.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}

function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

function buildSystem(): string {
  const catalog = listSkills();
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${catalog}\n` +
    "Use load_skill to get full details when needed."
  );
}

const SYSTEM = buildSystem();

const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";


// ═══════════════════════════════════════════════════════════
//  FROM s02-s07 (unchanged): Basic Tools
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  try {
    const r = execSync(command, { cwd: WORKDIR, timeout: 120000, encoding: "utf-8", stdio: "pipe" });
    const out = r.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) return "Error: Timeout (120s)";
    const out = ((err.stdout || "") + (err.stderr || "")).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  }
}

function runRead(p: string, limit: number | null = null): string {
  try {
    const lines = fs.readFileSync(safePath(p), "utf-8").split("\n");
    if (limit !== null && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
    }
    return lines.join("\n");
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const filePath = safePath(p);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function runEdit(p: string, oldText: string, newText: string): string {
  try {
    const filePath = safePath(p);
    const text = fs.readFileSync(filePath, "utf-8");
    if (!text.includes(oldText)) return `Error: text not found in ${p}`;
    fs.writeFileSync(filePath, text.replace(oldText, newText), "utf-8");
    return `Edited ${p}`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const results: string[] = [];
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    function walk(dir: string, prefix: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (regex.test(relPath) || regex.test(entry.name)) {
          if (path.resolve(WORKDIR, relPath).startsWith(WORKDIR)) {
            results.push(relPath);
          }
        }
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      }
    }
    walk(WORKDIR, "");
    return results.length ? results.join("\n") : "(no matches)";
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function normalizeTodos(todos: unknown): [Record<string, string>[] | null, string | null] {
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      try {
        todos = JSON.parse(todos.replace(/'/g, '"'));
      } catch {
        return [null, "Error: todos must be a list or JSON array string"];
      }
    }
  }
  if (!Array.isArray(todos)) return [null, "Error: todos must be a list"];
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      return [null, `Error: todos[${i}] must be an object`];
    }
    if (!("content" in t) || !("status" in t)) {
      return [null, `Error: todos[${i}] missing 'content' or 'status'`];
    }
    if (!["pending", "in_progress", "completed"].includes(t.status)) {
      return [null, `Error: todos[${i}] has invalid status '${t.status}'`];
    }
  }
  return [todos, null];
}

function runTodoWrite(todos: Record<string, string>[]): string {
  const [normalized, error] = normalizeTodos(todos);
  if (error) return error;
  CURRENT_TODOS = normalized!;
  const lines: string[] = ["\n\x1b[33m## Current Tasks\x1b[0m"];
  for (const t of CURRENT_TODOS) {
    const icon: Record<string, string> = {
      pending: " ",
      in_progress: "\x1b[36m▸\x1b[0m",
      completed: "\x1b[32m✓\x1b[0m",
    };
    lines.push(`  [${icon[t.status]}] ${t.content}`);
  }
  console.log(lines.join("\n"));
  return `Updated ${CURRENT_TODOS.length} tasks`;
}

type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface Message {
  role: string;
  content: unknown;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return (content as ContentBlock[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}


// ═══════════════════════════════════════════════════════════
//  FROM s06-s07 (unchanged): Subagent
// ═══════════════════════════════════════════════════════════

const SUB_TOOLS: ToolDef[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];
const SUB_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob,
};

function spawnSubagent(task: string): string {
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: Message[] = [{ role: "user", content: task }];
  for (let i = 0; i < 30; i++) {
    const response = client.messages.create(
      MODEL, SUB_SYSTEM, messages, SUB_TOOLS, { maxTokens: 8000 }
    );
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;
    const results: { type: string; tool_use_id: string; content: string }[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        const blocked = triggerHooks("PreToolUse", block);
        if (blocked) {
          results.push({ type: "tool_result", tool_use_id: block.id!, content: String(blocked) });
          continue;
        }
        const handler = SUB_HANDLERS[block.name!];
        const output = handler
          ? handler(...Object.values(block.input ?? {}))
          : `Unknown: ${block.name}`;
        triggerHooks("PostToolUse", block, output);
        console.log(`  \x1b[90m[sub] ${block.name}: ${String(output).slice(0, 100)}\x1b[0m`);
        results.push({ type: "tool_result", tool_use_id: block.id!, content: output });
      }
    }
    messages.push({ role: "user", content: results });
  }
  let result = extractText(messages[messages.length - 1].content);
  if (!result) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        result = extractText(messages[i].content);
        if (result) break;
      }
    }
    if (!result) result = "Subagent stopped after 30 turns without final answer.";
  }
  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  return result;
}


// ═══════════════════════════════════════════════════════════
//  NEW in s08: Four-Layer Compaction Pipeline
// ═══════════════════════════════════════════════════════════

const CONTEXT_LIMIT = 50000;
const KEEP_RECENT = 3;
const PERSIST_THRESHOLD = 30000;

function estimateSize(msgs: unknown[]): number {
  return JSON.stringify(msgs).length;
}

function blockType(block: unknown): string | null {
  if (typeof block === "object" && block !== null) {
    return (block as Record<string, unknown>).type as string ?? null;
  }
  return null;
}

function messageHasToolUse(msg: Message): boolean {
  if (msg.role !== "assistant") return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => blockType(block) === "tool_use");
}

function isToolResultMessage(msg: Message): boolean {
  if (msg.role !== "user") return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => typeof block === "object" && block !== null && blockType(block) === "tool_result"
  );
}


// L1: snipCompact — trim middle messages
function snipCompact(messages: Message[], maxMessages = 50): Message[] {
  if (messages.length <= maxMessages) return messages;
  const keepHead = 3;
  const keepTail = maxMessages - 3;
  let headEnd = keepHead;
  let tailStart = messages.length - keepTail;
  if (headEnd > 0 && messageHasToolUse(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) {
      headEnd++;
    }
  }
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolUse(messages[tailStart - 1])
  ) {
    tailStart--;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` },
    ...messages.slice(tailStart),
  ];
}


// L2: microCompact — old result placeholders
function collectToolResults(messages: Message[]): [number, number, Record<string, unknown>][] {
  const blocks: [number, number, Record<string, unknown>][] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (typeof block === "object" && block !== null && blockType(block) === "tool_result") {
        blocks.push([mi, bi, block as Record<string, unknown>]);
      }
    }
  }
  return blocks;
}

function microCompact(messages: Message[]): Message[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT) return messages;
  for (let i = 0; i < toolResults.length - KEEP_RECENT; i++) {
    const block = toolResults[i][2];
    if (String(block.content || "").length > 120) {
      block.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
  return messages;
}


// L3: toolResultBudget — persist large results to disk
function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const p = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, output, "utf-8");
  return `<persisted-output>\nFull output: ${p}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

function toolResultBudget(messages: Message[], maxBytes = 200_000): Message[] {
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return messages;
  const blocks: [number, Record<string, unknown>][] = [];
  for (let i = 0; i < last.content.length; i++) {
    const b = last.content[i];
    if (typeof b === "object" && b !== null && blockType(b) === "tool_result") {
      blocks.push([i, b as Record<string, unknown>]);
    }
  }
  let total = blocks.reduce((sum, [, b]) => sum + String(b.content || "").length, 0);
  if (total <= maxBytes) return messages;
  const ranked = [...blocks].sort(
    (a, b) => String(b[1].content || "").length - String(a[1].content || "").length
  );
  for (const [, block] of ranked) {
    if (total <= maxBytes) break;
    const content = String(block.content || "");
    if (content.length <= PERSIST_THRESHOLD) continue;
    const tid = String(block.tool_use_id || "unknown");
    block.content = persistLargeOutput(tid, content);
    total = blocks.reduce((sum, [, b]) => sum + String(b.content || "").length, 0);
  }
  return messages;
}


// L4: autoCompact — LLM full summary
function writeTranscript(messages: Message[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const p = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m, replacer) + "\n").join("");
  fs.writeFileSync(p, lines, "utf-8");
  return p;
}

// JSON.stringify replacer for non-JSON-safe values
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return String(value);
  return value;
}

function summarizeHistory(messages: Message[]): string {
  const conversation = JSON.stringify(messages, replacer).slice(0, 80000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" + conversation;
  const response = client.messages.create(
    MODEL, undefined, [{ role: "user", content: prompt }], [], { maxTokens: 2000 }
  );
  return (
    (response.content as ContentBlock[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim() || "(empty summary)"
  );
}

function compactHistory(messages: Message[]): Message[] {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}


// Emergency: reactiveCompact — on API error
function reactiveCompact(messages: Message[]): Message[] {
  const transcript = writeTranscript(messages);
  const summary = summarizeHistory(messages);
  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolUse(messages[tailStart - 1])
  ) {
    tailStart--;
  }
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(tailStart),
  ];
}


// ═══════════════════════════════════════════════════════════
//  FROM s07: Tool Definitions
// ═══════════════════════════════════════════════════════════

const TOOLS: ToolDef[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.",
    input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "todo_write", description: "Create and manage a task list for your current coding session.",
    input_schema: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } },
  { name: "task", description: "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
  { name: "load_skill", description: "Load the full content of a skill by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  // s08 change: new compact tool — triggers compact_history, not a no-op
  { name: "compact", description: "Summarize earlier conversation to free context space.",
    input_schema: { type: "object", properties: { focus: { type: "string" } } } },
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob, todo_write: runTodoWrite,
  task: spawnSubagent, load_skill: loadSkill,
};


// ═══════════════════════════════════════════════════════════
//  FROM s04 (unchanged): Hooks
// ═══════════════════════════════════════════════════════════

type HookCallback = (...args: any[]) => unknown | null;

const HOOKS: Record<string, HookCallback[]> = {
  PreToolUse: [],
  PostToolUse: [],
};

function triggerHooks(event: string, ...args: unknown[]): unknown | null {
  for (const cb of HOOKS[event]) {
    const r = cb(...args);
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown"];

function permissionHook(block: ContentBlock): string | null {
  if (block.name === "bash") {
    for (const p of DENY_LIST) {
      if ((block.input?.command as string || "").includes(p)) return "Permission denied";
    }
  }
  return null;
}

function logHook(block: ContentBlock): null {
  console.log(`\x1b[90m[HOOK] ${block.name}\x1b[0m`);
  return null;
}

HOOKS["PreToolUse"].push(permissionHook);
HOOKS["PreToolUse"].push(logHook);


// ═══════════════════════════════════════════════════════════
//  agent_loop — s08 core: run compaction pipeline before LLM
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1; // retry limit for reactive compact

function agentLoop(messages: Message[]): void {
  let reactiveRetries = 0;
  while (true) {
    // s08 change: three preprocessors (0 API calls, cheap first)
    // Order matches CC source: budget → snip → micro
    const budgeted = toolResultBudget(messages);    // L3: persist large results first
    messages.length = 0;
    messages.push(...budgeted);

    const snipped = snipCompact(messages);          // L1: trim middle
    messages.length = 0;
    messages.push(...snipped);

    const microed = microCompact(messages);         // L2: old result placeholders
    messages.length = 0;
    messages.push(...microed);

    // s08 change: tokens still over threshold → LLM summary (1 API call)
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      const compacted = compactHistory(messages);
      messages.length = 0;
      messages.push(...compacted);
    }

    let response: Awaited<ReturnType<typeof client.messages.create>>;
    try {
      response = client.messages.create(
        MODEL, SYSTEM, messages, TOOLS, { maxTokens: 8000 }
      );
      reactiveRetries = 0; // reset on successful API call
    } catch (e: unknown) {
      const errStr = String(e);
      if (
        (errStr.toLowerCase().includes("prompt_too_long") || errStr.toLowerCase().includes("too many tokens")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        console.log("[reactive compact]");
        const compacted = reactiveCompact(messages);
        messages.length = 0;
        messages.push(...compacted);
        reactiveRetries++;
        continue;
      }
      throw e;
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: { type: string; tool_use_id: string; content: string }[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      // s08: compact tool triggers compact_history, not a no-op string
      if (block.name === "compact") {
        const compacted = compactHistory(messages);
        messages.length = 0;
        messages.push(...compacted);
        results.push({
          type: "tool_result",
          tool_use_id: block.id!,
          content: "[Compacted. Conversation history has been summarized.]",
        });
        messages.push({ role: "user", content: results });
        break; // end current turn, start fresh with compacted context
      }

      const blocked = triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({ type: "tool_result", tool_use_id: block.id!, content: String(blocked) });
        continue;
      }
      const handler = TOOL_HANDLERS[block.name!];
      const output = handler
        ? handler(...Object.values(block.input ?? {}))
        : `Unknown: ${block.name}`;
      triggerHooks("PostToolUse", block, output);
      console.log(String(output).slice(0, 200));
      results.push({ type: "tool_result", tool_use_id: block.id!, content: String(output) });
    }

    // Check if we already appended results (compact path)
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "user" && Array.isArray(lastMsg.content) && lastMsg.content === results) {
      // compact path: results already appended above
      continue;
    }
    // normal path: no compact was called
    messages.push({ role: "user", content: results });
    continue;
  }
}


// ── Main ──

async function main(): Promise<void> {
  console.log("s08: Context Compact — four-layer compaction pipeline");
  console.log("Type a question, press Enter. Type q to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: Message[] = [];

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms08 >> \x1b[0m", (answer) => resolve(answer));
    });

  while (true) {
    const query = await ask();
    if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
      break;
    }
    history.push({ role: "user", content: query });
    agentLoop(history);
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as ContentBlock[]) {
        if (block.type === "text") console.log(block.text);
      }
    }
    console.log();
  }

  rl.close();
}

main().catch(console.error);
