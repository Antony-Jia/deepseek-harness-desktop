# Plugin 开发文档

> 本文档整理在当前项目根目录，用于指导开发人员完成 Plugin（插件）的规划、编码、调试、测试、发布与问题排查。
> 本项目宿主为 **DSH（DeepSeek Harness，npm 运行时 `@deepseek-ai/dsh`，v0.1.0-rc.6）**，插件即 **Cordis 插件（宿主半 + 浏览器半）**。
> 第 1–13 章是通用开发规范与入门指引；**DSH 平台的真实规则以第 14 章为准**，官方文档清单见 14.1——
> 两者冲突时以第 14 章的官方内容为准（"先查文档再写代码，不要凭空猜 API"）。

---

## 1. 文档目的

- 明确 Plugin 的基本概念、开发流程和规范。
- 提供一套可复用的 Plugin 目录结构、配置清单和接口约定。
- 帮助开发人员在遇到问题时快速定位文档和排查路径。

---

## 2. 什么是 Plugin

Plugin（插件）是一种可独立开发、按需安装、动态扩展宿主应用能力的模块。  
通常具备以下特征：

- **低耦合**：不修改宿主应用核心代码，通过扩展点接入。
- **可复用**：同一插件可被多个环境或项目复用。
- **可独立发布**：插件有自己的版本、依赖和发布包。
- **生命周期可控**：宿主可以安装、启用、停用、卸载插件。

常见的插件形态包括：

| 形态 | 说明 |
|---|---|
| 前端插件 | 扩展 UI 组件、编辑器能力、菜单/工具栏、页面路由等 |
| 后端插件 | 扩展服务接口、消息处理、定时任务、数据处理流程等 |
| 构建/工具插件 | 扩展编译、打包、代码检查、命令行工具能力 |
| 平台类插件 | 为某个具体平台（如 AI 平台、低代码平台、邮件系统）提供业务扩展 |

---

## 3. 开发前准备

开始开发前，请确认以下内容：

1. **目标平台/宿主版本**
   - 明确插件要运行的宿主应用名称、版本号、架构。
   - 确认宿主是否已开放插件机制，以及支持的插件类型。

2. **开发语言与运行环境**
   - 确认宿主规定的语言、版本、依赖管理工具。
   - 确认本机 Node.js / JDK / Python / Go 等环境是否就绪。

3. **SDK / API / 示例**
   - 获取宿主提供的 Plugin SDK、API 文档或示例插件。
   - 优先复制官方示例作为起点，避免从零搭建错误骨架。

4. **权限与账号**
   - 获取本地调试所需的测试账号、沙箱环境、API Token 等。
   - 明确发布/上架所需的权限和审核流程。

---

## 4. 插件目录结构（推荐）

以下是一个通用的插件工程目录，实际项目可按宿主规范调整：

```text
my-plugin/
├── manifest.json          # 插件清单：名称、版本、入口、权限、依赖等
├── package.json           # 前端/Node 插件依赖（如有）
├── pom.xml / build.gradle # Java 插件依赖（如有）
├── requirements.txt       # Python 插件依赖（如有）
├── src/
│   ├── main/
│   │   ├── java/          # 或 ts/ py/ go/，插件核心代码
│   │   ├── resources/     # 配置文件、静态资源
│   │   └── web/           # 前端资源（如需要）
│   └── test/              # 单元测试、集成测试
├── docs/                  # 插件自身文档
│   ├── README.md
│   └── CHANGELOG.md
├── examples/              # 配置示例、调用示例
├── scripts/               # 构建、打包、发布脚本
└── .gitignore
```

---

## 5. 插件清单与配置

多数插件通过一个清单文件声明插件元数据。以常见的 `manifest.json` 为例：

```json
{
  "name": "my-plugin",
  "displayName": "我的示例插件",
  "version": "1.0.0",
  "description": "用于演示插件开发",
  "main": "src/index.js",
  "apiVersion": "1.0",
  "engines": {
    "host": ">=1.2.0"
  },
  "permissions": [
    "read:data",
    "write:data"
  ],
  "dependencies": {}
}
```

建议统一维护以下字段：

- `name`：插件唯一标识，建议使用小写字母、数字、连字符。
- `version`：语义化版本号，如 `1.0.0`。
- `main` / `entry`：插件入口文件或类。
- `apiVersion`：依赖的宿主 API 版本。
- `engines`：兼容的宿主版本范围。
- `permissions`：插件申请的权限，遵循最小权限原则。
- `dependencies`：插件自身的依赖，尽量保持精简。

---

## 6. 核心接口与扩展点

插件开发最关键的是正确使用宿主暴露的 **扩展点（Extension Point）**。

常见扩展点包括：

| 扩展点类型 | 说明 | 示例 |
|---|---|---|
| 生命周期钩子 | 插件安装、启用、停用、卸载时执行 | `onActivate()`、`onDeactivate()` |
| 事件监听 | 订阅宿主事件并响应 | 邮件到达、用户点击、任务完成 |
| 命令/菜单 | 向宿主注册新的操作入口 | 右键菜单、工具栏按钮 |
| 服务接口 | 调用宿主提供的 API 完成业务 | 查询数据、发送通知 |
| 自定义组件 | 向宿主 UI 注入组件 | 页面、弹窗、设置面板 |
| 数据转换器 | 扩展数据处理链 | 格式化、脱敏、抽取 |

### 最小示例（伪代码）

```javascript
// 插件入口
export function activate(context) {
  // 注册一个命令
  context.registerCommand('myPlugin.hello', () => {
    context.ui.showMessage('Hello from plugin!');
  });
}

export function deactivate() {
  // 清理资源
}
```

> 实际 API 名称以宿主提供的 SDK 为准，不要凭空猜测。

---

## 7. 插件生命周期

典型插件生命周期如下：

```text
安装 -> 加载 -> 启用 -> 运行 -> 停用 -> 卸载
```

| 阶段 | 开发注意事项 |
|---|---|
| 安装 | 检查依赖是否齐全，写入安装目录或注册表 |
| 加载 | 读取清单、加载入口，避免在加载阶段执行重逻辑 |
| 启用 | 注册命令、监听事件、初始化资源 |
| 运行 | 处理业务，记录日志，处理异常 |
| 停用 | 注销监听、释放资源、保存状态 |
| 卸载 | 清理数据、移除文件、恢复宿主配置 |

**重要原则：**
- 插件不能阻塞宿主主流程。
- 插件内部异常不能导致宿主崩溃。
- 插件启停应可重复，且状态一致。
- 所有外部资源（定时器、连接、文件句柄）必须在停用时释放。

---

## 8. 开发步骤

1. **阅读宿主官方文档**
   - 找到“Plugin / 插件开发”章节。
   - 下载 SDK 和示例插件。

2. **搭建插件骨架**
   - 复制官方示例。
   - 修改 `name`、`version`、`description`、入口文件。
   - 确保空插件可以被宿主识别和启用。

3. **实现第一个扩展点**
   - 从最简单的命令或事件开始。
   - 验证宿主能正确加载插件并触发扩展点。

4. **实现业务逻辑**
   - 按需求拆分模块。
   - 调用宿主 API 获取数据、执行操作。
   - 避免在插件内重复造轮子。

5. **补充配置与权限**
   - 按最小权限声明权限。
   - 将可调整项放入插件配置。

6. **编写测试**
   - 单元测试：覆盖核心逻辑。
   - 集成测试：验证与宿主的交互。
   - 异常测试：模拟宿主 API 不可用、参数错误等。

7. **编写文档**
   - 编写 `README.md`：功能介绍、安装方式、配置说明。
   - 编写 `CHANGELOG.md`：版本变更记录。
   - 如有接口，补充接口说明。

8. **构建与打包**
   - 执行宿主规定的打包命令。
   - 校验产物是否包含清单、入口、依赖和资源。

9. **发布**
   - 上传到插件仓库/市场。
   - 填写版本说明和兼容范围。
   - 按流程申请审核。

---

## 9. 调试与日志

### 9.1 本地调试

- 开启宿主调试模式。
- 使用开发模式加载本地插件目录，修改后热重载。
- 在插件入口处设置断点，跟踪调用链。

### 9.2 日志规范

推荐统一使用宿主提供的日志接口，格式建议：

```text
[时间] [级别] [插件名] [模块] 日志内容
```

示例：

```text
2026-07-16 10:00:00 [INFO] [my-plugin] [service] 开始处理邮件解析任务
2026-07-16 10:00:01 [ERROR] [my-plugin] [service] 调用宿主 API 失败: timeout
```

### 9.3 常见排查手段

1. 查看宿主日志文件。
2. 查看插件自身日志。
3. 在本地最小复现环境中逐行调试。
4. 对比官方示例插件的实现。
5. 使用抓包/链路追踪工具定位 API 调用问题。

---

## 10. 打包与发布检查清单

- [ ] 插件名称、版本号正确。
- [ ] 插件入口文件存在且可加载。
- [ ] 权限声明最小化。
- [ ] 依赖已完整打包或声明清楚。
- [ ] 配置文件不包含敏感信息（密码、Token、私钥）。
- [ ] 文档和更新日志已更新。
- [ ] 已通过单元测试和集成测试。
- [ ] 已在目标版本宿主上验证安装、启用、停用、卸载全流程。

---

## 11. 常见问题与处理建议

| 问题现象 | 可能原因 | 处理建议 |
|---|---|---|
| 插件无法安装 | 版本不兼容 / 缺少依赖 / 清单格式错误 | 检查 `engines`、`apiVersion`、`dependencies`，对照官方示例 |
| 插件启用后不生效 | 入口配置错误 / 扩展点未注册 | 确认 `main` 路径，检查日志中是否出现插件加载记录 |
| 调用宿主 API 报错 | API 版本不匹配 / 权限不足 / 参数错误 | 核对 API 文档、权限声明、参数格式 |
| 插件导致宿主卡顿 | 主线程执行耗时操作 / 死循环 | 将耗时任务放入异步或工作线程，避免阻塞宿主 |
| 插件停用后仍有残留 | 未注销事件/定时器/连接 | 在 `deactivate` 中统一释放资源 |
| 日志不输出 | 日志级别设置过高 / 未使用宿主日志接口 | 调整日志级别，改用宿主推荐日志 API |
| 发布后用户看不到 | 版本未审核 / 仓库未同步 / 权限未分配 | 检查发布状态、仓库地址、用户权限 |

---

## 12. 出现问题去哪里查文档

按以下顺序查询，通常可以最快定位问题：

### 12.1 项目内文档（第一优先级）

- 当前项目根目录下的 `README.md`、`docs/`、`doc/`
- 插件相关文档：`PLUGIN.md`、`plugin-dev.md`、`插件开发指南.md`
- **DSH 平台（本项目宿主）**：npm `@deepseek-ai/dsh` 包内官方文档与本仓库 `dsh-plugin-template/` 模板，见本文档 **14.1 官方文档清单**
- 版本更新说明：`CHANGELOG.md`、`RELEASE_NOTES.md`
- 示例代码：`examples/`、`samples/`、`demo/`
- 源码注释：插件 SDK 或宿主扩展点定义处的 Javadoc / TSDoc / 注释

### 12.2 官方/平台文档（第二优先级）

- 宿主应用官网的“开发者中心”或“插件开发文档”
- 官方 SDK / API Reference
- 官方示例仓库
- 官方博客或技术专栏中的插件开发专题

### 12.3 源码与框架文档（第三优先级）

- 宿主源码中 `plugin` / `extension` / `extension-point` 相关目录
- 依赖框架的官方文档（如 React、Spring Boot、Vue、Webpack 等）
- 语言官方文档（如 Java、JavaScript、Python、Go）

### 12.4 问题反馈渠道（第四优先级）

- 项目 Issue 列表 / 需求单 / Bug 单
- 内部 Wiki 或知识库
- 团队群、邮件组、值班接口人
- 开源社区：GitHub Issues、Gitee Issues、官方论坛、Stack Overflow

### 12.5 日志与监控（用于辅助定位）

- 宿主应用日志
- 插件自身日志
- 应用监控 / 链路追踪系统
- 数据库慢查询、异常堆栈、审计日志

### 12.6 提问前建议准备的信息

如果你需要向他人求助，请提前整理：

1. 宿主应用名称和版本号。
2. 插件名称和版本号。
3. 使用的 SDK/API 版本。
4. 复现步骤（尽量最小化）。
5. 完整错误信息或日志片段。
6. 已尝试过的排查方法。
7. 相关配置文件（隐藏敏感信息）。

---

## 13. 约定与规范

- 所有新增插件必须在根目录或 `docs/` 下补充开发说明。
- 插件命名清晰、版本规范、权限最小化。
- 不修改宿主核心代码，除非是宿主官方要求的扩展方式。
- 插件代码必须通过基础代码检查，并保留单元测试。
- 遇到不确定的 API，先查文档，再写代码；不要靠猜。

---

## 14. DSH（DeepSeek Harness）平台专项：真实插件开发指南

> 内容核对自 npm 安装的 `@deepseek-ai/dsh`（v0.1.0-rc.6）随带官方文档、
> 运行时各 `@deepseek-ai/*` 包 README，以及本仓库 `dsh-plugin-template/` 模板代码。
> 官方文档上的字段、方法签名以 **`cordis_inspect` 实时查询结果**为最终依据。

### 14.1 官方文档清单（先读这些）

| 文档 | 位置 | 内容 |
| --- | --- | --- |
| dsh CLI 总入口 | npm 包内 `@deepseek-ai/dsh/README.md` / `README.zh.md`；npm 页面：<https://www.npmjs.com/package/@deepseek-ai/dsh> | dsh 命令、profile、`dsh plugin` 插件管理、配置树叠加顺序 |
| **动态插件开发 SKILL** | npm 包内 `config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md` | **插件开发权威文档**：宿主/浏览器半、服务、事件、槽位、包内 RPC、动态工具、版本与审批 |
| 组合编辑 SKILL | npm 包内 `config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md` | cordis.yml 组合、host/agent 预设分层、realm 与 isolate |
| 宿主 runner | `@deepseek-ai/dsh-cordis-host-runner/README.zh.md` | 动态包宿主半：define/run/stop、vm 沙箱、fiber 生命周期 |
| 浏览器 runner | `@deepseek-ai/dsh-cordis-client-runner/README.zh.md` | 动态包浏览器半：装载、guard 门面、渲染失败回流 |
| Cordis 工具集 | `@deepseek-ai/dsh-tool-cordis/README.zh.md` | `cordis_inspect/define/run/stop/undefine` 五个工具的语义 |
| Cordis 框架 | `@deepseek-ai/cordis/README.md` | Context、Fiber、`inject`、effect 清理、事件/服务/日志 |
| 本地插件模板 | 本仓库 `dsh-plugin-template/`（README.md、DEBUGGING.md、`lib/index.js`、`lib/client.js`、`cordis.patch.example.yml`） | 可复制、可运行的最小双半插件 + 挂载示例 + 三层调试指南 |
| 参考实现 | 本仓库 `plugins/dsh-desktop-bridge/` | 上线的宿主/浏览器集成插件（托盘、通知、目录选择） |

### 14.2 架构：插件有两半，中间是 HTTP / JSON RPC

```
宿主半（Node 进程，ESM）    ←→    边界（HTTP / JSON RPC）    ←→    浏览器半（页面）
完整 Node 环境，无沙箱             curl 直打路由 / host.call         由 client-modules 加载
console.log → 启动终端             Network 面板                      DevTools Console
```

- **宿主半**：在 DSH 的 Node 进程内运行，`export default` 一个 Cordis 插件。
- **浏览器半**：在页面里运行，固定 `window.__ModuleLoader__.load({ id, factory })` 外壳。
- **静态插件**（随 profile 挂载，代码在 profile 的 `node_modules`）与**动态插件**（会话内用 `cordis_*` 工具定义、只存进程内存，详见 14.7）共用同一套 Cordis 契约。

### 14.3 profile 与插件安装

profile 目录：`$DSH_HOME/profiles/<name>/`（`$DSH_HOME` 默认 `~/.dsh`，Windows 即 `C:\Users\<你>\.dsh`），包含：

- `package.json`：插件依赖 + profile manifest `dsh.profile`（含按顺序排列的 `bundles` 列表）；
- `cordis.patch.yml`：用户自己的 patch 层，**插件挂载行追加在这里**。

配置树叠加顺序（后层覆盖前层）：各 bundle 的 patch（按 `dsh.profile.bundles` 顺序）→ profile 的 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。

插件管理命令（由 `@deepseek-ai/dsh` 提供）：

```sh
dsh web                                    # 启动 web profile（= dsh --profile web）
dsh plugin --profile web add <包名>        # 在 profile 目录内用 pnpm 安装插件
dsh --dump-default-config                  # 不启动，查看组合后的默认配置树
dsh --dump-config                          # 不启动，查看当前配置树
```

挂载行示例（追加到 `profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: my-plugin
      name: 你的包名
      inject: [commands, webServer, fs]   # 按实际需要裁剪；见 14.5
      # config: { ... }                   # 插件配置（可选，apply 的第二个参数）
```

生效方式：**宿主改动 → 重启 dsh；浏览器改动 → 刷新页面（Ctrl+F5）**。

### 14.4 工程结构与 package.json（对照通用第 4、5 章）

DSH 插件**没有 `manifest.json`**，清单就是 `package.json`：

```text
my-plugin/
├── package.json         # 声明 main / exports["./client"] / dsh.client.platform
└── lib/
    ├── index.js         # 宿主半：ESM，export default 一个 Cordis 插件
    └── client.js        # 浏览器半：window.__ModuleLoader__.load({ id, factory }) 外壳
```

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "platform": "web" } }
}
```

要点：

- `name` 必须与目录名一致；浏览器 bundle 里 `load({ id: '...' })` 的 **id 也用同一个名字**；
- `exports["./client"]` + `dsh.client.platform: "web"` 是浏览器半的开关；
- 仅本机使用：把整个目录复制进 `profiles/web/node_modules/你的包名/` + 加 insert 行即可，无发布流程；
- 分享：`npm publish`（去掉 `private: true`）→ 对方执行 `dsh plugin --profile web add <包名>` → 再加相同的 insert 行。

### 14.5 宿主半规范（Node 进程）

一个宿主插件 = `export default` 一个 Cordis 插件，函数形式（`(ctx) => {}`）或对象形式（`{ inject, apply(ctx) }`，本模板用这个）：

```javascript
export default {
  // 硬依赖：loader 会等这些宿主服务就绪后才调用 apply，
  // 否则 apply 可能跑得太早，服务还没就绪（webServer 未就绪时路由会被静默跳过）
  inject: ['commands', 'webServer', 'fs'],

  apply(ctx) {
    // 副作用必须可逆：register/订阅类 API 返回的 disposer 就是清理函数，
    // 插件停止/更新/删除时自动执行——一律用 ctx.effect 包裹或保留 disposer
    ctx.effect(() => ctx.commands.register({
      name: 'template-echo',
      description: '示例指令：回显你输入的内容',
      handler: async (invocation) => {
        const text = invocation.rawInput.trim()
        return { kind: 'success', text: text === '' ? '（空）' : `echo: ${text}` }
      }
    }))

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', // 'exact' 精确匹配路径；'prefix' 匹配前缀
      path: '/my-plugin/echo',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(JSON.stringify({ ok: true }))
      }
    }))
  }
}
```

规则：

- **服务访问**：可选服务用 `const s = ctx.get('xxx'); if (s === undefined) return`；**硬依赖写进 `inject`**（loader 会等这些服务存在后才调用 apply）；
- **副作用可逆**：一律 `ctx.effect(() => xxx.register(...))` 或保留 disposer；
- **事件**：`ctx.on('some/event', (payload) => {})`；Waterfall 事件最后一个参数是 `next`，除非有意截断下游，必须 `return next()`；
- **计时器**：`timer` 是**服务**不是全局函数；使用前 `inject: ['timer']`，然后 `ctx.timeout(fn, ms)` / `ctx.interval(fn, ms)`；**禁止裸 `setTimeout`/`setInterval`**；
- **不要直接 import 其它 DSH 包的内部实现**，一律用服务（`ctx.get` / `inject`）；
- 可以使用 npm 包，但宿主包要能被 loader 从 profile 的 `node_modules` 解析到。

常用宿主服务（先 `cordis_inspect` 查签名再写，方法以查询结果为准）：

| 服务 | 用途 | 常用方法 |
| --- | --- | --- |
| `commands` | 斜杠指令（`/xxx` 直接执行，不经过模型） | `register({ name, description, handler })`，handler 返回 `{ kind: 'success'/'error', text }` |
| `webServer` | HTTP 路由（浏览器 fetch 直连，curl 可直打） | `register`，`kind` 取 `'exact'` 或 `'prefix'`，`path`、`handler(req, res)` |
| `fs` | 文件系统 | `resolve` / `readText` / `writeText`（原子写）/ `listDir` / `stat` / `processPath` |
| `subprocess` | 子进程 | `spawn({ argv, cwd, stdio, graceMs })` |
| `workspaceRegistry` | 工作区 | `list()` / `resolveByPath(path)` |
| `sessions` / `agents` | 会话与 Agent | 如 `invocation.agent.session.header.cwd` |

### 14.6 浏览器半规范（页面）

固定外壳（不要改），导出 `{ inject, apply }`，与宿主半同一套 Cordis 插件契约：

```javascript
window.__ModuleLoader__.load({
  id: 'my-plugin',                        // 必须 = 包名
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')          // React 用 require 拿，不用 import

    var inject = ['slots']                // 依赖的客户端服务（缺失会让插件等待）

    function apply(ctx) {
      // 样式：插入 <style> 标签（dataset.plugin 约定），插件卸载时自动删除
      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'my-plugin'
        tag.textContent = '.my-btn{...}'
        document.head.appendChild(tag)
        return function () { tag.remove() }
      })

      // 槽位注册：先查协议，再用 slots.inject 等槽位声明就绪
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'my-button', order: 30, label: '模板按钮' },
          function () {
            return React.createElement('button', {
              onClick: function () {
                fetch('/my-plugin/echo?text=hi').then(function (r) { return r.json() })
              }
            }, '按钮')
          }
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
```

规则：

- **不能用 `import` / JSX / TypeScript / 装饰器**；UI 一律 `React.createElement(...)`；
- **UI 必须注册进槽位**；注册前先 `cordis_inspect` 查 `Slots.listSubTree` 确认协议（`single`/`list`/`keyed`/`chain`、注册选项、props、当前占用者），**不要猜槽位 key、id、selector**；
- 用 `ctx.slots.inject('<slot>', () => ctx.slots.register(...))` 等槽位声明就绪；`ctx.get('slots')` 可选访问；`ctx.slots` 仅当声明 `inject: ['slots']` 时可用；
- **优先最窄的入口**：侧边栏加按钮用 `sidebar.footer.action` 之类的内层槽位，不要整体替换 `root`/`sidebar`/`conversation`/`details`——替换整个槽位会把它声明的子槽位一起移除；
- **样式**：`ctx.effect` 里插 `<style>`，卸载时删除；优先用主题 CSS 变量；不要直接改 `document.body` / `window` / 硬编码产品 DOM；
- **调宿主**：普通路由用 `fetch('/你的路由?参数')`；动态插件的包内 RPC 用 `host.call(method, args)`（宿主侧 `harness.handle(method, handler)` 注册），只传可无损 JSON 序列化的数据（不能传函数/React 元素/类实例）；
- **常用客户端服务**（inject 声明）：`slots`、`workspaces`、`sessions`、`locale`、`timer`、`layout`；
- **常用槽位**：`sidebar.footer.action`（侧边栏底部按钮）、`conversation.session.header.actions`（会话头部按钮）、`shell.overlay`（全局浮层/面板）、`settings.section` / `settings.general.item`（设置页）、`conversation.chat.turnTail` / `tool.call.toolview`（对话流内卡片）、`tool.view.cordis`（`cordis_run` 卡片内面板，`key: 'self'`）。

### 14.7 动态插件（会话内开发/调试）

模型可以直接在 DSH 会话里用 `cordis_*` 工具定义、运行、调试插件——**不重启改宿主逻辑的首选路径**，验证通过后再固化成静态包：

| 工具 | 用途 |
| --- | --- |
| `cordis_inspect_list` / `cordis_inspect_query` | 查宿主/浏览器当前注册的服务、事件、槽位、主题 token、工具的确切签名（**先查再写**） |
| `cordis_inspect_self(pluginId, packageId)` | 读某定义的源码、版本指针与运行诊断 |
| `cordis_define` | 登记一个包：`code.host` 和/或 `code.client`（纯 JS 函数体，无 import/JSX/TS）——**只登记，不执行** |
| `cordis_run` | `run` = 首次激活/重启/回滚；`update` = 切换/修复版本；带浏览器半且未授权时返回 `awaiting-approval` |
| `cordis_stop` | 停用但保留定义（可再次 run）；`cordis_undefine` = 彻底删除 |

版本语义：`pluginId` = 稳定实例；`packageId` = 不可变代码版本；`pluginRunId` = 每次激活。更新失败时：编辑修复后用 `update` 补 `nextPackageId` 重试，或用 `run` 回滚到 `currentPackageId`。

**动态插件的边界**：只存在于 DSH 进程内存——`cordis_stop`/`cordis_undefine`、工具集卸载或 DSH 重启后即消失；不会创建插件文件、不安装包、不修改 `cordis.yml`、不能跨重启存续，也不会自动转成正式插件。**信任立场**：vm 沙箱隔离全局变量但**不是安全边界**，应像授予 bash 访问一样对待（见 host-runner README 的信任立场）。

### 14.8 调试（对照通用第 9 章的平台实操）

完整三层调试指南见 `dsh-plugin-template/DEBUGGING.md`。核心是分层定位 + **curl 对照法**：

| 现象 | 判断 |
| --- | --- |
| curl 返回 JSON、浏览器拿到 HTML | 浏览器缓存了旧 bundle → **Ctrl+F5** |
| curl 也返回 HTML/404 | 宿主路由没注册：重启过吗？`inject` 声明了吗？动态插件重启后会消失 |
| curl 报 500 | 宿主 handler 抛错，看错误 message / 进程日志 |
| curl 正常、浏览器 JSON 正常但 UI 不对 | 问题在 React 渲染/状态层 |

宿主侧：`node --check lib/index.js` 先做语法冒烟；启动前 `NODE_OPTIONS=--inspect=9229` 再跑 `dsh web`，VS Code Attach 断点。浏览器侧：F12 Console / Network（看 `/你的路由` 的请求、状态码、Content-Type）/ Sources（`/plugins/<包名>/client.js` 断点）。动态插件另有 `cordis_inspect_self` 诊断与 steering 消息。

经典坑（摘自模板与 DEBUGGING.md）：

| 症状 | 根因 |
| --- | --- |
| 面板报 "Unexpected token '<'" | 请求落到 SPA 回退，返回了 index.html——路由未注册/时序问题 |
| `ctx.get('webServer')` 得到 undefined、路由被静默跳过 | 没写 `inject`，apply 跑得太早 |
| 改完客户端不生效 | 浏览器缓存了旧 bundle → Ctrl+F5 |
| 浏览器半页面加载即崩 | bundle 格式错：用了 JSX/import/TypeScript，或没用 `__ModuleLoader__.load` 外壳 |

### 14.9 通用章节与 DSH 实际的差异（核对结论）

| 通用文档章节 | DSH（DeepSeek Harness）实际 |
| --- | --- |
| §5 `manifest.json`（`permissions` / `engines` / `apiVersion`） | **没有 manifest.json**；清单 = `package.json`（`main`、`exports["./client"]`、`dsh.client.platform`），无权限/引擎/API 版本字段 |
| §6 伪代码 `activate(context)` / `context.registerCommand` | Cordis 契约：`export default { inject, apply(ctx) }`；指令用 `ctx.commands.register`；API 签名以 `cordis_inspect` 实时查询为准 |
| §7 生命周期 安装→加载→启用→运行→停用→卸载 | 静态插件 = `cordis.patch.yml` 挂载行（随 profile 启停）；清理靠 fiber effect/disposer；动态插件 = define→run→stop→undefine |
| §10 发布检查清单 | 追加：`exports["./client"]` 与 `dsh.client` 声明正确、bundle id 与包名一致、宿主半 `inject` 裁剪正确、浏览器改动 Ctrl+F5 验证 |
| §12 查文档路径 | 优先 npm 包内 SKILL 文档 + 本仓库 `dsh-plugin-template/`（见 14.1 文档清单） |
| §13 约定 | 追加：宿主半不 import 其它 DSH 包内部实现；动态验证后必须固化为静态包才能留用 |

### 14.10 组合：一个业务方向 = 多个子插件

**结论：DSH 插件天然支持"组合"，且有两层级**，正好对应"一个业务方向 = 一个组合（含一个或多个插件）"。

**层级一：单个包 = 双半（UI + 逻辑合体）**

一个插件包同时含宿主半（逻辑：存储、记忆、路由、指令、后台服务）与浏览器半（UI：新增 button、页面、面板）。最小业务方向可以直接是一个包，挂载一行即生效。

**层级二：多个独立子插件 = 一个组合（Cordis group）**

用 `@cordisjs/plugin-group`（即 `cordis:group`）+ `group: true` 在一个挂载行里声明多个子插件行；子插件各自独立成包、独立版本、独立启停。示例（追加到 `cordis.patch.yml`）：

```yaml
- insert:
    - id: crm                          # 这个业务方向的组合名
      name: '@cordisjs/plugin-group'
      group: true
      config:
        - id: core                     # 纯逻辑子插件：存储/记忆/业务服务（嵌套 id 即 crm:core）
          name: '@market/crm-core'
          inject: [fs, commands]
        - id: ui-button                # 纯 UI 子插件：新增按钮
          name: '@market/crm-ui-button'
          inject: [slots]
        - id: ui-page                  # 纯 UI 子插件：新增页面
          name: '@market/crm-ui-page'
          inject: [slots, webServer]
```

要点：

- group 本身永远启用；停用整个 group → 全部子插件一起停，子插件可单独 disabled；
- 每个子插件仍是独立 Cordis 插件（独立 fiber、独立 `inject`、独立生命周期清理），group 只是把它们组合在一起；
- 嵌套 id 用冒号分隔（如 `crm:core`）；所谓"逻辑/UI 拆分"= 拆成哪些 npm 包 + group 里挂哪些行，**不在包内部嵌套**；
- 业务插件组合**不需要** `isolate` realm（那是 agent 预设做跨会话隔离用的，见编辑组合 SKILL）。

**选型建议**（决定因素是"可选择性 / 版本独立性"）：

| 形态 | 特点 | 适合 |
| --- | --- | --- |
| 单包（一方向一包） | 安装最轻（一行即挂载），但全量激活、一包一版本 | 方向是整体、无可选拆分 |
| 组合 group（一方向多子包，**推荐**） | 子插件可独立发版/修复、可选装、可复用 | 方向有可选模块、需独立更新 |

**市场推荐形态**：组合（group）+ 细粒度子包。业务方向做成一个"组合包（meta-package）"，包内不带真正功能代码，只带一段 `cordis.patch.yml` group 模板并把子包列为 `dependencies`；安装器装完子包后，把 group 行追加进用户 `cordis.patch.yml` 即"一键装一个方向"。

### 14.11 安装与统一管理（npm / pnpm）

**结论：profile 本身就是标准 Node 项目**（`$DSH_HOME/profiles/<name>/` 下有独立的 `package.json` 与 `node_modules`），可被 npm / pnpm / yarn 统一管理；但 **DSH 官方 `dsh plugin` 命令只转发给 pnpm，不是 npm**。

**官方命令（pnpm 转发 + 自动对齐）**

```sh
dsh plugin --profile web add <pkg>      # 在 profile 目录里跑 pnpm add <pkg>
dsh plugin --profile web remove <pkg>
dsh plugin --profile web update <pkg>
dsh plugin --profile web why  <pkg>
dsh plugin --profile web add <本地路径>  # 相对路径锚定到调用命令所在的目录
```

- 参数原样透传：registry 名、git 地址、`file:`/`link:`、tarball 都支持；
- 装完后自动 reconcile `dsh.profile.bundles`：声明了 `dsh.bundle`（带 `patch`）的包自动进入 profile 配置层栈；
- **前置要求**：目标机器 `PATH` 里有 pnpm（缺少时报 `pnpm not found on PATH`）。

**手动方式（任意包管理器）**

```sh
cd "$HOME/.dsh/profiles/web"
npm install <pkg>    # 或 pnpm add / yarn add
```

可把包装进 profile 的 `node_modules`，但**不会**自动更新 `dsh.profile.bundles`、也不会自动挂载。

**安装 ≠ 挂载（重要）**

- 装包 = 用包管理器管理依赖与版本（`dependencies` / `node_modules`）；
- 挂载 = 在 `cordis.patch.yml` 里 `insert` 一行，把插件接进运行中的配置树；
- 装了但没在 patch 里挂行的包，只是"装了个库"，不会被 mount。

因此市场安装器对每个方向做两步（均可脚本化、幂等）：

1. **装包**：`pnpm add` / `npm install` 该方向的所有子包；
2. **挂载**：向 `cordis.patch.yml` 追加该方向的 group 组合行（先做去重）。

**建议**：面向标准用户用官方 `dsh plugin`（需 pnpm）；要兼容无 pnpm 的环境，就用市场客户端直接对 profile 目录跑 `npm install`。

---

*文档维护：Plugin 开发小组 / 项目技术负责人*  
*最后更新：2026-07，已与 npm `@deepseek-ai/dsh` v0.1.0-rc.6 随带官方文档及本仓库 `dsh-plugin-template/` 对齐，并补充"插件组合"与"npm/pnpm 统一管理"讨论结论（详见 Git 提交记录）*
