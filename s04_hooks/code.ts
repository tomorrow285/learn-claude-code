#!/usr/bin/env node
/**
 * s04: Hooks — move extension logic out of the loop, onto hooks.
 *
 *   User types query
 *        │
 *        ▼
 *   ┌──────────────────┐
 *   │ UserPromptSubmit │ ── triggerHooks() before LLM
 *   └────────┬─────────┘
 *            ▼
 *   ┌────────────┐     ┌─────────────────────────────┐
 *   │  messages  │────▶│  LLM (stop_reason=tool_use?)│
 *   └────────────┘     │   No ──▶ Stop hooks ──▶ exit │
 *                      │   Yes ──▶ tool_use block ──┐ │
 *                      └────────────────────────────┘ │
 *                                                     ▼
 *                                           ┌──────────────────┐
 *                                           │ triggerHooks()   │
 *                                           │  PreToolUse:      │
 *                                           │   permissionHook │
 *                                           │   logHook        │
 *                                           └───────┬──────────┘
 *                                                   │ (not blocked)
 *                                           ┌───────▼──────────┐
 *                                           │ TOOL_HANDLERS[x]  │
 *                                           └───────┬──────────┘
 *                                                   │
 *                                           ┌───────▼──────────┐
 *                                           │ triggerHooks()   │
 *                                           │  PostToolUse:    │
 *                                           │   largeOutput    │
 *                                           └───────┬──────────┘
 *                                                   │
 *                                           results ──▶ back to messages
 *
 * Changes from s03:
 *   + HOOKS registry (event -> list of callbacks)
 *   + registerHook() / triggerHooks()
 *   + contextInjectHook (UserPromptSubmit)
 *   + permissionHook, logHook (PreToolUse)
 *   + largeOutputHook (PostToolUse)
 *   + summaryHook (Stop)
 *   - checkPermission() removed from loop body
 *     (logic moved into permissionHook, triggered via PreToolUse)
 *
 * Run: npx tsx s04_hooks/code.ts
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;


// ═══════════════════════════════════════════════════════════
//  FROM s02-s03 (unchanged): Tool Implementations
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
];

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob,
};


// ═══════════════════════════════════════════════════════════
//  NEW in s04: Hook System (s03 permission logic now via hooks)
// ═══════════════════════════════════════════════════════════

// Hook event types
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
    if (result != null) {  // teaching shortcut: block this tool call
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

// s03 permission check logic, now wrapped as a hook
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

function permissionHook(block: any): string | null {
  /* PreToolUse: s03 checkPermission() logic moved here. */
  if (block.name === "bash") {
    for (const pattern of DENY_LIST) {
      if ((block.input?.command || "").includes(pattern)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    for (const kw of DESTRUCTIVE) {
      if ((block.input?.command || "").includes(kw)) {
        console.log(`\n\x1b[33m⚠  Potentially destructive command\x1b[0m`);
        console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
        // NOTE: in a real async hook you would await user input;
        // for teaching we resolve synchronously via a pre-stored readline.
        // Sync prompt alternative: use a blocking input mechanism.
        const choice = promptSync(`   Allow? [y/N] `);
        if (choice !== 'y' && choice !== 'yes') {
          return "Permission denied by user";
        }
      }
    }
  }
  if (block.name === "write_file" || block.name === "edit_file") {
    const filePath = block.input?.path || "";
    try { safePath(filePath); } catch {
      console.log(`\n\x1b[33m⚠  Writing outside workspace\x1b[0m`);
      console.log(`   Tool: ${block.name}(${JSON.stringify(block.input)})`);
      const choice = promptSync(`   Allow? [y/N] `);
      if (choice !== 'y' && choice !== 'yes') {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

function logHook(block: any): null {
  /* PreToolUse: log every tool call. */
  const argsPreview = String(Object.values(block.input || {}).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${argsPreview})\x1b[0m`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  /* PostToolUse: warn on large output. */
  const outStr = String(output);
  if (outStr.length > 100000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${block.name}: ${outStr.length} chars\x1b[0m`);
  }
  return null;
}

// UserPromptSubmit hook: log user input before it reaches the LLM
function contextInjectHook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop hook: print summary when loop is about to exit
function summaryHook(messages: any[]): null {
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
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);


// ═══════════════════════════════════════════════════════════
//  agentLoop — same structure as s03, but no hard-coded check
//  s03: if (!checkPermission(block)): ...
//  s04: if (triggerHooks("PreToolUse", block)): ...
// ═══════════════════════════════════════════════════════════

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
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

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      // s04 change: hook replaces hard-coded checkPermission()
      const blocked = triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({ type: "tool_result", tool_use_id: block.id,
                        content: String(blocked) });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(...Object.values(block.input)) : `Unknown: ${block.name}`;

      triggerHooks("PostToolUse", block, output);  // s04: post hook

      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
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
  console.log("s04: Hooks — extension logic on hooks, loop stays clean");
  console.log("Type a question, press Enter. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms04 >> \x1b[0m");
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
