# dsh-open-workspace 旧版重装说明

该文件保留给已有手工安装用户。正式发布包已经改为
`@p-dsh-market/dsh-open-workspace`，建议使用 DSH Desktop 的“插件市场”完成安装和卸载。

安装后请重启 DSH，让 `cordis.patch.yml` 自动挂载宿主半与浏览器半；卸载后同样重启，插件的命令、路由、样式和右侧面板会一并撤销。

如果必须手工恢复，请将整个包复制到当前 `web` profile 的 `node_modules/@p-dsh-market/dsh-open-workspace/`，并在 profile 的 patch 层插入包内 `cordis.patch.yml` 内容。不要再使用旧的无 scope 包名 `dsh-open-workspace`。
