#!/usr/bin/env node
/**
 * s02: Tool Use — 在 s01 基础上新增 4 个工具 + 分发映射。
 *
 * 运行: npx tsx s02_tool_use/code.ts
 * 需要: npm install @anthropic-ai/sdk dotenv + .env 中配置 ANTHROPIC_API_KEY
 *
 * 本文件 = s01 的全部代码 + 以下新增:
 *   + runRead / runWrite / runEdit / runGlob 四个工具实现
 *   + TOOL_HANDLERS 分发映射（替代 s01 中硬编码的 runBash 调用）
 *   + safePath 路径安全校验
 *
 * 循环本身（agentLoop）与 s01 完全一致。
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
//  FROM s01 (unchanged)
// ═══════════════════════════════════════════════════════════

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
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


// ═══════════════════════════════════════════════════════════
//  NEW in s02: 4 个新工具
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
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

    // 将简单 glob 模式转为正则
    const regexStr = '^' + pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '___GLOBSTAR___')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/___GLOBSTAR___/g, '.*')
      .replace(/\?/g, '.') + '$';
    const regex = new RegExp(regexStr);

    function walk(currentDir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
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
//  NEW in s02: 工具定义（s01 只有一个 bash，现在扩展到 5 个）
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

// ═══════════════════════════════════════════════════════════
//  NEW in s02: 工具分发映射（s01 是硬编码 runBash，现在改为查表）
// ═══════════════════════════════════════════════════════════

const TOOL_HANDLERS: Record<string, (...args: any[]) => string> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob,
};


// ═══════════════════════════════════════════════════════════
//  agentLoop — 与 s01 结构完全一致，只改了工具执行那部分
//  s01: output = runBash(block.input["command"])
//  s02: output = TOOL_HANDLERS[block.name](...block.input)
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
      if (block.type === "tool_use") {
        console.log(`\x1b[33m> ${block.name}\x1b[0m`);
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(...Object.values(block.input)) : `Unknown: ${block.name}`;
        console.log(String(output).slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
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
  console.log("s02: Tool Use — 在 s01 基础上加了 4 个工具");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms02 >> \x1b[0m");
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
