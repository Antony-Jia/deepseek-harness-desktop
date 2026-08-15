# DSH Desktop

English: [README.md](README.md)

DSH Desktop 是一个基于 Windows/Tauri 的轻量桌面客户端，用于运行
`@deepseek-ai/dsh` npm 运行时。客户端不会内置或重新构建上游 DSH 代码。

## 功能边界

- 使用 `%LOCALAPPDATA%/dsh-desktop/state.json` 保存固定版本、最后可用版本、可用运行时版本和桌面偏好设置。
- 每个 DSH 版本安装在独立的运行时目录中，并使用精确的 npm 版本标识。安装失败时会使用临时目录并自动清理。
- 通过独立的 Node 进程启动 DSH，使用明确的工作目录、仅监听回环地址的 Web/控制端口、随机 Bearer token，以及配置了 `KILL_ON_JOB_CLOSE` 的 Windows Job Object。
- 启动页会显示安装和启动日志，并提供失败后的恢复操作。启动成功后，客户端会在内置 WebView 中打开 DSH 的本地页面。
- 提供可见的系统托盘图标和原生通知桥接；这些能力通过可选的 `dsh-desktop-bridge` profile 插件提供。
- 使用无边框窗口设计，提供自定义的最小化、最大化、关闭和页面切换控件。

## 直接安装

Windows 用户可以使用 release 构建生成的 NSIS 安装包安装客户端：

```text
src-tauri/target/release/bundle/nsis/DSH Desktop_0.1.0_x64-setup.exe
```

安装后启动 DSH Desktop，在首页选择运行来源并启动 DSH。客户端会在本地启动上游服务，并通过内置页面打开，不需要手动复制本地地址到浏览器。

## 本地开发

安装依赖并启动开发窗口：

```powershell
npm install
npm run check
npm run tauri dev
```

开发环境默认使用系统 PATH 中的 Node。如果提供了
`runtime-assets/node/node.exe`，release 包会将该目录作为资源，并在首次启动时复制到 `%LOCALAPPDATA%/dsh-desktop/node`。仓库不会提交 50 MB 以上的 Node 分发包。

要测试运行时安装流程，可以在启动页安装固定版本 `0.1.0-rc.6`。

构建 Windows 安装包前，将 portable Node 24 x64 分发包放入
`runtime-assets/node/`，并在仓库外验证其 SHA256，然后执行：

```powershell
npm run build
```

当前 Tauri 配置生成 Windows NSIS 安装包，并嵌入 WebView2 bootstrapper。代码签名由最终分发环境负责。

开发期间使用的独立运行时探针位于
`scripts/e1-runtime-smoke.ps1`。它会将 rc.6 安装到临时目录、检查回环页面，并且只删除该临时目录。
