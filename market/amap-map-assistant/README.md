# 高德地图

`@p-dsh-market/amap-map-assistant` 是 DSH 的高德地图展示插件。它与 Desktop 内建的 `amap` MCP 配合使用：高德 MCP 查询真实地点、POI 和路线，插件只保存经过校验的展示 DTO，并在正式的 DSH slots 中提供正文卡片、右侧地图面板和同级中央地图视图。

## 能力

- `amap_present_map` 展示单地点、POI 列表和四类路线结果。
- `conversation.view` 提供“地图”中央会话视图。
- `conversation.session.header.actions` 提供当前会话地图入口。
- `tool.call.toolview` 只显示地图卡片；只有用户点击“在地图中查看”才打开面板。
- `shell.overlay` 提供可读的路线摘要、点位列表和在线高德 JS API 地图。
- 当前会话状态保存到用户级插件目录，不复制完整对话或 MCP 原始响应。

## 前置条件

1. 在 DSH Desktop 的 MCP 管理页启用高德地图并配置 Web 服务 Key。
2. 打开地图插件的“地图设置”，填写 Web JS API Key 与 `securityJsCode`；三种 Key 不会自动互相复制。
3. 安装本包到 DSH `web` profile 后重启 DSH，并在对话中按 Skill 规则先调用 `mcp__amap__*`，再调用 `amap_present_map`。

JS API 只在线加载，不打包高德脚本、瓦片或样式。插件设置只返回两项凭据的配置状态，不回显密值；缺少 JS 凭据时，正文卡片仍保留 MCP 返回的地点、列表和路线摘要。
