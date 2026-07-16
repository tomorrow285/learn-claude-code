#!/usr/bin/env tsx
/**
 * s10: System Prompt — Runtime prompt assembly with caching.
 *
 * Run:  npx tsx s10_system_prompt/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s09:
 *   - PROMPT_SECTIONS: topic-keyed dict of prompt fragments
 *   - assemble_system_prompt(context): select + join sections by real state
 *   - get_system_prompt(context): deterministic cache via JSON.stringify
 *   - agent_loop uses get_system_prompt(context) instead of hardcoded SYSTEM
 *
 * Memory section loads when .memory/MEMORY.md exists (real state, not keywords).
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
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;


// ── Prompt Sections ──

interface PromptSections {
  [key: string]: string;
}

const PROMPT_SECTIONS: PromptSections = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file.",
  workspace: `Working directory: ${WORKDIR}`,
  memory: "Relevant memories are injected below when available.",
};

interface Context {
  enabled_tools: string[];
  workspace: string;
  memories: string;
  [key: string]: unknown;
}

function assembleSystemPrompt(context: Context): string {
  /** Select and join prompt sections based on current context. */
  const sections: string[] = [];

  // Always loaded — identity, tools, workspace
  sections.push(PROMPT_SECTIONS["identity"]);
  sections.push(PROMPT_SECTIONS["tools"]);
  sections.push(PROMPT_SECTIONS["workspace"]);

  // Conditional — memory loaded when MEMORY.md exists and has content
  const memories = context["memories"] || "";
  if (memories) {
    sections.push(`Relevant memories:\n${memories}`);
  }

  return sections.join("\n\n");
}


let _lastContextKey: string | null = null;
let _lastPrompt: string | null = null;


function getSystemPrompt(context: Context): string {
  /** Cache wrapper — reassemble only when context changes.
   *
   * Uses JSON.stringify for deterministic serialization, not JavaScript's
   * object identity which fails on nested objects.
   * This cache only avoids redundant string assembly within a process.
   * Real Claude Code additionally protects API-level prompt cache via
   * stable section ordering and SYSTEM_PROMPT_DYNAMIC_BOUNDARY.
   */
  const key = JSON.stringify(context, Object.keys(context).sort());
  if (key === _lastContextKey && _lastPrompt) {
    console.log("  \x1b[90m[cache hit] system prompt unchanged\x1b[0m");
    return _lastPrompt;
  }
  _lastContextKey = key;
  _lastPrompt = assembleSystemPrompt(context);

  const loaded = ["identity", "tools", "workspace"];
  if (context["memories"]) loaded.push("memory");
  console.log(`  \x1b[32m[assembled] sections: ${loaded.join(", ")}\x1b[0m`);
  return _lastPrompt;
}


// ── Tools ──

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

const TOOLS = [
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
];

type ToolHandler = (...args: any[]) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: runBash,
  read_file: runRead,
  write_file: runWrite,
};


// ── Context ──

function updateContext(context: Context, messages: { role: string; content: unknown }[]): Context {
  /** Derive context from real state: which tools exist, whether memory files exist. */
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    const content = fs.readFileSync(MEMORY_INDEX, "utf-8").trim();
    if (content) memories = content;
  }
  return {
    enabled_tools: Object.keys(TOOL_HANDLERS),
    workspace: WORKDIR,
    memories,
  };
}


// ── Agent Loop ──

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

async function agentLoop(messages: { role: string; content: unknown }[], context: Context): Promise<void> {
  /** Main loop — uses assembled system prompt instead of hardcoded SYSTEM. */
  let system = getSystemPrompt(context);
  while (true) {
    const response = await client.messages.create(
      MODEL, system, messages, TOOLS, { maxTokens: 8000 }
    );
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: { type: string; tool_use_id: string; content: string }[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const handler = TOOL_HANDLERS[block.name!];
      const output = handler
        ? handler(...Object.values(block.input ?? {}))
        : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({
        type: "tool_result",
        tool_use_id: block.id!,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

    // Re-evaluate context and prompt after each tool round
    const newContext = updateContext(context, messages);
    Object.assign(context, newContext);
    system = getSystemPrompt(context);
  }
}


// ── Main ──

async function main(): Promise<void> {
  console.log("s10: system prompt — runtime assembly");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: { role: string; content: unknown }[] = [];
  let context: Context = updateContext({} as Context, []);

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question("\x1b[36ms10 >> \x1b[0m", (answer) => resolve(answer));
    });

  while (true) {
    const query = await ask();
    if (query.trim().toLowerCase() === "q" || query.trim().toLowerCase() === "exit" || query.trim() === "") {
      break;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history, context);
    context = updateContext(context, history);
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
