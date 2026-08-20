# Neon Agent

Neon Agent 是 DSH Desktop 的声明式 Theme Pack 示例。它只包含受宿主允许列表约束的语义 token 和本地 PNG 背景，不携带任意 CSS、selector、HTML、远程资源或可执行桌面代码。只有包已安装、加入 `web` profile bundles、依赖 `@deepseek-ai/dsh-client-ui-theme`、协议校验通过并由 DSH Web 完成主题注册后，Desktop 才会把它列为可选皮肤。

`assets/background.png` 和 `assets/preview.png` 均使用 `feature_doc/assets/neon-agent-background-with-operator.png` 的带 operator 构图；实际背景由宿主统一叠加遮罩、按 `68% center` 定位，并通过 bridge 投影到 DSH Web。

当前背景遮罩为较浅的 `rgba(1, 4, 15, 0.32)`；浏览器侧“新会话”按钮使用与 Neon Agent 一致的半透明电蓝底色。

主题包更新后需要重启 DSH Web；正式发布后使用确定版本安装：

```powershell
dsh plugin --profile web add @p-dsh-market/neon-agent-theme@0.1.4
```
