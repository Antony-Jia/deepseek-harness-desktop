window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var inject = ['slots', 'workspaces']

    function apply(ctx) {
      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-desktop-bridge'
        tag.textContent =
          '.dsh-desktop-folder{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid var(--dsw-alias-line-light);border-radius:9px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:12px}' +
          '.dsh-desktop-folder:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
          '.dsh-desktop-folder-path{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        document.head.appendChild(tag)
        return function () { tag.remove() }
      })

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-desktop-folder', order: 20, label: '系统文件夹' },
          function () {
            var pair = React.useState('')
            var path = pair[0]
            var setPath = pair[1]
            var busyPair = React.useState(false)
            var busy = busyPair[0]
            var setBusy = busyPair[1]
            function choose() {
              setBusy(true)
              fetch('/dsh-desktop-bridge/pick-folder', { method: 'POST' })
                .then(function (response) { return response.json() })
                .then(function (data) {
                  if (!data.path) return
                  setPath(data.path)
                  addWorkspace(ctx.workspaces, data.path)
                })
                .catch(function (error) { console.error('[dsh-desktop-bridge]', error) })
                .finally(function () { setBusy(false) })
            }
            return React.createElement('button', {
              type: 'button',
              className: 'dsh-desktop-folder',
              disabled: busy,
              title: path || '使用 Windows 原生文件夹选择器',
              onClick: choose,
            }, busy ? '选择中…' : React.createElement(React.Fragment, null,
              React.createElement('span', null, '▣'),
              React.createElement('span', { className: 'dsh-desktop-folder-path' }, path || '系统选择器')
            ))
          }
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})

function addWorkspace(workspaces, path) {
  if (!workspaces) return
  try {
    if (typeof workspaces.add === 'function') return void workspaces.add(path)
    if (typeof workspaces.register === 'function') return void workspaces.register(path)
    if (typeof workspaces.create === 'function') return void workspaces.create({ path: path })
  } catch (error) {
    console.warn('[dsh-desktop-bridge] workspace integration', error)
  }
  window.dispatchEvent(new CustomEvent('dsh-desktop-workspace-selected', { detail: path }))
}
