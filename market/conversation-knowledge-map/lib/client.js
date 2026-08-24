// 知识视图 — browser half
//
// The client intentionally keeps graph data in the host-owned workspace and
// treats the knowledge graph as read-only. It uses only React nodes for text;
// model output is never inserted as HTML.
window.__ModuleLoader__.load({
  id: '@p-dsh-market/conversation-knowledge-map',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var PLUGIN_ID = '@p-dsh-market/conversation-knowledge-map'
    var DESKTOP_RPC_METHOD = 'conversationKnowledgeMap.open'
    var BASE = '/conversation-knowledge-map'
    var stores = Object.create(null)
    var overlay = { open: false, version: 0, listeners: [] }
    var navigation = { pending: null, version: 0, listeners: [] }

    function notify(target) {
      target.version += 1
      target.listeners.slice().forEach(function (listener) { try { listener() } catch (_) {} })
    }

    function subscribe(target, listener) {
      target.listeners.push(listener)
      return function () { target.listeners = target.listeners.filter(function (item) { return item !== listener }) }
    }

    function useVersion(target) {
      var pair = React.useState(target.version)
      React.useEffect(function () {
        return subscribe(target, function () { pair[1](function (value) { return value + 1 }) })
      }, [target])
      return pair[0]
    }

    function setOverlayOpen(open) {
      var next = open === true
      if (overlay.open === next) return
      overlay.open = next
      notify(overlay)
    }

    function setPendingNavigation(value) {
      navigation.pending = value || null
      notify(navigation)
    }

    function resolveSessionId(props) {
      var value = props && (props.sessionId || props.id || (props.session && props.session.id))
      value = String(value || '').trim()
      return value && value !== 'active' ? value : null
    }

    function currentSessionId(sessions) {
      if (!sessions) return null
      var value = typeof sessions.current === 'function' ? sessions.current() : (sessions.current || sessions.active || '')
      if (!value && sessions.list && typeof sessions.list.getSnapshot === 'function') {
        var snapshot = sessions.list.getSnapshot()
        value = snapshot && (snapshot.current || snapshot.currentId || snapshot.sessionId || '')
      }
      if (value && typeof value === 'object') value = value.id
      return resolveSessionId({ sessionId: value })
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
      return currentSessionId({ current: snapshot && (snapshot.current || snapshot.currentId || snapshot.sessionId) })
    }

    function getStore(sessionId) {
      var key = String(sessionId || 'no-session')
      if (!stores[key]) {
        stores[key] = {
          sessionId: sessionId,
          context: null,
          state: null,
          sessions: [],
          modelCatalog: null,
          generation: null,
          loading: false,
          loaded: false,
          error: '',
          listeners: [],
          sourceRequest: 0,
          stream: null,
          pollTimer: null,
          mode: 'mind-map'
        }
      }
      return stores[key]
    }

    function notifyStore(store) {
      store.listeners.slice().forEach(function (listener) { try { listener() } catch (_) {} })
    }

    function useStore(sessionId) {
      var store = getStore(sessionId)
      var pair = React.useState(0)
      React.useEffect(function () {
        var listener = function () { pair[1](function (value) { return value + 1 }) }
        store.listeners.push(listener)
        return function () { store.listeners = store.listeners.filter(function (item) { return item !== listener }) }
      }, [store])
      React.useEffect(function () {
        if (sessionId && store.sessionId === sessionId && !store.loaded && !store.loading) loadStore(store)
      }, [sessionId, store])
      return store
    }

    async function request(path, options) {
      var init = Object.assign({ headers: { accept: 'application/json' } }, options || {})
      if (init.body && typeof init.body !== 'string') {
        init.body = JSON.stringify(init.body)
        init.headers = Object.assign({}, init.headers, { 'content-type': 'application/json' })
      }
      var response = await fetch(BASE + path, init)
      var body = await response.json().catch(function () { return {} })
      if (!response.ok || body.ok === false) throw new Error(body.error || ('请求失败（HTTP ' + response.status + '）'))
      return body
    }

    function closeStream(store) {
      if (store.stream) store.stream.close()
      store.stream = null
      if (store.pollTimer) window.clearInterval(store.pollTimer)
      store.pollTimer = null
    }

    function applyGeneration(store, generation) {
      store.generation = generation || null
      notifyStore(store)
      if (!generation || !generation.id) return
      if (generation.status === 'completed') {
        request('/state?anchorSessionId=' + encodeURIComponent(store.sessionId)).then(function (body) {
          store.context = body.context
          store.state = body.state
          notifyStore(store)
        }).catch(function (error) { store.error = error.message || String(error); notifyStore(store) })
      }
    }

    function openGenerationStream(store, id) {
      closeStream(store)
      if (typeof EventSource === 'function') {
        var stream = new EventSource(BASE + '/generations/' + encodeURIComponent(id) + '/events')
        store.stream = stream
        stream.addEventListener('snapshot', function (event) {
          try { applyGeneration(store, JSON.parse(event.data).generation) } catch (_) {}
        })
        stream.addEventListener('update', function (event) {
          try {
            var generation = JSON.parse(event.data).generation
            applyGeneration(store, generation)
            if (generation.status === 'completed' || generation.status === 'failed' || generation.status === 'cancelled') stream.close()
          } catch (_) {}
        })
        stream.onerror = function () {
          if (store.generation && !['completed', 'failed', 'cancelled'].includes(store.generation.status)) startGenerationPolling(store, id)
        }
        return
      }
      startGenerationPolling(store, id)
    }

    function startGenerationPolling(store, id) {
      if (store.pollTimer) return
      store.pollTimer = window.setInterval(function () {
        request('/generations/' + encodeURIComponent(id)).then(function (body) {
          applyGeneration(store, body.generation)
          if (['completed', 'failed', 'cancelled'].includes(body.generation.status)) closeStream(store)
        }).catch(function (error) { store.error = error.message || String(error); notifyStore(store) })
      }, 900)
    }

    async function loadStore(store) {
      var requestId = ++store.sourceRequest
      store.loading = true
      store.error = ''
      notifyStore(store)
      try {
        var contextBody = await request('/context?sessionId=' + encodeURIComponent(store.sessionId || ''))
        if (requestId !== store.sourceRequest) return
        store.context = contextBody.context
        if (store.context && store.context.ready) {
          var stateBody = await request('/state?anchorSessionId=' + encodeURIComponent(store.sessionId))
          if (requestId !== store.sourceRequest) return
          store.context = stateBody.context
          store.state = stateBody.state
        } else {
          store.state = null
        }
        store.loaded = true
      } catch (error) {
        if (requestId === store.sourceRequest) store.error = error.message || String(error)
      } finally {
        if (requestId === store.sourceRequest) { store.loading = false; notifyStore(store) }
      }
    }

    function useOverlay() {
      useVersion(overlay)
      return overlay
    }

    function useNavigation() {
      useVersion(navigation)
      return navigation
    }

    function Button(props, children) {
      return React.createElement('button', Object.assign({ type: 'button' }, props || {}), children)
    }

    function EmptyState(props) {
      return React.createElement('div', { className: 'ckm-empty' }, [
        React.createElement('div', { key: 'icon', className: 'ckm-empty-icon' }, '⌘'),
        React.createElement('h2', { key: 'title' }, props.title),
        React.createElement('p', { key: 'copy' }, props.copy)
      ])
    }

    function KnowledgeView(props) {
      var sessionId = resolveSessionId(props)
      var store = useStore(sessionId)
      var selectedPair = React.useState(null)
      var selectedNodeId = selectedPair[0]
      var setSelectedNodeId = selectedPair[1]
      if (!sessionId) return React.createElement(EmptyState, { title: '请先打开一个已有对话', copy: '确定对话及其工作路径后，才能选择多个历史对话并生成知识视图。' })
      if (store.loading && !store.context) return React.createElement(EmptyState, { title: '正在读取当前对话上下文…', copy: '这里只读取 Session 元数据，不会自动读取历史对话正文。' })
      if (!store.context || !store.context.ready) return React.createElement(EmptyState, { title: '当前对话没有可用工作路径', copy: '知识视图需要从当前 Session 的 header.cwd 确定工作区。' })
      if (store.error && !store.state) return React.createElement(EmptyState, { title: '知识视图暂时不可用', copy: store.error })
      var state = store.state
      var mode = store.mode
      return React.createElement('div', { className: 'ckm-page' }, [
        React.createElement('header', { key: 'header', className: 'ckm-page-header' }, [
          React.createElement('div', { key: 'title' }, [React.createElement('h2', { key: 'h' }, '思维与知识'), React.createElement('p', { key: 'p' }, store.context.cwd)]),
          React.createElement('div', { key: 'actions', className: 'ckm-page-actions' }, [
            Button({ className: 'ckm-tab', 'data-active': mode === 'mind-map', onClick: function () { store.mode = 'mind-map'; notifyStore(store) } }, '思维导图'),
            Button({ className: 'ckm-tab', 'data-active': mode === 'knowledge-graph', onClick: function () { store.mode = 'knowledge-graph'; notifyStore(store) } }, '知识图谱'),
            Button({ className: 'ckm-secondary', onClick: function () { setOverlayOpen(true) } }, '配置 / 重新生成')
          ])
        ]),
        store.generation && store.generation.status !== 'completed' ? React.createElement(GenerationStrip, { key: 'generation', store: store }) : null,
        state && state.compatibility && !state.compatibility.supported ? React.createElement('div', { key: 'compatibility', className: 'ckm-warning ckm-compatibility-warning' }, state.compatibility.message) : null,
        state && state.manifest ? React.createElement(SourceSummary, { key: 'sources', manifest: state.manifest }) : null,
        state && state.manifest && state.manifest.generationTimeline ? React.createElement(GenerationTimeline, { key: 'timeline', items: state.manifest.generationTimeline, defaultCollapsed: true }) : null,
        !state || (!state.mindMap && !state.knowledgeGraph) ? React.createElement(EmptyState, { key: 'empty', title: '尚未生成知识视图', copy: '从标题栏打开“知识视图”，选择同工作路径下的对话并确认生成。' }) : (mode === 'mind-map'
          ? React.createElement(MindMapPanel, { key: 'mind', store: store, selectedNodeId: selectedNodeId, setSelectedNodeId: setSelectedNodeId })
          : React.createElement(KnowledgeGraphPanel, { key: 'graph', store: store }))
      ])
    }

    function SourceSummary(props) {
      var manifest = props.manifest || {}
      var sources = Array.isArray(manifest.sourceSessions) && manifest.sourceSessions.length
        ? manifest.sourceSessions
        : (manifest.sourceSessionIds || []).map(function (sessionId) { return { sessionId: sessionId, title: '' } })
      var warnings = manifest.sourceWarnings || {}
      var failedSources = manifest.failedSources || []
      if (!sources.length) return null
      return React.createElement('section', { className: 'ckm-source-summary', 'aria-label': '本次总结来源' }, [
        React.createElement('div', { key: 'head', className: 'ckm-source-summary-head' }, [
          React.createElement('strong', { key: 'title' }, '已总结 ' + sources.length + ' 个对话' + (manifest.sourceMode === 'answer-only' ? ' · 仅助手回答正文' : ' · 完整对话正文')),
          warnings.skippedItems || warnings.skippedRefs || failedSources.length ? React.createElement('span', { key: 'warning', className: 'ckm-source-warning' }, '失败对话 ' + failedSources.length + ' 个 · 已过滤 ' + (warnings.skippedRefs || 0) + ' 个无效引用、跳过 ' + (warnings.skippedItems || 0) + ' 个内容项') : null
        ]),
        React.createElement('div', { key: 'list', className: 'ckm-source-list' }, sources.map(function (source) {
          var sessionId = String(source.sessionId || '')
          var label = source.title ? source.title + ' · ' + sessionId.slice(0, 16) + '…' : sessionId
          return React.createElement('span', { key: sessionId, className: 'ckm-source-chip', title: sessionId }, label)
        })),
        failedSources.length ? React.createElement('div', { key: 'failed', className: 'ckm-source-failed' }, '未纳入最终报告：' + failedSources.map(function (source) { return source.title || source.sessionId }).join('、')) : null
      ])
    }

    function GenerationTimeline(props) {
      var items = (props.items || []).slice(-80)
      var collapsedPair = React.useState(props.defaultCollapsed === true)
      var collapsed = collapsedPair[0]
      var setCollapsed = collapsedPair[1]
      if (!items.length) return null
      return React.createElement('section', { className: 'ckm-timeline', 'aria-label': '生成过程时间线' }, [
        React.createElement('div', { key: 'head', className: 'ckm-timeline-head' }, [
          React.createElement('strong', { key: 'title', className: 'ckm-timeline-title' }, '生成过程时间线 · ' + items.length + ' 条'),
          Button({ key: 'toggle', className: 'ckm-timeline-toggle', 'aria-expanded': !collapsed, onClick: function () { setCollapsed(!collapsed) } }, collapsed ? '展开' : '折叠')
        ]),
        collapsed ? null : React.createElement('ol', { key: 'items' }, items.map(function (item, index) {
          var time = ''
          try { time = new Date(Number(item.at) || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch (_) {}
          return React.createElement('li', { key: String(item.id || index), 'data-type': item.type || 'info' }, [
            React.createElement('time', { key: 'time' }, time),
            React.createElement('span', { key: 'message' }, item.message)
          ])
        }))
      ])
    }

    function GenerationStrip(props) {
      var generation = props.store.generation
      var progress = generation.progress || { percent: 0, current: 0, total: 0, label: '' }
      var percent = Math.max(0, Math.min(100, Number(progress.percent) || 0))
      return React.createElement('div', { className: 'ckm-generation-strip', 'data-status': generation.status }, [
        React.createElement('div', { key: 'body', className: 'ckm-generation-body' }, [
          React.createElement('div', { key: 'status-row', className: 'ckm-generation-status-row' }, [
            React.createElement('strong', { key: 'status' }, generation.message || generation.status),
            React.createElement('span', { key: 'detail' }, progress.total ? (progress.current + '/' + progress.total + ' 个对话 · ' + progress.label) : progress.label)
          ]),
          React.createElement('div', { key: 'progress', className: 'ckm-progress-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-label': '知识视图生成进度' }, React.createElement('span', { className: 'ckm-progress-value', style: { width: percent + '%' } })),
          React.createElement(GenerationTimeline, { key: 'activity', items: generation.timeline || [] })
        ]),
        generation.error ? React.createElement('span', { key: 'error', className: 'ckm-generation-error' }, generation.error) : null,
        ['failed', 'cancelled'].includes(generation.status) ? null : Button({ key: 'cancel', className: 'ckm-danger', onClick: function () { request('/generations/' + encodeURIComponent(generation.id) + '/cancel', { method: 'POST' }).then(function (body) { applyGeneration(props.store, body.generation) }).catch(function (error) { props.store.error = error.message; notifyStore(props.store) }) } }, '取消')
      ])
    }

    function mindTree(map) {
      var nodes = (map && map.nodes) || []
      var byParent = Object.create(null)
      nodes.forEach(function (node) { var key = node.parentId || ''; (byParent[key] || (byParent[key] = [])).push(node) })
      function branch(node, ancestors) {
        var seen = Object.assign({}, ancestors || {})
        if (seen[node.id]) return { node: node, children: [] }
        seen[node.id] = true
        return { node: node, children: (byParent[node.id] || []).map(function (child) { return branch(child, seen) }) }
      }
      var root = nodes.filter(function (node) { return node.id === map.rootId })[0]
      return root ? branch(root, {}) : null
    }

    function MindTreeBranch(props) {
      var branch = props.branch
      var node = branch.node
      return React.createElement('li', { className: 'ckm-tree-branch' }, [
        Button({ key: 'node', className: 'ckm-tree-node', 'data-active': node.id === props.selectedNodeId, onClick: function () { props.setSelectedNodeId(node.id) } }, [
          React.createElement('span', { key: 'type', className: 'ckm-node-type' }, node.type),
          React.createElement('strong', { key: 'title' }, node.title),
          React.createElement('span', { key: 'narrative' }, node.narrative)
        ]),
        branch.children.length ? React.createElement('ul', { key: 'children', className: 'ckm-tree-children' }, branch.children.map(function (child) {
          return React.createElement(MindTreeBranch, { key: child.node.id, branch: child, selectedNodeId: props.selectedNodeId, setSelectedNodeId: props.setSelectedNodeId })
        })) : null
      ])
    }

    function MindMapPanel(props) {
      var map = props.store.state && props.store.state.mindMap
      var selected = map && map.nodes.filter(function (node) { return node.id === props.selectedNodeId })[0]
      var tree = map ? mindTree(map) : null
      var followPair = React.useState(null)
      var followUp = followPair[0]
      var setFollowUp = followPair[1]
      var messagePair = React.useState('')
      var message = messagePair[0]
      var setMessage = messagePair[1]
      function formQuestion(node) {
        var target = node.primarySourceSessionId || (node.sourceRefs && node.sourceRefs[0] && node.sourceRefs[0].sessionId)
        setMessage('正在形成后续问题…')
        request('/mind-map/follow-up-question', { method: 'POST', body: { anchorSessionId: props.store.sessionId, nodeId: node.id, targetSessionId: target } }).then(function (body) {
          setMessage('')
          setFollowUp({ node: node, value: body.followUp, targets: node.sourceRefs || [] })
        }).catch(function (error) { setMessage(error.message || String(error)) })
      }
      return React.createElement('div', { className: 'ckm-workspace' }, [
        React.createElement('section', { key: 'canvas', className: 'ckm-mind-canvas' }, [
          React.createElement('div', { key: 'hint', className: 'ckm-panel-hint' }, '节点代表阶段性认知；点击后可形成问题，但不会直接修改脑图。'),
          map && map.nodes.length < 2 ? React.createElement('div', { key: 'coverage-warning', className: 'ckm-warning' }, '本次思维导图仅保留了根节点，没有可展开的子节点。请使用修复后的版本重新生成。') : null,
          tree ? React.createElement('ul', { key: 'tree', className: 'ckm-tree ckm-tree-root' }, React.createElement(MindTreeBranch, { branch: tree, selectedNodeId: props.selectedNodeId, setSelectedNodeId: props.setSelectedNodeId })) : null
        ]),
        React.createElement('aside', { key: 'detail', className: 'ckm-detail' }, [
          selected ? [
            React.createElement('div', { key: 'head', className: 'ckm-detail-head' }, [React.createElement('span', { key: 'type', className: 'ckm-node-type' }, selected.type), React.createElement('h3', { key: 'title' }, selected.title)]),
            React.createElement('p', { key: 'narrative', className: 'ckm-narrative' }, selected.narrative),
            selected.openQuestions && selected.openQuestions.length ? React.createElement('div', { key: 'questions', className: 'ckm-source-box' }, [React.createElement('strong', { key: 'label' }, '未决问题'), React.createElement('ul', { key: 'list' }, selected.openQuestions.map(function (item) { return React.createElement('li', { key: item }, item) }))]) : null,
            React.createElement('div', { key: 'sources', className: 'ckm-source-box' }, [React.createElement('strong', { key: 'label' }, '来源对话'), React.createElement('ul', { key: 'list' }, (selected.sourceRefs || []).map(function (ref) { return React.createElement('li', { key: ref.sessionId + ':' + ref.eventSeqs.join(',') }, ref.sessionId.slice(0, 12) + ' · seq ' + ref.eventSeqs.join(', ')) }))]),
            Button({ key: 'follow', className: 'ckm-primary', onClick: function () { formQuestion(selected) } }, '基于此节点继续对话'),
            message ? React.createElement('p', { key: 'message', className: 'ckm-error' }, message) : null
          ] : React.createElement('div', { className: 'ckm-detail-empty' }, '选择一个节点查看阶段性说明和来源。'),
          followUp ? React.createElement(FollowUpModal, { key: 'follow-up', store: props.store, state: followUp, close: function () { setFollowUp(null) } }) : null
        ])
      ])
    }

    function FollowUpModal(props) {
      var value = props.state.value
      var targetPair = React.useState(value.targetSessionId)
      var target = targetPair[0]
      var setTarget = targetPair[1]
      var questionPair = React.useState(value.question)
      var question = questionPair[0]
      var setQuestion = questionPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      function confirm() {
        setBusy(true)
        request('/navigation/confirm', { method: 'POST', body: { anchorSessionId: props.store.sessionId, nodeId: props.state.node.id, targetSessionId: target, question: question } }).then(function (body) {
          setPendingNavigation(body.navigation)
          props.close()
        }).catch(function (error) { setBusy(false); setQuestion(question + '\n\n[确认失败：' + (error.message || String(error)) + ']') })
      }
      var targets = (props.state.targets || []).map(function (ref) { return ref.sessionId }).filter(function (id, index, list) { return list.indexOf(id) === index })
      return React.createElement('div', { className: 'ckm-modal-backdrop' }, React.createElement('div', { className: 'ckm-modal', role: 'dialog', 'aria-modal': 'true' }, [
        React.createElement('h3', { key: 'title' }, '确认返回原对话'),
        React.createElement('p', { key: 'hint' }, '问题会进入目标对话的下一步操作；插件不会自动发送。'),
        React.createElement('label', { key: 'target' }, ['目标对话', React.createElement('select', { key: 'select', value: target, onChange: function (event) { setTarget(event.target.value) } }, targets.map(function (id) { return React.createElement('option', { key: id, value: id }, id) }))]),
        React.createElement('label', { key: 'question' }, ['后续问题', React.createElement('textarea', { key: 'textarea', rows: 6, value: question, onChange: function (event) { setQuestion(event.target.value) } })]),
        React.createElement('div', { key: 'actions', className: 'ckm-modal-actions' }, [Button({ key: 'cancel', className: 'ckm-secondary', onClick: props.close, disabled: busy }, '返回修改'), Button({ key: 'confirm', className: 'ckm-primary', onClick: confirm, disabled: busy || !question.trim() }, busy ? '确认中…' : '确认并返回')])
      ]))
    }

    function graphLayout(entities, relations, spacing) {
      var degree = Object.create(null)
      entities.forEach(function (entity) { degree[entity.id] = 0 })
      relations.forEach(function (relation) {
        if (degree[relation.from] !== undefined) degree[relation.from] += 1
        if (degree[relation.to] !== undefined) degree[relation.to] += 1
      })
      var ordered = entities.slice().sort(function (left, right) {
        return (degree[right.id] || 0) - (degree[left.id] || 0) || String(left.name || '').localeCompare(String(right.name || ''))
      })
      if (!ordered.length) return { positions: [], width: 900, height: 620 }
      var density = Math.max(0.8, Math.min(2.2, Number(spacing) || 1))
      var nodeWidth = 150
      var nodeHeight = 64
      var remaining = ordered.slice(1)
      var rings = []
      var ringIndex = 1
      while (remaining.length) {
        var radius = ringIndex * 205 * density
        var capacity = Math.max(8, Math.floor(Math.PI * 2 * radius / (nodeWidth + 34 * density)))
        rings.push({ radius: radius, items: remaining.splice(0, capacity) })
        ringIndex += 1
      }
      var maxRadius = rings.length ? rings[rings.length - 1].radius : 0
      var size = Math.max(620, Math.ceil((maxRadius + nodeWidth / 2 + 110) * 2))
      var center = size / 2
      var positions = [{ entity: ordered[0], x: center, y: center, width: 174, height: 72, central: true }]
      rings.forEach(function (ring, index) {
        ring.items.forEach(function (entity, itemIndex) {
          var angle = -Math.PI / 2 + (index % 2 ? Math.PI / Math.max(2, ring.items.length) : 0) + itemIndex / Math.max(1, ring.items.length) * Math.PI * 2
          positions.push({ entity: entity, x: center + Math.cos(angle) * ring.radius, y: center + Math.sin(angle) * ring.radius, width: nodeWidth, height: nodeHeight, central: false })
        })
      })
      return { positions: positions, width: size, height: size }
    }

    function graphLabelLines(value) {
      var text = String(value || '').replace(/\s+/g, ' ').trim()
      if (text.length <= 16) return [text]
      var probe = text.slice(0, 17)
      var split = Math.max(probe.lastIndexOf(' '), probe.lastIndexOf('_'), probe.lastIndexOf('/'), probe.lastIndexOf('-'))
      if (split < 7) split = 15
      var first = text.slice(0, split).trim()
      var rest = text.slice(split).replace(/^[_/\-\s]+/, '').trim()
      var second = rest.length > 16 ? rest.slice(0, 15) + '…' : rest
      return [first, second].filter(Boolean)
    }

    function graphEdgePath(from, to, relationId) {
      var dx = to.x - from.x
      var dy = to.y - from.y
      var distance = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      var fromScale = Math.min((from.width / 2) / Math.max(1, Math.abs(dx)), (from.height / 2) / Math.max(1, Math.abs(dy)))
      var toScale = Math.min((to.width / 2) / Math.max(1, Math.abs(dx)), (to.height / 2) / Math.max(1, Math.abs(dy)))
      var startX = from.x + dx * fromScale
      var startY = from.y + dy * fromScale
      var endX = to.x - dx * toScale
      var endY = to.y - dy * toScale
      var hash = String(relationId || '').split('').reduce(function (sum, char) { return sum + char.charCodeAt(0) }, 0)
      var bend = (hash % 3 - 1) * 12
      var controlX = (startX + endX) / 2 - dy / distance * bend
      var controlY = (startY + endY) / 2 + dx / distance * bend
      return 'M ' + startX + ' ' + startY + ' Q ' + controlX + ' ' + controlY + ' ' + endX + ' ' + endY
    }

    function KnowledgeGraphPanel(props) {
      var graph = props.store.state && props.store.state.knowledgeGraph
      var queryPair = React.useState('')
      var query = queryPair[0]
      var setQuery = queryPair[1]
      var confidencePair = React.useState('all')
      var confidence = confidencePair[0]
      var setConfidence = confidencePair[1]
      var selectedPair = React.useState(null)
      var selected = selectedPair[0]
      var setSelected = selectedPair[1]
      var zoomPair = React.useState(1)
      var zoom = zoomPair[0]
      var setZoom = zoomPair[1]
      var spacingPair = React.useState(1)
      var spacing = spacingPair[0]
      var setSpacing = spacingPair[1]
      var localPair = React.useState(false)
      var localOnly = localPair[0]
      var setLocalOnly = localPair[1]
      var panRef = React.useRef(null)
      if (!graph) return React.createElement(EmptyState, { title: '尚未生成知识图谱', copy: '从标题栏打开知识视图并选择生成知识图谱。' })
      var filteredEntities = graph.entities.filter(function (entity) {
        return (confidence === 'all' || entity.confidence === confidence) && (!query.trim() || (entity.name + ' ' + entity.summary).toLowerCase().indexOf(query.trim().toLowerCase()) >= 0)
      })
      var visible = Object.create(null)
      filteredEntities.forEach(function (entity) { visible[entity.id] = true })
      var filteredRelations = graph.relations.filter(function (relation) { return visible[relation.from] && visible[relation.to] })
      var localIds = Object.create(null)
      if (localOnly && selected && visible[selected.id]) {
        localIds[selected.id] = true
        filteredRelations.forEach(function (relation) {
          if (relation.from === selected.id || relation.to === selected.id) {
            localIds[relation.from] = true
            localIds[relation.to] = true
          }
        })
      }
      var entities = localOnly && selected && visible[selected.id] ? filteredEntities.filter(function (entity) { return localIds[entity.id] }) : filteredEntities
      var shown = Object.create(null)
      entities.forEach(function (entity) { shown[entity.id] = true })
      var relations = filteredRelations.filter(function (relation) { return shown[relation.from] && shown[relation.to] })
      var layout = graphLayout(entities, relations, spacing)
      var positions = layout.positions
      var byId = Object.create(null)
      positions.forEach(function (item) { byId[item.entity.id] = item })
      var viewBox = ['0', '0', layout.width, layout.height].join(' ')
      var centerSignature = [layout.width, layout.height, zoom, spacing, localOnly ? selected && selected.id : 'all'].join(':')
      function setStagePan(stage, x, y) {
        stage.dataset.panX = String(x)
        stage.dataset.panY = String(y)
        stage.style.transform = 'translate(' + x + 'px,' + y + 'px)'
      }
      function centerGraphStage(stage) {
        if (!stage || stage.dataset.centered === centerSignature) return
        stage.dataset.centered = centerSignature
        window.requestAnimationFrame(function () {
          var viewport = stage.parentElement
          if (!viewport) return
          setStagePan(stage, (viewport.clientWidth - layout.width * zoom) / 2, (viewport.clientHeight - layout.height * zoom) / 2)
        })
      }
      function beginPan(event) {
        if (event.button !== 0 || (event.target.closest && event.target.closest('.ckm-graph-node,.ckm-graph-toolbar,button,input,select'))) return
        var viewport = event.currentTarget
        var stage = viewport.querySelector('.ckm-graph-stage')
        if (!stage) return
        panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: Number(stage.dataset.panX) || 0, panY: Number(stage.dataset.panY) || 0, stage: stage }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.dataset.dragging = 'true'
        event.preventDefault()
      }
      function movePan(event) {
        var pan = panRef.current
        if (!pan || pan.pointerId !== event.pointerId) return
        setStagePan(pan.stage, pan.panX + event.clientX - pan.x, pan.panY + event.clientY - pan.y)
      }
      function endPan(event) {
        var pan = panRef.current
        if (!pan || pan.pointerId !== event.pointerId) return
        panRef.current = null
        event.currentTarget.dataset.dragging = 'false'
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }
      return React.createElement('div', { className: 'ckm-workspace ckm-graph-layout' }, [
        React.createElement('section', { key: 'graph', className: 'ckm-graph-canvas' }, [
          React.createElement('div', { key: 'toolbar', className: 'ckm-graph-toolbar' }, [
            React.createElement('input', { key: 'search', value: query, placeholder: '搜索实体…', onChange: function (event) { setQuery(event.target.value) } }),
            React.createElement('select', { key: 'confidence', value: confidence, onChange: function (event) { setConfidence(event.target.value) } }, [React.createElement('option', { key: 'all', value: 'all' }, '全部置信度'), React.createElement('option', { key: 'confirmed', value: 'confirmed' }, '已确认'), React.createElement('option', { key: 'inferred', value: 'inferred' }, '推测'), React.createElement('option', { key: 'conflicted', value: 'conflicted' }, '有冲突')]),
            Button({ key: 'local', className: 'ckm-secondary', disabled: !selected, title: selected ? '只显示选中实体及其直接相邻实体' : '请先选择一个实体', onClick: function () { setLocalOnly(!localOnly) } }, localOnly ? '全部视图' : '局部一跳'),
            React.createElement('div', { key: 'spacing', className: 'ckm-graph-zoom', 'aria-label': '知识图谱节点间距控制' }, [
              Button({ key: 'compact', title: '缩小节点间距', disabled: spacing <= 0.8, onClick: function () { setSpacing(Math.max(0.8, Number((spacing - 0.2).toFixed(1)))) } }, '−'),
              Button({ key: 'value', title: '重置节点间距', className: 'ckm-zoom-value', onClick: function () { setSpacing(1) } }, '间距 ' + Math.round(spacing * 100) + '%'),
              Button({ key: 'loose', title: '增大节点间距', disabled: spacing >= 2.2, onClick: function () { setSpacing(Math.min(2.2, Number((spacing + 0.2).toFixed(1)))) } }, '+')
            ]),
            React.createElement('div', { key: 'zoom', className: 'ckm-graph-zoom', 'aria-label': '知识图谱缩放控制' }, [
              Button({ key: 'out', title: '缩小', 'aria-label': '缩小知识图谱', disabled: zoom <= 0.5, onClick: function () { setZoom(Math.max(0.5, Number((zoom - 0.1).toFixed(1)))) } }, '−'),
              Button({ key: 'reset', title: '重置缩放', className: 'ckm-zoom-value', onClick: function () { setZoom(1) } }, Math.round(zoom * 100) + '%'),
              Button({ key: 'in', title: '放大', 'aria-label': '放大知识图谱', disabled: zoom >= 2, onClick: function () { setZoom(Math.min(2, Number((zoom + 0.1).toFixed(1)))) } }, '+')
            ])
          ]),
          React.createElement('p', { key: 'static', className: 'ckm-panel-hint' }, '知识图谱位于固定视口内；可按住空白区域自由拖动，移出视口的部分会被裁剪。画布缩放与节点间距可分别调整，选择实体后可查看一跳局部子图。'),
          React.createElement('div', { key: 'viewport', className: 'ckm-graph-viewport', onPointerDown: beginPan, onPointerMove: movePan, onPointerUp: endPan, onPointerCancel: endPan }, [
            React.createElement('div', { key: 'stage', ref: centerGraphStage, className: 'ckm-graph-stage', style: { width: layout.width * zoom + 'px', height: layout.height * zoom + 'px' } }, [
              React.createElement('svg', { key: 'svg', className: 'ckm-graph-svg', viewBox: viewBox, width: layout.width * zoom, height: layout.height * zoom, style: { width: layout.width * zoom + 'px', height: layout.height * zoom + 'px' }, role: 'img', 'aria-label': '知识图谱' }, [
            React.createElement('defs', { key: 'defs' }, React.createElement('marker', { id: 'ckm-arrow', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto', markerUnits: 'strokeWidth' }, React.createElement('path', { d: 'M0,0 L7,3.5 L0,7 Z', className: 'ckm-arrow-head' }))),
            React.createElement('g', { key: 'edges', className: 'ckm-graph-edges' }, relations.map(function (relation) {
              var from = byId[relation.from]
              var to = byId[relation.to]
              return React.createElement('path', { key: relation.id, d: graphEdgePath(from, to, relation.id), className: 'ckm-edge', markerEnd: 'url(#ckm-arrow)' }, React.createElement('title', null, relation.type))
            })),
            positions.map(function (item) {
              var lines = graphLabelLines(item.entity.name)
              return React.createElement('g', { key: item.entity.id, className: 'ckm-graph-node', 'data-active': selected && selected.id === item.entity.id, 'data-confidence': item.entity.confidence, 'data-central': item.central, onClick: function () { setSelected(item.entity) } }, [
                React.createElement('rect', { key: 'shape', x: item.x - item.width / 2, y: item.y - item.height / 2, width: item.width, height: item.height, rx: 13 }),
                React.createElement('text', { key: 'type', className: 'ckm-graph-node-type', x: item.x, y: item.y - 12, textAnchor: 'middle' }, String(item.entity.type || 'entity').slice(0, 18)),
                React.createElement('text', { key: 'name', className: 'ckm-graph-node-name', x: item.x, y: lines.length === 1 ? item.y + 10 : item.y + 4, textAnchor: 'middle' }, lines.map(function (line, index) {
                  return React.createElement('tspan', { key: index, x: item.x, dy: index === 0 ? 0 : 16 }, line)
                })),
                React.createElement('title', { key: 'title' }, item.entity.name + ' · ' + item.entity.confidence)
              ])
            })
              ])
            ])
          ])
        ]),
        React.createElement('aside', { key: 'detail', className: 'ckm-detail' }, [
          selected ? [
            React.createElement('span', { key: 'type', className: 'ckm-node-type' }, selected.type + ' · ' + selected.confidence),
            React.createElement('h3', { key: 'name' }, selected.name),
            React.createElement('p', { key: 'summary', className: 'ckm-narrative' }, selected.summary),
            React.createElement('div', { key: 'sources', className: 'ckm-source-box' }, [
              React.createElement('strong', { key: 'label' }, '来源证据'),
              React.createElement('ul', { key: 'list' }, (selected.sourceRefs || []).map(function (ref) {
                return React.createElement('li', { key: ref.sessionId + ref.eventSeqs.join(',') }, ref.sessionId.slice(0, 12) + ' · seq ' + ref.eventSeqs.join(', '))
              }))
            ]),
            React.createElement('div', { key: 'relations', className: 'ckm-source-box' }, [
              React.createElement('strong', { key: 'label' }, '相关关系'),
              React.createElement('ul', { key: 'list' }, relations.filter(function (relation) {
                return relation.from === selected.id || relation.to === selected.id
              }).map(function (relation) {
                return React.createElement('li', { key: relation.id }, relation.type + ' → ' + (relation.from === selected.id ? relation.to : relation.from))
              }))
            ])
          ] : React.createElement('div', { className: 'ckm-detail-empty' }, '选择实体查看摘要、置信度、关系和来源。')
        ])
      ])
    }

    function KnowledgeHeaderAction(props) {
      var pending = useNavigation().pending
      var sessionId = resolveSessionId(props)
      if (!sessionId) return null
      if (pending && typeof props.open === 'function') {
        return Button({ className: 'ckm-header-action ckm-header-pending', title: '打开目标对话并复制后续问题', onClick: function () {
          props.open(pending.targetSessionId)
          try { navigator.clipboard && navigator.clipboard.writeText(pending.question) } catch (_) {}
          setPendingNavigation(null)
        } }, '返回并复制问题')
      }
      return Button({ className: 'ckm-header-action', title: '打开知识视图配置', onClick: function () { setOverlayOpen(true) } }, '知识视图')
    }

    function ConfigurationOverlay(props) {
      var store = props.store
      var sessionsPair = React.useState(null)
      var available = sessionsPair[0]
      var setAvailable = sessionsPair[1]
      var selectedPair = React.useState([])
      var selected = selectedPair[0]
      var setSelected = selectedPair[1]
      var modePair = React.useState('both')
      var mode = modePair[0]
      var setMode = modePair[1]
      var sourceModePair = React.useState('conversation')
      var sourceMode = sourceModePair[0]
      var setSourceMode = sourceModePair[1]
      var promptPair = React.useState('')
      var prompt = promptPair[0]
      var setPrompt = promptPair[1]
      var strictPair = React.useState(true)
      var strict = strictPair[0]
      var setStrict = strictPair[1]
      var includePair = React.useState(false)
      var includeSubagents = includePair[0]
      var setIncludeSubagents = includePair[1]
      var modelCatalogPair = React.useState(null)
      var modelCatalog = modelCatalogPair[0]
      var setModelCatalog = modelCatalogPair[1]
      var providerPair = React.useState('')
      var modelProvider = providerPair[0]
      var setModelProvider = providerPair[1]
      var modelIdPair = React.useState('')
      var modelId = modelIdPair[0]
      var setModelId = modelIdPair[1]
      var confirmationPair = React.useState(null)
      var confirmation = confirmationPair[0]
      var setConfirmation = confirmationPair[1]
      var messagePair = React.useState('')
      var message = messagePair[0]
      var setMessage = messagePair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      React.useEffect(function () {
        if (!store.context || !store.context.ready) return
        request('/sessions?anchorSessionId=' + encodeURIComponent(store.sessionId) + '&includeSubagents=' + includeSubagents).then(function (body) {
          setAvailable(body.sessions || [])
          setSelected(function (old) { return old.length ? old.filter(function (id) { return (body.sessions || []).some(function (item) { return item.id === id }) }) : [store.sessionId] })
        }).catch(function (error) { setMessage(error.message || String(error)) })
      }, [store.context && store.context.cwd, includeSubagents])
      React.useEffect(function () {
        if (!store.context || !store.context.ready) return
        request('/models').then(function (body) {
          var catalog = body.catalog || { default: null, groups: [] }
          setModelCatalog(catalog)
          var defaultModel = catalog.default || {}
          var firstGroup = catalog.groups && catalog.groups[0] ? catalog.groups[0] : {}
          var firstModel = firstGroup.models && firstGroup.models[0] ? firstGroup.models[0].id : ''
          setModelProvider(function (old) { return old || defaultModel.provider || firstGroup.id || '' })
          setModelId(function (old) { return old || defaultModel.model || firstModel || '' })
        }).catch(function (error) { setMessage(error.message || String(error)) })
      }, [store.context && store.context.cwd])
      function toggle(id) { setSelected(function (old) { return old.indexOf(id) >= 0 ? old.filter(function (item) { return item !== id }) : old.concat([id]) }) }
      function confirm() {
        if (!selected.length) { setMessage('至少选择一个对话。'); return }
        setBusy(true)
        request('/confirm', { method: 'POST', body: { anchorSessionId: store.sessionId, selectedSessionIds: selected, outputMode: mode, sourceMode: sourceMode, prompt: prompt, strict: strict, includeSubagents: includeSubagents, model: { provider: modelProvider, model: modelId }, expectedRevision: store.state ? store.state.revision : 0 } }).then(function (body) { setConfirmation(body.confirmation); setMessage(''); setBusy(false) }).catch(function (error) { setMessage(error.message || String(error)); setBusy(false) })
      }
      function start() {
        setBusy(true)
        request('/generations', { method: 'POST', body: { token: confirmation.token, anchorSessionId: store.sessionId, selectedSessionIds: selected, outputMode: mode, sourceMode: confirmation.sourceMode, prompt: prompt, strict: strict, includeSubagents: includeSubagents, model: confirmation.model, expectedRevision: confirmation.revision } }).then(function (body) {
          setConfirmation(null)
          setBusy(false)
          setOverlayOpen(false)
          applyGeneration(store, body.generation)
          openGenerationStream(store, body.generation.id)
        }).catch(function (error) { setMessage(error.message || String(error)); setBusy(false) })
      }
      if (!store.context || !store.context.ready) return React.createElement('div', { className: 'ckm-modal-backdrop' }, React.createElement('div', { className: 'ckm-modal' }, [React.createElement('h3', { key: 'title' }, '知识视图'), React.createElement('p', { key: 'copy' }, '请先打开一个有明确工作路径的已有对话。'), Button({ key: 'close', className: 'ckm-primary', onClick: function () { setOverlayOpen(false) } }, '关闭')]))
      return React.createElement('div', { className: 'ckm-modal-backdrop' }, React.createElement('div', { className: 'ckm-modal ckm-config-modal', role: 'dialog', 'aria-modal': 'true' }, confirmation ? [
        React.createElement('h3', { key: 'title' }, '确认生成知识视图？'),
        React.createElement('dl', { key: 'summary', className: 'ckm-confirm-summary' }, [React.createElement('dt', { key: 'cwd-label' }, '工作路径'), React.createElement('dd', { key: 'cwd' }, store.context.cwd), React.createElement('dt', { key: 'source-label' }, '来源'), React.createElement('dd', { key: 'sources' }, confirmation.selectedSessions.length + ' 个已选择对话'), React.createElement('dt', { key: 'scope-label' }, '提取范围'), React.createElement('dd', { key: 'scope' }, confirmation.sourceMode === 'answer-only' ? '仅助手回答正文' : '完整对话正文'), React.createElement('dt', { key: 'output-label' }, '生成'), React.createElement('dd', { key: 'output' }, mode === 'both' ? '思维导图 + 知识图谱' : mode), React.createElement('dt', { key: 'model-label' }, '模型'), React.createElement('dd', { key: 'model' }, confirmation.model.provider + ' / ' + confirmation.model.model), React.createElement('dt', { key: 'strict-label' }, '约束'), React.createElement('dd', { key: 'strict' }, strict ? '严格约束已开启' : '普通约束'), React.createElement('dt', { key: 'save-label' }, '保存'), React.createElement('dd', { key: 'save' }, '.g-dsh-market-knowledge' + (confirmation.overwrite ? '（将替换已有结果）' : ''))]),
        React.createElement('p', { key: 'note', className: 'ckm-warning' }, '确认后才会读取所选对话正文、调用模型并写入工作区；不会自动发送消息。'),
        React.createElement('div', { key: 'actions', className: 'ckm-modal-actions' }, [Button({ key: 'back', className: 'ckm-secondary', onClick: function () { setConfirmation(null) }, disabled: busy }, '返回修改'), Button({ key: 'ok', className: 'ckm-primary', onClick: start, disabled: busy }, busy ? '生成中…' : '确认并生成')])
      ] : [
        React.createElement('div', { key: 'head', className: 'ckm-modal-head' }, [React.createElement('h3', { key: 'title' }, '知识视图配置'), Button({ key: 'close', className: 'ckm-icon-close', onClick: function () { setOverlayOpen(false) } }, '×')]),
        React.createElement('p', { key: 'cwd', className: 'ckm-workspace-label' }, '当前工作路径：' + store.context.cwd),
        React.createElement('label', { key: 'sessions', className: 'ckm-field' }, [
          '参与生成的对话',
          React.createElement('div', { key: 'list', className: 'ckm-session-list' }, available ? available.map(function (item) {
            return React.createElement('label', { key: item.id, className: 'ckm-session-option' }, [
              React.createElement('input', { key: 'check', type: 'checkbox', checked: selected.indexOf(item.id) >= 0, onChange: function () { toggle(item.id) } }),
              React.createElement('span', { key: 'copy' }, [
                React.createElement('strong', { key: 'title' }, (item.current ? '当前对话：' : '') + item.title),
                React.createElement('small', { key: 'meta' }, item.id.slice(0, 12) + ' · ' + (item.origin === 'subagent' ? '子 Agent' : '普通对话'))
              ])
            ])
          }) : React.createElement('span', { key: 'loading' }, '正在加载对话列表…')),
          React.createElement('label', { key: 'include', className: 'ckm-inline-field' }, [
            React.createElement('input', { key: 'check', type: 'checkbox', checked: includeSubagents, onChange: function (event) { setIncludeSubagents(event.target.checked) } }),
            '包含子 Agent 对话（默认关闭）'
          ])
        ]),
        React.createElement('label', { key: 'mode', className: 'ckm-field' }, ['生成内容', React.createElement('select', { key: 'select', value: mode, onChange: function (event) { setMode(event.target.value) } }, [React.createElement('option', { key: 'both', value: 'both' }, '思维导图 + 知识图谱'), React.createElement('option', { key: 'mind', value: 'mind-map' }, '仅思维导图'), React.createElement('option', { key: 'graph', value: 'knowledge-graph' }, '仅知识图谱')])]),
        React.createElement('label', { key: 'source-mode', className: 'ckm-field' }, [
          '提取范围（同时作用于思维导图和知识图谱）',
          React.createElement('select', { key: 'select', value: sourceMode, onChange: function (event) { setSourceMode(event.target.value) } }, [
            React.createElement('option', { key: 'conversation', value: 'conversation' }, '完整对话正文（用户问题 + 助手回答）'),
            React.createElement('option', { key: 'answer-only', value: 'answer-only' }, '仅助手回答正文')
          ]),
          React.createElement('span', { key: 'hint', className: 'ckm-panel-hint' }, '两种模式都会排除 reasoning / thinking、工具结果和流式过程块。')
        ]),
        React.createElement('label', { key: 'model', className: 'ckm-field' }, [
          '生成模型',
          React.createElement('span', { key: 'hint', className: 'ckm-panel-hint' }, '默认带入 DSH 默认模型；可以为本次知识视图单独选择 Provider / Model。'),
          modelCatalog && modelCatalog.groups && modelCatalog.groups.length ? React.createElement('div', { key: 'selectors', className: 'ckm-model-selectors' }, [
            React.createElement('select', { key: 'provider', value: modelProvider, onChange: function (event) { var next = event.target.value; var group = modelCatalog.groups.filter(function (item) { return item.id === next })[0]; setModelProvider(next); setModelId(group && group.models && group.models[0] ? group.models[0].id : '') } }, modelCatalog.groups.map(function (group) { return React.createElement('option', { key: group.id, value: group.id }, group.name + '（' + group.id + '）') })),
            React.createElement('select', { key: 'model', value: modelId, onChange: function (event) { setModelId(event.target.value) } }, ((modelCatalog.groups.filter(function (item) { return item.id === modelProvider })[0] || {}).models || []).map(function (item) { return React.createElement('option', { key: item.id, value: item.id }, item.name + '（' + item.id + '）') }))
          ]) : React.createElement('div', { key: 'inputs', className: 'ckm-model-selectors' }, [
            React.createElement('input', { key: 'provider', value: modelProvider, placeholder: 'Provider', onChange: function (event) { setModelProvider(event.target.value) } }),
            React.createElement('input', { key: 'model', value: modelId, placeholder: 'Model', onChange: function (event) { setModelId(event.target.value) } })
          ])
        ]),
        React.createElement('label', { key: 'prompt', className: 'ckm-field' }, ['额外要求', React.createElement('textarea', { key: 'textarea', rows: 4, maxLength: 4000, value: prompt, placeholder: '请输入形成思维导图或知识图谱时需要遵守的 Prompt…', onChange: function (event) { setPrompt(event.target.value) } })]),
        React.createElement('label', { key: 'strict', className: 'ckm-inline-field' }, [React.createElement('input', { key: 'check', type: 'checkbox', checked: strict, onChange: function (event) { setStrict(event.target.checked) } }), '严格约束模式（来源、路径、工具和写入均由 Host 校验）']),
        message ? React.createElement('p', { key: 'message', className: 'ckm-error' }, message) : null,
        React.createElement('div', { key: 'actions', className: 'ckm-modal-actions' }, [Button({ key: 'cancel', className: 'ckm-secondary', onClick: function () { setOverlayOpen(false) }, disabled: busy }, '取消'), Button({ key: 'next', className: 'ckm-primary', onClick: confirm, disabled: busy || !available || !selected.length }, busy ? '读取中…' : '下一步：确认')])
      ]))
    }

    function KnowledgeOverlay(props) {
      var state = useOverlay()
      var sessionId = useCurrentSessionId(props.sessions)
      var store = useStore(sessionId)
      if (!state.open) return null
      return React.createElement(ConfigurationOverlay, { store: store })
    }

    var CSS = '\n' +
      '.ckm-page,.ckm-modal,.ckm-detail,.ckm-empty{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}' +
      '.ckm-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}' +
      '.ckm-page-header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}' +
      '.ckm-page-header h2{margin:0;font-size:16px}.ckm-page-header p{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;word-break:break-all}' +
      '.ckm-page-actions,.ckm-modal-actions{display:flex;align-items:center;gap:8px}.ckm-tab,.ckm-secondary,.ckm-primary,.ckm-danger,.ckm-header-action{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 11px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px}.ckm-tab[data-active=true],.ckm-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}.ckm-tab:hover,.ckm-secondary:hover,.ckm-header-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.ckm-primary:hover{background:var(--dsw-alias-button-info-hover)}.ckm-danger{border-color:#d36b6b;color:#ffb7b7}.ckm-danger:hover{background:#d94a4a22}.ckm-page button:disabled,.ckm-modal button:disabled{opacity:.5;cursor:not-allowed}' +
      '.ckm-empty{display:flex;flex:1;min-height:260px;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center}.ckm-empty-icon{display:grid;place-items:center;width:44px;height:44px;margin-bottom:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;color:var(--dsw-alias-state-business-primary);font-size:24px}.ckm-empty h2{margin:0 0 8px;font-size:17px}.ckm-empty p{max-width:520px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}' +
      '.ckm-generation-strip{display:flex;align-items:flex-start;gap:12px;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-state-business-tertiary);font-size:12px}.ckm-generation-body{display:grid;gap:7px;flex:1;min-width:0}.ckm-generation-status-row{display:flex;justify-content:space-between;gap:12px}.ckm-generation-status-row span{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ckm-progress-track{height:6px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-1)}.ckm-progress-value{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary);transition:width .25s ease}.ckm-generation-error{color:#ff9898;max-width:38%;overflow-wrap:anywhere}.ckm-generation-strip .ckm-danger{margin-left:auto}.ckm-source-summary{display:grid;gap:8px;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}.ckm-source-summary-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px}.ckm-source-warning,.ckm-source-failed{color:#d69a42}.ckm-source-failed{font-size:11px}.ckm-source-list{display:flex;flex-wrap:wrap;gap:6px}.ckm-source-chip{max-width:360px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ckm-timeline{display:grid;gap:9px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px}.ckm-generation-strip .ckm-timeline{max-height:220px;overflow:auto;padding:6px 0 0;border:0}.ckm-timeline-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ckm-timeline-title{color:var(--dsw-alias-label-primary)}.ckm-timeline-toggle{border:0;padding:3px 7px;border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;font-size:11px}.ckm-timeline-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}.ckm-timeline ol{display:grid;gap:0;margin:0;padding:0;list-style:none}.ckm-timeline li{position:relative;display:grid;grid-template-columns:78px 1fr;gap:10px;padding:5px 0 5px 14px;color:var(--dsw-alias-label-secondary)}.ckm-timeline li:before{content:"";position:absolute;left:2px;top:11px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}.ckm-timeline li:not(:last-child):after{content:"";position:absolute;left:4px;top:17px;bottom:-5px;width:1px;background:var(--dsw-alias-border-l2)}.ckm-timeline li[data-type="retry"]:before,.ckm-timeline li[data-type="skipped"]:before,.ckm-timeline li[data-type="view-failed"]:before{background:#d69a42}.ckm-timeline li[data-type="failed"]:before{background:#ff7070}.ckm-timeline time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}' +
      '.ckm-workspace{display:grid;grid-template-columns:minmax(0,1fr) 330px;min-height:0;flex:1}.ckm-mind-canvas,.ckm-graph-canvas{min-width:0;min-height:0;padding:20px;background:var(--dsw-alias-bg-base)}.ckm-mind-canvas{overflow:auto}.ckm-graph-canvas{overflow-x:hidden;overflow-y:auto}.ckm-detail{min-width:0;min-height:0;overflow:auto;padding:20px;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}.ckm-panel-hint{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}.ckm-tree{max-width:900px;margin:0 auto;padding:0;list-style:none}.ckm-tree-branch{position:relative;padding:6px 0 6px 30px;list-style:none}.ckm-tree-root>.ckm-tree-branch{padding-left:0}.ckm-tree-children{position:relative;margin:8px 0 0 20px;padding:0 0 0 22px;list-style:none}.ckm-tree-children>.ckm-tree-branch:before{content:"";position:absolute;left:-22px;top:-8px;bottom:50%;border-left:1px solid var(--dsw-alias-border-l2)}.ckm-tree-children>.ckm-tree-branch:not(:last-child):before{bottom:-8px}.ckm-tree-children>.ckm-tree-branch:after{content:"";position:absolute;left:-22px;top:50%;width:22px;border-top:1px solid var(--dsw-alias-border-l2)}.ckm-tree-node{display:flex;flex-direction:column;align-items:flex-start;gap:5px;width:min(720px,100%);padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}.ckm-tree-node[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}.ckm-tree-node:hover{background:var(--dsw-alias-interactive-bg-hover)}.ckm-tree-node strong{font-size:13px}.ckm-tree-node span:last-child{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65}.ckm-node-type{display:inline-block;color:var(--dsw-alias-state-business-primary);font-size:10px;letter-spacing:.04em;text-transform:uppercase}.ckm-detail-head{display:flex;flex-direction:column;gap:5px}.ckm-detail h3{margin:0;font-size:16px;line-height:1.45}.ckm-narrative{font-size:13px;line-height:1.8}.ckm-source-box{margin:16px 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);font-size:11px;line-height:1.6}.ckm-source-box strong{display:block;margin-bottom:5px}.ckm-source-box ul{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary)}.ckm-detail-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}' +
      '.ckm-graph-layout{grid-template-columns:minmax(0,1fr) 330px}.ckm-graph-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.ckm-model-selectors{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:8px}.ckm-graph-toolbar input,.ckm-graph-toolbar select,.ckm-field textarea,.ckm-field select,.ckm-field input,.ckm-modal textarea,.ckm-modal select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 9px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}.ckm-graph-toolbar input{flex:1;min-width:180px}.ckm-graph-zoom{display:flex;align-items:center;margin-left:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}.ckm-graph-zoom button{min-width:32px;border:0;border-right:1px solid var(--dsw-alias-border-l2);padding:7px 9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}.ckm-graph-zoom button:last-child{border-right:0}.ckm-graph-zoom button:hover{background:var(--dsw-alias-interactive-bg-hover)}.ckm-graph-zoom button:disabled{opacity:.4;cursor:not-allowed}.ckm-graph-zoom .ckm-zoom-value{min-width:58px;color:var(--dsw-alias-state-business-primary);font-size:11px}.ckm-graph-svg{display:block;width:100%;max-width:100%;height:auto;min-height:500px;margin-top:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:radial-gradient(circle at 50% 48%,var(--dsw-alias-state-business-tertiary),var(--dsw-alias-bg-layer-1) 58%);box-sizing:border-box}.ckm-graph-edges{opacity:.62}.ckm-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.4}.ckm-arrow-head{fill:var(--dsw-alias-label-tertiary)}.ckm-graph-node{cursor:pointer}.ckm-graph-node rect{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-state-business-primary);stroke-width:1.5;filter:drop-shadow(0 4px 8px rgba(0,0,0,.14))}.ckm-graph-node[data-central=true] rect{fill:var(--dsw-alias-button-info-fill);stroke:var(--dsw-alias-label-primary);stroke-width:2}.ckm-graph-node[data-confidence="inferred"] rect{stroke:#d69a42}.ckm-graph-node[data-confidence="conflicted"] rect{stroke:#e06c75}.ckm-graph-node[data-active=true] rect{fill:var(--dsw-alias-state-business-tertiary);stroke:var(--dsw-alias-label-primary);stroke-width:2.5}.ckm-graph-node text{pointer-events:none}.ckm-graph-node-type{fill:var(--dsw-alias-label-tertiary);font-size:9px;letter-spacing:.04em;text-transform:uppercase}.ckm-graph-node-name{fill:var(--dsw-alias-label-primary);font-size:11px;font-weight:600}.ckm-graph-node[data-central=true] .ckm-graph-node-type,.ckm-graph-node[data-central=true] .ckm-graph-node-name{fill:var(--dsw-alias-label-primary-foreground)}' +
      '.ckm-modal-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.46)}.ckm-modal{width:min(680px,calc(100vw - 40px));max-height:min(760px,calc(100vh - 40px));overflow:auto;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 56px #0008}.ckm-modal h3{margin:0;font-size:17px}.ckm-modal p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65}.ckm-modal-head{display:flex;align-items:center;justify-content:space-between}.ckm-icon-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;cursor:pointer}.ckm-workspace-label{padding:9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);word-break:break-all}.ckm-field{display:flex;flex-direction:column;gap:7px;margin:14px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.ckm-field textarea{resize:vertical}.ckm-session-list{display:flex;max-height:220px;flex-direction:column;gap:5px;overflow:auto}.ckm-session-option{display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}.ckm-session-option:hover{border-color:var(--dsw-alias-border-l2)}.ckm-session-option input,.ckm-inline-field input{margin-top:3px}.ckm-session-option span{display:flex;flex-direction:column;gap:3px}.ckm-session-option small{color:var(--dsw-alias-label-secondary);font-size:10px}.ckm-inline-field{display:flex;align-items:flex-start;gap:7px;margin:10px 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}.ckm-confirm-summary{display:grid;grid-template-columns:100px 1fr;gap:7px 12px;margin:18px 0;font-size:12px}.ckm-confirm-summary dt{color:var(--dsw-alias-label-secondary)}.ckm-confirm-summary dd{margin:0;word-break:break-all}.ckm-warning{padding:10px;border-radius:8px;background:#d29c2518;color:var(--dsw-alias-label-secondary)}.ckm-error{color:#ff9898!important}.ckm-modal-actions{justify-content:flex-end;margin-top:18px}.ckm-header-pending{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}' +
      '@media(max-width:800px){.ckm-workspace,.ckm-graph-layout{display:flex;flex-direction:column}.ckm-detail{border-top:1px solid var(--dsw-alias-border-l2);border-left:0}.ckm-page-header{align-items:flex-start;flex-direction:column}.ckm-page-actions{width:100%;flex-wrap:wrap}}'

    CSS += '.ckm-graph-layout{height:100%;min-height:0;overflow:hidden;align-self:stretch}.ckm-graph-canvas{display:flex;flex-direction:column;height:100%;max-height:100%;box-sizing:border-box;overflow:hidden}.ckm-graph-toolbar{position:relative;z-index:2;padding-bottom:4px;background:var(--dsw-alias-bg-base);cursor:default}.ckm-graph-zoom{margin-left:0}.ckm-graph-zoom:last-child{margin-left:auto}.ckm-graph-viewport{position:relative;flex:1;min-height:360px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:radial-gradient(circle at 50% 48%,var(--dsw-alias-state-business-tertiary),var(--dsw-alias-bg-layer-1) 58%);cursor:grab;touch-action:none}.ckm-graph-viewport[data-dragging="true"]{cursor:grabbing;user-select:none}.ckm-graph-stage{position:absolute;left:0;top:0;will-change:transform}.ckm-graph-svg{display:block;width:auto;max-width:none;height:auto;min-width:620px;min-height:620px;margin:0;border:0;border-radius:0;background:transparent}@media(max-width:800px){.ckm-graph-layout{height:auto;overflow:visible}.ckm-graph-canvas{height:auto;min-height:420px}.ckm-graph-viewport{flex:none;height:60vh}}'

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
          if (data.type === 'plugin-rpc' && data.pluginId === PLUGIN_ID && data.method === DESKTOP_RPC_METHOD) setOverlayOpen(data.open !== false)
        }
        window.addEventListener('message', onDesktopMessage)
        return function () { window.removeEventListener('message', onDesktopMessage) }
      })
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({ name: 'conversation.view', id: 'conversation-knowledge-map', order: 35, label: '思维与知识' }, function (props) { return React.createElement(KnowledgeView, props) })
      })
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({ name: 'conversation.session.header.actions', id: 'conversation-knowledge-map', order: 35, label: '知识视图' }, KnowledgeHeaderAction)
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'conversation-knowledge-map', order: 125, label: '知识视图配置' }, function () { return React.createElement(KnowledgeOverlay, { sessions: sessions }) })
      })
    }

    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    exports.resolveSessionId = resolveSessionId
    exports.currentSessionId = currentSessionId
    exports.setOverlayOpen = setOverlayOpen
    return module.exports
  }
})
