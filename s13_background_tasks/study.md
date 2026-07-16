# 后台任务

- 将明确要求在后台运行的，和耗时较长的任务放在后台执行

```ts
function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  /** Fallback heuristic: commands likely to take > 30s. */
  if (toolName !== "bash") return false;
  const cmd = String(toolInput["command"] ?? "").toLowerCase();
  const slowKeywords = [
    "install", "build", "test", "deploy", "compile",
    "docker build", "pip install", "npm install",
    "cargo build", "pytest", "make",
  ];
  return slowKeywords.some((kw) => cmd.includes(kw));
}

function shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  /** Model explicit request takes priority; fallback to heuristic. */
  if (toolInput["run_in_background"]) return true;
  return isSlowOperation(toolName, toolInput);
}
```

## Loop

- 每轮循环结束时，收集后台任务的执行结果： `collectBackgroundResults`