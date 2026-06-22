#!/usr/bin/env tsx
/**
 * s06: Subagent — spawn sub-agents with fresh messages[] for context isolation.
 *
 *   Parent Agent                           Subagent
 *   +------------------+                  +------------------+
 *   | messages=[...]   |                  | messages=[task]  | <-- fresh
 *   |                  |   dispatch       |                  |
 *   | tool: task       | ---------------> | own while loop   |
 *   |   prompt="..."   |                  |   bash/read/...  |
 *   |                  |   summary only   |   (max 30 turns) |
 *   | result = "..."   | <--------------- | return last text |
 *   +------------------+                  +------------------+
 *         ^                                      |
 *         |       intermediate results DISCARDED  |
 *         +--------------------------------------+
 *
 *   Subagent tools: bash, read, write, edit, glob (NO task — no recursion)
 *
 * Changes from s05:
 *   + task tool + spawn_subagent() with fresh messages[]
 *   + Safety limit: max 30 turns per subagent
 *   + extract_text() helper
 *   Subagent cannot spawn sub-subagents (no task tool in sub_tools).
 *   Main loop unchanged: task auto-dispatches via TOOL_HANDLERS.
 *
 * Run: npx tsx s06_subagent/code.ts
 * Needs: npm install @anthropic-ai/sdk dotenv + ANTHROPIC_API_KEY in .env
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
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;
let CURRENT_TODOS: Record<string, string>[] = [];

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "For complex sub-problems, use the task tool to spawn a subagent.";

// s06: subagent gets its own system prompt — no task, no recursion
const SUB_SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";


// ═══════════════════════════════════════════════════════════
//  FROM s02-s05 (unchanged): Tool Implementations
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  try {
    const r = execSync(command, {
      cwd: WORKDIR,
      timeout: 120000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const out = r.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) {
      return "Error: Timeout (120s)";
    }
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
    if (!text.includes(oldText)) {
      return `Error: text not found in ${p}`;
    }
    fs.writeFileSync(filePath, text.replace(oldText, newText), "utf-8");
    return `Edited ${p}`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const results: string[] = [];
    // Simple glob implementation: convert pattern to regex
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
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), relPath);
        }
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
        // Basic Python literal eval fallback — parse simple list of dicts
        todos = parsePythonLiteral(todos);
      } catch {
        return [null, "Error: todos must be a list or JSON array string"];
      }
    }
  }
  if (!Array.isArray(todos)) {
    return [null, "Error: todos must be a list"];
  }
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

// Simple Python literal parser for the ast.literal_eval fallback
function parsePythonLiteral(s: string): unknown {
  s = s.trim();
  // Very basic: handle only list of simple dicts for todo parsing
  return JSON.parse(s.replace(/'/g, '"'));
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
];

type ToolHandler = (...args: any[]) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob, todo_write: runTodoWrite,
};


// ═══════════════════════════════════════════════════════════
//  NEW in s06: Subagent — fresh messages[], summary only
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
// NO "task" tool — prevent recursive spawning

const SUB_HANDLERS: Record<string, ToolHandler> = {
  bash: runBash, read_file: runRead, write_file: runWrite,
  edit_file: runEdit, glob: runGlob,
};

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

function extractText(content: unknown): string {
  /** Extract text from message content blocks. */
  if (!Array.isArray(content)) {
    return String(content);
  }
  return (content as ContentBlock[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function spawnSubagent(description: string): string {
  /** Spawn a subagent with fresh messages[], return summary only. */
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);
  const messages: { role: string; content: unknown }[] = [
    { role: "user", content: description },
  ]; // fresh context

  for (let i = 0; i < 30; i++) {
    // safety limit
    const response = client.messages.create(
      MODEL,
      SUB_SYSTEM,
      messages,
      SUB_TOOLS,
      { maxTokens: 8000 }
    );
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      break;
    }
    const results: { type: string; tool_use_id: string; content: string }[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        // Issue 1: subagent also runs hooks (permissions apply)
        const blocked = triggerHooks("PreToolUse", block);
        if (blocked) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id!,
            content: String(blocked),
          });
          continue;
        }
        const handler = SUB_HANDLERS[block.name!];
        const output = handler
          ? handler(...Object.values(block.input ?? {}))
          : `Unknown: ${block.name}`;
        triggerHooks("PostToolUse", block, output);
        console.log(`  \x1b[90m[sub] ${block.name}: ${String(output).slice(0, 100)}\x1b[0m`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id!,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  // Issue 5: fallback if safety limit hit during tool_use
  let result = extractText(messages[messages.length - 1].content);
  if (!result) {
    // last message is tool_result, look backwards for assistant text
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        result = extractText(messages[i].content);
        if (result) break;
      }
    }
    if (!result) {
      result = "Subagent stopped after 30 turns without final answer.";
    }
  }
  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  return result; // only summary, entire message history discarded
}

// Add task tool to parent's tools
TOOLS.push({
  name: "task",
  description: "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
  input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
});
TOOL_HANDLERS["task"] = spawnSubagent;


// ═══════════════════════════════════════════════════════════
//  FROM s04 (unchanged): Hook System
// ═══════════════════════════════════════════════════════════

type HookCallback = (...args: any[]) => unknown | null;

const HOOKS: Record<string, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: HookCallback): void {
  HOOKS[event].push(callback);
}

function triggerHooks(event: string, ...args: unknown[]): unknown | null {
  for (const callback of HOOKS[event]) {
    const result = callback(...args);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];

function permissionHook(block: ContentBlock): string | null {
  /** PreToolUse: deny list check. */
  if (block.name === "bash") {
    for (const p of DENY_LIST) {
      if ((block.input?.command as string || "").includes(p)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${p}'\x1b[0m`);
        return "Permission denied";
      }
    }
  }
  return null;
}

function logHook(block: ContentBlock): null {
  /** PreToolUse: log tool calls. */
  console.log(`\x1b[90m[HOOK] ${block.name}\x1b[0m`);
  return null;
}

function contextInjectHook(query: string): null {
  /** UserPromptSubmit: log working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

function summaryHook(messages: { role: string; content: unknown }[]): null {
  /** Stop: print tool call count. */
  let toolCount = 0;
  for (const m of messages) {
    const content = m.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_result") {
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
//  agent_loop — same as s05 + nag reminder, task auto-dispatches
// ═══════════════════════════════════════════════════════════

let roundsSinceTodo = 0;

function agentLoop(messages: { role: string; content: unknown }[]): void {
  while (true) {
    // s05: nag reminder
    if (roundsSinceTodo >= 3 && messages.length > 0) {
      messages.push({
        role: "user",
        content: "<reminder>Update your todos.</reminder>",
      });
      roundsSinceTodo = 0;
    }

    const response = client.messages.create(
      MODEL,
      SYSTEM,
      messages,
      TOOLS,
      { maxTokens: 8000 }
    );
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      const force = triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      return;
    }

    roundsSinceTodo++;
    const results: { type: string; tool_use_id: string; content: string }[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type !== "tool_use") {
        continue;
      }

      const blocked = triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id!,
          content: String(blocked),
        });
        continue;
      }

      const handler = TOOL_HANDLERS[block.name!];
      const output = handler
        ? handler(...Object.values(block.input ?? {}))
        : `Unknown: ${block.name}`;

      triggerHooks("PostToolUse", block, output);

      if (block.name === "todo_write") {
        roundsSinceTodo = 0;
      }

      results.push({
        type: "tool_result",
        tool_use_id: block.id!,
        content: output,
      });
    }

    messages.push({ role: "user", content: results });
  }
}


// ── Main ──

async function main(): Promise<void> {
  console.log("s06: Subagent — spawn sub-agents with fresh context, summary only");
  console.log("Type a question, press Enter. Type q to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: { role: string; content: unknown }[] = [];

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms06 >> \x1b[0m", (answer) => resolve(answer));
    });

  while (true) {
    const query = await ask();
    if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
      break;
    }
    triggerHooks("UserPromptSubmit", query);
    history.push({ role: "user", content: query });
    agentLoop(history);
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent as ContentBlock[]) {
        if (block.type === "text") {
          console.log(block.text);
        }
      }
    }
    console.log();
  }

  rl.close();
}

main().catch(console.error);
