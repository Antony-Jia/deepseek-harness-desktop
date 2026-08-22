window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    // 文件夹和 Terminal 入口现在由 Tauri 外层标题栏统一提供。
    // 颜色主题只切换已经由已安装插件注册到 DSH Web 的 theme 服务项；
    // bridge 不再替缺失插件注册主题。背景只写 document.body 上固定允许的
    // background 属性，不通过 selector 或任意 CSS 触碰产品 DOM。
    exports.inject = ['slots', 'sessions']
    exports.apply = function (ctx) {
      var sessions = ctx.get('sessions') || ctx.sessions
      var styleId = 'dsh-desktop-market-skills-style'
      var style = document.getElementById(styleId)
      if (!style) {
        style = document.createElement('style')
        style.id = styleId
        style.textContent = '.dsh-market-skills-overlay{position:fixed;z-index:1300;inset:0;display:flex;align-items:flex-start;justify-content:center;padding:72px 20px 20px;background:var(--dsw-alias-bg-mask-1);pointer-events:auto}.dsh-market-skills-panel{width:min(520px,calc(100vw - 40px));max-height:calc(100vh - 110px);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 18px 54px rgba(0,0,0,.36);overflow:hidden}.dsh-market-skills-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh-market-skills-heading-copy{display:grid;gap:3px}.dsh-market-skills-heading strong{color:var(--dsw-alias-label-primary);font-size:15px}.dsh-market-skills-heading small{color:var(--dsw-alias-label-tertiary);font-size:11px}.dsh-market-skills-close{width:28px;height:28px;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:18px}.dsh-market-skills-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsh-market-skills-list{padding:10px;overflow:auto}.dsh-market-skill{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;padding:10px 8px;border-radius:10px;cursor:pointer}.dsh-market-skill:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-market-skill input{margin:2px 0 0;accent-color:var(--dsw-alias-button-info-fill)}.dsh-market-skill-copy{display:grid;gap:3px;min-width:0}.dsh-market-skill-copy strong{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;overflow-wrap:anywhere}.dsh-market-skill-copy span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}.dsh-market-skill-plugin{opacity:.8}.dsh-market-skills-state{padding:18px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}.dsh-market-skills-state[data-error]{color:var(--dsw-alias-state-error-primary)}'
        style.textContent += '.dsh-market-skills-list{max-height:none;overflow-y:visible}.dsh-market-skills-list[data-scroll]{max-height:min(720px,calc(100vh - 190px));overflow-y:auto}.dsh-market-skills-group{display:grid;gap:6px}.dsh-market-skills-group+.dsh-market-skills-group{margin-top:12px}.dsh-market-skills-group-title{display:flex;align-items:center;justify-content:space-between;padding:2px 7px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}.dsh-market-skill{box-sizing:border-box;min-height:66px;border:1px solid transparent}.dsh-market-skill[data-group=market]{background:rgba(74,132,255,.10);border-color:rgba(74,132,255,.16)}.dsh-market-skill[data-group=user]{background:rgba(153,105,255,.10);border-color:rgba(153,105,255,.16)}.dsh-market-skill[data-group=workspace]{background:rgba(55,181,125,.10);border-color:rgba(55,181,125,.16)}.dsh-market-skill[data-group=other]{background:rgba(140,148,170,.08);border-color:rgba(140,148,170,.12);cursor:default}.dsh-market-skill-lock{display:flex;align-items:center;justify-content:center;width:18px;height:18px;margin-top:1px;border-radius:5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);font-size:10px}.dsh-market-skills-unmanaged{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}'
        document.head.appendChild(style)
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
        var appearance = preferenceFor(data)
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

      function currentSessionId() {
        try {
          var snapshot = sessions.list.getSnapshot()
          return snapshot && typeof snapshot.current === 'string' ? snapshot.current : ''
        } catch (error) { return '' }
      }

      function requestMarketSkills(method, body, signal, sessionId) {
        var url = '/dsh-desktop-bridge/market-skills'
        if (method === 'GET' && sessionId) url += '?sessionId=' + encodeURIComponent(sessionId)
        return fetch(url, {
          method: method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: signal
        }).then(function (response) {
          return response.text().then(function (text) {
            var value
            try { value = JSON.parse(text) } catch (parseError) {
              var invalid = new Error(response.ok ? '市场 Skills 接口返回了无效 JSON。' : ('HTTP ' + response.status))
              invalid.status = response.status
              throw invalid
            }
            if (!response.ok || value.ok === false) {
              var error = new Error(value.error || ('HTTP ' + response.status))
              error.status = response.status
              throw error
            }
            return value
          })
        })
      }

      function MarketSkillSelector(props) {
        var state = React.useState({ loading: true, skills: [], error: '', unavailable: false })
        var snapshot = state[0]
        var setSnapshot = state[1]
        var pendingState = React.useState('')
        var pending = pendingState[0]
        var setPending = pendingState[1]
        React.useEffect(function () {
          if (!props.open) return
          var abort = new AbortController()
          requestMarketSkills('GET', null, abort.signal, props.sessionId).then(function (value) {
            setSnapshot({ loading: false, skills: Array.isArray(value.skills) ? value.skills : [], error: '', unavailable: false })
          }).catch(function (error) {
            if (!abort.signal.aborted) setSnapshot({ loading: false, skills: [], error: error && error.status === 404 ? '' : String(error && error.message || error), unavailable: !!(error && error.status === 404) })
          })
          return function () { abort.abort() }
        }, [props.open, props.sessionId])
        function toggle(skill, enabled) {
          if (pending) return
          setPending(skill.name)
          requestMarketSkills('POST', { name: skill.name, enabled: enabled, sessionId: props.sessionId }).then(function (value) {
            setSnapshot({ loading: false, skills: Array.isArray(value.skills) ? value.skills : [], error: '', unavailable: false })
          }).catch(function (error) {
            setSnapshot(function (current) { return { loading: false, skills: current.skills, error: String(error && error.message || error), unavailable: false } })
          }).finally(function () { setPending('') })
        }
        if (!props.open || snapshot.unavailable) return null
        var controllable = snapshot.skills.filter(function (skill) { return skill.canDisable })
        var unmanaged = snapshot.skills.filter(function (skill) { return !skill.canDisable })
        var enabled = controllable.filter(function (skill) { return skill.enabled }).length
        function renderSkill(skill) {
          var leading = skill.canDisable
            ? React.createElement('input', {
              type: 'checkbox',
              checked: !!skill.enabled,
              disabled: !!pending,
              onChange: function (event) { toggle(skill, event.target.checked) }
            })
            : React.createElement('span', { className: 'dsh-market-skill-lock', title: '该 Skill 不支持在此处禁用' }, '锁')
          return React.createElement(skill.canDisable ? 'label' : 'div', {
            className: 'dsh-market-skill',
            'data-group': skill.group,
            key: skill.name
          },
            leading,
            React.createElement('span', { className: 'dsh-market-skill-copy' },
              React.createElement('strong', null, skill.name),
              React.createElement('span', null, skill.description || 'Skill'),
              React.createElement('span', { className: 'dsh-market-skill-plugin' }, skill.sourceLabel || skill.plugin)
            )
          )
        }
        function renderGroup(group, title, skills, extraClass) {
          if (!skills.length) return null
          return React.createElement('section', { className: 'dsh-market-skills-group ' + (extraClass || ''), key: group },
            React.createElement('div', { className: 'dsh-market-skills-group-title' },
              React.createElement('span', null, title),
              React.createElement('span', null, String(skills.length))
            ),
            skills.map(renderSkill)
          )
        }
        var content
        if (snapshot.loading) {
          content = React.createElement('div', { className: 'dsh-market-skills-state' }, '正在读取全部 Skills…')
        } else if (!snapshot.skills.length) {
          content = React.createElement('div', { className: 'dsh-market-skills-state', 'data-error': snapshot.error || undefined }, snapshot.error || '当前没有可显示的 Skill。')
        } else {
          content = [
            renderGroup('market', '市场插件 Skills', controllable.filter(function (skill) { return skill.group === 'market' })),
            renderGroup('user', '用户级 Skills', controllable.filter(function (skill) { return skill.group === 'user' })),
            renderGroup('workspace', '当前工作区 Skills', controllable.filter(function (skill) { return skill.group === 'workspace' })),
            renderGroup('other', '不可禁用', unmanaged, 'dsh-market-skills-unmanaged')
          ]
        }
        return React.createElement('div', {
          className: 'dsh-market-skills-overlay',
          role: 'presentation',
          onMouseDown: function (event) { if (event.target === event.currentTarget) props.close() }
        },
          React.createElement('section', { className: 'dsh-market-skills-panel', role: 'dialog', 'aria-modal': true, 'aria-label': 'Skills 管理' },
            React.createElement('div', { className: 'dsh-market-skills-heading' },
              React.createElement('div', { className: 'dsh-market-skills-heading-copy' },
                React.createElement('strong', null, 'Skills 管理'),
                React.createElement('small', null, pending ? '正在应用…' : enabled + '/' + controllable.length + ' 可控项已启用 · 共 ' + snapshot.skills.length + ' 项')
              ),
              React.createElement('button', { className: 'dsh-market-skills-close', type: 'button', onClick: props.close, 'aria-label': '关闭' }, '×')
            ),
            React.createElement('div', { className: 'dsh-market-skills-list', 'data-scroll': snapshot.skills.length > 10 || undefined },
              content,
              snapshot.error && snapshot.skills.length ? React.createElement('div', { className: 'dsh-market-skills-state', 'data-error': true }, snapshot.error) : null
            )
          )
        )
      }

      function MarketSkillOverlay() {
        var openState = React.useState({ open: false, sessionId: '' })
        var overlay = openState[0]
        var setOverlay = openState[1]
        React.useEffect(function () {
          function onOpen(event) {
            if (event.source !== window.parent) return
            var data = event.data
            if (!data || data.source !== 'dsh-desktop' || data.type !== 'dsh-market-skills-open') return
            setOverlay({ open: true, sessionId: currentSessionId() })
          }
          window.addEventListener('message', onOpen)
          return function () { window.removeEventListener('message', onOpen) }
        }, [])
        return React.createElement(MarketSkillSelector, {
          open: overlay.open,
          sessionId: overlay.sessionId,
          close: function () { setOverlay({ open: false, sessionId: overlay.sessionId }) }
        })
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
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-desktop-market-skills', order: 80, label: 'Skills 管理' },
          MarketSkillOverlay
        )
      })
      return function () {
        window.removeEventListener('message', onMessage)
        resetWebBackground()
      }
    }
    return module.exports
  }
})
