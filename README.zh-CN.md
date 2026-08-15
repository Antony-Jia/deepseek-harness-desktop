# DSH Desktop

English: [README.md](README.md)

DSH Desktop 是一个基于 Windows/Tauri 的轻量桌面客户端，用于管理并运行
`@deepseek-ai/dsh` npm 运行时。客户端负责运行时、进程和桌面体验，不会内置或重新构建上游 DSH 代码。

## 下载与安装

当前 Windows x64 安装包位于
[GitHub v0.1.0 Release](https://github.com/Antony-Jia/deepseek-harness-desktop/releases/tag/v0.1.0)：

[下载 DSH Desktop Windows 安装包](https://github.com/Antony-Jia/deepseek-harness-desktop/releases/download/v0.1.0/DSH.Desktop_0.1.0_x64-setup.exe)

安装包内置经过 SHA256 校验的 Node.js v24.19.0 x64 运行时，因此目标电脑不需要预先安装 Node.js、npm 或 npx。首次安装桌面托管版 DSH 时，仍需要联网从 npm registry 下载所选的 `@deepseek-ai/dsh` 版本。

安装后启动 DSH Desktop，在首页启动 DSH 或进入已经运行的 DSH 页面。客户端会通过内置 WebView 打开本地回环 Web UI，不需要手动复制地址到浏览器。

## 桌面客户端提供的能力

- 通过独立的 Node 进程启动 DSH，并使用明确的工作目录。
- Web/控制端口仅监听回环地址，使用随机 Bearer token，并通过配置了 `KILL_ON_JOB_CLOSE` 的 Windows Job Object 管理子进程。
- 支持系统中的本地 DSH，也支持独立的桌面托管 DSH。托管版本安装在独立目录中，不会覆盖系统 npm。
- 在恢复首页显示启动、安装、更新和失败日志。
- 提供可见的系统托盘图标、原生通知桥接和无边框窗口控制。
- 将窗口位置、尺寸、最大化状态，以及亮色、暗色或跟随系统主题保存到 `%LOCALAPPDATA%/dsh-desktop/state.json`。

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
src-tauri/target/release/bundle/nsis/DSH Desktop_0.1.0_x64-setup.exe
```

`.gitignore` 会忽略 `src-tauri/target/`、`dist/bundle/`、portable Node 二进制和安装包文件；这些内容只作为 release 构建输入或输出，不应提交到源码仓库。

当前 Tauri 配置会嵌入 WebView2 bootstrapper，代码签名由最终分发环境负责。

## 运行时 Smoke Test

独立运行时探针位于 `scripts/e1-runtime-smoke.ps1`。它会将 rc.6 安装到临时目录、检查回环页面，并且只删除该临时目录。
