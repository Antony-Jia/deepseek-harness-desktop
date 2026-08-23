# @p-dsh-market/conversation-knowledge-map

DSH 的“知识视图”插件，把同一工作路径下用户明确选择的多个历史对话整理成：

- 有阶段性段落的思维导图；
- 只读、可筛选、可回溯来源的静态知识图谱。

首版通过 `sessionQuery.filterSessions()`、`readTitleSnapshots()` 和 `readSurface()` 读取会话，不扫描 `$DSH_HOME/sessions`。结果保存到当前工作路径的 `.g-dsh-market-knowledge/`，只保存图数据、来源事件序号和生成参数，不复制完整聊天正文。

生成流程必须经过菜单栏配置和应用内确认。Host 会再次校验锚点 Session、`cwd`、选中 Session、revision 和固定保存目录；模型输出先通过图数据 Schema 校验，失败或取消不会替换旧结果。

配置面板会列出运行时可用的 Provider / Model，并默认带入 DSH 默认模型；本次选择会绑定到确认令牌、Agent 调用和 `manifest.json`，不会因为默认模型变化而被静默替换。提交任务后配置对话框立即关闭，失败原因会显示在知识视图页的任务条中。

节点“继续对话”只形成一个可编辑的后续问题。确认导航后，插件使用公开的 Session 导航入口；如果当前 Runtime 没有向该槽位暴露草稿镜像，则提供“打开并复制问题”的安全降级，不自动发送消息。

## 生成失败诊断

Host 和生成编排器会输出带 `[conversation-knowledge-map]` 前缀的诊断日志。日志包含路由、Provider / Model、Agent Session、实时事件类型、surface/session 读取次数、提取文本长度、输出形状和错误原因，不记录 Prompt、对话正文或模型返回正文。优先查看 DSH Web Runtime 的终端日志；若 Runtime 提供 logger 服务，则同时写入该 logger。重点关注 `agent event`、`agent idle`、`agent surface read`、`agent session read` 和 `agent output parse failed`。

## 本地验证

```powershell
node --test tests/conversation-knowledge-map.test.mjs
node --check market/conversation-knowledge-map/lib/index.js
node --check market/conversation-knowledge-map/lib/client.js
```

本地实现未执行 `npm pack`、发布或真实 Profile 安装；真实 DSH Web 视觉回放仍需在插件安装后验证。
