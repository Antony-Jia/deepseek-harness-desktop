---
name: conversation-knowledge-map
description: 在用户明确要求整理多个同工作路径对话、生成思维导图或静态知识图谱时，使用知识视图插件的结构化生成、来源引用、严格约束和工作区持久化流程。
---

# 知识视图生成约束

- 只有用户明确点击确认后，才能读取所选对话正文、调用模型或写入 `.g-dsh-market-knowledge`。
- 只使用锚点 Session 的 `header.cwd` 和用户从同一 `cwd` 选择的 Session；默认排除 `origin: subagent`。
- 默认读取 `sessionQuery.readSurface()`，不要读取或复制完整原始 JSONL。
- 生成模型由用户在配置面板中选择；确认时固定 Provider / Model，并将其传给每一次摘要、图谱和追问调用。
- 思维导图节点必须包含标题、阶段性说明和来源引用；知识图谱关系必须包含证据和置信度。
- 知识图谱是静态结果，不自动更新、不在图上编辑、不从节点发散。
- 思维导图节点只生成后续问题；导航确认后不自动发送。
