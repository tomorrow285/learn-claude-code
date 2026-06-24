## 子智能体

## 系统提示词

- 主智能体： For complex sub-problems, use the task tool to spawn a subagent.
- 子智能体：  `You are a coding agent at ${WORKDIR}. ` +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

## spawnSubagent

- 本质上是有限制的Loop，限制循环次数30次，不可以继续分发任务，没有todo_write工具和相关reminder

## task tool

- 工具中新增 task tool
```ts
TOOLS.push({
  name: "task",
  description: "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
  input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
});
TOOL_HANDLERS["task"] = spawnSubagent;
```