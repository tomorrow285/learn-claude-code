## LLM 容错

- 维护一个 state
```ts
interface RecoveryState {
  hasEscalated: boolean; // 是否已执行过 token 升级
  recoveryCount: number; // 恢复尝试次数
  consecutive529: number; // 连续 529 错误的计数
  hasAttemptedReactiveCompact: boolean; // 是否已尝试过响应式压缩
  currentModel: string; // 当前使用的模型
}
```
- 将调用 LLM 的方法放在 `withRetry` 中执行，用来自动容错

## withRetry

- 在一个循环体（循坏次数=MAX_RETRIES=10）中给 LLM 发送消息
- LLM 报错时，解析 err 中的 name 和 msg
- 429 rate limit 频率限制: `name.includes("ratelimit") || msg.includes("429") || err.status === 429`
  - 执行 exponential backoff 指数退避策略，等待一定时间后重试
  - const delay = retryDelay(attempt);
  - await new Promise((r) => setTimeout(r, delay * 1000));
  - continue
- 529 overloaded 过载： `name.includes("overloaded") || msg.includes("529") || msg.includes("overloaded") || err.status === 529`
  - 备用模型策略 fallback model ： state.currentModel = FALLBACK_MODEL;
  - 指数退避策略，等待一定时间后重试

## Loop

- LLM 因为 token 过大而停止时：`response.stop_reason === "max_tokens"`
- 更新 MaxTokens 修改 `maxTokens = ESCALATED_MAX_TOKENS`