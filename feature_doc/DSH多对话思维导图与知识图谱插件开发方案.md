# DSH 多对话思维导图与知识图谱插件开发方案

> 文档状态：开发设计稿  
> 编写日期：2026-08-23  
> 目标运行时：`@deepseek-ai/dsh 0.1.1-rc.2` 及其 Web Profile  
> 推荐包名：`@p-dsh-market/conversation-knowledge-map`  
> 工作区数据目录：`<workspace>/.g-dsh-market-knowledge/`

## 1. 结论与产品定位

该功能适合作为一个独立 DSH Plugin 实现，不并入 `multi-agent-roundtable`。两者可以复用页面接入、Host/Client 分层、模型任务状态和主题样式经验，但产品目标不同：

- Multi-Agent Roundtable 面向一次讨论中的多角色协作；
- 本插件面向同一工作路径下多个历史对话的整理、关联、回顾与继续探索。

插件增加一个完整页面，页面包含两种只在已有明确对话和工作路径时可用的模式：

1. **思维导图模式**：把多段对话整理为有层级的阶段性认知。节点不是只有几个关键词，而是由标题和一段完整说明组成。点击节点后，不在图上直接无限添加子节点；插件基于该节点和目标对话生成一个后续问题，用户确认后返回原对话继续交流。
2. **知识图谱模式**：抽取实体、概念、模块、决策和关系，提供静态浏览、搜索、筛选和来源回溯。知识图谱不支持节点编辑、节点发散或后台自动更新，只能由用户显式执行完整重新生成。

插件遵循以下原则：

- 不点击生成，不读取所选对话正文、不调用模型、不创建图数据；
- 已经生成并保存的结果允许在再次进入页面时直接加载，这不属于自动生成；
- 多对话选择和生成配置必须从菜单栏入口打开；
- 支持严格约束模式；任何实际读取、模型调用和工作区写入都必须经过确认；
- DeepSeek Harness 工作区首页没有明确选中的对话时，不显示对话选择器和 Prompt；
- 一个工作路径只维护一套当前思维导图和一套当前知识图谱。

## 2. 首版范围

### 2.1 首版必须实现

- 菜单栏入口“知识视图”；
- 与原生聊天并列的完整插件页面；
- 页面内“思维导图 / 知识图谱”切换；
- 按当前对话 `cwd` 列出同工作路径下的多个对话；
- 对话多选、额外 Prompt 和严格约束模式；
- 生成前确认；
- 手动生成思维导图、知识图谱或同时生成；
- 思维导图节点段落化展示；
- 点击思维导图节点后生成建议问题；
- 用户确认目标对话和建议问题后，返回该对话并把问题放入输入框；
- 知识图谱静态展示和来源回溯；
- 在 `.g-dsh-market-knowledge` 中原子保存结果；
- 失败、取消、超限和旧数据兼容提示。

### 2.2 首版明确不实现

- 自动监听聊天变化并重新生成；
- 在后台周期性分析对话；
- 知识图谱手工增删节点或关系；
- 点击知识图谱节点继续对话；
- 自动发送思维导图生成的问题；
- 多人实时协作编辑；
- 跨工作路径合并图谱；
- 直接扫描或修改 `$DSH_HOME/sessions/*.jsonl`；
- 把完整聊天正文复制到工作区数据目录。

## 3. 核心交互

### 3.1 入口与页面

插件在 DSH Desktop 菜单栏/标题栏贡献一个受控入口：

```text
知识视图
```

入口使用 `desktop.titlebar.workspaceActions` 和受控 `pluginRpc`，整体交互与 `multi-agent-roundtable` 一致。推荐方法名：

```text
conversationKnowledgeMap.open
```

进入已有对话后，中央会话区域可以出现新的完整视图：

```text
聊天 | 思维与知识
```

插件视图内部再切换：

```text
思维导图 | 知识图谱
```

`conversation.view` 只负责展示图和当前状态。对话选择、Prompt、严格约束和生成操作由菜单栏打开的设置面板承载，避免永久占用图画布。

### 3.2 工作区首页状态

“工作区首页”指当前没有明确对话 `sessionId` 的空白状态。即使 Desktop 已记住某个最近工作路径，也不能仅凭最近路径展示生成配置。

页面必须按以下条件判断是否可用：

```text
存在当前 sessionId
AND 能通过正式会话服务读取该 Session
AND Session Header 中存在有效 cwd
```

任意条件不满足时：

- 不显示“选择对话”；
- 不显示额外 Prompt；
- 不显示严格约束配置；
- 不显示生成按钮；
- 不读取历史会话列表；
- 不调用任何模型接口；
- 不推断 `lastWorkspace` 为当前工作路径。

只显示轻量空状态：

```text
请先打开一个已有对话。确定对话及其工作路径后，才能选择同工作路径下的历史对话并生成思维导图或知识图谱。
```

如果工作路径内已有 `.g-dsh-market-knowledge`，也必须先确认当前对话的 `cwd` 后才能加载，不能在首页按最近工作路径猜测并读取。

### 3.3 菜单栏选择多对话

用户在明确对话中点击菜单栏“知识视图”后，打开配置面板：

```text
当前工作路径：D:\Code\deepseek-harness

参与生成的对话
[✓] 当前对话：插件可行性讨论
[ ] 会话读取接口调查
[✓] DSH Plugin Contract 讨论

生成内容
[✓] 思维导图  [✓] 知识图谱

额外要求
[请输入形成思维导图或知识图谱时需要遵守的 Prompt……]

[✓] 严格约束模式

[取消] [下一步：确认]
```

选择列表规则：

- 只列出规范化后 `header.cwd` 与当前对话工作路径完全相同的 Session；
- 默认只列顶层普通会话；
- 默认排除 `header.origin === 'subagent'`；
- 当前对话默认勾选，但用户可以取消；
- 至少选择一个对话才能进入确认步骤；
- 展示标题、更新时间、会话 ID 缩写和来源类型；
- 可提供“包含子 Agent 对话”的高级开关，但默认关闭；
- 不允许手工输入其他工作路径或任意 Session ID。

## 4. 严格约束模式与确认

### 4.1 严格约束的含义

严格约束模式不是一个模糊的 Prompt 前缀，而是 Host 端必须执行的行为边界：

- 只读取用户刚刚勾选且属于当前 `cwd` 的会话；
- 只使用会话当前有效表面，不默认包含 reasoning、流式 chunk 或无关工具日志；
- 禁止模型调用外部网络和与生成无关的工具；
- 所有知识图谱关系必须带来源引用；
- 无直接依据的内容不能写成事实，应标记为“推测”或拒绝生成；
- 不跨工作路径读取或合并内容；
- 不保存完整聊天正文；
- 不自动发送后续问题；
- 不自动重新生成或覆盖已有结果；
- 工作区写入目标固定为当前路径下的 `.g-dsh-market-knowledge`。

严格约束应同时通过以下三层实现：

1. UI 明示当前约束和将发生的操作；
2. Host 校验 Session、`cwd`、路径和请求 revision；
3. 生成 Agent 使用限制后的工具集合和结构化输出 Schema。

不能仅依靠“请严格遵守”这类自然语言 Prompt 实现安全边界。

### 4.2 生成前确认

菜单栏面板点击“下一步：确认”后，必须出现居中的应用内确认框。确认框至少展示：

- 当前工作路径；
- 已选择对话数量和标题；
- 将生成思维导图、知识图谱或两者；
- 是否启用严格约束；
- 将调用的模型；
- 是否会覆盖已有结果；
- 数据保存目录；
- 说明不会自动发送消息。

示例：

```text
确认生成知识视图？

工作路径：D:\Code\deepseek-harness
来源：3 个已选择对话
生成：思维导图 + 知识图谱
约束：严格约束已开启
保存：.g-dsh-market-knowledge
影响：将调用大模型，并替换该工作路径当前保存的对应图数据

[返回修改] [确认并生成]
```

只有用户点击“确认并生成”后，Host 才能：

1. 再次验证当前 Session 和 `cwd`；
2. 再次验证所有已选 Session 仍属于该 `cwd`；
3. 读取对话内容；
4. 调用大模型；
5. 写入工作区文件。

确认信息发生变化、Session 被删除、工作路径变化或 revision 过期时，原确认失效，必须返回配置面板重新确认。

### 4.3 节点继续对话前的第二次确认

点击思维导图节点不会直接跳转或自动发送，而是进入“形成后续问题”流程：

1. 用户点击节点；
2. 插件显示该节点的阶段性说明和来源对话；
3. 用户点击“基于此节点继续对话”；
4. 模型结合节点内容、来源证据和目标对话最近上下文形成一个后续问题；
5. 插件展示可编辑的问题和目标对话；
6. 用户确认后才跳转目标对话，并把问题放入输入框草稿；
7. 用户仍需使用原生发送按钮真正发送。

如果节点引用多个来源对话，确认框必须让用户选择目标对话。默认目标按以下顺序确定：

1. 节点的 `primarySourceSessionId`；
2. 打开插件时的锚点对话；
3. 第一个仍可读取的来源对话。

不能在没有明确目标 Session 的情况下创建新会话代替原对话。

## 5. 思维导图设计

### 5.1 节点不是简单关键词

思维导图节点至少包含：

- 短标题：用于画布快速定位；
- 阶段性说明：一段可以独立理解的完整文字；
- 节点类型：主题、阶段、问题、决策、方案、风险或结论；
- 来源引用：对应 Session 和事件序号；
- 主要来源对话；
- 可选的未决问题。

推荐约束：

- `title` 建议 6～30 个中文字符；
- `narrative` 建议 80～300 个中文字符；
- 不能只返回“架构设计”“性能优化”一类短标签；
- 一段说明应包含背景、当前认识以及仍需推进的方向；
- 画布缩放较小时只显示标题和摘要，选中节点后在侧栏完整显示段落。

示例节点：

```json
{
  "id": "mind-stage-session-access",
  "parentId": "mind-root",
  "type": "stage",
  "title": "多对话读取边界已经确认",
  "narrative": "当前运行时可以通过 sessionQuery 按工作路径列出会话，并读取每个会话的有效展示表面。因此插件不需要扫描底层 JSONL 文件。下一阶段需要重点处理超长对话分段、子 Agent 会话过滤以及来源引用的稳定性。",
  "primarySourceSessionId": "session-...",
  "sourceRefs": [
    { "sessionId": "session-...", "eventSeqs": [18, 23] }
  ],
  "openQuestions": [
    "多长的对话应该进入分段摘要流程？"
  ]
}
```

### 5.2 节点点击与继续对话

原需求中的“持续发散”定义为继续原对话，而不是直接修改脑图拓扑：

```text
选中节点
  → 阅读阶段性说明
  → 请求模型形成一个推进问题
  → 用户编辑并确认
  → 返回指定来源对话
  → 问题进入输入框草稿
  → 用户手动发送并继续讨论
```

形成问题的 Prompt 应要求：

- 不复述整个节点；
- 针对节点中的未决点提出一个清晰问题；
- 能自然衔接目标对话最近上下文；
- 优先推动决策、验证或下一步行动；
- 默认生成一个主问题，可额外给出不超过两个备选问题；
- 不自行回答问题；
- 不携带其他未选择会话的敏感原文。

建议问题响应结构：

```json
{
  "targetSessionId": "session-...",
  "question": "既然多对话读取接口已经确定，第一版应采用怎样的分段和合并阈值，才能在保留来源引用的同时控制上下文成本？",
  "alternatives": [],
  "reason": "该问题直接推进节点中尚未确定的长对话处理策略。"
}
```

节点点击本身不改变保存的思维导图。可以在 `navigationHistory` 中记录用户已确认的跳转，但不得把“点击过”误认为知识结论已经更新。

### 5.3 思维导图层级

首版建议 3～5 层：

```text
工作路径主题
├─ 目标与背景
├─ 已形成的阶段性认识
│  ├─ 决策
│  ├─ 方案
│  └─ 风险
├─ 当前进行中的方向
└─ 未决问题与下一步
```

首轮默认上限建议为 80 个节点。超过上限时优先合并重复节点，不通过缩短每个节点为关键词来容纳更多节点。

## 6. 知识图谱设计

知识图谱从同一批确认过的对话中抽取：

- 实体：模块、服务、文件、接口、概念、人员角色、决策、风险和外部系统；
- 关系：依赖、调用、产生、替代、约束、支持、反对、属于和来源于；
- 证据：`sessionId + eventSeq`，以及不包含大段原文的短摘要；
- 置信度：`confirmed`、`inferred` 或 `conflicted`。

知识图谱允许：

- 缩放、平移和重新布局；
- 按类型和置信度筛选；
- 搜索实体；
- 点击查看属性、关系和来源；
- 跳转到来源对话进行人工核对。

知识图谱不允许：

- 在画布中增加、删除或改写实体；
- 从节点继续发散；
- 因对话发生变化而自动增量更新；
- 在没有用户确认的情况下覆盖旧图谱。

这里的“静态”是指生成后的知识内容不自动变化。用户可以从菜单栏显式选择“完整重新生成”，确认后整体替换当前知识图谱。

推荐规模上限：150 个实体、300 条关系。超过上限时应聚类或要求用户缩小对话范围。

## 7. 多对话读取

### 7.1 正式数据来源

Host 半通过 `ctx.sessionQuery` 读取会话：

- `filterSessions([{ kind: 'cwd', values: [cwd] }])`：列出同工作路径会话；
- `readTitleSnapshots(sessionIds)`：批量取得标题；
- `readSurface(sessionId)`：取得适合模型处理的当前有效对话表面；
- `readSession(sessionId)`：只在显式选择完整原始日志模式时使用。

不得直接遍历 `$DSH_HOME/sessions`。当前运行时的 `SessionHeader` 已包含 `id`、`createdAt`、`cwd`、`parentSession` 和 `origin`，足以完成选择、过滤和来源追踪。

### 7.2 路径比较

Windows 工作路径必须：

- 转为绝对路径；
- 统一目录分隔符；
- 去除无意义的尾部分隔符；
- 使用适合 Windows 的大小写不敏感比较；
- 条件允许时 canonicalize，防止符号链接绕过；
- 不以字符串前缀判断父子路径关系。

Host 必须以当前锚点 Session 的 `header.cwd` 为权威，不能信任浏览器直接提交的 `workspacePath`。

### 7.3 超长对话处理

多个完整对话不能简单拼接到一个 Prompt。推荐管线：

```text
确认后的 Session 列表
  → 分别读取有效 Surface
  → 每个会话按 Token 预算分段
  → 生成带来源引用的会话摘要
  → 跨会话去重与冲突识别
  → 分别生成思维导图和知识图谱 JSON
  → Schema 校验
  → 原子保存
```

每个中间摘要都必须携带来源 Session 和事件序号，最终节点不能只引用临时摘要 ID。

## 8. 模型调用与结构化输出

推荐复用 Roundtable 已验证的 `agents.create()` 路径创建受限生成 Agent，并继承当前可用模型选择。生成 Agent 不应继承与任务无关的工具；严格模式下应显式 deny 网络、文件写入和再次启动圆桌等能力。

模型输出必须先经过结构化 Schema 校验，不能把未经验证的 Mermaid 或自由文本直接作为持久化权威。

生成任务状态至少包括：

```text
created
confirming
reading-sources
summarizing
building-mind-map
building-knowledge-graph
validating
saving
completed
failed
cancelled
```

Client 通过 Host HTTP/JSON 和 SSE 获取进度。运行期间锁定同一工作路径的生成、重新生成和节点问题形成操作，取消后不得写入半成品。

## 9. 工作区持久化

### 9.1 目录结构

建议把 `.g-dsh-market-knowledge` 定义为目录：

```text
<workspace>/.g-dsh-market-knowledge/
├─ manifest.json
├─ mind-map.json
├─ knowledge-graph.json
└─ navigation-history.json
```

文件职责：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | Schema、revision、工作路径指纹、来源 Session、Prompt 摘要、模型和生成时间 |
| `mind-map.json` | 当前思维导图节点、边和来源引用 |
| `knowledge-graph.json` | 当前静态实体、关系、证据和置信度 |
| `navigation-history.json` | 已确认的节点到对话跳转记录，不保存完整聊天正文 |

### 9.2 一个工作路径一套数据

一个工作路径只有一套当前数据：

- 重新生成思维导图只替换 `mind-map.json`；
- 重新生成知识图谱只替换 `knowledge-graph.json`；
- 同时生成时使用同一来源快照和 generation ID；
- 对话选择或 Prompt 变化不会自动触发生成；
- 页面显示“配置已变化，当前结果尚未重新生成”；
- 覆盖前必须确认。

### 9.3 安全写入

插件 Manifest 应声明：

```json
{
  "permissions": [
    "shell:titlebar",
    "shell:page",
    "workspace:read",
    "workspace:write-plugin-data"
  ]
}
```

Host 写入时必须：

- 重新从锚点 Session 解析权威 `cwd`；
- 验证目标目录恰好是 `<cwd>/.g-dsh-market-knowledge`；
- 临时文件写完并校验后再原子重命名；
- 使用 `revision` 防止多个窗口覆盖；
- 保存失败时保留旧文件；
- 不把临时文件、模型流式半成品或完整聊天正文留在工作区；
- 通过 `schemaVersion` 支持后续迁移。

当前 Desktop 已识别 `workspace:write-plugin-data` 权限，但实施前仍需确认运行时是否已有正式工作区写入 Broker。如果没有，首版可由 Host Node 端在上述严格校验后直接写入；公开市场版本建议补充由 Desktop 执行权限检查和路径约束的受控写入接口。

## 10. 推荐工程结构

```text
conversation-knowledge-map/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ lib/
│  ├─ index.js
│  ├─ client.js
│  ├─ session-source.js
│  ├─ generation-orchestrator.js
│  ├─ mind-map-schema.js
│  ├─ knowledge-graph-schema.js
│  ├─ workspace-storage.js
│  └─ protocol.js
└─ skills/
   └─ conversation-knowledge-map/
      └─ SKILL.md
```

Host 注入建议：

```yaml
- insert:
    - id: p-dsh-market-conversation-knowledge-map
      name: '@p-dsh-market/conversation-knowledge-map'
      inject: [agentDefaultModel, agents, sessionQuery, sessions, skills, webServer]
```

最终注入项必须以实施时 `cordis_inspect` 返回的实际服务契约为准。

## 11. Host API 草案

```text
GET  /conversation-knowledge-map/context?sessionId=...
GET  /conversation-knowledge-map/sessions?anchorSessionId=...
GET  /conversation-knowledge-map/state?anchorSessionId=...
POST /conversation-knowledge-map/confirm
POST /conversation-knowledge-map/generations
GET  /conversation-knowledge-map/generations/:id
GET  /conversation-knowledge-map/generations/:id/events
POST /conversation-knowledge-map/generations/:id/cancel
POST /conversation-knowledge-map/mind-map/follow-up-question
POST /conversation-knowledge-map/navigation/confirm
```

`confirm` 返回一次性、短时有效的确认令牌。`generations` 必须携带该令牌，Host 校验来源 Session、`cwd`、选项摘要和 revision 完全一致后才执行。

确认令牌不能替代服务端校验，也不能授权任意路径访问。

## 12. 页面状态机

```text
no-session
  → 仅显示“请先打开已有对话”

session-without-cwd
  → 仅显示“当前对话没有可用工作路径”

ready-empty
  → 可从菜单栏打开配置；画布显示尚未生成

ready-loaded
  → 自动加载该 cwd 已保存结果；不自动重新生成

configuring
  → 菜单栏面板选择对话、模式、Prompt 和严格约束

awaiting-confirmation
  → 居中确认框

generating
  → 显示分阶段进度并锁定冲突操作

viewing
  → 思维导图或知识图谱浏览

forming-question
  → 为选中思维导图节点形成问题

awaiting-navigation-confirmation
  → 编辑问题、选择目标对话并确认

navigating
  → 返回目标对话并写入输入框草稿
```

Session 切换时，Client 必须取消旧请求，按新 Session 重新解析 `cwd`。新旧 `cwd` 相同时可复用已加载数据，不同时必须卸载旧图，禁止短暂显示上一工作路径的内容。

## 13. 实施阶段

### 阶段一：契约验证与骨架

- 使用 `cordis_inspect` 确认 `conversation.view`、菜单栏入口、`sessions`、`sessionQuery`、`agents` 和 `webServer`；
- 确认从插件返回指定 Session 并设置输入框草稿的正式 Client API；
- 确认工作区写入 Broker 是否存在；
- 建立 Host/Client、健康检查、空状态和菜单栏入口。

### 阶段二：上下文门禁和多会话选择

- 实现 `sessionId + header.cwd` 双重门禁；
- 实现同 `cwd` Session 列表、标题加载和子 Agent 过滤；
- 实现首页隐藏逻辑；
- 实现配置面板、严格约束和确认令牌。

### 阶段三：结构化生成与保存

- 实现分段摘要、去重和来源引用；
- 实现思维导图和知识图谱 Schema；
- 实现生成状态、SSE、取消和错误恢复；
- 实现 `.g-dsh-market-knowledge` 原子保存和 revision。

### 阶段四：图形页面

- 实现思维导图段落节点、布局、缩放和详情侧栏；
- 实现知识图谱静态布局、过滤、搜索和证据面板；
- 使用 DSH `--dsw-*` 语义 Token 适配明暗主题；
- 图形依赖必须随插件打包，不使用公网 CDN。

### 阶段五：节点返回对话

- 实现节点来源解析和目标对话选择；
- 实现受限模型生成后续问题；
- 实现问题编辑和第二次确认；
- 实现返回指定 Session 并注入输入框草稿；
- 确认绝不自动发送。

## 14. 验收标准

### 14.1 首页与上下文

- 没有当前 Session 时，页面不出现对话选择器、Prompt、严格约束和生成按钮；
- 只有最近工作路径、没有明确对话时，不读取该路径数据；
- 当前 Session 没有 `cwd` 时不进入可生成状态；
- Session 切换到不同 `cwd` 后不残留上一工作路径的图。

### 14.2 多对话与确认

- 菜单栏可以打开同工作路径对话选择面板；
- 不出现其他工作路径的 Session；
- 子 Agent Session 默认被排除；
- 未点击最终确认时不读取正文、不调用模型、不写文件；
- 确认内容变化后旧确认令牌失效；
- 严格约束模式在 Host 端真实生效。

### 14.3 思维导图

- 节点同时具有标题和完整阶段性段落；
- 不以大量简短关键词代替阶段性说明；
- 点击节点可以形成与节点及目标对话相关的问题；
- 多来源节点允许用户选择目标对话；
- 确认后返回原对话，问题进入草稿但不会自动发送；
- 节点点击不会擅自改写脑图结论。

### 14.4 知识图谱

- 实体和关系可浏览、筛选、搜索和查看来源；
- 严格模式下每条事实关系都有来源；
- 图谱不能在画布中编辑或发散；
- 对话更新不会让图谱自动变化；
- 只有完整重新生成并确认后才替换旧图谱。

### 14.5 持久化

- 每个工作路径只有一套当前思维导图和知识图谱；
- 结果保存在准确的 `.g-dsh-market-knowledge` 目录；
- 不保存完整聊天正文；
- 中途取消和模型失败不会覆盖旧结果；
- 两个窗口并发写入时 revision 冲突可见且不会静默覆盖；
- 插件重启后能在明确 Session 和 `cwd` 的前提下恢复已有结果。

## 15. 风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 多个长对话超过上下文 | 生成失败或成本过高 | 分段摘要、分级合并、Token 预算和来源引用 |
| 模型虚构关系 | 图谱失真 | 严格模式、证据必填、置信度和 Schema 校验 |
| 多来源节点不知道返回哪个对话 | 继续对话位置错误 | 保存主要来源，并在跳转确认中允许选择 |
| 自动发送问题造成意外操作 | 用户失去控制 | 只写入草稿，最终由用户点击原生发送 |
| 首页错误使用最近工作路径 | 读取错误项目数据 | 必须存在明确 Session 并从 Header 取得 `cwd` |
| 路径穿越或跨工作区写入 | 数据安全问题 | Host 权威路径、canonicalize、固定目录和权限校验 |
| 并发覆盖 | 图数据丢失 | revision、工作区级锁和原子替换 |
| 图节点过多 | 页面不可读 | 节点上限、聚类、过滤和缩放时摘要展示 |
| 浏览器图形依赖加载失败 | 页面不可用 | 随插件打包或使用受控 SVG，不使用 CDN |

## 16. 实施前必须确认的宿主契约

以下三项不应在编码时猜测：

1. 当前 `0.1.1-rc.2` 中菜单栏受控 `pluginRpc` 与 `conversation.view` 的实时 Props；
2. 从插件切换到指定 Session 并向原生输入框写入草稿的公开 Client API；
3. `workspace:write-plugin-data` 是否已经对应正式写入 Broker，还是首版需要 Host 端受限写入。

如果第 2 项没有公开能力，可以先实现“复制建议问题 + 打开目标对话”，但这属于降级路径，不能用 DOM 查询和模拟点击绕过宿主契约。

## 17. 最终推荐方案

首版采用以下闭环：

```text
明确打开一个已有对话
  → 菜单栏打开知识视图配置
  → 只列出同 cwd 的多个对话
  → 选择生成类型、Prompt 和严格约束
  → 应用内确认
  → 读取有效会话表面并分段摘要
  → 生成结构化思维导图/知识图谱
  → 校验并原子保存到 .g-dsh-market-knowledge
  → 在独立 conversation.view 中展示
  → 点击思维导图节点
  → 模型形成后续问题
  → 用户确认目标对话和问题
  → 返回原对话并写入草稿
  → 用户手动发送继续交流
```

该方案保留了用户要求的多对话聚合、手动生成、严格确认、段落化思维节点、静态知识图谱和工作区级持久化，同时把“思维导图发散”落实为可控地返回真实对话继续推进，避免生成一个脱离原始聊天历史、不断自我膨胀的平行知识系统。
