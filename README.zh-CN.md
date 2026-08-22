# DSH Desktop

English: [README.md](README.md)

DSH Desktop 是一个基于 Windows/Tauri 的桌面客户端，用于管理并运行
`@deepseek-ai/dsh` npm 运行时，同时提供桌面体验、界面主题和经过协议校验的插件市场；客户端不会内置或重新构建上游 DSH 代码。

![DSH Desktop 首页](images/%E9%A6%96%E9%A1%B5.png)

## 下载与安装

当前 Windows x64 安装包位于
[GitHub v0.1.7 Release](https://github.com/Antony-Jia/deepseek-harness-desktop/releases/tag/v0.1.7)：

[下载 DSH Desktop Windows 安装包](https://github.com/Antony-Jia/deepseek-harness-desktop/releases/download/v0.1.7/DSH.Desktop_0.1.7_x64-setup.exe)

安装包内置经过 SHA256 校验的 Node.js v24.19.0 x64 运行时，因此目标电脑不需要预先安装 Node.js、npm 或 npx。首次安装桌面托管版 DSH 时，仍需要联网从 npm registry 下载所选的 `@deepseek-ai/dsh` 版本。

安装后启动 DSH Desktop，在首页启动 DSH 或进入已经运行的 DSH 页面。客户端会通过内置 WebView 打开本地回环 Web UI，不需要手动复制地址到浏览器。

## 桌面客户端提供的能力

- 通过独立的 Node 进程启动 DSH，并使用明确的工作目录。
- Web/控制端口仅监听回环地址，使用随机 Bearer token，并通过配置了 `KILL_ON_JOB_CLOSE` 的 Windows Job Object 管理子进程。
- 支持系统中的本地 DSH，也支持独立的桌面托管 DSH。托管版本安装在独立目录中，不会覆盖系统 npm。
- 提供面向 Web profile 的插件市场，可搜索、安装和卸载通过清单协议校验的插件与主题包，并按安装、启用和协议兼容状态控制入口。
- 在插件市场旁提供 MCP 管理入口，通过 DSH 官方 MCP Client 注册工具；内置默认关闭的 Tavily Search、Firecrawl 与仅限本机的 Chrome DevTools，也支持用户添加 stdio/npm、本地命令或 Streamable HTTP MCP。
- 自定义 MCP 添加对话框跟随亮色、暗色、系统主题和已安装 Theme Pack 外观变化。
- 支持受控的桌面顶栏扩展、工作区文件浏览、终端、股票行情分析和多 Agent 圆桌讨论。
- 市场内置 DeepSeek 视觉桥接插件，为不支持图片输入的模型提供 `/vision` 命令和受控的 `deepseek_vision_analyze` 工具，只分析 DSH 会话中已持久化的图片。
- 顶栏插件操作支持响应式溢出菜单，并提供标准的首页和重启入口。
- 顶栏提供统一的 Skills 管理入口，可查看市场插件、用户级 Skills 以及当前工作区的 `.dsh/skills` 和 `.agents/skills`。
- 在恢复首页显示启动、安装、更新和失败日志。
- 提供可见的系统托盘图标、原生通知桥接和无边框窗口控制。
- 将窗口位置、尺寸、最大化状态、外观模式、界面皮肤、背景强度和减少效果偏好保存到 `%LOCALAPPDATA%/dsh-desktop/state.json`。
- 提供受控的 Neon Agent Theme Pack 预览、15 秒确认回退、本地背景资源和默认主题恢复；主题包不能携带任意 CSS、selector、远程资源或桌面命令。

### MCP 管理

插件市场旁的 MCP 页面用于管理默认关闭的 Tavily Search、Firecrawl 和
Chrome DevTools 预设，并允许用户添加 stdio npm 包、已有的本地命令或 Streamable HTTP
服务。npm 包会在首次启用并启动 DSH 时由桌面托管的 Node/npm 自动安装；
启用后通过官方 `@deepseek-ai/dsh-mcp-client` 注册为
`mcp__<serverName>__*` 工具。API Key、环境变量和 HTTP Header 使用 Windows
DPAPI 保护且不会回显；页面会显示每个服务的连接状态、工具数量和工具名称。
Chrome DevTools 只通过本机 stdio 启动隔离的本地 Chrome，不提供远程 URL。
可选的 `autoConnect` 开关允许连接当前本地 Chrome；关闭时仍使用独立隔离浏览器。
页面顶部的启动诊断会分别显示本地 Node/npm、npm Registry 下载能力、精确版本
缓存、web profile 注入和实际工具注册状态，便于区分下载失败与 MCP 子进程启动失败。

### Skills 管理

顶栏 Skills 入口会汇总已安装市场插件、`~/.dsh/skills`、`~/.agents/skills`
以及当前工作区 `.dsh/skills`、`.agents/skills` 中的 Skills。桌面端通过 DSH
官方 Skills provider 管理可控 Skills 的启用状态，同时保留不可管理的上游
Skills 只读展示。

### DeepSeek 视觉桥接

市场内置 `@p-dsh-market/deepseek-vision-bridge`，用于让不支持图片输入的
模型分析会话图片。安装插件并重启 DSH 后，附加图片并执行
`/vision 你的问题`；插件会通过受控的 `deepseek_vision_analyze` 工具调用官方
`deepseek-official/deepseek-v4-flash-vision-exp` 模型。未显式指定图片时，
默认分析最近一条含图片消息中的全部图片；显式选择时最多支持 8 张。插件只
读取 DSH 已持久化的会话附件，不读取任意本地路径或远程 URL；原生视觉模型会
直接看图并隐藏桥接工具。`/vision` 会把原始问题和图片作为正常用户消息写入
聊天流，桥接指令只进入系统提示词，因此界面会显示用户气泡和图片画廊。

## 界面预览

### 插件市场

为 DSH Web profile 搜索、查看、安装和卸载经过协议校验的插件与主题包。

![DSH 插件市场](images/%E6%8F%92%E4%BB%B6%E5%B8%82%E5%9C%BA.png)

### 工作区文件与终端

在 DSH 对话旁浏览工作区文件并预览 Markdown、HTML 与代码，同时可在下方直接使用集成的 PowerShell 终端。

![工作区文件浏览器与终端](images/%E5%B7%A5%E4%BD%9C%E5%8C%BA%E6%96%87%E4%BB%B6%E4%B8%8E%E7%BB%88%E7%AB%AF.png)

### 股票行情分析插件

AKShare 插件可在对话消息和右侧面板中展示行情快照、历史 K 线与技术分析结果。

![AKShare 股票行情分析插件](images/%E8%82%A1%E7%A5%A8%E6%8F%92%E4%BB%B6.png)

### 多 Agent 圆桌讨论

多个独立 Agent 可按自定义角色并行讨论、交叉评审，通过 Markdown 实时输出消息，并由主持人生成最终总结。

![多 Agent 圆桌讨论](images/%E5%A4%9A%E4%BA%BA%E8%AE%A8%E8%AE%BA.png)

## 运行时与数据位置

- `%LOCALAPPDATA%/dsh-desktop/state.json` 保存固定版本、最后可用版本、可用更新、运行来源、桌面偏好设置和窗口边界。
- 托管 DSH 版本保存在 `%LOCALAPPDATA%/dsh-desktop/runtimes/<version>`。
- 应用日志保存在 `%LOCALAPPDATA%/dsh-desktop/logs`。
- 当安装包包含内置 Node 资源时，客户端首次启动会将它复制到 `%LOCALAPPDATA%/dsh-desktop/node`。

## 本地开发

仓库使用 Node/npm 执行检查，并使用 Tauri CLI 启动开发客户端：

```powershell
npm install
npm run check
npm test
npm run tauri dev
```

开发模式默认使用系统 `PATH` 中的 Node；如果 `runtime-assets/node/` 中存在 portable Node，则优先使用该目录。Node 二进制由 Git 忽略，仓库只跟踪 `runtime-assets/node/README.md`。

## 构建安装包

如需复现当前 release，先下载官方 Node.js 24 x64 portable ZIP，完成校验后将内容直接解压到 `runtime-assets/node/`：

- 文件：`node-v24.19.0-win-x64.zip`
- SHA256：`57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`
- 官方发布目录：<https://nodejs.org/download/release/latest-v24.x/>

该目录必须包含 `node.exe` 和 `node_modules/npm/bin/npm-cli.js`。然后执行：

```powershell
npm run check
npm test
npm run build
```

Windows NSIS 安装包生成在：

```text
src-tauri/target/release/bundle/nsis/DSH Desktop_0.1.7_x64-setup.exe
```

`.gitignore` 会忽略 `src-tauri/target/`、`dist/bundle/`、portable Node 二进制和安装包文件；这些内容只作为 release 构建输入或输出，不应提交到源码仓库。

当前 Tauri 配置会嵌入 WebView2 bootstrapper，代码签名由最终分发环境负责。

## 运行时 Smoke Test

独立运行时探针位于 `scripts/e1-runtime-smoke.ps1`。它会将 rc.6 安装到临时目录、检查回环页面，并且只删除该临时目录。
