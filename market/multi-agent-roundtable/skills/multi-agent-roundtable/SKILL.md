---
name: multi-agent-roundtable
description: 在当前 DSH 对话中调用多个独立角色，对问题进行讨论、评审、会诊或头脑风暴。
---

# Multi-Agent Roundtable

当用户明确要求多个角色、多个专家或多个智能体共同讨论、评审、会诊或头脑风暴时，调用 `multi_agent_discuss`。

- 将用户的问题完整放入 `topic`，不要擅自缩小讨论范围。
- 未指定角色、模式或轮数时，省略相应参数，使用插件中保存的默认配置。
- 用户要求各自独立判断时使用 `independent`；要求互相复核时使用 `review`；要求主持人汇总时使用 `host`。
- 工具返回后，基于各角色的正式回答向用户总结；不要把角色的 reasoning 当作正式意见。
- 详细群聊记录保存在插件的 Multi-Agent 对话页面，主对话保留工具调用和结果。
