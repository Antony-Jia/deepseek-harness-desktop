# DSH Theme Pack 协议 v1

DSH Desktop 已实现 `feature_doc/DSH UI皮肤插件开发方案.md` 的首个可用阶段，并接通 DSH Web iframe 的官方主题服务：主题包通过受控 token 改变外框和 Harness 内容视觉，并可把宿主校验后的本地图片投影为 Harness 背景；不注入任意 CSS，也不改变页面布局、交互入口或盒模型属性。

## 当前实现

- `appearanceMode`、`skinId`、`backgroundIntensity` 和 `reduceEffects` 分开持久化；旧版本的 `theme` 字段会迁移为 `appearanceMode`。
- Desktop 只内建安全默认主题。`Neon Agent` 只支持暗色，必须从 `web` profile 安装并启用后才进入皮肤备选列表；安装后若 DSH 正在运行，需要重启使浏览器半完成注册。
- `Neon Agent` 的实际背景和预览均使用 `feature_doc/assets/neon-agent-background-with-operator.png` 对应的包内副本，采用 `cover` 和 `68% center` 保留右侧人物构图。
- `Neon Agent` 当前使用较浅的 `rgba(1, 4, 15, 0.32)` 背景遮罩；浏览器侧“新会话”按钮通过 `--dsw-alias-button-elevated-fill` 使用主题电蓝色，而不是依赖 Harness 默认灰色。
- Desktop 通过 `list_theme_packs`、`get_active_theme_pack`、`preview_theme_pack`、`confirm_theme_pack`、`cancel_theme_preview`、`reset_theme_pack` 和 `set_background_preferences` 管理主题。
- 预览保存在内存中，15 秒未确认自动回到上一个主题；确认后才写入 `state.json`。主题损坏、未启用或不支持当前外观时回到内建默认主题。
- 已安装 `web` profile 主题包从包内 `package.json`、`theme.json` 和图片资源读取；路径会 canonicalize 并拒绝绝对路径、越出包目录的 `..` 路径、URL、超限图片、SVG、任意 token 和 CSS 注入。主题清单位于 `theme/` 子目录时允许安全的 `../assets` 包内引用。
- 市场清单会识别 `theme-pack`，安装后重新校验本地资源并刷新设置页；卸载当前主题前先回退 `builtin.default`，卸载失败会恢复原主题选择。
- 主题插件浏览器半必须先向 DSH Web 上游的单数 `theme` 服务注册主题，bridge 只允许切换已经注册的主题，不再代替缺失插件注册内建副本。未安装、未启用、协议不兼容或尚未完成重启注册的主题不会成为可用皮肤。
- 主题包的 `dsh.client.inject` 必须包含 `@deepseek-ai/dsh-client-ui-theme`；这是 DSH plugin 模式中从浏览器插件图依赖官方 `theme` 服务的声明。缺少该依赖的旧包会被宿主标记为协议不兼容，不会静默显示半套主题。
- Desktop 将 Rust 校验并转换为本地 `data:image/*` 的背景通过 `postMessage` 发送给 iframe。`dsh-desktop-bridge` 只修改 `document.body` 上固定允许的背景属性，不使用 selector、远程 URL 或任意 CSS；恢复默认主题、卸载插件或 bridge 销毁时会清理这些属性。

## 示例包

`market/neon-agent-theme/` 是可打包的本地示例，包含：

- `theme/theme.json`：schema v1、暗色声明、语义 token 和本地背景描述；
- `assets/background.png`：带 operator 的实际背景；
- `assets/preview.png`：同一构图的主题预览；
- `lib/` 与 `cordis.patch.yml`：不执行宿主命令的惰性插件入口。

其中 `package.json.dsh.client.inject` 依赖 `@deepseek-ai/dsh-client-ui-theme`，浏览器入口通过 `theme.register({ id: 'neon-agent', colorScheme: 'dark', tokens })` 注册主题。

主题包只有在 `web` profile 中已安装、启用、协议兼容且资源校验成功时才会显示为可用。市场目录登记了 `@p-dsh-market/neon-agent-theme`；本地修正版发布后安装对应版本，并重启 DSH Web，使 npm 启动的 Harness 重新构建浏览器插件图。

## 验证

```powershell
npm run check
npm test
cargo fmt -- --check
cargo test
Push-Location market/neon-agent-theme
npm pack --dry-run --json
Pop-Location
```

主题 token 的允许列表和资源边界由 `src-tauri/src/theme.rs` 维护；宿主 CSS 位于 `dist/styles.css`，主题选择和预览流程位于 `dist/app.js`。
