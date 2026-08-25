// 高德地图插件浏览器半。它只消费 amap_present_map 的结构化结果和 Host
// 状态，不扫描聊天文本，也不直接调用高德 Web 服务接口。
window.__ModuleLoader__.load({
  id: '@p-dsh-market/amap-map-assistant',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var PLUGIN_ID = '@p-dsh-market/amap-map-assistant'
    var BASE_PATH = '/amap-map'
    var TOOL_NAME = 'amap_present_map'
    var DESKTOP_RPC_METHOD = 'amapMapAssistant.openSettings'
    var loaderPromise = null
    var stateRequests = {}
    var mapStore = {
      version: 0,
      overlayOpen: false,
      settingsOpen: false,
      activeSessionId: null,
      activePresentationId: null,
      bySession: {},
      settings: { loading: false, saving: false, error: '', jsApiConfigured: false, securityJsCodeConfigured: false, jsApiReady: false }
    }
    var storeListeners = []

    function finite(value) {
      return typeof value === 'number' && isFinite(value) ? value : null
    }

    function sessionIdFromSnapshot(snapshot) {
      var value = snapshot && (snapshot.current || snapshot.currentId || snapshot.sessionId)
      if (value && typeof value === 'object') value = value.id
      return String(value || '').trim()
    }

    function resolveSessionId(props) {
      var value = props && (props.sessionId || props.id || (props.session && props.session.id))
      value = String(value || '').trim()
      return value && value !== 'active' ? value : null
    }

    function useCurrentSessionId(sessions) {
      var source = sessions && sessions.list
      var pair = React.useState(function () { return source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null })
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      React.useEffect(function () {
        if (!source || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') {
          setSnapshot(null)
          return undefined
        }
        function update() { setSnapshot(source.getSnapshot()) }
        update()
        return source.subscribe(update)
      }, [source])
      return sessionIdFromSnapshot(snapshot)
    }

    function recordFor(sessionId) {
      var id = sessionId || '__unknown__'
      if (!mapStore.bySession[id]) mapStore.bySession[id] = { current: null, latest: null, loading: false, error: '' }
      return mapStore.bySession[id]
    }

    function notify() {
      mapStore.version += 1
      var snapshot = Object.assign({}, mapStore)
      storeListeners.slice().forEach(function (listener) { listener(snapshot) })
    }

    function useMapStore() {
      var pair = React.useState(mapStore.version)
      React.useEffect(function () {
        function update() { pair[1](function (value) { return value + 1 }) }
        storeListeners.push(update)
        return function () { storeListeners = storeListeners.filter(function (item) { return item !== update }) }
      }, [])
      return mapStore
    }

    function setPresentation(sessionId, presentation) {
      if (!sessionId || !presentation) return
      var record = recordFor(sessionId)
      record.latest = presentation
      record.current = presentation
      record.loading = false
      record.error = ''
      notify()
    }

    function openPanel(sessionId, presentation) {
      var record = recordFor(sessionId)
      var selected = presentation || record.current || record.latest
      mapStore.overlayOpen = true
      mapStore.settingsOpen = false
      mapStore.activeSessionId = sessionId || null
      mapStore.activePresentationId = selected && selected.id ? selected.id : null
      if (selected) record.current = selected
      else if (sessionId) loadState(sessionId)
      notify()
    }

    function closePanel() {
      mapStore.overlayOpen = false
      mapStore.settingsOpen = false
      mapStore.activePresentationId = null
      notify()
    }

    function openSettings() {
      mapStore.overlayOpen = false
      mapStore.settingsOpen = true
      mapStore.settings.error = ''
      notify()
      loadSettings()
    }

    function loadSettings() {
      if (mapStore.settings.loading || mapStore.settings.saving) return
      mapStore.settings.loading = true
      mapStore.settings.error = ''
      notify()
      fetch(BASE_PATH + '/settings', { cache: 'no-store' })
        .then(function (response) { return response.json().then(function (body) { if (!response.ok || body.ok === false) throw new Error(body.error || '地图设置读取失败。'); return body.settings || {} }) })
        .then(function (settings) {
          mapStore.settings = Object.assign({}, mapStore.settings, settings, { loading: false, error: '' })
          notify()
        })
        .catch(function (error) {
          mapStore.settings.loading = false
          mapStore.settings.error = error && error.message ? error.message : String(error)
          notify()
        })
    }

    function saveSettings(patch) {
      if (mapStore.settings.saving) return Promise.reject(new Error('地图设置正在保存。'))
      mapStore.settings.saving = true
      mapStore.settings.error = ''
      notify()
      return fetch(BASE_PATH + '/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch || {})
      })
        .then(function (response) { return response.json().then(function (body) { if (!response.ok || body.ok === false) throw new Error(body.error || '地图设置保存失败。'); return body.settings || {} }) })
        .then(function (settings) {
          mapStore.settings = Object.assign({}, mapStore.settings, settings, { saving: false, error: '' })
          notify()
          return settings
        })
        .catch(function (error) {
          mapStore.settings.saving = false
          mapStore.settings.error = error && error.message ? error.message : String(error)
          notify()
          throw error
        })
    }

    function loadState(sessionId) {
      if (!sessionId || stateRequests[sessionId]) return
      var record = recordFor(sessionId)
      if (record.current || record.loading) return
      record.loading = true
      record.error = ''
      notify()
      var request = fetch(BASE_PATH + '/state?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
        .then(function (response) { return response.json().then(function (body) { if (!response.ok || body.ok === false) throw new Error(body.error || '地图状态读取失败。'); return body }) })
        .then(function (body) {
          var current = recordFor(sessionId)
          current.loading = false
          if (body.state) {
            current.current = body.state
            current.latest = body.state
          }
          notify()
        })
        .catch(function (error) {
          var current = recordFor(sessionId)
          current.loading = false
          current.error = error && error.message ? error.message : String(error)
          notify()
        })
        .finally(function () { delete stateRequests[sessionId] })
      stateRequests[sessionId] = request
    }

    function metadataFromBlock(block) {
      var candidates = [
        block && block.meta,
        block && block.presentationMeta,
        block && block.resultView && block.resultView.meta,
        block && block.result,
        block && block.value
      ]
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index]
        if (!candidate || typeof candidate !== 'object') continue
        if (candidate.presentation && typeof candidate.presentation === 'object') candidate = candidate.presentation
        if (candidate.presentationMeta && typeof candidate.presentationMeta === 'object' && candidate.presentationMeta.presentation) candidate = candidate.presentationMeta.presentation
        if (candidate.schemaVersion === 1 && candidate.scene && candidate.title && candidate.sourceTools) return candidate
      }
      return null
    }

    function presentationPlaces(presentation) {
      if (presentation && Array.isArray(presentation.places)) return presentation.places
      if (presentation && presentation.scene === 'route') return [presentation.origin, ...(presentation.waypoints || []), presentation.destination].filter(Boolean)
      return presentation && presentation.destination ? [presentation.destination] : []
    }

    function formatNumber(value, digits) {
      var number = finite(value)
      return number === null ? '—' : number.toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 1 : digits })
    }

    function modeLabel(mode) {
      return mode === 'driving' ? '驾车' : mode === 'transit' ? '公交 / 地铁' : mode === 'walking' ? '步行' : mode === 'bicycling' ? '骑行' : '地点'
    }

    function summaryLines(presentation) {
      var summary = presentation && presentation.summary || {}
      var lines = []
      if (summary.distanceMeters !== undefined) lines.push('距离 ' + formatNumber(summary.distanceMeters / 1000, 2) + ' 公里')
      if (summary.durationSeconds !== undefined) lines.push('预计 ' + formatNumber(summary.durationSeconds / 60, 0) + ' 分钟')
      if (summary.costCny !== undefined) lines.push('费用 ¥' + formatNumber(summary.costCny, 2))
      if (summary.walkingDistanceMeters !== undefined) lines.push('步行 ' + formatNumber(summary.walkingDistanceMeters, 0) + ' 米')
      if (summary.transfers !== undefined) lines.push('换乘 ' + formatNumber(summary.transfers, 0) + ' 次')
      return lines
    }

    function loadAmap(bootstrap) {
      if (loaderPromise) return loaderPromise
      var serviceHost = new URL(bootstrap.serviceHost || '/_AMapService', window.location.origin).toString()
      window._AMapSecurityConfig = { serviceHost: serviceHost }
      loaderPromise = new Promise(function (resolve, reject) {
        function useLoader() {
          if (!window.AMapLoader || typeof window.AMapLoader.load !== 'function') return reject(new Error('高德 JS API Loader 未提供 AMapLoader.load。'))
          window.AMapLoader.load({
            key: bootstrap.jsApiKey,
            version: '2.0',
            plugins: ['AMap.Scale', 'AMap.ToolBar', 'AMap.Driving', 'AMap.Transfer', 'AMap.Walking', 'AMap.Riding']
          }).then(resolve).catch(reject)
        }
        if (window.AMapLoader && typeof window.AMapLoader.load === 'function') return useLoader()
        var script = document.querySelector('script[data-dsh-amap-loader="true"]')
        if (!script) {
          script = document.createElement('script')
          script.src = 'https://webapi.amap.com/loader.js'
          script.async = true
          script.dataset.dshAmapLoader = 'true'
          script.onload = useLoader
          script.onerror = function () { reject(new Error('高德 JS API Loader 加载失败。')) }
          document.head.appendChild(script)
        } else {
          script.addEventListener('load', useLoader, { once: true })
          script.addEventListener('error', function () { reject(new Error('高德 JS API Loader 加载失败。')) }, { once: true })
        }
      }).catch(function (error) {
        loaderPromise = null
        throw error
      })
      return loaderPromise
    }

    function addPointMarkers(AMap, map, presentation) {
      var points = presentationPlaces(presentation)
      var markers = points.map(function (place, index) {
        var marker = new AMap.Marker({ position: [place.location.longitude, place.location.latitude], title: place.name })
        if (typeof marker.setLabel === 'function') marker.setLabel({ content: String(index + 1) + ' · ' + place.name, direction: 'top' })
        return marker
      })
      if (markers.length) {
        map.add(markers)
        if (typeof map.setFitView === 'function') map.setFitView(markers, false, [50, 50, 50, 50])
      }
      return markers
    }

    function routePositions(presentation) {
      return presentationPlaces(presentation).map(function (place) { return [place.location.longitude, place.location.latitude] })
    }

    function drawOrderedConnection(AMap, map, presentation, showDirection) {
      var positions = routePositions(presentation)
      if (positions.length < 2 || typeof AMap.Polyline !== 'function') return false
      var line = new AMap.Polyline({
        path: positions,
        isOutline: true,
        outlineColor: '#ffffff',
        borderWeight: 2,
        strokeWeight: 5,
        strokeColor: '#1677ff',
        strokeOpacity: 0.78,
        lineJoin: 'round',
        showDir: showDirection === true
      })
      map.add(line)
      return true
    }

    function searchRouteSegment(AMap, map, className, start, end, options, callback) {
      if (!className || typeof AMap[className] !== 'function') return callback('error')
      var service = new AMap[className]({ map: map, hideMarkers: true, autoFitView: false })
      try {
        if (className === 'Driving') service.search(start, end, options || {}, callback)
        else service.search(start, end, callback)
      } catch (error) {
        callback('error', error)
      }
    }

    function previewRoute(AMap, map, presentation, setNote) {
      if (!presentation) return
      var positions = routePositions(presentation)
      if (presentation.scene === 'places') {
        if (positions.length > 1 && drawOrderedConnection(AMap, map, presentation, false)) setNote('已按查询结果顺序连接地点；这不是路线规划结果。')
        return
      }
      if (presentation.scene !== 'route' || positions.length < 2) return
      var classes = { driving: 'Driving', transit: 'Transfer', walking: 'Walking', bicycling: 'Riding' }
      var className = classes[presentation.mode]
      if (!className || typeof AMap[className] !== 'function') {
        drawOrderedConnection(AMap, map, presentation, true)
        setNote('当前出行方式没有可用的地图路线服务，已按地点顺序绘制连线。')
        return
      }

      if (positions.length > 2 && className !== 'Driving') {
        var failures = 0
        var nextSegment = function (index) {
          if (index >= positions.length - 1) {
            if (failures > 0) {
              drawOrderedConnection(AMap, map, presentation, true)
              setNote('部分分段路线预览失败，已保留全部地点的有序连线；文字距离与时间仍以本次 MCP 查询结果为准。')
            } else {
              setNote('已按地点顺序绘制分段路线；文字距离与时间仍以本次 MCP 查询结果为准。')
            }
            return
          }
          searchRouteSegment(AMap, map, className, positions[index], positions[index + 1], undefined, function (status) {
            if (status !== 'complete') failures += 1
            nextSegment(index + 1)
          })
        }
        nextSegment(0)
        return
      }

      var options = className === 'Driving' && positions.length > 2
        ? { waypoints: positions.slice(1, -1) }
        : undefined
      searchRouteSegment(AMap, map, className, positions[0], positions[positions.length - 1], options, function (status) {
        if (status !== 'complete') {
          drawOrderedConnection(AMap, map, presentation, true)
          setNote('地图线路预览加载失败，已按地点顺序保留连线；文字距离与时间仍以本次 MCP 查询结果为准。')
        } else {
          setNote(positions.length > 2 ? '已按顺序绘制包含途经点的驾车路线；文字距离与时间仍以本次 MCP 查询结果为准。' : '地图线路为同一组起终点的可视化预览；文字距离与时间以本次 MCP 查询结果为准。')
        }
      })
    }

    function MapCanvas(props) {
      var container = React.useRef(null)
      var statePair = React.useState({ loading: true, error: '', note: '' })
      var status = statePair[0]
      var setStatus = statePair[1]
      var presentation = props.presentation
      React.useEffect(function () {
        var disposed = false
        var map = null
        var markers = []
        fetch(BASE_PATH + '/bootstrap', { cache: 'no-store' })
          .then(function (response) { return response.json().then(function (body) { if (!response.ok || body.ok === false) throw new Error(body.error || '地图配置读取失败。'); return body }) })
          .then(function (bootstrap) {
            if (!bootstrap.jsApiReady || !bootstrap.jsApiKey) throw new Error('未配置完整的 Web JS API Key 与 securityJsCode。')
            return loadAmap(bootstrap)
          })
          .then(function (AMap) {
            if (disposed || !container.current) return
            map = new AMap.Map(container.current, { viewMode: '2D', zoom: 12, resizeEnable: true })
            markers = addPointMarkers(AMap, map, presentation)
            previewRoute(AMap, map, presentation, function (note) { if (!disposed) setStatus({ loading: false, error: '', note: note }) })
            if (!disposed) setStatus({ loading: false, error: '', note: '' })
          })
          .catch(function (error) { if (!disposed) setStatus({ loading: false, error: error && error.message ? error.message : String(error), note: '' }) })
        return function () {
          disposed = true
          markers = []
          if (map && typeof map.destroy === 'function') map.destroy()
          map = null
        }
      }, [presentation && presentation.id])
      return React.createElement('div', { className: 'amap-map-stack' }, [
        React.createElement('div', { key: 'canvas', className: 'amap-canvas', ref: container, 'aria-label': '高德地图画布' }),
        status.loading ? React.createElement('div', { key: 'loading', className: 'amap-map-message' }, '正在加载高德在线地图…') : null,
        status.error ? React.createElement('div', { key: 'error', className: 'amap-map-message amap-error' }, status.error) : null,
        status.note ? React.createElement('p', { key: 'note', className: 'amap-map-note' }, status.note) : null
      ])
    }

    function PlaceList(props) {
      var places = presentationPlaces(props.presentation)
      if (!places.length) return null
      return React.createElement('ol', { className: 'amap-place-list' }, places.map(function (place, index) {
        return React.createElement('li', { key: (place.id || place.name) + '-' + index }, [
          React.createElement('strong', { key: 'name' }, String(index + 1) + '. ' + place.name),
          place.address ? React.createElement('span', { key: 'address' }, place.address) : null,
          React.createElement('small', { key: 'location' }, place.location.longitude.toFixed(6) + ', ' + place.location.latitude.toFixed(6))
        ])
      }))
    }

    function PresentationFacts(props) {
      var presentation = props.presentation
      var facts = summaryLines(presentation)
      return React.createElement('div', { className: 'amap-facts' }, [
        React.createElement('span', { key: 'mode', className: 'amap-mode-pill' }, presentation.scene === 'route' ? modeLabel(presentation.mode) : presentation.scene === 'places' ? 'POI 搜索' : '地点'),
        facts.map(function (fact, index) { return React.createElement('span', { key: 'fact-' + index }, fact) }),
        React.createElement('span', { key: 'source' }, '来源：高德地图 MCP')
      ])
    }

    function PresentationBody(props) {
      var presentation = props.presentation
      return React.createElement('div', { className: 'amap-presentation-body' }, [
        React.createElement(PresentationFacts, { key: 'facts', presentation: presentation }),
        presentation.scene === 'route' ? React.createElement('div', { key: 'route', className: 'amap-route-pair' }, [
          React.createElement('strong', { key: 'origin' }, presentation.origin.name),
          React.createElement('span', { key: 'arrow' }, ' → '),
          React.createElement('strong', { key: 'destination' }, presentation.destination.name)
        ]) : null,
        React.createElement(PlaceList, { key: 'places', presentation: presentation }),
        presentation.summary && Array.isArray(presentation.summary.instructions) ? React.createElement('ol', { key: 'instructions', className: 'amap-instructions' }, presentation.summary.instructions.slice(0, 80).map(function (item, index) { return React.createElement('li', { key: index }, item) })) : null
      ])
    }

    function useCurrentPresentation(sessionId) {
      useMapStore()
      var record = recordFor(sessionId)
      React.useEffect(function () { loadState(sessionId) }, [sessionId])
      return record.current || record.latest
    }

    function EmptyState(props) {
      return React.createElement('div', { className: 'amap-empty' }, [
        React.createElement('div', { key: 'icon', className: 'amap-empty-icon' }, '⌖'),
        React.createElement('h2', { key: 'title' }, props.title),
        React.createElement('p', { key: 'copy' }, props.copy),
        props.action ? React.createElement('div', { key: 'action', className: 'amap-empty-action' }, props.action) : null
      ])
    }

    function AmapConversationView(props) {
      var sessions = props.sessions || props.sessionService
      var fallbackSessionId = useCurrentSessionId(sessions)
      var sessionId = resolveSessionId(props) || fallbackSessionId
      var record = recordFor(sessionId)
      var presentation = useCurrentPresentation(sessionId)
      if (!sessionId) return React.createElement(EmptyState, { title: '请先打开一个已有对话', copy: '地图视图需要绑定到当前 DSH 会话。' })
      if (record.loading && !presentation) return React.createElement(EmptyState, { title: '正在读取当前地图状态…', copy: '只读取地图插件保存的当前状态，不扫描普通回答文本。' })
      if (record.error && !presentation) return React.createElement(EmptyState, { title: '地图状态读取失败', copy: record.error })
      if (!presentation) return React.createElement(EmptyState, { title: '当前对话还没有地图结果', copy: '你可以在对话中搜索地点、查询周边或规划路线；模型完成高德查询后会生成一张地图卡片。' })
      return React.createElement('div', { className: 'amap-page' }, [
        React.createElement('header', { key: 'header', className: 'amap-page-header' }, [
          React.createElement('div', { key: 'title' }, [
            React.createElement('h2', { key: 'h' }, '地图 · 当前会话'),
            React.createElement('p', { key: 'p' }, presentation.title)
          ]),
          React.createElement('button', { key: 'open', type: 'button', className: 'amap-secondary-button', onClick: function () { openPanel(sessionId, presentation) } }, '打开右侧地图')
        ]),
        React.createElement(MapLayout, { key: 'layout', presentation: presentation })
      ])
    }

    function AmapSettingsPanel() {
      useMapStore()
      var keyPair = React.useState('')
      var securityPair = React.useState('')
      var jsApiKey = keyPair[0]
      var setJsApiKey = keyPair[1]
      var securityJsCode = securityPair[0]
      var setSecurityJsCode = securityPair[1]
      var settings = mapStore.settings
      React.useEffect(function () { loadSettings() }, [])

      function submit(event) {
        event.preventDefault()
        saveSettings({
          jsApiKey: jsApiKey.trim() || undefined,
          securityJsCode: securityJsCode.trim() || undefined
        }).then(function () {
          setJsApiKey('')
          setSecurityJsCode('')
        }).catch(function () {})
      }

      function clear(name) {
        saveSettings(name === 'jsApiKey' ? { clearJsApiKey: true } : { clearSecurityJsCode: true })
          .then(function () {
            if (name === 'jsApiKey') setJsApiKey('')
            else setSecurityJsCode('')
          }).catch(function () {})
      }

      return React.createElement('div', { className: 'amap-settings' }, [
        React.createElement('header', { key: 'header', className: 'amap-settings-header' }, [
          React.createElement('div', { key: 'title' }, [
            React.createElement('strong', { key: 'strong' }, '高德地图设置'),
            React.createElement('span', { key: 'span' }, 'JS API 凭据只用于在线地图加载与安全代理')
          ]),
          React.createElement('button', { key: 'close', type: 'button', className: 'amap-close-button', onClick: closePanel, 'aria-label': '关闭高德地图设置' }, '×')
        ]),
        React.createElement('form', { key: 'form', className: 'amap-settings-form', onSubmit: submit }, [
          React.createElement('p', { key: 'intro', className: 'amap-settings-copy' }, 'Web Service Key 仍由 Desktop MCP 管理；这里单独填写 Web JS API Key 和 securityJsCode，不会互相复制。'),
          React.createElement('label', { key: 'key-label', htmlFor: 'amap-plugin-js-api-key' }, 'Web JS API Key'),
          React.createElement('div', { key: 'key-row', className: 'amap-settings-input-row' }, [
            React.createElement('input', { id: 'amap-plugin-js-api-key', type: 'password', value: jsApiKey, maxLength: 512, autoComplete: 'new-password', placeholder: settings.jsApiConfigured ? '已配置；留空保留当前 Key' : '填写 Web JS API Key', onChange: function (event) { setJsApiKey(event.target.value) } }),
            React.createElement('button', { type: 'button', className: 'amap-secondary-button', disabled: settings.saving || !settings.jsApiConfigured, onClick: function () { clear('jsApiKey') } }, '清除')
          ]),
          React.createElement('label', { key: 'security-label', htmlFor: 'amap-plugin-security-code' }, 'securityJsCode'),
          React.createElement('div', { key: 'security-row', className: 'amap-settings-input-row' }, [
            React.createElement('input', { id: 'amap-plugin-security-code', type: 'password', value: securityJsCode, maxLength: 512, autoComplete: 'new-password', placeholder: settings.securityJsCodeConfigured ? '已配置；留空保留当前密钥' : '填写 securityJsCode', onChange: function (event) { setSecurityJsCode(event.target.value) } }),
            React.createElement('button', { type: 'button', className: 'amap-secondary-button', disabled: settings.saving || !settings.securityJsCodeConfigured, onClick: function () { clear('securityJsCode') } }, '清除')
          ]),
          React.createElement('div', { key: 'status', className: 'amap-settings-status ' + (settings.jsApiReady ? 'good' : '') }, settings.loading ? '正在读取设置…' : settings.jsApiReady ? '地图脚本配置完整，可以加载在线地图。' : '两项凭据都配置后，地图画布才会启用；未配置时仍可查看 MCP 文本结果。'),
          settings.error ? React.createElement('p', { key: 'error', className: 'amap-settings-error' }, settings.error) : null,
          React.createElement('div', { key: 'actions', className: 'amap-settings-actions' }, [
            React.createElement('button', { key: 'save', type: 'submit', className: 'amap-primary-button', disabled: settings.loading || settings.saving }, settings.saving ? '正在保存…' : '保存设置'),
            React.createElement('button', { key: 'refresh', type: 'button', className: 'amap-secondary-button', disabled: settings.loading || settings.saving, onClick: loadSettings }, '刷新状态')
          ])
        ])
      ])
    }

    function MapLayout(props) {
      var presentation = props.presentation
      return React.createElement('div', { className: 'amap-layout' }, [
        React.createElement('div', { key: 'map', className: 'amap-map-column' }, React.createElement(MapCanvas, { presentation: presentation })),
        React.createElement('aside', { key: 'detail', className: 'amap-detail-column' }, [
          React.createElement('h3', { key: 'title' }, presentation.title),
          React.createElement(PresentationBody, { key: 'body', presentation: presentation }),
          React.createElement('p', { key: 'meta', className: 'amap-meta' }, '查询时间：' + (presentation.fetchedAt || '—') + ' · revision ' + (presentation.revision || 0))
        ])
      ])
    }

    function AmapToolView(props) {
      var sessions = props.sessions
      var fallbackSessionId = useCurrentSessionId(sessions)
      var sessionId = resolveSessionId(props) || fallbackSessionId
      var block = props.block || props.value || {}
      var presentation = metadataFromBlock(block)
      React.useEffect(function () {
        if (presentation && sessionId) setPresentation(sessionId, presentation)
      }, [sessionId, presentation && presentation.id])
      if (block.isError === true || block.status === 'error') return React.createElement('div', { className: 'amap-tool amap-tool-error' }, '高德地图展示工具返回错误，未打开空地图。')
      if (!presentation) return React.createElement('div', { className: 'amap-tool amap-tool-running' }, '正在准备地图展示…')
      return React.createElement('div', { className: 'amap-tool' }, [
        React.createElement('div', { key: 'head', className: 'amap-tool-head' }, [React.createElement('strong', { key: 'title' }, presentation.title), React.createElement('span', { key: 'scene' }, presentation.scene === 'route' ? modeLabel(presentation.mode) : '高德地图')]),
        React.createElement(PresentationBody, { key: 'body', presentation: presentation }),
        React.createElement('button', { key: 'open', type: 'button', className: 'amap-primary-button', onClick: function () { openPanel(sessionId, presentation) } }, '在地图中查看')
      ])
    }

    function AmapOverlay(props) {
      useMapStore()
      if (!mapStore.overlayOpen && !mapStore.settingsOpen) return null
      if (mapStore.settingsOpen) return React.createElement('div', { className: 'amap-overlay', role: 'dialog', 'aria-label': '高德地图设置' }, React.createElement('section', { className: 'amap-overlay-panel amap-settings-panel' }, React.createElement(AmapSettingsPanel)))
      var record = recordFor(mapStore.activeSessionId)
      var presentation = record.current || record.latest
      return React.createElement('div', { className: 'amap-overlay', role: 'dialog', 'aria-label': '高德地图' }, React.createElement('section', { className: 'amap-overlay-panel' }, [
        React.createElement('header', { key: 'header', className: 'amap-overlay-header' }, [
          React.createElement('div', { key: 'title' }, [React.createElement('strong', { key: 'strong' }, '高德地图'), React.createElement('span', { key: 'span' }, presentation ? presentation.title : '当前会话')]),
          React.createElement('button', { key: 'close', type: 'button', className: 'amap-close-button', onClick: closePanel, 'aria-label': '关闭地图面板' }, '×')
        ]),
        presentation ? React.createElement(MapLayout, { key: 'body', presentation: presentation }) : React.createElement(EmptyState, { key: 'empty', title: '当前没有地图结果', copy: '完成一次高德地图查询后，再从地图卡片打开此面板。' })
      ]))
    }

    function AmapSidebarAction(props) {
      var sessions = props.sessions || props.sessionService
      var fallbackSessionId = useCurrentSessionId(sessions)
      var sessionId = resolveSessionId(props) || fallbackSessionId
      return React.createElement('button', {
        type: 'button',
        className: 'amap-sidebar-action',
        disabled: !sessionId,
        onClick: function () { if (sessionId) openPanel(sessionId, null) },
        title: sessionId ? '打开当前会话地图' : '打开一个会话后使用地图',
        'aria-label': sessionId ? '打开当前会话地图' : '请先打开一个会话'
      }, [
        React.createElement('span', { key: 'icon', className: 'amap-sidebar-icon', 'aria-hidden': 'true' }, '⌖'),
        React.createElement('span', { key: 'label' }, '地图')
      ])
    }

    var CSS = '' +
      '.amap-page,.amap-tool,.amap-overlay,.amap-empty{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}' +
      '.amap-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}.amap-page-header,.amap-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}.amap-page-header h2{margin:0;font-size:16px}.amap-page-header p,.amap-overlay-header span,.amap-meta{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.amap-secondary-button,.amap-primary-button,.amap-close-button,.amap-header-action{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;text-decoration:none}.amap-primary-button{display:inline-flex;border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}.amap-secondary-button:hover,.amap-header-action:hover,.amap-close-button:hover{background:var(--dsw-alias-interactive-bg-hover)}.amap-primary-button:hover{filter:brightness(1.08)}.amap-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;min-height:0;flex:1}.amap-map-column{position:relative;min-width:0;min-height:360px;padding:14px;background:var(--dsw-alias-bg-base)}.amap-detail-column{min-width:0;min-height:0;overflow:auto;padding:16px;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}.amap-detail-column h3{margin:0 0 12px;font-size:15px;line-height:1.45}.amap-map-stack{position:relative;width:100%;height:100%;min-height:330px}.amap-canvas{width:100%;height:100%;min-height:330px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}.amap-map-message{position:absolute;left:12px;right:12px;top:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;box-shadow:0 4px 18px #0003}.amap-error,.amap-tool-error{color:var(--dsw-alias-state-error-primary)}.amap-map-note{margin:7px 0 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}.amap-presentation-body{display:grid;gap:11px}.amap-facts{display:flex;flex-wrap:wrap;gap:6px}.amap-facts span,.amap-mode-pill{padding:4px 7px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-secondary);font-size:10px}.amap-mode-pill{color:var(--dsw-alias-state-business-primary)}.amap-route-pair{font-size:13px;line-height:1.7;overflow-wrap:anywhere}.amap-place-list,.amap-instructions{display:grid;gap:7px;margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.55}.amap-place-list li{padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;list-style-position:outside}.amap-place-list strong,.amap-place-list span,.amap-place-list small{display:block}.amap-place-list strong{color:var(--dsw-alias-label-primary);font-size:12px}.amap-place-list small{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;font-size:9px}.amap-meta{white-space:normal;line-height:1.5}.amap-empty{display:flex;align-items:center;justify-content:center;flex:1;min-height:280px;flex-direction:column;padding:28px;text-align:center}.amap-empty-icon{display:grid;place-items:center;width:44px;height:44px;margin-bottom:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;color:var(--dsw-alias-state-business-primary);font-size:23px}.amap-empty h2{margin:0 0 7px;font-size:16px}.amap-empty p{max-width:540px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}.amap-overlay{position:fixed;inset:0;z-index:100;display:flex;justify-content:flex-end;background:var(--dsw-alias-bg-mask-1)}.amap-overlay-panel{display:flex;width:520px;min-width:420px;max-width:75vw;height:100%;flex-direction:column;resize:horizontal;overflow:hidden;background:var(--dsw-alias-bg-base);box-shadow:-16px 0 42px var(--dsw-alias-bg-mask-2)}.amap-overlay-header strong,.amap-overlay-header span{display:block}.amap-overlay-header strong{font-size:14px}.amap-overlay-header span{max-width:390px}.amap-close-button{padding:2px 8px;font-size:21px;line-height:25px}.amap-overlay-panel .amap-layout{display:flex;flex:1;flex-direction:column;overflow:auto}.amap-overlay-panel .amap-map-column{flex:0 0 48%;min-height:300px}.amap-overlay-panel .amap-detail-column{border-top:1px solid var(--dsw-alias-border-l2);border-left:0}.amap-tool{margin:6px 0;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.amap-tool-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px}.amap-tool-head span{color:var(--dsw-alias-label-secondary)}.amap-tool .amap-place-list{max-height:180px;overflow:auto}.amap-tool-running{color:var(--dsw-alias-label-secondary);font-size:12px}@media(max-width:800px){.amap-layout{display:flex;flex-direction:column}.amap-detail-column{border-top:1px solid var(--dsw-alias-border-l2);border-left:0}.amap-page-header{align-items:flex-start;flex-direction:column}.amap-overlay-panel{width:100%;min-width:0;max-width:100%}}'

    CSS += '.amap-page-actions,.amap-header-actions{display:flex;align-items:center;gap:8px}.amap-settings{display:flex;min-height:100%;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.amap-settings-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}.amap-settings-header strong,.amap-settings-header span{display:block}.amap-settings-header strong{font-size:15px}.amap-settings-header span{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px}.amap-settings-form{display:grid;gap:9px;max-width:620px;padding:20px}.amap-settings-form label{font-size:12px;color:var(--dsw-alias-label-secondary)}.amap-settings-copy{margin:0 0 5px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}.amap-settings-input-row{display:flex;gap:8px}.amap-settings-input-row input{min-width:0;flex:1;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}.amap-settings-input-row input:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.amap-settings-status{padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}.amap-settings-status.good{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.amap-settings-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:11px}.amap-settings-actions{display:flex;gap:8px;margin-top:5px}.amap-secondary-button:disabled,.amap-primary-button:disabled{cursor:not-allowed;opacity:.55}@media(max-width:800px){.amap-page-actions{flex-wrap:wrap}.amap-settings-form{padding:16px}.amap-settings-input-row{align-items:stretch;flex-direction:column}}'

    CSS += '.amap-sidebar-action{display:flex;align-items:center;justify-content:flex-start;width:100%;gap:8px;border:1px solid transparent;border-radius:8px;padding:7px 10px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;text-align:left}.amap-sidebar-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.amap-sidebar-action:disabled{cursor:not-allowed;opacity:.55}.amap-sidebar-icon{display:grid;place-items:center;width:18px;height:18px;border:1px solid currentColor;border-radius:6px;font-size:13px;line-height:1}'

    function apply(ctx) {
      var sessions = ctx.sessions || (ctx.get && ctx.get('sessions'))
      ctx.effect(function () {
        var style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      })
      ctx.effect(function () {
        function onDesktopMessage(event) {
          if (event.source !== window.parent) return
          var data = event.data
          if (!data || data.source !== 'dsh-desktop') return
          if (data.type === 'plugin-rpc' && data.pluginId === PLUGIN_ID && data.method === DESKTOP_RPC_METHOD) openSettings()
        }
        window.addEventListener('message', onDesktopMessage)
        return function () { window.removeEventListener('message', onDesktopMessage) }
      })
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({ name: 'conversation.view', id: 'amap-map-assistant', order: 40, label: '地图' }, function (props) {
          return React.createElement(AmapConversationView, Object.assign({}, props, { sessions: sessions }))
        })
      })
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({ name: 'sidebar.footer.action', id: 'amap-map-assistant', order: 90, label: '地图' }, function (props) {
          return React.createElement(AmapSidebarAction, Object.assign({}, props, { sessions: sessions }))
        })
      })
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, function (props) {
          return React.createElement(AmapToolView, Object.assign({}, props, { sessions: sessions }))
        })
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'amap-map-assistant-panel', order: 130, label: '高德地图' }, function () {
          return React.createElement(AmapOverlay, { sessions: sessions })
        })
      })
    }

    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    exports.resolveSessionId = resolveSessionId
    exports.metadataFromBlock = metadataFromBlock
    return module.exports
  }
})
