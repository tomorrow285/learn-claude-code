## 构建 System Prompt

```ts
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
```


## main

- 维护一个 context： `let context: Context = updateContext({} as Context, []);`
- 第一次构建 system prompt: `let system = getSystemPrompt(context)`


## Loop

- 每次工具调用和执行结束后：`response.stop_reason === "tool_use"` // Re-evaluate context and prompt after tool round
  - 更新 context： `context = updateContext(context, history);`
  - 更新 prompt： `system = getSystemPrompt(context);`
- 使用 LLM 评估工具的执行结果 // Follow-up call for tool results
- 然后再次更新 context 和 prompt
  - 更新 context： `context = updateContext(context, history);`
  - 更新 prompt： `system = getSystemPrompt(context);`

## updateContext

- 将 TOOL_HANDLERS、WORKDIR、memories 信息注入到 `context` 中

## getSystemPrompt

- 创建 key: `const key = JSON.stringify(context, Object.keys(context).sort());`
- key没有变化时，复用上一次创建的 prompt
- 否则调用 `assembleSystemPrompt` 组装 prompt

## assembleSystemPrompt

- 根据 context 的数据，将 `identity、tools、workspace、memory` 信息插入到 `sections(string[])` 中
- `return sections.join("\n\n")`
