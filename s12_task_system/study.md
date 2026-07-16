# Task

提供了一系列 Task 相关工具和调用器，用来管理和执行跨会话的任务

```ts
interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;       // pending | in_progress | completed
  owner: string | null; // Agent name (multi-agent scenarios)
  blockedBy: string[];  // Dependency task IDs
}


{
    name: "create_task",
    description: "Create a new task with optional blockedBy dependencies.",
}
{

    name: "list_tasks",
    description: "List all tasks with status, owner, and dependencies.",
}
{

    name: "get_task",
    description: "Get full details of a specific task by ID.",
}
{

    name: "claim_task",
    description: "Claim a pending task. Sets owner, changes status to in_progress.",
}
{
    name: "complete_task",
    description: "Complete an in-progress task. Reports unblocked downstream tasks.",
}
```

## 和 todo_write 对比

s05 todo_write 是"给 LLM 看的便签"：它的价值在于让模型把计划写下来、保持专注（配合 nag 提醒防止跑偏），本质是一种上下文管理/注意力锚定技术。对应真实 Claude Code 的 TodoWrite 工具。

s12 Task 系统是"真正的任务基础设施"：文件持久化 + 依赖图 + 认领机制，使任务可以跨会话存活、被多个 Agent 并发消费，状态迁移有守卫保证一致性。它是从"单会话计划清单"到"多 Agent 工作队列"的演进。

一句话总结：s05 管理的是"我这次对话打算做什么"，s12 管理的是"这个项目有哪些工作、谁在做、什么能开始做"
