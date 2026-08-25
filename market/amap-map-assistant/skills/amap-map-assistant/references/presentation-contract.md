# `amap_present_map` 展示契约

提交 `schemaVersion: 1` 的 `location`、`places` 或 `route` DTO。坐标字段顺序是 `longitude`、`latitude`，必须是高德 GCJ-02 坐标；`sourceTools` 至少一项且必须来自本次高德 MCP 调用。

工具是幂等的展示提交，不是搜索工具。它会把当前会话的地图状态替换为最新 revision，但不会打开右侧面板，也不会修改普通回答正文。用户点击卡片按钮后才查看地图。
