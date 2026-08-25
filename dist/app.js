(function () {
  'use strict'

  var api = window.__TAURI__ && window.__TAURI__.core
  var invoke = api && api.invoke
  var state = null
  var poller = null
  var versionHint = ''
  var viewMode = 'home'
  var autoOpenedUrl = ''
  var loadedFrameUrl = ''
  var workspacePanelOpen = false
  var terminalPanelOpen = false
  var marketPanelOpen = false
  var roundtablePanelOpen = false
  var desktopContributions = []
  var desktopContributionsKey = ''
  var desktopContributionRequest = null
  var desktopActionsBusy = false
  var marketResult = null
  var marketQuery = ''
  var marketBusy = false
  var marketConfirming = false
  var marketConfirmResolver = null
  var runtimeConfirming = false
  var runtimeConfirmResolver = null
  var marketError = ''
  var marketOperation = null
  var marketCategory = 'all'
  var marketSelectedPlugin = null
  var marketCacheSeenAt = 0
  var mcpResult = null
  var mcpBusy = false
  var mcpError = ''
  var mcpDraftEnabled = {}
  var mcpDraftAutoConnect = {}
  var mcpRuntimeResult = null
  var mcpRuntimeRequest = null
  var mcpRuntimeCheckedAt = 0
  var mcpReadinessResult = null
  var mcpReadinessRequest = null
  var mcpReadinessCheckedAt = 0
  var mcpDeleteId = ''
  var appLoadingMessage = ''
  var appLoadingDetail = ''
  var pendingRestartNames = []
  var localDetecting = false
  var themePacks = []
  var themePacksLoaded = false
  var themePacksRequest = null
  var themePreviewId = ''
  var themePreviewUntil = 0
  var themePreferencesTimer = null
  var themeWebStatus = 'idle'
  var themeWebStatusTimer = null
  var themePostedSkin = ''
  var themeActionError = ''
  var systemThemeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false }

  function el(id) { return document.getElementById(id) }
  function setText(id, value) { if (el(id)) el(id).textContent = value == null ? '' : String(value) }
  function setHidden(id, hidden) { if (el(id)) el(id).hidden = hidden }
  function renderMarketUpdateBadge(snapshot) {
    var button = el('titlebar-market')
    var badge = el('market-update-badge')
    if (!button || !badge) return
    var count = Math.max(0, Number(snapshot && snapshot.marketUpdateCount || 0))
    badge.hidden = count < 1
    badge.textContent = count > 99 ? '99+' : String(count)
    var label = count > 0 ? '打开插件市场（' + count + ' 个插件有新版本）' : '打开插件市场'
    button.title = label
    button.setAttribute('aria-label', label)
  }
  function setAppLoading(message, detail) {
    appLoadingMessage = message ? String(message) : ''
    appLoadingDetail = detail ? String(detail) : ''
    setText('app-loading-title', appLoadingMessage)
    setText('app-loading-detail', appLoadingDetail)
    setHidden('app-loading-overlay', !appLoadingMessage)
    var overlay = el('app-loading-overlay')
    if (overlay) overlay.setAttribute('aria-busy', appLoadingMessage ? 'true' : 'false')
  }
  function clearAppLoading() { setAppLoading('', '') }
  function effectiveTheme(theme) {
    return theme === 'light' || theme === 'dark' ? theme : (systemThemeMedia.matches ? 'dark' : 'light')
  }
  function fallbackThemePacks() {
    return [
      { packageName: 'builtin.default', id: 'builtin.default', displayName: '默认主题', version: 'builtin', source: 'builtin', installed: true, enabled: true, protocolCompatible: true, appearance: 'light', supportedAppearances: ['light', 'dark'], tokens: {}, background: null, previewUrl: null }
    ]
  }
  function availableThemePacks() {
    var packs = themePacks.length ? themePacks : fallbackThemePacks()
    var byId = {}
    packs.forEach(function (pack) {
      if (!pack || !pack.id) return
      var current = byId[pack.id]
      if (!current || (pack.source === 'profile' && current.source !== 'profile')) byId[pack.id] = pack
    })
    return Object.keys(byId).map(function (id) { return byId[id] })
  }
  function selectableThemePacks() {
    return availableThemePacks().filter(function (pack) {
      if (pack.id === 'builtin.default') return true
      return pack.source === 'profile' && pack.installed === true && pack.enabled === true && pack.protocolCompatible === true && pendingRestartNames.indexOf(pack.packageName) < 0
    })
  }
  function themePackById(id) {
    var packs = availableThemePacks()
    return packs.find(function (pack) { return pack.id === id }) || packs[0]
  }
  function packSupportsAppearance(pack, appearance) {
    return !!(pack && Array.isArray(pack.supportedAppearances) && pack.supportedAppearances.indexOf(appearance) >= 0)
  }
  function activeSkinFor(snapshot) {
    var id = snapshot && snapshot.skinId ? String(snapshot.skinId) : 'builtin.default'
    if (themePreviewId) id = themePreviewId
    var pack = themePackById(id)
    var active = effectiveTheme(snapshot && snapshot.appearanceMode ? snapshot.appearanceMode : 'system')
    return pack && pack.id !== 'builtin.default' && pack.source === 'profile' && pack.installed === true && packSupportsAppearance(pack, active) && pack.protocolCompatible === true && pack.enabled === true
      ? pack
      : themePackById('builtin.default')
  }
  function setTokenVariables(pack) {
    var root = document.documentElement
    var tokens = pack && pack.tokens ? pack.tokens : {}
    var values = {
      '--accent': tokens['color.accent.primary'],
      '--accent-strong': tokens['color.accent.secondary'],
      '--muted': tokens['color.text.secondary'],
      '--success': tokens['color.success'],
      '--danger': tokens['color.danger'],
      '--skin-background-base': tokens['color.background.base'],
      '--skin-surface-primary': tokens['color.surface.primary'],
      '--skin-surface-secondary': tokens['color.surface.secondary'],
      '--skin-text-primary': tokens['color.text.primary'],
      '--skin-border': tokens['color.border.default'],
      '--skin-focus-ring': tokens['focus.ring'],
      '--skin-button-background': tokens['components.button.background'],
      '--skin-button-hover-background': tokens['components.button.hoverBackground'],
      '--skin-button-active-background': tokens['components.button.activeBackground'],
      '--skin-button-disabled-background': tokens['components.button.disabledBackground'],
      '--skin-button-text': tokens['components.button.text'],
      '--skin-button-hover-text': tokens['components.button.hoverText'],
      '--skin-button-border': tokens['components.button.border'],
      '--skin-button-radius': tokens['components.button.radius'],
      '--skin-button-shadow': tokens['components.button.shadow'],
      '--skin-input-background': tokens['components.input.background'],
      '--skin-input-border': tokens['components.input.border'],
      '--skin-input-focus-border': tokens['components.input.focusBorder'],
      '--skin-input-placeholder': tokens['components.input.placeholder'],
      '--skin-input-caret': tokens['components.input.caret'],
      '--skin-panel-radius': tokens['components.panel.radius'],
      '--skin-panel-shadow': tokens['components.panel.shadow'],
      '--skin-titlebar-background': tokens['desktop.titlebar.background'],
      '--skin-panel-blur': tokens['desktop.panel.backdropBlur']
    }
    Object.keys(values).forEach(function (name) {
      if (values[name]) root.style.setProperty(name, values[name])
      else root.style.removeProperty(name)
    })
  }
  function applyTheme(input) {
    var snapshot = typeof input === 'string' ? Object.assign({}, state || {}, { appearanceMode: input }) : (input || state || {})
    if (!snapshot.appearanceMode && snapshot.theme) snapshot = Object.assign({}, snapshot, { appearanceMode: snapshot.theme })
    var preference = snapshot.appearanceMode === 'light' || snapshot.appearanceMode === 'dark' || snapshot.appearanceMode === 'system' ? snapshot.appearanceMode : 'system'
    var active = effectiveTheme(preference)
    var pack = activeSkinFor(snapshot)
    document.documentElement.dataset.theme = active
    document.documentElement.dataset.appearance = active
    document.documentElement.dataset.themePreference = preference
    document.documentElement.dataset.skin = pack.id
    document.documentElement.dataset.skinSource = pack.source || 'builtin'
    setTokenVariables(pack)
    applyThemeBackground(pack, snapshot)
    document.querySelectorAll('[data-theme-choice]').forEach(function (button) {
      var selected = button.getAttribute('data-theme-choice') === preference
      button.classList.toggle('active', selected)
      button.setAttribute('aria-pressed', selected ? 'true' : 'false')
    })
    var labels = { light: '亮色', dark: '暗色', system: '跟随系统' }
    var message = preference === 'system'
      ? '跟随系统：当前使用' + (active === 'dark' ? '暗色。' : '亮色。')
      : '当前使用' + labels[preference] + '。'
    setText('theme-message', message)
    renderSkinOptions(snapshot, pack)
    renderThemePreview(snapshot, pack)
    postActiveTheme(pack, snapshot, active)
  }
  function applyThemeBackground(pack, snapshot) {
    var layer = el('theme-background')
    if (!layer) return
    var background = pack && pack.background
    var intensity = snapshot && Number.isFinite(Number(snapshot.backgroundIntensity)) ? Math.max(0, Math.min(1, Number(snapshot.backgroundIntensity))) : 0
    var enabled = !!(background && background.imageUrl && pack.id !== 'builtin.default' && intensity > 0)
    layer.hidden = !enabled
    if (!enabled) {
      layer.style.backgroundImage = ''
      layer.style.opacity = '0'
      return
    }
    layer.style.backgroundImage = 'url("' + String(background.imageUrl).replace(/"/g, '%22') + '")'
    layer.style.backgroundSize = background.fit || 'cover'
    layer.style.backgroundPosition = background.position || 'center'
    layer.style.setProperty('--theme-overlay', background.overlay || 'rgba(1, 4, 15, .66)')
    layer.style.opacity = String(intensity)
    layer.style.filter = snapshot.reduceEffects ? 'none' : ('blur(' + (background.blur || '0px') + ')')
  }
  function postActiveTheme(pack, snapshot, appearance) {
    if (!pack) return
    var sent = postDshMessage('dsh-theme-apply', {
      skinId: pack.id,
      appearanceMode: snapshot.appearanceMode || 'system',
      appearance: appearance,
      tokens: pack.tokens || {},
      background: pack.background || null,
      backgroundIntensity: snapshot.backgroundIntensity,
      reduceEffects: !!snapshot.reduceEffects
    })
    if (sent && pack.id !== 'builtin.default' && themePostedSkin !== pack.id) {
      themePostedSkin = pack.id
      themeWebStatus = 'pending'
      if (themeWebStatusTimer) window.clearTimeout(themeWebStatusTimer)
      themeWebStatusTimer = window.setTimeout(function () {
        if (themeWebStatus === 'pending') {
          themeWebStatus = 'unavailable'
          renderSkinOptions(state || snapshot, activeSkinFor(state || snapshot))
        }
      }, 2500)
    } else if (pack.id === 'builtin.default') {
      themeWebStatus = 'idle'
      themePostedSkin = pack.id
    }
  }
  function renderSkinOptions(snapshot, activePack) {
    var container = el('skin-options')
    if (!container) return
    container.replaceChildren()
    selectableThemePacks().forEach(function (pack) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'skin-option' + (activePack && activePack.id === pack.id ? ' active' : '')
      button.setAttribute('role', 'listitem')
      button.setAttribute('aria-pressed', activePack && activePack.id === pack.id ? 'true' : 'false')
      button.disabled = desktopActionsBusy
      var preview = document.createElement('span')
      preview.className = 'skin-preview'
      if (pack.previewUrl) preview.style.backgroundImage = 'url("' + String(pack.previewUrl).replace(/"/g, '%22') + '")'
      button.appendChild(preview)
      var text = document.createElement('span')
      text.className = 'skin-option-copy'
      text.appendChild(makeNode('strong', null, pack.displayName || pack.id))
      text.appendChild(makeNode('small', null, pack.id === 'builtin.default' ? '宿主内建' : '插件已启用 · ' + pack.version))
      button.appendChild(text)
      if (pack.error) button.title = pack.error
      button.addEventListener('click', function () { previewThemePack(pack) })
      container.appendChild(button)
    })
    var selected = activePack && activePack.id !== 'builtin.default' ? activePack.displayName : '默认主题'
    setText('skin-status-pill', selected)
    var skinMessage = themeActionError || (activePack && activePack.id !== 'builtin.default' ? activePack.description : '默认主题不读取外部资源。')
    if (!themeActionError && activePack && activePack.id !== 'builtin.default' && viewMode === 'dsh') {
      skinMessage += themeWebStatus === 'applied'
        ? ' Web 主题服务已回执。'
        : themeWebStatus === 'error'
          ? ' Web 主题服务报告应用失败，Desktop 外框仍已保留。'
          : themeWebStatus === 'unavailable'
            ? ' Web 主题服务未回执，当前仅 Desktop 外框生效。'
            : ' Web 主题服务等待回执，Desktop 外框已先应用。'
    }
    setText('skin-message', skinMessage)
    var intensity = snapshot && snapshot.backgroundIntensity != null ? Number(snapshot.backgroundIntensity) : 0.32
    var range = el('background-intensity')
    if (range && document.activeElement !== range) range.value = String(Math.max(0, Math.min(1, intensity)))
    setText('background-intensity-value', Math.round(Math.max(0, Math.min(1, intensity)) * 100) + '%')
    var reduce = el('reduce-effects')
    if (reduce && document.activeElement !== reduce) reduce.checked = !!(snapshot && snapshot.reduceEffects)
  }
  function renderThemePreview(snapshot, activePack) {
    var until = themePreviewUntil || (snapshot && snapshot.themePreviewUntil) || 0
    var id = themePreviewId || (snapshot && snapshot.themePreviewUntil ? snapshot.skinId : '')
    if (until && until <= Date.now()) {
      themePreviewUntil = 0
      themePreviewId = ''
      until = 0
      id = ''
    }
    var banner = el('theme-preview-banner')
    if (!banner) return
    banner.hidden = !until
    if (until) {
      var seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setText('theme-preview-title', '正在预览 ' + ((themePackById(id) || activePack || {}).displayName || '主题'))
      setText('theme-preview-countdown', seconds + ' 秒后自动恢复')
    }
  }
  function setBusy(busy) {
    desktopActionsBusy = !!busy
    ;['primary-action', 'toggle-dsh', 'restart-dsh', 'enter-dsh', 'market-restart-dsh', 'mcp-restart-dsh', 'check-updates', 'install-version', 'delete-version', 'version-select', 'detect-local', 'use-local', 'use-managed', 'titlebar-home', 'titlebar-market', 'titlebar-mcp', 'titlebar-skills', 'app-home', 'app-restart', 'background-intensity', 'reduce-effects', 'reset-theme', 'confirm-theme-preview', 'cancel-theme-preview'].forEach(function (id) {
      var node = el(id)
      if (node) node.disabled = !!busy
    })
    document.querySelectorAll('[data-theme-choice]').forEach(function (button) { button.disabled = !!busy })
    renderSkinOptions(state || {}, activeSkinFor(state || {}))
    renderDesktopActions()
    renderMarket()
    renderMcp()
  }
  function updateView() {
    var url = state && state.webUrl ? String(state.webUrl) : ''
    if (url) {
      if (!autoOpenedUrl && viewMode !== 'market' && viewMode !== 'mcp') viewMode = 'dsh'
      autoOpenedUrl = url
    } else if (viewMode === 'dsh') {
      viewMode = 'home'
      autoOpenedUrl = ''
    } else {
      autoOpenedUrl = ''
    }
    var showingDsh = !!url && viewMode === 'dsh'
    var showingMarket = viewMode === 'market'
    var showingMcp = viewMode === 'mcp'
    setHidden('setup-view', showingDsh || showingMarket || showingMcp)
    setHidden('dsh-view', !showingDsh)
    setHidden('market-view', !showingMarket)
    setHidden('mcp-view', !showingMcp)
    var titlebarHome = el('titlebar-home')
    if (titlebarHome) {
      titlebarHome.disabled = !url && !showingMarket && !showingMcp
      titlebarHome.title = showingMarket || showingMcp
        ? (url ? '进入 DSH 页面' : '返回配置首页')
        : (!url ? 'DSH 未启动，无法切换页面' : (showingDsh ? '返回配置首页' : '进入 DSH 页面'))
      titlebarHome.setAttribute('aria-label', titlebarHome.title)
    }
    var marketButton = el('titlebar-market')
    if (marketButton) {
      marketButton.classList.toggle('active', showingMarket)
      marketButton.setAttribute('aria-pressed', showingMarket ? 'true' : 'false')
    }
    renderMarketUpdateBadge(state)
    var mcpButton = el('titlebar-mcp')
    if (mcpButton) {
      mcpButton.classList.toggle('active', showingMcp)
      mcpButton.setAttribute('aria-pressed', showingMcp ? 'true' : 'false')
    }
    var skillsButton = el('titlebar-skills')
    if (skillsButton) {
      skillsButton.disabled = !showingDsh || desktopActionsBusy
      skillsButton.title = showingDsh ? '管理当前会话可用的 Skills' : '进入 DSH 页面后管理 Skills'
    }
    if (!showingMarket) closeMarketDetail()
    renderDesktopActions()
    var frame = el('dsh-frame')
    if (frame && url && loadedFrameUrl !== url) {
      workspacePanelOpen = false
      terminalPanelOpen = false
      roundtablePanelOpen = false
      loadedFrameUrl = url
      frame.src = url
    }
  }
  function focusHomeElement(id) {
    var node = el(id)
    if (node) window.setTimeout(function () { node.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 0)
  }
  function showHome(focusId) {
    viewMode = 'home'
    updateView()
    if (focusId) focusHomeElement(focusId)
  }
  function openMarket() {
    viewMode = 'market'
    updateView()
    invokeOrThrow('acknowledge_market_updates').catch(function (error) {
      if (window.console && console.warn) console.warn('[dsh-desktop] market update acknowledgement failed:', messageOf(error))
    })
    if (!marketBusy && !marketResult) {
      marketSearch(marketQuery, false).then(function (result) {
        if (result && result.cached) requestMarketBackgroundScan()
      })
    } else if (!marketBusy) {
      requestMarketBackgroundScan()
    }
  }

  function requestMarketBackgroundScan() {
    return invokeOrThrow('start_market_background_scan').catch(function (error) {
      if (window.console && console.warn) console.warn('[dsh-desktop] market background scan unavailable:', messageOf(error))
      return false
    })
  }
  function openMcp() {
    viewMode = 'mcp'
    updateView()
    if (!mcpBusy) loadMcpServers()
  }
  function enterDsh() {
    if (state && state.webUrl) {
      viewMode = 'dsh'
      updateView()
      return
    }
    action(function () { return state && state.status === 'needs_workspace' ? invokeOrThrow('choose_workspace') : invokeOrThrow('start_dsh') })
  }
  function toggleDsh() {
    if (state && state.webUrl) {
      action(function () { return invokeOrThrow('stop_dsh') })
      return
    }
    action(function () { return state && state.status === 'needs_workspace' ? invokeOrThrow('choose_workspace') : invokeOrThrow('start_dsh') })
  }
  function restartDsh() {
    if (!state || !state.webUrl) return
    action(function () {
      return invokeOrThrow('restart_dsh').then(function (result) {
        setAppLoading('DSH 已重启，正在加载插件状态…', '正在重新读取 web profile 和桌面插件入口，请稍候。')
        // restart_dsh stops and starts inside one command, so polling never
        // observes the intermediate stopped state. Clear the install guard on
        // successful restart so newly active titlebar contributions can load.
        pendingRestartNames = []
        desktopContributionsKey = ''
        themePacksLoaded = false
        return result
      })
    }, '正在重启 DSH…', '正在停止并重新启动运行时，请稍候。')
  }
  function postDshMessage(type, payload) {
    var frame = el('dsh-frame')
    if (!frame || !frame.contentWindow) return false
    frame.contentWindow.postMessage(Object.assign({ source: 'dsh-desktop', type: type }, payload || {}), '*')
    return true
  }
  function desktopActionMethod(action) {
    var descriptor = action && action.action ? action.action : {}
    if (descriptor.type === 'native') return descriptor.command || ''
    if (descriptor.type === 'pluginRpc') return descriptor.method || ''
    return ''
  }
  function desktopActionSupported(action) {
    var descriptor = action && action.action ? action.action : {}
    if (descriptor.type === 'native') return descriptor.command === 'workspace.openFolder' || descriptor.command === 'workspace.openTerminal'
    if (descriptor.type === 'pluginRpc') return descriptor.method === 'workspace.togglePanel' || descriptor.method === 'workspace.toggleTerminal' || descriptor.method === 'akshare.toggleAnalysisPanel' || descriptor.method === 'multiAgentRoundtable.open'
    return false
  }
  function desktopActionPressed(action) {
    var method = desktopActionMethod(action)
    return method === 'workspace.openFolder' || method === 'workspace.togglePanel' ? workspacePanelOpen
      : method === 'workspace.openTerminal' || method === 'workspace.toggleTerminal' ? terminalPanelOpen
        : method === 'akshare.toggleAnalysisPanel' ? marketPanelOpen
          : method === 'multiAgentRoundtable.open' ? roundtablePanelOpen
        : false
  }
  function desktopActionRequiresWorkspace(action) {
    var method = desktopActionMethod(action)
    return method === 'workspace.openFolder' || method === 'workspace.openTerminal' || method === 'workspace.togglePanel' || method === 'workspace.toggleTerminal'
  }
  function desktopActionVisible(contribution, action, showingDsh) {
    var conditions = Array.isArray(action.when) ? action.when : (action.when ? [action.when] : [])
    var packageName = contribution && (contribution.packageName || contribution.name)
    return desktopActionSupported(action) && conditions.every(function (condition) {
      if (condition === 'workspaceSelected') return !!(state && state.workspace)
      if (condition === 'dshRunning') return showingDsh
      if (condition === 'pluginActive') return true
      if (condition === 'restartNotRequired') return !packageName || pendingRestartNames.indexOf(packageName) < 0
      return false
    })
  }
  function runDesktopAction(action, contribution) {
    var method = desktopActionMethod(action)
    if (method === 'workspace.openFolder' || method === 'workspace.togglePanel') {
      openWorkspacePanel()
      return
    }
    if (method === 'workspace.openTerminal' || method === 'workspace.toggleTerminal') {
      openTerminalPanel()
      return
    }
    if (method === 'akshare.toggleAnalysisPanel') {
      postDshMessage('plugin-rpc', {
        pluginId: contribution && (contribution.packageName || contribution.name),
        method: method
      })
      return
    }
    if (method === 'multiAgentRoundtable.open') {
      postDshMessage('plugin-rpc', {
        pluginId: contribution && (contribution.packageName || contribution.name),
        method: method,
        open: !roundtablePanelOpen
      })
      return
    }
    // pluginRpc 只接受当前外框已经登记的有限方法，不能把任意 Tauri invoke 暴露给插件。
    return
  }
  function layoutDesktopActions() {
    var container = el('titlebar-plugin-actions')
    var list = el('titlebar-plugin-actions-list')
    var overflow = el('titlebar-plugin-overflow')
    var menu = el('titlebar-plugin-overflow-menu')
    if (!container || !list || !overflow || !menu) return
    Array.from(menu.children).forEach(function (button) { list.appendChild(button) })
    overflow.hidden = true
    overflow.open = false
    var drag = el('titlebar-drag')
    var maxWidth = Math.max(0, Math.floor(((drag && drag.clientWidth) || window.innerWidth) / 2))
    container.style.maxWidth = maxWidth + 'px'
    var availableWidth = Math.min(maxWidth, container.clientWidth || maxWidth)
    if (!list.children.length || list.scrollWidth <= availableWidth) return
    overflow.hidden = false
    var available = Math.max(0, availableWidth - overflow.offsetWidth - 4)
    while (list.lastElementChild && list.scrollWidth > available) {
      menu.insertBefore(list.lastElementChild, menu.firstElementChild)
    }
  }
  function renderDesktopActions() {
    var list = el('titlebar-plugin-actions-list')
    var menu = el('titlebar-plugin-overflow-menu')
    var overflow = el('titlebar-plugin-overflow')
    if (!list || !menu || !overflow) return
    list.replaceChildren()
    menu.replaceChildren()
    overflow.hidden = true
    var showingDsh = !!(state && state.webUrl && viewMode === 'dsh')
    var actions = []
    desktopContributions.forEach(function (contribution) {
      ;(contribution.actions || []).forEach(function (action) {
        if (action.slot !== 'desktop.titlebar.workspaceActions') return
        if (!desktopActionVisible(contribution, action, showingDsh)) return
        actions.push({ contribution: contribution, action: action })
      })
    })
    actions.sort(function (left, right) {
      return Number(left.action.order || 0) - Number(right.action.order || 0)
        || String(left.contribution.packageName || '').localeCompare(String(right.contribution.packageName || ''))
        || String(left.action.id || '').localeCompare(String(right.action.id || ''))
    })
    actions.forEach(function (item) {
      var action = item.action
      var method = desktopActionMethod(action)
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'titlebar-tool'
      button.textContent = action.label || (action.icon === 'terminal' ? 'Terminal' : '文件夹')
      var enabled = showingDsh && (!desktopActionRequiresWorkspace(action) || !!(state && state.workspace)) && !desktopActionsBusy && !marketBusy
      var title = method === 'workspace.openTerminal' || method === 'workspace.toggleTerminal'
        ? (terminalPanelOpen ? '关闭下方 PowerShell 面板' : '打开下方 PowerShell 面板')
        : method === 'akshare.toggleAnalysisPanel'
          ? (marketPanelOpen ? '关闭行情分析面板' : '打开行情分析面板')
          : method === 'multiAgentRoundtable.open'
            ? (roundtablePanelOpen ? '关闭多 Agent 圆桌' : '打开多 Agent 圆桌')
            : (workspacePanelOpen ? '关闭悬浮工作区面板' : '打开悬浮工作区面板')
      button.disabled = !enabled
      button.title = title
      button.setAttribute('aria-label', title)
      button.setAttribute('aria-pressed', desktopActionPressed(action) ? 'true' : 'false')
      button.dataset.plugin = item.contribution.packageName || ''
      button.dataset.contribution = action.id || ''
      button.addEventListener('mousedown', function (event) { event.stopPropagation() })
      button.addEventListener('click', function () {
        overflow.open = false
        runDesktopAction(action, item.contribution)
      })
      list.appendChild(button)
    })
    layoutDesktopActions()
  }
  function openWorkspacePanel() {
    if (!state || !state.workspace || viewMode !== 'dsh') return
    postDshMessage('workspace-panel-toggle', { cwd: String(state.workspace) })
  }
  function openTerminalPanel() {
    if (!state || !state.workspace || viewMode !== 'dsh') return
    postDshMessage('terminal-panel-toggle', { cwd: String(state.workspace) })
  }
  function closeWindow() {
    invokeOrThrow('stop_dsh').then(function () { return refresh() }).then(function () { return invokeOrThrow('hide_window') }).catch(showWindowError)
  }
  function messageOf(error) { return error && error.message ? error.message : String(error) }
  function invokeOrThrow(command, args) {
    if (!invoke) return Promise.reject(new Error('Tauri API 未注入，请使用 tauri dev/build 启动客户端。'))
    return invoke(command, args || {})
  }
  function versionsOf(snapshot) {
    var versions = Array.isArray(snapshot && snapshot.versions) ? snapshot.versions.slice() : []
    if (snapshot && snapshot.pinned && !versions.some(function (item) { return item.version === snapshot.pinned })) {
      versions.push({ version: snapshot.pinned, installed: false, ready: false })
    }
    if (snapshot && snapshot.available && !versions.some(function (item) { return item.version === snapshot.available })) {
      versions.push({ version: snapshot.available, installed: false, ready: false })
    }
    return versions
  }
  function statusMeta(status) {
    var map = {
      checking: ['检查中', 'neutral'], starting: ['启动中', 'neutral'], installing: ['安装中', 'warn'],
      ready: ['运行中', 'good'], needs_install: ['待安装', 'warn'], needs_local: ['待选择本地版本', 'warn'], needs_workspace: ['待选择', 'warn'],
      failed: ['启动失败', 'bad'], stopped: ['已停止', 'neutral'], updating: ['更新中', 'warn']
    }
    return map[status] || ['未连接', 'neutral']
  }
  function setPill(id, text, tone) {
    var node = el(id)
    if (!node) return
    node.textContent = text
    node.className = 'pill ' + tone
  }
  function makeNode(tag, className, value) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (value != null) node.textContent = String(value)
    return node
  }
  function pluginCategory(plugin) {
    return plugin && plugin.theme ? 'theme' : 'plugin'
  }
  function pluginMatchesCategory(plugin, category) {
    if (category === 'all') return true
    if (category === 'installed') return !!plugin.installed
    return pluginCategory(plugin) === category
  }
  function pluginInitials(name) {
    if (!name) return '?'
    var cleaned = String(name).replace(/^@[^/]+\//, '').replace(/[\s\u3000-\u303f\uff00-\uffef]+/g, '-')
    var parts = cleaned.split(/[-_.]/)
    var chars = []
    for (var i = 0; i < parts.length && chars.length < 2; i++) {
      var c = parts[i].charAt(0).toUpperCase()
      if (c && /[a-zA-Z0-9\u4e00-\u9fa5]/.test(c)) chars.push(c)
    }
    return chars.join('') || name.charAt(0).toUpperCase()
  }
  function pluginIconGradient(name, theme) {
    if (theme) return 'linear-gradient(135deg, #f6c8ff, #9d7bff)'
    var seed = 0
    var str = String(name)
    for (var i = 0; i < str.length; i++) seed = ((seed << 5) - seed) + str.charCodeAt(i) | 0
    var gradients = [
      'linear-gradient(135deg, #c8d0ff, #7de2bc)',
      'linear-gradient(135deg, #8b9cf6, #5eead4)',
      'linear-gradient(135deg, #a8d8ff, #6a82fb)',
      'linear-gradient(135deg, #ffd9a8, #ff8c8c)',
      'linear-gradient(135deg, #9df3d7, #5bb8ff)'
    ]
    return gradients[Math.abs(seed) % gradients.length]
  }
  function renderMarket() {
    var source = state && state.runtimeSource === 'local' ? '本地' : '桌面托管'
    var runtimeReady = marketResult ? !!marketResult.runtimeReady : true
    var packageManagerReady = marketResult ? !!marketResult.packageManagerReady : false
    var interactionBusy = marketBusy || marketConfirming || desktopActionsBusy
    setText('market-runtime-title', runtimeReady ? '当前使用' + source + ' DSH' : '插件市场只读')
    setText('market-runtime-message', marketResult && marketResult.message
      ? marketResult.message
      : (runtimeReady ? '市场固定使用 web profile，不会切换 DSH 运行来源。' : '请先返回首页准备 DSH 运行时。'))
    setPill('market-runtime-pill', runtimeReady ? 'DSH 可用' : 'DSH 缺失', runtimeReady ? 'good' : 'warn')
    setPill('market-pnpm-pill', packageManagerReady ? '私有 pnpm 可用' : 'pnpm 未准备', packageManagerReady ? 'good' : 'warn')
    var marketRestartButton = el('market-restart-dsh')
    if (marketRestartButton) {
      var marketCanRestart = !!(state && state.webUrl) && runtimeReady
      marketRestartButton.disabled = !marketCanRestart || interactionBusy || desktopActionsBusy
      marketRestartButton.title = marketCanRestart ? '停止并重新启动当前 DSH 工作区' : 'DSH 当前未运行，无法重启'
      marketRestartButton.setAttribute('aria-label', marketRestartButton.title)
    }
    var query = el('market-query')
    if (query && document.activeElement !== query) query.value = marketQuery
    var canSearch = !marketResult || (runtimeReady && packageManagerReady)
    var searchButton = el('market-search-button')
    if (searchButton) {
      searchButton.disabled = interactionBusy || !canSearch
      searchButton.textContent = marketBusy ? '处理中…' : '搜索'
    }
    var refreshButton = el('market-refresh-button')
    if (refreshButton) {
      refreshButton.disabled = interactionBusy
      refreshButton.textContent = marketBusy ? '刷新中…' : '刷新扫描'
      refreshButton.title = '主动扫描远程市场并更新本地缓存'
    }
    if (query) query.disabled = interactionBusy || !canSearch
    var message = marketError || (marketResult && marketResult.message) || ''
    if (!message && marketResult) message = marketResult.plugins.length + ' 个插件通过协议校验。'
    if (pendingRestartNames.length) {
      message += (message ? ' ' : '') + (state && state.webUrl
        ? '插件变更待重启 DSH 后生效。'
        : '磁盘状态已更新，将在下次启动 DSH 时生效。')
    }
    var messageNode = el('market-message')
    if (messageNode) {
      messageNode.textContent = message
      messageNode.className = 'market-message' + (marketError ? ' bad' : '')
    }
    setHidden('market-readonly-note', !!marketResult && !runtimeReady)
    document.querySelectorAll('[data-category]').forEach(function (tab) {
      var active = tab.getAttribute('data-category') === marketCategory
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
      tab.disabled = !marketResult || marketBusy
    })
    var filtered = (marketResult && marketResult.plugins) ? marketResult.plugins.filter(function (plugin) { return pluginMatchesCategory(plugin, marketCategory) }) : []
    if (marketCategory !== 'all' && !marketError) {
      message = filtered.length + ' 个' + (marketCategory === 'plugin' ? '插件' : marketCategory === 'theme' ? '主题包' : '已安装项目') + '。'
    }
    if (messageNode) messageNode.textContent = message
    var results = el('market-results')
    if (results) {
      results.replaceChildren()
      if (filtered.length) {
        filtered.forEach(function (plugin) { results.appendChild(renderMarketPlugin(plugin, runtimeReady && packageManagerReady && !interactionBusy)) })
      } else if (marketResult && runtimeReady && packageManagerReady && !marketBusy) {
        var empty = makeNode('div', 'market-empty', marketResult.message || '没有符合条件的插件。')
        results.appendChild(empty)
      }
    }
    renderMarketDetail()
    var operationCard = el('market-operation-card')
    if (operationCard) operationCard.hidden = !marketOperation
    if (marketOperation) {
      var operationNoun = marketOperation.theme ? '主题包' : '插件'
      setText('market-operation-title', marketOperation.running ? '正在' + (marketOperation.operation === 'install' ? '安装' : '卸载') + operationNoun : (marketOperation.ok ? operationNoun + '操作完成' : operationNoun + '操作失败'))
      setText('market-operation-message', marketOperation.message || '')
      var details = el('market-operation-details')
      if (details) details.hidden = !marketOperation.log
      setText('market-operation-log', marketOperation.log || '')
    }
  }
  function renderMarketPlugin(plugin, enabled) {
    var card = makeNode('article', 'market-plugin-card' + (enabled ? '' : ' disabled'))
    card.dataset.pluginName = plugin.name
    card.addEventListener('click', function (event) {
      if (!event.target) return
      var target = event.target.nodeType === 3 ? event.target.parentNode : event.target
      if (target && (target.tagName === 'BUTTON' || target.closest && target.closest('button'))) return
      openMarketDetail(plugin)
    })
    var header = makeNode('div', 'market-plugin-header')
    var icon = makeNode('div', plugin.theme ? 'market-plugin-icon theme' : 'market-plugin-icon', pluginInitials(plugin.displayName || plugin.name))
    icon.style.background = pluginIconGradient(plugin.name, !!plugin.theme)
    header.appendChild(icon)
    var heading = makeNode('div', 'market-plugin-heading')
    var title = makeNode('h2', null, plugin.displayName || plugin.name)
    var packageName = makeNode('code', 'market-plugin-name', plugin.name)
    heading.appendChild(title)
    heading.appendChild(packageName)
    header.appendChild(heading)
    card.appendChild(header)
    var description = makeNode('p', 'market-plugin-description', plugin.description || '暂无描述。')
    card.appendChild(description)
    var meta = makeNode('div', 'market-plugin-meta')
    meta.appendChild(makeNode('span', 'market-plugin-version', '最新版本 ' + plugin.version))
    if (plugin.installed) meta.appendChild(makeNode('span', 'pill good', '已安装 · ' + (plugin.installedVersion || '未知版本')))
    if (plugin.theme) {
      meta.appendChild(makeNode('span', 'pill neutral', '主题包'))
      var appearances = Array.isArray(plugin.theme.supportedAppearances) ? plugin.theme.supportedAppearances : []
      if (appearances.length) meta.appendChild(makeNode('span', 'market-plugin-version', '支持 ' + appearances.join(' / ')))
    }
    card.appendChild(meta)
    var capabilities = makeNode('div', 'market-capabilities')
    ;(plugin.capabilities || []).forEach(function (capability) { capabilities.appendChild(makeNode('span', 'market-capability', capability)) })
    card.appendChild(capabilities)
    var footer = makeNode('div', 'market-plugin-footer')
    if (plugin.theme && plugin.installed) {
      var previewButton = makeNode('button', 'button secondary', '预览主题')
      previewButton.type = 'button'
      previewButton.disabled = !enabled || pendingRestartNames.indexOf(plugin.name) >= 0
      previewButton.title = '在 Desktop 设置中预览此主题包'
      previewButton.addEventListener('click', function () { previewMarketTheme(plugin) })
      footer.appendChild(previewButton)
    }
    var actionButton = makeNode('button', 'button ' + (plugin.installed ? 'danger-button' : 'primary'), plugin.installed ? (plugin.theme ? '卸载主题' : '卸载') : (plugin.theme ? '安装主题' : '安装'))
    actionButton.type = 'button'
    actionButton.disabled = !enabled
    actionButton.title = plugin.installed ? (plugin.theme ? '卸载此主题包；当前主题会先回退默认主题' : '从 web profile 卸载此插件') : '安装搜索结果中的确定版本 ' + plugin.version
    actionButton.addEventListener('click', function () { runMarketOperation(plugin, plugin.installed ? 'uninstall' : 'install') })
    footer.appendChild(actionButton)
    card.appendChild(footer)
    return card
  }
  function openMarketDetail(plugin) {
    if (!plugin || marketBusy || marketConfirming) return
    marketSelectedPlugin = plugin
    renderMarketDetail()
    var panel = el('market-detail-panel')
    if (panel) {
      panel.hidden = false
      panel.setAttribute('aria-hidden', 'false')
      panel.classList.add('open')
    }
  }
  function closeMarketDetail() {
    marketSelectedPlugin = null
    var panel = el('market-detail-panel')
    if (panel) {
      panel.classList.remove('open')
      panel.setAttribute('aria-hidden', 'true')
      window.setTimeout(function () { if (!marketSelectedPlugin) panel.hidden = true }, 300)
    }
  }
  function renderMarketDetail() {
    var plugin = marketSelectedPlugin
    if (!plugin) return
    var isTheme = !!plugin.theme
    setText('market-detail-category', isTheme ? '主题包' : '插件')
    setText('market-detail-title', plugin.displayName || plugin.name)
    setText('market-detail-name', plugin.name)
    setText('market-detail-description', plugin.description || '暂无描述。')
    var icon = el('market-detail-icon')
    if (icon) {
      icon.textContent = pluginInitials(plugin.displayName || plugin.name)
      icon.className = isTheme ? 'market-detail-icon theme' : 'market-detail-icon'
      icon.style.background = pluginIconGradient(plugin.name, isTheme)
    }
    var meta = el('market-detail-meta')
    if (meta) {
      meta.replaceChildren()
      meta.appendChild(makeNode('span', 'market-plugin-version', '最新版本 ' + plugin.version))
      if (plugin.installed) meta.appendChild(makeNode('span', 'pill good', '已安装 · ' + (plugin.installedVersion || '未知版本')))
      if (isTheme) {
        meta.appendChild(makeNode('span', 'pill neutral', '主题包'))
        var appearances = Array.isArray(plugin.theme.supportedAppearances) ? plugin.theme.supportedAppearances : []
        if (appearances.length) meta.appendChild(makeNode('span', 'market-plugin-version', '支持 ' + appearances.join(' / ')))
      }
    }
    var caps = el('market-detail-capabilities')
    if (caps) {
      caps.replaceChildren()
      ;(plugin.capabilities || []).forEach(function (capability) { caps.appendChild(makeNode('span', 'market-capability', capability)) })
    }
    var capsSection = el('market-detail-capabilities-section')
    if (capsSection) capsSection.hidden = !(plugin.capabilities && plugin.capabilities.length)
    var runtimeReady = marketResult ? !!marketResult.runtimeReady : true
    var packageManagerReady = marketResult ? !!marketResult.packageManagerReady : false
    var interactionBusy = marketBusy || marketConfirming || desktopActionsBusy
    var enabled = runtimeReady && packageManagerReady && !interactionBusy
    var actions = el('market-detail-actions')
    if (actions) {
      actions.replaceChildren()
      if (isTheme && plugin.installed) {
        var previewButton = makeNode('button', 'button secondary', '预览主题')
        previewButton.type = 'button'
        previewButton.disabled = !enabled || pendingRestartNames.indexOf(plugin.name) >= 0
        previewButton.title = '在 Desktop 设置中预览此主题包'
        previewButton.addEventListener('click', function () { previewMarketTheme(plugin) })
        actions.appendChild(previewButton)
      }
      var actionButton = makeNode('button', 'button ' + (plugin.installed ? 'danger-button' : 'primary'), plugin.installed ? (isTheme ? '卸载主题' : '卸载') : (isTheme ? '安装主题' : '安装'))
      actionButton.type = 'button'
      actionButton.disabled = !enabled
      actionButton.addEventListener('click', function () { runMarketOperation(plugin, plugin.installed ? 'uninstall' : 'install') })
      actions.appendChild(actionButton)
    }
  }
  function previewMarketTheme(plugin) {
    if (!plugin || marketBusy || marketConfirming || desktopActionsBusy) return
    loadThemePacks(true).then(function () {
      var metadata = plugin.theme || {}
      var pack = availableThemePacks().find(function (item) {
        return item.packageName === plugin.name || item.id === metadata.id
      })
      if (!pack) throw new Error('主题包已安装但未通过本地主题校验。')
      showHome('skin-options')
      previewThemePack(pack)
    }).catch(function (error) {
      marketError = messageOf(error)
      renderMarket()
    })
  }
  function confirmMarketOperation(plugin, operation) {
    if (marketConfirming || marketConfirmResolver) return Promise.resolve(false)
    var installing = operation === 'install'
    var noun = plugin.theme ? '主题包' : '插件'
    var displayName = plugin.displayName || plugin.name
    var version = installing ? '@' + plugin.version : ''
    setText('market-confirm-title', installing ? '确认安装' + noun : '确认卸载' + noun)
    setText('market-confirm-message', installing
      ? '确认将 ' + displayName + '（' + plugin.name + version + '）安装到 DSH web profile？'
      : '确认从 DSH web profile 卸载 ' + displayName + '（' + plugin.name + '）？')
    marketConfirming = true
    var modal = el('market-confirm-modal')
    if (modal) {
      modal.hidden = false
      modal.setAttribute('aria-hidden', 'false')
    }
    document.body.classList.add('modal-open')
    renderMarket()
    return new Promise(function (resolve) {
      marketConfirmResolver = resolve
      window.setTimeout(function () {
        var accept = el('market-confirm-accept')
        if (accept) accept.focus()
      }, 0)
    })
  }
  function resolveMarketConfirmation(confirmed) {
    var resolver = marketConfirmResolver
    if (!resolver) return
    marketConfirmResolver = null
    marketConfirming = false
    var modal = el('market-confirm-modal')
    if (modal) {
      modal.hidden = true
      modal.setAttribute('aria-hidden', 'true')
    }
    document.body.classList.remove('modal-open')
    if (confirmed) {
      marketBusy = true
      setAppLoading('正在准备插件操作…', '正在连接 npm 并准备更新 web profile，请稍候。')
    }
    renderMarket()
    resolver(confirmed === true)
  }
  function confirmRuntimeDeletion(version) {
    if (runtimeConfirming || runtimeConfirmResolver) return Promise.resolve(false)
    setText('runtime-confirm-title', '确认删除运行时')
    setText('runtime-confirm-message', '确认删除托管运行时 ' + version + '？')
    setText('runtime-confirm-note', '删除后将释放该版本占用的磁盘空间，且不会影响其他已安装版本。')
    runtimeConfirming = true
    var modal = el('runtime-confirm-modal')
    if (modal) {
      modal.hidden = false
      modal.setAttribute('aria-hidden', 'false')
    }
    document.body.classList.add('modal-open')
    return new Promise(function (resolve) {
      runtimeConfirmResolver = resolve
      window.setTimeout(function () {
        var accept = el('runtime-confirm-accept')
        if (accept) accept.focus()
      }, 0)
    })
  }
  function resolveRuntimeDeletion(confirmed) {
    var resolver = runtimeConfirmResolver
    if (!resolver) return
    runtimeConfirmResolver = null
    runtimeConfirming = false
    var modal = el('runtime-confirm-modal')
    if (modal) {
      modal.hidden = true
      modal.setAttribute('aria-hidden', 'true')
    }
    document.body.classList.remove('modal-open')
    resolver(confirmed === true)
  }
  function marketSearch(queryValue, forceRefresh) {
    if (marketBusy || marketConfirming) return Promise.resolve()
    closeMarketDetail()
    marketQuery = String(queryValue == null ? '' : queryValue).trim()
    marketError = ''
    marketBusy = true
    renderMarket()
    return invokeOrThrow('search_market_plugins', { query: marketQuery, forceRefresh: forceRefresh === true }).then(function (result) {
      marketResult = result || null
      marketQuery = result && result.query != null ? String(result.query) : marketQuery
      if (result && result.scannedAt) marketCacheSeenAt = Number(result.scannedAt)
      marketError = ''
      renderMarket()
      return result
    }).catch(function (error) {
      marketError = messageOf(error)
      renderMarket()
      return null
    }).finally(function () {
      marketBusy = false
      renderMarket()
    })
  }
  function runMarketOperation(plugin, operation) {
    if (marketBusy || marketConfirming || !marketResult || !marketResult.runtimeReady || !marketResult.packageManagerReady) return
    var actionText = operation === 'install' ? '安装' : '卸载'
    return confirmMarketOperation(plugin, operation).then(function (confirmed) {
      if (!confirmed) return null
      marketBusy = true
      marketError = ''
      marketOperation = { running: true, operation: operation, name: plugin.name, theme: !!plugin.theme, message: '正在' + actionText + '，请稍候…', log: '' }
      setAppLoading(
        operation === 'install' ? '正在向 npm 确认插件并安装…' : '正在卸载插件并复核状态…',
        operation === 'install'
          ? '正在校验精确版本、执行 pnpm 安装并复核 web profile。'
          : '正在执行 pnpm 卸载并确认 web profile 已更新。'
      )
      renderMarket()
      var command = operation === 'install' ? 'install_market_plugin' : 'uninstall_market_plugin'
      var args = operation === 'install' ? { name: plugin.name, version: plugin.version } : { name: plugin.name }
      return invokeOrThrow(command, args).then(function (result) {
        marketOperation = Object.assign({}, result || {}, { running: false, operation: operation, name: plugin.name, theme: !!plugin.theme, ok: true })
        if (result && result.restartRequired && pendingRestartNames.indexOf(plugin.name) < 0) pendingRestartNames.push(plugin.name)
        setAppLoading(actionText + '完成，正在刷新市场状态…', '正在重新确认插件清单、主题状态和桌面入口，请稍候。')
        return invokeOrThrow('search_market_plugins', { query: marketQuery }).then(function (next) {
          marketResult = next || marketResult
          marketQuery = next && next.query != null ? String(next.query) : marketQuery
        }).catch(function (error) {
          marketError = '操作已完成，但刷新插件列表失败：' + messageOf(error)
        }).then(function () {
          return loadThemePacks(true).then(function () { return refreshDesktopContributions(true) })
        })
      }).catch(function (error) {
        marketOperation = { running: false, operation: operation, name: plugin.name, theme: !!plugin.theme, ok: false, message: actionText + '失败：' + messageOf(error), log: messageOf(error) }
        marketError = messageOf(error)
      }).finally(function () {
        marketBusy = false
        renderMarket()
        clearAppLoading()
      })
    })
  }
  function mcpServerById(id) {
    var servers = mcpResult && Array.isArray(mcpResult.servers) ? mcpResult.servers : []
    return servers.find(function (server) { return server.id === id }) || null
  }
  function mcpRuntimeServerById(id) {
    var servers = mcpRuntimeResult && Array.isArray(mcpRuntimeResult.servers) ? mcpRuntimeResult.servers : []
    return servers.find(function (server) { return server.id === id }) || null
  }
  function mcpReadinessServerById(id) {
    var servers = mcpReadinessResult && Array.isArray(mcpReadinessResult.servers) ? mcpReadinessResult.servers : []
    return servers.find(function (server) { return server.id === id }) || null
  }
  function syncMcpDrafts(result, force) {
    var servers = result && Array.isArray(result.servers) ? result.servers : []
    servers.forEach(function (server) {
      if (!server || !server.id) return
      if (force || !Object.prototype.hasOwnProperty.call(mcpDraftEnabled, server.id)) {
        mcpDraftEnabled[server.id] = !!server.enabled
      }
      if (server.supportsAutoConnect && (force || !Object.prototype.hasOwnProperty.call(mcpDraftAutoConnect, server.id))) {
        mcpDraftAutoConnect[server.id] = !!server.autoConnect
      }
    })
  }
  function createCustomMcpCard(server) {
    var card = makeNode('article', 'card mcp-server-card')
    card.setAttribute('data-mcp-server', server.id)
    card.setAttribute('data-mcp-custom', 'true')
    var heading = makeNode('div', 'mcp-server-heading')
    heading.appendChild(makeNode('div', 'mcp-server-icon custom', (server.displayName || 'M').slice(0, 1).toUpperCase()))
    var title = makeNode('div')
    title.appendChild(makeNode('p', 'eyebrow', server.transport === 'streamable-http' ? '远程 MCP' : '自定义 MCP'))
    title.appendChild(makeNode('h2', '', server.displayName || server.serverName))
    title.appendChild(makeNode('code', '', 'mcp__' + server.serverName + '__*'))
    heading.appendChild(title)
    var toggle = makeNode('label', 'mcp-switch')
    var checkbox = makeNode('input')
    checkbox.type = 'checkbox'
    checkbox.id = 'mcp-' + server.id + '-enabled'
    checkbox.addEventListener('change', function () {
      mcpDraftEnabled[server.id] = checkbox.checked
      saveMcpServer(server.id)
    })
    toggle.appendChild(checkbox)
    toggle.appendChild(makeNode('span', '', '启用'))
    heading.appendChild(toggle)
    card.appendChild(heading)
    card.appendChild(makeNode('p', 'mcp-server-description', server.description || '用户添加的 MCP 服务。'))
    var meta = makeNode('div', 'mcp-server-meta')
    meta.appendChild(makeNode('span', '', server.transport === 'streamable-http' ? 'Streamable HTTP' : 'stdio'))
    if (server.command) meta.appendChild(makeNode('span', '', server.command))
    if (server.url) meta.appendChild(makeNode('span', '', server.url))
    if (Array.isArray(server.secretNames) && server.secretNames.length) meta.appendChild(makeNode('span', '', '加密配置：' + server.secretNames.join('、')))
    card.appendChild(meta)
    var status = makeNode('p', 'mcp-server-status', '正在读取状态…')
    status.id = 'mcp-' + server.id + '-status'
    card.appendChild(status)
    var pipeline = makeNode('div', 'mcp-server-pipeline')
    pipeline.id = 'mcp-' + server.id + '-pipeline'
    card.appendChild(pipeline)
    var actions = makeNode('div', 'mcp-server-actions')
    var remove = makeNode('button', 'button danger', '删除')
    remove.type = 'button'
    remove.addEventListener('click', function () { openMcpDelete(server.id) })
    actions.appendChild(remove)
    card.appendChild(actions)
    return card
  }
  function syncCustomMcpCards() {
    var list = el('mcp-server-list')
    if (!list) return
    var servers = mcpResult && Array.isArray(mcpResult.servers) ? mcpResult.servers : []
    var customIds = servers.filter(function (server) { return !server.builtIn }).map(function (server) { return server.id })
    list.querySelectorAll('[data-mcp-custom="true"]').forEach(function (card) {
      if (customIds.indexOf(card.getAttribute('data-mcp-server')) < 0) card.remove()
    })
    servers.forEach(function (server) {
      if (!server.builtIn && !list.querySelector('[data-mcp-server="' + server.id + '"]')) list.appendChild(createCustomMcpCard(server))
    })
  }
  function setMcpCheck(id, title, detail, tone) {
    setText(id, title)
    setText(id + '-detail', detail)
    var node = el(id)
    if (node) node.className = tone || ''
  }
  function renderMcpReadiness() {
    var checking = !!mcpReadinessRequest
    var result = mcpReadinessResult
    var enabled = result && Array.isArray(result.servers)
      ? result.servers.filter(function (server) { return server.enabled })
      : []
    var runtimeServers = mcpRuntimeResult && Array.isArray(mcpRuntimeResult.servers) ? mcpRuntimeResult.servers : []
    var disconnected = runtimeServers.filter(function (server) { return server.status === 'not_connected' || server.status === 'unavailable' }).length
    setText('mcp-readiness-title', checking
      ? '正在检查能否下载与启动'
      : result && result.canStart && disconnected
        ? '下载与配置正常，但有 MCP 未连接'
        : result && result.canStart
          ? '启用的 MCP 已具备启动条件'
          : result ? '部分启动条件尚未满足' : '尚未检查启动条件')
    setText('mcp-readiness-message', checking
      ? '正在检查本地环境、npm Registry、缓存和 Profile。'
      : result && result.canStart && disconnected
        ? '问题已经缩小到 MCP 子进程启动或连接阶段；请查看对应卡片和 DSH 日志。'
        : result ? result.message : '点击“重新检查”读取实际状态。')
    var refresh = el('mcp-check-readiness')
    if (refresh) refresh.disabled = checking || mcpBusy
    if (!result) {
      ;['mcp-check-runtime', 'mcp-check-download', 'mcp-check-cache', 'mcp-check-profile'].forEach(function (id) { setMcpCheck(id, checking ? '检查中' : '未检查', '', '') })
      return
    }
    setMcpCheck('mcp-check-runtime', result.runtimeReady ? '可以启动' : '不可启动', result.runtimeMessage, result.runtimeReady ? 'good' : 'bad')
    setMcpCheck('mcp-check-download', result.registryReachable ? '可以下载' : '无法下载', result.registryMessage, result.registryReachable ? 'good' : 'bad')
    var cached = enabled.filter(function (server) { return server.packageCached }).length
    setMcpCheck('mcp-check-cache', cached + '/' + enabled.length + ' 已缓存', enabled.length ? '未缓存的包会在启动时通过 npm 下载。' : '当前没有启用的 MCP。', cached === enabled.length ? 'good' : result.registryReachable ? '' : 'bad')
    var registered = enabled.filter(function (server) { return server.profileRegistered }).length
    setMcpCheck('mcp-check-profile', registered + '/' + enabled.length + ' 已注入', registered === enabled.length ? '当前 web profile 已包含全部启用服务。' : '需要重新保存配置或重启 DSH。', registered === enabled.length ? 'good' : 'bad')
  }
  function renderMcpPipeline(server, runtimeServer) {
    var container = el('mcp-' + server.id + '-pipeline')
    if (!container) return
    container.replaceChildren()
    var readiness = mcpReadinessServerById(server.id)
    function step(label, tone) { container.appendChild(makeNode('span', 'mcp-stage ' + (tone || ''), label)) }
    if (!server.enabled) {
      step('① 服务未启用', '')
      return
    }
    if (!readiness) {
      step('① 正在检查环境', 'warn')
      return
    }
    step('① 运行环境' + (readiness.localDependencyReady ? '可用' : '缺失'), readiness.localDependencyReady ? 'good' : 'bad')
    step('② ' + (readiness.packageCached ? '包已缓存' : mcpReadinessResult.registryReachable ? '启动时下载' : '无法下载'), readiness.packageCached ? 'good' : mcpReadinessResult.registryReachable ? 'warn' : 'bad')
    step('③ Profile ' + (readiness.profileRegistered ? '已注入' : '未注入'), readiness.profileRegistered ? 'good' : 'bad')
    step('④ ' + (runtimeServer && runtimeServer.status === 'connected' ? '工具已注册' : runtimeServer && runtimeServer.status === 'not_connected' ? '启动后未连接' : state && state.webUrl ? '等待连接' : '等待 DSH 启动'), runtimeServer && runtimeServer.status === 'connected' ? 'good' : runtimeServer && runtimeServer.status === 'not_connected' ? 'bad' : 'warn')
  }
  function renderMcp() {
    syncCustomMcpCards()
    renderMcpReadiness()
    var running = !!(state && state.webUrl)
    var runtimeServers = mcpRuntimeResult && Array.isArray(mcpRuntimeResult.servers) ? mcpRuntimeResult.servers : []
    var enabledCount = runtimeServers.filter(function (server) { return server.status !== 'disabled' }).length
    var connectedCount = runtimeServers.filter(function (server) { return server.status === 'connected' }).length
    setText('mcp-runtime-title', !running ? 'DSH 当前未启动' : connectedCount ? 'MCP 工具已注入 Harness' : enabledCount ? 'MCP 尚未连接' : '没有启用的 MCP 服务')
    setText('mcp-runtime-pill', !running ? '已停止' : connectedCount + '/' + enabledCount + ' 已连接')
    if (el('mcp-runtime-pill')) el('mcp-runtime-pill').className = 'pill ' + (connectedCount ? 'good' : enabledCount ? 'warn' : 'neutral')
    setText('mcp-message', mcpError || (mcpRuntimeResult && mcpRuntimeResult.message) || (mcpResult && mcpResult.message) || 'API Key 使用当前 Windows 用户的 DPAPI 加密且不会回显；配置变更将在下次启动或重启 DSH 时生效。')
    var restart = el('mcp-restart-dsh')
    if (restart) restart.disabled = !running || mcpBusy || desktopActionsBusy
    var configuredServers = mcpResult && Array.isArray(mcpResult.servers) ? mcpResult.servers : []
    configuredServers.forEach(function (server) {
      var id = server.id
      var runtimeServer = mcpRuntimeServerById(id)
      var enabled = el('mcp-' + id + '-enabled')
      var key = el('mcp-' + id + '-key')
      var autoConnect = el('mcp-' + id + '-auto-connect')
      var save = document.querySelector('[data-mcp-save="' + id + '"]')
      var secretInputs = document.querySelectorAll('[data-mcp-secret-server="' + id + '"]')
      var secretStates = Array.isArray(server.secretStates) ? server.secretStates : []
      if (enabled && server) {
        enabled.checked = Object.prototype.hasOwnProperty.call(mcpDraftEnabled, id)
          ? !!mcpDraftEnabled[id]
          : !!server.enabled
      }
      if (enabled) enabled.disabled = mcpBusy || desktopActionsBusy
      if (autoConnect && server.supportsAutoConnect) {
        autoConnect.checked = Object.prototype.hasOwnProperty.call(mcpDraftAutoConnect, id)
          ? !!mcpDraftAutoConnect[id]
          : !!server.autoConnect
        autoConnect.disabled = mcpBusy || desktopActionsBusy
        setText('mcp-chrome-mode-meta', autoConnect.checked ? '当前浏览器' : '隔离浏览器')
      }
      if (key) {
        key.disabled = mcpBusy || desktopActionsBusy
        key.placeholder = server && server.apiKeyConfigured ? '已配置；留空会保留当前 Key' : '填写 API Key 后即可启用'
      }
      secretInputs.forEach(function (input) {
        var name = input.getAttribute('data-mcp-secret') || ''
        var secretState = secretStates.find(function (item) { return item.name === name })
        input.disabled = mcpBusy || desktopActionsBusy
        input.placeholder = secretState && secretState.configured
          ? '已配置；留空会保留当前凭据'
          : '填写凭据后保存'
      })
      if (save) save.disabled = mcpBusy || desktopActionsBusy
      document.querySelectorAll('[data-mcp-clear-server="' + id + '"]').forEach(function (button) { button.disabled = mcpBusy || desktopActionsBusy })
      var status = el('mcp-' + id + '-status')
      if (status) {
        var toolSummary = runtimeServer && Array.isArray(runtimeServer.tools)
          ? runtimeServer.tools.slice(0, 4).map(function (name) { return name.replace('mcp__' + server.serverName + '__', '') }).join('、')
          : ''
        var readiness = mcpReadinessServerById(id)
        var statusText = !server
          ? '正在读取配置…'
          : runtimeServer && runtimeServer.status === 'connected'
            ? runtimeServer.message + (toolSummary ? ' ' + toolSummary + (runtimeServer.toolCount > 4 ? ' 等' : '') : '')
          : runtimeServer && runtimeServer.status === 'not_connected' && readiness && readiness.canStart
            ? '下载、缓存和 Profile 均正常，但 DSH 未发现注册工具；MCP 进程可能已退出，请查看日志。'
          : server.enabled
            ? ((runtimeServer && runtimeServer.message) || (server.requiresApiKey && !server.apiKeyConfigured ? '缺少 API Key。' : '已启用；重启 DSH 后注册工具。'))
            : (server.requiresApiKey ? (server.apiKeyConfigured ? 'API Key 已保存，服务当前关闭。' : '尚未配置，服务当前关闭。') : '服务当前关闭。')
        if (id === 'amap') statusText += ' Web JS API Key 与 securityJsCode 请在地图插件的“地图设置”中配置。'
        status.textContent = statusText
        status.className = 'mcp-server-status ' + (runtimeServer && runtimeServer.status === 'connected' ? 'good' : runtimeServer && runtimeServer.status === 'not_connected' && readiness && readiness.canStart ? 'bad' : server.enabled ? 'warn' : server.requiresApiKey && !server.apiKeyConfigured ? 'warn' : '')
      }
      renderMcpPipeline(server, runtimeServer)
    })
  }
  function refreshMcpRuntimeStatus(force) {
    if (!invoke || mcpRuntimeRequest) return mcpRuntimeRequest || Promise.resolve(mcpRuntimeResult)
    if (!force && Date.now() - mcpRuntimeCheckedAt < 2000) return Promise.resolve(mcpRuntimeResult)
    mcpRuntimeCheckedAt = Date.now()
    mcpRuntimeRequest = invokeOrThrow('get_mcp_runtime_status').then(function (result) {
      mcpRuntimeResult = result || null
      renderMcp()
      return mcpRuntimeResult
    }).catch(function (error) {
      mcpError = '读取 MCP 启动状态失败：' + messageOf(error)
      renderMcp()
      return null
    }).finally(function () {
      mcpRuntimeRequest = null
    })
    return mcpRuntimeRequest
  }
  function refreshMcpReadiness(force) {
    if (!invoke || mcpReadinessRequest) return mcpReadinessRequest || Promise.resolve(mcpReadinessResult)
    if (!force && Date.now() - mcpReadinessCheckedAt < 30000) return Promise.resolve(mcpReadinessResult)
    mcpReadinessCheckedAt = Date.now()
    mcpReadinessRequest = invokeOrThrow('check_mcp_readiness').then(function (result) {
      mcpReadinessResult = result || null
      renderMcp()
      return mcpReadinessResult
    }).catch(function (error) {
      mcpError = '检查 MCP 下载与启动条件失败：' + messageOf(error)
      renderMcp()
      return null
    }).finally(function () {
      mcpReadinessRequest = null
      renderMcp()
    })
    renderMcp()
    return mcpReadinessRequest
  }
  function loadMcpServers() {
    if (mcpBusy) return Promise.resolve()
    mcpBusy = true
    mcpError = ''
    renderMcp()
    return invokeOrThrow('list_mcp_servers').then(function (result) {
      mcpResult = result || { servers: [] }
      syncMcpDrafts(mcpResult, true)
    }).catch(function (error) {
      mcpError = '读取 MCP 配置失败：' + messageOf(error)
    }).finally(function () {
      mcpBusy = false
      renderMcp()
      refreshMcpRuntimeStatus(true)
      refreshMcpReadiness(true)
    })
  }
  function saveMcpServer(id, clearSecret) {
    if (mcpBusy || desktopActionsBusy) return
    var enabled = el('mcp-' + id + '-enabled')
    var key = el('mcp-' + id + '-key')
    var autoConnect = el('mcp-' + id + '-auto-connect')
    var apiKey = key ? key.value.trim() : ''
    var secrets = []
    document.querySelectorAll('[data-mcp-secret-server="' + id + '"]').forEach(function (input) {
      var name = input.getAttribute('data-mcp-secret') || ''
      var value = input.value.trim()
      if (name && value) secrets.push({ name: name, value: value })
    })
    if (clearSecret) secrets.push({ name: clearSecret, clear: true })
    mcpBusy = true
    mcpError = ''
    setAppLoading('正在保存 MCP 配置', '配置将写入 DSH web profile，API Key 不会显示在界面中。')
    renderMcp()
    invokeOrThrow('save_mcp_server', {
      id: id,
      enabled: !!(enabled && enabled.checked),
      autoConnect: autoConnect ? !!autoConnect.checked : null,
      apiKey: apiKey || null,
      clearApiKey: false,
      secrets: secrets.length ? secrets : null
    }).then(function (result) {
      mcpResult = result || mcpResult
      syncMcpDrafts(mcpResult, true)
      if (key) key.value = ''
      document.querySelectorAll('[data-mcp-secret-server="' + id + '"]').forEach(function (input) { input.value = '' })
    }).catch(function (error) {
      mcpError = '保存失败：' + messageOf(error)
      syncMcpDrafts(mcpResult, true)
    }).finally(function () {
      mcpBusy = false
      clearAppLoading()
      renderMcp()
      refreshMcpRuntimeStatus(true)
      refreshMcpReadiness(true)
    })
  }
  function setMcpEditorOpen(open) {
    var modal = el('mcp-editor-modal')
    if (!modal) return
    modal.hidden = !open
    modal.setAttribute('aria-hidden', open ? 'false' : 'true')
    document.body.classList.toggle('modal-open', open)
    if (!open) setText('mcp-editor-error', '')
  }
  function updateMcpEditorFields() {
    var http = el('mcp-custom-transport').value === 'streamable-http'
    var command = el('mcp-custom-launch').value === 'command'
    setHidden('mcp-custom-stdio-fields', http)
    setHidden('mcp-custom-http-fields', !http)
    setHidden('mcp-custom-package-field', command)
    setHidden('mcp-custom-command-field', !command)
  }
  function openMcpEditor() {
    el('mcp-editor-form').reset()
    el('mcp-custom-transport').value = 'stdio'
    el('mcp-custom-launch').value = 'npm'
    updateMcpEditorFields()
    setMcpEditorOpen(true)
    window.setTimeout(function () { el('mcp-custom-name').focus() }, 0)
  }
  function parseMcpPairs(value, label) {
    return String(value || '').split(/\r?\n/).map(function (line) { return line.trim() }).filter(Boolean).map(function (line) {
      var separator = line.indexOf('=')
      if (separator < 1) throw new Error(label + '必须使用 NAME=value 格式：' + line)
      return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1) }
    })
  }
  function submitCustomMcp(event) {
    event.preventDefault()
    if (mcpBusy) return
    var transport = el('mcp-custom-transport').value
    var launch = el('mcp-custom-launch').value
    var input
    try {
      input = {
        displayName: el('mcp-custom-name').value.trim(),
        description: el('mcp-custom-description').value.trim(),
        serverName: el('mcp-custom-server-name').value.trim(),
        transport: transport,
        package: transport === 'stdio' && launch === 'npm' ? el('mcp-custom-package').value.trim() : '',
        command: transport === 'stdio' && launch === 'command' ? el('mcp-custom-command').value.trim() : '',
        args: transport === 'stdio' ? el('mcp-custom-args').value.split(/\r?\n/).map(function (line) { return line.trim() }).filter(Boolean) : [],
        url: transport === 'streamable-http' ? el('mcp-custom-url').value.trim() : '',
        env: transport === 'stdio' ? parseMcpPairs(el('mcp-custom-env').value, '环境变量') : [],
        headers: transport === 'streamable-http' ? parseMcpPairs(el('mcp-custom-headers').value, '请求头') : [],
        enabled: el('mcp-custom-enabled').checked
      }
    } catch (error) {
      setText('mcp-editor-error', messageOf(error))
      return
    }
    mcpBusy = true
    setText('mcp-editor-error', '')
    setAppLoading('正在保存自定义 MCP', input.package ? 'npm 包会在首次启用并启动 DSH 时自动安装。' : '正在加密配置并写入 DSH web profile。')
    invokeOrThrow('add_custom_mcp_server', { input: input }).then(function (result) {
      mcpResult = result || mcpResult
      syncMcpDrafts(mcpResult, true)
      setMcpEditorOpen(false)
    }).catch(function (error) {
      setText('mcp-editor-error', '保存失败：' + messageOf(error))
    }).finally(function () {
      mcpBusy = false
      clearAppLoading()
      renderMcp()
      refreshMcpRuntimeStatus(true)
      refreshMcpReadiness(true)
    })
  }
  function openMcpDelete(id) {
    var server = mcpServerById(id)
    if (!server || server.builtIn || mcpBusy) return
    mcpDeleteId = id
    setText('mcp-delete-message', '确认删除 ' + (server.displayName || server.serverName) + '（mcp__' + server.serverName + '__*）？')
    var modal = el('mcp-delete-modal')
    modal.hidden = false
    modal.setAttribute('aria-hidden', 'false')
    document.body.classList.add('modal-open')
  }
  function closeMcpDelete() {
    mcpDeleteId = ''
    var modal = el('mcp-delete-modal')
    modal.hidden = true
    modal.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('modal-open')
  }
  function deleteCustomMcp() {
    var id = mcpDeleteId
    if (!id || mcpBusy) return
    closeMcpDelete()
    mcpBusy = true
    setAppLoading('正在删除 MCP 服务', '正在移除加密配置与 DSH web profile 注册。')
    invokeOrThrow('delete_custom_mcp_server', { id: id }).then(function (result) {
      mcpResult = result || mcpResult
      syncMcpDrafts(mcpResult, true)
    }).catch(function (error) {
      mcpError = '删除失败：' + messageOf(error)
    }).finally(function () {
      mcpBusy = false
      clearAppLoading()
      renderMcp()
      refreshMcpRuntimeStatus(true)
      refreshMcpReadiness(true)
    })
  }
  function loadThemePacks(force) {
    if (!invoke) return Promise.resolve(themePacks)
    if (!force && themePacksLoaded) return Promise.resolve(themePacks)
    if (themePacksRequest) return themePacksRequest
    themePacksRequest = invokeOrThrow('list_theme_packs').then(function (packs) {
      themePacks = Array.isArray(packs) ? packs : []
      themePacksLoaded = true
      applyTheme(state)
      return themePacks
    }).catch(function (error) {
      themePacksLoaded = themePacksLoaded || !force
      if (window.console && console.warn) console.warn('[dsh-desktop] theme pack load failed:', messageOf(error))
      applyTheme(state)
      return themePacks
    }).finally(function () {
      themePacksRequest = null
    })
    return themePacksRequest
  }
  function previewThemePack(pack) {
    if (!pack || pack.protocolCompatible === false || pack.enabled === false || desktopActionsBusy) return
    var currentAppearance = effectiveTheme((state && state.appearanceMode) || 'system')
    if (!packSupportsAppearance(pack, currentAppearance)) {
      themeActionError = (pack.displayName || pack.id) + ' 仅支持' + (pack.supportedAppearances || []).join(' / ') + '外观，请先切换外观模式。'
      renderSkinOptions(state || {}, activeSkinFor(state || {}))
      return
    }
    var previousPreviewId = themePreviewId
    var previousPreviewUntil = themePreviewUntil
    themeActionError = ''
    themePreviewId = pack.id
    themePreviewUntil = Date.now() + 15000
    applyTheme(Object.assign({}, state || {}, { skinId: pack.id }))
    setBusy(true)
    invokeOrThrow('preview_theme_pack', { id: pack.id }).then(function (result) {
      themePreviewId = result && result.id ? String(result.id) : pack.id
      themePreviewUntil = result && result.expiresAt ? Number(result.expiresAt) : Date.now() + 15000
      themeActionError = ''
      render(state)
    }).catch(function (error) {
      themePreviewId = previousPreviewId
      themePreviewUntil = previousPreviewUntil
      themeActionError = '主题预览失败：' + messageOf(error)
      applyTheme(state)
      render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '主题预览失败' }))
    }).finally(function () {
      setBusy(false)
      refresh()
    })
  }
  function finishThemePreview(command, args) {
    if (!themePreviewUntil && !themePreviewId) return
    setBusy(true)
    invokeOrThrow(command, args || {}).then(function () {
      themePreviewId = ''
      themePreviewUntil = 0
    }).catch(function (error) {
      themeActionError = '主题预览操作失败：' + messageOf(error)
      render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '主题预览操作失败' }))
    }).finally(function () {
      setBusy(false)
      refresh()
    })
  }
  function scheduleThemePreferencesSave() {
    var range = el('background-intensity')
    var reduce = el('reduce-effects')
    var intensity = range ? Math.max(0, Math.min(1, Number(range.value))) : 0.32
    var reduceEffects = !!(reduce && reduce.checked)
    var optimistic = Object.assign({}, state || {}, { backgroundIntensity: intensity, reduceEffects: reduceEffects })
    applyTheme(optimistic)
    if (themePreferencesTimer) window.clearTimeout(themePreferencesTimer)
    themePreferencesTimer = window.setTimeout(function () {
      invokeOrThrow('set_background_preferences', { intensity: intensity, reduceEffects: reduceEffects }).catch(function (error) {
        if (window.console && console.warn) console.warn('[dsh-desktop] background preference save failed:', messageOf(error))
      })
    }, 180)
  }
  function render(next) {
    var wasRunning = !!(state && state.webUrl)
    var previousMarketCacheAt = marketCacheSeenAt
    state = next || state || {}
    var nextMarketCacheAt = Number(state.marketCacheUpdatedAt || 0)
    var marketCacheChanged = nextMarketCacheAt > 0 && nextMarketCacheAt !== previousMarketCacheAt
    if (nextMarketCacheAt > 0) marketCacheSeenAt = nextMarketCacheAt
    renderMarketUpdateBadge(state)
    if (state.themePreviewUntil) themePreviewUntil = Number(state.themePreviewUntil)
    else if (themePreviewUntil && themePreviewUntil <= Date.now()) { themePreviewUntil = 0; themePreviewId = '' }
    if (!!state.webUrl && !wasRunning && pendingRestartNames.length) {
      pendingRestartNames = []
      if (viewMode === 'market' && !marketBusy) window.setTimeout(function () { marketSearch(marketQuery) }, 0)
    }
    applyTheme(state)
    updateView()
    renderMarket()
    renderMcp()
    if (marketCacheChanged && marketResult && viewMode === 'market' && !marketBusy) {
      window.setTimeout(function () {
        if (viewMode === 'market' && !marketBusy) marketSearch(marketQuery, false)
      }, 0)
    }
    if (viewMode === 'mcp') refreshMcpRuntimeStatus(false)
    var meta = statusMeta(state.status)
    setText('status-title', state.message || '等待操作')
    setText('status-pill', meta[0])
    if (el('status-pill')) el('status-pill').className = 'pill ' + meta[1]
    setText('status-message', state.detail || '')
    setText('entry-message', state.webUrl
      ? 'DSH 已启动，可以关闭服务，或直接进入上游页面。'
      : (state.status === 'needs_workspace' ? '点击启动时会弹出工作区选择，完成后自动进入页面。' : '未启动时先启动 DSH，启动完成后再进入页面。'))
    var local = state.localRuntime
    var source = state.runtimeSource || 'managed'
    var localVersion = local && local.version ? local.version : ''
    if (localDetecting) {
      setText('runtime-source-title', '正在检测本地 DSH…')
      setText('runtime-source-message', '正在调用 npx 探测 @deepseek-ai/dsh 版本，请稍候。')
    } else {
      setText('runtime-source-title', source === 'local' ? '当前使用本地 DSH' : '当前使用桌面托管 DSH')
      setText('runtime-source-message', localVersion
        ? '已检测到 @deepseek-ai/dsh@' + localVersion + '（' + (local.source || '系统 PATH') + '）。' + (source === 'local' ? '当前启动会复用这个本地版本。' : '你也可以直接切换使用它。')
        : '系统中暂未检测到可复用的本地 @deepseek-ai/dsh；可以安装并使用桌面托管版本。')
    }
    setHidden('use-local', !localVersion || source === 'local' || localDetecting)
    setHidden('use-managed', source !== 'local' || localDetecting)
    setText('version-summary', '固定版本 ' + (state.pinned || '未设置'))
    setText('update-message', versionHint || (state.available ? '检测到可用版本 ' + state.available + '，安装后切换到托管版。' : '安装只会写入桌面托管目录，不会覆盖系统中的本地版本。'))
    setHidden('error-detail', !state.error)
    setText('error-detail', state.error || '')
    setHidden('progress-track', !['installing', 'updating'].includes(state.status))
    setHidden('install-log', !state.logs || !state.logs.length)
    setText('install-log', (state.logs || []).slice(-80).join('\n'))
    if (state.progress != null && el('progress-bar')) el('progress-bar').style.width = Math.max(3, Math.min(100, state.progress)) + '%'
    var versions = versionsOf(state)
    setHidden('update-card', !versions.length)
    var select = el('version-select')
    if (select) {
      var current = select.value
      select.innerHTML = ''
      select.disabled = !versions.length
      versions.forEach(function (version) {
        var option = document.createElement('option')
        option.value = version.version
        option.textContent = version.version + (version.installed ? ' · 已安装' : ' · 可下载')
        if (version.version === current || (!current && version.version === state.available)) option.selected = true
        select.appendChild(option)
      })
    }
    var selectedVersion = select && select.value ? versions.find(function (version) { return version.version === select.value }) : null
    var deleteButton = el('delete-version')
    if (deleteButton) {
      var selectedIsPinned = !!(selectedVersion && state.runtimeSource !== 'local' && selectedVersion.version === state.pinned)
      var canDelete = !!(selectedVersion && selectedVersion.installed && !selectedIsPinned)
      deleteButton.disabled = !canDelete || desktopActionsBusy
      deleteButton.title = !selectedVersion
        ? '请选择一个运行时版本'
        : !selectedVersion.installed
          ? '当前版本尚未安装，不能删除'
          : selectedIsPinned
            ? '不能删除当前固定版本，请先切换到其他托管版本'
            : '删除已安装的托管运行时 ' + selectedVersion.version
    }
    var primary = el('primary-action')
    if (primary) primary.textContent = state.status === 'needs_workspace' ? '选择工作区' : '重启'
    var running = !!state.webUrl
    var toggleDsh = el('toggle-dsh')
    var enterDshButton = el('enter-dsh')
    if (toggleDsh) {
      toggleDsh.textContent = running ? '关闭' : (['starting', 'installing', 'updating'].includes(state.status) ? '启动中…' : '启动')
      toggleDsh.className = 'button ' + (running ? 'secondary' : 'primary')
      toggleDsh.disabled = !running && ['starting', 'installing', 'updating'].includes(state.status)
      toggleDsh.title = running ? '停止 DSH 服务' : '启动 DSH 服务'
    }
    ;['restart-dsh', 'app-restart'].forEach(function (id) {
      var restartButton = el(id)
      if (!restartButton) return
      var restartBlocked = ['starting', 'installing', 'updating'].includes(state.status)
      restartButton.disabled = !running || restartBlocked || desktopActionsBusy
      restartButton.title = running ? '停止并重新启动当前 DSH 工作区' : 'DSH 当前未运行，无法重启'
      restartButton.setAttribute('aria-label', restartButton.title)
    })
    if (enterDshButton) {
      enterDshButton.disabled = !running
      enterDshButton.title = running ? '进入已启动的 DSH 页面' : 'DSH 未启动，暂时无法进入页面'
    }
  }
  function desktopContributionStateKey(snapshot) {
    return [
      snapshot && snapshot.webUrl ? String(snapshot.webUrl) : '',
      snapshot && snapshot.workspace ? String(snapshot.workspace) : '',
      snapshot && snapshot.runtimeSource ? String(snapshot.runtimeSource) : '',
      snapshot && snapshot.pinned ? String(snapshot.pinned) : '',
      pendingRestartNames.join(',')
    ].join('|')
  }
  function refreshDesktopContributions(force) {
    var key = desktopContributionStateKey(state)
    // 贡献清单来自本地 web profile，可以在 DSH 页面出现前预加载。
    // renderDesktopActions 仍会根据 dshRunning/viewMode 决定是否真正显示。
    var canRead = !!state
    if (!canRead) {
      desktopContributions = []
      desktopContributionsKey = key
      renderDesktopActions()
      return Promise.resolve()
    }
    if (!force && desktopContributionsKey === key) return Promise.resolve()
    if (desktopContributionRequest) return desktopContributionRequest
    desktopContributionRequest = invokeOrThrow('get_desktop_contributions').then(function (result) {
      desktopContributions = result && Array.isArray(result.contributions) ? result.contributions : []
      desktopContributionsKey = key
      renderDesktopActions()
      return result
    }).catch(function (error) {
      desktopContributions = []
      desktopContributionsKey = key
      renderDesktopActions()
      if (window.console && console.warn) console.warn('[dsh-desktop] desktop contribution load failed:', messageOf(error))
      return null
    }).finally(function () { desktopContributionRequest = null })
    return desktopContributionRequest
  }
  function refresh() {
    return invokeOrThrow('get_status').then(function (next) {
      render(next)
      return refreshDesktopContributions(false)
    }).catch(function (error) {
      setText('status-title', '无法连接客户端后端')
      setText('status-message', messageOf(error))
      if (el('status-pill')) el('status-pill').className = 'pill bad'
      setText('status-pill', '错误')
    })
  }
  function action(work, loadingMessage, loadingDetail) {
    versionHint = ''
    setBusy(true)
    if (loadingMessage) setAppLoading(loadingMessage, loadingDetail || '请稍候，操作完成后会自动刷新状态。')
    return Promise.resolve().then(work).catch(function (error) {
      render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '操作失败' }))
    }).finally(function () {
      setBusy(false)
      return refresh().finally(function () {
        if (loadingMessage) clearAppLoading()
      })
    })
  }
  function detectAction(work) {
    localDetecting = true
    render(state)
    versionHint = ''
    setBusy(true)
    return Promise.resolve().then(work).catch(function (error) {
      render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '操作失败' }))
    }).finally(function () {
      localDetecting = false
      setBusy(false)
      return refresh()
    })
  }
  function showWindowError(error) {
    render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '窗口操作失败' }))
  }
  function setMaximizeGlyph(maximized) {
    var button = el('window-maximize')
    if (!button) return
    button.textContent = maximized ? '❐' : '□'
    button.title = maximized ? '还原' : '最大化'
    button.setAttribute('aria-label', maximized ? '还原' : '最大化')
  }
  el('titlebar-drag').addEventListener('mousedown', function (event) {
    if (event.button !== 0) return
    event.preventDefault()
    invokeOrThrow('start_window_dragging').catch(showWindowError)
  })
  el('titlebar-plugin-overflow').addEventListener('mousedown', function (event) { event.stopPropagation() })
  window.addEventListener('resize', layoutDesktopActions)
  el('titlebar-home').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-home').addEventListener('click', function () {
    if (viewMode === 'market' || viewMode === 'mcp') {
      if (state && state.webUrl) { viewMode = 'dsh'; updateView() } else showHome()
      return
    }
    if (!state || !state.webUrl) return
    if (viewMode === 'dsh') showHome()
    else { viewMode = 'dsh'; updateView() }
  })
  el('titlebar-market').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-market').addEventListener('click', openMarket)
  el('titlebar-mcp').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-mcp').addEventListener('click', openMcp)
  el('titlebar-skills').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-skills').addEventListener('click', function () { postDshMessage('dsh-market-skills-open') })
  window.addEventListener('message', function (event) {
    var frame = el('dsh-frame')
    if (!frame || event.source !== frame.contentWindow) return
    var data = event.data
    if (!data) return
    if (data.source === 'dsh-desktop-theme') {
      themeWebStatus = data.type === 'theme-applied' ? 'applied' : 'error'
      if (themeWebStatusTimer) window.clearTimeout(themeWebStatusTimer)
      renderSkinOptions(state || {}, activeSkinFor(state || {}))
      return
    }
    if (data.source === '@p-dsh-market/akshare-market-analysis') {
      if (data.type === 'analysis-panel-state') marketPanelOpen = data.open === true
      updateView()
      return
    }
    if (data.source === '@p-dsh-market/multi-agent-roundtable') {
      if (data.type === 'roundtable-panel-state') roundtablePanelOpen = data.open === true
      updateView()
      return
    }
    if (data.source !== 'dsh-open-workspace') return
    if (data.type === 'workspace-panel-state') workspacePanelOpen = data.open === true
    if (data.type === 'terminal-panel-state') terminalPanelOpen = data.open === true
    updateView()
  })
  var dshFrame = el('dsh-frame')
  if (dshFrame) {
    dshFrame.addEventListener('load', function () {
      themePostedSkin = ''
      postDshMessage('workspace-panel-state-request')
      postDshMessage('terminal-panel-state-request')
      postDshMessage('analysis-panel-state-request')
      postDshMessage('roundtable-panel-state-request')
      postActiveTheme(activeSkinFor(state || {}), state || {}, effectiveTheme((state && state.appearanceMode) || 'system'))
    })
  }
  el('window-minimize').addEventListener('click', function () { invokeOrThrow('minimize_window').catch(showWindowError) })
  el('window-maximize').addEventListener('click', function () {
    invokeOrThrow('toggle_maximize').then(setMaximizeGlyph).catch(showWindowError)
  })
  el('window-close').addEventListener('click', closeWindow)
  el('app-home').addEventListener('click', function () { showHome() })
  el('app-restart').addEventListener('click', restartDsh)
  el('market-back-home').addEventListener('click', function () { showHome() })
  el('mcp-back-home').addEventListener('click', function () { showHome() })
  el('mcp-open-logs').addEventListener('click', function () { action(function () { return invokeOrThrow('open_logs') }) })
  el('mcp-add-server').addEventListener('click', openMcpEditor)
  el('mcp-check-readiness').addEventListener('click', function () { refreshMcpReadiness(true) })
  el('mcp-editor-cancel').addEventListener('click', function () { setMcpEditorOpen(false) })
  el('mcp-editor-modal').addEventListener('click', function (event) {
    if (event.target && event.target.getAttribute('data-mcp-editor-cancel') === 'true') setMcpEditorOpen(false)
  })
  el('mcp-editor-form').addEventListener('submit', submitCustomMcp)
  el('mcp-custom-transport').addEventListener('change', updateMcpEditorFields)
  el('mcp-custom-launch').addEventListener('change', updateMcpEditorFields)
  el('mcp-delete-cancel').addEventListener('click', closeMcpDelete)
  el('mcp-delete-accept').addEventListener('click', deleteCustomMcp)
  el('mcp-delete-modal').addEventListener('click', function (event) {
    if (event.target && event.target.getAttribute('data-mcp-delete-cancel') === 'true') closeMcpDelete()
  })
  document.querySelectorAll('[data-mcp-save]').forEach(function (button) {
    button.addEventListener('click', function () { saveMcpServer(button.getAttribute('data-mcp-save')) })
  })
  document.querySelectorAll('[data-mcp-clear-secret]').forEach(function (button) {
    button.addEventListener('click', function () {
      saveMcpServer(button.getAttribute('data-mcp-clear-server'), button.getAttribute('data-mcp-clear-secret'))
    })
  })
  document.querySelectorAll('[data-mcp-server] input[id$="-enabled"]').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      var card = checkbox.closest('[data-mcp-server]')
      var id = card && card.getAttribute('data-mcp-server')
      if (id) {
        mcpDraftEnabled[id] = checkbox.checked
        saveMcpServer(id)
      }
    })
  })
  el('mcp-chrome-auto-connect').addEventListener('change', function () {
    mcpDraftAutoConnect.chrome = el('mcp-chrome-auto-connect').checked
    saveMcpServer('chrome')
  })
  el('market-search-form').addEventListener('submit', function (event) {
    event.preventDefault()
    marketSearch(el('market-query').value, false)
  })
  el('market-refresh-button').addEventListener('click', function () {
    marketSearch(el('market-query').value, true)
  })
  el('market-confirm-cancel').addEventListener('click', function () { resolveMarketConfirmation(false) })
  el('market-confirm-accept').addEventListener('click', function () { resolveMarketConfirmation(true) })
  el('market-confirm-modal').addEventListener('click', function (event) {
    if (event.target && event.target.getAttribute('data-market-confirm-cancel') === 'true') resolveMarketConfirmation(false)
  })
  el('runtime-confirm-cancel').addEventListener('click', function () { resolveRuntimeDeletion(false) })
  el('runtime-confirm-accept').addEventListener('click', function () { resolveRuntimeDeletion(true) })
  el('runtime-confirm-modal').addEventListener('click', function (event) {
    if (event.target && event.target.getAttribute('data-runtime-confirm-cancel') === 'true') resolveRuntimeDeletion(false)
  })
  document.querySelectorAll('[data-category]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      if (marketBusy || marketConfirming) return
      marketCategory = tab.getAttribute('data-category') || 'all'
      renderMarket()
    })
  })
  var detailPanel = el('market-detail-panel')
  if (detailPanel) {
    detailPanel.addEventListener('click', function (event) {
      if (event.target && event.target.getAttribute('data-market-detail-close') === 'true') closeMarketDetail()
    })
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && el('mcp-editor-modal') && !el('mcp-editor-modal').hidden) {
      event.preventDefault()
      setMcpEditorOpen(false)
      return
    }
    if (event.key === 'Escape' && mcpDeleteId) {
      event.preventDefault()
      closeMcpDelete()
      return
    }
    if (event.key === 'Escape' && marketConfirming) {
      event.preventDefault()
      resolveMarketConfirmation(false)
      return
    }
    if (event.key === 'Escape' && runtimeConfirming) {
      event.preventDefault()
      resolveRuntimeDeletion(false)
      return
    }
    if (event.key === 'Escape' && marketSelectedPlugin) {
      event.preventDefault()
      closeMarketDetail()
    }
  })
  el('detect-local').addEventListener('click', function () { detectAction(function () { return invokeOrThrow('detect_local_runtime') }) })
  el('use-local').addEventListener('click', function () { detectAction(function () { return invokeOrThrow('set_runtime_source', { source: 'local' }) }) })
  el('use-managed').addEventListener('click', function () { detectAction(function () { return invokeOrThrow('set_runtime_source', { source: 'managed' }) }) })
  document.querySelectorAll('[data-theme-choice]').forEach(function (button) {
    button.addEventListener('click', function () {
      var theme = button.getAttribute('data-theme-choice')
      if (desktopActionsBusy || !theme) return
      themeActionError = ''
      // Apply the visual mode before the Tauri round trip so a click never
      // looks inert while state.json is being written.
      applyTheme(Object.assign({}, state || {}, { appearanceMode: theme }))
      action(function () { return invokeOrThrow('set_theme', { theme: theme }) })
    })
  })
  el('background-intensity').addEventListener('input', scheduleThemePreferencesSave)
  el('reduce-effects').addEventListener('change', scheduleThemePreferencesSave)
  el('confirm-theme-preview').addEventListener('click', function () {
    finishThemePreview('confirm_theme_pack', { id: themePreviewId || (state && state.skinId) })
  })
  el('cancel-theme-preview').addEventListener('click', function () {
    finishThemePreview('cancel_theme_preview')
  })
  el('reset-theme').addEventListener('click', function () {
    setBusy(true)
    invokeOrThrow('reset_theme_pack').then(function () {
      themePreviewId = ''
      themePreviewUntil = 0
      themeActionError = ''
    }).catch(function (error) {
      render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '恢复默认主题失败' }))
    }).finally(function () {
      setBusy(false)
      refresh()
    })
  })
  el('toggle-dsh').addEventListener('click', toggleDsh)
  el('restart-dsh').addEventListener('click', restartDsh)
  el('market-restart-dsh').addEventListener('click', restartDsh)
  el('mcp-restart-dsh').addEventListener('click', restartDsh)
  el('enter-dsh').addEventListener('click', enterDsh)
  el('primary-action').addEventListener('click', function () {
    action(function () { return state && state.status === 'needs_workspace' ? invokeOrThrow('choose_workspace') : invokeOrThrow('start_dsh') })
  })
  el('check-updates').addEventListener('click', function () { action(function () { return invokeOrThrow('check_for_updates') }) })
  el('version-select').addEventListener('change', function () {
    var option = this.options[this.selectedIndex]
    versionHint = option ? '已选择 ' + option.value + '，点击“安装并切换”开始安装。' : '暂无可安装版本，请先点击“检查更新”。'
    render(state)
  })
  el('version-select').addEventListener('click', function () {
    if (this.options.length) return
    versionHint = '正在加载上游版本列表…'
    render(state)
    action(function () { return invokeOrThrow('check_for_updates') })
  })
  el('install-version').addEventListener('click', function () {
    var version = el('version-select').value
    if (!version) {
      versionHint = '暂无可安装版本，请先点击“检查更新”。'
      render(Object.assign({}, state || {}, { status: 'stopped', message: '没有可安装版本' }))
      return
    }
    action(function () { return invokeOrThrow('install_and_switch', { version: version }) })
  })
  el('delete-version').addEventListener('click', function () {
    var select = el('version-select')
    var version = select && select.value
    var selected = state && versionsOf(state).find(function (item) { return item.version === version })
    if (!selected || !selected.installed) {
      versionHint = '请选择一个已安装的运行时版本。'
      render(state)
      return
    }
    if (state.runtimeSource !== 'local' && version === state.pinned) {
      versionHint = '当前固定版本不能删除，请先切换到其他托管版本。'
      render(state)
      return
    }
    confirmRuntimeDeletion(version).then(function (confirmed) {
      if (confirmed) action(function () { return invokeOrThrow('delete_runtime', { version: version }) }, '正在删除运行时…', '正在删除托管版本 ' + version + '，请稍候。')
    })
  })
  el('open-logs').addEventListener('click', function () { action(function () { return invokeOrThrow('open_logs') }) })
  el('quit').addEventListener('click', function () { action(function () { return invokeOrThrow('quit_app') }) })
  var onSystemThemeChanged = function () {
    if (!state || (state.appearanceMode || state.theme || 'system') === 'system') applyTheme(state || 'system')
  }
  if (systemThemeMedia.addEventListener) systemThemeMedia.addEventListener('change', onSystemThemeChanged)
  else if (systemThemeMedia.addListener) systemThemeMedia.addListener(onSystemThemeChanged)
  loadThemePacks()
  refresh()
  poller = window.setInterval(refresh, 1500)
  window.addEventListener('beforeunload', function () { if (poller) window.clearInterval(poller) })
})()
