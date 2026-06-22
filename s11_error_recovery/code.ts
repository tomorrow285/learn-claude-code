#!/usr/bin/env tsx
/**
 * s11: Error Recovery — three recovery paths + exponential backoff.
 *
 * Run:  tsx s11_error_recovery/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 * Changes from s10:
 *   - LLM call wrapped in try/except with three recovery paths
 *   - Path 1: max_tokens -> escalate 8K->64K (no append on first escalation),
 *             then continuation prompt (max 3)
 *   - Path 2: prompt_too_long -> reactive compact -> retry (once)
 *   - Path 3: 429/529 -> exponential backoff with jitter (max 10),
 *             fallback model on consecutive 529
 *   - with_retry wrapper for transient errors
 *   - RecoveryState tracks escalation / compact / 529 / model
 *
 * ASCII flow:
 *   messages -> prompt assembly -> compress+load -> [try] LLM [except] -> tools -> loop
 *                                                     |          |
 *                                               stop_reason   error type
 *                                               max_tokens?   prompt_too_long? -> compact
 *                                               escalate /    429/529? -> backoff
 *                                               continue      other? -> log + exit
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
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
const PRIMARY_MODEL = process.env.MODEL_ID!;
const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID;

// ── Constants ──

const ESCALATED_MAX_TOKENS = 64000;
const DEFAULT_MAX_TOKENS = 8000;
const MAX_RECOVERY_RETRIES = 3;
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 500;
const MAX_CONSECUTIVE_529 = 3;
const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — " +
  "no apology, no recap. Pick up mid-thought.";

// ── Prompt Assembly (from s10, synced) ──

const PROMPT_SECTIONS: Record<string, string> = {
  identity: "You are a coding agent. Act, don't explain.",
  tools: "Available tools: bash, read_file, write_file.",
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
  if (key === _lastContextKey && _lastPrompt) {
    console.log(`  \x1b[90m[cache hit] system prompt unchanged\x1b[0m`);
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
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  try {
    const result = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const out = (result.stdout || '' + result.stderr || '').trim();
    // execSync combines stdout/stderr — we have stdout as result, stderr is separate
    // For simplicity, return the stdout
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
    const filePath = safePath(p);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: unknown) {
    return `Error: ${String(e)}`;
  }
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ToolHandler {
  (input: Record<string, unknown>): string;
}

const TOOLS: ToolDef[] = [
  {
    name: "bash", description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file", description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "write_file", description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command as string),
  read_file: (input) => runRead(input.path as string, input.limit as number | null | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
};

// ── Error Recovery (s11 new) ──

interface RecoveryState {
  hasEscalated: boolean;
  recoveryCount: number;
  consecutive529: number;
  hasAttemptedReactiveCompact: boolean;
  currentModel: string;
}

function createRecoveryState(): RecoveryState {
  return {
    hasEscalated: false,
    recoveryCount: 0,
    consecutive529: 0,
    hasAttemptedReactiveCompact: false,
    currentModel: PRIMARY_MODEL,
  };
}

function retryDelay(attempt: number, retryAfter?: number | null): number {
  /** Exponential backoff with jitter. Retry-After takes priority. */
  if (retryAfter) return retryAfter;
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 32000) / 1000;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

async function withRetry(
  fn: () => Promise<Anthropic.Messages.Message>,
  state: RecoveryState,
): Promise<Anthropic.Messages.Message> {
  /** Exponential backoff for transient errors (429/529).
   *  Non-transient errors are re-raised for the outer handler. */
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e: unknown) {
      const err = e as Error & { status?: number };
      const name = err.constructor.name.toLowerCase();
      const msg = String(err).toLowerCase();

      // 429 rate limit -> exponential backoff
      if (name.includes("ratelimit") || msg.includes("429") || err.status === 429) {
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[429 rate limit] retry ${attempt + 1}/${MAX_RETRIES}, wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }

      // 529 overloaded -> exponential backoff + fallback model
      if (name.includes("overloaded") || msg.includes("529") || msg.includes("overloaded") || err.status === 529) {
        state.consecutive529 += 1;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529) {
          if (FALLBACK_MODEL) {
            state.currentModel = FALLBACK_MODEL;
            state.consecutive529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] switching to ${FALLBACK_MODEL}\x1b[0m`,
            );
          } else {
            state.consecutive529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] no FALLBACK_MODEL_ID configured, continuing retry\x1b[0m`,
            );
          }
        }
        const delay = retryDelay(attempt);
        console.log(
          `  \x1b[33m[529 overloaded] retry ${attempt + 1}/${MAX_RETRIES}, wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }

      // Not transient -> re-raise for outer try/catch
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

function isPromptTooLongError(e: unknown): boolean {
  /** Check whether an API error indicates prompt/context too long. */
  const msg = String(e).toLowerCase();
  return (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("prompt_is_too_long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window")
  );
}

function reactiveCompact(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
  /** Emergency compact — teaching version keeps last N messages.
   *  Real CC generates a compact summary via LLM, then retries with
   *  the compacted message list. Teaching version simplifies to tail
   *  retention since s08/s09 already cover LLM-based compact. */
  console.log(`  \x1b[31m[reactive compact] trimming to last 5 messages\x1b[0m`);
  const tail = messages.slice(-5);
  return [
    {
      role: "user",
      content:
        "[Reactive compact] Earlier conversation trimmed. Continue from where you left off.",
    },
    ...tail,
  ];
}

// ── Context ──

function updateContext(
  _context: Record<string, unknown>,
  _messages: Anthropic.Messages.MessageParam[],
): Record<string, unknown> {
  /** Derive context from real state: which tools exist, whether memory files exist. */
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    const content = fs.readFileSync(MEMORY_INDEX, 'utf-8').trim();
    if (content) memories = content;
  }
  return {
    enabled_tools: Object.keys(TOOL_HANDLERS),
    workspace: WORKDIR,
    memories,
  };
}

// ── Agent Loop ──

async function agentLoop(
  messages: Anthropic.Messages.MessageParam[],
  context: Record<string, unknown>,
): Promise<void> {
  /** Main loop with error recovery wrapping LLM calls. */
  let system = getSystemPrompt(context);
  const state = createRecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    // ── LLM call: withRetry handles 429/529, outer handles rest ──
    let response: Anthropic.Messages.Message;
    try {
      response = await withRetry(
        () =>
          client.messages.create({
            model: state.currentModel,
            system,
            messages,
            tools: TOOLS as Anthropic.Messages.Tool[],
            max_tokens: maxTokens,
          }),
        state,
      );
    } catch (e: unknown) {
      // Path 2: prompt_too_long -> reactive compact (once)
      if (isPromptTooLongError(e)) {
        if (!state.hasAttemptedReactiveCompact) {
          messages.length = 0;
          messages.push(...reactiveCompact(messages));
          state.hasAttemptedReactiveCompact = true;
          continue;
        }
        console.log(`  \x1b[31m[unrecoverable] still too long after compact\x1b[0m`);
        messages.push({
          role: "assistant",
          content: [
            { type: "text", text: "[Error] Context too large, cannot continue." },
          ],
        });
        return;
      }

      // Unrecoverable
      const name = e instanceof Error ? e.constructor.name : String(e);
      console.log(`  \x1b[31m[unrecoverable] ${name}: ${String(e).slice(0, 100)}\x1b[0m`);
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `[Error] ${name}: ${String(e).slice(0, 200)}` },
        ],
      });
      return;
    }

    // ── Path 1: max_tokens -> escalate or continue ──
    if (response.stop_reason === "max_tokens") {
      // First escalation: don't append truncated output, retry same request
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(
          `  \x1b[33m[max_tokens] escalating ${DEFAULT_MAX_TOKENS} -> ${ESCALATED_MAX_TOKENS}\x1b[0m`,
        );
        continue;
      }
      // 64K still truncated: save truncated output + continuation prompt
      messages.push({ role: "assistant", content: response.content });
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT });
        state.recoveryCount += 1;
        console.log(
          `  \x1b[33m[max_tokens] continuation ${state.recoveryCount}/${MAX_RECOVERY_RETRIES}\x1b[0m`,
        );
        continue;
      }
      console.log(`  \x1b[31m[max_tokens] recovery limit reached\x1b[0m`);
      return;
    }

    // Normal completion: append assistant response
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") return;

    // ── Tool execution ──
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      const handler = TOOL_HANDLERS[block.name];
      const output = handler
        ? handler(block.input as Record<string, unknown>)
        : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: output,
      });
    }
    messages.push({ role: "user", content: results });

    context = updateContext(context, messages);
    system = getSystemPrompt(context);
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log("s11: error recovery");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const history: Anthropic.Messages.MessageParam[] = [];
  let context = updateContext({}, []);

  while (true) {
    let query: string;
    try {
      query = await question("\x1b[36ms11 >> \x1b[0m");
    } catch {
      break;
    }
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") break;

    const turnStart = history.length;
    history.push({ role: "user", content: query });
    await agentLoop(history, context);
    context = updateContext(context, history);

    for (const msg of history.slice(turnStart)) {
      if (msg.role !== "assistant") continue;
      const content = msg.content;
      if (typeof content === "string") {
        console.log(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && "type" in block) {
            const b = block as { type: string; text?: string };
            if (b.type === "text" && b.text) console.log(b.text);
          }
        }
      }
    }
    console.log();
  }
  rl.close();
}

main().catch(console.error);
