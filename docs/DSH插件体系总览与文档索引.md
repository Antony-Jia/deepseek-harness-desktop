# DSH 插件体系总览与文档索引

> 本文是 DSH 插件相关文档的总入口，用于快速判断“应该阅读哪一份文档”。具体字段、流程和代码示例应进入对应专题文档查询。

## 1. 一句话概览

DSH 插件以 npm 包为交付单位，通过 DSH/Cordis 扩展宿主逻辑和 Web UI，通过 DSH Desktop 插件市场完成发现、安装与卸载，并通过 DSH Plugin Contract 约束 Tauri 外框 UI、权限和插件数据生命周期。

## 2. 总体结构

```text
                          npm registry
                               |
                               | 搜索、读取清单、安装确定版本
                               v
+----------------------------------------------------------------+
| DSH Desktop                                                    |
|                                                                |
|  插件市场                                                      |
|  - @p-dsh-market/*                                             |
|  - 清单校验                                                     |
|  - 安装 / 卸载 / 重启提示                                       |
|                                                                |
|  Tauri 桌面外框                                                |
|  - 核心按钮：市场、首页、窗口控制                               |
|  - 插件贡献：标题栏按钮、菜单、独立页面                         |
|  - 原生能力：文件夹、终端、通知、受控存储                       |
+---------------------------+------------------------------------+
                            |
                            | 启动 web profile
                            v
+----------------------------------------------------------------+
| DSH / Cordis                                                   |
|                                                                |
|  宿主半                         浏览器半                        |
|  - Skill                       - DSH Web slots                  |
|  - command                     - 按钮 / 面板 / 页面             |
|  - service / route             - 通过 HTTP / JSON RPC 调宿主    |
|  - 后台任务                                                     |
+---------------------------+------------------------------------+
                            |
                            | 宿主分配路径
                            v
+----------------------------------------------------------------+
| 插件数据                                                       |
| - workspace/.p-dsh-market/<pluginId>/                          |
| - %LOCALAPPDATA%/dsh-desktop/plugin-data/<pluginId>/           |
| - %LOCALAPPDATA%/dsh-desktop/plugin-cache/<pluginId>/          |
+----------------------------------------------------------------+
```

## 3. 三份专题文档

### 3.1 [Plugin 开发文档](./plugin开发文档.md)

回答“一个 DSH 插件怎么写”。

主要内容：

- Cordis 插件的宿主半和浏览器半。
- `package.json` 的 DSH 基础字段。
- `main`、`exports["./client"]` 和 `dsh.client.platform`。
- command、Skill、service、HTTP route 等宿主能力。
- DSH Web slots 的 UI 注册方法。
- `ctx.effect`、disposer、依赖注入和调试方法。
- 单包组合和 Cordis group。

适合读者：插件开发者、调试插件运行问题的维护者。

不负责：Tauri 外框按钮、市场安装器实现、插件数据删除策略。

### 3.2 [DSH Desktop 插件市场开发方案](./插件市场开发方案.md)

回答“插件怎样被发现、校验、安装和卸载”。

主要内容：

- 插件市场位于 Tauri 桌面外框，而不是 DSH Web DOM 内部。
- `@p-dsh-market/*` 市场命名空间。
- 市场搜索结果、插件卡片和只读降级。
- `dsh plugin --profile web` 的安装与卸载流程。
- 桌面私有 pnpm、子进程边界和写操作互斥。
- 当前 `dsh.market` 清单校验要求。
- 安装后重启提示、错误处理和首版验证范围。

适合读者：DSH Desktop 和插件市场维护者。

不负责：插件内部业务代码写法，也不完整定义外框 UI、SQLite 和数据生命周期。

### 3.3 [DSH Plugin Contract v1](./DSH插件协议v1.md)

回答“插件可以向桌面声明什么，以及这些能力如何被约束”。

主要内容：

- `package.json.dsh` 的桌面协议扩展。
- Tauri 标题栏、菜单、页面等正式贡献点。
- 插件安装状态与外框按钮可见性的关系。
- capability 与 permission 的区别。
- 受控原生命令和插件 RPC。
- `.p-dsh-market` 工作区目录约定。
- 用户数据、缓存和 SQLite 的存储位置。
- 安装、升级、停用和卸载时的数据策略。
- 插件注册表、协议校验和安全限制。

适合读者：协议设计者、桌面外框开发者、需要持久化数据的插件作者。

状态：设计草案，不能当作当前代码已完整支持的能力清单。

## 4. 推荐阅读路径

### 4.1 第一次理解整个插件体系

1. 先阅读本文的总体结构。
2. 阅读《Plugin 开发文档》的 DSH 专项章节，理解宿主半、浏览器半和 Cordis 生命周期。
3. 阅读《插件市场开发方案》，理解 npm 包如何进入 web profile。
4. 阅读《DSH Plugin Contract v1》，理解桌面外框和数据治理的目标协议。

### 4.2 开发普通 Web UI 插件

1. 《Plugin 开发文档》：`package.json`、浏览器半和 slots。
2. 《插件市场开发方案》：市场包清单和 bundle patch。
3. 只有需要 Tauri 外框或原生能力时，再阅读《DSH Plugin Contract v1》。

### 4.3 开发外框按钮插件

1. 《DSH Plugin Contract v1》：`desktop.contributes`、permissions 和可见性状态机。
2. 《插件市场开发方案》：安装、卸载和重启状态。
3. 《Plugin 开发文档》：如果按钮还要调用 DSH 宿主逻辑，再实现宿主半和 RPC。

### 4.4 开发记忆或 SQLite 插件

1. 《DSH Plugin Contract v1》：`desktop.storage`、SQLite 迁移和卸载策略。
2. 《Plugin 开发文档》：后台服务、route、effect 和 disposer。
3. 《插件市场开发方案》：清单校验、安装与卸载确认流程。

### 4.5 修改插件市场

1. 《插件市场开发方案》作为当前实现依据。
2. 《DSH Plugin Contract v1》作为下一阶段协议目标。
3. 对照《Plugin 开发文档》，确保没有破坏 DSH/Cordis 现有加载方式。

## 5. 职责边界速查

| 问题 | 权威专题文档 |
| --- | --- |
| npm 包怎样声明宿主入口和浏览器入口？ | Plugin 开发文档 |
| Cordis 插件如何注册服务、Skill、路由？ | Plugin 开发文档 |
| DSH Web 内部按钮放到哪里？ | Plugin 开发文档中的 slots 规范 |
| 市场接受哪些 npm 包？ | 插件市场开发方案 |
| 市场如何调用 pnpm 安装和卸载？ | 插件市场开发方案 |
| Tauri 外框按钮放到哪里？ | DSH Plugin Contract v1 |
| 插件未安装时按钮是否显示？ | DSH Plugin Contract v1 |
| 文件夹和 Terminal 按钮由谁提供？ | DSH Plugin Contract v1 的工作区工具示例 |
| `.p-dsh-market` 放什么？ | DSH Plugin Contract v1 |
| SQLite 放在哪里？ | DSH Plugin Contract v1 |
| 卸载插件时是否删除数据？ | DSH Plugin Contract v1 |
| 当前市场首版做到了哪些能力？ | 插件市场开发方案 |

## 6. 关键术语

| 术语 | 含义 |
| --- | --- |
| 宿主半 | 在 DSH Node 进程中运行的 Cordis 插件逻辑 |
| 浏览器半 | 在 DSH Web 中运行、通过 slots 注册 UI 的插件逻辑 |
| 桌面外框 | DSH Web iframe 之外的 Tauri 标题栏、菜单和桌面页面 |
| contribution | 插件向宿主声明的按钮、菜单、页面等扩展项 |
| capability | 用于市场展示和分类的能力摘要，不代表授权 |
| permission | 插件请求并由宿主执行校验的权限 |
| bundle patch | 安装后将插件挂载进 DSH profile 配置树的 patch |
| plugin data | SQLite、记忆、用户配置等应长期保留的数据 |
| plugin cache | 可以删除并重新生成的数据 |
| workspace data | 当前项目中的临时代码、索引或生成文件 |

## 7. 当前状态与目标状态

| 能力 | 当前状态 | 目标状态 |
| --- | --- | --- |
| DSH 宿主半和浏览器半 | 已有文档和模板 | 保持 Cordis 契约 |
| 市场搜索、安装、卸载 | 首版已实现并有方案记录 | 扩展协议校验和权限展示 |
| `dsh.market` 基础清单 | 已有 | 增加 `protocolVersion`、desktop 和 storage |
| DSH Web slots | 已有 | 继续用于 iframe 内 UI |
| Tauri 外框贡献点 | 尚未形成插件协议 | 由 `desktop.contributes` 声明 |
| 文件夹 / Terminal 按钮 | 当前属于桌面硬编码 UI | 由已安装工作区工具插件决定是否显示 |
| 插件工作区目录 | 尚无统一治理协议 | `.p-dsh-market/<pluginId>/` |
| SQLite 生命周期 | 尚无统一治理协议 | 宿主分配目录、默认保留、可确认删除 |

## 8. 文档冲突时的优先级

不同文档描述的层次不同，原则上不应互相替代。发生冲突时按以下方式判断：

1. 当前 DSH 运行时和官方 Cordis 接口决定“现在能否运行”。
2. 《插件市场开发方案》决定当前市场首版的实现边界。
3. 《DSH Plugin Contract v1》决定下一阶段桌面贡献和数据治理的目标协议。
4. 《Plugin 开发文档》中的通用示例如果与 DSH 专项章节冲突，以 DSH 专项章节为准。

如果目标协议尚未进入代码，必须明确标注“设计中”或“尚未实现”，不能仅凭文档字段宣称功能已经可用。

## 9. 维护约定

- 新增插件能力时，先判断它属于 Cordis、市场还是桌面协议。
- 修改共享字段时，同时检查三份专题文档是否产生含义冲突。
- 新增桌面权限、扩展点或存储类型时，更新《DSH Plugin Contract v1》和本文索引。
- 修改市场实际支持范围时，更新《插件市场开发方案》的实现状态。
- 修改插件代码模板、slots 或生命周期时，更新《Plugin 开发文档》。
- 文档中的“已实现”结论必须有当前代码或测试证据；设计目标应明确标注状态。

---

*文档角色：DSH 插件体系总入口*  
*最后更新：2026-08-18*
