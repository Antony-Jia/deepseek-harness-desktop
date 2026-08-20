我会按三条线调查：前端顶部设定栏能挂在哪个官方槽位、角色配置如何存储在插件自身范围、宿主端如何调度指定角色参与讨论。最后给出可直接实施的分阶段方案，并标明哪些能力已确认、哪些必须运行时探测。

UI 和存储边界已经基本确认。一个重要结论是：**默认角色模板可以随 npm 插件包发布，但用户修改后的 Prompt 不能写回 `node_modules` 插件目录**；插件包应视为只读，动态内容必须进入插件专属数据区。接下来我确认本机 DSH 运行时是否能提供更精确的 `agents` 调用契约。

调查后结论：**可实施，而且当前 DSH `0.1.0-rc.7` 已经提供了比 `shell.overlay` 更合适的实现路径——注册一个新的 `conversation.view` 会话标签页。**

这样不用覆盖原生聊天页面，而是在同一会话中增加：

```text
聊天 | 多 Agent 讨论
```

“多 Agent 讨论”页面内部可以完整实现顶部设定栏、微信式消息区和独立输入框。

---

# 一、推荐界面结构

```text
┌─────────────────────────────────────────────────────────┐
│ 聊天 | 多 Agent 讨论                                    │
├─────────────────────────────────────────────────────────┤
│ 讨论模式：两轮评审 ▼                                    │
│                                                         │
│ 参与角色：                                              │
│ [✓ 产品经理] [✓ 架构师] [✓ 市场分析师] [ 风险评审]     │
│                                                         │
│ [管理角色] [保存组合]             [停止讨论] [开始讨论] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [产品经理]                                             │
│  建议 MVP 优先解决以下问题……                            │
│                                                         │
│                              [架构师]                    │
│                      ## 技术方案                         │
│                      | 模块 | 技术 |                     │
│                      |---|---|                           │
│                      | 前端 | React |                    │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ @所有人 请输入讨论主题……                         发送   │
└─────────────────────────────────────────────────────────┘
```

顶部设定栏采用 `sticky`：

- 页面滚动时始终固定在顶部
- 角色用复选 Chip 展示
- 只有被勾选的角色参与下一轮讨论
- “管理角色”打开角色编辑抽屉
- 支持保存常用团队组合
- 显示当前轮次、运行状态和停止按钮

---

# 二、UI 接入路径

## 1. 使用 `conversation.view`

这是当前最适合的扩展点。

运行时定义表明：

- `conversation.view` 是 `list` 类型
- 一个注册项对应一个会话视图标签
- 与内置“聊天”视图并列
- 自动获得当前 `sessionId` 和会话 Snapshot
- 不会破坏原生聊天页面

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\slots.d.ts" lines="71-82" />

文档明确建议：需要新增完整视图时使用 `conversation.view`，不要替换整个 `conversation.session`：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\slots.d.ts" lines="23-35" />

预计注册形式：

```javascript
ctx.slots.inject('conversation.view', function () {
  return ctx.slots.register(
    {
      name: 'conversation.view',
      id: 'multi-agent-roundtable',
      order: 30,
      label: '多 Agent 讨论'
    },
    function (props) {
      return React.createElement(RoundtableView, props)
    }
  )
})
```

实施前还需要在运行中的 DSH 执行：

```text
cordis_inspect_query
```

查询 `conversation.view` 的实时完整契约，确认当前版本的注册选项和标准 Props。官方要求不能只根据服务名猜测接口：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh\config\agent-presets\cordis\skills\cordis-plugin-development\SKILL.md" lines="230-265" />

## 2. 可选的会话头部入口

还可以注册：

```text
conversation.session.header.actions
```

增加一个“圆桌讨论”按钮，用来切换到多 Agent 标签页或快速开始讨论。

该槽位是可追加的 `list`，不会替换原生标题栏：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\slots.d.ts" lines="47-61" />

## 3. 完整角色设置页面

顶部设定栏负责快捷选择；复杂配置建议再注册：

```text
settings.section
```

完整设置页负责：

- 新增、复制和删除角色
- 编辑角色 Prompt
- 选择模型
- 配置头像和颜色
- 设置工具权限
- 管理团队组合
- 导入、导出配置

官方建议复杂设置使用 `settings.section`，而不是拥挤到 `settings.general.item`：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh\config\agent-presets\cordis\skills\cordis-plugin-development\SKILL.md" lines="267-275" />

---

# 三、角色 Prompt 的可靠实现方式

当前 DSH 已正式支持程序化创建独立 Agent：

```javascript
ctx.agents.create({
  sessionId,
  meta,
  agentOptions,
  setup
})
```

每个角色对应一个真正独立的 Agent 和独立 Session，而不是让一个模型伪装成多个角色。

公开接口说明：  
<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-agent\README.zh.md" lines="37-45" />

创建参数支持：

- 独立 `sessionId`
- 父会话关系
- `origin: 'subagent'`
- 模型提供方
- 模型 ID
- 最大输出 Token
- 创建阶段的 `setup(agentCtx)`

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-agent\lib\types\index.d.ts" lines="65-117" />

## 为每个角色安装独立 Prompt

在 `setup(agentCtx)` 中注册 Agent 作用域的 persona：

```javascript
const handle = await ctx.agents.create({
  sessionId: childSessionId,
  meta: {
    parentSession: parentSessionId,
    origin: 'subagent',
    cwd
  },
  agentOptions: {
    provider: role.provider,
    model: role.model,
    maxTokens: role.maxTokens
  },
  setup(agentCtx) {
    agentCtx.systemPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text: role.prompt
    })
  }
})
```

DSH 的系统 Prompt 服务明确支持：

- Agent 作用域 Prompt
- Agent Prompt 遮蔽全局 persona
- 有序 Prompt 段
- 动态变量
- Agent 销毁时自动移除

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-system-prompt\README.zh.md" lines="16-25" />

`deployment:persona` 是官方定义的角色 Prompt 槽位：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-system-prompt\lib\types\index.d.ts" lines="111-131" />

## 向角色发送问题

创建 Agent 后：

```javascript
handle.agent.followup({
  id: messageId,
  role: 'user',
  content: [
    {
      type: 'text',
      text: prompt
    }
  ],
  source: {
    kind: 'plugin',
    plugin: '@p-dsh-market/multi-agent-roundtable'
  }
})

await handle.agent.whenIdle()
```

公开 Agent 接口支持：

- `followup()`：开始新一轮
- `steer()`：运行中补充指令
- `inject()`：注入上下文但不立即唤醒
- `cancel()`：停止 Agent
- `whenIdle()`：等待运行结束

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts" lines="59-132" />

因此以下功能都是可行的：

- 多角色并行回答
- 多轮交叉评审
- 用户中途追加要求
- 停止单个角色
- 停止整个讨论
- 每个角色使用不同模型
- 每个角色使用不同 Prompt

---

# 四、角色参与选择

顶部栏维护当前讨论配置：

```json
{
  "mode": "review",
  "rounds": 2,
  "participantIds": [
    "product-manager",
    "architect",
    "market-analyst"
  ]
}
```

开始讨论时只创建或唤醒选中的 Agent：

```javascript
const selectedRoles = roles.filter(function (role) {
  return discussion.participantIds.includes(role.id)
})
```

建议支持三种模式：

### 1. 独立评估

所有角色并行回答，不看其他角色的答案。

```text
用户问题
 ├─ 产品经理
 ├─ 架构师
 └─ 市场分析师
```

### 2. 交叉评审

第一轮并行，第二轮将其他角色结论作为上下文注入。

```text
第一轮独立回答
       ↓
汇总其他角色结论
       ↓
第二轮分别复审
```

### 3. 主持人模式

角色讨论完成后，由主持人 Agent 输出最终报告。

```text
角色第一轮
    ↓
角色互评
    ↓
主持人总结
```

---

# 五、配置应该如何存储

这里需要区分三类内容。

## 1. 插件包内：只存默认角色模板

例如：

```text
presets/default-roles.json
```

内容：

```json
{
  "schemaVersion": 1,
  "roles": [
    {
      "id": "product-manager",
      "name": "产品经理",
      "prompt": "你是一名资深产品经理……",
      "color": "#4f8cff",
      "enabled": true
    }
  ]
}
```

这部分随 npm 包发布，作为初始默认值。

**不能把用户修改后的 Prompt 写回这里。**

插件安装目录位于 `node_modules`：

- 应视为只读
- 更新插件时可能整体被替换
- 卸载时会被删除
- 不适合保存用户数据

DSH 协议也明确禁止把持久数据放进 npm 包目录：

<ref_snippet file="D:\Code\deepseek-harness\docs\DSH插件协议v1.md" lines="348-356" />

## 2. 用户修改后的角色：使用 `ctx.settings`

这是最合适、当前已经实际实现的存储方式。

插件注册独立 namespace：

```text
multi-agent-roundtable
```

结构：

```yaml
multi-agent-roundtable:
  roles:
    - id: product-manager
      name: 产品经理
      prompt: 你是一名资深产品经理……
      color: "#4f8cff"
      enabled: true

  teams:
    - id: product-review
      name: 产品评审组
      participantIds:
        - product-manager
        - architect
        - market-analyst

  defaults:
    teamId: product-review
    mode: review
    rounds: 2
```

`ctx.settings` 支持：

- Namespace 隔离
- Schema 校验
- 默认值与用户配置分层
- `get/watch/update/replace`
- 原子文件写入
- 设置热更新
- 并发 Revision 检查

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-settings\README.zh.md" lines="5-18" />

默认由文件提供方存到：

```text
$DSH_HOME/settings.yaml
```

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-settings-file\README.zh.md" lines="5-13" />

这满足“数据归插件管理”，但不会冒险写进插件安装目录。

浏览器端可以通过 `settingsScope` 读写对应 namespace，因此顶部设置栏保存后可以立刻同步给宿主端：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-client-ui-settings\README.zh.md" lines="5-11" />

## 3. 讨论内容：优先使用 DSH Session

每个角色 Agent 自带一个独立 Session，模型输入、流式分片和最终回复都进入 Session 事件日志。

DSH Session 是事件溯源的历史真源：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-session\README.zh.md" lines="5-19" />

因此不建议把整段 Agent 消息再复制进 `settings.yaml`。

推荐：

```text
主 DSH 会话
└── Roundtable discussion
    ├── 产品经理子 Session
    ├── 架构师子 Session
    └── 市场分析师子 Session
```

插件只需要额外保存：

```json
{
  "discussionId": "discussion-uuid",
  "parentSessionId": "当前DSH会话ID",
  "participants": [
    {
      "roleId": "architect",
      "childSessionId": "roundtable-uuid-architect"
    }
  ]
}
```

这份映射可采用插件自定义 Session Event 保存到父会话中。DSH 明确允许插件扩展自己的 Session 事件，并由插件负责关系约束：

<ref_snippet file="C:\Users\Admin\AppData\Local\dsh-desktop\runtimes\0.1.0-rc.7\node_modules\@deepseek-ai\dsh-session\README.zh.md" lines="69-75" />

建议事件：

```text
roundtable/discussion-created
roundtable/participants-selected
roundtable/message-linked
roundtable/discussion-completed
```

这样：

- 角色 Prompt 存在插件 Settings
- Agent 回复存在 DSH Session
- 父子关系存在插件自定义 Session Event
- 不需要重复维护完整聊天数据库

---

# 六、Markdown 渲染路径

不要直接显示纯文本。每条 Agent 消息统一保存为 Markdown 字符串：

```json
{
  "roleId": "architect",
  "contentType": "markdown",
  "content": "## 技术方案\n\n| 模块 | 方案 |\n|---|---|\n| API | Node.js |"
}
```

浏览器端建议打包：

- GFM Markdown 解析
- HTML Sanitizer
- 代码高亮
- 可选 Mermaid

至少支持：

- 标题
- 列表
- 引用
- 表格
- 任务列表
- 行内代码
- 围栏代码块
- 链接

当前工作区插件中的 Markdown 解析器只是轻量实现，可以参考安全处理方式，但不适合作为完整群聊渲染器：

<ref_snippet file="D:\Code\deepseek-harness\market\dsh-open-workspace\lib\client.js" lines="308-355" />

安全要求：

- 默认禁止原始 HTML
- 链接只允许安全协议
- 外链增加 `noopener noreferrer`
- Mermaid 在隔离容器中渲染
- 不把模型文本直接无清洗地放入 `dangerouslySetInnerHTML`

---

# 七、推荐插件结构

建议建立新插件：

```text
market/multi-agent-roundtable/
├── package.json
├── cordis.patch.yml
├── README.md
├── presets/
│   └── default-roles.json
├── lib/
│   ├── index.js
│   ├── client.js
│   ├── orchestration.js
│   ├── role-schema.js
│   └── protocol.js
└── test/
    ├── orchestration.test.js
    ├── role-schema.test.js
    └── protocol.test.js
```

考虑当前市场插件的发布风格，也可以在源码阶段使用 `src/`，发布前构建到 `lib/`。最终 `client.js` 必须符合 DSH 浏览器模块格式：

```javascript
window.__ModuleLoader__.load({
  id: '@p-dsh-market/multi-agent-roundtable',
  factory: function (require) {
    var React = require('react')
    // ...
  }
})
```

DSH 浏览器插件不能直接使用 JSX、TypeScript 或原生 ESM import：

<ref_snippet file="D:\Code\deepseek-harness\docs\plugin开发文档.md" lines="503-558" />

---

# 八、Host 与 Client 通信

静态市场插件建议通过宿主 HTTP 路由通信：

```text
GET    /multi-agent-roundtable/config
PUT    /multi-agent-roundtable/config
POST   /multi-agent-roundtable/discussions
POST   /multi-agent-roundtable/discussions/:id/messages
POST   /multi-agent-roundtable/discussions/:id/cancel
GET    /multi-agent-roundtable/discussions/:id
GET    /multi-agent-roundtable/discussions/:id/events
```

流式输出可以选择：

1. SSE
2. 长轮询
3. Session Snapshot 订阅

推荐优先使用 **Session 事件/Snapshot**；如果 Client 当前只暴露最终投影，再增加 SSE 作为实时增量传输。

需要注意：文档中的 `host.call/harness.handle` 是动态插件的包内 RPC；静态市场插件模板明确使用 `webServer + fetch`：

<ref_snippet file="D:\Code\deepseek-harness\dsh-plugin-template\lib\client.js" lines="7-15" />

<ref_snippet file="D:\Code\deepseek-harness\dsh-plugin-template\lib\index.js" lines="45-61" />

---

# 九、实施阶段

## 阶段 0：运行时契约探测

必须先在运行中的 DSH 查询：

- `conversation.view`
- `settings.section`
- `settingsScope`
- `agents`
- `sessions`
- `systemPrompt`
- `session/event`

确认 rc.7 实际挂载的服务与槽位和磁盘文档一致。

## 阶段 1：UI 骨架

完成：

- “多 Agent 讨论”标签页
- 顶部设定栏
- 静态角色选择
- 微信式消息列表
- 独立输入框
- Markdown 渲染

先使用模拟消息，不接模型。

## 阶段 2：设置持久化

完成：

- `ctx.settings` namespace
- 默认角色模板
- 角色增删改
- Prompt 编辑
- 参与团队配置
- Client 与 Host 热同步

## 阶段 3：单角色真实 Agent

先验证一条最短链路：

```text
前端输入
→ Host agents.create()
→ setup 注册角色 Prompt
→ agent.followup()
→ session 收到 assistant/chunk
→ UI 渲染最终 assistant/message
```

## 阶段 4：多角色并行

使用多个独立 Agent：

```javascript
await Promise.all(selectedRoles.map(runRole))
```

加入：

- 独立状态
- 单 Agent 取消
- 全部取消
- 失败隔离
- 并发上限

## 阶段 5：多轮讨论

实现：

- 独立分析
- 交叉评审
- 主持人总结
- 轮次上限
- Token 预算
- 上下文摘要

## 阶段 6：恢复与回放

通过父子 Session 和插件事件恢复：

- 参与角色
- 消息顺序
- 讨论轮次
- 未完成状态
- 最终总结

---

# 十、最终判断

| 要求 | 可行性 | 推荐实现 |
|---|---|---|
| 独立多 Agent 对话页 | 已确认可行 | `conversation.view` |
| 顶部设置栏 | 已确认可行 | 自定义 View 内 sticky toolbar |
| 角色增删改 | 已确认可行 | `settings.section` |
| 每角色独立 Prompt | 已确认可行 | Agent `setup` + `systemPrompt.section` |
| 选择参与角色 | 已确认可行 | Settings + 本轮 participantIds |
| 多 Agent 并行运行 | 已确认可行 | `ctx.agents.create()` |
| 中止讨论 | 已确认可行 | `agent.cancel()` |
| Markdown 表格/代码 | 可行 | 插件内打包安全 Markdown 渲染器 |
| 讨论历史持久化 | 已确认底层可行 | 子 Agent Session + 自定义父会话事件 |
| 写回 npm 插件目录 | 不应实施 | 包目录只保存默认模板 |

**推荐最终路径：`conversation.view` 独立标签页 + 顶部角色设定栏 + `ctx.settings` 保存角色 Prompt + `ctx.agents.create()` 创建独立角色 + DSH Session 保存讨论历史。**

这条路径全部建立在 DSH 当前公开扩展点上，不需要修改宿主 DOM，也不需要覆盖原生对话页面。