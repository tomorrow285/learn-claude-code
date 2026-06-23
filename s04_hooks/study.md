## Hooks

- 在对话流程中，定义了4个生命周期："UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop"
- 将非对话主流程的逻辑全部提取出来，通过 hooks 注入到流程的生命周期中

## 生命周期

- UserPromptSubmit：用户输入问题后，进入loop前
- PreToolUse：执行大模型提供的工具命令前，该hook支持返回值，有返回值时，视为拒绝本次工具执行
- PostToolUse：执行工具命令后
- Stop：在循环结束时执行，该hook支持返回force值，有force时，在history中追加messages.push({ role: "user", content: force });，然后重新开启循环

## 挂载的Hook

- UserPromptSubmit：contextInjectHook
- PreToolUse：permissionHook logHook
- PostToolUse： largeOutputHook
- Stop： summaryHook