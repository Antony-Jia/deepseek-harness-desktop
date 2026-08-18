# DSH Plugin Contract v1

> 状态：设计草案，尚未完整实现。
>
> 本文定义 DSH 市场插件在 npm 包清单、Tauri 桌面外框扩展、权限、存储和生命周期方面的统一协议。当前代码与本文不一致之处，应视为后续实施项，而不是现有能力。

## 1. 目标

DSH 插件目前已经可以把宿主逻辑、浏览器逻辑、Skill 和 bundle patch 放进同一个 npm 包。本协议在此基础上补充以下约束：

- 插件可以声明 Tauri 桌面外框上的按钮、菜单和页面入口。
- 插件未安装、未启用或不兼容时，不得显示其外框 UI。
- 插件只能使用宿主公开且经过授权的原生能力。
- 插件的代码、配置、缓存、工作区文件和持久化数据具有明确边界。
- SQLite 等持久化数据与插件建立逻辑归属，但不存放在 `node_modules` 中。
- 安装、升级、停用和卸载行为可验证、可恢复，并避免意外删除用户数据。

本文不取代 Cordis 插件契约。Cordis 继续负责 DSH 进程内的宿主半和浏览器半生命周期；本文负责 npm 包进入 DSH Desktop 后的桌面级声明和资源治理。

## 2. 设计原则

### 2.1 声明与执行分离

插件在 `package.json` 中声明能力，DSH Desktop 负责校验和执行。插件不能因为在清单中写入某个字段，就自动获得对应权限。

### 2.2 插件包不可变，运行数据外置

- npm 包和 `node_modules` 只保存代码、静态资源、数据库迁移和默认配置。
- SQLite、用户记忆、生成文件和缓存保存在宿主分配的目录。
- 插件更新或重装不得依赖修改 npm 包内部文件来保留状态。

### 2.3 最小权限

外框按钮只能调用允许列表中的原生命令或已注册的插件 RPC。不得从清单直接执行任意 shell、任意 Tauri command 或任意磁盘路径。

### 2.4 默认保留持久化数据

卸载插件不等于删除用户数据。缓存可以自动清理；SQLite、记忆和用户生成内容默认保留，只有用户明确确认后才能删除。

### 2.5 两类 UI 边界明确

| UI 所在位置 | 所属协议 | 注册方式 |
| --- | --- | --- |
| DSH Web iframe 内部 | Cordis 浏览器插件 | `ctx.slots.inject/register` |
| DSH Desktop Tauri 外框 | 本文桌面贡献协议 | `dsh.desktop.contributes` |

Web 插件不得通过 DOM 选择器修改 Tauri 外框；桌面插件也不得绕过 Web slots 修改 DSH 页面内部结构。

## 3. npm 包作为协议载体

### 3.1 第一版清单位置

第一版直接扩展现有的 `package.json.dsh` 字段。npm 允许包声明自定义字段，市场可以在搜索候选包后读取完整包清单并进行协议校验。

```json
{
  "name": "@p-dsh-market/workspace-tools",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "protocolVersion": 1,
    "client": {
      "platform": "web"
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "market": {
      "displayName": "工作区工具",
      "capabilities": [
        "host",
        "client",
        "desktop-shell",
        "workspace-storage"
      ]
    },
    "desktop": {
      "permissions": [],
      "contributes": {},
      "storage": []
    }
  }
}
```

### 3.2 未来拆分清单

当协议过大时，可以增加外部清单：

```json
{
  "dsh": {
    "protocolVersion": 1,
    "manifest": "./dsh.plugin.json"
  }
}
```

外部清单必须包含在 npm `files` 中，路径必须位于包目录内。第一版不需要实施该拆分，以免同时维护两种权威来源。

### 3.3 标识规则

- npm 包名仍是安装和版本管理标识，例如 `@p-dsh-market/workspace-tools`。
- 插件资源使用稳定的 `pluginId`。第一版可从包名末段推导，例如 `workspace-tools`。
- `pluginId`、贡献项 `id` 和存储项 `id` 必须匹配 `[a-z0-9]+(?:-[a-z0-9]+)*`。
- 同一插件内的贡献项和存储项 ID 不得重复。
- 文件系统路径不得直接使用带 `/` 的 scoped npm 包名。

## 4. 市场能力与权限

`dsh.market.capabilities` 用于展示和初步筛选，不是权限授权。可使用的能力名称包括：

| capability | 含义 |
| --- | --- |
| `skills` | 注册模型可加载的 Skill |
| `host` | 包含 DSH Node 宿主逻辑 |
| `client` | 包含 DSH Web 浏览器逻辑 |
| `desktop-shell` | 声明 Tauri 外框贡献项 |
| `workspace-storage` | 使用工作区插件目录 |
| `persistent-storage` | 使用用户级持久化数据 |
| `sqlite` | 使用宿主分配位置中的 SQLite 数据库 |

`dsh.desktop.permissions` 是安装前展示、运行时授权和宿主执行检查的依据。第一版建议使用以下权限：

| permission | 允许行为 |
| --- | --- |
| `shell:titlebar` | 在允许的标题栏扩展点注册按钮 |
| `shell:page` | 注册桌面外框独立页面入口 |
| `workspace:read` | 获取当前工作区的宿主规范化路径 |
| `workspace:write-plugin-data` | 写入本插件的工作区数据目录 |
| `native:open-folder` | 调用宿主的打开文件夹能力 |
| `native:open-terminal` | 调用宿主的工作区终端能力 |
| `storage:user` | 使用本插件的用户级数据目录 |
| `storage:sqlite` | 创建和访问本插件声明的 SQLite 文件 |
| `notifications:native` | 发送经过限流的系统通知 |

协议校验通过不代表权限已经授予。安装界面必须向用户展示敏感权限；运行时还必须再次校验插件状态和命令允许列表。

## 5. Tauri 外框贡献协议

### 5.1 正式扩展点

第一版建议只开放少量、稳定的扩展点：

| 扩展点 | 用途 | 形态 |
| --- | --- | --- |
| `desktop.titlebar.navigation` | 外框主导航入口 | 有序列表 |
| `desktop.titlebar.workspaceActions` | 与当前工作区相关的动作 | 有序列表 |
| `desktop.appMenu` | 应用级菜单动作 | 有序列表 |
| `desktop.pages` | 外框独立页面 | keyed 集合 |
| `desktop.statusbar` | 简短状态展示 | 有序列表 |

插件不得声明像素坐标、DOM selector 或替换整个标题栏。宿主决定实际布局、响应式折叠、主题和无障碍行为。

### 5.2 标题栏按钮示例

```json
{
  "dsh": {
    "desktop": {
      "permissions": [
        "shell:titlebar",
        "workspace:read",
        "native:open-folder",
        "native:open-terminal"
      ],
      "contributes": {
        "titlebarActions": [
          {
            "id": "open-folder",
            "slot": "desktop.titlebar.workspaceActions",
            "label": "文件夹",
            "icon": "folder",
            "order": 100,
            "when": "workspaceSelected",
            "action": {
              "type": "native",
              "command": "workspace.openFolder"
            }
          },
          {
            "id": "open-terminal",
            "slot": "desktop.titlebar.workspaceActions",
            "label": "Terminal",
            "icon": "terminal",
            "order": 110,
            "when": "workspaceSelected",
            "action": {
              "type": "native",
              "command": "workspace.openTerminal"
            }
          }
        ]
      }
    }
  }
}
```

### 5.3 按钮字段

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `id` | 是 | 插件内唯一、kebab-case |
| `slot` | 是 | 必须属于宿主公开扩展点 |
| `label` | 是 | 非空纯文本，宿主限制长度 |
| `icon` | 否 | 内建图标名，或未来支持的包内受控 SVG |
| `order` | 否 | 有界整数，仅决定同一扩展点内顺序 |
| `when` | 否 | 宿主支持的声明式条件表达式 |
| `action` | 是 | 受控原生命令或插件 RPC |

### 5.4 `when` 条件

第一版不实现任意表达式，只支持宿主定义的有限状态：

- `workspaceSelected`
- `dshRunning`
- `pluginActive`
- `restartNotRequired`

多个条件可以用数组表达全部满足，避免在清单中执行代码。

### 5.5 Action 类型

#### 受控原生命令

```json
{
  "type": "native",
  "command": "workspace.openFolder"
}
```

命令必须出现在宿主允许列表中，并且插件声明了对应权限。不得把任意 Tauri invoke 名称直接暴露给插件。

#### 插件 RPC

```json
{
  "type": "pluginRpc",
  "method": "memory.openPanel"
}
```

RPC 只能调用当前已激活插件注册的方法，只能传递可无损 JSON 序列化的数据，并受超时、返回大小和错误脱敏限制。

### 5.6 可见性状态机

```text
未安装                 -> 不显示贡献项
已安装但清单无效       -> 不显示，市场显示协议错误
已安装但协议不兼容     -> 不显示，市场显示兼容性错误
已安装但已禁用         -> 不显示
已安装但等待重启       -> 默认不显示，市场提示重启后生效
已安装且已激活         -> 根据 when 条件显示或禁用
卸载中                 -> 立即禁用，完成后移除
```

“文件夹”和“Terminal”应作为工作区工具插件的贡献项。它们可以继续调用 Tauri 内部已有的安全实现，但插件未安装时不应出现在外框中。

插件市场、首页、窗口最小化、最大化和关闭按钮属于 DSH Desktop 核心能力，不受插件安装状态控制。

## 6. 存储协议

### 6.1 存储分类

| scope | 宿主解析位置 | 适用内容 | 默认卸载策略 |
| --- | --- | --- | --- |
| `workspace` | `<workspace>/.p-dsh-market/<pluginId>/` | 临时代码、索引、项目生成物 | 询问 |
| `user` | `%LOCALAPPDATA%/dsh-desktop/plugin-data/<pluginId>/` | SQLite、记忆、用户设置 | 保留 |
| `cache` | `%LOCALAPPDATA%/dsh-desktop/plugin-cache/<pluginId>/` | 可重新生成的缓存 | 删除 |

目录名称统一使用 `.p-dsh-market`，不使用 `.p-dsh-maket`。

### 6.2 存储声明示例

```json
{
  "dsh": {
    "desktop": {
      "storage": [
        {
          "id": "workspace-files",
          "scope": "workspace",
          "kind": "directory",
          "retention": "temporary",
          "onUninstall": "prompt"
        },
        {
          "id": "memory",
          "scope": "user",
          "kind": "sqlite",
          "file": "memory.sqlite",
          "retention": "persistent",
          "onUninstall": "retain",
          "schemaVersion": 1,
          "migrations": "./migrations"
        },
        {
          "id": "embedding-cache",
          "scope": "cache",
          "kind": "directory",
          "retention": "rebuildable",
          "onUninstall": "delete"
        }
      ]
    }
  }
}
```

### 6.3 字段约束

- `scope` 只能是 `workspace`、`user` 或 `cache`。
- `kind` 第一版只能是 `directory` 或 `sqlite`。
- `file` 只能是文件名，禁止绝对路径、路径分隔符和 `..`。
- `migrations` 必须是包内相对路径，并包含在 npm `files` 中。
- 插件不能自行覆盖宿主解析出的根目录。
- 工作区尚未选择时，`workspace` 存储不可用，宿主应返回明确错误。

### 6.4 SQLite 规则

- 数据库不得存放在 `node_modules` 或 npm 包目录中。
- 宿主向插件提供解析后的数据库路径或受控存储服务。
- 数据库迁移必须有单调递增的 `schemaVersion`。
- 更新前应完成数据库备份或可恢复迁移检查。
- 同一插件不得同时由多个不协调的进程执行迁移。
- 停用或卸载前必须停止写入、关闭连接，并处理 SQLite 的 `-wal` 和 `-shm` 文件。
- 降级到不支持当前 schema 的旧插件版本时必须拒绝启动，除非插件明确提供安全降级迁移。

### 6.5 `.p-dsh-market` 工作区目录

建议结构：

```text
<workspace>/
└── .p-dsh-market/
    ├── workspace-tools/
    │   ├── tmp/
    │   └── generated/
    └── memory/
        ├── index/
        └── exports/
```

每个插件只能访问自己的子目录。是否将该目录加入 Git，应由插件说明和用户决定；宿主不能静默修改项目 `.gitignore`。

## 7. 安装、启用和卸载生命周期

### 7.1 安装

```text
搜索 npm 候选包
-> 读取确定版本的完整 package.json
-> 校验包名、DSH 基础清单和 protocolVersion
-> 校验贡献点、权限和存储声明
-> 向用户展示权限及数据影响
-> 通过 DSH CLI 安装确定版本
-> 重新读取 web profile 已安装状态
-> 建立宿主插件注册记录
-> 按需创建或延迟创建数据目录
-> 提示重启 DSH
-> 重启后激活并显示贡献项
```

数据目录建议在首次使用时延迟创建，避免只安装未使用就产生空目录。

### 7.2 启用与停用

- 启用前重新校验协议版本、权限和依赖。
- 所有 UI、事件、路由和后台任务必须有 disposer 或可逆注销过程。
- 停用时先禁用外框贡献项，再停止任务、关闭连接并注销能力。
- 停用不删除代码或用户数据。

### 7.3 升级

- 使用确定版本，不使用未解析的版本范围执行市场写操作。
- 升级前比较新增权限、存储和迁移声明；新增敏感权限需要再次确认。
- 先备份或验证数据迁移，再切换插件版本。
- 升级失败时不得让注册表显示一个未实际安装的版本。

### 7.4 卸载

```text
标记卸载中并禁用按钮
-> 停止插件后台任务
-> 注销 Web slots 和桌面贡献项
-> 关闭 SQLite 和文件句柄
-> 通过 DSH CLI 删除 npm 包
-> 重新读取已安装状态
-> 根据存储策略保留、询问或删除数据
-> 更新插件注册记录
-> 必要时提示重启 DSH
```

卸载对话框至少提供：

- 仅卸载插件并保留数据，默认推荐。
- 卸载插件并删除可重建缓存。
- 卸载插件并删除全部数据，需要二次确认。
- 打开数据目录或导出数据。

不得依赖 npm `preuninstall`、`postuninstall` 等生命周期脚本删除用户数据。

## 8. 插件注册表与权威来源

DSH Desktop 可以维护派生的插件注册表，用于快速渲染外框贡献项和保存启用状态。建议记录：

```json
{
  "pluginId": "workspace-tools",
  "packageName": "@p-dsh-market/workspace-tools",
  "version": "0.1.0",
  "enabled": true,
  "protocolVersion": 1,
  "permissions": [],
  "contributions": [],
  "storage": [],
  "restartRequired": false
}
```

注册表只是派生状态，不能取代实际安装状态：

- web profile 中的确定版本依赖是“是否安装”的权威来源。
- npm 包中的 `package.json` 是该版本协议声明的权威来源。
- 宿主注册表保存启用状态、授权结果和经过校验的缓存。
- 启动时发现三者不一致，应进入修复或只读状态，不应盲目渲染按钮。

插件不得直接修改宿主注册表。

## 9. 安全约束

- 所有远程清单和已安装清单都必须重新校验。
- 贡献点、图标、命令、路径、字符串长度和排序值必须使用允许列表或边界检查。
- 不允许清单携带任意 HTML、JavaScript、CSS selector 或 shell 命令。
- 原生命令按插件身份、启用状态和权限逐次校验。
- RPC 必须限制超时、输入/输出大小，并对错误和日志脱敏。
- 插件只能写入宿主分配给自己的目录。
- 删除前解析并确认最终路径仍位于目标插件目录中。
- npm 包通过协议校验不代表其代码可信；市场仍需展示发布者和权限信息。
- 安装成功不等于激活成功，加载错误必须在市场诊断中可见。

## 10. 协议校验

市场展示前至少检查：

- 包名属于允许的市场 scope。
- `dsh.protocolVersion` 是宿主支持的整数版本。
- 现有 DSH 基础字段 `main`、client export、web platform 和 bundle patch 有效。
- `capabilities` 与实际声明不存在明显矛盾。
- permissions 全部来自宿主已知集合。
- slot、action command 和条件全部来自允许列表。
- ID 唯一并符合命名规则。
- 存储 scope、kind、文件名和迁移路径安全。
- 包内入口、patch、图标和迁移资产确实包含在发布包中。

协议错误应返回结构化结果，例如：

```json
{
  "code": "DSH_PLUGIN_INVALID_CONTRIBUTION",
  "field": "dsh.desktop.contributes.titlebarActions[0].slot",
  "message": "未知的桌面扩展点"
}
```

## 11. 第一阶段实施边界

为了保持首版可控，建议第一阶段只实现：

1. `dsh.protocolVersion: 1`。
2. `desktop.titlebar.workspaceActions` 扩展点。
3. 内建 `folder`、`terminal` 图标。
4. `workspace.openFolder`、`workspace.openTerminal` 两个受控原生命令。
5. `workspace`、`user`、`cache` 三种存储范围。
6. `directory` 和 `sqlite` 两种存储类型。
7. `retain`、`prompt`、`delete` 三种卸载策略。
8. 一个工作区工具测试插件，用来接管当前“文件夹 / Terminal”按钮的显示资格。

第一阶段不包含：

- 任意第三方 Tauri 原生代码加载。
- 任意 shell 命令声明。
- 插件自定义标题栏 HTML/CSS。
- 热加载、跨 profile 同步或批量更新。
- 未经确认的自动数据删除。
- 通用表达式语言和复杂菜单系统。

## 12. 与其他文档的关系

- 插件如何编写宿主半、浏览器半、Skill 和 Cordis 生命周期：参见 [Plugin 开发文档](./plugin开发文档.md)。
- 市场如何搜索、校验、安装和卸载 npm 包：参见 [DSH Desktop 插件市场开发方案](./插件市场开发方案.md)。
- 三份文档的职责边界和推荐阅读顺序：参见 [DSH 插件体系总览与文档索引](./DSH插件体系总览与文档索引.md)。

---

*协议名称：DSH Plugin Contract v1*  
*文档状态：设计草案，等待实现与验证*  
*最后更新：2026-08-18*
