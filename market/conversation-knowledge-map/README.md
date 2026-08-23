# @p-dsh-market/conversation-knowledge-map

DSH 的“知识视图”插件，把同一工作路径下用户明确选择的多个历史对话整理成：

- 有阶段性段落的思维导图；
- 只读、可筛选、可回溯来源的静态知识图谱。

首版通过 `sessionQuery.filterSessions()`、`readTitleSnapshots()` 和 `readSurface()` 读取会话，不扫描 `$DSH_HOME/sessions`。结果保存到当前工作路径的 `.g-dsh-market-knowledge/`，只保存图数据、来源事件序号和生成参数，不复制完整聊天正文。

生成流程必须经过菜单栏配置和应用内确认。Host 会再次校验锚点 Session、`cwd`、选中 Session、revision 和固定保存目录；模型输出先通过图数据 Schema 校验，失败或取消不会替换旧结果。

节点“继续对话”只形成一个可编辑的后续问题。确认导航后，插件使用公开的 Session 导航入口；如果当前 Runtime 没有向该槽位暴露草稿镜像，则提供“打开并复制问题”的安全降级，不自动发送消息。

## 本地验证

```powershell
node --test tests/conversation-knowledge-map.test.mjs
node --check market/conversation-knowledge-map/lib/index.js
node --check market/conversation-knowledge-map/lib/client.js
```

本地实现未执行 `npm pack`、发布或真实 Profile 安装；真实 DSH Web 视觉回放仍需在插件安装后验证。
