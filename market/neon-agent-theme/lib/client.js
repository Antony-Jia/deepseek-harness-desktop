window.__ModuleLoader__.load({
  id: '@p-dsh-market/neon-agent-theme',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // The package registers the declarative theme with DSH Web's official
    // ThemeService. Desktop still owns the selected skin and tells the bridge
    // when to call setTheme(); this registration makes the package useful in a
    // normal npm-started Harness as well and keeps the theme data out of DOM
    // selectors and arbitrary CSS.
    var tokens = {
      '--dsw-alias-bg-base': 'rgba(2, 4, 13, 0.64)',
      '--dsw-alias-bg-layer-1': 'rgba(7, 14, 38, 0.90)',
      '--dsw-alias-bg-layer-2': 'rgba(12, 23, 58, 0.82)',
      '--dsw-alias-bg-overlay': 'rgba(4, 10, 29, 0.94)',
      '--dsw-alias-label-primary': '#EDF4FF',
      '--dsw-alias-label-secondary': '#879AC8',
      '--dsw-alias-label-primary-foreground': '#FFFFFF',
      '--dsw-alias-brand-primary': '#1976FF',
      '--dsw-alias-interactive-bg-hover': 'rgba(37, 91, 230, 0.24)',
      '--dsw-alias-border-l1': 'rgba(61, 105, 255, 0.22)',
      '--dsw-alias-border-l2': 'rgba(61, 105, 255, 0.35)',
      '--dsw-alias-brand-primary-new-colorprimary-new-color': '#1976FF',
      '--dsw-alias-state-business-primary': '#1976FF',
      '--dsw-alias-button-info-fill': '#1976FF',
      '--dsw-alias-button-info-hover': '#7B4DFF',
      '--dsw-specific-bubble-highlight': '#7B4DFF',
      '--dsw-alias-state-success-primary': '#3BD6AF',
      '--dsw-alias-state-success-secondary': '#3BD6AF',
      '--dsw-alias-state-warn-primary': '#F4C563',
      '--dsw-alias-state-warn-secondary': '#F4C563',
      '--dsw-alias-state-error-primary': '#FF708C',
      '--dsw-alias-state-error-secondary': '#FF708C',
      '--dsw-specific-bubble': 'rgba(4, 10, 29, 0.76)',
      '--dsw-specific-sidebar-fill': 'rgba(3, 8, 24, 0.88)',
      '--dsw-alias-button-elevated-fill': 'rgba(22, 61, 155, 0.32)',
      '--dsw-alias-button-primary-fill': 'rgba(22, 61, 155, 0.32)',
      '--dsw-alias-button-floating-fill': 'rgba(22, 61, 155, 0.32)',
      '--dsw-alias-button-primary-hover': 'rgba(37, 91, 230, 0.50)',
      '--dsw-alias-button-floating-hover': 'rgba(37, 91, 230, 0.50)',
      '--dsw-alias-interactive-bg-active': 'rgba(55, 105, 255, 0.62)',
      '--dsw-alias-button-ghost-active-fill': 'rgba(55, 105, 255, 0.62)',
      '--dsw-alias-label-primary-foreground': '#FFFFFF',
      '--dsw-alias-button-ghost-active-border': 'rgba(53, 112, 255, 0.55)',
      '--dsw-specific-input-major': 'rgba(3, 10, 30, 0.78)',
      '--dsw-specific-login-input': 'rgba(3, 10, 30, 0.78)',
      '--dsw-specific-selector': 'rgba(74, 116, 255, 0.38)',
      '--dsw-alias-border-l4': '#397CFF',
      '--dsw-alias-label-caption': '#6576A5',
    }

    function getThemeService(ctx) {
      if (ctx.theme) return ctx.theme
      try {
        return ctx.get && ctx.get('theme')
      } catch (error) {
        return null
      }
    }

    function alreadyRegistered(service) {
      if (!service || typeof service.getTheme !== 'function') return false
      try {
        var snapshot = service.getTheme()
        return !!(snapshot && Array.isArray(snapshot.themes) && snapshot.themes.some(function (item) {
          return item && item.id === 'neon-agent'
        }))
      } catch (error) {
        return false
      }
    }

    exports.inject = ['theme']
    exports.apply = function (ctx) {
      var service = getThemeService(ctx)
      if (!service || typeof service.register !== 'function' || alreadyRegistered(service)) return function () {}
      var dispose = service.register({
        id: 'neon-agent',
        colorScheme: 'dark',
        tokens: tokens,
      })
      return typeof dispose === 'function' ? dispose : function () {}
    }
    return module.exports
  },
})
