# DSH UI 皮肤插件开发方案

> 状态：已实现首版，Web 内容同步已接入
> 文档版本：0.1  
> 日期：2026-08-19  
> 目标：在不改变页面布局、功能入口和交互逻辑的前提下，通过市场插件统一改变 DSH Desktop 与 DSH Web 的主题配色、按钮、输入框、面板等视觉样式，并支持本地背景图片。

## 1. 背景与结论

当前 DSH Desktop 已支持 `light`、`dark`、`system` 三种外观模式，外框样式主要位于 `dist/styles.css`，选择结果由 Tauri 持久化到 `PersistedState.theme`。现有市场插件可以在 DSH Web 的正式 slot 中注册自己的 UI，并为插件自己的组件注入样式，但没有正式的“全局皮肤包”协议。

本功能不应实现成任意 CSS 覆盖插件。推荐新增受控、声明式的 Theme Pack（主题包）协议：插件只提供宿主允许的语义 token 和本地图片资源，Desktop 与 Web 各自通过主题服务消费同一份清单。插件不得接触产品 DOM selector，也不得改变布局属性。

本方案首个示例皮肤暂定名为 **Neon Agent**，采用近黑、深海军蓝、电蓝和克制紫色的赛博科技风格。

## 2. 范围

### 2.1 本期包含

- 全局基础色、文字色、弱化文字色和强调色。
- 标题栏、卡片、面板、弹窗和工具卡片的视觉样式。
- 按钮的背景、文字、边框、圆角、阴影以及 hover、active、focus、disabled 状态。
- 输入框、文本域、选择器的背景、文字、占位文字、边框、光标及 focus 状态。
- 标签、状态徽标、滚动条、分隔线和焦点环。
- 一张随插件本地分发的背景图片，以及背景位置、缩放、透明度、遮罩和轻微模糊参数。
- Desktop 外框与 DSH Web iframe 的一致主题应用。
- 安装后预览、确认启用、恢复默认、卸载回退和加载失败回退。
- 主题包的市场清单校验、资源校验和状态持久化。

### 2.2 明确不包含

- 改变现有页面布局、导航、功能入口或交互流程。
- 改变元素的 `display`、`position`、宽高、间距、顺序或层级结构。
- 替换整个标题栏、侧边栏、会话区或其他根级 slot。
- 允许主题包携带任意 CSS、CSS selector、HTML 或可执行 JavaScript。
- 允许主题包加载远程图片、远程字体或远程样式。
- 插件自带 Tauri 原生代码。
- 首版动画主题、视频背景、粒子引擎和自定义字体。
- 复制参考图中的人物、Logo、文字或具体界面构图。

## 3. 核心设计原则

### 3.1 外观模式与皮肤分离

`light/dark/system` 表示外观模式，`skinId` 表示选中的视觉皮肤，两者不能复用同一个字段。

建议持久化状态扩展为：

```json
{
  "appearanceMode": "system",
  "skinId": "@p-dsh-market/neon-agent-theme",
  "backgroundIntensity": 0.32,
  "reduceEffects": false
}
```

- `appearanceMode`：`light | dark | system`。
- `skinId`：`builtin.default` 或已安装主题包名。
- `backgroundIntensity`：用户级覆盖值，范围 `0..1`。
- `reduceEffects`：关闭非必要 glow、blur 和过渡效果。

迁移时将现有 `theme` 值转入 `appearanceMode`；`skinId` 默认设为 `builtin.default`。

### 3.2 声明式 token，不开放任意 CSS

宿主维护一套稳定的语义 token。主题包只能为允许列表中的 token 提供值，宿主负责把这些值映射到实际组件。这样可以避免主题依赖 DOM 结构，并允许宿主继续修复无障碍、响应式和组件状态。

### 3.3 Desktop 与 Web 边界不互相穿透

- Desktop 外框由 Tauri 宿主主题管理器应用主题。
- DSH Web 由浏览器侧正式 `theme` 服务应用主题；Theme Pack token 由 Desktop bridge 映射为 DSH 的 `--dsw-*` 语义变量。
- iframe 内插件不得用 DOM selector 修改 Tauri 外框。
- Desktop 不得直接修改 iframe 内部 DOM。
- 两端通过主题 ID、规范化 token 和资源描述保持一致。

### 3.4 默认可恢复

无论主题清单损坏、资源缺失、插件被禁用、插件卸载还是 Web 端加载失败，都必须回退到内建默认主题。恢复默认入口不能由主题插件隐藏或重绘到不可见。

## 4. 主题包协议

### 4.1 npm 包结构

```text
@p-dsh-market/neon-agent-theme
├─ package.json
├─ theme/
│  └─ theme.json
├─ assets/
│  ├─ background.webp
│  └─ preview.webp
├─ lib/
│  ├─ index.js
│  └─ client.js
└─ cordis.patch.yml
```

主题清单和资源必须包含在 npm 包的 `files` 中。路径必须是包内相对路径，禁止绝对路径、`..` 路径穿越、URL 和符号链接逃逸。

### 4.2 `package.json.dsh` 建议扩展

```json
{
  "name": "@p-dsh-market/neon-agent-theme",
  "version": "0.1.0",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./theme": "./theme/theme.json",
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
      "displayName": "Neon Agent",
      "capabilities": [
        "client",
        "desktop-theme",
        "web-theme",
        "theme-pack"
      ]
    },
    "desktop": {
      "permissions": [
        "shell:theme"
      ]
    },
    "theme": {
      "schemaVersion": 1,
      "id": "neon-agent",
      "displayName": "Neon Agent",
      "entry": "./theme/theme.json",
      "preview": "./assets/preview.webp",
      "supportedAppearances": ["dark"]
    }
  }
}
```

说明：

- `theme-pack` 表示该包提供声明式主题，而不是普通功能页面。
- `desktop-theme` 与 `web-theme` 明确主题影响的消费端。
- `shell:theme` 需要在安装确认中展示，但只授权宿主读取并应用声明式主题，不能授予任意 DOM 或原生命令能力。
- 首版主题包仍沿用市场 scope `@p-dsh-market/*`。

### 4.3 `theme.json` 建议结构

```json
{
  "schemaVersion": 1,
  "appearance": "dark",
  "tokens": {
    "shared": {
      "color.background.base": "#02040D",
      "color.surface.primary": "rgba(7, 14, 38, 0.90)",
      "color.surface.secondary": "rgba(12, 23, 58, 0.82)",
      "color.text.primary": "#EDF4FF",
      "color.text.secondary": "#879AC8",
      "color.border.default": "rgba(61, 105, 255, 0.35)",
      "color.accent.primary": "#1976FF",
      "color.accent.secondary": "#7B4DFF",
      "color.success": "#3BD6AF",
      "color.warning": "#F4C563",
      "color.danger": "#FF708C",
      "focus.ring": "0 0 0 3px rgba(25, 118, 255, 0.32)"
    },
    "desktop": {
      "titlebar.background": "rgba(2, 6, 22, 0.90)",
      "panel.backdropBlur": "12px"
    },
    "web": {
      "conversation.surface": "rgba(4, 10, 29, 0.76)",
      "sidebar.surface": "rgba(3, 8, 24, 0.88)"
    },
    "components": {
      "button.background": "rgba(22, 61, 155, 0.32)",
      "button.hoverBackground": "rgba(37, 91, 230, 0.50)",
      "button.border": "rgba(53, 112, 255, 0.55)",
      "button.radius": "8px",
      "button.shadow": "0 0 18px rgba(35, 103, 255, 0.18)",
      "input.background": "rgba(3, 10, 30, 0.78)",
      "input.border": "rgba(74, 116, 255, 0.38)",
      "input.focusBorder": "#397CFF",
      "input.placeholder": "#6576A5",
      "input.caret": "#6CA5FF",
      "panel.radius": "10px",
      "panel.shadow": "0 0 24px rgba(21, 60, 180, 0.20)"
    }
  },
  "background": {
    "image": "../assets/background.webp",
    "targets": ["desktop.home", "desktop.market", "web.shell"],
    "fit": "cover",
    "position": "center",
    "opacity": 0.32,
    "overlay": "rgba(1, 4, 15, 0.62)",
    "blur": "0px",
    "fixed": true
  }
}
```

## 5. Token 允许列表与限制

### 5.1 允许修改

| 类别 | 示例 | 说明 |
| --- | --- | --- |
| 颜色 | `color.*` | HEX、RGB、RGBA 或受限渐变 |
| 边框 | `*.border` | 只改变颜色，不改变布局宽度 |
| 圆角 | `*.radius` | 受宿主最小值和最大值限制 |
| 阴影 | `*.shadow`、`focus.ring` | 限制层数、长度和模糊半径 |
| 背景 | `*.background` | 纯色或受限线性渐变 |
| 模糊 | `*.backdropBlur` | `0..20px`，可被“减少效果”覆盖 |
| 控件状态 | `hover/active/focus/disabled` | 必须保留可识别差异 |
| 图片参数 | `fit/position/opacity/overlay/blur` | 由宿主背景层消费 |

### 5.2 禁止修改

- `display`、`position`、`inset`、`z-index`。
- `width`、`height`、`min/max-*`。
- `margin`、`padding`、`gap`。
- `grid-*`、`flex-*`、`order`、`float`。
- `overflow`、`pointer-events`、`visibility`。
- `content`、任意伪元素文本和任意 selector。
- 外部 `url(...)`、`@import`、`@font-face`。
- 会隐藏 focus、disabled、error 或 selection 状态的配置。

圆角虽然可能轻微改变绘制边界，但不改变盒模型尺寸，可列入允许项。按钮和输入框高度、内边距继续由宿主控制。

## 6. 背景图片设计

### 6.1 当前示例素材

- 文件：[`assets/neon-agent-background.png`](./assets/neon-agent-background.png)
- 用途：Desktop 首页、插件市场和 DSH Web 外层背景候选图。
- 视觉：近黑深蓝底，电蓝和克制紫色电路纹理集中在边缘，中央保留低对比留白。
- 来源：使用 GPT Image 生成的原创背景；附件仅作为氛围和配色参考，未复制人物、标识、文字和界面布局。

### 6.2 运行时渲染层级

```text
背景底色
  -> 本地背景图片
  -> 用户可调暗色遮罩
  -> 可选轻微模糊
  -> 现有页面内容与半透明面板
```

背景图片不应直接设置到每张卡片上。Desktop 和 Web 都应使用单一、不可交互的背景层；页面内容层维持现有结构和点击区域。

### 6.3 资源约束

- 首版格式：PNG、JPEG、WebP；不接收 SVG。
- 推荐比例：16:9。
- 推荐最低尺寸：1920×1080。
- 最大尺寸：7680×4320。
- 单张文件建议不超过 8 MiB，安装校验硬上限建议 16 MiB。
- 图片必须随 npm 包本地分发，禁止 HTTP/HTTPS URL。
- 解码失败、尺寸异常或资源缺失时忽略背景并继续应用颜色 token。
- 低显存或“减少效果”模式可以关闭 blur，但不应关闭遮罩。

## 7. 应用架构

```text
已安装 web profile
       |
       v
主题包发现与清单校验
       |
       +---------------------+
       |                     |
       v                     v
Desktop Theme Manager    DSH Web theme service
       |                     |
       v                     v
Tauri 外框 CSS variables  Web 语义 CSS variables
       |                     |
       +----------+----------+
                  |
                  v
          同一 skinId 与共享 token
```

### 7.1 Desktop Theme Manager

建议新增 `src-tauri/src/theme.rs`，职责包括：

- 从 web profile 已安装依赖中发现 `theme-pack`。
- 解析并校验 `package.json.dsh.theme` 和 `theme.json`。
- 解析包内真实路径并拒绝越界资源。
- 生成规范化 `ThemePackSummary` 与 `ResolvedThemePack`。
- 为前端提供已校验 token 和可访问的本地资源 URL。
- 处理启用、预览、确认、取消和回退。
- 不执行主题包中的代码来获取清单。

建议增加受控命令：

```text
list_theme_packs()
get_active_theme_pack()
preview_theme_pack(packageName)
confirm_theme_pack(packageName, settings)
cancel_theme_preview()
reset_theme_pack()
```

### 7.2 Desktop 前端

`dist/app.js` 不再只根据 `data-theme` 控制颜色，而是设置：

```html
<html
  data-appearance="dark"
  data-skin="neon-agent"
>
```

规范化 token 通过 `document.documentElement.style.setProperty()` 映射到宿主定义的 CSS 变量。映射逻辑属于宿主，不属于插件。

背景使用宿主创建的固定层，例如：

```html
<div id="theme-background" aria-hidden="true"></div>
```

该节点不承载交互，不能覆盖标题栏拖拽、窗口按钮或页面点击。

### 7.3 DSH Web `theme` 服务

当前 npm 启动的 DSH Web 已提供正式的浏览器半 `theme` 服务和 ThemePresenter。主题包通过 bridge 使用该接口：

```javascript
ctx.theme.register({
  id: 'neon-agent',
  colorScheme: 'dark',
  tokens: dswAliasTokens,
})
ctx.theme.setTheme('neon-agent')
```

主题插件通过 Cordis 生命周期注册和注销主题；上游 `ThemePresenter` 负责将主题快照投影到 `body[data-ds-dark-theme]`、`html { color-scheme }` 和 Web 的语义 CSS 变量。插件不得直接查询或修改产品 DOM。若服务不可用，bridge 会向 Desktop 回传错误，设置页显示 Web 未应用，而不是静默显示半套主题。

### 7.4 Desktop 与 iframe 同步

推荐将用户选择保存在 Desktop 状态中，Web 连接后由桥接插件同步：

1. Web 启动并声明 `theme` 服务就绪。
2. Desktop bridge 发送当前 `skinId`、`appearanceMode` 和用户覆盖参数。
3. Web 仅在对应主题包已安装、已启用、协议兼容且成功注册时应用。
4. Web 回传成功或结构化错误。
5. Desktop 显示“双端已应用”或“仅 Desktop 生效”的诊断状态。

## 8. 设置与交互

现有“主题模式”卡片建议拆成两层：

```text
外观模式
[亮色] [暗色] [跟随系统]

界面皮肤
[默认主题] [Neon Agent] [浏览更多]

背景强度  --------●---
[ ] 减少光晕和模糊效果
[恢复默认主题]
```

主题安装后不自动启用：

1. 用户在市场安装主题包。
2. 设置页显示预览图、支持的外观模式和影响范围。
3. 点击“预览”后临时应用，开始 15 秒安全倒计时。
4. 用户点击“保留主题”后持久化。
5. 用户取消、倒计时结束或前端失联时恢复上一个主题。

如果主题只支持暗色，而用户选择亮色，首版建议停用该皮肤并回退默认亮色，不自动强制改变用户的外观模式。

## 9. 生命周期与回退

### 9.1 启用条件

主题只有同时满足以下条件才允许应用：

- 插件存在于 web profile 的确定版本依赖中。
- 插件已启用。
- `protocolVersion` 与主题 `schemaVersion` 兼容。
- 市场清单和已安装清单均通过重新校验。
- `theme.entry`、preview 和背景资源位于包目录内。
- 主题支持当前有效外观模式。
- Desktop 或 Web 对应消费端已成功注册。

### 9.2 卸载行为

- 卸载非当前主题：不影响现有界面。
- 卸载当前主题：先切回 `builtin.default`，确认界面恢复后再卸载。
- 卸载失败：保持插件与选择状态，不得留下指向不存在资源的半卸载状态。
- 背景缓存可以清除；用户的背景强度与减少效果偏好可以保留。

### 9.3 启动恢复

启动顺序建议：

1. 使用内建默认主题绘制首屏。
2. 加载持久化状态。
3. 校验所选主题包。
4. 校验成功后原子应用规范化主题。
5. 任何步骤失败都保持默认主题并记录可读诊断，不阻塞应用启动。

## 10. 安全与性能

### 10.1 安全

- 远程市场清单和本地已安装清单都要重新校验。
- 主题 JSON 需要限制总大小、字符串长度、token 数量和嵌套深度。
- token 名称使用允许列表，未知 token 返回结构化错误或按兼容策略忽略。
- CSS 值按类型解析，不能直接拼接未校验字符串。
- 图片路径必须 canonicalize 后确认仍在插件包目录内。
- 禁止 SVG、data URL、远程 URL、CSS URL 和字体资源。
- 主题包不能执行原生命令，也不能获得工作区读写权限。

### 10.2 可读性

- 正文与背景对比度目标至少 4.5:1。
- 大字和非文本控件边界至少 3:1。
- focus 状态不能只依赖颜色变化。
- error、warning、success 必须保持可区分。
- 背景遮罩不得低于宿主定义的安全阈值；用户增加背景强度时仍需满足对比度要求。

### 10.3 性能

- 图片只解码一次，Desktop 与 Web 各自复用。
- 不在滚动和轮询过程中反复设置全部 CSS 变量。
- 主题切换使用单次批量提交，避免逐 token 可见闪烁。
- `backdrop-filter` 数量受宿主控制，主题只能提供建议值。
- Windows 低性能或远程桌面环境自动关闭不必要 blur/glow。

## 11. 实施拆分

### 阶段 A：协议与 Desktop 示例

- 扩展 DSH Plugin Contract，增加主题 capability、权限、清单和校验规则。
- 增加 `theme.rs` 和主题包读取、校验、回退能力。
- 拆分 `appearanceMode` 与 `skinId` 状态。
- 将现有 Desktop CSS 重构为语义变量。
- 在设置页实现主题选择、预览、倒计时确认和恢复默认。
- 接入 Neon Agent 背景和 token。

阶段 A 完成后，Desktop 首页、插件市场、标题栏和原生设置区域可完整换肤；DSH Web 仍使用自己的主题。

### 阶段 B：DSH Web 主题服务（已接入）

- 对接 DSH Web 已发布的 `--dsw-*` 语义 CSS token 和 Cordis `theme` 服务。
- 增加 Desktop bridge 主题状态同步与应用回执。
- 将侧边栏、对话区、按钮、输入框和工具卡片迁移到语义变量。
- 完成 Desktop 与 Web 一致性验证。

### 阶段 C：市场体验与治理

- 市场卡片识别 `theme-pack` 并展示预览、兼容模式和影响范围。
- 增加当前主题卸载保护。
- 增加主题诊断、资源错误和双端应用状态。
- 增加主题包模板和发布检查。
- 增加内网 Registry 场景下的资源完整性验证。

## 12. 预计代码影响范围

| 路径 | 预计修改 |
| --- | --- |
| `src-tauri/src/state.rs` | 外观模式、skinId 和主题偏好持久化及迁移 |
| `src-tauri/src/theme.rs` | 新增主题发现、解析、校验、资源解析和回退 |
| `src-tauri/src/market.rs` | 增加主题 capability、清单与资源校验 |
| `src-tauri/src/lib.rs` | 注册主题命令、状态摘要和 bridge 同步 |
| `dist/index.html` | 设置区皮肤选择和宿主背景层 |
| `dist/app.js` | 主题列表、预览、确认、回退和变量映射 |
| `dist/styles.css` | 将硬编码视觉值迁移到宿主语义变量 |
| `plugins/*/lib/client.js` | Desktop bridge 通过 `theme` 服务注册并选择 Web 主题 |
| `docs/DSH插件协议v1.md` | 增加正式 Theme Pack 协议 |
| `docs/plugin开发文档.md` | 增加主题包开发与调试说明 |

DSH Web 的语义 token 和 `theme` 服务已由 npm 运行时提供；Desktop 仓库只维护协议 token 到上游 `--dsw-*` 变量的固定映射。

## 13. 测试方案

### 13.1 Rust 单元测试

- 合法主题清单可以解析并规范化。
- 未知 schema、capability、permission 和 token 被拒绝。
- 绝对路径、`..`、URL、符号链接逃逸被拒绝。
- 图片缺失、超限、格式错误得到结构化错误。
- 已选择主题被卸载或禁用后回退默认主题。
- 旧 `theme` 状态可以正确迁移到 `appearanceMode`。

### 13.2 前端测试

- light、dark、system 与 skinId 独立工作。
- 预览取消、超时和确认行为正确。
- 背景强度与减少效果可以持久化。
- 不支持当前外观模式时回退正确。
- Desktop 与 Web 应用状态和错误提示正确。

### 13.3 布局不变验证

在应用主题前后采集关键组件的 `getBoundingClientRect()`：

- 标题栏与窗口控制按钮。
- 首页主要卡片。
- 插件市场搜索框和插件卡片。
- DSH Web 侧边栏、对话区、输入区和工具卡片。

除字体渲染造成的亚像素差异外，位置与尺寸应保持一致。主题 token 不允许改变盒模型相关属性。

### 13.4 视觉与无障碍验证

- 在 100%、125%、150% Windows 缩放下检查背景裁切。
- 检查 1280×720、1920×1080 和超宽窗口。
- 验证普通、hover、focus、disabled、error 状态。
- 使用对比度检查确保正文、弱化文字和控件边界符合目标。
- 开启减少动态效果、高对比度和远程桌面场景进行降级检查。

### 13.5 回归验证

- `npm test`
- `npm run check`
- `cargo fmt -- --check`
- `cargo check`
- `cargo test`
- `npm pack --dry-run --json` 检查示例主题资源确实进入包。
- 安装包构建后验证背景资源不依赖开发机绝对路径。

## 14. 验收标准

1. 启用皮肤前后，页面功能、布局、入口和交互行为不变。
2. Desktop 标题栏、首页、市场以及 DSH Web 的按钮、输入框、面板采用一致主题语言。
3. 背景图片来自已安装插件本地资源，不发起外部网络请求。
4. 中央内容区域在默认遮罩下保持清晰可读。
5. 主题包不能通过清单注入任意 CSS、selector、HTML 或脚本。
6. 主题预览可以取消，15 秒未确认自动回退。
7. 当前主题损坏、禁用或卸载时自动恢复内建默认主题。
8. light、dark、system 与皮肤选择互不混淆。
9. Desktop 与 Web 任一端应用失败时均可诊断，不能静默显示半套主题。
10. 通过单元测试、前端检查、布局不变验证和构建验证。

## 15. 当前待确认项

- 首版是否只支持暗色皮肤；本方案建议 Neon Agent 仅支持暗色。
- 背景是否同时应用到 Desktop 首页、市场和 DSH Web；本方案默认三处均可用，由 `targets` 控制。
- 主题预览是否采用 15 秒确认倒计时；本方案建议保留，以防不可读配置。
- DSH Web `theme` 服务已由 npm Runtime 上游发布，Desktop 通过 bridge 对接其正式接口。
- 市场首版是否只允许官方/企业签名主题包，还是允许所有通过协议校验的 `@p-dsh-market/*` 包。

## 16. GPT Image 生成记录

生成方式：Codex 内置 GPT Image。

最终提示词：

```text
Use case: stylized-concept
Asset type: desktop application and web UI background image, 16:9 landscape
Primary request: create an original dark cyber-futuristic background inspired only by the blue-violet neon atmosphere of the reference image; suitable behind an existing productivity UI without changing its layout
Input images: the supplied image is a mood and palette reference only, not an edit target; do not copy its character, branding, text, panels, or composition
Scene/backdrop: abstract high-tech command-space ambience, near-black navy field with restrained electric-blue and violet light traces, subtle circuit geometry, faint holographic grid, a few soft volumetric glows and glass-like reflections
Composition/framing: wide 16:9 wallpaper; keep the central 60 percent calm, dark, low-detail, and low-contrast for readable UI content; concentrate decorative energy near the outer edges and corners; balanced for common desktop crops
Lighting/mood: premium, precise, quiet cyberpunk, dark and immersive rather than flashy
Color palette: near-black #02040D, deep navy #07112C, electric blue #126BFF, indigo #4934D4, restrained violet #8A45FF
Materials/textures: subtle smoked glass, fine luminous circuitry, sparse particles, gentle bloom; clean and polished
Constraints: background artwork only; no people, no anime character, no mascot, no UI cards, no buttons, no interface mockup, no readable text, no letters, no numbers, no logos, no trademarks, no watermark; avoid bright areas behind likely content; must remain legible under translucent dark panels
Avoid: busy center, dense starfield, city skyline, spaceships, weapons, strong lens flare, magenta-dominant palette, obvious copied motifs
```

该图片当前作为方案素材和未来示例主题资产使用；在正式发行前仍需完成实际界面叠加、对比度、不同窗口比例与压缩格式验证。
