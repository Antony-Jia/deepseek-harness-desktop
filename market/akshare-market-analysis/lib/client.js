// AKShare market analysis — browser half.
// The UI only consumes persisted presentationMeta from tool results. It never
// calls AKShare directly and never rebuilds a transcript or session map.
window.__ModuleLoader__.load({
  id: '@p-dsh-market/akshare-market-analysis',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var PLUGIN_ID = '@p-dsh-market/akshare-market-analysis'
    var SNAPSHOT_TOOL = 'akshare_market_snapshot'
    var HISTORY_TOOL = 'akshare_stock_history'
    var ANALYSIS_TOOL = 'akshare_technical_analysis'
    var inject = ['slots', 'sessions']
    var WIDTH_KEY = 'dsh-akshare-market-analysis:panel'

    function clamp(value, minimum, maximum) {
      return Math.max(minimum, Math.min(maximum, value))
    }

    function finite(value) {
      return typeof value === 'number' && isFinite(value) ? value : null
    }

    function loadWidth() {
      try {
        var value = JSON.parse(window.localStorage.getItem(WIDTH_KEY) || '{}')
        return clamp(finite(value.width) || 560, 430, 980)
      } catch (_) { return 560 }
    }

    var store = {
      open: false,
      width: loadWidth(),
      activeSessionId: null,
      activeAnalysisId: null,
      pendingNew: false,
      bySession: {}
    }
    var listeners = []

    function announceDesktop(type, payload) {
      if (window.parent === window) return
      window.parent.postMessage(Object.assign({ source: PLUGIN_ID, type: type }, payload || {}), '*')
    }

    function notify() {
      // React ignores state updates that reuse the same object identity. The
      // store is intentionally mutated in place, so publish a fresh snapshot
      // for every panel/open/resize change.
      var snapshot = Object.assign({}, store)
      listeners.slice().forEach(function (listener) { listener(snapshot) })
      announceDesktop('analysis-panel-state', {
        open: snapshot.open,
        sessionId: snapshot.activeSessionId,
        analysisId: snapshot.activeAnalysisId,
        pendingNew: snapshot.pendingNew
      })
    }

    function subscribe(listener) {
      listeners.push(listener)
      return function () { listeners = listeners.filter(function (item) { return item !== listener }) }
    }

    function usePanelState() {
      var pair = React.useState(store)
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      React.useEffect(function () { return subscribe(function (next) { setSnapshot(next) }) }, [])
      return snapshot
    }

    function sessionIdFromSnapshot(snapshot) {
      if (!snapshot) return '__unknown__'
      var current = snapshot.current || snapshot.currentId
      if (typeof current === 'string' && current) return current
      if (current && typeof current === 'object' && current.id) return String(current.id)
      return '__unknown__'
    }

    function useCurrentSessionId(sessions) {
      var source = sessions && sessions.list
      var pair = React.useState(function () {
        return source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null
      })
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

    function metadataOf(block) {
      var candidates = [block && block.meta, block && block.presentationMeta, block && block.resultView && block.resultView.meta]
      for (var index = 0; index < candidates.length; index++) {
        var candidate = candidates[index]
        if (!candidate || typeof candidate !== 'object') continue
        if (candidate.presentationMeta && typeof candidate.presentationMeta === 'object') candidate = candidate.presentationMeta
        if (candidate.schemaVersion === 1 && (candidate.kind === 'snapshot' || candidate.kind === 'history' || candidate.kind === 'analysis')) return candidate
      }
      return null
    }

    function metadataId(meta) {
      if (!meta) return ''
      if (meta.analysisId) return String(meta.analysisId)
      try { return JSON.stringify([meta.kind, meta.symbol, meta.fetchedAt, meta.rows, meta.bars]) } catch (_) { return '' }
    }

    function recordFor(sessionId) {
      var key = sessionId || '__unknown__'
      if (!store.bySession[key]) store.bySession[key] = { latest: null, active: null }
      return store.bySession[key]
    }

    function registerMetadata(sessionId, meta) {
      var id = sessionId || '__unknown__'
      var record = recordFor(id)
      var nextId = metadataId(meta)
      var oldId = metadataId(record.latest)
      record.latest = meta
      if (!record.active) record.active = meta
      if (store.open && store.activeSessionId === id && oldId && nextId && oldId !== nextId) store.pendingNew = true
      notify()
    }

    function openPanel(sessionId, meta) {
      var record = recordFor(sessionId)
      var selected = meta || record.latest || record.active || null
      record.active = selected
      store.open = true
      store.activeSessionId = sessionId || '__unknown__'
      store.activeAnalysisId = metadataId(selected)
      store.pendingNew = false
      notify()
    }

    function closePanel() {
      store.open = false
      store.pendingNew = false
      notify()
    }

    function togglePanel(sessionId) {
      if (store.open && store.activeSessionId === (sessionId || '__unknown__')) closePanel()
      else openPanel(sessionId, null)
    }

    function selectLatest(sessionId) {
      var record = recordFor(sessionId)
      if (!record.latest) return
      record.active = record.latest
      store.activeAnalysisId = metadataId(record.latest)
      store.pendingNew = false
      notify()
    }

    function formatNumber(value, digits) {
      var number = finite(value)
      return number === null ? '—' : number.toLocaleString('zh-CN', { maximumFractionDigits: digits == null ? 4 : digits })
    }

    function formatDate(value) {
      if (!value) return '—'
      var raw = String(value)
      return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6) : raw
    }

    function snapshotRows(meta) {
      return Array.isArray(meta && meta.rows) ? meta.rows : []
    }

    function SnapshotTable(props) {
      var rows = snapshotRows(props.meta)
      if (!rows.length) return React.createElement('div', { className: 'aka-empty' }, '没有匹配的行情记录。')
      return React.createElement('div', { className: 'aka-table-wrap' }, React.createElement('table', { className: 'aka-table' }, [
        React.createElement('thead', { key: 'head' }, React.createElement('tr', null, [
          React.createElement('th', { key: 'symbol' }, '代码'),
          React.createElement('th', { key: 'name' }, '名称'),
          React.createElement('th', { key: 'price' }, '价格'),
          React.createElement('th', { key: 'change' }, '涨跌幅'),
          React.createElement('th', { key: 'amount' }, '成交额')
        ])),
        React.createElement('tbody', { key: 'body' }, rows.slice(0, 100).map(function (row, index) {
          var change = finite(row.changePct)
          return React.createElement('tr', { key: String(row.symbol || index) }, [
            React.createElement('td', { key: 'symbol', className: 'aka-mono' }, row.symbol || '—'),
            React.createElement('td', { key: 'name', title: row.name || '' }, row.name || '—'),
            React.createElement('td', { key: 'price', className: 'aka-number' }, formatNumber(row.price, 3)),
            React.createElement('td', { key: 'change', className: change === null ? '' : change >= 0 ? 'aka-up' : 'aka-down' }, change === null ? '—' : formatNumber(change, 2) + '%'),
            React.createElement('td', { key: 'amount', className: 'aka-number' }, formatNumber(row.amount, 0))
          ])
        }))
      ]))
    }

    function barValues(meta) {
      return Array.isArray(meta && meta.bars) ? meta.bars : []
    }

    function chartY(value, minimum, maximum, top, bottom) {
      if (maximum === minimum) return (top + bottom) / 2
      return top + (maximum - value) / (maximum - minimum) * (bottom - top)
    }

    function periodLabel(period) {
      return period === 'weekly' ? '周线' : period === 'monthly' ? '月线' : '日线'
    }

    function chartTitle(meta) {
      var identity = [meta.symbol, meta.name].filter(function (value) { return value }).join(' ')
      var kind = meta.kind === 'analysis' ? 'K线与技术分析' : '历史K线'
      return identity ? identity + ' · ' + kind : kind
    }

    function chartYAxisLabel(meta) {
      return '价格' + (meta.currency ? '（' + meta.currency + '）' : '')
    }

    function formatAxisNumber(value) {
      var number = finite(value)
      return number === null ? '—' : formatNumber(number, Math.abs(number) < 1 ? 4 : 2)
    }

    function CandleChart(props) {
      var meta = props.meta || {}
      var bars = barValues(meta).slice(-120)
      if (!bars.length) return React.createElement('div', { className: 'aka-empty' }, '历史数据为空。')
      var numbers = []
      bars.forEach(function (bar) { ;[bar[2], bar[3], bar[1], bar[4]].forEach(function (value) { if (finite(value) !== null) numbers.push(Number(value)) }) })
      var minimum = Math.min.apply(Math, numbers)
      var maximum = Math.max.apply(Math, numbers)
      var width = 760
      var height = 300
      var plotLeft = 58
      var plotRight = 14
      var plotTop = 28
      var plotBottom = height - 38
      var step = (width - plotLeft - plotRight) / Math.max(1, bars.length)
      var bodyWidth = Math.max(2, step * 0.58)
      var children = []
      bars.forEach(function (bar, index) {
        var open = finite(bar[1])
        var high = finite(bar[2])
        var low = finite(bar[3])
        var close = finite(bar[4])
        if (open === null || high === null || low === null || close === null) return
        var x = plotLeft + step * index + step / 2
        var color = close >= open ? 'var(--aka-up)' : 'var(--aka-down)'
        var yHigh = chartY(high, minimum, maximum, plotTop, plotBottom)
        var yLow = chartY(low, minimum, maximum, plotTop, plotBottom)
        var yOpen = chartY(open, minimum, maximum, plotTop, plotBottom)
        var yClose = chartY(close, minimum, maximum, plotTop, plotBottom)
        children.push(React.createElement('line', { key: 'wick-' + index, x1: x, x2: x, y1: yHigh, y2: yLow, stroke: color, strokeWidth: 1 }))
        children.push(React.createElement('rect', { key: 'body-' + index, x: x - bodyWidth / 2, y: Math.min(yOpen, yClose), width: bodyWidth, height: Math.max(1, Math.abs(yOpen - yClose)), fill: color, opacity: 0.96 }))
      })
      var series = meta.series || {}
      ;[['sma20', 'var(--aka-line)'], ['bollMiddle', 'var(--aka-band)']].forEach(function (entry) {
        var values = Array.isArray(series[entry[0]]) ? series[entry[0]].slice(-bars.length) : []
        var points = []
        values.forEach(function (value, index) {
          var number = finite(value)
          if (number === null) return
          var x = plotLeft + step * index + step / 2
          var y = chartY(number, minimum, maximum, plotTop, plotBottom)
          points.push(x + ',' + y)
        })
        if (points.length > 1) children.push(React.createElement('polyline', { key: entry[0], points: points.join(' '), fill: 'none', stroke: entry[1], strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' }))
      })
      var yTickValues = [maximum]
      if (minimum !== maximum) yTickValues.push((maximum + minimum) / 2, minimum)
      var axisChildren = [
        React.createElement('line', { key: 'axis-x', x1: plotLeft, x2: width - plotRight, y1: plotBottom, y2: plotBottom, className: 'aka-axis-line' }),
        React.createElement('line', { key: 'axis-y', x1: plotLeft, x2: plotLeft, y1: plotTop, y2: plotBottom, className: 'aka-axis-line' })
      ]
      yTickValues.forEach(function (value, index) {
        var y = chartY(value, minimum, maximum, plotTop, plotBottom)
        axisChildren.push(React.createElement('line', { key: 'grid-' + index, x1: plotLeft, x2: width - plotRight, y1: y, y2: y, className: 'aka-grid' }))
        axisChildren.push(React.createElement('text', { key: 'y-label-' + index, x: plotLeft - 8, y: y + 4, textAnchor: 'end', className: 'aka-axis-text' }, formatAxisNumber(value)))
      })
      var xTicks = [{ index: 0, label: formatDate(bars[0][0]) }]
      if (bars.length > 1) xTicks.push({ index: bars.length - 1, label: formatDate(bars[bars.length - 1][0]) })
      xTicks.forEach(function (tick, index) {
        var x = plotLeft + step * tick.index + step / 2
        axisChildren.push(React.createElement('line', { key: 'x-tick-' + index, x1: x, x2: x, y1: plotBottom, y2: plotBottom + 5, className: 'aka-axis-line' }))
        axisChildren.push(React.createElement('text', { key: 'x-label-' + index, x: x, y: plotBottom + 17, textAnchor: index === 0 ? 'start' : 'end', className: 'aka-axis-text' }, tick.label))
      })
      var title = chartTitle(meta)
      var yAxisLabel = chartYAxisLabel(meta)
      var ariaLabel = title + '，横轴交易日期，纵轴' + yAxisLabel
      axisChildren.push(React.createElement('text', { key: 'y-title', x: 15, y: (plotTop + plotBottom) / 2, textAnchor: 'middle', transform: 'rotate(-90 15 ' + ((plotTop + plotBottom) / 2) + ')', className: 'aka-axis-title' }, yAxisLabel))
      axisChildren.push(React.createElement('text', { key: 'x-title', x: (plotLeft + width - plotRight) / 2, y: height - 4, textAnchor: 'middle', className: 'aka-axis-title' }, '交易日期'))
      return React.createElement('div', { className: 'aka-chart-wrap' }, [
        React.createElement('div', { key: 'caption', className: 'aka-chart-caption' }, [
          React.createElement('strong', { key: 'title' }, title),
          React.createElement('span', { key: 'subtitle' }, periodLabel(meta.period) + ' · 复权：' + (meta.adjust || 'none') + ' · ' + bars.length + ' 根')
        ]),
        React.createElement('svg', { key: 'svg', className: 'aka-chart', viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': ariaLabel }, [
          React.createElement('title', { key: 'svg-title' }, ariaLabel)
        ].concat(axisChildren, children))
      ])
    }

    function Summary(props) {
      var summary = props.meta && props.meta.analysisSummary
      if (!summary) return null
      return React.createElement('div', { className: 'aka-summary' }, [
        React.createElement('div', { key: 'trend', className: 'aka-summary-card' }, [React.createElement('strong', { key: 'label' }, '趋势'), React.createElement('span', { key: 'value' }, summary.trend || '—')]),
        React.createElement('div', { key: 'momentum', className: 'aka-summary-card' }, [React.createElement('strong', { key: 'label' }, '动量'), React.createElement('span', { key: 'value' }, summary.momentum || '—')]),
        React.createElement('div', { key: 'volatility', className: 'aka-summary-card' }, [React.createElement('strong', { key: 'label' }, '波动'), React.createElement('span', { key: 'value' }, summary.volatility || '—')]),
        React.createElement('div', { key: 'volume', className: 'aka-summary-card' }, [React.createElement('strong', { key: 'label' }, '量价'), React.createElement('span', { key: 'value' }, summary.volumePrice || '—')]),
        Array.isArray(summary.warnings) && summary.warnings.length ? React.createElement('div', { key: 'warnings', className: 'aka-warnings' }, summary.warnings.join('；')) : null
      ])
    }

    function Panel(props) {
      var sessions = props.sessions
      var sessionId = useCurrentSessionId(sessions)
      var state = usePanelState()
      var record = state.bySession[sessionId]
      React.useEffect(function () {
        if (state.open && state.activeSessionId && state.activeSessionId !== sessionId && sessionId !== '__unknown__') closePanel()
      }, [sessionId, state.open, state.activeSessionId])
      if (!state.open || (state.activeSessionId && state.activeSessionId !== sessionId)) return null
      var meta = record && record.active
      var resize = function (event) {
        event.preventDefault()
        var startX = event.clientX
        var startWidth = state.width
        function move(nextEvent) {
          store.width = clamp(startWidth + startX - nextEvent.clientX, 430, Math.max(430, Math.min(980, (window.innerWidth || 1400) - 24)))
          notify()
        }
        function up() {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          try { window.localStorage.setItem(WIDTH_KEY, JSON.stringify({ width: store.width })) } catch (_) { /* optional */ }
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      var title = meta && meta.kind === 'snapshot' ? '行情快照' : meta ? 'K线与技术分析' : '行情分析'
      return React.createElement('div', { className: 'aka-overlay', onMouseDown: function (event) { if (event.target === event.currentTarget) closePanel() } }, React.createElement('aside', {
        className: 'aka-panel',
        style: { width: state.width + 'px' },
        role: 'region',
        'aria-label': '行情分析面板',
        onMouseDown: function (event) { event.stopPropagation() }
      }, [
        React.createElement('div', { key: 'resize', className: 'aka-resize', title: '拖拽调整行情面板宽度', onMouseDown: resize }),
        React.createElement('header', { key: 'head', className: 'aka-head' }, [
          React.createElement('div', { key: 'title', className: 'aka-title' }, [React.createElement('strong', { key: 'name' }, title), React.createElement('span', { key: 'source' }, meta ? (meta.symbol || meta.market || '') : '等待工具结果')]),
          record && record.latest && metadataId(record.latest) !== metadataId(meta) ? React.createElement('button', { key: 'latest', type: 'button', className: 'aka-small-button', onClick: function () { selectLatest(sessionId) } }, '有新结果') : null,
          React.createElement('button', { key: 'close', type: 'button', className: 'aka-close', 'aria-label': '关闭行情分析面板', onClick: closePanel }, '×')
        ]),
        !meta ? React.createElement('div', { key: 'empty', className: 'aka-panel-empty' }, '在对话中调用 AKShare 行情工具后，结果会按当前会话显示在这里。') : meta.kind === 'snapshot'
          ? React.createElement('div', { key: 'snapshot', className: 'aka-panel-body' }, [
            React.createElement('div', { key: 'meta', className: 'aka-meta-line' }, '数据时间：' + (meta.fetchedAt || '—') + ' · 来源：' + (meta.source || '—') + (meta.delayMinutes ? ' · 约延迟 ' + meta.delayMinutes + ' 分钟' : '')),
            React.createElement(SnapshotTable, { key: 'table', meta: meta })
          ])
          : React.createElement('div', { key: 'analysis', className: 'aka-panel-body' }, [
            React.createElement('div', { key: 'meta', className: 'aka-meta-line' }, formatDate(meta.startDate) + ' 至 ' + formatDate(meta.endDate) + ' · ' + (meta.period || 'daily') + ' · ' + (meta.adjust || 'none') + ' · ' + (meta.source || '—')),
            React.createElement(CandleChart, { key: 'chart', meta: meta }),
            React.createElement(Summary, { key: 'summary', meta: meta })
          ]),
        React.createElement('footer', { key: 'foot', className: 'aka-foot' }, '仅作数据描述与指标展示，不构成投资建议。')
      ]))
    }

    function ToolRow(props) {
      var sessions = props.sessions
      var sessionId = useCurrentSessionId(sessions)
      var block = props.block || {}
      var meta = metadataOf(block)
      React.useEffect(function () {
        if (meta) registerMetadata(sessionId, meta)
      }, [sessionId, metadataId(meta)])
      var isError = block.isError === true || block.status === 'error'
      if (!meta) return React.createElement('div', { className: isError ? 'aka-tool aka-tool-error' : 'aka-tool aka-tool-running' }, isError ? '行情工具返回错误。' : '正在获取行情数据…')
      var label = meta.kind === 'snapshot' ? '行情快照' : meta.kind === 'analysis' ? 'K线分析' : '历史行情'
      return React.createElement('div', { className: 'aka-tool' }, [
        React.createElement('div', { key: 'head', className: 'aka-tool-head' }, [React.createElement('strong', { key: 'label' }, label), React.createElement('span', { key: 'time' }, meta.fetchedAt || '')]),
        meta.kind === 'snapshot' ? React.createElement(SnapshotTable, { key: 'table', meta: meta }) : React.createElement(CandleChart, { key: 'chart', meta: meta }),
        React.createElement('button', { key: 'open', type: 'button', className: 'aka-open-button', onClick: function () { openPanel(sessionId, meta) } }, '在行情分析面板中打开')
      ])
    }

    var CSS = `
.aka-overlay{position:fixed;inset:0;z-index:90;display:flex;justify-content:flex-end;background:rgba(3,8,20,.12)}
.aka-panel,.aka-tool{--aka-up:#e5484d;--aka-down:#00a870;--aka-line:#f59e0b;--aka-band:#3b82f6}.aka-panel{position:relative;height:100%;max-width:calc(100vw - 16px);display:flex;flex-direction:column;background:var(--color-surface-primary,rgba(18,24,40,.98));color:var(--color-text-primary,#e8edf7);border-left:1px solid var(--color-border-default,rgba(128,145,178,.28));box-shadow:-14px 0 38px rgba(0,0,0,.24);overflow:hidden}
.aka-resize{position:absolute;left:-5px;top:0;bottom:0;width:10px;cursor:ew-resize;z-index:2}
.aka-head{display:flex;align-items:center;gap:10px;min-height:58px;padding:10px 16px;border-bottom:1px solid var(--color-border-default,rgba(128,145,178,.2));background:var(--color-surface-secondary,rgba(25,32,52,.72))}
.aka-title{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.aka-title strong{font-size:15px}.aka-title span,.aka-meta-line,.aka-foot{font-size:11px;color:var(--color-text-secondary,#8f9cb3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aka-close,.aka-small-button,.aka-open-button{border:1px solid var(--color-border-default,rgba(128,145,178,.3));border-radius:6px;background:var(--components-button-background,rgba(90,110,150,.18));color:var(--color-text-primary,#e8edf7);cursor:pointer}.aka-close{font-size:22px;line-height:25px;width:30px;height:30px}.aka-small-button{padding:5px 8px;font-size:11px}.aka-open-button{padding:6px 10px;font-size:12px}.aka-close:hover,.aka-small-button:hover,.aka-open-button:hover{background:var(--components-button-hoverBackground,rgba(90,125,210,.3))}
.aka-panel-body{min-height:0;flex:1;overflow:auto;padding:14px 16px}.aka-meta-line{margin-bottom:10px}.aka-panel-empty{flex:1;padding:42px 28px;color:var(--color-text-secondary,#8f9cb3);line-height:1.7}.aka-foot{padding:8px 16px;border-top:1px solid var(--color-border-default,rgba(128,145,178,.2))}
.aka-table-wrap{overflow:auto;border:1px solid var(--color-border-default,rgba(128,145,178,.18));border-radius:7px}.aka-table{width:100%;border-collapse:collapse;font-size:12px}.aka-table th,.aka-table td{padding:7px 8px;text-align:left;border-bottom:1px solid var(--color-border-default,rgba(128,145,178,.12));white-space:nowrap}.aka-table th{position:sticky;top:0;background:var(--color-surface-secondary,rgba(25,32,52,.98));color:var(--color-text-secondary,#8f9cb3);font-weight:500}.aka-table tr:last-child td{border-bottom:0}.aka-number{text-align:right!important;font-variant-numeric:tabular-nums}.aka-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.aka-up{color:var(--aka-up,#ef6e76)}.aka-down{color:var(--aka-down,#48bd91)}.aka-empty{padding:28px;text-align:center;color:var(--color-text-secondary,#8f9cb3)}
 .aka-chart-wrap{border:1px solid var(--color-border-default,rgba(128,145,178,.32));border-radius:7px;padding:8px;background:var(--color-surface-primary,rgba(18,24,40,.72))}.aka-chart-caption{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 2px 6px;min-width:0}.aka-chart-caption strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.aka-chart-caption span{font-size:10px;color:var(--color-text-secondary,#8f9cb3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.aka-chart{display:block;width:100%;height:auto;min-height:180px}.aka-chart .aka-grid,.aka-grid{stroke:var(--color-border-default,rgba(128,145,178,.38));stroke-width:1;stroke-dasharray:3 4}.aka-chart .aka-axis-line{stroke:var(--color-border-default,rgba(128,145,178,.52));stroke-width:1}.aka-chart .aka-axis-text{fill:var(--color-text-secondary,#8f9cb3);font-size:11px}.aka-chart .aka-axis-title{fill:var(--color-text-secondary,#8f9cb3);font-size:11px;font-weight:500}.aka-summary{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.aka-summary-card{display:flex;flex-direction:column;gap:5px;padding:9px;border:1px solid var(--color-border-default,rgba(128,145,178,.16));border-radius:7px;font-size:12px;line-height:1.45}.aka-summary-card strong{font-size:11px;color:var(--color-text-secondary,#8f9cb3)}.aka-warnings{grid-column:1/-1;padding:8px 10px;color:#d9ac5c;border:1px solid rgba(217,172,92,.28);border-radius:7px;font-size:11px;line-height:1.5}
.aka-tool{margin:6px 0;padding:10px;border:1px solid var(--color-border-default,rgba(128,145,178,.2));border-radius:8px;background:var(--color-surface-secondary,rgba(25,32,52,.36))}.aka-tool-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:8px;font-size:12px}.aka-tool-head span{color:var(--color-text-secondary,#8f9cb3)}.aka-tool .aka-chart{max-height:190px}.aka-tool .aka-table{font-size:11px}.aka-tool .aka-table th,.aka-tool .aka-table td{padding:5px 6px}.aka-tool-running,.aka-tool-error{font-size:12px;color:var(--color-text-secondary,#8f9cb3)}.aka-tool-error{color:var(--color-danger,#ef6e76)}
`

    function apply(ctx) {
      var sessions = ctx.sessions
      if (ctx.get) sessions = ctx.get('sessions') || sessions
      ctx.effect(function () {
        var style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.dataset.pluginCss = PLUGIN_ID + '/styles'
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      })
      ctx.effect(function () {
        function onDesktopMessage(event) {
          if (event.source !== window.parent) return
          var data = event.data
          if (!data || data.source !== 'dsh-desktop') return
          if (data.type === 'analysis-panel-toggle' || (data.type === 'plugin-rpc' && data.pluginId === PLUGIN_ID && data.method === 'akshare.toggleAnalysisPanel')) togglePanel(data.sessionId || useSessionIdOutsideHook(sessions))
          else if (data.type === 'analysis-panel-open') openPanel(data.sessionId || useSessionIdOutsideHook(sessions), null)
          else if (data.type === 'analysis-panel-close') closePanel()
          else if (data.type === 'analysis-panel-state-request') announceDesktop('analysis-panel-state', { open: store.open, sessionId: store.activeSessionId, analysisId: store.activeAnalysisId, pendingNew: store.pendingNew })
        }
        window.addEventListener('message', onDesktopMessage)
        announceDesktop('analysis-panel-state', { open: store.open, sessionId: store.activeSessionId, analysisId: store.activeAnalysisId, pendingNew: store.pendingNew })
        return function () { window.removeEventListener('message', onDesktopMessage) }
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'akshare-market-analysis-panel', order: 120, label: '行情分析' }, function () {
          return React.createElement(Panel, { sessions: sessions })
        })
      })
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({ name: 'tool.call.toolview', key: SNAPSHOT_TOOL }, function (props) {
          return React.createElement(ToolRow, Object.assign({}, props, { sessions: sessions }))
        })
      })
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({ name: 'tool.call.toolview', key: HISTORY_TOOL }, function (props) {
          return React.createElement(ToolRow, Object.assign({}, props, { sessions: sessions }))
        })
      })
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({ name: 'tool.call.toolview', key: ANALYSIS_TOOL }, function (props) {
          return React.createElement(ToolRow, Object.assign({}, props, { sessions: sessions }))
        })
      })
    }

    function useSessionIdOutsideHook(sessions) {
      var source = sessions && sessions.list
      if (!source || typeof source.getSnapshot !== 'function') return '__unknown__'
      return sessionIdFromSnapshot(source.getSnapshot())
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
