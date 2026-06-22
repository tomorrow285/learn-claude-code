#!/usr/bin/env tsx
/**
 * s09_memory.ts - Memory System
 *
 * Persistent, cross-session knowledge for the coding agent.
 *
 * Storage:
 *     .memory/
 *       MEMORY.md          ← index (one line per memory, ≤200 lines)
 *       feedback_tabs.md    ← individual memory files (Markdown + YAML frontmatter)
 *       user_profile.md
 *       project_facts.md
 *
 * Flow in agent_loop:
 *     1. Load MEMORY.md index into SYSTEM prompt (cheap, always present)
 *     2. Select relevant memories by filename/description → inject content
 *     3. Run compression pipeline from s08
 *     4. After each turn ends → extract new memories from original messages
 *     5. Periodically consolidate (Dream)
 *
 * Builds on s08 (context compact). Usage:
 *
 *     npx tsx s09_memory/code.ts
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
const MEMORY_DIR = path.join(WORKDIR, ".memory");
fs.mkdirSync(MEMORY_DIR, { recursive: true });
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;


// ═══════════════════════════════════════════════════════════
//  NEW in s09: Memory System
// ═══════════════════════════════════════════════════════════

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

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


function writeMemoryFile(name: string, memType: string, description: string, body: string): string {
  /** Write a single memory file with YAML frontmatter. */
  const slug = name.toLowerCase().replace(/ /g, "-").replace(/\//g, "-");
  const filename = `${slug}.md`;
  const filepath = path.join(MEMORY_DIR, filename);
  fs.writeFileSync(
    filepath,
    `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n\n${body}\n`,
    "utf-8"
  );
  rebuildIndex();
  return filepath;
}


function rebuildIndex(): void {
  /** Rebuild MEMORY.md index from all memory files. */
  const lines: string[] = [];
  const entries = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md")).sort();
  for (const f of entries) {
    if (f === "MEMORY.md") continue;
    const raw = fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8");
    const [meta, body] = parseFrontmatter(raw);
    const name = meta["name"] || path.basename(f, ".md");
    const desc = meta["description"] || body.split("\n")[0].slice(0, 80);
    lines.push(`- [${name}](${f}) — ${desc}`);
  }
  fs.writeFileSync(MEMORY_INDEX, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
}


function readMemoryIndex(): string {
  /** Read MEMORY.md index (injected into SYSTEM every turn). */
  if (!fs.existsSync(MEMORY_INDEX)) return "";
  const text = fs.readFileSync(MEMORY_INDEX, "utf-8").trim();
  return text || "";
}


function readMemoryFile(filename: string): string | null {
  /** Read a single memory file's full content. */
  const p = path.join(MEMORY_DIR, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}


interface MemoryFileMeta {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
}

function listMemoryFiles(): MemoryFileMeta[] {
  /** List all memory files with metadata. */
  const result: MemoryFileMeta[] = [];
  const entries = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md")).sort();
  for (const f of entries) {
    if (f === "MEMORY.md") continue;
    const raw = fs.readFileSync(path.join(MEMORY_DIR, f), "utf-8");
    const [meta, body] = parseFrontmatter(raw);
    result.push({
      filename: f,
      name: meta["name"] || path.basename(f, ".md"),
      description: meta["description"] || "",
      type: meta["type"] || "user",
      body,
    });
  }
  return result;
}


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


function selectRelevantMemories(messages: Message[], maxItems = 5): string[] {
  /** Select relevant memory filenames by matching recent conversation against
   * memory names/descriptions. Uses a simple LLM call (or falls back to keyword
   * matching on name+description). */
  const files = listMemoryFiles();
  if (files.length === 0) return [];

  // Collect recent user text for context
  const recentTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      let content = msg.content;
      if (Array.isArray(content)) {
        content = (content as ContentBlock[])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ");
      }
      if (typeof content === "string") recentTexts.push(content);
      if (recentTexts.length >= 3) break;
    }
  }
  const recent = [...recentTexts].reverse().join(" ").slice(0, 2000);

  if (!recent.trim()) return [];

  // Build catalog of name + description for LLM to choose from
  const catalogLines = files.map((f, i) => `${i}: ${f.name} — ${f.description}`);
  const catalog = catalogLines.join("\n");

  const prompt =
    "Given the recent conversation and the memory catalog below, " +
    "select the indices of memories that are clearly relevant. " +
    "Return ONLY a JSON array of integers, e.g. [0, 3]. " +
    "If none are relevant, return [].\n\n" +
    `Recent conversation:\n${recent}\n\n` +
    `Memory catalog:\n${catalog}`;

  try {
    const response = client.messages.create(
      MODEL, undefined, [{ role: "user", content: prompt }], [], { maxTokens: 200 }
    );
    const text = extractText(response.content).trim();
    // Extract JSON array from response
    const match = text.match(/\[.*?\]/s);
    if (match) {
      const indices: number[] = JSON.parse(match[0]);
      const selected: string[] = [];
      for (const idx of indices) {
        if (typeof idx === "number" && idx >= 0 && idx < files.length) {
          selected.push(files[idx].filename);
          if (selected.length >= maxItems) break;
        }
      }
      return selected;
    }
  } catch {
    // fall through to keyword matching
  }

  // Fallback: keyword matching on name + description
  const keywords = recent
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3);
  const selected: string[] = [];
  for (const f of files) {
    const text = (f.name + " " + f.description).toLowerCase();
    if (keywords.some((kw) => text.includes(kw))) {
      selected.push(f.filename);
      if (selected.length >= maxItems) break;
    }
  }
  return selected;
}


function loadMemories(messages: Message[]): string {
  /** Load relevant memory content for injection into context. */
  const selectedFiles = selectRelevantMemories(messages);
  if (selectedFiles.length === 0) return "";

  const parts: string[] = ["<relevant_memories>"];
  for (const filename of selectedFiles) {
    const content = readMemoryFile(filename);
    if (content) parts.push(content);
  }
  parts.push("</relevant_memories>");
  return parts.join("\n\n");
}


function extractMemories(messages: Message[]): void {
  /** Extract new memories from recent dialogue. Runs after each turn. */
  // Collect recent conversation text
  const dialogueParts: string[] = [];
  for (const msg of messages.slice(-10)) {
    const role = msg.role || "?";
    let content = msg.content;
    if (Array.isArray(content)) {
      content = (content as ContentBlock[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ");
    }
    if (typeof content === "string" && content.trim()) {
      dialogueParts.push(`${role}: ${content}`);
    }
  }
  const dialogue = dialogueParts.join("\n");

  if (!dialogue.trim()) return;

  // Check existing memories to avoid duplicates
  const existing = listMemoryFiles();
  const existingDesc =
    existing.length > 0
      ? existing.map((m) => `- ${m.name}: ${m.description}`).join("\n")
      : "(none)";

  const prompt =
    "Extract user preferences, constraints, or project facts from this dialogue.\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n" +
    "- name: short kebab-case identifier (e.g. 'user-preference-tabs')\n" +
    "- type: one of 'user' (user preference), 'feedback' (guidance), " +
    "'project' (project fact), 'reference' (external pointer)\n" +
    "- description: one-line summary for index lookup\n" +
    "- body: full detail in markdown\n" +
    "If nothing new or already covered by existing memories, return [].\n\n" +
    `Existing memories:\n${existingDesc}\n\n` +
    `Dialogue:\n${dialogue.slice(0, 4000)}`;

  try {
    const response = client.messages.create(
      MODEL, undefined, [{ role: "user", content: prompt }], [], { maxTokens: 800 }
    );
    const text = extractText(response.content).trim();
    // Extract JSON array from response
    const match = text.match(/\[.*\]/s);
    if (!match) return;
    const items: Record<string, string>[] = JSON.parse(match[0]);
    if (!items || items.length === 0) return;
    let count = 0;
    for (const mem of items) {
      const name = mem["name"] || `memory_${Math.floor(Date.now() / 1000)}`;
      const memType = mem["type"] || "user";
      const desc = mem["description"] || "";
      const body = mem["body"] || "";
      if (desc && body) {
        writeMemoryFile(name, memType, desc, body);
        count++;
      }
    }
    if (count) {
      console.log(`\n\x1b[33m[Memory: extracted ${count} new memories]\x1b[0m`);
    }
  } catch {
    // pass
  }
}


const CONSOLIDATE_THRESHOLD = 10;

function consolidateMemories(): void {
  /** Merge duplicate/stale memories. Triggered when file count >= threshold. */
  const files = listMemoryFiles();
  if (files.length < CONSOLIDATE_THRESHOLD) return;

  const catalog = files
    .map(
      (f) =>
        `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`
    )
    .join("\n\n");

  const prompt =
    "Consolidate the following memory files. Rules:\n" +
    "1. Merge duplicates into one\n" +
    "2. Remove outdated/contradicted memories\n" +
    "3. Keep the total under 30 memories\n" +
    "4. Preserve important user preferences above all\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n\n" +
    catalog.slice(0, 16000);

  try {
    const response = client.messages.create(
      MODEL, undefined, [{ role: "user", content: prompt }], [], { maxTokens: 3000 }
    );
    const text = extractText(response.content).trim();
    const match = text.match(/\[.*\]/s);
    if (!match) return;
    const items: Record<string, string>[] = JSON.parse(match[0]);

    // Remove old memory files (keep MEMORY.md)
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (f.endsWith(".md") && f !== "MEMORY.md") {
        fs.unlinkSync(path.join(MEMORY_DIR, f));
      }
    }

    for (const mem of items) {
      const name = mem["name"] || `memory_${Math.floor(Date.now() / 1000)}`;
      const memType = mem["type"] || "user";
      const desc = mem["description"] || "";
      const body = mem["body"] || "";
      if (desc && body) writeMemoryFile(name, memType, desc, body);
    }

    console.log(
      `\n\x1b[33m[Memory: consolidated ${files.length} → ${items.length} memories]\x1b[0m`
    );
  } catch {
    // pass
  }
}


// Build SYSTEM with memory index
function buildSystem(): string {
  const index = readMemoryIndex();
  const memoriesSection = index ? `\n\nMemories available:\n${index}` : "";
  return (
    `You are a coding agent at ${WORKDIR}.` +
    `${memoriesSection}\n` +
    "Relevant memories are injected below. Respect user preferences from memory.\n" +
    "When the user says 'remember' or expresses a clear preference, extract it as a memory."
  );
}

const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";


// ═══════════════════════════════════════════════════════════
//  FROM s02-s08 (skeleton): Basic tools
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
          if (path.resolve(WORKDIR, relPath).startsWith(WORKDIR)) results.push(relPath);
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

// Subagent (simplified from s06-s07)
const SUB_TOOLS: Record<string, unknown>[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];
const SUB_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
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
        const handler = SUB_HANDLERS[block.name!];
        const output = handler
          ? handler(...Object.values(block.input ?? {}))
          : `Unknown: ${block.name}`;
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
//  FROM s08 (skeleton): Compaction pipeline
// ═══════════════════════════════════════════════════════════

const CONTEXT_LIMIT = 50000;
const KEEP_RECENT_COMPACT = 3;
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

function snipCompact(msgs: Message[], mx = 50): Message[] {
  if (msgs.length <= mx) return msgs;
  let headEnd = 3;
  let tailStart = msgs.length - (mx - 3);
  if (headEnd > 0 && messageHasToolUse(msgs[headEnd - 1])) {
    while (headEnd < msgs.length && isToolResultMessage(msgs[headEnd])) {
      headEnd++;
    }
  }
  if (
    tailStart > 0 &&
    tailStart < msgs.length &&
    isToolResultMessage(msgs[tailStart]) &&
    messageHasToolUse(msgs[tailStart - 1])
  ) {
    tailStart--;
  }
  if (headEnd >= tailStart) return msgs;
  return [
    ...msgs.slice(0, headEnd),
    { role: "user", content: `[snipped ${tailStart - headEnd} msgs]` },
    ...msgs.slice(tailStart),
  ];
}

function collectToolResults(msgs: Message[]): [number, number, Record<string, unknown>][] {
  const blocks: [number, number, Record<string, unknown>][] = [];
  for (let mi = 0; mi < msgs.length; mi++) {
    const msg = msgs[mi];
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

function microCompact(msgs: Message[]): Message[] {
  const tr = collectToolResults(msgs);
  if (tr.length <= KEEP_RECENT_COMPACT) return msgs;
  for (let i = 0; i < tr.length - KEEP_RECENT_COMPACT; i++) {
    const b = tr[i][2];
    if (String(b.content || "").length > 120) b.content = "[Earlier tool result compacted.]";
  }
  return msgs;
}

function persistLarge(tid: string, out: string): string {
  if (out.length <= PERSIST_THRESHOLD) return out;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const p = path.join(TOOL_RESULTS_DIR, `${tid}.txt`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, out, "utf-8");
  return `<persisted-output>\nFull: ${p}\nPreview:\n${out.slice(0, 2000)}\n</persisted-output>`;
}

function toolResultBudget(msgs: Message[], mx = 200_000): Message[] {
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return msgs;
  const blocks: [number, Record<string, unknown>][] = [];
  for (let i = 0; i < last.content.length; i++) {
    const b = last.content[i];
    if (typeof b === "object" && b !== null && blockType(b) === "tool_result") {
      blocks.push([i, b as Record<string, unknown>]);
    }
  }
  let total = blocks.reduce((sum, [, b]) => sum + String(b.content || "").length, 0);
  if (total <= mx) return msgs;
  for (const [, block] of [...blocks].sort(
    (a, b) => String(b[1].content || "").length - String(a[1].content || "").length
  )) {
    if (total <= mx) break;
    const c = String(block.content || "");
    if (c.length <= PERSIST_THRESHOLD) continue;
    block.content = persistLarge(String(block.tool_use_id || "?"), c);
    total = blocks.reduce((sum, [, b]) => sum + String(b.content || "").length, 0);
  }
  return msgs;
}

function writeTranscript(msgs: Message[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const p = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const lines = msgs.map((m) => JSON.stringify(m, replacer) + "\n").join("");
  fs.writeFileSync(p, lines, "utf-8");
  return p;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return String(value);
  return value;
}

function summarizeHistory(msgs: Message[]): string {
  const conv = JSON.stringify(msgs, replacer).slice(0, 80000);
  const r = client.messages.create(
    MODEL, undefined,
    [{
      role: "user",
      content:
        "Summarize this coding-agent conversation so work can continue.\n" +
        "Preserve: 1. current goal, 2. key findings, 3. files changed, 4. remaining work, 5. user constraints.\n\n" +
        conv,
    }],
    [],
    { maxTokens: 2000 }
  );
  return extractText(r.content).trim();
}

function compactHistory(msgs: Message[]): Message[] {
  writeTranscript(msgs);
  const summary = summarizeHistory(msgs);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

function reactiveCompact(msgs: Message[]): Message[] {
  writeTranscript(msgs);
  const summary = summarizeHistory(msgs);
  let tailStart = Math.max(0, msgs.length - 5);
  if (
    tailStart > 0 &&
    tailStart < msgs.length &&
    isToolResultMessage(msgs[tailStart]) &&
    messageHasToolUse(msgs[tailStart - 1])
  ) {
    tailStart--;
  }
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...msgs.slice(tailStart),
  ];
}


// ═══════════════════════════════════════════════════════════
//  Tool Definitions (skeleton — fewer tools to focus on memory)
// ═══════════════════════════════════════════════════════════

const TOOLS: Record<string, unknown>[] = [
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
  { name: "task", description: "Launch a subagent to handle a subtask.",
    input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob, task: spawnSubagent,
};


// ═══════════════════════════════════════════════════════════
//  agent_loop — s09: inject memories + extract after each turn
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1;

function agentLoop(messages: Message[]): void {
  let reactiveRetries = 0;
  // s09: inject relevant memory content into the current user turn
  const memoriesContent = loadMemories(messages);
  let memoryTurn: number | null = null;
  if (messages.length > 0 && typeof messages[messages.length - 1].content === "string") {
    memoryTurn = messages.length - 1;
  }
  // s09: build system once per user turn; memory is updated after the loop returns
  const system = buildSystem();

  while (true) {
    // s09: save pre-compression snapshot for accurate memory extraction
    const preCompress: Message[] = messages.map((m) => {
      if (typeof m === "object" && m !== null) {
        return {
          role: (m as Record<string, unknown>).role as string || "",
          content: String((m as Record<string, unknown>).content || ""),
        };
      }
      return { role: "", content: "" };
    });

    // s08: compression pipeline (budget → snip → micro)
    const budgeted = toolResultBudget(messages);
    messages.length = 0;
    messages.push(...budgeted);

    const snipped = snipCompact(messages);
    messages.length = 0;
    messages.push(...snipped);

    const microed = microCompact(messages);
    messages.length = 0;
    messages.push(...microed);

    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      const compacted = compactHistory(messages);
      messages.length = 0;
      messages.push(...compacted);
    }

    let requestMessages = messages;
    if (memoriesContent && memoryTurn !== null && memoryTurn < messages.length) {
      requestMessages = [...messages];
      requestMessages[memoryTurn] = {
        ...messages[memoryTurn],
        content: memoriesContent + "\n\n" + messages[memoryTurn].content,
      };
    }

    let response: Awaited<ReturnType<typeof client.messages.create>>;
    try {
      response = client.messages.create(
        MODEL, system, requestMessages, TOOLS, { maxTokens: 8000 }
      );
      reactiveRetries = 0;
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
    if (response.stop_reason !== "tool_use") {
      // s09: extract from pre-compression snapshot for full fidelity
      extractMemories(preCompress);
      consolidateMemories();
      return;
    }

    const results: { type: string; tool_use_id: string; content: string }[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const handler = TOOL_HANDLERS[block.name!];
      const output = handler
        ? handler(...Object.values(block.input ?? {}))
        : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({ type: "tool_result", tool_use_id: block.id!, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}


// ── Main ──

async function main(): Promise<void> {
  console.log("s09: Memory — persistent cross-session knowledge");
  console.log("Type a question, press Enter. Type q to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: Message[] = [];

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms09 >> \x1b[0m", (answer) => resolve(answer));
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
