## Skill

## buildSystem

- 系统提示词从静态改为动态：

```ts
  const catalog = listSkills();
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${catalog}\n` +
    "Use load_skill to get full details when needed."
  );
```

## listSkills + scanSkills

扫描 skill 目录下所有 SKILL.md 文件，然后从文件中解析这样的结构：
---
name: agent-builder
description: |
  Design and build AI agents for any domain. Use when users:
  (1) ask to "create an agent", "build an assistant", or "design an AI system"
  (2) want to understand agent architecture, agentic patterns, or autonomous AI
  (3) need help with capabilities, subagents, planning, or skill mechanisms
  (4) ask about Claude Code, Cursor, or similar agent internals
  (5) want to build agents for business, research, creative, or operational tasks
  Keywords: agent, assistant, autonomous, workflow, tool use, multi-step, orchestration
---
从结构中获取 name description content 信息，将得到的所有有效 skill 整理为一个包含 name description 的列表

```ts
function listSkills(): string {
  /** List all skills (name + one-line description). */
  const entries = Object.values(SKILL_REGISTRY);
  if (entries.length === 0) {
    return "(no skills found)";
  }
  return entries.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
```

## load_skill tool

```json
  { name: "load_skill", description: "Load the full content of a skill by name.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
```

runner: loadSkill
```ts
function loadSkill(name: string): string {
  /** Load full skill content. Lookup via registry — no path traversal. */
  const skill = SKILL_REGISTRY[name];
  if (!skill) {
    return `Skill not found: ${name}`;
  }
  return skill.content;
}
```