// =============================================================================
// DSH 插件模板 — 浏览器半（在页面里运行，经 client-modules 服务加载）
//
// 固定外壳：window.__ModuleLoader__.load({ id, factory }) 不要改。
// 导出对象 = { inject, apply }，与宿主半同一套 Cordis 插件契约。
//
// 规则速记：
//   - 不能用 import / JSX / TypeScript；React 用 require('react') 拿
//   - UI 必须注册进"槽位"（先 cordis_inspect 查 Slots.listSubTree 确认协议）
//   - 状态用 React hooks；跨组件共享状态用订阅 store（见下）
//   - 样式：手动插入 <style>（官方包的 dataset 约定），插件卸载时自动删除
//   - 调宿主：fetch('/你的路由?参数')，用 Network 面板看请求/响应
//     （动态插件另有 host.call/harness.handle，静态包没有）
//
// 常用客户端服务（inject 声明）：slots、workspaces、sessions、locale、timer、layout
// 常用槽位（先查协议再注册）：
//   sidebar.footer.action                  侧边栏底部按钮（root 作用域，所有会话可见）
//   conversation.session.header.actions    会话头部按钮
//   shell.overlay                          全局浮层（面板/弹层）
//   settings.section / settings.general.item  设置页
//   conversation.chat.turnTail / tool.call.toolview  对话流内卡片
// =============================================================================
window.__ModuleLoader__.load({
  id: 'dsh-plugin-template',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    // 依赖的客户端服务（缺失会让插件等待；按需裁剪）
    var inject = ['slots']

    // ── 一个最小的共享 store 模式（可选；多个组件共享状态时用）────────
    var store = { count: 0, last: null }
    var listeners = []
    function getState() { return store }
    function setState(patch) {
      store = Object.assign({}, store, patch)
      for (var i = 0; i < listeners.length; i++) listeners[i]()
    }
    function subscribe(fn) {
      listeners.push(fn)
      return function () { listeners = listeners.filter(function (f) { return f !== fn }) }
    }
    function useStore() {
      var pair = React.useState(getState())
      var setSnap = pair[1]
      React.useEffect(function () { return subscribe(function () { setSnap(getState()) }) }, [])
      return store
    }

    function apply(ctx) {
      // 样式：插入 <style> 标签，卸载时删除
      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-template'
        tag.dataset.pluginCss = 'dsh-plugin-template/styles'
        tag.textContent =
          '.tpl-hbtn{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex}' +
          '.tpl-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}'
        document.head.appendChild(tag)
        return function () { tag.remove() }
      })

      // 槽位注册示例：会话头部加一个按钮，点击调用宿主路由
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'template-button', order: 30, label: '模板按钮' },
          function () {
            var state = useStore()
            return React.createElement('button', {
              type: 'button',
              className: 'tpl-hbtn',
              title: '模板按钮：点击调用宿主路由 /dsh-plugin-template/echo',
              onClick: function () {
                fetch('/dsh-plugin-template/echo?text=' + encodeURIComponent('你好，DSH'))
                  .then(function (res) { return res.json() })
                  .then(function (data) { setState({ count: state.count + 1, last: data.text }) })
                  .catch(function (err) { console.error('[dsh-plugin-template]', err) })
              }
            }, String(state.count))
          }
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
