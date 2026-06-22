#!/usr/bin/env node
/**
 * s05: TodoWrite — add a planning tool on top of s04 hooks.
 *
 *   +---------+      +-------+      +------------------+
 *   |  User   | ---> |  LLM  | ---> | TOOL_HANDLERS    |
 *   | prompt  |      |       |      |  bash            |
 *   +---------+      +---+---+      |  read_file       |
 *                         ^         |  write_file      |
 *                         | result  |  edit_file       |
 *                         +---------+  glob            |
 *                                       todo_write ← NEW
 *                                    +------------------+
 *                                         |
 *                          in-memory currentTodos
 *                                         |
 *                         if roundsSinceTodo >= 3:
 *                           inject <reminder>
 *
 * Changes from s04:
 *   + todo_write tool + runTodoWrite() implementation
 *   + Nag reminder (inject reminder after 3 rounds without todo update)
 *   + SYSTEM prompt includes "plan before execute" guidance
 *   + roundsSinceTodo counter in agentLoop
 *   Loop unchanged: new tool auto-dispatches via TOOL_HANDLERS.
 *
 * Run: npx tsx s05_todo_write/code.ts
 * Needs: npm install @anthropic-ai/sdk dotenv + ANTHROPIC_API_KEY in .env
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import Anthropic from '@anthropic-ai/sdk';

// NOTE: Python 版使用 readline.parse_and_bind 修复 macOS libedit 中文退格问题，
// Node.js 的 readline 模块不存在此问题，无需处理。

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const MODEL = process.env.MODEL_ID!;

// Module-level todo state
let CURRENT_TODOS: Array<Record<string, any>> = [];

// s05 change: SYSTEM prompt adds planning guidance
const SYSTEM = (
  `You are a coding agent at ${WORKDIR}. ` +
  "Before starting any multi-step task, use todo_write to plan your steps. " +
  "Update status as you go."
);


// ═══════════════════════════════════════════════════════════
//  FROM s02-s04 (unchanged): Tool Implementations
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  try {
    const output = execSync(command + ' 2>&1', {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: 'utf-8',
    });
    const out = output.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: any) {
    if (e.killed) {
      return "Error: Timeout (120s)";
    }
    return `Error: ${e.message || e}`;
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(filePath), 'utf-8');
    const lines = content.split('\n');
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join('\n');
    }
    return content;
  } catch (e: any) {
    return `Error: ${e.message || e}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message || e}`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const text = fs.readFileSync(fullPath, 'utf-8');
    if (!text.includes(oldText)) {
      return `Error: text not found in ${filePath}`;
    }
    fs.writeFileSync(fullPath, text.replace(oldText, newText), 'utf-8');
    return `Edited ${filePath}`;
  } catch (e: any) {
    return `Error: ${e.message || e}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const results: string[] = [];
    const regexStr = '^' + pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '___GLOBSTAR___')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/___GLOBSTAR___/g, '.*')
      .replace(/\?/g, '.') + '$';
    const regex = new RegExp(regexStr);

    function walk(currentDir: string): void {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(WORKDIR, fullPath).replace(/\\/g, '/');
        if (regex.test(relPath)) {
          results.push(relPath);
        }
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
      }
    }

    walk(WORKDIR);
    return results.length > 0 ? results.join('\n') : "(no matches)";
  } catch (e: any) {
    return `Error: ${e.message || e}`;
  }
}


// ═══════════════════════════════════════════════════════════
//  NEW in s05: todo_write tool — plan only, no execution
// ═══════════════════════════════════════════════════════════

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

function normalizeTodos(todos: any): { todos: TodoItem[] | null; error: string | null } {
  if (typeof todos === 'string') {
    try {
      todos = JSON.parse(todos);
    } catch {
      return { todos: null, error: "Error: todos must be a list or JSON array string" };
    }
  }
  if (!Array.isArray(todos)) {
    return { todos: null, error: "Error: todos must be a list" };
  }
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      return { todos: null, error: `Error: todos[${i}] must be an object` };
    }
    if (!('content' in t) || !('status' in t)) {
      return { todos: null, error: `Error: todos[${i}] missing 'content' or 'status'` };
    }
    if (!["pending", "in_progress", "completed"].includes(t.status)) {
      return { todos: null, error: `Error: todos[${i}] has invalid status '${t.status}'` };
    }
  }
  return { todos: todos as TodoItem[], error: null };
}

function runTodoWrite(todos: any): string {
  const { todos: normalized, error } = normalizeTodos(todos);
  if (error) {
    return error;
  }
  CURRENT_TODOS = normalized!;
  const lines: string[] = ["\n\x1b[33m## Current Tasks\x1b[0m"];
  const icons: Record<string, string> = {
    pending: " ", in_progress: "\x1b[36m▸\x1b[0m", completed: "\x1b[32m✓\x1b[0m",
  };
  for (const t of CURRENT_TODOS) {
    const icon = icons[t.status];
    lines.push(`  [${icon}] ${t.content}`);
  }
  console.log(lines.join('\n'));
  return `Updated ${CURRENT_TODOS.length} tasks`;
}

const TOOLS = [
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
  // s05: new tool
  { name: "todo_write", description: "Create and manage a task list for your current coding session.",
    input_schema: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } },
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob, todo_write: runTodoWrite,
};


// ═══════════════════════════════════════════════════════════
//  FROM s04 (unchanged): Hook System
// ═══════════════════════════════════════════════════════════

type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
type HookCallback = (...args: any[]) => string | null | undefined;

const HOOKS: Record<HookEvent, HookCallback[]> = {
  UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [],
};

function registerHook(event: HookEvent, callback: HookCallback): void {
  HOOKS[event].push(callback);
}

function triggerHooks(event: HookEvent, ...args: any[]): string | null {
  for (const callback of HOOKS[event]) {
    const result = callback(...args);
    if (result != null) {
      return result;
    }
  }
  return null;
}

// Synchronous prompt — Node.js 没有内置的同步 input()，
// 使用 fs.readSync(0, ...) 从 stdin 读取一行。
// 生产环境中建议使用异步 readline 方式。
function promptSync(question: string): string {
  process.stdout.write(question);
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(0, buf, 0, 4096);
    return buf.toString('utf-8', 0, n).trim();
  } catch {
    return 'n';
  }
}

// s04 hooks preserved
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];

function permissionHook(block: any): string | null {
  /* PreToolUse: deny list check. */
  if (block.name === "bash") {
    for (const p of DENY_LIST) {
      if ((block.input?.command || "").includes(p)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${p}'\x1b[0m`);
        return "Permission denied";
      }
    }
  }
  return null;
}

function logHook(block: any): null {
  /* PreToolUse: log tool calls. */
  console.log(`\x1b[90m[HOOK] ${block.name}\x1b[0m`);
  return null;
}

function contextInjectHook(query: string): null {
  /* UserPromptSubmit: log working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

function summaryHook(messages: any[]): null {
  /* Stop: print tool call count. */
  let toolCount = 0;
  for (const m of messages) {
    const content = m.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b === 'object' && b !== null && b.type === "tool_result") {
          toolCount++;
        }
      }
    }
  }
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("Stop", summaryHook);


// ═══════════════════════════════════════════════════════════
//  agentLoop — same as s04 + nag reminder counter
// ═══════════════════════════════════════════════════════════

let roundsSinceTodo = 0;

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    // s05: nag reminder — inject if model hasn't updated todos for 3 rounds
    if (roundsSinceTodo >= 3 && messages.length > 0) {
      messages.push({ role: "user",
                       content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages: messages as any,
      tools: TOOLS as any, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return;
    }

    roundsSinceTodo += 1;
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      const blocked = triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({ type: "tool_result", tool_use_id: block.id,
                        content: String(blocked) });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(...Object.values(block.input)) : `Unknown: ${block.name}`;

      triggerHooks("PostToolUse", block, output);

      // s05: reset nag counter when todo_write is called
      if (block.name === "todo_write") {
        roundsSinceTodo = 0;
      }

      results.push({ type: "tool_result", tool_use_id: block.id,
                      content: output });
    }

    messages.push({ role: "user", content: results });
  }
}


// ═══════════════════════════════════════════════════════════
//  Entry point
// ═══════════════════════════════════════════════════════════

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(query: string): Promise<string> {
  return new Promise((resolve) => { rl.question(query, resolve); });
}

async function main(): Promise<void> {
  console.log("s05: TodoWrite — plan before execute, nag if you forget");
  console.log("Type a question, press Enter. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms05 >> \x1b[0m");
    } catch {
      break;
    }
    if (query.trim().toLowerCase() === 'q' || query.trim().toLowerCase() === 'exit' || query.trim() === '') {
      break;
    }
    triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    await agentLoop(history);
    for (const block of history[history.length - 1]["content"]) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
    console.log();
  }
  rl.close();
}

main().catch(console.error);
