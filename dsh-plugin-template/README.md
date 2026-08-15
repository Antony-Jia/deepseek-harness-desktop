# dsh-plugin-template — DSH 插件模板

一个**可复制、可运行**的最小 DSH 插件：宿主半（Node）+ 浏览器半（页面），
演示了指令、HTTP 路由、文件系统访问、槽位 UI、共享状态、样式注入等最常见模式。

参考实现：已安装并正在工作的 `dsh-open-workspace`
（`C:\Users\Admin\.dsh\profiles\web\node_modules\dsh-open-workspace\`，
含完整的右侧文件浏览器：目录列表 / 多 tab 预览 / 拖拽宽度）。

## 目录结构

```
dsh-plugin-template/
├── package.json              # 包元数据 + dsh.client 声明（浏览器半的开关）
├── lib/
│   ├── index.js              # 宿主半：指令 / 路由 / 文件读写示例（带注释）
│   └── client.js             # 浏览器半：槽位注册 / store / 样式（带注释）
├── cordis.patch.example.yml  # 挂载示例（insert 行）
├── README.md                 # 本文件
└── DEBUGGING.md              # 分层调试指南
```

## 快速开始

1. **复制**：把 `dsh-plugin-template` 整个目录复制为
   `C:\Users\Admin\.dsh\profiles\web\node_modules\你的包名\`
2. **改名**：改 `package.json` 的 `"name"`（必须与目录名一致）；浏览器 bundle 里
   `window.__ModuleLoader__.load({ id: '...' })` 的 id 也改成同一个名字
3. **写代码**：按 `lib/index.js` / `lib/client.js` 里的注释改；不需要的部分直接删
4. **挂载**：把 `cordis.patch.example.yml` 里的 insert 段追加到
   `C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml`（`inject` 按需裁剪）
5. **生效**：重启 dsh（宿主）+ Ctrl+F5（浏览器）。用
   `curl "http://127.0.0.1:3080/你的路由?..."`
   冒烟宿主路由

## 规范速查

| 项 | 要求 |
| --- | --- |
| 宿主半 | ESM，`export default` 一个 Cordis 插件（函数或 `{inject, apply}`） |
| 浏览器半 | `window.__ModuleLoader__.load({ id, factory })` 外壳，导出 `{inject, apply}`；无 import/JSX |
| package.json | `main` = 宿主入口；`exports["./client"]` = 浏览器入口；`dsh.client.platform: "web"` |
| 挂载 | `cordis.patch.yml` 里 `- insert: [{ id, name, inject?, config? }]` |
| 服务访问 | 可选 `ctx.get`+判空；硬依赖 `inject`（防激活太早） |
| 副作用 | 一律 `ctx.effect(() => xxx.register(...))` 或保留 disposer，保证可逆 |

## 发布/分发

- **仅本机**：复制进 `profiles\web\node_modules\` + 加 insert 行即可，无发布流程。
- **分享**：`npm publish`（去掉 `private: true`）→ 对方 `dsh plugin --profile web add <包名>` → 加 insert 行。

## 调试

见 [DEBUGGING.md](DEBUGGING.md)——三层（宿主 / 边界 / 浏览器）各自的手段，
以及"curl 对照法"这个最实用的定位套路。
