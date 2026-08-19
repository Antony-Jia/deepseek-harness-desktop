# DSH AKShare 对话行情与 K 线分析插件实施方案

> 状态：首版已实现并完成本地静态/单元验证；打包 sidecar 已通过启动与健康检查，但本机对 Eastmoney 行情 API 的联网 smoke 被上游 TLS 连接断开阻断；真实 DSH 集成测试待上传后执行  
> 文档版本：0.2  
> 日期：2026-08-19  
> 目标：以一个同时包含 Skill、宿主插件、浏览器插件和 Windows sidecar 的 DSH 市场包，为对话提供 A 股/港股实时行情、历史行情、K 线和基础技术指标分析，并允许把当前会话的一份分析结果在对话卡片与右侧悬浮面板之间联动展示。

## 1. 结论

该功能适合实现为 **Skill + DSH Tool + AKShare sidecar + 对话内 Tool View + 右侧悬浮面板**，而不是让模型直接运行任意 Python、把 AKTools 的通用动态接口整体暴露出来，或只在回复中插入临时图片。

推荐首版交付一个市场插件：

```text
@p-dsh-market/akshare-market-analysis
```

同一个 npm 包负责：

- 注册一个金融行情 Skill，约束模型何时查询、如何解释、如何披露数据时间与复权方式。
- 注册三项模型工具：行情筛选、历史数据、技术分析。
- 启动只监听本机回环地址的 AKShare 可执行 sidecar。
- 在 `tool.call.toolview` 中渲染实时行情表或交互式 K 线图。
- 在 Tauri 外框顶栏提供“行情”入口。
- 在 DSH Web 的 `shell.overlay` 中渲染右侧悬浮分析面板。
- 每个会话只维护一个“当前分析”，新分析替换当前内容，不建设自选股、组合、预警或多卡片看板。

首版业务范围严格限定为：

- A 股实时行情，支持受控字段筛选。
- A 股历史行情，支持日线、周线、月线。
- 港股实时行情；必须明确标注数据源可能存在约 15 分钟延迟，不宣传为交易所逐笔实时数据。
- 港股历史行情，支持日线、周线、月线。
- 基于历史 OHLCV 的有限技术指标与描述性分析。

## 2. 需求边界

### 2.1 本期包含

#### 行情查询

- A 股全市场快照与单只股票查询。
- A 股快照筛选：代码、名称、价格区间、涨跌幅区间、成交量下限、成交额下限、换手率区间。
- 港股全市场快照与单只股票查询。
- 港股快照筛选：代码、名称、价格区间、涨跌幅区间、成交量下限、成交额下限。
- 查询结果分页或限量，模型和 UI 默认不接收全市场完整表。

#### 历史数据

- 市场：`a-share | hk`。
- 周期：`daily | weekly | monthly`。
- 日期范围：显式起止日期；未给定时使用受控默认值。
- 复权：`none | qfq | hfq`，默认值必须在回复和图表标题中展示。
- 标准化输出字段：交易日、开盘、最高、最低、收盘、成交量、成交额、涨跌幅、换手率；源数据缺失字段允许为 `null`，不得伪造。

#### 技术分析

- 均线：SMA5、SMA10、SMA20、SMA60。
- MACD：EMA12、EMA26、DEA9、柱体。
- RSI14。
- BOLL20，标准差倍数 2。
- 成交量均线：VMA5、VMA10。
- ATR14，用于描述近期波动，不生成仓位建议。
- 近 20/60 周期高低点，用于描述观察区间，不将其表述为确定支撑或压力。
- 生成有限、可追溯的描述性结论：趋势、动量、波动、量价和数据质量提示。

#### UI

- 实时行情 Tool View：紧凑表格、筛选条件、抓取时间、来源和结果数量。
- 历史/分析 Tool View：K 线、成交量、均线和指标切换。
- Tool View 内提供“在右侧打开”按钮。
- Tauri 顶栏提供“行情”按钮；点击后打开当前会话最新分析。
- 右侧悬浮面板使用 `shell.overlay`，形态参考现有文件夹面板，但内容仅属于当前会话。
- 切换会话时切换当前分析；无分析时显示明确空状态。
- 新分析完成后更新“当前分析”，但默认不强制弹开右侧面板。

### 2.2 明确不包含

- 下单、模拟交易、账户、持仓、盈亏或券商连接。
- 买入、卖出、目标价、收益保证或个性化投资建议。
- 分钟线、逐笔、Level-2、盘口队列和 WebSocket 推送。
- 美股、期货、基金、指数和宏观数据；参考项目已有这些方向，但不进入本期。
- 自选股、组合、多窗口、多图联动、行情预警和后台定时刷新。
- 任意 AKShare 函数名调用、任意 Python 表达式、任意查询参数透传。
- 直接把原版 AKTools 的 `/api/public/{item_id}` 作为插件接口。
- 在 npm 安装阶段运行 Python 或下载未声明的远程可执行文件。
- 将用户查询、股票代码或行情结果用于训练、遥测或外部上报。

## 3. 参考项目吸收与修正

参考：[openclaw-akshare-skill 实现总结](https://github.com/succ985/openclaw-akshare-skill/blob/master/scripts/IMPLEMENTATION_SUMMARY.md)。

### 3.1 可以吸收

- 四个核心数据入口：A 股实时、A 股历史、港股实时、港股历史。
- 对网络错误做有限重试。
- 将函数名和规范化参数组成缓存键。
- 日线、周线、月线与前复权、后复权、不复权的参数表达。
- 将 Pandas DataFrame 转成 JSON/CSV 的标准化出口。
- 用 fixture 做无网络测试，用显式 smoke 做联网测试。

### 3.2 不直接照搬

| 参考实现 | 本方案调整 |
| --- | --- |
| 一个 700 行以上 CLI 负责所有市场 | 只保留 A 股与港股，并拆分 sidecar 数据层、DSH Tool 层和 UI 层 |
| 接受 `filter_field` / `filter_value` | 改成宿主定义的筛选字段和操作符白名单 |
| 缓存写入 `~/.akshare_cache` | 改为宿主分配的插件 cache 目录，禁止写入包目录和不透明用户目录 |
| Parquet + pyarrow | 首版使用 SQLite 或 gzip JSON，避免为了缓存引入体积较大的 pyarrow |
| 固定 24 小时缓存 | 实时行情与历史行情使用不同 TTL，并对当日历史数据缩短 TTL |
| 在控制台打印重试过程 | 返回结构化错误、重试次数、数据源和时间戳，由 Tool View 展示 |
| CLI 输出整张表 | DSH Tool 返回有界 DTO，完整结果仅在用户明确导出时写文件 |
| 依赖用户本机 Python | 随插件分发 Windows x64 可执行 sidecar，用户无需安装 Python |
| Skill 展示直接运行 Python 示例 | Skill 只允许模型调用已注册的 DSH 工具，不指导模型执行任意代码 |

参考仓库使用 MIT License；如果实现阶段复制了有实质性的代码或文档段落，发布包必须保留其版权与 MIT 许可声明。优先重新实现有限功能，只借鉴接口边界和测试思路。

## 4. 用户体验

### 4.1 查询实时行情

用户：

```text
帮我看看今天 A 股银行股，涨幅 0 到 5%，成交额大于 5 亿，列前 20 个。
```

模型调用：

```json
{
  "market": "a-share",
  "query": "",
  "filters": {
    "changePct": { "gte": 0, "lte": 5 },
    "amount": { "gte": 500000000 }
  },
  "sort": { "field": "amount", "direction": "desc" },
  "limit": 20
}
```

说明：首版不应假设 `stock_zh_a_spot_em()` 固定提供“行业”字段。行业筛选只有在增加受控行业映射数据源并完成字段校验后才能开启；否则模型应解释当前只能按名称或行情数值筛选。

对话中显示一张行情表卡片，最终回答只总结显著事实，并注明：

- 抓取时间。
- 数据源。
- 筛选条件。
- 返回条数与是否截断。
- 港股行情的延迟说明。

### 4.2 查询历史行情

用户：

```text
看看腾讯 00700 最近一年的周线。
```

模型调用历史工具，Tool View 显示周 K、成交量和复权方式。最终回答描述区间涨跌、振幅和阶段高低点，不自动输出买卖结论。

### 4.3 技术分析

用户：

```text
分析一下 600519 最近 240 个交易日，看看均线、MACD、RSI 和布林带。
```

分析卡片包含：

- 主图：K 线、SMA5/10/20/60、BOLL。
- 副图：成交量/VMA、MACD、RSI、ATR，按 tab 切换。
- 摘要：最新收盘价、区间涨跌、近 20/60 周期高低点、指标状态。
- 元信息：市场、代码、名称、周期、复权、数据区间、抓取时间、AKShare 版本。
- 操作：“在右侧打开”“复制摘要”“导出 CSV”（导出可作为第二阶段开关）。

最终回答依据同一份快照生成，不能在卡片数据与文字结论之间重新抓取数据。

### 4.4 顶栏与右侧悬浮面板

交互规则：

1. 插件安装、启用、协议兼容且已激活时，Tauri 顶栏显示“行情”按钮。
2. 点击 Tool View 的“在右侧打开”，将该 Tool call 对应的分析设置为当前会话的活动分析，并打开面板。
3. 点击顶栏“行情”按钮：
   - 当前会话已有活动分析：切换面板开关。
   - 当前会话只有历史分析、没有显式活动项：打开最近一次成功分析。
   - 当前会话没有分析：打开空状态，提示用户在对话中查询股票。
4. 新分析完成后替换“最近分析”，但若用户正在查看旧分析，不强制跳转；可以显示“有新分析”提示。
5. 切换会话时面板读取目标会话的活动分析；不得显示上一会话的股票内容。
6. 面板同一时刻只显示一份分析，不建立多标签页和分析历史列表。
7. 关闭面板只改变 UI 状态，不删除对话结果或缓存。

面板建议宽度 `420–620px`，支持拖动调整并限制在可用视口内；窄屏下切换为覆盖式抽屉。布局和 z-index 复用现有 `shell.overlay` 约定，不直接操作产品 DOM。

## 5. 总体架构

```text
┌──────────────────────────────────────────────────────────────────┐
│ DSH Agent                                                        │
│  Skill → 选择工具 → 生成基于同一快照的说明                         │
└──────────────────────────────┬───────────────────────────────────┘
                               │ ctx.tools.register
┌──────────────────────────────▼───────────────────────────────────┐
│ 插件宿主半 lib/index.js                                          │
│  tools / skills / subprocess / webServer / lifecycle / cache proxy│
└───────────────┬─────────────────────────────┬────────────────────┘
                │ JSON HTTP, loopback         │ Tool result + meta
┌───────────────▼──────────────────┐  ┌───────▼────────────────────┐
│ akshare-service.exe             │  │ 插件浏览器半 lib/client.js │
│ AKShare + normalization + TA    │  │ toolview + overlay + store │
│ cache + retry + health          │  │ Canvas/SVG K 线            │
└───────────────┬──────────────────┘  └───────────┬────────────────┘
                │                                 │
        外部公开财经数据源                 DSH 对话卡片 / 右侧悬浮面板
```

### 5.1 为什么使用 sidecar

- AKShare 和 Pandas 属于 Python 生态，不应在 Node 插件中重写。
- 独立进程可以被 DSH 超时、终止和重启，崩溃不会直接带走宿主进程。
- 可执行分发避免要求普通用户安装 Python。
- HTTP/JSON 协议便于做 schema、健康检查、限流和版本诊断。
- 与 DLL 相比，sidecar 避免 CPython ABI、Node N-API、Rust FFI 和进程内崩溃传播。

### 5.2 网络边界

- sidecar 只绑定 `127.0.0.1` 的随机端口，不监听 `0.0.0.0`。
- sidecar 启动后在 stdout 输出一条有界的 ready JSON，包含端口、协议版本和进程 nonce，不输出访问令牌。
- 宿主生成随机 token，通过环境变量传给 sidecar；浏览器端永远看不到 sidecar token。
- 浏览器只访问 DSH 宿主注册的插件路由；宿主将白名单请求代理到 sidecar。
- 不允许用户选择监听地址、端口、上游 URL 或任意 AKShare 函数名。
- 企业严格内网环境必须配置允许访问的上游站点或内部行情网关；完全阻断公网时该插件进入明确离线状态。

## 6. npm 插件包设计

### 6.1 建议目录

```text
@p-dsh-market/akshare-market-analysis
├─ package.json
├─ LICENSE
├─ THIRD_PARTY_NOTICES.md
├─ README.md
├─ cordis.patch.yml
├─ lib/
│  ├─ index.js                   # 宿主半
│  ├─ client.js                  # 浏览器半
│  ├─ schemas.js                 # 工具输入/输出 schema
│  └─ protocol.js                # sidecar DTO 与版本
├─ skills/
│  └─ akshare-market-analysis/
│     ├─ SKILL.md
│     └─ references/
│        ├─ data-contract.md
│        └─ analysis-rules.md
├─ python-sidecar/              # 独立 Python/uv 工程，仅用于开发、测试和打包
│  ├─ .python-version           # 固定 Python 3.11
│  ├─ pyproject.toml
│  ├─ uv.lock
│  ├─ README.md
│  ├─ src/
│  │  └─ akshare_service/
│  │     ├─ __init__.py
│  │     ├─ main.py
│  │     ├─ adapters/
│  │     ├─ indicators/
│  │     └─ protocol/
│  ├─ tests/
│  │  ├─ fixtures/
│  │  └─ unit/
│  └─ akshare-service.spec      # PyInstaller onedir 配置
├─ runtime/
│  └─ win32-x64/
│     ├─ akshare-service.exe
│     ├─ python311.dll
│     └─ ...                     # PyInstaller onedir 依赖
├─ client-vendor/
│  └─ chart-runtime.js           # 经许可审计并打入 client bundle
└─ tests/
   ├─ fixtures/
   └─ contract/
```

首版只发布 Windows x64。后续如支持其他平台，应拆成可选平台运行时包，避免所有用户下载所有二进制。

### 6.2 `package.json.dsh` 目标声明

以下为目标形态，字段中的新增权限和 `pluginRpc` 路由需要按第 12 节先补齐宿主能力：

```json
{
  "name": "@p-dsh-market/akshare-market-analysis",
  "version": "0.1.0",
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
      "displayName": "AKShare 行情分析",
      "capabilities": [
        "skills",
        "host",
        "client",
        "desktop-shell",
        "persistent-storage"
      ]
    },
    "desktop": {
      "permissions": [
        "shell:titlebar",
        "process:execute-bundled",
        "network:outbound",
        "storage:user",
        "storage:cache"
      ],
      "contributes": {
        "titlebarActions": [
          {
            "id": "toggle-market-analysis",
            "slot": "desktop.titlebar.workspaceActions",
            "label": "行情",
            "icon": "chart-candlestick",
            "order": 120,
            "when": ["dshRunning", "pluginActive", "restartNotRequired"],
            "action": {
              "type": "pluginRpc",
              "method": "akshare.toggleAnalysisPanel"
            }
          }
        ]
      }
    }
  }
}
```

不得使用 `preinstall`、`install` 或 `postinstall` 下载/启动 sidecar。所有运行文件必须在 `npm pack --dry-run --json` 中可见，并接受路径、大小和平台校验。

## 7. Skill 设计

### 7.1 Skill 名称与触发条件

建议名称：`akshare-market-analysis`。

触发场景：

- 用户询问 A 股或港股当前行情、涨跌、成交量、成交额、筛选或排行。
- 用户询问单只 A/H 股票历史日线、周线、月线或 K 线。
- 用户要求均线、MACD、RSI、布林带、成交量、ATR 等技术分析。
- 用户要求将分析在图表或右侧面板打开。

不触发：

- 账户持仓、下单、交易执行。
- 非 A/H 市场。
- 只问通用金融概念且不需要市场数据。

### 7.2 Skill 核心约束

- 只能调用本插件注册的工具，不运行任意 Python、curl 或 shell。
- 行情查询优先使用实时工具；技术分析必须使用历史/分析工具，不能从实时快照推断趋势。
- 用户未给股票市场时，根据代码格式做候选判断；存在歧义时先澄清，不静默猜测。
- 港股代码规范化为 5 位字符串，保留前导零。
- A 股代码规范化为 6 位字符串，保留前导零。
- 所有时间、周期、复权和数据延迟必须进入答案。
- 分析基于数据描述，不生成确定性买卖建议。
- 数据不足时明确报告指标不可计算，不用较短窗口冒充完整指标。
- 工具失败时解释数据源不可用，不根据记忆填充最新价格。
- 最终回答引用工具返回的 `analysisSummary`，不得自行重新计算出不一致数值。

### 7.3 建议回答结构

```markdown
当前数据概览……

- 趋势：……
- 动量：……
- 波动：……
- 量价：……
- 需要留意：……

图表已显示在本次工具卡片中，也可以点击“在右侧打开”。

数据时间：……；周期：……；复权：……；来源：……。
以上为历史数据与技术指标的描述性分析，不构成投资建议。
```

## 8. DSH 工具协议

### 8.1 工具划分

#### `akshare_market_snapshot`

用途：A 股/港股实时市场快照、单股查询和筛选。

核心参数：

```json
{
  "market": "a-share | hk",
  "query": "代码或名称，可空",
  "filters": {
    "price": { "gte": 0, "lte": 0 },
    "changePct": { "gte": 0, "lte": 0 },
    "volume": { "gte": 0, "lte": 0 },
    "amount": { "gte": 0, "lte": 0 },
    "turnoverRate": { "gte": 0, "lte": 0 }
  },
  "sort": {
    "field": "price | changePct | volume | amount | turnoverRate",
    "direction": "asc | desc"
  },
  "limit": 20
}
```

要求：

- `limit` 默认 20，最大 100。
- 未知字段、未知运算符和非有限数值必须在 schema 或执行前拒绝。
- 过滤顺序固定：规范化 → query → 数值过滤 → 排序 → limit。
- 返回 `totalMatched` 与 `truncated`，不能让模型误以为列表完整。

#### `akshare_stock_history`

用途：获取用于表格或 K 线的历史数据，不自动生成完整技术解读。

核心参数：

```json
{
  "market": "a-share | hk",
  "symbol": "600519",
  "period": "daily | weekly | monthly",
  "startDate": "20250101",
  "endDate": "20260819",
  "adjust": "none | qfq | hfq",
  "maxBars": 240
}
```

#### `akshare_technical_analysis`

用途：获取历史数据、计算指标、生成图表快照和确定性分析摘要。

在历史参数外增加：

```json
{
  "indicators": ["sma", "macd", "rsi", "boll", "volume-ma", "atr"]
}
```

首版指标集合固定，不允许模型传入任意表达式、窗口脚本或公式。

### 8.2 工具输出与模型上下文

工具的规范值和 UI 持久化元数据应分离：

- `value`：结构化行情/分析结果，供模型生成文字。
- `content`：有界文本摘要，不把数百根 K 线全部塞进模型上下文。
- `presentationMeta`：供对话回放和图表渲染的 `ChartSnapshotV1`。

`ChartSnapshotV1` 建议形态：

```json
{
  "schemaVersion": 1,
  "analysisId": "sha256:...",
  "market": "a-share",
  "symbol": "600519",
  "name": "贵州茅台",
  "period": "daily",
  "adjust": "qfq",
  "currency": "CNY",
  "startDate": "2025-08-20",
  "endDate": "2026-08-19",
  "fetchedAt": "2026-08-19T16:30:00+08:00",
  "source": "AKShare/stock_zh_a_hist",
  "akshareVersion": "1.x.y",
  "bars": [
    ["2026-08-19", 100.0, 103.0, 105.0, 99.0, 1000000, 120000000]
  ],
  "series": {
    "sma5": [],
    "sma10": [],
    "sma20": [],
    "sma60": [],
    "macdDif": [],
    "macdDea": [],
    "macdHist": [],
    "rsi14": [],
    "bollUpper": [],
    "bollMiddle": [],
    "bollLower": [],
    "atr14": []
  },
  "analysisSummary": {
    "trend": "...",
    "momentum": "...",
    "volatility": "...",
    "volumePrice": "...",
    "warnings": []
  },
  "quality": {
    "missingBars": 0,
    "droppedRows": 0,
    "truncated": false
  }
}
```

为保证日志回放稳定：

- `presentationMeta` 最多保存 240 根日线或等量周/月线。
- 数组使用紧凑结构，保留必要精度，不存重复字段名。
- `NaN`、`Infinity`、Pandas Timestamp 和 NumPy scalar 必须转换为合法 JSON。
- `analysisId` 由规范化输入和快照内容的 SHA-256 生成。
- 图表渲染只依赖持久化 meta，不在历史回放时重新请求最新行情。
- 超过持久化上限时，Tool View 明确显示已截断；不能静默少画。

## 9. sidecar 设计

### 9.1 API 白名单

sidecar 只提供：

```text
GET  /health
POST /v1/market/snapshot
POST /v1/stock/history
POST /v1/stock/analysis
```

禁止：

- `/api/{functionName}`。
- `eval`、`getattr(akshare, userInput)` 或动态 import。
- 任意 URL 抓取。
- 任意本地文件路径读写。
- 任意输出目录。

内部固定映射：

| 业务能力 | AKShare 接口 |
| --- | --- |
| A 股实时 | `stock_zh_a_spot_em()` |
| A 股历史 | `stock_zh_a_hist(...)` |
| 港股实时 | `stock_hk_spot_em()` |
| 港股历史 | `stock_hk_hist(...)` |

每次升级 AKShare 都必须用 fixture 和可选联网 smoke 复核接口字段；不得假设中文列名永久稳定。

### 9.2 数据标准化

建立独立 adapter，将 AKShare 中文列名转换为内部 DTO。adapter 按接口和 AKShare 版本记录字段映射，不让 UI 或 Skill 直接依赖 DataFrame 中文列。

标准化规则：

- 代码始终为字符串，保留前导零。
- 日期统一为 `YYYY-MM-DD`。
- 时间戳统一带时区；没有可靠时间时只标记抓取时间，不伪造交易所时间。
- 金额和成交量保持数值与单位字段分离。
- 无法转换的行记录到 `quality.droppedRows`。
- OHLC 必须满足有限数值；不满足时该行不进入 K 线并产生质量告警。
- 后复权出现负价格等 AKShare 已知数据特性时不擅自修改，只展示明确告警。

### 9.3 技术指标计算

技术指标由本插件基于标准化收盘价/最高价/最低价/成交量本地计算，不依赖用户输入公式。

分析文本必须由确定性规则生成第一层摘要，例如：

- 收盘价相对 SMA20/SMA60 的位置。
- SMA5 与 SMA20 的相对关系及最近一次交叉日期。
- MACD DIF/DEA 的符号、相对关系和柱体近 3 期变化。
- RSI14 是否处于 `<30`、`30–70`、`>70` 区间；只称“超卖/中性/超买指标区间”，不等同于交易信号。
- 收盘价相对 BOLL 中轨和上下轨的位置。
- 当前成交量相对 VMA5/VMA10 的倍数。
- ATR14 相对价格的百分比，用于描述波动强弱。

模型可以把这些事实组织成自然语言，但不能改写底层数值或添加未计算信号。

### 9.4 缓存与重试

建议 TTL：

| 数据 | TTL |
| --- | --- |
| A 股实时快照 | 15–30 秒 |
| 港股实时快照 | 60 秒，并保留延迟标签 |
| 已结束历史区间 | 6–24 小时 |
| 包含当前交易日的历史区间 | 5–15 分钟 |

缓存采用宿主传入的插件 cache 路径，首版使用 SQLite 或 gzip JSON。缓存键为 `schemaVersion + akshareVersion + endpoint + normalizedArgs` 的 SHA-256。

重试规则：

- 只对超时、连接重置、明确的临时上游错误重试。
- 参数错误、字段漂移、解析失败不盲目重试。
- 最多 3 次，指数退避并加入少量 jitter。
- 每个请求有总 deadline；取消信号必须从 DSH Tool 传到宿主代理并终止 sidecar 请求。

### 9.5 独立 uv 工程与打包

- Python 源码、测试、fixture、依赖声明和 PyInstaller spec 全部放在 npm 插件包内独立的 `python-sidecar/` 目录，不与 Node/浏览器代码混放。
- 本地开发、测试、锁定依赖和打包统一使用 `uv`；禁止直接调用系统 `python`、`pip`、Conda 环境或复用仓库其他 Python 虚拟环境。
- 使用 `python-sidecar/.python-version` 固定 Python 3.11 x64，使用 `pyproject.toml` 声明运行及开发依赖，提交 `uv.lock` 保证构建可复现。
- `python-sidecar/.venv/` 仅是本地生成目录，必须加入 `.gitignore`，不得打进 npm 包；交付给用户的是 `runtime/win32-x64/` 中的自包含产物，用户侧不需要安装 `uv` 或 Python。
- PyInstaller `onedir` 为首选，不强求 `onefile`。
- 锁定 AKShare、Pandas、NumPy、lxml、curl_cffi、PyInstaller 等版本。
- 显式收集 AKShare 的 `.json`、`.pk`、`.js`、`.zip` 资源和证书。
- 构建产物生成 SBOM、文件清单和 SHA-256。
- Windows 发布版尽量代码签名，降低 SmartScreen/杀毒误报。
- 发布前在干净 Windows 用户环境验证，不依赖系统 Python、Conda 或 PATH。

建议的本地工作流：

```powershell
Set-Location .\python-sidecar
uv sync --frozen --group dev
uv run pytest
uv run pyinstaller --noconfirm .\akshare-service.spec
```

构建脚本负责在校验成功后将 `python-sidecar/dist/akshare-service/` 复制到 `runtime/win32-x64/`。复制前应清理或覆盖明确的目标子目录，并在复制后校验入口文件、依赖清单和 SHA-256；不得把整个 `.venv` 当作运行时发布。

## 10. 浏览器插件与图表

### 10.1 对话内卡片

为三个工具分别注册 `tool.call.toolview`，`key` 与 wire tool name 一致。Tool View 处理 running、success、error 和 replay 四种状态。

行情表卡片：

- 只显示返回的有界结果。
- 数字列对齐，涨跌使用主题语义色，不硬编码只适用于某一市场习惯的颜色。
- 显示筛选条件、排序、总匹配数和截断状态。

K 线卡片：

- 使用 Canvas 或 SVG 渲染；如引入第三方浏览器图表库，必须打入 `client.js` bundle 并完成许可证审计。
- 浏览器半不能依赖运行时从 CDN 加载脚本。
- 支持 hover、十字光标、缩放和指标 tab。
- 卡片高度建议 320–420px，窄宽度下隐藏次要图例。
- 图表颜色读取 DSH 主题变量，暗色/亮色均可读。
- 组件卸载时释放事件、observer 和图表实例。

### 10.2 右侧悬浮面板

- 注册 `shell.overlay`，不替换 `root`、`conversation` 或 `details`。
- 使用插件自己的订阅 store 管理 `open`、`activeSessionId`、`activeAnalysisId` 和快照。
- 通过 `sessions` 服务获取当前会话；实施前用 `cordis_inspect` 核对实际签名。
- Tool View 点击“在右侧打开”时写入 store。
- 会话消息重放时，Tool View 从持久化 `presentationMeta` 恢复快照并登记为该会话的候选最新分析。
- 面板只持有一份活动内容；清理当前项后回到空状态。
- 不把行情快照写入 `localStorage`；主题偏好、面板宽度等非金融状态可使用受控 UI 偏好存储。

### 10.3 静态图片降级

当前 DSH Markdown 只直接渲染绝对 HTTP(S) 图片，不渲染相对路径、`file:` 或 `data:`。因此静态 PNG/SVG 只作为可选导出或浏览器能力降级，不作为主协议。

若启用静态图：

- 由宿主白名单路由提供。
- URL 必须短期签名并限制为本会话。
- 历史回放仍优先使用持久化图表 DTO 重绘，避免 sidecar 停止后图片失效。

## 11. 顶栏插件入口

当前实现存在明确前置限制：

- `src-tauri/src/market.rs` 已能解析 `pluginRpc` 描述，但外框只接受当前登记的方法。
- `dist/app.js` 目前只允许 `workspace.togglePanel` / `workspace.toggleTerminal` 两个 `pluginRpc`，并只维护文件夹/终端的 pressed 状态。
- 标题栏图标当前只接受 `folder` / `terminal`。

因此不能仅靠市场包清单就声明 `akshare.toggleAnalysisPanel`；必须先实现受控的插件 RPC 注册与路由，或为该插件增加一个新的宿主允许方法。推荐通用但受限的方案：

1. 外框只加载已安装、启用、协议兼容且 active 的插件贡献。
2. `pluginRpc` 方法必须带插件身份并通过贡献清单校验。
3. Desktop 只把 `{ pluginId, method }` 作为 `postMessage` 发给 DSH iframe，不把它映射为任意 Tauri invoke 或 shell。
4. 浏览器 plugin bridge 只向相同 pluginId 的活动客户端插件分发已登记方法。
5. 本插件只登记 `akshare.toggleAnalysisPanel`，无任意参数。
6. 增加内建图标 `chart-candlestick`，仍禁止任意 SVG/HTML。
7. pressed 状态由浏览器插件回传 `analysis-panel-state`，外框只接受来源、插件 ID 和布尔值。
8. 插件卸载、停用、失活或协议不兼容后，按钮立即消失并关闭面板。

该扩展应进入 DSH Plugin Contract 的正式文档和 Rust/JS 合同测试，不能只为一个插件硬编码包名。

## 12. 新权限与宿主前置项

当前桌面权限集合不足以准确表达该插件的实际能力。实施前建议增加：

| 权限 | 用途 |
| --- | --- |
| `process:execute-bundled` | 只执行清单内声明、路径位于包内的 sidecar |
| `network:outbound` | sidecar 访问公开财经数据源 |
| `storage:cache` | 写入宿主分配的可清理缓存目录 |
| `shell:titlebar` | 注册外框顶栏按钮 |

宿主需要同时完成：

- 安装确认界面展示上述敏感权限。
- 运行时按插件身份再次校验。
- canonicalize sidecar 路径并确认仍位于包目录。
- 使用程序路径 + argv 启动，禁止 shell 字符串拼接。
- 固定工作目录、最小化环境变量、限制日志和启动超时。
- sidecar 进入 Desktop Job Object 或等价生命周期托管；退出 DSH 时终止。
- 用户缓存目录由宿主分配，卸载默认可清理；分析快照以会话日志为权威，不依赖缓存生存。

如果这些权限协议暂未实现，首版可以在受信任内测渠道运行，但市场 UI 必须明确显示“宿主插件拥有完整 Node/子进程能力”，不能假装已经沙箱化。

## 13. 会话状态与持久化

### 13.1 权威来源

- 工具结果中的持久化 `presentationMeta`：历史图表与分析的权威来源。
- 会话级浏览器 store：当前打开/选中的分析，仅为 UI 状态。
- sidecar cache：性能优化，可随时删除，不是历史记录权威来源。
- npm 包：代码和只读资源，不写运行状态。

### 13.2 一次对话内容的定义

本方案将“一次对话内容”定义为：当前 session 中某一次成功的 `akshare_stock_history` 或 `akshare_technical_analysis` Tool call 产生的一份 `ChartSnapshotV1`。

- 一个面板一次只绑定一个 `analysisId`。
- 同一 Turn 多次调用时，以用户在卡片中显式选择的调用为活动项；未选择时以最后成功完成者为最近项。
- 新 Turn 不合并旧快照。
- 不跨会话自动复制。
- Fork 后按会话日志自然继承可见历史，但 UI 活动选择重新计算，不共享可变 store。

## 14. 错误与降级

| 场景 | 行为 |
| --- | --- |
| sidecar 未找到/校验失败 | 工具不可用，市场诊断显示运行时损坏，不从系统 PATH 找同名程序 |
| sidecar 启动超时 | 终止进程，返回结构化 `SIDECAR_START_TIMEOUT` |
| AKShare 上游超时 | 有限重试后返回数据源暂不可用，保留旧卡片但标记未刷新 |
| AKShare 字段漂移 | adapter fail closed，报告缺失字段和版本，不错位映射 OHLC |
| 返回空表 | 区分“合法无结果”和“上游解析失败” |
| 指标窗口不足 | 只展示可计算指标，其余明确标记数据不足 |
| 浏览器图表初始化失败 | 显示摘要表与错误，不让整个对话崩溃 |
| 顶栏消息未送达 | 仍可通过 Tool View 的“在右侧打开”或会话内入口重试 |
| 插件被禁用/卸载 | 移除工具、Skill、路由、槽位和按钮，终止 sidecar |
| 完全离线 | 显示离线状态；只有命中未过期缓存时允许返回，并明确标记缓存时间 |

## 15. 安全、合规与产品文案

- AKShare 代码采用 MIT License，但其抓取的数据仍受各数据源条款、频率限制和用途约束；发布前需要逐项审查目标数据源的可用范围。
- 官方文档将 AKShare 主要定位为研究工具。产品不得宣传为交易所官方实时行情或交易级数据服务。
- 港股 `stock_hk_spot_em` 文档标明存在约 15 分钟延迟，UI 和回复必须显示。
- 不向模型或前端暴露 Cookie、Authorization、代理口令和 sidecar token。
- 默认禁止跨域访问 sidecar；浏览器只能走宿主代理。
- 参数、返回行数、响应字节、并发和时间范围全部设上限。
- 记录接口名、耗时、状态、AKShare 版本和行数；不记录完整行情 payload 和用户敏感文本。
- 技术指标只描述历史数据，不构成投资建议；错误文案不得诱导用户依据失效/缺失数据决策。

## 16. 实施阶段

### 阶段 0：宿主协议前置

- 补充 `process:execute-bundled`、`network:outbound`、`storage:cache` 权限。
- 实现受控 `pluginRpc` 外框 → iframe 路由。
- 新增 `chart-candlestick` 内建图标。
- 增加外框按钮 pressed 状态的插件化回传。
- 更新 `docs/DSH插件协议v1.md`、市场校验和合同测试。

完成标准：一个测试插件可以在安装/启用/激活时显示顶栏按钮，通过受控 RPC 切换 `shell.overlay`，停用后入口和面板均消失。

### 阶段 1：sidecar 与数据合同

- 单独建立 `python-sidecar/` uv 工程，固定 Python 3.11，提交 `pyproject.toml`、`.python-version` 和 `uv.lock`。
- 通过 `uv sync --frozen`、`uv run pytest` 和 `uv run pyinstaller` 完成依赖恢复、测试和 `onedir` 构建。
- 实现四个 AKShare adapter。
- 实现标准化 DTO、缓存、重试、健康检查和取消。
- 实现 SMA/MACD/RSI/BOLL/VMA/ATR。
- 使用 fixture 验证字段漂移和异常数据。

完成标准：在无系统 Python 的干净 Windows 环境，可通过白名单 API 获得四类数据和分析 DTO。

### 阶段 2：DSH Tool 与 Skill

- 注册三个工具和输出 schema。
- 注册 Skill 并加入分析纪律。
- 建立 `presentationMeta` 快照和大小限制。
- 验证 native 与 code tool presentation 模式下都能调用。

完成标准：模型能按自然语言稳定选择工具，回答只使用同一快照，并正确披露周期、复权和时间。

### 阶段 3：对话卡片

- 实现行情表 Tool View。
- 实现 K 线/成交量/指标 Tool View。
- 处理 running、error、success、replay。
- 完成亮/暗主题、响应式和资源释放。

完成标准：刷新页面和重新进入历史会话后图表仍可从持久化 meta 重绘，不依赖重新联网。

### 阶段 4：顶栏与右侧悬浮

- 注册顶栏贡献。
- 实现 `shell.overlay` 单内容面板。
- 实现 Tool View → 面板、顶栏 → 面板和会话切换。
- 验证新分析提示、关闭、切会话、禁用和卸载。

完成标准：右侧面板始终只显示当前会话的一份分析，不发生跨会话串数据。

### 阶段 5：市场交付

- 许可证与第三方通知审计。
- SBOM、哈希、代码签名和杀毒误报检查。
- `npm pack --dry-run --json` 复核全部运行资源。
- 安装/卸载/重启/更新和损坏恢复测试。
- 完成内网 Registry 递归依赖导入清单。

## 17. 测试方案

### 17.1 Python 单元测试

- A/H 实时列名映射。
- A/H 历史 OHLCV 映射。
- 代码前导零和日期/时区规范化。
- `NaN`、无穷值、空表、重复日期、逆序数据和字段缺失。
- SMA、EMA、MACD、RSI、BOLL、VMA、ATR 的固定 fixture。
- 分析规则与边界值。
- 缓存 TTL、键、损坏恢复和并发写。
- 重试分类、deadline 和取消。

### 17.2 宿主插件测试

- 工具 schema 拒绝未知字段和超限值。
- sidecar 路径不能逃出包目录。
- 启动握手、token、健康检查、重启和终止。
- 工具结果 value/content/meta 分离。
- `presentationMeta` 大小和合法 JSON。
- sidecar 日志脱敏与截断。
- 插件 dispose 后工具、路由和进程全部消失。

### 17.3 浏览器测试

- 三个 `tool.call.toolview` 按工具名分发。
- running/error/success/replay。
- K 线缩放、hover、tab、主题切换和窄屏。
- “在右侧打开”设置正确分析。
- 顶栏 toggle、pressed 状态和空状态。
- 会话 A/B 切换无串数据。
- 新分析完成不强制覆盖用户正在查看的旧分析。
- 组件卸载无残留 listener、observer 和 DOM 样式。

### 17.4 合同与构建验证

建议执行：

```text
cd python-sidecar && uv sync --frozen --group dev
cd python-sidecar && uv run pytest
cd python-sidecar && uv run pyinstaller --noconfirm akshare-service.spec
sidecar clean Windows smoke（目标机器无需 uv/Python）
node --check lib/index.js
node --check lib/client.js
npm test
npm run check
npm pack --dry-run --json
cargo fmt -- --check
cargo check
cargo test
npm run build
git diff --check
```

联网 smoke 与确定性测试分开：

- 默认 CI 只使用固定 fixture，不因上游网站波动随机失败。
- 定时或发布前 smoke 实际调用四个 AKShare 接口，只验证 schema 和最小数据质量。
- 联网 smoke 失败阻止宣称“当前可用”，但不得自动修改 fixture 来掩盖字段漂移。

## 18. 验收场景

1. 用户要求筛选 A 股涨跌幅和成交额，模型调用实时工具，对话显示有界表格并正确说明截断。
2. 用户查询 A 股日线，卡片显示 K 线、成交量、周期和复权。
3. 用户查询港股实时行情，卡片和回答均展示延迟提示。
4. 用户查询港股月线，代码前导零保持正确。
5. 用户要求 MACD/RSI/BOLL 分析，模型调用分析工具，文字与卡片数值来自同一快照。
6. 用户点击“在右侧打开”，悬浮面板显示同一 `analysisId`。
7. 用户关闭面板后点击顶栏“行情”，重新打开当前会话活动分析。
8. 用户切换会话，面板不显示上一会话内容。
9. 刷新页面或重启 DSH 后，历史对话中的图表无需联网即可重绘。
10. 禁用或卸载插件后，工具、Skill、顶栏入口、悬浮面板、路由和 sidecar 全部撤销。
11. sidecar 或上游失败时，错误卡片可理解且不会伪造最新价格。
12. 没有系统 Python 的 Windows 用户安装插件后仍可使用。

## 19. 需要审阅确认的决策

实施前建议确认以下默认值：

1. 首版只支持 Windows x64，其他平台延期。
2. K 线快照最多持久化 240 根，工具允许查询更多但图表/回放截断。
3. A 股实时筛选首版不承诺行业字段；行业筛选作为单独 adapter 后续加入。
4. 技术指标固定为 SMA、MACD、RSI、BOLL、VMA、ATR，不支持用户公式。
5. 面板一次只显示当前会话的一份分析，不做历史列表和自选股。
6. 新分析只提示，不自动抢占已打开的旧分析。
7. 静态图片是降级/导出，不是主显示协议。
8. 缓存优先 SQLite/gzip JSON，不引入 pyarrow。
9. 顶栏入口通过正式受控 `pluginRpc` 扩展实现，不硬编码包名或开放任意 Tauri command。
10. 所有技术分析使用“描述性信号 + 风险提示”，不输出交易建议。

## 20. 参考资料

- [OpenClaw AkShare Skill 实现总结](https://github.com/succ985/openclaw-akshare-skill/blob/master/scripts/IMPLEMENTATION_SUMMARY.md)
- [OpenClaw AkShare Skill](https://github.com/succ985/openclaw-akshare-skill)
- [AKShare 官方仓库](https://github.com/akfamily/akshare)
- [AKShare 股票数据文档](https://akshare.akfamily.xyz/data/stock/stock.html)
- [AKShare 数据风险说明](https://akshare.akfamily.xyz/data_tips.html)
- 本仓库 `docs/plugin开发文档.md`
- 本仓库 `docs/DSH插件协议v1.md`
- 本仓库 `docs/插件市场开发方案.md`
- 本仓库 `market/dsh-open-workspace/`，作为顶栏控制和 `shell.overlay` 交互参考
