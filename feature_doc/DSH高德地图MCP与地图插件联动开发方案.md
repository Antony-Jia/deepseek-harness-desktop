# DSH 高德地图 MCP 与地图插件联动开发方案

> 状态：开发设计稿，尚未实施  
> 文档版本：0.1  
> 日期：2026-08-25  
> 目标：在 DSH Desktop 中内建高德地图 MCP 配置，并通过一个市场插件把地点查询、POI 搜索和路线规划结果展示在对话正文卡片、右侧地图面板以及与思维导图同级的中央地图视图中。

## 1. 结论与产品定位

该功能应实现为两项可独立安装、又能协同工作的能力：

1. **DSH Desktop 内建高德 MCP 管理**：负责高德 Web 服务 Key、官方 MCP 进程、Cordis 挂载、真实工具注册状态和故障诊断。
2. **DSH 市场地图插件**：负责地图展示工具、Skill、会话级地图状态、正文卡片、右侧地图面板和中央地图页面。

推荐插件包名：

```text
@p-dsh-market/amap-map-assistant
```

推荐内建 MCP 标识：

```text
id: amap
serverName: amap
package: @amap/amap-maps-mcp-server@0.0.8
transport: stdio
```

首版采用以下交互原则：

- 地图主页面使用正式的 `conversation.view`，与“思维与知识”等视图处于同一中央区域，而不是新增 Tauri 独立页面或修改 DSH DOM。
- 当回答涉及地点转移时，模型先调用高德 MCP 获取真实数据，再调用专用展示工具 `amap_present_map`。
- `amap_present_map` 在正文中生成一张地图卡片，但**不得自动弹开右侧面板**。
- 用户点击卡片中的“在地图中查看”后，才打开右侧地图规划面板。
- 普通回答文本不会被前端扫描；地点名、路线词或链接本身都不会触发地图。
- MCP 是查询事实的权威来源；地图插件只整理和展示数据，不能用可视化重新解释或覆盖 MCP 结论。

## 2. 首版范围

### 2.1 必须实现

#### MCP 能力

- 地理编码：地址或建筑物名称转换为 GCJ-02 经纬度。
- 逆地理编码：GCJ-02 经纬度转换为行政区划和地址信息。
- POI 关键词搜索。
- POI 周边搜索。
- POI 详情查询。
- 距离测量。
- 天气查询。
- 驾车路径规划。
- 公交/地铁综合路径规划。
- 步行路径规划。
- 骑行路径规划。
- IP 粗定位；只用于城市级默认范围，不视为用户精确位置。

#### 地图插件能力

- 单地点 Marker、名称、地址和 POI 信息展示。
- 多个搜索结果的 Marker、编号、结果列表和选中态联动。
- 起点、终点和途经点展示。
- 驾车、公交、步行和骑行路线展示。
- 距离、预计时间、费用或换乘摘要；仅展示 MCP 已返回的字段。
- 地图自动适应点位或路线视野。
- 正文卡片、右侧地图面板、中央地图视图三处共享同一份会话状态。
- 在用户明确点击后生成高德地图 URI/网页导航链接。
- 每个会话保存一份“当前地图状态”，新展示结果替换当前状态。

#### 配置与诊断

- 高德 MCP 默认关闭，必须由用户显式启用。
- 在 MCP 管理页的一张“高德地图”卡片中统一配置三项凭据。
- 保存后明确提示需要重启 DSH 才能重新挂载 MCP。
- 展示 MCP 配置状态、Profile 挂载状态、进程连接状态和工具注册状态。
- 插件单独显示地图 JS API 是否可用，不把“已填写 Key”当作地图已就绪。

### 2.2 明确不实现

- 不实现实时导航、语音导航、偏航重算或车道级导航。
- 不持续采集定位，不后台跟踪用户，不保存位置轨迹。
- 不自动读取系统定位；首版起点由用户输入、MCP 解析或用户在地图中选择。
- 不扫描普通聊天文本，不使用正则或额外模型从完成后的回答中猜测地点。
- 不自动打开地图面板，不自动唤起高德地图 App。
- 不把高德 JS API、瓦片、样式或 Loader 下载后打进插件包。
- 不把完整地图状态写进业务工作区或 Git 仓库。
- 不建设收藏夹、历史足迹、多人共享行程或旅行计划数据库。
- 不提供打车下单、订票、支付或其他外部交易能力。
- 不承诺海外地图、海外路线或 WGS-84 数据的完整支持。

## 3. 用户体验与入口

### 3.1 MCP 管理页

在现有 Tavily、Firecrawl、Chrome MCP 卡片旁增加“高德地图”卡片：

```text
┌──────────────────────────────────────────────────────┐
│ 高德地图                                  [ 启用 ]   │
│ @amap/amap-maps-mcp-server@0.0.8                     │
│                                                      │
│ Web 服务 Key       [ 已配置 / 未配置 ] [重新填写]    │
│ Web JS API Key     [ 已配置 / 未配置 ] [重新填写]    │
│ securityJsCode     [ 已配置 / 未配置 ] [重新填写]    │
│                                                      │
│ Profile：已挂载   连接：已连接   工具：12 个         │
│ 地图脚本：可用    安全代理：可用                     │
│                                      [刷新诊断]       │
└──────────────────────────────────────────────────────┘
```

规则：

- 三个输入框只接受新值，不回显旧值。
- 页面只返回 `configured: true | false`，不返回密文或明文。
- 用户清除任一凭据时必须使用明确的“清除”操作，空输入不代表删除已有值。
- 三项凭据不完整时可以保存，但不能启用高德服务。
- 保存或切换启用状态后，复用现有 DSH 重启提示与操作锁。
- 工具数量以桥接接口实际返回的 `mcp__amap__*` 为准，不使用固定文案冒充运行状态。

### 3.2 中央地图页面

插件注册一个同级中央视图：

```text
聊天 | 多 Agent 讨论 | 思维与知识 | 地图
```

使用：

```javascript
ctx.slots.inject('conversation.view', function () {
  return ctx.slots.register(
    {
      name: 'conversation.view',
      id: 'amap-map-assistant',
      order: 40,
      label: '地图'
    },
    AmapConversationView
  )
})
```

中央页面结构：

```text
┌────────────────────────────────────────────────────────────┐
│ 地图 · 当前会话             [驾车] [公交] [步行] [骑行]   │
│ 北京南站 → 国家大剧院                     [在高德中打开] │
├──────────────────────────────────────┬─────────────────────┤
│                                      │ 路线摘要            │
│                                      │ 预计 28 分钟        │
│          高德交互地图                │ 约 12.6 公里        │
│                                      │                     │
│          Marker / Polyline           │ 起点、终点、途经点  │
│                                      │ 分步说明            │
│                                      │ 数据来源与时间      │
└──────────────────────────────────────┴─────────────────────┘
```

页面只读取当前会话的地图状态。没有状态时显示：

```text
当前对话还没有地图结果。
你可以在对话中搜索地点、查询周边或规划路线；
模型完成高德查询后会生成一张可打开的地图卡片。
```

### 3.3 正文地图卡片

`amap_present_map` 通过 `tool.call.toolview` 渲染，不在聊天文本中拼接 HTML：

```text
┌──────────────────────────────────────────┐
│ 路线规划 · 驾车                         │
│ 北京南站 → 国家大剧院                   │
│ 约 12.6 公里 · 预计 28 分钟             │
│ 来源：高德地图 MCP                      │
│                         [在地图中查看]   │
└──────────────────────────────────────────┘
```

卡片行为：

- 工具执行完成后只显示卡片，不改变当前视图，不打开 Overlay。
- 点击“在地图中查看”时打开右侧面板，并以这张卡片的状态为当前状态。
- 点击卡片标题或正文不触发打开，减少误操作。
- 工具失败时显示普通错误卡片，不打开空地图。
- 页面刷新后，卡片从会话 Tool Block 恢复；Host 保存的当前状态用于恢复中央视图和右侧面板。

### 3.4 右侧地图面板

面板使用 `shell.overlay` 注册，与 AKShare 右侧面板采用相同的受控浮层思路：

```javascript
ctx.slots.inject('shell.overlay', function () {
  return ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'amap-map-assistant-panel',
      order: 130,
      label: '高德地图'
    },
    AmapMapOverlay
  )
})
```

面板要求：

- 从右侧打开，默认宽度 520px，允许在 420px 至视口宽度 75% 范围调整。
- 关闭面板不清除会话地图状态。
- 切换会话后立即切换到新会话状态；新会话无数据时显示空状态。
- 不通过 `window.open`、DOM selector 或 Tauri 任意命令控制面板。
- 地图实例在面板卸载时执行 `destroy()`，移除事件监听和 ResizeObserver。

## 4. 总体架构

### 4.1 组件图

```text
┌──────────────────── DSH Desktop / Tauri ─────────────────────┐
│ MCP 管理页                                                    │
│  ├─ 高德三项凭据输入                                         │
│  ├─ DPAPI 加密/解密                                          │
│  ├─ cordis.patch.yml 生成                                    │
│  └─ MCP / Profile / Tool readiness                           │
└──────────────────────────────┬────────────────────────────────┘
                               │ 启动时注入 AMAP_MAPS_API_KEY
                               ▼
┌──────────────────────── DSH Host ─────────────────────────────┐
│ @deepseek-ai/dsh-mcp-client                                  │
│  └─ stdio → @amap/amap-maps-mcp-server@0.0.8                │
│             └─ mcp__amap__maps_*                             │
│                                                              │
│ @p-dsh-market/amap-map-assistant Host                        │
│  ├─ Skill 注册                                                │
│  ├─ amap_present_map 工具                                     │
│  ├─ 会话状态存储                                              │
│  ├─ /amap-map/bootstrap                                       │
│  ├─ /amap-map/state                                           │
│  └─ /amap-map/_AMapService/* 安全代理                         │
└──────────────────────────────┬────────────────────────────────┘
                               │ HTTP / Tool Block / slots
                               ▼
┌──────────────────────── DSH Web ──────────────────────────────┐
│ 高德 JS API 2.0（只在线加载）                                │
│  ├─ conversation.view 中央地图                               │
│  ├─ tool.call.toolview 正文卡片                              │
│  ├─ shell.overlay 右侧地图面板                               │
│  └─ conversation.session.header.actions 会话入口             │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 完整数据流

```text
用户询问地点、搜索或路线
  → 模型加载 amap-map-assistant Skill
  → 检查 mcp__amap__* 是否存在
  → 必要时调用 maps_geo / maps_text_search / maps_search_detail
  → 调用对应路线或距离 MCP 工具
  → 根据 MCP 原始结果形成文字回答所需事实
  → 调用 amap_present_map 写入规范化展示状态
  → Host 校验坐标、数量、来源工具和会话身份
  → Host 原子保存当前会话地图状态
  → 对话流渲染地图卡片
  → 不自动打开面板
  → 用户点击“在地图中查看”
  → 客户端从卡片或 Host 状态载入同一 revision
  → 打开右侧地图面板
  → 用户也可切换到中央“地图”视图查看
```

### 4.3 MCP 与插件的职责边界

| 能力 | 高德 MCP | 地图插件 |
| --- | --- | --- |
| 地址解析 | 权威查询 | 展示解析后的点位 |
| POI 搜索与详情 | 权威查询 | Marker、列表和详情卡 |
| 路线距离/时间/步骤 | 权威查询 | 摘要、Polyline 和步骤列表 |
| 普通聊天回答 | 提供事实 | 不改写回答 |
| 地图渲染 | 不负责 | 高德 JS API 2.0 |
| 会话当前地图 | 不负责 | Host 持久化 |
| 凭据保存 | Desktop/DPAPI | 只读取受控 bootstrap |
| 运行诊断 | Desktop Bridge | 展示只读状态 |

地图插件不得直接假装 MCP 已成功调用。`amap_present_map.sourceTools` 必须记录本次展示所依赖的高德工具名；Host 只接受已知的 `mcp__amap__*` 名称。

## 5. 高德 MCP 内建配置

### 5.1 官方服务与工具命名

首版固定：

```text
@amap/amap-maps-mcp-server@0.0.8
```

官方文档同时提供 Streamable HTTP 和 Node.js stdio。DSH Desktop 首版选择 stdio，原因是：

- 可复用当前 Desktop 托管的 Node/npm，不要求系统 Node。
- API Key 通过子进程环境注入，不需要放在远程 URL 查询参数中。
- 能沿用 Tavily、Firecrawl 的 DPAPI、Profile Patch 和 readiness 流程。
- 可以固定 npm 版本，降低上游工具 Schema 漂移。

启用后预期注册：

| DSH 工具名 | 用途 |
| --- | --- |
| `mcp__amap__maps_regeocode` | 逆地理编码 |
| `mcp__amap__maps_geo` | 地理编码 |
| `mcp__amap__maps_ip_location` | IP 粗定位 |
| `mcp__amap__maps_weather` | 天气查询 |
| `mcp__amap__maps_search_detail` | POI 详情 |
| `mcp__amap__maps_bicycling` | 骑行规划 |
| `mcp__amap__maps_direction_walking` | 步行规划 |
| `mcp__amap__maps_direction_driving` | 驾车规划 |
| `mcp__amap__maps_direction_transit_integrated` | 公交/地铁综合规划 |
| `mcp__amap__maps_distance` | 距离测量 |
| `mcp__amap__maps_text_search` | 关键词 POI 搜索 |
| `mcp__amap__maps_around_search` | 周边 POI 搜索 |

发布或升级前必须重新执行 MCP `tools/list`，不能只依据本表假设上游仍有相同工具。

### 5.2 凭据模型

高德需要区分两类应用 Key：

| 凭据 | 用途 | 是否进入 MCP 子进程 | 是否提供给浏览器 |
| --- | --- | --- | --- |
| `AMAP_MAPS_API_KEY` | Web 服务与官方 MCP | 是 | 否 |
| `AMAP_JS_API_KEY` | Web JS API Loader | 否 | 仅通过临时 bootstrap 提供 |
| `AMAP_JS_SECURITY_CODE` | JS API 安全鉴权 | 否 | 否，由 Host 代理使用 |

不得把 Web 服务 Key 当作 Web JS API Key，也不得因为用户填写一个 Key 就自动复制到另一个字段。

### 5.3 MCP 配置 DTO 的兼容扩展

当前内建服务使用单个 `apiKey`。为 AMap 增加可复用的多凭据表达，同时保留 Tavily/Firecrawl 兼容：

```typescript
type McpSecretPatch = {
  name: string
  value?: string
  clear?: boolean
}

type SaveMcpServerInput = {
  id: string
  enabled: boolean
  autoConnect?: boolean
  apiKey?: string                 // 兼容既有内建服务
  clearApiKey?: boolean           // 兼容既有内建服务
  secrets?: McpSecretPatch[]      // AMap 等多凭据服务
}

type McpSecretState = {
  name: string
  configured: boolean
}

type McpServerSummary = {
  id: string
  displayName: string
  package: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  secretStates: McpSecretState[]
  restartRequired: boolean
}
```

兼容规则：

- Tavily/Firecrawl 继续使用现有 `apiKey` 调用路径，内部可以迁移到通用 secrets 存储。
- AMap 只接受白名单中的三个 secret name。
- 未传 `value` 且 `clear !== true` 时保留旧值。
- `clear: true` 是删除凭据的唯一方式。
- 返回 DTO 只包含名称和 `configured`，不得包含密文、长度、尾号或哈希。

### 5.4 本地保存与 DPAPI 生命周期

`mcp.json` 可以保存 DPAPI 密文，但不能保存明文：

```json
{
  "servers": {
    "amap": {
      "enabled": true,
      "secrets": {
        "AMAP_MAPS_API_KEY": "dpapi:<base64-ciphertext>",
        "AMAP_JS_API_KEY": "dpapi:<base64-ciphertext>",
        "AMAP_JS_SECURITY_CODE": "dpapi:<base64-ciphertext>"
      }
    }
  }
}
```

生命周期：

1. Tauri 命令接收新值。
2. 立即校验名称、空白、长度和字符边界。
3. 使用当前 Windows 用户的 DPAPI 加密。
4. 原子替换 `mcp.json`。
5. 生成 Cordis Patch 时只解密 `AMAP_MAPS_API_KEY`。
6. 通过 Desktop 启动 DSH 时把它注入受控子进程环境。
7. JS Key 和 securityJsCode 只由插件 Host 的 bootstrap/代理读取。
8. 日志、错误、进程 argv、Patch、UI 响应和测试快照全部脱敏。

### 5.5 Cordis Patch

生成的挂载结构应与既有 MCP 客户端一致：

```yaml
- insert:
    - id: dsh-desktop-mcp-amap
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: amap
        transport: stdio
        command: '<desktop-bundled-node.exe>'
        args:
          - '<desktop-bundled-npx-cli.js>'
          - '-y'
          - '@amap/amap-maps-mcp-server@0.0.8'
        env:
          AMAP_MAPS_API_KEY: '${DSH_DESKTOP_MCP_AMAP_API_KEY}'
        failOnStartupError: false
```

约束：

- Patch 中只出现 Desktop 环境变量引用，不出现真实 Key。
- 使用可执行文件加 argv，不通过 shell 拼接命令。
- 不修改系统 PATH，只为 DSH 子进程构造受控环境。
- npm 包首次下载沿用现有 readiness 和缓存诊断。

### 5.6 真实就绪状态

状态分为五层：

```text
configured
  → profileRegistered
  → dependencyReady
  → connected
  → toolsRegistered
```

只有存在至少一个 `mcp__amap__*` 工具时，UI 才显示“高德 MCP 已注入 Harness”。推荐状态：

```typescript
type AmapReadiness = {
  configured: boolean
  credentials: {
    webService: boolean
    jsApi: boolean
    securityCode: boolean
  }
  profileRegistered: boolean
  dependencyReady: boolean
  connected: boolean
  toolCount: number
  tools: string[]
  mapBootstrapReady: boolean
  mapProxyReady: boolean
  restartRequired: boolean
  message: string
}
```

readiness 只在以下时机刷新：

- 进入 MCP 页面。
- 保存高德配置。
- 用户点击“刷新诊断”。
- DSH 重启完成。

不得加入 1.5 秒循环中的高成本 npm/进程检查。

## 6. 地图插件设计

### 6.1 推荐目录

```text
market/amap-map-assistant/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ lib/
│  ├─ index.js
│  ├─ client.js
│  ├─ protocol.js
│  ├─ presentation-schema.js
│  ├─ presentation-tool.js
│  ├─ session-storage.js
│  └─ amap-proxy.js
└─ skills/
   └─ amap-map-assistant/
      ├─ SKILL.md
      └─ references/
         ├─ tool-routing.md
         └─ presentation-contract.md
```

首版不引入前端框架构建步骤。`lib/client.js` 保持 DSH 现有浏览器插件格式，使用 `window.__ModuleLoader__.load`、`require('react')` 和 `React.createElement`。

### 6.2 package.json 草案

```json
{
  "name": "@p-dsh-market/amap-map-assistant",
  "version": "0.1.0",
  "description": "DSH 高德地图查询、搜索与路线规划可视化插件",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "protocolVersion": 1,
    "client": { "platform": "web" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "market": {
      "displayName": "高德地图",
      "capabilities": [
        "skills",
        "host",
        "client",
        "persistent-storage"
      ]
    },
    "desktop": {
      "permissions": [
        "network:outbound",
        "storage:user"
      ]
    }
  }
}
```

插件本身不要求 Tauri 顶栏 `pluginRpc`。中央 `conversation.view`、会话 Header 入口和正文卡片已经能完成导航；避免为了打开 Web 内视图扩大桌面 RPC 白名单。

### 6.3 Host 职责

Host 半负责：

- 注册 `amap-map-assistant` Skill。
- 注册 `amap_present_map` 工具。
- 从 `exec.agent.session.header.id` 获取权威会话 ID。
- 校验并规范化展示状态。
- 原子保存每个会话的当前状态。
- 提供只读 bootstrap 和 state 路由。
- 提供高德 JS API `serviceHost` 安全代理。
- 对日志、错误和 HTTP 响应做凭据脱敏。

Host 不负责：

- 解析聊天正文。
- 代替模型决定何时调用高德 MCP。
- 直接修改会话 JSONL。
- 调用 Tauri 任意命令。
- 把插件的可视化计算作为 MCP 查询结果返回给模型。

### 6.4 Client 职责

Client 半负责：

- 注册四个正式 Cordis slots。
- 加载高德 JS API 2.0。
- 创建、更新和销毁地图实例。
- 渲染 Marker、Polyline、POI 列表和路线摘要。
- 维护中央视图与 Overlay 的打开状态。
- 从 Tool Block 提取 `presentationMeta`，但不从普通文本提取地点。
- 点击正文卡片时打开 Overlay。
- 切换会话时取消旧请求、释放旧监听并载入新状态。

## 7. `amap_present_map` 工具契约

### 7.1 定位

`amap_present_map` 是一个**展示提交工具**，不是另一个地图搜索工具。

它的职责是把已通过高德 MCP 验证的地点和路线转换为稳定的 UI DTO，并产生正文卡片。工具必须在一个正在运行的 DSH 主对话中调用。

### 7.2 输入 Schema

```typescript
type AmapCoordinate = {
  longitude: number
  latitude: number
}

type AmapPlace = {
  id?: string
  name: string
  address?: string
  type?: string
  location: AmapCoordinate
}

type AmapRouteSummary = {
  distanceMeters?: number
  durationSeconds?: number
  costCny?: number
  walkingDistanceMeters?: number
  transfers?: number
  instructions?: string[]
}

type AmapPresentMapInputV1 = {
  schemaVersion: 1
  scene: 'route' | 'places' | 'location'
  title: string
  origin?: AmapPlace
  destination?: AmapPlace
  waypoints?: AmapPlace[]
  mode?: 'driving' | 'transit' | 'walking' | 'bicycling'
  places?: AmapPlace[]
  summary?: AmapRouteSummary
  sourceTools: string[]
  fetchedAt?: string
}
```

约束：

- `schemaVersion` 首版只能为 `1`。
- `scene=route` 必须包含 `origin`、`destination` 和 `mode`。
- `scene=places` 必须包含 1 至 50 个 `places`。
- `scene=location` 必须包含恰好一个 `places` 项，或只使用 `destination`。
- 经纬度必须为有限数值，顺序固定为经度、纬度。
- 首版只接受中国境内可用的 GCJ-02 坐标；若来源坐标系不明，Skill 必须先调用高德地理编码或坐标转换能力。
- `waypoints` 最多 16 个，超出时要求模型分段展示。
- `instructions` 最多 80 项，每项最多 500 字符。
- `title`、地点名称和地址只作为 React 文本节点渲染，不使用 `innerHTML`。
- `sourceTools` 至少一个，且每项必须匹配 `mcp__amap__*` 白名单。
- 工具不接受 API Key、securityJsCode、任意 URL、任意 HTML、任意脚本或文件路径。

### 7.3 输出 Schema

```typescript
type AmapPresentationV1 = AmapPresentMapInputV1 & {
  id: string
  sessionId: string
  revision: number
  createdAt: string
}

type AmapPresentMapResult = {
  schemaVersion: 1
  kind: 'amap-presentation'
  presentation: AmapPresentationV1
  presentationMeta: {
    id: string
    sessionId: string
    scene: 'route' | 'places' | 'location'
    title: string
    revision: number
  }
}
```

Tool output 的文本部分只包含有界摘要；完整 DTO 放在结构化结果或 `presentationMeta` 中，避免模型回答重复吞入大量路线步骤。

### 7.4 幂等与 revision

- 每次成功调用生成新的 `id` 并递增当前会话 `revision`。
- 同一 Tool Call 重放时使用 Tool Call ID 作为幂等键，不能重复递增 revision。
- 后到的较旧 revision 不得覆盖更新状态。
- 卡片始终绑定调用时的 `presentation.id`；用户点击旧卡片时可以查看旧结果，但不会静默把它写成当前状态，除非用户明确点击“设为当前地图”。首版可以不提供该按钮。

## 8. Skill 调用规则

### 8.1 何时使用

Skill 在下列明确需求中启用：

- “搜索附近的咖啡店”。
- “查一下某个地点在哪里”。
- “从 A 到 B 怎么走”。
- “比较驾车和地铁时间”。
- “规划包含多个地点的路线”。
- “把这些地点放到地图上”。

普通地名知识、历史介绍或不需要实时位置数据的问答不强制调用地图。

### 8.2 路线调用顺序

```text
1. 判断起点、终点、城市和出行方式是否明确。
2. 对自然语言地点调用 maps_geo，或对搜索结果调用 maps_search_detail。
3. 若同名 POI 有歧义，先把候选项交给用户选择，不自行猜测。
4. 调用对应的 maps_direction_* 工具。
5. 使用同一份 MCP 结果形成回答摘要。
6. 调用 amap_present_map 提交展示数据。
7. 在最终回答中提示“可点击地图卡片查看”，不声称侧栏已经打开。
```

### 8.3 POI 搜索调用顺序

```text
maps_text_search / maps_around_search
  → 选择需要展示的有限候选
  → 对缺少坐标的候选调用 maps_search_detail
  → amap_present_map(scene='places')
```

官方关键词搜索结果不保证每个版本都返回完整坐标，因此没有坐标的 POI 不得由模型补写。

### 8.4 禁止行为

- 禁止凭语言常识生成经纬度。
- 禁止把 WGS-84、百度 BD-09 坐标直接当成 GCJ-02。
- 禁止在 MCP 失败后仍调用 `amap_present_map` 伪造成功卡片。
- 禁止把 IP 定位当作用户当前位置或精确起点。
- 禁止通过普通文本、Markdown 链接或隐藏标记控制客户端 UI。
- 禁止为了显示地图而重复调用同一查询，除非上游结果缺少展示必需字段。

## 9. 会话状态与持久化

### 9.1 保存位置

地图状态属于用户级插件数据，不属于业务工作区：

```text
%LOCALAPPDATA%/dsh-desktop/plugin-data/amap-map-assistant/
├─ sessions/
│  ├─ <sha256(session-id)>.json
│  └─ ...
└─ index.json
```

文件名使用 Session ID 的哈希，不把未校验字符串直接拼进路径。

### 9.2 保存内容

只保存：

- 展示 DTO。
- 会话 ID 或其安全索引。
- revision、创建时间和更新时间。
- 来源工具名。
- 有界路线摘要与点位。

不保存：

- API Key 或任何凭据。
- 完整对话正文。
- MCP 原始未裁剪响应。
- 用户实时位置或位置轨迹。
- 高德瓦片、脚本或缓存资源。

### 9.3 原子写入

- 先写同目录临时文件，再原子替换目标文件。
- 单文件设置大小上限，推荐 512KB。
- 同一会话写入串行化。
- 保留最近一次有效文件；解析失败时返回可诊断错误，不覆盖损坏文件。
- 插件卸载时由用户选择是否保留插件数据；首版不自动删除用户状态。

## 10. Host HTTP API

### 10.1 Bootstrap

```http
GET /amap-map/bootstrap
```

成功响应：

```json
{
  "configured": true,
  "jsApiReady": true,
  "jsApiKey": "<ephemeral-js-api-key>",
  "version": "2.0",
  "serviceHost": "http://127.0.0.1:<dsh-port>/amap-map/_AMapService",
  "mcp": {
    "connected": true,
    "toolCount": 12
  }
}
```

说明：

- Web JS API Key 按高德前端机制会出现在 Loader 请求中，不能宣称它对浏览器不可见。
- 它不得进入持久化前端 Store、日志、错误文本或 DOM 属性。
- `securityJsCode` 永不返回给浏览器。
- 响应设置 `Cache-Control: no-store`。

### 10.2 当前会话状态

```http
GET /amap-map/state?sessionId=<id>
```

响应：

```json
{
  "state": null,
  "revision": 0
}
```

或：

```json
{
  "state": {
    "schemaVersion": 1,
    "id": "map_...",
    "sessionId": "...",
    "revision": 3,
    "scene": "route",
    "title": "北京南站到国家大剧院",
    "origin": {},
    "destination": {},
    "mode": "driving",
    "summary": {},
    "sourceTools": ["mcp__amap__maps_direction_driving"],
    "createdAt": "2026-08-25T00:00:00.000Z"
  },
  "revision": 3
}
```

Host 必须确认请求的 Session 是调用者当前可访问的会话，不能把任意 Session ID 当作开放文件读取接口。

### 10.3 JS API 安全代理

```http
ANY /amap-map/_AMapService/*
```

代理规则：

- 只实现高德 `serviceHost` 协议所需路径。
- 上游 Host 固定为高德官方允许域名，不接受客户端传入目标域名、协议或端口。
- Host 端附加 securityJsCode，不转发客户端伪造的同名参数。
- 限制方法、请求体、响应大小、并发和超时。
- 删除 Cookie、Authorization、Proxy-* 和不需要的转发头。
- 日志只记录路径类别、状态码、耗时和响应大小，不记录 query、请求体或密钥。
- 上游失败返回稳定错误码，不把完整上游 URL 回显给浏览器。
- 具体转发路径在实施前按高德官方 JS API 2.0 安全代理说明做一次网络抓包和契约测试，禁止实现通用开放代理。

## 11. 地图渲染

### 11.1 在线加载

高德 JS API 只允许在线加载。客户端初始化顺序：

```text
GET /amap-map/bootstrap
  → 检查 jsApiReady
  → window._AMapSecurityConfig = { serviceHost }
  → 在线加载 https://webapi.amap.com/loader.js
  → AMapLoader.load({ key: jsApiKey, version: '2.0', plugins: [...] })
  → 创建 AMap.Map
```

Loader Promise 在页面级缓存，中央视图和右侧面板复用同一次脚本加载；每个容器仍使用独立 Map 实例。

### 11.2 点位展示

- `location`：单 Marker，默认缩放到地点周边。
- `places`：最多 50 个 Marker，使用编号或短标签与结果列表对应。
- 点击 Marker 只更新插件内选中态和详情卡，不修改会话。
- 名称、地址和类型使用文本节点，不渲染 MCP 返回的 HTML。
- 搜索结果为空时保留查询摘要并显示“高德未返回可展示点位”。

### 11.3 路线展示

展示数据分为两层：

1. **回答事实层**：距离、时间、费用、换乘和步骤来自 MCP 结果。
2. **地图图形层**：优先使用展示 DTO 中可靠的路径点；如果官方 MCP 未返回 Polyline，则使用高德 JS API 对同一组起终点生成“地图预览路线”。

当使用 JS API 重新计算图形时必须显示：

```text
地图线路为同一组起终点的可视化预览；
文字距离与时间以本次 MCP 查询结果为准，二者可能因实时路况和接口版本略有差异。
```

不得用 JS API 预览结果静默替换模型已引用的 MCP 摘要。

### 11.4 出行方式切换

- 当前 MCP 已查询的方式标记为“本次结果”。
- 用户在地图 UI 切换到其他方式时，只生成临时可视化预览，不写回聊天、不改变 MCP 事实。
- 若用户需要新的权威比较，UI 提供“回到对话查询此方式”的可编辑草稿；首版不得自动发送。

### 11.5 高德导航链接

- 只在用户点击后生成或打开。
- 使用起终点名称、经纬度和出行方式构造受控高德 URI/网页链接。
- 固定允许 `https://uri.amap.com/` 等官方目标；禁止使用模型提供的任意 URL。
- 打开前显示目标名称；无有效经纬度时禁用按钮。

## 12. 页面状态机

```text
unconfigured
  → configured-restart-required
  → mcp-starting
  → mcp-ready-map-unavailable
  → ready-empty
  → loading-state
  → ready-location | ready-places | ready-route
  → panel-open
```

错误态独立覆盖：

```text
mcp-unavailable
map-loader-failed
map-proxy-failed
invalid-presentation
upstream-rate-limited
route-not-found
state-load-failed
```

状态规则：

- MCP 不可用时保留已有地图状态只读展示。
- JS API 不可用时保留正文摘要、POI 列表和路线步骤，不显示空白画布。
- 状态读取失败不得清空已渲染的 Tool Card。
- 旧会话请求完成后不得覆盖新会话 Store；所有异步载入带 request token。
- Tool 执行成功不会把 Overlay 状态改为 `open`。

## 13. Theme 与布局

- 使用 DSH `--dsw-*` 语义变量，不硬编码产品背景、文字和边框颜色。
- 地图画布本身允许使用高德官方地图样式；周围工具栏、卡片、详情和浮层必须跟随 DSH Theme。
- 覆盖亮色、暗色、跟随系统和已安装 Theme Pack。
- 自定义 Theme Pack 规则放在基础 light/dark 规则之后，避免被默认主题覆盖。
- 窄于 800px 时右侧详情区域移到地图下方；Overlay 宽度不超过视口。
- `prefers-reduced-motion` 下关闭非必要面板动画。
- 所有按钮具有可见焦点、键盘操作和 `aria-label`。

## 14. 失败降级与错误文案

| 场景 | 行为 |
| --- | --- |
| 高德 MCP 未启用 | 地图页显示如何前往 MCP 管理页；已有地图可只读查看 |
| 三项凭据不完整 | 禁止启用，逐项提示缺失，不清除已保存项 |
| 保存后未重启 | 显示“配置已保存，重启后注册工具” |
| MCP 连接但无工具 | 显示工具注册失败和日志入口，不显示“已就绪” |
| 地名有多个候选 | 模型要求用户选择，不默认取第一个 |
| POI 无坐标 | 不进入展示 DTO；必要时调用详情或地理编码补足 |
| 路线无结果 | 保留起终点和高德错误摘要，不画直线冒充路线 |
| JS API Loader 失败 | 展示文本摘要、地点列表、重试按钮和诊断信息 |
| serviceHost 代理失败 | 不退回浏览器明文 securityJsCode 模式 |
| 上游限流 | 显示可重试提示，不进行无限重试 |
| 状态文件损坏 | 隔离损坏文件、保留 Tool Card、显示恢复提示 |
| 插件未安装 | 高德 MCP 仍可供模型使用，只缺少地图卡片和页面 |

## 15. 安全与隐私边界

### 15.1 凭据

- 三项凭据仅在用户主动保存时进入 Tauri。
- 使用 Windows 当前用户 DPAPI 加密。
- 不在 Rust Debug、Node logger、浏览器 Console、测试快照或崩溃文本中输出。
- 子进程只接收 Web 服务 Key；地图 Host 只读取 JS Key 和 securityJsCode。
- 删除或停用服务后不得继续向新进程注入 Key。

### 15.2 地图代理

- 固定官方域名和路径，不实现 SSRF 入口。
- 拒绝非预期方法、超大 body、重定向到非官方域名和协议降级。
- 设置连接、首字节和完整响应超时。
- 限制并发，避免模型或 UI 循环刷新耗尽高德额度。

### 15.3 模型和内容

- 所有坐标必须来自高德工具或用户明确提供并经校验。
- 不信任 MCP 返回的字符串；只作为文本展示。
- 不允许模型通过 `amap_present_map` 注入链接、HTML、脚本或本地路径。
- 展示工具必须验证 `exec.agent.session.header.id`，拒绝无会话调用和子 Agent 越权写入主会话状态。

### 15.4 位置隐私

- IP 定位只视为城市级提示。
- 用户选择当前位置前显示浏览器权限说明；首版默认不申请 Geolocation 权限。
- 不建立历史轨迹，不把地点用于遥测或训练。
- 打开外部高德链接前由用户明确点击。

## 16. 实施阶段

### 阶段一：宿主契约与上游基线

- 使用当前 Runtime 执行 `cordis_inspect`，确认四个 slots 的模式、Props 和占用者。
- 启动固定版本官方 MCP，保存 `tools/list` 的 12 项 Schema fixture。
- 验证 Desktop 托管 Node/npm 能启动该包。
- 验证高德 JS API 2.0 Loader 和 `serviceHost` 代理请求形态。

### 阶段二：Desktop 内建 MCP

- 增加 AMap `ServerDefinition` 和三凭据 UI。
- 扩展通用多凭据 DTO 与 DPAPI 存储。
- 生成 stdio Cordis Patch 和受控进程环境。
- 扩展 readiness、实际工具状态和日志脱敏测试。

### 阶段三：插件 Host

- 创建市场包、Cordis Patch 和 Skill。
- 实现 `amap_present_map` Schema、执行器和 presentationMeta。
- 实现会话状态存储、revision、幂等和只读 state API。
- 实现 bootstrap 与受限 AMap `serviceHost` 代理。

### 阶段四：插件 Client

- 注册 `conversation.view`、Header Action、Tool View 和 Overlay。
- 实现 Loader 单例、地图实例生命周期和 Theme。
- 实现地点、POI、路线、摘要和错误降级。
- 实现卡片点击打开 Overlay，并确认工具完成时不会自动打开。

### 阶段五：联动与集成验收

- 用真实会话验证 MCP → `amap_present_map` → 卡片 → Overlay → 中央视图完整链路。
- 覆盖会话切换、刷新、重启、插件缺失和 MCP 停止。
- 在真实高德 Key 下执行受控 smoke，记录额度和上游错误。
- 最后再决定是否 link 安装、打包或发布；这些操作不属于本文档阶段。

## 17. 测试计划

### 17.1 Rust / Desktop

- AMap 默认关闭。
- 三项凭据缺一时不能启用。
- DPAPI 往返成功，磁盘文件没有明文。
- 空输入保留旧凭据，`clear=true` 才删除。
- Cordis Patch 只包含环境变量引用。
- argv 使用固定版本官方包和托管 Node/npm。
- 日志和错误不会输出任何凭据。
- readiness 区分配置、挂载、连接和工具注册。
- 实际工具列表只统计 `mcp__amap__*`。
- 既有 Tavily、Firecrawl、Chrome 配置兼容不回归。

### 17.2 插件 Host

- 三种 scene 的有效 Schema。
- route 缺起点、终点或 mode 时拒绝。
- 空 POI、超限 POI、超限途经点、NaN 和反序经纬度拒绝。
- 非 `mcp__amap__*` sourceTools 拒绝。
- HTML、脚本、URL 和超长文本作为普通文本裁剪或拒绝。
- 主会话 ID 绑定、子 Agent 和无会话调用拒绝。
- Tool Call 重放幂等，revision 单调递增。
- 状态原子写、并发写、损坏恢复和大小上限。
- bootstrap 不返回 securityJsCode。
- 代理 Host、路径、方法、头、重定向和响应大小白名单。

### 17.3 插件 Client

- `conversation.view` 与思维导图同级显示。
- Header Action 进入当前会话地图。
- Tool View 对三种 scene 渲染正确。
- Tool 完成后 Overlay 保持关闭。
- 点击“在地图中查看”后打开正确卡片对应的地图。
- 中央视图和 Overlay 共享状态但使用独立 Map 实例。
- 切换会话不串状态，旧异步响应不覆盖新会话。
- Loader 失败、代理失败和 MCP 不可用时有文本降级。
- Map 实例卸载时销毁，事件和 Observer 无泄漏。
- 亮色、暗色、系统和 Theme Pack 均可读。
- 窄屏和键盘操作可用。

### 17.4 联动场景

| 场景 | 预期工具链 | 地图结果 |
| --- | --- | --- |
| 查询单地点 | `maps_geo` → `amap_present_map(location)` | 单 Marker |
| 关键词搜索 | `maps_text_search` → 必要的 `maps_search_detail` → `amap_present_map(places)` | 多 Marker + 列表 |
| 周边搜索 | `maps_geo` → `maps_around_search` → 详情补坐标 → `amap_present_map(places)` | 半径内点位 |
| 驾车规划 | 地理编码 → `maps_direction_driving` → `amap_present_map(route)` | 驾车路线 |
| 公交规划 | 地理编码 → `maps_direction_transit_integrated` → 展示工具 | 换乘摘要和路线 |
| 步行规划 | 地理编码 → `maps_direction_walking` → 展示工具 | 步行路线 |
| 骑行规划 | 地理编码 → `maps_bicycling` → 展示工具 | 骑行路线 |
| 工具失败 | MCP Error，不调用展示工具 | 错误文本，无空卡片 |

### 17.5 推荐验证命令

实现后执行：

```powershell
npm run check
npm test
npm run catalog:validate
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm pack --dry-run --json .\market\amap-map-assistant
git diff --check
```

上述验证只能证明源码、契约和包内容。以下必须单独记录，不得由单元测试替代：

- 真实高德 Web 服务 Key 的 MCP 调用。
- 真实 Web JS API Key 和安全代理的在线地图加载。
- 安装到真实 Web Profile 后的 slots 与主题表现。
- DSH 重启后的工具注册与会话状态恢复。

## 18. 验收标准

### 18.1 MCP

- 高德默认关闭，用户可在现有 MCP 页面统一配置三项凭据。
- 磁盘、Patch、日志和 UI 响应不存在明文凭据。
- 重启后实际注册官方高德工具，页面显示真实数量和工具名称。
- 配置存在但连接或工具注册失败时，页面不会显示“已注入”。

### 18.2 地图入口

- 地图出现在与脑图/思维导图相同的中央 `conversation.view` 区域。
- 正文展示工具卡片使用正式 `tool.call.toolview`。
- 右侧面板使用正式 `shell.overlay`。
- 不依赖 DOM selector、普通文本扫描或任意 Tauri RPC。

### 18.3 交互

- 地点、POI 搜索和四类路线都有可视化结果。
- `amap_present_map` 完成后不会自动打开侧栏。
- 只有用户点击卡片按钮才打开右侧地图。
- 切换会话时状态不串联，刷新和重启后可恢复当前地图。
- JS API 不可用时仍能阅读 MCP 文本结果。

### 18.4 安全

- securityJsCode 只存在于 DPAPI 密文和 Host 内存中。
- 地图代理不能访问任意上游。
- 模型不能提交任意 HTML、脚本、链接或文件路径。
- 不采集持续定位，不保存轨迹，不自动唤起外部应用。

## 19. 风险与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 官方 MCP 工具 Schema 或输出变化 | 固定 `0.0.8`，保存 fixture，升级前重新 `tools/list` |
| 官方 MCP 部分路线不返回 Polyline | 图形层使用同端点 JS API 预览，并明确区分 MCP 事实和预览 |
| JS API Key 与 Web 服务 Key 混用 | UI 分成三项独立凭据，禁止自动复制 |
| securityJsCode 泄漏 | DPAPI + Host `serviceHost` 代理，拒绝浏览器明文降级 |
| 配置成功但 MCP 未注入 | 查询 bridge 工具表，按命名空间确认真实注册 |
| 模型臆造坐标 | Skill 强制先查 MCP，Host 校验来源工具和坐标 |
| 普通回答误触发地图 | 只响应 `amap_present_map` Tool Block |
| Overlay 干扰对话 | 工具只生成卡片，用户点击后才打开 |
| 会话切换状态串联 | Session ID 分区、request token、revision fencing |
| 地图脚本或事件泄漏 | Loader 单例，Map/Observer/事件按组件生命周期释放 |
| 上游额度耗尽 | 有界结果、避免自动刷新、有限重试和明确限流错误 |

## 20. 实施前必须重新确认

实施开始前必须使用当前安装的 DSH Runtime 重新确认：

1. `conversation.view` 的注册模式、Props 和视图切换行为。
2. `conversation.session.header.actions` 是否提供当前 Session ID 和正式导航能力。
3. `tool.call.toolview` 的 key 是否使用完整 DSH Tool 名 `amap_present_map`，以及 Tool Block 的结构。
4. `shell.overlay` 的层级、卸载时机和与其他 Overlay 的共存规则。
5. `exec.agent.session.header.id` 在当前 Runtime 中的稳定性。
6. `@deepseek-ai/dsh-mcp-client` 对 stdio env、启动错误和工具命名的实际行为。
7. 高德官方 `0.0.8` 的实时 `tools/list` 与输出结构。
8. 高德 JS API 2.0 当前 `serviceHost` 代理的请求协议和官方允许域名。

如果 Runtime 或高德上游与本文不同，应更新契约适配层和测试 fixture；不得通过扫描 DSH DOM、放宽代理或关闭来源校验绕过差异。

## 21. 官方参考

- [高德地图 MCP Server 概述](https://developer.amap.com/api/mcp-server/summary)
- [快速接入高德地图 MCP Server](https://lbs.amap.com/api/mcp-server/gettingstarted)
- [高德地图 Web 服务 API](https://lbs.amap.com/api/webservice/gettingstarted)
- [搜索 POI](https://lbs.amap.com/api/webservice/guide/api/search/)
- [路径规划](https://lbs.amap.com/api/webservice/guide/api/direction)
- [路径规划 2.0](https://lbs.amap.com/api/webservice/guide/api/newroute)
- [地图 JS API 2.0 加载](https://lbs.amap.com/api/javascript-api-v2/guide/abc/load)
- [JS API 安全密钥使用](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)
- [地图 JS API 路径规划](https://lbs.amap.com/api/javascript-api-v2/guide/services/navigation)
- [Polyline](https://lbs.amap.com/api/javascript-api-v2/guide/amap-line/poly-line)
- [Marker](https://lbs.amap.com/api/javascript-api-v2/guide/amap-marker/default-marker)

## 22. 最终推荐方案

首版最终链路为：

```text
Desktop MCP 页面统一配置三项高德凭据
  → DPAPI 加密
  → Desktop 托管 Node/npm 启动固定版本官方高德 MCP
  → 实际注册 mcp__amap__* 工具
  → 模型通过 Skill 先查询真实地点和路线
  → amap_present_map 提交会话级展示 DTO
  → 正文只显示地图卡片
  → 用户点击卡片
  → 右侧地图面板打开
  → 同一状态也可在中央“地图”conversation.view 中查看
```

该方案把“地图事实查询”和“地图 UI 展示”明确分层，同时保留一个受控的展示工具作为二者的联动点。它满足规划、查询、搜索、地图嵌入和地点转移 Hook 的需求，又避免普通文本误触发、密钥泄漏、会话串联和插件绕过正式宿主接口。
