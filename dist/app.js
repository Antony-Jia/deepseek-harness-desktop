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
  var marketResult = null
  var marketQuery = ''
  var marketBusy = false
  var marketError = ''
  var marketOperation = null
  var pendingRestartNames = []
  var localDetecting = false
  var systemThemeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false }

  function el(id) { return document.getElementById(id) }
  function setText(id, value) { if (el(id)) el(id).textContent = value == null ? '' : String(value) }
  function setHidden(id, hidden) { if (el(id)) el(id).hidden = hidden }
  function effectiveTheme(theme) {
    return theme === 'light' || theme === 'dark' ? theme : (systemThemeMedia.matches ? 'dark' : 'light')
  }
  function applyTheme(theme) {
    var preference = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system'
    var active = effectiveTheme(preference)
    document.documentElement.dataset.theme = active
    document.documentElement.dataset.themePreference = preference
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
  }
  function setBusy(busy) {
    ;['primary-action', 'toggle-dsh', 'enter-dsh', 'check-updates', 'install-version', 'version-select', 'detect-local', 'use-local', 'use-managed', 'titlebar-home', 'titlebar-workspace', 'titlebar-terminal', 'app-home', 'app-update', 'app-upgrade', 'app-stop'].forEach(function (id) {
      var node = el(id)
      if (node) node.disabled = !!busy
    })
  }
  function updateView() {
    var url = state && state.webUrl ? String(state.webUrl) : ''
    if (url) {
      if (!autoOpenedUrl && viewMode !== 'market') viewMode = 'dsh'
      autoOpenedUrl = url
    } else if (viewMode === 'dsh') {
      viewMode = 'home'
      autoOpenedUrl = ''
    } else {
      autoOpenedUrl = ''
    }
    var showingDsh = !!url && viewMode === 'dsh'
    var showingMarket = viewMode === 'market'
    setHidden('setup-view', showingDsh || showingMarket)
    setHidden('dsh-view', !showingDsh)
    setHidden('market-view', !showingMarket)
    setHidden('app-actions', !showingDsh)
    var titlebarHome = el('titlebar-home')
    if (titlebarHome) {
      titlebarHome.disabled = !url && !showingMarket
      titlebarHome.title = showingMarket
        ? (url ? '进入 DSH 页面' : '返回配置首页')
        : (!url ? 'DSH 未启动，无法切换页面' : (showingDsh ? '返回配置首页' : '进入 DSH 页面'))
      titlebarHome.setAttribute('aria-label', titlebarHome.title)
    }
    var marketButton = el('titlebar-market')
    if (marketButton) {
      marketButton.classList.toggle('active', showingMarket)
      marketButton.setAttribute('aria-pressed', showingMarket ? 'true' : 'false')
    }
    var workspaceReady = !!(state && state.workspace)
    var workspaceButton = el('titlebar-workspace')
    var terminalButton = el('titlebar-terminal')
    if (workspaceButton) {
      workspaceButton.disabled = !(showingDsh && workspaceReady)
      workspaceButton.title = showingDsh && workspaceReady ? (workspacePanelOpen ? '隐藏右侧工作区面板' : '显示右侧工作区面板') : '尚未进入 DSH 或选择工作区'
      workspaceButton.setAttribute('aria-label', workspaceButton.title)
      workspaceButton.setAttribute('aria-pressed', workspacePanelOpen ? 'true' : 'false')
    }
    if (terminalButton) {
      terminalButton.disabled = !(showingDsh && workspaceReady)
      terminalButton.title = showingDsh && workspaceReady ? (terminalPanelOpen ? '关闭下方 PowerShell 面板' : '打开下方 PowerShell 面板') : '尚未进入 DSH 或选择工作区'
      terminalButton.setAttribute('aria-label', terminalButton.title)
      terminalButton.setAttribute('aria-pressed', terminalPanelOpen ? 'true' : 'false')
    }
    var frame = el('dsh-frame')
    if (frame && url && loadedFrameUrl !== url) {
      workspacePanelOpen = false
      terminalPanelOpen = false
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
  function openUpdateCard(checkFirst) {
    showHome('update-card')
    if (!checkFirst) return Promise.resolve()
    return action(function () { return invokeOrThrow('check_for_updates') }).then(function () { focusHomeElement('update-card') })
  }
  function openMarket() {
    viewMode = 'market'
    updateView()
    if (!marketBusy) marketSearch(marketResult ? marketQuery : '')
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
  function postDshMessage(type, payload) {
    var frame = el('dsh-frame')
    if (!frame || !frame.contentWindow) return false
    frame.contentWindow.postMessage(Object.assign({ source: 'dsh-desktop', type: type }, payload || {}), '*')
    return true
  }
  function openWorkspacePanel() {
    if (!state || !state.workspace || viewMode !== 'dsh') return
    postDshMessage('workspace-panel-toggle')
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
  function renderMarket() {
    var source = state && state.runtimeSource === 'local' ? '本地' : '桌面托管'
    var runtimeReady = marketResult ? !!marketResult.runtimeReady : true
    var packageManagerReady = marketResult ? !!marketResult.packageManagerReady : false
    setText('market-runtime-title', runtimeReady ? '当前使用' + source + ' DSH' : '插件市场只读')
    setText('market-runtime-message', marketResult && marketResult.message
      ? marketResult.message
      : (runtimeReady ? '市场固定使用 web profile，不会切换 DSH 运行来源。' : '请先返回首页准备 DSH 运行时。'))
    setPill('market-runtime-pill', runtimeReady ? 'DSH 可用' : 'DSH 缺失', runtimeReady ? 'good' : 'warn')
    setPill('market-pnpm-pill', packageManagerReady ? '私有 pnpm 可用' : 'pnpm 未准备', packageManagerReady ? 'good' : 'warn')
    var query = el('market-query')
    if (query && document.activeElement !== query) query.value = marketQuery
    var canSearch = !marketResult || (runtimeReady && packageManagerReady)
    var searchButton = el('market-search-button')
    if (searchButton) {
      searchButton.disabled = marketBusy || !canSearch
      searchButton.textContent = marketBusy ? '处理中…' : '搜索'
    }
    if (query) query.disabled = marketBusy || !canSearch
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
    var results = el('market-results')
    if (results) {
      results.replaceChildren()
      if (marketResult && marketResult.plugins && marketResult.plugins.length) {
        marketResult.plugins.forEach(function (plugin) { results.appendChild(renderMarketPlugin(plugin, runtimeReady && packageManagerReady)) })
      } else if (marketResult && runtimeReady && packageManagerReady && !marketBusy) {
        var empty = makeNode('div', 'market-empty', marketResult.message || '没有符合条件的插件。')
        results.appendChild(empty)
      }
    }
    var operationCard = el('market-operation-card')
    if (operationCard) operationCard.hidden = !marketOperation
    if (marketOperation) {
      setText('market-operation-title', marketOperation.running ? '正在' + (marketOperation.operation === 'install' ? '安装' : '卸载') : (marketOperation.ok ? '插件操作完成' : '插件操作失败'))
      setText('market-operation-message', marketOperation.message || '')
      var details = el('market-operation-details')
      if (details) details.hidden = !marketOperation.log
      setText('market-operation-log', marketOperation.log || '')
    }
  }
  function renderMarketPlugin(plugin, enabled) {
    var card = makeNode('article', 'market-plugin-card')
    var heading = makeNode('div', 'market-plugin-heading')
    var title = makeNode('h2', null, plugin.displayName || plugin.name)
    var packageName = makeNode('code', 'market-plugin-name', plugin.name)
    heading.appendChild(title)
    heading.appendChild(packageName)
    card.appendChild(heading)
    var description = makeNode('p', 'market-plugin-description', plugin.description || '暂无描述。')
    card.appendChild(description)
    var meta = makeNode('div', 'market-plugin-meta')
    meta.appendChild(makeNode('span', 'market-plugin-version', '最新版本 ' + plugin.version))
    if (plugin.installed) meta.appendChild(makeNode('span', 'pill good', '已安装 · ' + (plugin.installedVersion || '未知版本')))
    card.appendChild(meta)
    var capabilities = makeNode('div', 'market-capabilities')
    ;(plugin.capabilities || []).forEach(function (capability) { capabilities.appendChild(makeNode('span', 'market-capability', capability)) })
    card.appendChild(capabilities)
    var footer = makeNode('div', 'market-plugin-footer')
    var actionButton = makeNode('button', 'button ' + (plugin.installed ? 'danger-button' : 'primary'), plugin.installed ? '卸载' : '安装')
    actionButton.type = 'button'
    actionButton.disabled = !enabled || marketBusy
    actionButton.title = plugin.installed ? '从 web profile 卸载此插件' : '安装搜索结果中的确定版本 ' + plugin.version
    actionButton.addEventListener('click', function () { runMarketOperation(plugin, plugin.installed ? 'uninstall' : 'install') })
    footer.appendChild(actionButton)
    card.appendChild(footer)
    return card
  }
  function marketSearch(queryValue) {
    if (marketBusy) return Promise.resolve()
    marketQuery = String(queryValue == null ? '' : queryValue).trim()
    marketError = ''
    marketBusy = true
    renderMarket()
    return invokeOrThrow('search_market_plugins', { query: marketQuery }).then(function (result) {
      marketResult = result || null
      marketQuery = result && result.query != null ? String(result.query) : marketQuery
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
    if (marketBusy || !marketResult || !marketResult.runtimeReady || !marketResult.packageManagerReady) return
    var actionText = operation === 'install' ? '安装' : '卸载'
    var confirmation = operation === 'install'
      ? '确认安装 ' + plugin.name + '@' + plugin.version + ' 到 web profile？'
      : '确认从 web profile 卸载 ' + plugin.name + '？'
    if (typeof window.confirm === 'function' && !window.confirm(confirmation)) return
    marketBusy = true
    marketError = ''
    marketOperation = { running: true, operation: operation, name: plugin.name, message: '正在' + actionText + '，请稍候…', log: '' }
    renderMarket()
    var command = operation === 'install' ? 'install_market_plugin' : 'uninstall_market_plugin'
    var args = operation === 'install' ? { name: plugin.name, version: plugin.version } : { name: plugin.name }
    invokeOrThrow(command, args).then(function (result) {
      marketOperation = Object.assign({}, result || {}, { running: false, operation: operation, name: plugin.name, ok: true })
      if (result && result.restartRequired && pendingRestartNames.indexOf(plugin.name) < 0) pendingRestartNames.push(plugin.name)
      return invokeOrThrow('search_market_plugins', { query: marketQuery }).then(function (next) {
        marketResult = next || marketResult
        marketQuery = next && next.query != null ? String(next.query) : marketQuery
      }).catch(function (error) {
        marketError = '操作已完成，但刷新插件列表失败：' + messageOf(error)
      })
    }).catch(function (error) {
      marketOperation = { running: false, operation: operation, name: plugin.name, ok: false, message: actionText + '失败：' + messageOf(error), log: messageOf(error) }
      marketError = messageOf(error)
    }).finally(function () {
      marketBusy = false
      renderMarket()
    })
  }
  function render(next) {
    var wasRunning = !!(state && state.webUrl)
    state = next || state || {}
    if (!!state.webUrl && !wasRunning && pendingRestartNames.length) {
      pendingRestartNames = []
      if (viewMode === 'market' && !marketBusy) window.setTimeout(function () { marketSearch(marketQuery) }, 0)
    }
    applyTheme(state.theme || 'system')
    updateView()
    renderMarket()
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
    if (enterDshButton) {
      enterDshButton.disabled = !running
      enterDshButton.title = running ? '进入已启动的 DSH 页面' : 'DSH 未启动，暂时无法进入页面'
    }
  }
  function refresh() {
    return invokeOrThrow('get_status').then(render).catch(function (error) {
      setText('status-title', '无法连接客户端后端')
      setText('status-message', messageOf(error))
      if (el('status-pill')) el('status-pill').className = 'pill bad'
      setText('status-pill', '错误')
    })
  }
  function action(work) {
    versionHint = ''
    setBusy(true)
    return Promise.resolve().then(work).catch(function (error) {
      render(Object.assign({}, state || {}, { status: 'failed', error: messageOf(error), message: '操作失败' }))
    }).finally(function () { setBusy(false); return refresh() })
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
  el('titlebar-home').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-home').addEventListener('click', function () {
    if (viewMode === 'market') {
      if (state && state.webUrl) { viewMode = 'dsh'; updateView() } else showHome()
      return
    }
    if (!state || !state.webUrl) return
    if (viewMode === 'dsh') showHome()
    else { viewMode = 'dsh'; updateView() }
  })
  el('titlebar-market').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-market').addEventListener('click', openMarket)
  el('titlebar-workspace').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-workspace').addEventListener('click', openWorkspacePanel)
  el('titlebar-terminal').addEventListener('mousedown', function (event) { event.stopPropagation() })
  el('titlebar-terminal').addEventListener('click', openTerminalPanel)
  window.addEventListener('message', function (event) {
    var frame = el('dsh-frame')
    if (!frame || event.source !== frame.contentWindow) return
    var data = event.data
    if (!data || data.source !== 'dsh-open-workspace') return
    if (data.type === 'workspace-panel-state') workspacePanelOpen = data.open === true
    if (data.type === 'terminal-panel-state') terminalPanelOpen = data.open === true
    updateView()
  })
  var dshFrame = el('dsh-frame')
  if (dshFrame) {
    dshFrame.addEventListener('load', function () {
      postDshMessage('workspace-panel-state-request')
      postDshMessage('terminal-panel-state-request')
    })
  }
  el('window-minimize').addEventListener('click', function () { invokeOrThrow('minimize_window').catch(showWindowError) })
  el('window-maximize').addEventListener('click', function () {
    invokeOrThrow('toggle_maximize').then(setMaximizeGlyph).catch(showWindowError)
  })
  el('window-close').addEventListener('click', closeWindow)
  el('app-home').addEventListener('click', function () { showHome() })
  el('app-update').addEventListener('click', function () { openUpdateCard(true) })
  el('app-upgrade').addEventListener('click', function () { openUpdateCard(true) })
  el('app-stop').addEventListener('click', function () {
    showHome()
    action(function () { return invokeOrThrow('stop_dsh') })
  })
  el('market-back-home').addEventListener('click', function () { showHome() })
  el('market-search-form').addEventListener('submit', function (event) {
    event.preventDefault()
    marketSearch(el('market-query').value)
  })
  el('detect-local').addEventListener('click', function () { detectAction(function () { return invokeOrThrow('detect_local_runtime') }) })
  el('use-local').addEventListener('click', function () { detectAction(function () { return invokeOrThrow('set_runtime_source', { source: 'local' }) }) })
  el('use-managed').addEventListener('click', function () { detectAction(function () { return invokeOrThrow('set_runtime_source', { source: 'managed' }) }) })
  document.querySelectorAll('[data-theme-choice]').forEach(function (button) {
    button.addEventListener('click', function () {
      var theme = button.getAttribute('data-theme-choice')
      action(function () { return invokeOrThrow('set_theme', { theme: theme }) })
    })
  })
  el('toggle-dsh').addEventListener('click', toggleDsh)
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
  el('open-logs').addEventListener('click', function () { action(function () { return invokeOrThrow('open_logs') }) })
  el('quit').addEventListener('click', function () { action(function () { return invokeOrThrow('quit_app') }) })
  var onSystemThemeChanged = function () {
    if (!state || (state.theme || 'system') === 'system') applyTheme('system')
  }
  if (systemThemeMedia.addEventListener) systemThemeMedia.addEventListener('change', onSystemThemeChanged)
  else if (systemThemeMedia.addListener) systemThemeMedia.addListener(onSystemThemeChanged)
  refresh()
  poller = window.setInterval(refresh, 1500)
  window.addEventListener('beforeunload', function () { if (poller) window.clearInterval(poller) })
})()
