#!/usr/bin/env node
/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 *
 * Usage:
 *     npm install @anthropic-ai/sdk dotenv
 *     ANTHROPIC_API_KEY=... npx tsx s01_agent_loop/code.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { execSync } from 'child_process';
import * as readline from 'readline';
import Anthropic from '@anthropic-ai/sdk';

// NOTE: Python 版使用 readline.parse_and_bind 修复 macOS libedit 中文退格问题，
// Node.js 的 readline 模块不存在此问题，无需处理。

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// ── Tool definition: just bash ────────────────────────────
const TOOLS = [{
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
}];


// ── Tool execution ────────────────────────────────────────
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command + ' 2>&1', {
      cwd: process.cwd(),
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


// ── The core pattern: a while loop that calls tools until the model stops ──
async function agentLoop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // Execute each tool call, collect results
    const results: any[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m$ ${block.input['command']}\x1b[0m`);
        const output = runBash(block.input["command"]);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // Feed tool results back, loop continues
    messages.push({ role: "user", content: results });
  }
}


// ── Entry point ──────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main(): Promise<void> {
  console.log("s01: Agent Loop");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      query = await ask("\x1b[36ms01 >> \x1b[0m");
    } catch {
      break;
    }
    if (query.trim().toLowerCase() === 'q' || query.trim().toLowerCase() === 'exit' || query.trim() === '') {
      break;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    // Print the model's final text response
    const responseContent = history[history.length - 1]["content"];
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
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
