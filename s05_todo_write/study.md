## todo_write（本质上是 plan mode?）

- 新增了一个名为 todo_write 的工具和它的 runner
- 修改了系统提示词，让系统在执行多步骤任务时，执行 todo_write 工具
- loop 中新增了user类型“更新todo”的提示词逻辑

## 系统提示词

  "Before starting any multi-step task, use todo_write to plan your steps. " +
  "Update status as you go."

## todo_write

- 三种状态："pending" | "in_progress" | "completed"
- Tool：{ name: "todo_write", description: "Create and manage a task list for your current coding session.",
    input_schema: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] } },
- Runner： 将大模型提供的任务列表格式化，给用户一个良好的文案展示

## Loop

在每次和AI对话前检查 roundsSinceTodo 计数，计数大于3则追加 messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" }); 并清空计数
当大模型的返回值不是 tool_use 时增加 roundsSinceTodo

这个设计是因为 LLM 代理的经典遗忘问题。LLM会专注于处理问题，而忘记更新 plan 的状态