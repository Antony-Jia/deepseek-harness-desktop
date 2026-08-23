# @p-dsh-market/conversation-knowledge-map

DSH 的“知识视图”插件，把同一工作路径下用户明确选择的多个历史对话整理成：

- 有阶段性段落的思维导图；
- 只读、可筛选、可回溯来源的静态知识图谱。

首版通过 `sessionQuery.filterSessions()`、`readTitleSnapshots()` 和 `readSurface()` 读取会话，不扫描 `$DSH_HOME/sessions`。结果保存到当前工作路径的 `.g-dsh-market-knowledge/`，只保存图数据、来源事件序号和生成参数，不复制完整聊天正文。

生成流程必须经过菜单栏配置和应用内确认。Host 会再次校验锚点 Session、`cwd`、选中 Session、revision 和固定保存目录；模型输出先通过图数据 Schema 校验，失败或取消不会替换旧结果。

配置面板会列出运行时可用的 Provider / Model，并默认带入 DSH 默认模型；本次选择会绑定到确认令牌、Agent 调用和 `manifest.json`，不会因为默认模型变化而被静默替换。提交任务后配置对话框立即关闭，失败原因会显示在知识视图页的任务条中。

摘要阶段按对话并行处理，并发上限固定为 3；每个对话按约 5000 字、优先在完整段落边界分段，只有单段本身超长时才按句末或硬边界拆分。同一对话的分段保持顺序处理，随后先合并为一份对话摘要，再统一生成思维导图或知识图谱。结构化输出失败时会完全重置并最多重试 3 次；单个对话连续失败后只跳过该对话，不阻断其他对话和最终报告。“同时生成”模式下，一个最终视图失败也不会阻断另一个视图保存。进度区域和最终知识视图都会按时间线显示读取、摘要、具体失败原因、重试、跳过、合并、生成及保存过程。模型可以保留 thinking，但结果提取只读取最终文本并过滤 reasoning 内容；摘要和最终视图分别预留 12000 与 24000 个输出 Token。知识图谱最多生成 20 个实体、30 条关系。最终模型若返回未选择的 Session 引用，会过滤该引用；严格模式下无有效来源的内容项会被跳过，最终页面列出实际总结的对话、失败对话和过滤数量。

生成过程时间线支持折叠和展开：进行中的任务默认展开，已完成结果中的历史时间线默认折叠。思维导图使用递归树形布局并绘制父子连接线。知识图谱按关联度使用中心节点与内外双环布局，节点卡片内显示类型和最多两行名称，关系以带方向箭头的弱化曲线呈现，并通过描边区分推测或冲突内容；画布提供 50%–200% 缩放和一键恢复 100%，缩放不会影响实体筛选、点击和详情查看，也不会产生横向滚动条。

节点“继续对话”只形成一个可编辑的后续问题。确认导航后，插件使用公开的 Session 导航入口；如果当前 Runtime 没有向该槽位暴露草稿镜像，则提供“打开并复制问题”的安全降级，不自动发送消息。

## 生成失败诊断

Host 和生成编排器会输出带 `[conversation-knowledge-map]` 前缀的诊断日志。日志包含路由、Provider / Model、Agent Session、实时事件类型、surface/session 读取次数、提取文本长度、输出形状和错误原因，不记录 Prompt、对话正文或模型返回正文。优先查看 DSH Web Runtime 的终端日志；若 Runtime 提供 logger 服务，则同时写入该 logger。重点关注 `agent event`、`agent idle`、`agent turn failure`、`agent surface read`、`agent session read` 和 `agent output parse failed`。Runtime 在 `turn/end.reason.kind = error` 时会优先显示其 `code/message`；只有未发现 turn 错误且确实没有助手输出时，才会报告“模型没有返回 JSON 对象”。

## 本地验证

```powershell
node --test tests/conversation-knowledge-map.test.mjs
node --check market/conversation-knowledge-map/lib/index.js
node --check market/conversation-knowledge-map/lib/client.js
```

仓库测试通过后可同步到 DSH Web Profile；真实 DSH Web 视觉回放仍需重启 Runtime 后验证。
