window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    // 文件夹和 Terminal 入口现在由 Tauri 外层标题栏统一提供。
    // 主题同步只调用 DSH Web 上游的 theme 服务；不通过 selector 触碰
    // DSH Web 页面 DOM。上游的 ThemePresenter 会把 theme 快照投影到
    // --dsw-* 语义变量和 body[data-ds-dark-theme]。
    exports.inject = []
    exports.apply = function (ctx) {
      var unregister = null
      var registeredId = ''
      var registeredKey = ''

      // Theme Pack 协议使用稳定的宿主语义 token 名称，DSH Web 的官方
      // ThemeService 使用 --dsw-* 变量。这个映射固定在宿主 bridge 中，
      // 主题包不能通过消息传入任意 CSS property 或 selector。
      var tokenTargets = {
        'color.background.base': ['--dsw-alias-bg-base'],
        'color.surface.primary': ['--dsw-alias-bg-layer-1'],
        'color.surface.secondary': ['--dsw-alias-bg-layer-2'],
        'color.text.primary': ['--dsw-alias-label-primary'],
        'color.text.secondary': ['--dsw-alias-label-secondary'],
        'color.border.default': ['--dsw-alias-border-l2'],
        'color.accent.primary': [
          '--dsw-alias-brand-primary-new-colorprimary-new-color',
          '--dsw-alias-state-business-primary',
          '--dsw-alias-button-info-fill',
        ],
        'color.accent.secondary': [
          '--dsw-alias-button-info-hover',
          '--dsw-specific-bubble-highlight',
        ],
        'color.success': [
          '--dsw-alias-state-success-primary',
          '--dsw-alias-state-success-secondary',
        ],
        'color.warning': [
          '--dsw-alias-state-warn-primary',
          '--dsw-alias-state-warn-secondary',
        ],
        'color.danger': [
          '--dsw-alias-state-error-primary',
          '--dsw-alias-state-error-secondary',
        ],
        'web.conversation.surface': [
          '--dsw-alias-bg-layer-1',
          '--dsw-specific-bubble',
        ],
        'web.sidebar.surface': ['--dsw-specific-sidebar-fill'],
        'components.button.background': [
          '--dsw-alias-button-primary-fill',
          '--dsw-alias-button-floating-fill',
        ],
        'components.button.hoverBackground': [
          '--dsw-alias-button-primary-hover',
          '--dsw-alias-button-floating-hover',
        ],
        'components.button.activeBackground': [
          '--dsw-alias-interactive-bg-active',
          '--dsw-alias-button-ghost-active-fill',
        ],
        'components.button.text': ['--dsw-alias-label-primary-foreground'],
        'components.button.border': [
          '--dsw-alias-button-ghost-active-border',
        ],
        'components.input.background': [
          '--dsw-specific-input-major',
          '--dsw-specific-login-input',
        ],
        'components.input.border': ['--dsw-specific-selector'],
        'components.input.focusBorder': ['--dsw-alias-border-l4'],
        'components.input.placeholder': ['--dsw-alias-label-caption'],
        'components.input.caret': ['--dsw-alias-button-info-fill'],
      }

      function themeService() {
        var service = null
        try {
          service = ctx.get && ctx.get('theme')
        } catch (error) {}
        if (!service) service = ctx.theme
        if (!service) {
          try {
            service = ctx.get && ctx.get('themes')
          } catch (error) {}
        }
        return service || ctx.themes
      }

      function normalizedTokens(input) {
        var output = {}
        if (!input || typeof input !== 'object') return output
        Object.keys(tokenTargets).forEach(function (source) {
          var value = input[source]
          if (typeof value !== 'string') return
          tokenTargets[source].forEach(function (target) {
            output[target] = value
          })
        })
        return output
      }

      function registeredTheme(service, id) {
        if (!service || !id) return null
        try {
          if (typeof service.getTheme === 'function') {
            var snapshot = service.getTheme()
            if (snapshot && Array.isArray(snapshot.themes)) {
              return snapshot.themes.find(function (item) { return item && item.id === id }) || null
            }
          }
        } catch (error) {}
        if (Array.isArray(service.themes)) {
          return service.themes.find(function (item) { return item && item.id === id }) || null
        }
        return null
      }

      function preferenceFor(data) {
        if (data.appearanceMode === 'system') return 'system'
        return data.appearance === 'light' ? 'light' : 'dark'
      }

      function ownRegistrationKey(id, appearance, tokens) {
        return id + '|' + appearance + '|' + JSON.stringify(tokens)
      }

      function disposeOwnRegistration() {
        if (typeof unregister === 'function') unregister()
        unregister = null
        registeredId = ''
        registeredKey = ''
      }

      function applyTheme(service, data) {
        if (!service) throw new Error('DSH Web theme 服务未就绪')

        var skinId = typeof data.skinId === 'string' && data.skinId ? data.skinId : 'builtin.default'
        var appearance = data.appearance === 'light' ? 'light' : 'dark'
        if (skinId === 'builtin.default') {
          disposeOwnRegistration()
          if (typeof service.setTheme === 'function') {
            service.setTheme(preferenceFor(data))
          } else if (typeof service.set === 'function') {
            service.set({ id: skinId, appearance: appearance, colorScheme: appearance, tokens: {} })
          } else if (typeof service.apply === 'function') {
            service.apply({ id: skinId, appearance: appearance, colorScheme: appearance, tokens: {} })
          } else {
            throw new Error('DSH Web theme 服务不支持切换')
          }
          return
        }

        var tokens = normalizedTokens(data.tokens)
        var definition = {
          id: skinId,
          appearance: appearance,
          colorScheme: appearance,
          tokens: tokens,
          background: data.background || null,
        }
        var key = ownRegistrationKey(skinId, appearance, tokens)
        var available = registeredTheme(service, skinId)
        if (!available && (registeredId !== skinId || registeredKey !== key)) {
          disposeOwnRegistration()
          if (typeof service.register === 'function') {
            var result = service.register(definition)
            if (typeof result === 'function') unregister = result
            registeredId = skinId
            registeredKey = key
          }
        }
        if (typeof service.setTheme === 'function') {
          if (!registeredTheme(service, skinId)) {
            throw new Error('主题 ' + skinId + ' 尚未在 DSH Web 注册')
          }
          service.setTheme(skinId)
        } else if (typeof service.apply === 'function') {
          var applied = service.apply(definition)
          if (typeof applied === 'function') {
            disposeOwnRegistration()
            unregister = applied
          }
        } else if (typeof service.set === 'function') {
          service.set(definition)
        } else {
          throw new Error('DSH Web theme 服务不支持注册')
        }
      }

      function onMessage(event) {
        if (event.source !== window.parent) return
        var data = event.data
        if (!data || data.source !== 'dsh-desktop' || data.type !== 'dsh-theme-apply') return
        try {
          applyTheme(themeService(), data)
          window.parent.postMessage({ source: 'dsh-desktop-theme', type: 'theme-applied', skinId: data.skinId }, '*')
        } catch (error) {
          window.parent.postMessage({ source: 'dsh-desktop-theme', type: 'theme-error', skinId: data.skinId, message: String(error && error.message || error) }, '*')
        }
      }
      window.addEventListener('message', onMessage)
      return function () {
        window.removeEventListener('message', onMessage)
        disposeOwnRegistration()
      }
    }
    return module.exports
  }
})
