# DSH Theme Pack 协议 v1

DSH Desktop 已实现 `feature_doc/DSH UI皮肤插件开发方案.md` 的首个可用阶段，并接通 DSH Web iframe 的官方主题服务：主题包通过受控 token 改变外框和 Harness 内容视觉，不注入任意 CSS，也不改变页面布局、交互入口或盒模型属性。

## 当前实现

- `appearanceMode`、`skinId`、`backgroundIntensity` 和 `reduceEffects` 分开持久化；旧版本的 `theme` 字段会迁移为 `appearanceMode`。
- 内建 `Neon Agent` 只支持暗色，使用本地 PNG 背景和近黑/深蓝/电蓝/紫色 token。带 operator 的参考图只作为预览图，实际背景使用保留内容留白的版本。
- Desktop 通过 `list_theme_packs`、`get_active_theme_pack`、`preview_theme_pack`、`confirm_theme_pack`、`cancel_theme_preview`、`reset_theme_pack` 和 `set_background_preferences` 管理主题。
- 预览保存在内存中，15 秒未确认自动回到上一个主题；确认后才写入 `state.json`。主题损坏、未启用或不支持当前外观时回到内建默认主题。
- 已安装 `web` profile 主题包从包内 `package.json`、`theme.json` 和图片资源读取；路径会 canonicalize 并拒绝绝对路径、越出包目录的 `..` 路径、URL、超限图片、SVG、任意 token 和 CSS 注入。主题清单位于 `theme/` 子目录时允许安全的 `../assets` 包内引用。
- 市场清单会识别 `theme-pack`，安装后重新校验本地资源并刷新设置页；卸载当前主题前先回退 `builtin.default`，卸载失败会恢复原主题选择。
- Desktop 将规范化 token 通过 `postMessage` 发送给 iframe。`dsh-desktop-bridge` 对接 DSH Web 上游的单数 `theme` 服务，使用固定的 Theme Pack token → `--dsw-*` 语义变量映射，再由上游 `ThemePresenter` 应用到 Harness 内容；不通过 DOM selector 修改 DSH Web。没有该服务时会回传结构化错误，Desktop 仍可独立换肤。

## 示例包

`market/neon-agent-theme/` 是可打包的本地示例，包含：

- `theme/theme.json`：schema v1、暗色声明、语义 token 和本地背景描述；
- `assets/background.png`：实际背景；
- `assets/preview.png`：使用带 operator 氛围参考的主题预览；
- `lib/` 与 `cordis.patch.yml`：不执行宿主命令的惰性插件入口。

主题包只有在 `web` profile 中已安装、启用、协议兼容且资源校验成功时才会显示为可用。当前市场目录包含已发布的 `@p-dsh-market/neon-agent-theme`，安装后需要重启 DSH Web，使 npm 启动的 Harness 重新构建浏览器插件图。

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
