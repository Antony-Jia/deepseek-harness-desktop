window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    // 文件夹和 Terminal 入口现在由 Tauri 外层标题栏统一提供。
    // 保留 bridge 的 host 通知能力，但不再向 DSH 侧边栏注册冲突按钮。
    exports.inject = []
    exports.apply = function () {}
    return module.exports
  }
})
