## 消息压缩

4种压缩方案 + 消息过长时的实时压缩方案

## snip_compact - 压缩（删除）中间的消息

- 指定一个 maxMessages 数量，例如 50，将中间区域的 Message 尽量删除，保留开头的3条消息和尾部的 50-3 条消息
- 如果从头部删除的消息是一个工具调用，则保留该消息和它的执行结果消息，向后顺延
- 如果从尾部删除的消息后一条是一个工具执行结果，它的工具调用消息，向前顺延

## micro_compact - 将较早且较长的工具执行结果替换为占位字符

- 设定需要保留的结果数量 KEEP_RECENT = 3
- 设定最大工具调用结果长度 = 120
- 将 KEEP_RECENT 前的工具结果进行遍历，将字符串类型的过长的执行结果替换为“[Earlier tool result compacted. Re-run if needed.]”

## tool_result_budget - 将超大的执行结果持久化

- 设定一个message中字符串的最大总长度=200_000
- 识别到总长度超出的message，将它的contents按照字符大小排序
- 设定一个需要持久化的消息长度：PERSIST_THRESHOLD =30000
- 遍历contents，将超出 PERSIST_THRESHOLD 的字符串内容：
    - 存储为文件（目录：TOOL_RESULTS_DIR  文件名：{tool_use_id}）
    - 内容替换为 `<persisted-output>\nFull output: ${p}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`


## compact_history - 使用LLM将当前会话中所有消息压缩为一条消息

- 处理的似乎是所有消息
- 将消息转换为字符串数组，写入到一个文件中
- 将将消息转换为字符串，最多保留80K字符，要求LLM对消息进行压缩：
    - 总结本次编程助手的对话内容，以便后续工作能够继续。保留：1. 当前目标，2. 关键发现/决策，3. 已阅读/修改的文件，4. 剩余工作，5. 用户约束。要求简洁但具体。
- 将 AI 的返回数据合并为一个字符串，加上 [Compacted] 标记，返回新的会话消息：[{ role: "user", content: `[Compacted]\n\n${summary}` }]
- 至此，一个包含了许多许多消息的会话历史被AI压缩为一个包含压缩内容的会话消息


## reactiveCompact - 当AI返回会话过长的错误消息时执行

- 在 compact_history 的基础上，保留最近的5条消息，标记改为 [Reactive compact]
- 执行时机：errStr.toLowerCase().includes("prompt_too_long") || errStr.toLowerCase().includes("too many tokens"))
- 最大重试次数：reactiveRetries < MAX_REACTIVE_RETRIES（1）

## 压缩时机

- tool_result_budget 每次循环开始时自动执行 顺位1
- snip_compact 每次循环开始时自动执行 顺位2
- micro_compact 每次循环开始时自动执行 顺位3
- compact_history 每次循环开始时自动判断 顺位4，所有消息序列化的字符串长度 > CONTEXT_LIMIT（50K） 时自动执行