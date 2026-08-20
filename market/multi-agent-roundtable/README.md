# 多 Agent 圆桌讨论

这是 DSH Desktop 的静态市场插件示例，实现方案中的第一版圆桌讨论能力：

- 在 `conversation.view` 增加“多 Agent 讨论”会话标签页；
- 使用插件包内 `presets/default-roles.json` 作为只读默认模板；
- 用户角色、Prompt、团队组合存入 `multi-agent-roundtable` Settings namespace；
- 每个参与角色通过 `agents.create()` 创建独立的子 Session，并在 `setup()` 中安装 `deployment:persona`；
- 通过 `session/event` 监听 `assistant/chunk` 与 `assistant/message`，使用 SSE 把 Markdown 消息投影到浏览器；
- 支持独立评估、交叉评审、主持人总结、并发上限、单角色取消和整场取消。

当前 `0.1.0-rc.7` 没有向第三方插件开放自定义 Session Event 注册面，因此讨论映射只保存为插件 Settings 中的元数据，完整消息仍以角色子 Session 为真源。宿主启动时会从可用的子 Session 事件日志重建消息投影；不会把完整聊天内容写入 `settings.yaml`。

本地验证：

```powershell
Push-Location market/multi-agent-roundtable
npm pack --dry-run
Pop-Location
```

该包已经加入仓库的 `market/catalog-v1.json`，但 npm 包尚未上传；上传 `@p-dsh-market/multi-agent-roundtable` 后，市场校验和远程安装即可生效。安装到本机 `web` profile 后，需要把 `cordis.patch.yml` 中的 entry 挂载到该 profile，并重启 DSH。
