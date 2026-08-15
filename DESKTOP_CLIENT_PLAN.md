# DSH 桌面客户端方案（Windows / Tauri 瘦壳）

目标：做一个本地客户端跑 DeepSeek Harness，**同时保持跟上游 npm 发布同步更新**，
且不把上游源码同步到本地、不重新构建上游代码。

核心结论：**可行，而且"瘦壳 + npm 运行时"是这类项目的正确做法。**
客户端不包含任何 dsh 代码，只负责三件事：**管进程、管运行时版本、装 WebView**。

---

## 0. 已确认的技术事实

这些是在本机实测/查询得到的，方案的形状由它们决定。

| 事实 | 值 | 对方案的影响 |
| --- | --- | --- |
| npm 包体积 | `@deepseek-ai/dsh` 解包 116KB，20 个文件 | 本体极小，重量全在依赖 |
| 依赖规模 | 70+ 个 `@deepseek-ai/*` 子包，前端产物已预构建 | `npx dsh web` 不需要任何本地构建 ✓ |
| 迭代速度 | 2026-08-10 ~ 08-13 发了 6 个版本，latest = `0.1.0-rc.6` | 更新机制是刚需，但**必须可 pin、可回滚** |
| 兼容性承诺 | README 明写 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" | 不能盲跟 latest |
| `engines` 声明 | **无**（上游用 Node 24.18/24.19 发布） | 内置 Node 版本由我们自己锁定并实测 |
| CLI 参数 | `--host`、`--port 0`（OS 挑空闲端口）、`--trusted-host` | 端口冲突问题可彻底免疫 |
| `/api` 安全围栏 | 有 browser-trust fence，非可信 authority 会被拒 | 决定了壳必须直接导航到 `http://127.0.0.1:<port>` |
| WebView2 Runtime | 本机 151.0.4129.86 已装 | Tauri 运行时依赖满足 ✓ |
| Rust 工具链 | **未装**（`cargo`/`rustc` 都不存在） | Tauri 硬前置，见 §7 |
| MSVC | VS 2022 存在（C++ workload 待确认） | Rust MSVC target 前置 |

### 原生模块（最关键的一条）

三个原生依赖**全部是预编译分发，无需编译工具链**：

| 模块 | 分发方式 | 风险 |
| --- | --- | --- |
| `node-pty` 1.1.0 | `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node` + `winpty-agent.exe` / `winpty.dll` / `conpty\OpenConsole.exe`；install 脚本 `node scripts/prebuild.js \|\| node-gyp rebuild`，本机 `build/` 无编译产物 → 走的是预编译分支 | **无**。Node-API ABI 稳定，Node 大版本升级不会崩 |
| `sharp` | `@img/sharp-win32-x64` 平台包 | 无 |
| `node-addon-require-builtin` | `optionalDependencies` 里 `node-addon-require-builtin-win32-x64-msvc` | **需实测**。描述为 "runtime probing for internal access"——探测 Node 内部，虽是预编译但可能对 Node 版本敏感 |

结论：终端用户机器上**不需要 MSVC / node-gyp / Python**。这是"内置便携 Node + 本地 npm install"路线成立的前提。

### 当前 npx 安装方式的问题

本机 `C:\Users\Admin\.dsh\profiles\node_modules` 里全是**指向 npx 缓存
`%LOCALAPPDATA%\npm-cache\_npx\1e7f6d9597241db0` 的 junction**，而该缓存目录的
`package.json` 是 `"@deepseek-ai/dsh": "^0.1.0-rc.6"`（**范围**解析，不是精确版本）。

即：npx 已经在给你做"半自动更新"，但

- 版本不可控（范围内静默升级）
- 不可回滚（旧版本被顶掉）
- 目录 hash 化，无法从客户端可靠寻址
- 无并存能力

**所以客户端不用 npx**，改用 `npm install --prefix <固定目录> @deepseek-ai/dsh@<精确版本>`。

---

## 1. 已定的选型

| 决策项 | 选择 | 理由 |
| --- | --- | --- |
| 壳 | **Tauri 2 + WebView2** | 壳约 5–10MB，原生窗口/托盘/通知齐全；WebView2 已预装 |
| 平台 | **仅 Windows x64** | 先把进程树、路径、WebView2 做扎实 |
| 上游更新 | **pin + 手动确认，失败自动回滚** | dev preview 三天六版，唯一稳妥策略 |
| Node 运行时 | **内置便携 Node，塞进安装包** | ABI/行为完全可控，开箱即用，不受用户环境污染 |
| DSH_HOME | **复用 `~/.dsh`** | 直接承接现有 sessions / credentials / settings / `dsh-open-workspace` 插件 |
| 原生能力 | 托盘常驻 + 后台运行、任务完成原生通知、工作区管理 + 原生选择器 | 全部落成**自己的 dsh 插件**，不改上游 UI |

**dsh 绝不跑在壳进程内**——始终是独立的真 Node 子进程。（这条对 Tauri 是天然的；如果将来换
Electron 也必须遵守，因为原生模块是 Node ABI 预编译，Electron ABI 不匹配。）

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────┐
│  Tauri 壳 (dsh-desktop.exe)   —— 几乎不需要更新           │
│  ├─ 单实例锁 (Named Mutex)                               │
│  ├─ 运行时版本管理器 (pin / install / switch / rollback)  │
│  ├─ 子进程监护 (Job Object, KILL_ON_JOB_CLOSE)           │
│  ├─ 托盘 + 原生通知 + 文件夹选择器                        │
│  └─ 本地控制端口 (127.0.0.1:随机 + Bearer token)          │
└───────┬──────────────────────────────┬──────────────────┘
        │ spawn                        │ HTTP (插件回调壳)
        ▼                              │
┌──────────────────────────┐           │
│ node.exe (内置便携)       │           │
│  dsh web --port 0        │◀──────────┘
│  DSH_HOME = ~/.dsh       │
│  cwd = 用户选的工作区      │
│  ├─ 上游 bundles (npm)    │
│  └─ 你的插件 (托盘桥/工作区)│
└──────────┬───────────────┘
           │ http://127.0.0.1:<port>
           ▼
┌──────────────────────────┐
│ WebView2 窗口             │
│ （直接导航到 loopback）    │
└──────────────────────────┘
```

三方彻底解耦，各自独立演进：

- **上游 dsh** → npm 版本号
- **你的插件** → 自己的 npm 包或 profile 本地目录
- **壳** → 极少更新

### 为什么原生能力走 HTTP 而不是 Tauri IPC

Tauri 2 对"导航到远程 URL 的窗口"默认**不开放 IPC**（需在 capabilities 里显式声明
remote domain，如 `urls: ["http://127.0.0.1:*"]`）。而且一旦依赖 `window.__TAURI__`
注入，你就把插件跟壳的实现绑死了。

更好的做法：**壳暴露一个 loopback 控制端口 + Bearer token**，token 通过环境变量传给
dsh 子进程，你的插件（宿主半）从 `process.env` 读到后调用壳的接口：

```
POST http://127.0.0.1:<ctrlPort>/notify      { title, body, sessionId }
POST http://127.0.0.1:<ctrlPort>/tray        { state: "busy" | "idle" }
POST http://127.0.0.1:<ctrlPort>/pick-folder → { path }   （阻塞直到用户选完）
Authorization: Bearer <token>
```

好处：壳可以随便换实现（甚至换成 Electron 或纯 Node 启动器），插件不用改；插件也能在没有壳的
纯命令行环境下优雅降级（探测不到环境变量就跳过注册）。

---

## 3. 磁盘布局

`~/.dsh` **完全不动**，客户端自己的东西全在 `%LOCALAPPDATA%`：

```
%LOCALAPPDATA%\dsh-desktop\
├── node\
│   └── v24.x.y\node.exe, npm, node_modules\npm\...   ← 随安装包分发
├── pnpm\pnpm.cjs                                     ← 固定版本，见 §3.1
├── runtimes\
│   ├── 0.1.0-rc.6\
│   │   ├── package.json          { "@deepseek-ai/dsh": "0.1.0-rc.6" }  精确版本
│   │   └── node_modules\@deepseek-ai\dsh\lib\bin.js
│   └── 0.1.0-rc.7\...            ← 新版另装一份，与旧版并存互不干扰
├── state.json
└── logs\dsh-<ISO时间戳>.log

C:\Users\<你>\.dsh\               ← 沿用现有，客户端只读取路径不接管
├── settings.yaml, .credentials.yaml, sessions\, storages\
└── profiles\web\{package.json, cordis.patch.yml, node_modules\你的插件}
```

`state.json`：

```json
{
  "pinned": "0.1.0-rc.6",
  "lastGood": "0.1.0-rc.6",
  "available": "0.1.0-rc.7",
  "lastWorkspace": "D:\\Code\\某项目",
  "recentWorkspaces": ["..."],
  "trayResident": true,
  "notifyOnTurnEnd": true
}
```

### 3.1 别忘了 pnpm

`dsh plugin --profile <name> <args>` 是**转发给 pnpm** 的，而便携 Node 只自带 npm。
如果客户端要提供插件管理界面（或者你想在客户端里装插件），必须额外附带**固定版本的
pnpm**（`pnpm.cjs` 单文件，用内置 node 执行）。不要依赖 corepack 联网下载。

注意本机全局 `npm` 是 **9.6.7**（很旧，Node 24 自带 11.x）。运行时安装必须用内置 Node
自带的那个 npm，**绝不能落到系统的 9.6.7 上**——旧 npm 对 `optionalDependencies`
平台包的解析行为有差异，正是原生模块最容易出问题的地方。

---

## 4. 启动序列

1. **单实例**：命名 Mutex（如 `Global\dsh-desktop`）。已有实例 → 激活其窗口并退出。
2. **读 `state.json`**，取 `pinned`。
3. **运行时就绪检查**：`runtimes\<pinned>\node_modules\@deepseek-ai\dsh\lib\bin.js` 存在？
   - 不存在 → 进入首次安装页，执行
     ```
     %LOCALAPPDATA%\dsh-desktop\node\v24.x.y\node.exe <npm-cli.js> install \
       --prefix %LOCALAPPDATA%\dsh-desktop\runtimes\0.1.0-rc.6 \
       @deepseek-ai/dsh@0.1.0-rc.6
     ```
     **必须流式显示进度**——依赖里有 aws-sdk / sharp / shiki / protobufjs，首装几百 MB，
     白屏几分钟等于产品死亡。
4. **工作区**：`state.json.lastWorkspace` 有效则用，否则弹原生文件夹选择器。
   （dsh 用**调用目录**作为默认工作区根，必须显式设 cwd，不能靠继承。）
5. **起控制端口**：绑 `127.0.0.1:0`，生成随机 token。
6. **spawn 子进程**：
   ```
   node.exe runtimes\<pinned>\node_modules\@deepseek-ai\dsh\lib\bin.js web \
            --host 127.0.0.1 --port 0
   cwd  = <工作区>
   env  = { DSH_HOME=%USERPROFILE%\.dsh,
            DSH_DESKTOP_CTRL=http://127.0.0.1:<ctrlPort>,
            DSH_DESKTOP_TOKEN=<token> }
   ```
   立刻把子进程句柄加入 **Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）**。
7. **等 URL**：从 stdout 抓 `http://127.0.0.1:\d+`，同时 tee 到 `logs\`。
   带超时（如 90s，首启可能更慢）+ `GET /` 健康检查。
8. **导航 WebView** 到该 URL。页面 origin 就是 `127.0.0.1:<port>`，`/api` 的
   browser-trust 围栏不会拦，**不需要 `--trusted-host`**。
9. **失败路径**：超时 / 子进程非 0 退出 / 健康检查失败 → 不要白屏，显示日志面板 +
   「回滚到 lastGood」「重试」「打开日志目录」三个按钮。
10. **成功后**：`state.json.lastGood = pinned`。

### 关闭与生命周期

- 托盘常驻开启时：关窗口 = 隐藏窗口，子进程继续跑（agent 不中断），托盘图标反映忙/闲。
- 真正退出：先给子进程发优雅关闭信号并等一个宽限期（会话要落盘），超时再关 Job Object。
- 壳崩溃 / 被任务管理器杀掉：Job Object 保证 node + conpty + winpty-agent 整棵树一起走，
  **不留孤儿进程**。这在 Windows 上不做就必然踩坑（node-pty 会起孙子进程）。

---

## 5. 更新机制（pin + 手动确认）

```
启动时 / 每 N 小时:
  GET https://registry.npmjs.org/@deepseek-ai/dsh   （只取 dist-tags + time，几十 KB）
      │
      ├─ latest == pinned → 无操作
      └─ latest != pinned → state.json.available = latest
                            状态栏出提示（不打扰、不自动装）
你点「更新」:
  1. npm install --prefix runtimes\<新版本> @deepseek-ai/dsh@<新版本>   ← 装到新目录
  2. 装失败 → 删掉半成品目录，保持 pinned 不变，报错
  3. 装成功 → 提示「重启生效」
  4. 重启子进程；起不来（超时/非 0 退出）→ 自动 pinned = lastGood 并回滚重启，
     弹出「新版本 X 启动失败，已回滚到 Y」+ 日志入口
  5. 起得来 → pinned = lastGood = 新版本
清理: 保留最近 N 个版本（默认 3），其余一键清理
```

关键点：**更新过程中壳的 exe 一行代码都不用重新构建**。这就是"同步上游更新但不本地构建"的
实现方式。

界面上还应提供：

- 版本下拉（列出 registry 上所有版本 + 已装的），可**手动降级到任意历史版本**
- 「离线可用」保证：registry 不可达时用已装的 pinned 直接启动，只是不提示更新

---

## 6. 三个原生能力的插件设计

全部落在你自己的插件里（复用现成的 `dsh-plugin-template` 双半结构），装进
`~/.dsh\profiles\web\node_modules\`，用 `cordis.patch.yml` 的 `insert` 挂载。
建议就做**一个**插件 `dsh-desktop-bridge`，避免多插件各自维护。

### 6.1 任务完成原生通知

- 宿主半：`inject: [sessions]`，监听 `turn/end` 与需要审批的事件
  （架构文档：`turn/*`、`tool/*` 是持久化 session 事件；审批走 permission policy）。
- 判定"值得通知"：窗口不在前台（壳通过控制端口回传前台状态）+ 该 turn 耗时超过阈值。
  否则会变成骚扰。
- 调 `POST /notify`，壳弹 Windows 通知，点击 → 唤起窗口并（可选）跳转到该 session。

### 6.2 托盘常驻 + 后台运行

- 宿主半监听 `turn/start` / `turn/end`，`POST /tray {state}` → 托盘图标忙/闲。
- 托盘菜单由壳提供：显示窗口、最近工作区、暂停/恢复、检查更新、退出。
- 后台运行的价值：关掉窗口 agent 继续跑完，再通知你。

### 6.3 工作区管理 + 原生选择器

- 上游 UI 自带 workspace 选择器，但它是 Web 的。插件浏览器半在合适槽位加一个
  「用系统对话框选择…」按钮 → 宿主半 `POST /pick-folder` → 壳弹原生对话框 → 返回路径 →
  走上游既有的添加工作区流程。
- 切换工作区的语义问题：dsh 的默认工作区根来自**进程 cwd**。要不要为切工作区重启子进程，
  取决于上游 UI 的多工作区支持程度——**需要实测**（见 §8 实验 E4）。
- 「最近工作区」列表存在壳的 `state.json`，托盘菜单直达。

### 6.4 降级保证

插件启动时检测 `process.env.DSH_DESKTOP_CTRL`：没有就**什么都不注册**。
这样同一个 profile 既能被客户端启动，也能被命令行 `dsh web` 启动，互不干扰。

---

## 7. 前置条件

| 项 | 状态 | 备注 |
| --- | --- | --- |
| WebView2 Runtime | ✅ 151.0.4129.86 | Win10/11 基本预装；安装包仍应带 bootstrapper 兜底 |
| Rust 工具链 | ❌ 未装 | `rustup` + `stable-x86_64-pc-windows-msvc` |
| VS 2022 C++ 生成工具 | ⚠️ 待确认 | VS 2022 目录存在，需确认含 "使用 C++ 的桌面开发" workload |
| 便携 Node | 待下载 | `node-v24.x.y-win-x64.zip`，约 55MB 解压后进安装包，需校验 SHA256 |
| pnpm 单文件 | 待下载 | 固定版本，供 `dsh plugin` 使用 |
| 代码签名证书 | 无 | 没有签名，Windows SmartScreen 会警告。自用可忍，分发要考虑 |

Rust 工具链 + MSVC 约 1.5–3GB 下载。

---

## 8. 建议先做的实验（在写壳之前）

按你 `DEBUGGING.md` 里"curl 对照法"的思路，**先用最便宜的手段把不确定性打掉**，
这些实验一个 exe 都不用编译：

| # | 实验 | 要验证什么 | 失败意味着 |
| --- | --- | --- | --- |
| **E1** | 便携 Node + `npm install --prefix <临时目录> @deepseek-ai/dsh@0.1.0-rc.6`，然后 `node bin.js web --port 0`，`DSH_HOME` 指向一个**临时目录** | 整条"自管运行时"链路可行；原生模块（尤其 `node-addon-require-builtin`）在我们选的 Node 版本上能加载 | 方案根基不成立，得回退到"用系统 Node" |
| **E2** | 同上，但 `DSH_HOME` 指向真实 `~/.dsh` | **profile 的 junction 农场**（`profiles\node_modules` 现在全指向 npx 缓存）在换了 dsh 安装位置后会不会被正确重链；你的 `dsh-open-workspace` 会不会被 pnpm prune 掉 | 需要在切版本前后做 profile 备份/迁移逻辑（**目前最大的未知**） |
| **E3** | 装两个版本并存，来回切，各起一次 | 并存 + 切换 + 回滚机制成立；切换后 profile 状态不损坏 | 更新机制要重新设计（可能得每版本一份 profile 副本） |
| **E4** | 手工起 `dsh web`，在 UI 里切换/添加多个工作区 | 切工作区是否需要重启子进程；cwd 语义的真实边界 | 影响 §6.3 的设计和"一窗口一进程 vs 单进程" |
| **E5** | 用 `msedge --app=http://127.0.0.1:<port>` 打开 UI，测终端（node-pty）、图片上传（sharp）、审批流 | WebView2 里功能完整，没有 secure-context / clipboard / SSE 之类的坑 | 可能需要 `--trusted-host` 或额外的 webview 配置 |
| **E6** | 杀掉父进程，看 node/conpty/winpty-agent 是否残留 | Job Object 的必要性和具体配置 | 确认必须做进程树收尾 |

E1–E3 是**阻塞性**的，尤其 E2。建议先跑完这三个再决定要不要装 Rust 工具链。

---

## 9. 里程碑

**M0 — 可行性验证（不写壳）**
跑完 E1–E6，产出一份结论。E2 若发现 profile 会被破坏，先解决它。

**M1 — 最小可用壳**
Tauri 项目骨架 + 单实例 + 便携 Node 打包 + 首装进度页 + spawn/抓 URL/导航 +
Job Object 收尾 + 日志面板。目标：**双击图标就能用**，功能等价于现在的 `npx dsh web` + 浏览器。

**M2 — 版本管理**
`state.json` + registry 查询 + pin/更新/回滚/降级/清理 + 离线降级。
这一步交付的是本方案的核心价值：**同步上游更新，永不本地构建**。

**M3 — 原生体验**
控制端口 + token + `dsh-desktop-bridge` 插件（托盘 / 通知 / 原生选择器）+
托盘常驻与后台运行 + 最近工作区。

**M4 — 打磨**
安装包（WebView2 bootstrapper 兜底）、崩溃恢复、设置界面、可选的代码签名。

---

## 10. 风险登记

| # | 风险 | 严重度 | 对策 |
| --- | --- | --- | --- |
| R1 | **切换运行时版本可能破坏 `~/.dsh/profiles` 的链接结构**，甚至 prune 掉你自己的插件 | 高 | E2/E3 先验证；必要时切版本前自动备份 profile，或每个运行时版本配一份独立 profile |
| R2 | 上游破坏性变更打断你的插件（三天六版 + 明示破坏性变更） | 高 | pin 为默认；更新前有"冒烟"步骤；保留一键回滚；插件里对上游 API 做能力探测而非硬假设 |
| R3 | `node-addon-require-builtin` 对 Node 版本敏感（探测内部实现） | 中 | 锁定内置 Node 版本，与上游发布用的 24.x 对齐；升 Node 视为一次需要完整回归的变更 |
| R4 | 首装几百 MB，网络差时体验崩坏 | 中 | 流式进度 + 可取消 + 断点重试；考虑把已知良好版本预置进安装包 |
| R5 | 客户端与命令行 `dsh` 同时写同一 profile | 中 | 单实例锁 + 启动时检测端口/锁文件，明确提示而不是静默共存 |
| R6 | Windows 孤儿进程（node-pty 起孙子进程） | 中 | Job Object `KILL_ON_JOB_CLOSE`，非可选项 |
| R7 | 无代码签名，SmartScreen 警告 | 低 | 自用可忍；要分发再买证书 |
| R8 | **上游可能自己出官方桌面端** | 低 | 正因如此壳要薄：届时你的插件（真正的差异化）可以无缝迁到官方客户端上 |

---

## 11. 明确不做的事

- ❌ **不 fork 上游仓库加 electron 包**：要构建、要 merge，三天六版的 rebase 成本会吃掉你。
- ❌ **不改上游 UI 源码**：所有定制走插件（"everything is a plugin"就是为此设计的）。
- ❌ **不在壳进程内 require dsh**：原生模块是 Node ABI 预编译。
- ❌ **不用 npx 管运行时**：范围解析、hash 目录、不可回滚。
- ❌ **不绑 0.0.0.0**：只绑 127.0.0.1；WebView 内的外部链接一律交给系统浏览器。
- ❌ **不自动跟 latest**：见 R2。
