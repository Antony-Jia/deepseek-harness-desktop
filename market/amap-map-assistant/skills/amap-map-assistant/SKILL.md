---
name: amap-map-assistant
description: 当用户明确查询地点、搜索 POI、查询天气、测量距离或规划驾车/公交/步行/骑行路线时，先调用高德 MCP 获取真实结果，再用 amap_present_map 展示地点或路线。不要从普通回答猜坐标，也不要让地图展示工具替代高德查询。
---

# 高德地图查询与展示规则

## 触发范围

使用本 Skill 的场景包括：搜索附近地点、查一个地点在哪里、查询天气、从 A 到 B 规划路线、比较出行方式、测量距离、把多个地点放到地图上。普通地名知识或不需要实时位置数据的回答不强制调用地图。

## 权威查询顺序

1. 确认起点、终点、城市和出行方式；地点有歧义时先让用户选择。
2. 对自然语言地址调用 `mcp__amap__maps_geo`，对候选 POI 调用 `mcp__amap__maps_search_detail` 补齐坐标。
3. POI 关键词使用 `mcp__amap__maps_text_search`，周边使用 `mcp__amap__maps_around_search`。
4. 路线分别使用 `mcp__amap__maps_direction_driving`、`mcp__amap__maps_direction_transit_integrated`、`mcp__amap__maps_direction_walking` 或 `mcp__amap__maps_bicycling`；距离使用 `mcp__amap__maps_distance`。
5. 只使用 MCP 原始结果中的 GCJ-02 经度、纬度、名称、地址、距离、时长、费用、换乘和步骤字段。
6. 查询成功后调用 `amap_present_map`。最终回答只提示用户可以点击地图卡片，不声称面板已经自动打开。

## `amap_present_map` 约束

- `scene=route` 必须有 `origin`、`destination` 和 `mode`。
- `scene=places` 只提交 1 到 50 个有真实坐标的 POI。
- `scene=location` 只提交一个真实坐标。
- `sourceTools` 必须列出本次实际使用的 `mcp__amap__*` 工具。
- 不得生成、猜测或转换来源不明的坐标；不得把 IP 粗定位当精确当前位置。
- MCP 失败、没有结果或没有坐标时不要调用展示工具伪造地图。
- 不向展示工具传 API Key、securityJsCode、任意 URL、HTML、脚本或文件路径。
