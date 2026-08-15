# DSH 插件调试指南

插件横跨**宿主（Node 后端）**和**浏览器（前端）**两层，中间还有一层**边界（HTTP/RPC）**。
调试先判断问题在哪一层，再用那一层的工具。

```
宿主（Node 进程）     ←→     边界（HTTP）     ←→     浏览器（页面）
console.log→终端            curl 直打路由           DevTools Console/Network
启动日志                    Network 面板            Sources 断点 / React DevTools
```

**核心套路：curl 对照法。** 浏览器报错时，用 curl 打同一个 URL：

- curl 返回 JSON、浏览器拿到 HTML → **浏览器缓存**（Ctrl+F5）或页面加载了旧 bundle
- curl 也返回 HTML/404 → **宿主路由没注册**（重启过吗？inject 声明了吗？）
- curl 报 500 → 宿主 handler 抛错，看错误里的 message / 进程日志
- curl 正常、浏览器也拿到 JSON 但 UI 不对 → 问题在 React 渲染/状态层

---

## 1. 宿主（后端）调试

| 手段 | 怎么做 | 适用 |
| --- | --- | --- |
| 日志 | `console.log/error` → 输出到 `dsh web` 进程的 stdout（启动它的终端） | 流程、变量、异常 |
| curl 直打 | `curl "http://127.0.0.1:3080/你的路由?参数"` | 验证路由与 handler，完全绕过 UI |
| 语法/加载冒烟 | `node --check lib/index.js`；在 profile 目录 `node --input-type=module -e "import('你的包名')"` | 改完先确认能编译能导入 |
| 启动失败 | 宿主模块坏了 → boot 直接失败（FAIL_LOUD），错误打在启动日志 | 启动即崩 |
| 断点调试 | 启动前 `NODE_OPTIONS=--inspect=9229` 再跑 `dsh web`，VS Code Attach | 想单步走宿主逻辑 |
| 热迭代 | 宿主逻辑先写成动态插件（`cordis_define`/`cordis_run` update），不重启改逻辑，跑通后固化进静态包 | 宿主静态包改一次要重启一次 |

**常见坑：激活时序。** 宿主插件没声明 `inject` 时 apply 可能跑得太早——
`ctx.get('webServer')` 拿到 `undefined`，路由注册被静默跳过（症状：curl 返回 SPA 的
index.html）。凡是要用 `webServer`/`fs` 等较晚就绪的服务，务必写进 `inject`。

## 2. 浏览器（前端）调试

| 手段 | 怎么做 | 适用 |
| --- | --- | --- |
| Console | F12 → Console；插件 `console.log` 带包名标签（`[dsh-open-workspace]`） | 渲染、事件、状态 |
| Network | F12 → Network，看 `/你的路由` 的请求/响应/状态码/Content-Type | **边界问题首选** |
| Sources 断点 | F12 → Sources → 打开 `/plugins/<包名>/client.js`，打断点 | 单步渲染逻辑 |
| React DevTools | 浏览器插件装 React DevTools，看面板组件的 props/state | 状态、tabs、目录不对时 |
| 语法预检 | `node --check lib/client.js` | 避免页面加载即崩 |
| 缓存 | 改客户端代码后必须 **Ctrl+F5**（bundle 路由 `cache-control: no-cache`） | 改了没生效先怀疑缓存 |

**常见坑：bundle 格式。** 浏览器半必须用 `window.__ModuleLoader__.load({ id, factory })`
外壳，`id` 等于包名；不能用 import/JSX/TypeScript。格式错了页面加载时报错在 Console。

## 3. 动态插件自带的诊断

对话里调试动态插件时：

- `cordis_inspect_self(pluginId, packageId)` → 宿主/客户端运行状态、等待的服务、
  apply 失败、渲染失败的诊断信息
- 运行卡片上的错误会通过 steering 消息报给你
- 改代码 = 定义新 Package（不可覆盖旧版本）+ `cordis_run` update

静态包没有这套面板，等价信息在：宿主侧 = 启动日志；浏览器侧 = DevTools Console。

## 4. 推荐迭代工作流

1. **宿主逻辑**：先动态插件快速验证（改逻辑不重启）→ 同步进静态包 → 重启验证一次
2. **浏览器 UI**：直接改静态包文件 → Ctrl+F5 刷新（bundle 每次请求读文件，不用重启）
3. **边界**：每次改动后用 curl 冒烟一遍路由，再点 UI

## 5. 本会话踩过的坑（对照参考）

| 症状 | 根因 | 定位手段 |
| --- | --- | --- |
| 面板报 "Unexpected token '<'" | 浏览器请求落到 SPA 回退，返回了 index.html | Network 看 Content-Type + curl 对照 |
| 面板报 "文件列表服务不可用（HTTP 200）" | 宿主路由未注册：进程重启后动态插件消失 + 永久插件缺 `inject` 激活太早 | `cordis_inspect_self` 发现动态插件没了；curl 返回 HTML |
| 按钮"点击没反应" | 旧按钮走系统打开 RPC，路径未就绪或打开静默失败 | 改为应用内面板（一定有可见反馈）+ 面板内显式报错 |
| 改完客户端不生效 | 浏览器缓存了旧 bundle | Ctrl+F5 硬刷新 |
