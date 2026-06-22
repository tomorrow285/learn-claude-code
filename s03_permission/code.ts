#!/usr/bin/env node
/**
 * s03_permission.ts - Permission System
 *
 * Three gates inserted before tool execution:
 *
 *     Gate 1: Hard deny list (rm -rf /, sudo, ...)
 *     Gate 2: Rule matching (write outside workspace? destructive cmd?)
 *     Gate 3: User approval (pause and wait for confirmation)
 *
 *     +-------+    +--------+    +--------+    +--------+    +------+
 *     | Tool  | -> | Gate 1 | -> | Gate 2 | -> | Gate 3 | -> | Exec |
 *     | call  |    | deny?  |    | match? |    | allow? |    |      |
 *     +-------+    +--------+    +--------+    +--------+    +------+
 *          |            |             |             |
 *          v            v             v             v
 *       (normal)     (blocked)    (ask user)   (user says no?)
 *
 * Only one line added to the agent loop:
 *
 *     if (!checkPermission(block)):
 *         continue
 *
 * Builds on s02 (multi-tool). Usage:
 *
 *     npx tsx s03_permission/code.ts
 *     Needs: npm install @anthropic-ai/sdk dotenv + ANTHROPIC_API_KEY in .env
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval.`;


// ═══════════════════════════════════════════════════════════
//  FROM s02 (unchanged): Tool Implementations
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
//  FROM s02 (unchanged): Tool Definitions & Dispatch
// ═══════════════════════════════════════════════════════════

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
//  NEW in s03: Three-Gate Permission Pipeline
// ═══════════════════════════════════════════════════════════

// Gate 1: Hard deny list — always forbidden
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}


// Gate 2: Rule matching — context-dependent checks
interface PermissionRule {
  tools: string[];
  check: (args: Record<string, any>) => boolean;
  message: string;
}

const PERMISSION_RULES: PermissionRule[] = [
  { tools: ["write_file", "edit_file"],
    check: (args) => {
      const p = args.path || "";
      try { safePath(p); return false; } catch { return true; }
    },
    message: "Writing outside workspace" },
  { tools: ["bash"],
    check: (args) => ["rm ", "> /etc/", "chmod 777"].some(kw => (args.command || "").includes(kw)),
    message: "Potentially destructive command" },
];

function checkRules(toolName: string, args: Record<string, any>): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) {
      return rule.message;
    }
  }
  return null;
}


// Gate 3: User approval — wait for confirmation after rule match
async function askUser(toolName: string, args: Record<string, any>, reason: string): Promise<string> {
  console.log(`\n\x1b[33m⚠  ${reason}\x1b[0m`);
  console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
  const answer = await ask(`   Allow? [y/N] `);
  const choice = answer.trim().toLowerCase();
  return (choice === 'y' || choice === 'yes') ? "allow" : "deny";
}


// Pipeline: all three gates chained
async function checkPermission(block: any): Promise<boolean> {
  if (block.name === "bash") {
    const reason = checkDenyList(block.input?.command || "");
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      return false;
    }
  }
  const reason = checkRules(block.name, block.input);
  if (reason) {
    const decision = await askUser(block.name, block.input, reason);
    if (decision === "deny") {
      return false;
    }
  }
  return true;
}


// ═══════════════════════════════════════════════════════════
//  agentLoop — same as s02, with checkPermission() inserted
// ═══════════════════════════════════════════════════════════

async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages: messages as any,
      tools: TOOLS as any, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: any[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      // s03 change: run through permission pipeline before executing
      if (!(await checkPermission(block))) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: "Permission denied." });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(...Object.values(block.input)) : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    messages.push({ role: "user", content: results });
  }
}


// ═══════════════════════════════════════════════════════════
//  Entry point
// ═══════════════════════════════════════════════════════════

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => { rl.question(prompt, resolve); });
}

async function main(): Promise<void> {
  console.log("s03: Permission");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms03 >> \x1b[0m");
    } catch {
      break;
    }
    if (query.trim().toLowerCase() === 'q' || query.trim().toLowerCase() === 'exit' || query.trim() === '') {
      break;
    }
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
