window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    // 文件夹和 Terminal 入口现在由 Tauri 外层标题栏统一提供。
    // 颜色主题只切换已经由已安装插件注册到 DSH Web 的 theme 服务项；
    // bridge 不再替缺失插件注册主题。背景只写 document.body 上固定允许的
    // background 属性，不通过 selector 或任意 CSS 触碰产品 DOM。
    exports.inject = []
    exports.apply = function (ctx) {
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

      function resetWebBackground() {
        if (typeof document === 'undefined' || !document.body) return
        var style = document.body.style
        style.backgroundImage = ''
        style.backgroundSize = ''
        style.backgroundPosition = ''
        style.backgroundRepeat = ''
        style.backgroundAttachment = ''
        style.backgroundColor = ''
      }

      function applyWebBackground(background, intensity, reduceEffects) {
        resetWebBackground()
        if (typeof document === 'undefined' || !document.body || !background) return
        if (!Array.isArray(background.targets) || background.targets.indexOf('web.shell') < 0) return
        var imageUrl = typeof background.imageUrl === 'string' ? background.imageUrl : ''
        if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(imageUrl)) {
          throw new Error('主题背景必须是宿主校验后的本地 PNG、JPEG 或 WebP 数据')
        }
        var strength = Number.isFinite(Number(intensity)) ? Math.max(0, Math.min(1, Number(intensity))) : Number(background.opacity)
        if (!Number.isFinite(strength)) strength = 0.32
        if (strength <= 0) return
        var overlay = typeof background.overlay === 'string' && background.overlay ? background.overlay : 'rgba(1, 4, 15, 0.62)'
        var dim = Math.max(0, 1 - strength).toFixed(3)
        var style = document.body.style
        style.backgroundColor = '#02040d'
        style.backgroundImage = 'linear-gradient(rgba(1, 4, 15, ' + dim + '), rgba(1, 4, 15, ' + dim + ')), linear-gradient(' + overlay + ', ' + overlay + '), url("' + imageUrl + '")'
        style.backgroundSize = background.fit === 'contain' ? 'contain' : 'cover'
        style.backgroundPosition = typeof background.position === 'string' && background.position ? background.position : 'center'
        style.backgroundRepeat = 'no-repeat'
        style.backgroundAttachment = background.fixed && !reduceEffects ? 'fixed' : 'scroll'
      }

      function applyTheme(service, data) {
        if (!service) throw new Error('DSH Web theme 服务未就绪')

        var skinId = typeof data.skinId === 'string' && data.skinId ? data.skinId : 'builtin.default'
        if (skinId === 'builtin.default') {
          resetWebBackground()
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

        var available = registeredTheme(service, skinId)
        if (!available) throw new Error('主题插件 ' + skinId + ' 尚未在 DSH Web 注册，请确认已安装并重启 DSH')
        if (typeof service.setTheme !== 'function') throw new Error('DSH Web theme 服务不支持切换')
        service.setTheme(skinId)
        applyWebBackground(data.background || null, data.backgroundIntensity, !!data.reduceEffects)
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
        resetWebBackground()
      }
    }
    return module.exports
  }
})
