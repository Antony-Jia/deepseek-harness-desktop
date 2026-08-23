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
        !state || (!state.mindMap && !state.knowledgeGraph) ? React.createElement(EmptyState, { key: 'empty', title: '尚未生成知识视图', copy: '从标题栏打开“知识视图”，选择同工作路径下的对话并确认生成。' }) : (mode === 'mind-map'
          ? React.createElement(MindMapPanel, { key: 'mind', store: store, selectedNodeId: selectedNodeId, setSelectedNodeId: setSelectedNodeId })
          : React.createElement(KnowledgeGraphPanel, { key: 'graph', store: store }))
      ])
    }

    function GenerationStrip(props) {
      var generation = props.store.generation
      return React.createElement('div', { className: 'ckm-generation-strip', 'data-status': generation.status }, [
        React.createElement('strong', { key: 'status' }, generation.message || generation.status),
        generation.error ? React.createElement('span', { key: 'error' }, generation.error) : null,
        ['failed', 'cancelled'].includes(generation.status) ? null : Button({ key: 'cancel', className: 'ckm-danger', onClick: function () { request('/generations/' + encodeURIComponent(generation.id) + '/cancel', { method: 'POST' }).then(function (body) { applyGeneration(props.store, body.generation) }).catch(function (error) { props.store.error = error.message; notifyStore(props.store) }) } }, '取消')
      ])
    }

    function mindNodes(map) {
      var nodes = (map && map.nodes) || []
      var byParent = Object.create(null)
      nodes.forEach(function (node) { var key = node.parentId || ''; (byParent[key] || (byParent[key] = [])).push(node) })
      var result = []
      function visit(node, depth) {
        result.push({ node: node, depth: depth })
        ;(byParent[node.id] || []).forEach(function (child) { visit(child, depth + 1) })
      }
      var root = nodes.filter(function (node) { return node.id === map.rootId })[0]
      if (root) visit(root, 0)
      return result
    }

    function MindMapPanel(props) {
      var map = props.store.state && props.store.state.mindMap
      var selected = map && map.nodes.filter(function (node) { return node.id === props.selectedNodeId })[0]
      var rows = map ? mindNodes(map) : []
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
          React.createElement('div', { key: 'tree', className: 'ckm-tree' }, rows.map(function (row) {
            return Button({ key: row.node.id, className: 'ckm-tree-node', 'data-active': row.node.id === props.selectedNodeId, style: { marginLeft: (row.depth * 24) + 'px' }, onClick: function () { props.setSelectedNodeId(row.node.id) } }, [
              React.createElement('span', { key: 'type', className: 'ckm-node-type' }, row.node.type),
              React.createElement('strong', { key: 'title' }, row.node.title),
              React.createElement('span', { key: 'narrative' }, row.node.narrative)
            ])
          }))
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
      if (!graph) return React.createElement(EmptyState, { title: '尚未生成知识图谱', copy: '从标题栏打开知识视图并选择生成知识图谱。' })
      var entities = graph.entities.filter(function (entity) {
        return (confidence === 'all' || entity.confidence === confidence) && (!query.trim() || (entity.name + ' ' + entity.summary).toLowerCase().indexOf(query.trim().toLowerCase()) >= 0)
      })
      var visible = Object.create(null)
      entities.forEach(function (entity) { visible[entity.id] = true })
      var positions = entities.map(function (entity, index) {
        var angle = index / Math.max(1, entities.length) * Math.PI * 2
        return { entity: entity, x: 400 + Math.cos(angle) * 260, y: 230 + Math.sin(angle) * 160 }
      })
      var byId = Object.create(null)
      positions.forEach(function (item) { byId[item.entity.id] = item })
      var relations = graph.relations.filter(function (relation) { return visible[relation.from] && visible[relation.to] })
      return React.createElement('div', { className: 'ckm-workspace ckm-graph-layout' }, [
        React.createElement('section', { key: 'graph', className: 'ckm-graph-canvas' }, [
          React.createElement('div', { key: 'toolbar', className: 'ckm-graph-toolbar' }, [React.createElement('input', { key: 'search', value: query, placeholder: '搜索实体…', onChange: function (event) { setQuery(event.target.value) } }), React.createElement('select', { key: 'confidence', value: confidence, onChange: function (event) { setConfidence(event.target.value) } }, [React.createElement('option', { key: 'all', value: 'all' }, '全部置信度'), React.createElement('option', { key: 'confirmed', value: 'confirmed' }, '已确认'), React.createElement('option', { key: 'inferred', value: 'inferred' }, '推测'), React.createElement('option', { key: 'conflicted', value: 'conflicted' }, '有冲突')])]),
          React.createElement('p', { key: 'static', className: 'ckm-panel-hint' }, '知识图谱是静态结果，只能通过菜单栏完整重新生成；画布不支持编辑或节点发散。'),
          React.createElement('svg', { key: 'svg', className: 'ckm-graph-svg', viewBox: '0 0 800 460', role: 'img', 'aria-label': '知识图谱' }, [
            relations.map(function (relation) { var from = byId[relation.from]; var to = byId[relation.to]; return React.createElement('line', { key: relation.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y, className: 'ckm-edge' }) }),
            positions.map(function (item) { return React.createElement('g', { key: item.entity.id, className: 'ckm-graph-node', 'data-active': selected && selected.id === item.entity.id, onClick: function () { setSelected(item.entity) } }, [React.createElement('circle', { key: 'circle', cx: item.x, cy: item.y, r: 26 }), React.createElement('text', { key: 'text', x: item.x, y: item.y + 44, textAnchor: 'middle' }, item.entity.name.slice(0, 18))]) })
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
        request('/confirm', { method: 'POST', body: { anchorSessionId: store.sessionId, selectedSessionIds: selected, outputMode: mode, prompt: prompt, strict: strict, includeSubagents: includeSubagents, model: { provider: modelProvider, model: modelId }, expectedRevision: store.state ? store.state.revision : 0 } }).then(function (body) { setConfirmation(body.confirmation); setMessage(''); setBusy(false) }).catch(function (error) { setMessage(error.message || String(error)); setBusy(false) })
      }
      function start() {
        setBusy(true)
        request('/generations', { method: 'POST', body: { token: confirmation.token, anchorSessionId: store.sessionId, selectedSessionIds: selected, outputMode: mode, prompt: prompt, strict: strict, includeSubagents: includeSubagents, model: confirmation.model, expectedRevision: confirmation.revision } }).then(function (body) {
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
        React.createElement('dl', { key: 'summary', className: 'ckm-confirm-summary' }, [React.createElement('dt', { key: 'cwd-label' }, '工作路径'), React.createElement('dd', { key: 'cwd' }, store.context.cwd), React.createElement('dt', { key: 'source-label' }, '来源'), React.createElement('dd', { key: 'sources' }, confirmation.selectedSessions.length + ' 个已选择对话'), React.createElement('dt', { key: 'output-label' }, '生成'), React.createElement('dd', { key: 'output' }, mode === 'both' ? '思维导图 + 知识图谱' : mode), React.createElement('dt', { key: 'model-label' }, '模型'), React.createElement('dd', { key: 'model' }, confirmation.model.provider + ' / ' + confirmation.model.model), React.createElement('dt', { key: 'strict-label' }, '约束'), React.createElement('dd', { key: 'strict' }, strict ? '严格约束已开启' : '普通约束'), React.createElement('dt', { key: 'save-label' }, '保存'), React.createElement('dd', { key: 'save' }, '.g-dsh-market-knowledge' + (confirmation.overwrite ? '（将替换已有结果）' : ''))]),
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
      '.ckm-generation-strip{display:flex;align-items:center;gap:12px;padding:9px 20px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-state-business-tertiary);font-size:12px}.ckm-generation-strip span{color:var(--dsw-alias-label-secondary)}.ckm-generation-strip .ckm-danger{margin-left:auto}' +
      '.ckm-workspace{display:grid;grid-template-columns:minmax(0,1fr) 330px;min-height:0;flex:1}.ckm-mind-canvas,.ckm-graph-canvas{min-width:0;min-height:0;overflow:auto;padding:20px;background:var(--dsw-alias-bg-base)}.ckm-detail{min-width:0;min-height:0;overflow:auto;padding:20px;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}.ckm-panel-hint{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}.ckm-tree{display:flex;flex-direction:column;gap:8px;max-width:900px;margin:0 auto}.ckm-tree-node{display:flex;flex-direction:column;align-items:flex-start;gap:5px;width:calc(100% - 0px);padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}.ckm-tree-node[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}.ckm-tree-node:hover{background:var(--dsw-alias-interactive-bg-hover)}.ckm-tree-node strong{font-size:13px}.ckm-tree-node span:last-child{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65}.ckm-node-type{display:inline-block;color:var(--dsw-alias-state-business-primary);font-size:10px;letter-spacing:.04em;text-transform:uppercase}.ckm-detail-head{display:flex;flex-direction:column;gap:5px}.ckm-detail h3{margin:0;font-size:16px;line-height:1.45}.ckm-narrative{font-size:13px;line-height:1.8}.ckm-source-box{margin:16px 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);font-size:11px;line-height:1.6}.ckm-source-box strong{display:block;margin-bottom:5px}.ckm-source-box ul{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary)}.ckm-detail-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}' +
      '.ckm-graph-layout{grid-template-columns:minmax(0,1fr) 330px}.ckm-graph-toolbar{display:flex;gap:8px}.ckm-model-selectors{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:8px}.ckm-graph-toolbar input,.ckm-graph-toolbar select,.ckm-field textarea,.ckm-field select,.ckm-field input,.ckm-modal textarea,.ckm-modal select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 9px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}.ckm-graph-toolbar input{flex:1}.ckm-graph-svg{display:block;width:100%;min-height:420px;margin-top:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.ckm-edge{stroke:var(--dsw-alias-border-l2);stroke-width:1.5}.ckm-graph-node{cursor:pointer}.ckm-graph-node circle{fill:var(--dsw-alias-state-business-tertiary);stroke:var(--dsw-alias-state-business-primary);stroke-width:1.5}.ckm-graph-node[data-active=true] circle{fill:var(--dsw-alias-button-info-fill);stroke:var(--dsw-alias-label-primary)}.ckm-graph-node text{fill:var(--dsw-alias-label-primary);font-size:11px}' +
      '.ckm-modal-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.46)}.ckm-modal{width:min(680px,calc(100vw - 40px));max-height:min(760px,calc(100vh - 40px));overflow:auto;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 56px #0008}.ckm-modal h3{margin:0;font-size:17px}.ckm-modal p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.65}.ckm-modal-head{display:flex;align-items:center;justify-content:space-between}.ckm-icon-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;cursor:pointer}.ckm-workspace-label{padding:9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);word-break:break-all}.ckm-field{display:flex;flex-direction:column;gap:7px;margin:14px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.ckm-field textarea{resize:vertical}.ckm-session-list{display:flex;max-height:220px;flex-direction:column;gap:5px;overflow:auto}.ckm-session-option{display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}.ckm-session-option:hover{border-color:var(--dsw-alias-border-l2)}.ckm-session-option input,.ckm-inline-field input{margin-top:3px}.ckm-session-option span{display:flex;flex-direction:column;gap:3px}.ckm-session-option small{color:var(--dsw-alias-label-secondary);font-size:10px}.ckm-inline-field{display:flex;align-items:flex-start;gap:7px;margin:10px 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}.ckm-confirm-summary{display:grid;grid-template-columns:100px 1fr;gap:7px 12px;margin:18px 0;font-size:12px}.ckm-confirm-summary dt{color:var(--dsw-alias-label-secondary)}.ckm-confirm-summary dd{margin:0;word-break:break-all}.ckm-warning{padding:10px;border-radius:8px;background:#d29c2518;color:var(--dsw-alias-label-secondary)}.ckm-error{color:#ff9898!important}.ckm-modal-actions{justify-content:flex-end;margin-top:18px}.ckm-header-pending{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}' +
      '@media(max-width:800px){.ckm-workspace,.ckm-graph-layout{display:flex;flex-direction:column}.ckm-detail{border-top:1px solid var(--dsw-alias-border-l2);border-left:0}.ckm-page-header{align-items:flex-start;flex-direction:column}.ckm-page-actions{width:100%;flex-wrap:wrap}}'

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
