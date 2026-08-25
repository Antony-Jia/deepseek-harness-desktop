# 高德工具路由

| 任务 | 首选工具链 |
| --- | --- |
| 地址到坐标 | `maps_geo` |
| 坐标到地址 | `maps_regeocode` |
| 关键词 POI | `maps_text_search` → 必要时 `maps_search_detail` |
| 周边 POI | `maps_geo` → `maps_around_search` → 必要时详情 |
| 天气 | `maps_weather` |
| 距离 | `maps_distance` |
| 驾车 | 地理编码/详情 → `maps_direction_driving` |
| 公交地铁 | 地理编码/详情 → `maps_direction_transit_integrated` |
| 步行 | 地理编码/详情 → `maps_direction_walking` |
| 骑行 | 地理编码/详情 → `maps_bicycling` |

高德 MCP 是事实来源；地图 JS API 只负责把同一组点位画出来，不能静默替换回答中的距离、时间或费用。
