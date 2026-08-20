# DSH 企业工作台插件开发指导

> 文档状态：实施指导稿  
> 目标运行时：`@deepseek-ai/dsh 0.1.0-rc.7` 及其 Web Profile  
> 推荐包名：`@p-dsh-market/enterprise-workspace`  
> 实现边界：本文只指导 DSH 客户端 Plugin 的开发；企业管理后台、模型网关和企业身份平台由外部系统提供，不在本文实现范围内。

## 1. 结论与实施边界

在以下产品边界下，客户端功能可以作为一个 DSH Plugin 实现，不要求修改 DSH Desktop/Tauri 外框：

- 企业为用户统一提供公司账户和企业模型访问能力；
- 企业配置属于推荐配置和开箱即用能力，不要求禁止用户使用个人模型；
- 企业 Skills 与个人、项目 Skills 可以共存；
- 聊天记录管理以查看、搜索、筛选、同步、导出和恢复访问为主；
- 暂不要求 Plugin 强制删除 DSH 底层会话文件、阻止卸载或实施不可绕过的终端策略。

Plugin 在客户端承担以下职责：

1. 企业账户登录、令牌刷新和退出登录；
2. 注册企业模型 Provider，使用户使用公司账户访问企业模型网关；
3. 获取企业模型目录和推荐默认模型；
4. 查询本地 DSH 会话，提供聊天记录管理界面，并按用户配置同步到企业后台；
5. 注册远程 Skill Provider，按用户身份加载企业 Skills；
6. 提供企业工作台 UI、状态反馈、错误诊断和同步状态。

本文明确不做：

- 企业管理后台本身；
- 企业模型网关本身；
- 企业 OIDC/SSO 服务本身；
- 禁止个人模型、个人 Skills 或本地会话；
- 直接编辑 `$DSH_HOME/sessions` 下的 JSONL；
- 将企业 API Key、Access Token 或 Refresh Token 写入 `settings.yaml`；
- 修改 DSH Desktop 固定 DOM 或暴露任意 Tauri command。

## 2. 推荐产品形态

插件安装后增加一个“企业工作台”入口，包含四个区域：

| 区域 | 主要能力 |
| --- | --- |
| 企业账户 | 登录状态、组织、用户、令牌刷新状态、退出登录 |
| 企业模型 | 可用模型、能力标签、推荐模型、连通性检查、设为下次会话默认值 |
| 聊天记录 | 本地/已同步记录、搜索、筛选、同步状态、重试、导出 |
| 企业 Skills | 企业 Skill 目录、版本、说明、加载状态、刷新 |

建议同时提供两个轻量入口：

- `sidebar.footer.action`：打开企业工作台；
- `conversation.session.header.actions`：对当前会话执行“同步到企业空间”或查看同步状态。

工作台主体优先通过受支持的槽位注册。实施前必须使用 `cordis_inspect` 查询当前运行时的槽位签名、类型和 Props，不根据文档示例猜测最终契约。若当前版本没有适合的全局页面槽位，可使用 `shell.overlay` 承载由侧边栏按钮打开的全尺寸面板；不得替换 `root`、`sidebar`、`conversation` 等顶层槽位。

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ DSH Web                                                     │
│                                                             │
│  Enterprise Workspace Client                               │
│  ├─ 企业工作台 UI                                           │
│  ├─ 登录交互与回调状态                                      │
│  ├─ 会话/模型/Skill 展示                                    │
│  └─ fetch Plugin Host HTTP API                              │
└───────────────────────────┬─────────────────────────────────┘
                            │ loopback HTTP / JSON
┌───────────────────────────▼─────────────────────────────────┐
│ DSH Plugin Host                                             │
│                                                             │
│  ├─ EnterpriseAuthService                                   │
│  ├─ EnterpriseModelAdapter                                  │
│  ├─ ConversationSyncService                                 │
│  ├─ EnterpriseSkillProvider                                 │
│  ├─ EnterpriseApiClient                                     │
│  └─ webServer routes                                        │
└───────────────┬────────────────┬────────────────┬───────────┘
                │                │                │
       ┌────────▼───────┐ ┌──────▼──────┐ ┌──────▼──────────┐
       │ 企业身份平台    │ │ 企业模型网关 │ │ 企业管理后台     │
       │ OIDC / OAuth2  │ │ Models/LLM  │ │ Skills/会话/配置 │
       └────────────────┘ └─────────────┘ └─────────────────┘
```

插件采用 DSH 标准双半结构：

- Host 半运行在 Node 进程，持有身份、模型调用、会话查询、同步和 Skill Provider；
- Client 半运行在浏览器，负责 UI 和用户交互；
- Host 与 Client 之间只传递可无损 JSON 序列化的数据；
- 所有企业后台调用都由 Host 半完成，浏览器半不直接持有企业令牌。

## 4. 推荐工程结构

```text
enterprise-workspace/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ lib/
│  ├─ index.js                    # Host 入口与生命周期装配
│  ├─ client.js                   # Client 入口与 UI 槽位注册
│  ├─ host/
│  │  ├─ api-client.js            # 企业后台 HTTP Client
│  │  ├─ auth-service.js          # 登录、回调、刷新、退出
│  │  ├─ model-adapter.js         # 企业模型 Provider/Adapter
│  │  ├─ conversation-sync.js     # 本地会话读取与增量同步
│  │  ├─ skill-provider.js        # 远程企业 Skill Provider
│  │  ├─ routes.js                # Plugin HTTP API
│  │  └─ validation.js            # 输入输出校验与错误归一化
│  ├─ client/
│  │  ├─ workspace-view.js        # 企业工作台主体
│  │  ├─ account-panel.js
│  │  ├─ models-panel.js
│  │  ├─ conversations-panel.js
│  │  ├─ skills-panel.js
│  │  └─ api.js                   # 浏览器到 Host 的 fetch 封装
│  └─ shared/
│     ├─ constants.js
│     └─ contracts.js             # JSON DTO 与错误码约定
└─ test/
   ├─ auth-service.test.mjs
   ├─ model-adapter.test.mjs
   ├─ conversation-sync.test.mjs
   ├─ skill-provider.test.mjs
   ├─ routes.test.mjs
   └─ manifest.test.mjs
```

若当前构建链仍要求浏览器入口保持单文件 ESM，可在源码中分模块，发布前打包为 `lib/client.js`。浏览器 UI 遵循现有 DSH 插件约束，使用宿主提供的 React 和槽位服务，不直接依赖产品 DOM。

## 5. package.json 和挂载要求

清单至少应包含：

```json
{
  "name": "@p-dsh-market/enterprise-workspace",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "protocolVersion": 1,
    "client": {
      "platform": "web"
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "market": {
      "displayName": "企业工作台",
      "capabilities": ["skills", "host", "client"]
    }
  }
}
```

`cordis.patch.yml` 示例：

```yaml
- insert:
    - id: enterprise-workspace
      name: '@p-dsh-market/enterprise-workspace'
      inject:
        - settings
        - credentials
        - llm
        - sessions
        - sessionQuery
        - skills
        - webServer
```

最终 `inject` 名称必须以目标 Runtime 的 `cordis_inspect` 结果为准。可选服务要通过特性检测访问；缺失时仅关闭对应区域，不得导致整个 DSH Web 启动失败。

## 6. 企业账户与认证

### 6.1 推荐登录方式

优先采用 OIDC Authorization Code + PKCE：

1. Client 点击“登录企业账户”；
2. Host 生成 `state`、`code_verifier` 和 `code_challenge`；
3. Client 打开系统浏览器进入企业登录页；
4. 企业身份平台回调 Plugin 注册的 loopback 路由；
5. Host 校验 `state` 并交换 Token；
6. Host 调用 `/api/v1/me` 获取用户和组织信息；
7. Host 刷新模型目录、会话同步配置和企业 Skill 目录；
8. Client 只收到脱敏后的登录状态。

如果企业身份平台支持 OAuth Device Authorization Grant，也可以将设备码登录作为无需 loopback 回调的备选方案。

### 6.2 令牌存储

- `settings.yaml` 只保存非敏感信息，例如企业服务地址、组织 ID、同步偏好和 Credential 引用；
- Access Token 和 Refresh Token 使用 `ctx.credentials` 或目标 Runtime 提供的安全凭据能力；
- Client 端永远不返回 Refresh Token；
- Host API 不提供“读取原始 Token”的路由；
- 日志中对 `authorization`、`token`、`cookie`、`apiKey`、`secret` 字段统一脱敏；
- 退出登录时清理企业令牌，并使模型目录、企业 Skills 和同步任务立即失效。

### 6.3 登录状态 DTO

```json
{
  "authenticated": true,
  "user": {
    "id": "user-123",
    "displayName": "张三",
    "email": "zhangsan@example.com"
  },
  "organization": {
    "id": "org-1",
    "displayName": "示例公司"
  },
  "expiresAt": "2026-08-20T12:00:00Z",
  "refreshable": true
}
```

## 7. 企业模型接入

### 7.1 推荐方式：Plugin 自有 LLM Adapter

因为用户使用公司账户访问模型，企业令牌通常是短期令牌，不适合把企业模型简单配置成一个长期 API Key。推荐由 Host 半注册企业 LLM Adapter：

- Adapter 从 `EnterpriseAuthService` 获取当前有效 Access Token；
- Token 临近过期时由 Auth Service 单飞刷新，避免并发请求重复刷新；
- `listModels(provider)` 从企业模型网关或后台 Bootstrap 接口取得模型目录；
- `stream()` 将 DSH 请求转换为企业模型网关协议，并转换流式响应；
- 每次请求记录企业侧 `requestId`，但不记录明文 Prompt；
- 401 先刷新一次并重试一次，仍失败则要求重新登录；
- 429、5xx 和网络错误按网关返回的可重试语义处理，不无限重试。

推荐 Provider ID 使用稳定值，例如：

```text
enterprise
```

模型 ID 由后台返回，例如：

```json
{
  "provider": "enterprise",
  "models": [
    {
      "id": "deepseek-chat",
      "displayName": "企业 DeepSeek Chat",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "reasoningEfforts": []
    },
    {
      "id": "deepseek-reasoner",
      "displayName": "企业 DeepSeek Reasoner",
      "contextWindow": 128000,
      "maxTokens": 32768,
      "reasoningEfforts": ["low", "medium", "high"]
    }
  ],
  "recommendedModel": "deepseek-chat"
}
```

### 7.2 默认模型策略

企业推荐模型只是默认值，不覆盖用户个人选择：

- 首次登录且用户尚未选择模型时，使用企业推荐模型；
- 用户主动切换模型后，保留其选择；
- 企业推荐模型变化时显示提示，不静默覆盖当前会话；
- “设为默认”只影响后续新会话；
- 会话事件继续记录实际 `provider` 和 `model`，保证历史可追溯。

### 7.3 模型连通性检查

连通性检查应是独立的低成本接口，不通过发送真实聊天 Prompt 实现。状态至少区分：

- 未登录；
- 正在刷新令牌；
- 模型可用；
- 当前账户无模型权限；
- 网关不可达；
- 令牌失效，需要重新登录。

## 8. 聊天记录管理与同步

### 8.1 数据来源

Host 半使用 DSH 正式服务读取会话：

- `ctx.sessions`：观察当前活跃会话和生命周期事件；
- `ctx.sessionQuery.listSessions()`：列出完整逻辑会话；
- `ctx.sessionQuery.readSession(sessionId)`：读取完整会话日志；
- `ctx.sessionQuery.searchSessions(...)`：全文搜索；
- `ctx.sessionQuery.searchEvents(...)`：会话内事件搜索；
- `ctx.sessionQuery.readSurface(sessionId)`：读取当前可展示表面。

不得直接遍历、编辑或删除 `$DSH_HOME/sessions/*.jsonl`。这样可以避免绕过会话重放校验、持久化协调和索引一致性。

### 8.2 本地管理能力

首版建议实现：

- 标题、创建时间、更新时间、工作区、Provider、模型筛选；
- 关键字搜索；
- 查看完整会话；
- 导出 Markdown/JSON；
- 标记“仅本地”“待同步”“已同步”“同步失败”；
- 手动同步单个会话；
- 批量重试失败同步；
- 当前会话的一键同步入口。

首版不实现底层删除。若需要“从企业后台移除”，只删除后台副本，并明确提示本地 DSH 会话仍然存在。

### 8.3 同步原则

- 默认由用户明确开启企业会话同步；
- 支持“手动同步”和“自动同步已完成会话”两种模式；
- 自动同步不得阻塞 Agent 回合结束；
- 监听 `turn/end` 后只投递轻量异步任务；
- 启动后通过 `sessionQuery` 进行补偿扫描，修复程序退出时遗漏的事件；
- 后台接口必须幂等，重复上传同一事件不会生成重复记录；
- 同步失败保留可诊断状态，网络恢复后指数退避重试；
- 用户退出企业账户后停止上传，但不删除本地会话。

### 8.4 稳定标识与幂等键

建议使用：

```text
tenant_id + user_id + device_id + local_session_id
```

会话事件使用：

```text
conversation_key + event_seq + event_hash
```

后台写入接口应使用 Upsert，而不是把“上传成功响应是否丢失”视为新会话。

### 8.5 数据最小化

同步配置至少提供：

- 是否同步消息正文；
- 是否同步工具调用参数和结果；
- 是否同步附件元数据；
- 是否排除指定工作区；
- 是否只同步用户手动选择的会话。

任何附件上传都必须独立授权和限制大小。首版可以只同步附件名称、类型和大小，不上传文件内容。

## 9. 企业 Skills 管理

### 9.1 使用远程 Skill Provider

Host 半通过 `ctx.skills.registerProvider(...)` 注册企业 Skill Provider：

```javascript
ctx.effect(() => ctx.skills.registerProvider((control) => ({
  name: 'enterprise-skills',

  async list(options) {
    return enterpriseSkills.list({
      cwd: options.cwd,
      signal: options.signal
    })
  },

  async get(candidate, options) {
    return enterpriseSkills.get(candidate, {
      cwd: options.cwd,
      signal: options.signal
    })
  }
})))
```

注意：示例只表达生命周期形态。最终字段必须符合目标 Runtime 的 `SkillCandidate`、`SkillDefinition` 和 `SkillProviderObservation` 类型。

### 9.2 Skill 列表返回内容

`list()` 只返回路由所需的轻量信息：

```json
{
  "name": "enterprise-release-check",
  "description": "按照公司发布规范检查版本、变更和回滚材料",
  "version": "3.2.1",
  "etag": "sha256:...",
  "source": "enterprise",
  "locator": "skill-123@3.2.1"
}
```

完整 `SKILL.md` 内容只在 `get()` 时加载，避免每次会话启动都注入所有 Skill 正文。

### 9.3 Skill 共存规则

- 企业 Skills 不删除个人 Skills；
- 企业 Skill 名称使用稳定的 kebab-case；
- 发布前检查是否与内置、用户和项目 Skill 重名；
- 若希望明确区分，企业 Skill 可统一使用 `enterprise-` 或业务域前缀；
- UI 显示来源、版本、更新时间和适用范围；
- 后台目录变化后调用 Provider Control 的 `invalidate()`，触发目录刷新；
- Skill 内容必须来自登录用户有权访问的目录，不由 Client 传入任意 Skill ID 绕过鉴权。

### 9.4 缓存策略

首版可以采用：

- 进程内 Last-Good Catalog；
- ETag/If-None-Match；
- 目录请求超时后继续使用本进程最近一次成功结果；
- 退出登录时清空企业 Skill 缓存。

如果后续需要重启后离线使用，再增加宿主分配的插件缓存目录；不要把运行时缓存写进 `node_modules`。

## 10. Plugin Host HTTP API

推荐统一前缀：

```text
/enterprise-workspace/api/v1
```

建议路由：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/status` | 聚合账户、模型、同步和 Skill 状态 |
| `POST` | `/auth/start` | 创建 PKCE 登录事务并返回授权地址 |
| `GET` | `/auth/callback` | 接收企业身份平台回调 |
| `POST` | `/auth/logout` | 退出登录并清理令牌 |
| `GET` | `/models` | 返回企业模型目录 |
| `POST` | `/models/refresh` | 刷新模型目录 |
| `POST` | `/models/test` | 执行低成本连通性检查 |
| `GET` | `/conversations` | 查询本地会话和同步状态 |
| `GET` | `/conversations/:id` | 读取一个本地会话 |
| `POST` | `/conversations/:id/sync` | 手动同步一个会话 |
| `POST` | `/conversations/sync-retry` | 重试失败同步 |
| `GET` | `/skills` | 返回企业 Skill 目录和状态 |
| `POST` | `/skills/refresh` | 刷新并 invalidate Skill Provider |

所有写操作应校验：

- HTTP 方法和 Content-Type；
- 请求体大小；
- session ID、模型 ID、Skill 名称格式；
- 当前登录用户；
- 操作是否属于当前 Plugin；
- 超时和 AbortSignal；
- 返回内容中不存在凭据。

浏览器 API 统一返回：

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "请先登录企业账户。",
    "retryable": false,
    "requestId": "req-123"
  }
}
```

## 11. 企业后台对接契约建议

虽然后台不在本文实现范围内，Plugin 开发前仍应冻结最小接口契约。

### 11.1 Bootstrap

```http
GET /api/v1/client/bootstrap
Authorization: Bearer <access-token>
```

返回用户、组织、模型目录、推荐模型、会话同步默认值和 Skill 目录修订号。Bootstrap 用于登录后的首次收敛，不代替后续分页查询。

### 11.2 会话 Upsert

```http
PUT /api/v1/conversations/{conversationKey}
POST /api/v1/conversations/{conversationKey}/events:batch
```

要求：

- 幂等；
- 支持事件批次；
- 返回已接受的最大事件序号；
- 单条非法事件不应导致服务端静默接受半套数据；
- 响应包含服务端 `requestId`；
- 对过大正文和附件返回明确错误码。

### 11.3 Skills

```http
GET /api/v1/skills?cursor=<cursor>&cwdHint=<optional>
GET /api/v1/skills/{skillId}/versions/{version}
```

Skill 正文响应至少包含：

- `name`；
- `description`；
- `version`；
- `content`；
- `etag` 或内容摘要；
- 用户调用和模型调用策略；
- 来源与更新时间。

## 12. 配置 Namespace

推荐 Namespace：

```text
enterprise-workspace
```

只保存非敏感配置：

```yaml
enterprise-workspace:
  baseURL: https://ai.example.com
  organizationId: org-1
  authCredentialRef: ENTERPRISE_WORKSPACE_AUTH
  conversationSync:
    enabled: false
    mode: manual
    includeMessageContent: true
    includeToolDetails: false
    excludedWorkspaces: []
  models:
    useRecommendedWhenUnset: true
  skills:
    enabled: true
```

配置更新通过 `ctx.settings` 完成，不直接读写 `settings.yaml`。浏览器设置表单只处理脱敏配置，Secret 通过独立认证流程写入凭据服务。

## 13. 生命周期与降级

### 13.1 apply

1. 注册配置 Namespace；
2. 创建 Auth、API Client、Model、Conversation 和 Skill 服务；
3. 注册 LLM Adapter；
4. 注册远程 Skill Provider；
5. 注册 Host HTTP 路由；
6. 监听会话结束和登录状态变化；
7. Client 注册 UI 槽位。

所有注册必须由 `ctx.effect` 管理，确保插件停用时完整撤销。

### 13.2 dispose

- 中止正在进行的后台请求；
- 停止 Token 刷新定时器；
- 停止会话同步队列；
- 注销 LLM Adapter 和 Skill Provider；
- 注销 HTTP 路由；
- 清理浏览器 UI 和样式；
- 不删除 DSH 会话和用户非敏感配置；
- 不在普通停用时擅自撤销企业后台数据。

### 13.3 能力缺失时降级

| 缺失能力 | 降级行为 |
| --- | --- |
| `credentials` | 禁用登录并显示安全凭据能力不可用 |
| `llm` | 账户和记录页可用，企业模型页只读诊断 |
| `sessionQuery` | 关闭历史搜索/回填，只观察当前活跃会话 |
| `skills` | 关闭企业 Skills，不影响其他功能 |
| `webServer` | Plugin 不激活 Client UI，记录清晰错误 |
| 企业后台不可达 | 保留本地聊天能力，显示离线状态并暂停同步 |

## 14. 安全要求

- 企业后台地址由管理员包配置或受控设置给出，不接受会话消息临时指定；
- 默认只允许 HTTPS；开发模式的 loopback HTTP 必须显式开启；
- OIDC 校验 issuer、audience、state、nonce、PKCE 和时间窗口；
- Access Token 只存在于 Host 半；
- Client 不得通过错误详情、状态接口或调试日志获得 Token；
- 会话同步默认遵守最小化原则；
- Skill 正文视为可信企业内容，但仍校验名称、大小、编码和摘要；
- Model/Skill/Conversation API 都设置超时、最大响应体和取消信号；
- 不执行后台返回的任意 shell、任意 JavaScript 或任意 Tauri command；
- 所有日志使用企业请求 ID 关联，不记录模型输入输出正文作为默认日志字段。

## 15. 可观测性与错误码

推荐稳定错误码：

| 错误码 | 含义 | 是否可重试 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 尚未登录 | 否 |
| `AUTH_EXPIRED` | 登录已失效 | 否，需要重新登录 |
| `AUTH_REFRESH_FAILED` | Token 刷新失败 | 视原因 |
| `MODEL_ACCESS_DENIED` | 当前账户无模型权限 | 否 |
| `MODEL_GATEWAY_UNAVAILABLE` | 模型网关不可达 | 是 |
| `CONVERSATION_NOT_FOUND` | 本地会话不存在 | 否 |
| `CONVERSATION_SYNC_REJECTED` | 后台拒绝会话数据 | 否，需查看原因 |
| `CONVERSATION_SYNC_FAILED` | 同步网络或服务错误 | 是 |
| `SKILL_CATALOG_UNAVAILABLE` | Skill 目录不可达 | 是 |
| `SKILL_STALE` | Skill 版本在加载前发生变化 | 是 |
| `PLUGIN_CAPABILITY_MISSING` | 目标 Runtime 缺少依赖服务 | 否 |

状态页面至少显示：

- Plugin 版本与 Runtime 版本；
- 当前企业用户和组织；
- Token 到期时间，不显示 Token；
- 模型目录最后刷新时间；
- 待同步和失败会话数量；
- Skill 目录修订号和最后刷新时间；
- 最近一次错误码和企业请求 ID。

## 16. 实施阶段

### 阶段 0：运行时契约探测

- 使用 `cordis_inspect` 确认 `settings`、`credentials`、`llm`、`sessions`、`sessionQuery`、`skills` 和 `webServer`；
- 确认 UI 槽位签名和 Props；
- 确认 LLM Adapter、Skill Provider 和会话事件的真实类型；
- 将探测结果记录在开发 README，不把探测性猜测直接写进业务代码。

验收：形成一份目标 Runtime 的接口快照，所有必须能力均有明确签名或降级方案。

### 阶段 1：Plugin 骨架和企业工作台 UI

- 建立 Host/Client 双半结构；
- 注册工作台入口和四个空状态面板；
- 建立统一 Host API、DTO、错误码和日志脱敏；
- 完成生命周期卸载测试。

验收：插件安装后正常激活；停用后无残留按钮、路由、样式和定时器。

### 阶段 2：企业登录

- 实现 PKCE 登录事务；
- 安全保存 Token；
- 实现单飞刷新和退出登录；
- 完成 `/status` 和账户面板。

验收：登录、刷新、重启恢复、退出、过期和错误回调均有测试。

### 阶段 3：企业模型

- 注册稳定 Provider；
- 加载模型目录；
- 实现流式调用和错误映射；
- 实现推荐模型和连通性检查；
- 保证个人 Provider 继续可用。

验收：企业模型与个人模型同时可见，选择企业模型可完成真实流式会话，退出登录后企业模型不可调用但不影响个人模型。

### 阶段 4：聊天记录管理

- 实现列表、搜索、详情和导出；
- 建立同步状态投影；
- 实现手动同步、自动同步和启动补偿扫描；
- 实现幂等事件批次和失败重试。

验收：重复同步不产生重复数据；断网、重启和 Token 过期后能够恢复；同步不阻塞正常对话。

### 阶段 5：企业 Skills

- 注册远程 Provider；
- 实现目录分页/ETag；
- 实现按需 `get()`；
- 实现目录刷新和来源/版本 UI；
- 验证与个人、项目 Skills 共存。

验收：登录后企业 Skills 可发现并按需加载；退出登录后消失；个人和项目 Skills 不受影响。

### 阶段 6：集成、打包和灰度

- 完成真实企业身份平台联调；
- 完成模型网关流式协议联调；
- 完成后台会话幂等联调；
- 完成企业 Skill 内容和权限联调；
- `npm pack` 后在干净 Web Profile 安装；
- 验证重启、升级、停用和卸载；
- 小范围灰度后再进入企业插件市场。

## 17. 测试要求

### 17.1 单元测试

- PKCE、state、nonce 和回调校验；
- Token 单飞刷新和过期判断；
- 日志及错误脱敏；
- 模型目录校验和 DSH 模型信息转换；
- 流式增量、结束、取消和错误转换；
- 会话幂等键和事件批次切分；
- 同步退避、补偿扫描和退出停止；
- Skill 名称、摘要、版本和大小校验；
- Provider invalidate 与 Last-Good 行为；
- HTTP 路由方法、请求体大小和错误码。

### 17.2 契约测试

- `package.json` 满足市场清单要求；
- Host 和 Client 入口存在；
- `cordis.patch.yml` 可解析；
- 所有路由响应符合 DTO；
- 企业后台 Mock 符合 OpenAPI/JSON Schema；
- 不允许敏感字段出现在 Client DTO 和日志快照中。

### 17.3 集成测试

- Web Profile 安装、激活、停用和卸载；
- 登录回调和系统浏览器跳转；
- 企业模型真实流式请求；
- DSH 会话结束后的异步同步；
- 历史会话启动补偿；
- 企业 Skill 被模型正确发现和加载；
- 企业后台不可达时 DSH 普通聊天不受影响。

## 18. 完成定义

满足以下条件才视为首版完成：

- 用户只需登录公司账户即可使用企业模型；
- 不要求用户手工填写企业模型 API Key；
- 企业模型与个人模型并存；
- 用户能够搜索、查看、导出并按配置同步本地聊天记录；
- 同步具备幂等、补偿和失败重试；
- 企业 Skills 能通过远程 Provider 按需加载；
- 企业 Skills 与个人/项目 Skills 共存；
- 插件停用不会影响 DSH 原有模型、会话和 Skills；
- Client 和日志中不存在 Token、API Key 或 Refresh Token；
- 插件可以通过市场包安装到 Web Profile；
- 所有单元、契约和目标集成测试通过。

## 19. 开发时必须遵守的原则

1. 先探测目标 Runtime 契约，再写实现；
2. 使用 DSH 正式服务读取会话，不直接修改会话文件；
3. 使用远程 Skill Provider，不把整个企业 Skill 库硬编码进插件；
4. 企业模型访问绑定公司账户，不向用户暴露企业上游密钥；
5. 同步和目录刷新永远不进入正常对话的阻塞路径；
6. Plugin 的每项副作用都必须可撤销；
7. 缺少某项可选能力时局部降级，不拖垮 DSH Web；
8. 后台返回的是数据和受控配置，不是可任意执行的本地代码；
9. 首版优先保证登录、模型访问、会话同步和 Skill 加载闭环，再增加统计报表等增强功能。

---

推荐实施路线：**单个企业工作台 Plugin + 企业 OIDC + 企业模型网关 + 企业管理后台**。客户端不承担不可绕过的终端管控，只负责为公司用户提供开箱即用的模型、会话和 Skills 工作空间。
