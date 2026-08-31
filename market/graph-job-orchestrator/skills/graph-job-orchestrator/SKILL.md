---
name: graph-job-orchestrator
description: 规划和运行经过用户确认的 Graph Job 多 Subagent 任务图。
---

# Graph Job 任务图

当用户明确要求把一个复杂目标拆成多个可以并行或串行执行的 Subagent 节点时，先使用 `graphjob_plan` 提出任务图草案。Planner 只能使用当前能力快照中列出的 Agent Profile、工具和非插件 Skill。

Graph Job 的节点执行遵守以下协议：

- task 和 merge 是 v1 支持的两种节点；所有前置节点完成后，后继节点才可运行。
- `read` 节点可以受限并行；`write` 节点保持串行，避免共享工作区互相覆盖。
- 节点最终只返回 `{"text":"...","artifactRefs":[{"path":"workspace-relative/path","type":"file","summary":"..."}]}`。
- 不要把 reasoning、thinking、stderr、原始工具协议放入节点结果；artifactRefs 不能离开当前 session cwd。
- 任何 Graph Job 都必须先在任务图界面查看 DAG 预览并由用户确认，不能由模型直接启动或绕过确认。
- 节点失败会暂停整个 Graph；只允许用户 retry 失败节点及其后继，或 terminate 整个 Graph，不允许静默 skip。

插件 Skills（包括本 Skill）不会向 Graph Job 子 Agent 暴露。不要在节点中递归调用 `graphjob_plan`、运行 Graph Job 或修改 Graph revision。

