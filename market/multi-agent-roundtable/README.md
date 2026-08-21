# 多 Agent 圆桌讨论

这是 DSH Desktop 的静态市场插件，实现中央微信式 Multi-Agent 群聊（当前版本 `0.4.1`）：

- 在普通 DSH 对话中注册原生 `multi_agent_discuss` 工具和配套 Skill；用户可直接要求多个角色讨论，工具调用和正式结果会保存在当前对话，完整角色消息保存在插件群聊；
- 从普通对话发起时，各角色通过父会话 Agent Preset 继承同一工作目录、MCP、Skills 及其他工具，同时保持独立 Session 和角色 Prompt，并禁止递归开启圆桌；

- 在 `conversation.view` 增加“多 Agent 讨论”会话标签页；
- 在 DSH 会话顶部 action 和 DSH Desktop 外框标题栏增加 `Multi-Agent` 入口；
- 入口通过受控 `pluginRpc` 打开右侧设置栏；已有会话切换原生 `聊天 / 多 Agent 讨论` 视图，空白会话也会直接打开中央群聊，无需先向普通 Agent 发消息；
- 中央讨论视图采用群聊头像、左右气泡、固定底部输入区和流式输入状态；
- reasoning/thinking 与正式回答分离，思考过程默认折叠；每条消息都可独立展开或收起，超长角色回答默认收起；
- 群聊拥有独立于普通 DSH 对话的持久化 ID；中央标题栏提供历史选择和“新建群聊”，切换普通会话时也能创建或恢复对应群聊；
- 使用插件包内 `presets/default-roles.json` 作为只读默认模板；
- 用户角色、Prompt、Provider、Model 和团队组合保存到 `%LOCALAPPDATA%/dsh-desktop/plugin-data/multi-agent-roundtable/roles.json`；旧 Settings namespace 会在首次启动时迁移并保留兼容投影；
- 群聊索引、讨论元数据和用于重启恢复的消息投影保存到同目录的 `conversations.json`；浏览器 `localStorage` 仅记录最近选择，不再是历史记录权威；旧记录缺少消息投影时会从持久化子 Session 补录；
- 每个参与角色通过 `agents.create()` 创建独立的子 Session，并在 `setup()` 中安装 `deployment:persona`；角色未单独配置模型时从 `agentDefaultModel.currentSelection()` 继承 DSH 当前默认模型；
- 子 Session 的 LLM `turn/end` 错误会显示为角色失败和整场失败，不会再把零输出误报为完成；
- 通过 `session/event` 监听 `assistant/chunk` 与 `assistant/message`，使用 SSE 把 Markdown 消息投影到浏览器；
- 颜色全部绑定 DSH Web 的 `--dsw-*` 语义 token，自动跟随系统明暗模式和当前安装的主题包；
- 支持独立评估、交叉评审、主持人总结、并发上限、单角色取消和整场取消。

当前 `0.1.0-rc.7` 没有向第三方插件开放自定义 Session Event 注册面，因此角色子 Session 仍是完整日志真源；插件同时把有界的消息展示投影写入 `conversations.json`，保证重启后无需先恢复在线 Agent 也能显示历史。旧版记录没有消息投影时，宿主会通过 `sessionQuery` 从持久化子 Session 补录；兼容 Settings 投影仍只保存索引元数据，不会把消息正文写入 `settings.yaml`。

本地验证：

```powershell
Push-Location market/multi-agent-roundtable
npm pack --dry-run
Pop-Location
```

该包已经加入仓库的 `market/catalog-v1.json`。发布 `@p-dsh-market/multi-agent-roundtable@0.4.1` 后，市场校验和远程安装即可生效。安装到本机 `web` profile 后，需要把 `cordis.patch.yml` 中的 entry 挂载到该 profile，并重启 DSH。

`标准模式`、`创造模式`属于 DSH 官方 Agent Preset roster；当前 `rc.7` 没有第三方静态插件追加 preset 的公开扩展点，因此本插件不改写该核心选择器，而是使用官方会话 action、`conversation.view` 和自身顶部模式栏提供圆桌体验。
