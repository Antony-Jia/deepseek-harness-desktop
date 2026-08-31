# Graph Job 多 Subagent 任务图

`@p-dsh-market/graph-job-orchestrator` 实现评审稿中的阶段 0～4 基础闭环：

- Graph Draft/Revision、Agent Profile snapshot、DAG validator、静态并行预览、受限 Planner patch；
- `%LOCALAPPDATA%/dsh-desktop/plugin-data/graph-job-orchestrator/` 下的原子 JSON 与 append-only JSONL 存储；
- DSH in-process Subagent executor、merge barrier、read 并行/write 串行、失败暂停、有限 transport/rate-limit retry、取消和终止；
- `artifactRefs` workspace-relative 校验、插件 Skill/Graph Job 递归保护、`/graphjob` 命令、Web API、SSE 和任务图编辑面板；
- Codex provider 的能力发现、model/reasoningEffort 快照与 capability mismatch 错误。

运行时必须先安装并注册 Codex Subagent provider，阶段 4 才会显示 Codex executor 可用；没有 provider 时不会伪装成可运行，而是在能力快照和运行错误中明确说明。当前仓库的本地 runtime 只有 DSH `spawn/fork` provider，因此不会在安装插件时自动修改 profile。

需要 Codex 时，在目标 DSH profile 安装官方 provider Bundle 后重启该 profile：

```powershell
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
```

插件只负责发现和校验 provider，不会代替用户安装 Bundle、登录 Codex 或修改 Codex 原生权限配置。

主要端点：

- `GET /graph-job-orchestrator/capabilities`
- `GET/PUT /graph-job-orchestrator/profiles`
- `GET/POST/PATCH /graph-job-orchestrator/graphs`
- `POST /graph-job-orchestrator/graphs/:id/preview|confirm|run`
- `GET /graph-job-orchestrator/graphs/:id/preview/:previewId`
- `GET /graph-job-orchestrator/templates`
- `GET /graph-job-orchestrator/templates/previews/:previewId`
- `POST /graph-job-orchestrator/templates/preview|confirm|bind`
- `GET /graph-job-orchestrator/runs/:runId/events`
- `POST /graph-job-orchestrator/runs/:runId/retry|cancel|terminate`

Planner 只接受当前会话的 roster、Graph JSON Schema 和受限 patch；候选图必须先 preview，再由用户确认。已有手工锁定图时，Planner 请求必须明确 `templateMode: "saveAs"` 或 `"overwrite"`，不会隐式改写当前模板。运行时输出严格投影为 `text` 和 `artifactRefs`，子会话 ID 只保存在运行状态和事件中。

模板 manifest 支持 `scope: "workspace" | "global"`，默认是当前 workspace；workspace 模板不会出现在其他工作区的模板列表中。切换模板会创建新的 Graph Instance，不会把可变模板文件直接绑定为活动 Graph。

验证命令：

```powershell
npm run check:graph-job
npm test
npm run catalog:validate
Push-Location market/graph-job-orchestrator
npm pack --dry-run --json
Pop-Location
```
