# @p-dsh-market/dsh-open-workspace

为 DSH `web` profile 提供工作区文件浏览器和对话区终端入口。

## 功能

- 点击 DSH Desktop 外层标题栏的“文件夹”（或会话标题栏文件按钮），在对话右侧的原生 details 列打开当前会话工作区；不再占用左下角侧边栏按钮。
- 左侧浏览目录，右侧以多标签预览 Markdown、HTML 和常见代码/文本文件；代码文件与 Markdown fenced code 会做轻量语法高亮。
- Terminal 使用 DSH 的语义颜色 token，跟随 DSH 的亮色、暗色或系统主题切换，不再固定为深色。
- 右侧面板内部的代码预览区默认占 64%，拖拽分隔线后仍至少保留 61%；外层 details 列的最终宽度仍由 DSH layout 运行时控制。
- Markdown 先转义再渲染；HTML 在无脚本 sandbox 中预览，避免把工作区文件直接作为 DSH 页面执行。
- `/workspace` 指令用系统默认文件管理器打开当前会话工作区，也可以传入指定路径。
- DSH Desktop 外层标题栏的“Terminal”在输入框下方打开内嵌 PowerShell 面板，支持输入命令、清空输出和关闭面板；Windows 使用受控管道传输，POSIX 使用 PTY。
- 所有宿主路由和客户端样式都通过 Cordis effect 注册，插件卸载后会撤销注册并关闭右侧面板。

## 安装与卸载

在 DSH Desktop 的“插件市场”搜索并安装 `@p-dsh-market/dsh-open-workspace`，安装后重启 DSH 生效。卸载同样从插件市场操作，重启后宿主命令、路由和浏览器 UI 一并移除。

插件只读取用户通过 DSH 当前工作区可访问的目录和文件；单文件读取上限为 1 MB，二进制或超大文件会提示使用系统默认应用打开。Terminal 只启动固定的交互式 PowerShell（非 Windows 使用系统交互式 shell），工作目录由当前工作区解析得到，输入长度限制为 16 KB。
