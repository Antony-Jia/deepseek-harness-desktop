window.__ModuleLoader__.load({
  id: '@p-dsh-market/example',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.footer.action', function () {
          return ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'p-dsh-market-example', order: 90, label: '市场示例' },
            function () {
              return React.createElement('span', { className: 'p-dsh-market-example' }, '市场示例已加载')
            },
          )
        })
      })
    }
    return module.exports
  },
})
