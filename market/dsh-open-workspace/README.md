# @p-dsh-market/dsh-open-workspace

为 DSH `web` profile 提供工作区文件浏览器和对话区终端入口，并通过 DSH 插件协议向 Tauri 外框贡献标题栏操作。

## 功能

- Tauri 外框只在插件已安装、启用且协议校验通过时动态显示“文件夹”和“Terminal”贡献按钮；插件卸载后按钮自动消失。
- 点击“文件夹”打开 `shell.overlay` 悬浮面板；面板整体宽度可从左缘拉宽，左侧层级目录宽度独立可调，不会随面板宽度按比例变化。
- 目录按父子节点展开，不再逐层进入；右侧以多标签预览 Markdown、HTML 和常见代码/文本文件，代码文件与 Markdown fenced code 会做轻量语法高亮。
- 面板支持“固定/取消固定”：固定后保持打开，取消固定时点击面板外可关闭；宽度、目录宽度和固定状态保存在本地插件偏好中。
- Terminal 使用 DSH 的语义颜色 token，跟随 DSH 的亮色、暗色或系统主题切换，不再固定为深色。
- Markdown 先转义再渲染；HTML 在无脚本 sandbox 中预览，避免把工作区文件直接作为 DSH 页面执行。
- `/workspace` 指令用系统默认文件管理器打开当前会话工作区，也可以传入指定路径。
- DSH Desktop 外层标题栏的“Terminal”在输入框下方打开内嵌 PowerShell 面板，支持输入命令、清空输出和关闭面板；Windows 使用受控管道传输，POSIX 使用 PTY。
- 所有宿主路由和客户端样式都通过 Cordis effect 注册，插件卸载后会撤销注册并关闭悬浮面板。

## Tauri 外框贡献协议

包清单声明 `dsh.protocolVersion: 1`、`desktop-shell` capability、标题栏权限以及 `desktop.titlebar.workspaceActions` 的两个受控原生命令：

- `workspace.openFolder`：向插件发送打开悬浮文件面板消息；
- `workspace.openTerminal`：向插件发送打开输入框下方 Terminal 消息。

Tauri 外框读取 web profile 中已安装的市场插件，重新校验清单、权限、扩展点、条件和动作白名单后才渲染贡献。插件不能直接调用任意 Tauri command，也不能通过 DOM 选择器修改外框。

## 安装与卸载

在 DSH Desktop 的“插件市场”搜索并安装 `@p-dsh-market/dsh-open-workspace`，安装后重启 DSH 生效。卸载同样从插件市场操作，重启后宿主命令、路由和浏览器 UI 一并移除。

插件只读取用户通过 DSH 当前工作区可访问的目录和文件；单文件读取上限为 1 MB，二进制或超大文件会提示使用系统默认应用打开。Terminal 只启动固定的交互式 PowerShell（非 Windows 使用系统交互式 shell），工作目录由当前工作区解析得到，输入长度限制为 16 KB。
