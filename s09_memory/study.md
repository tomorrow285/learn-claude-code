## 构建长期记忆

```ts
interface MemoryFileMeta {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
}

```

## SYSTEM

相关记忆已注入下方。请尊重记忆中记录的用户偏好。当用户说"记住"或表达明确偏好时，将其提取为记忆。

```ts
function buildSystem(): string {
  const index = readMemoryIndex(); // 用于获取 MEMORY.md 中的内容 
  const memoriesSection = index ? `\n\nMemories available:\n${index}` : "";
  return (
    `You are a coding agent at ${WORKDIR}.` +
    `${memoriesSection}\n` +
    "Relevant memories are injected below. Respect user preferences from memory.\n" +
    "When the user says 'remember' or expresses a clear preference, extract it as a memory."
  );
}
```

## agentLoop

- 每次开启 Loop 时加载一次记忆：loadMemories
- 每次开启 Loop 时使用 memoryTurn: 标记进入 Loop 时的用户消息
- 每次循环时，存储压缩前的消息 preCompress
- 每次循环时，把加载的 memoriesContent 插入到 memoryTurn 标记的用户消息中：`content: memoriesContent + "\n\n" + messages[memoryTurn].content`
- 每次 Loop 结束时更新记忆：
  - extractMemories 提取记忆
  - consolidateMemories 整合记忆


## loadMemories

- Loop 开始前把记忆从 messages 中加载进来
- selectRelevantMemories
  - recent： 将 messages 中最近三条 role=user 的消息内容合并在一起
  - catalog：调用 `listMemoryFiles` 读取所有记忆文件，创建 `${i}: ${f.name} — ${f.description}` 列表
  - 调用 LLM 来选择需要使用的记忆：
```ts
const prompt =
  "Given the recent conversation and the memory catalog below, " +
  "select the indices of memories that are clearly relevant. " +
  "Return ONLY a JSON array of integers, e.g. [0, 3]. " +
  "If none are relevant, return [].\n\n" +
  `Recent conversation:\n${recent}\n\n` +
  `Memory catalog:\n${catalog}`;
```
  - 使用 LLM 匹配出来的记忆文件
  - 如果 LLM 没有匹配上，则将 `recent` 展开为 keywords，尝试用 keywords 和记忆文件的名称+描述进行匹配
- 如果匹配成功，则使用 `readMemoryFile` 读取所有匹配的记忆文件
- 使用 `<relevant_memories>` `</relevant_memories>` 来标记记忆文件中获取的内容



## extractMemories

- dialogue： 提取最近的10条消息
- existingDesc： 调用 `listMemoryFiles` 读取所有记忆文件，创建 `${i}: ${f.name} — ${f.description}` 列表
- 调用 LLM 来提取记忆：
```ts
// 从这段对话中提取用户偏好、约束条件或项目事实
// 返回一个 JSON 数组。每个条目：{name, type, description, body}。
// - name：简短的 kebab-case 标识符（例如 'user-preference-tabs'）
// - type：'user'（用户偏好）、'feedback'（指导性反馈）、'project'（项目事实）、'reference'（外部引用）之一
// - description：用于索引查找的一行摘要
// - body：Markdown 格式的完整详情
const prompt =
  "Extract user preferences, constraints, or project facts from this dialogue.\n" +
  "Return a JSON array. Each item: {name, type, description, body}.\n" +
  "- name: short kebab-case identifier (e.g. 'user-preference-tabs')\n" +
  "- type: one of 'user' (user preference), 'feedback' (guidance), " +
  "'project' (project fact), 'reference' (external pointer)\n" +
  "- description: one-line summary for index lookup\n" +
  "- body: full detail in markdown\n" +
  "If nothing new or already covered by existing memories, return [].\n\n" +
  `Existing memories:\n${existingDesc}\n\n` +
  `Dialogue:\n${dialogue.slice(0, 4000)}`;
```
- 根据 LLM 返回的数据写入记忆文件： `writeMemoryFile`
- 更具 LLM 返回的数据整理 MEMORY.md

## consolidateMemories

- 如果记忆文件数量 `files.length < CONSOLIDATE_THRESHOLD(10)` 则不执行后续操作
- catalog： 将所有记忆文件拼接在一起：`## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`
- 调用 LLM 整理记忆
```ts
// "整合以下记忆文件。规则：\n" +
// "1. 将重复项合并为一条\n" +
// "2. 移除过时或相互矛盾的记忆\n" +
// "3. 保持记忆总数在 30 条以内\n" +
// "4. 优先保留重要的用户偏好\n" +
// "返回一个 JSON 数组。每个条目：{name, type, description, body}。\n\n"
const prompt =
  "Consolidate the following memory files. Rules:\n" +
  "1. Merge duplicates into one\n" +
  "2. Remove outdated/contradicted memories\n" +
  "3. Keep the total under 30 memories\n" +
  "4. Preserve important user preferences above all\n" +
  "Return a JSON array. Each item: {name, type, description, body}.\n\n" +
  catalog.slice(0, 16000);
```
- 根据 LLM 返回的数据写入记忆文件： `writeMemoryFile`
- 更具 LLM 返回的数据整理 MEMORY.md
