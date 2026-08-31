// Graph Job editor — browser half. The host owns graph validation, revisions,
// execution and persistence; this module only edits a session-scoped draft and
// renders the immutable run/event projection.
window.__ModuleLoader__.load({
  id: '@p-dsh-market/graph-job-orchestrator',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var PLUGIN_ID = '@p-dsh-market/graph-job-orchestrator'
    var BASE = '/graph-job-orchestrator'
    var DESKTOP_RPC_METHOD = 'graphJobOrchestrator.open'
    var sessionsService = null
    var STATUS_LABELS = { created: '待运行', running: '运行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', terminated: '已终止', succeeded: '完成', failed: '失败', blocked: '阻塞', pending: '等待' }

    function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

    function sessionIdFromSnapshot(snapshot) {
      var value = snapshot && (snapshot.current || snapshot.currentId || snapshot.sessionId)
      if (value && typeof value === 'object') value = value.id
      return String(value || '').trim()
    }

    function resolveSessionId(props) {
      var value = props && (props.sessionId || props.id || (props.session && props.session.id))
      value = String(value || '').trim()
      return value && value !== 'active' ? value : ''
    }

    function useSessionId(props) {
      var source = (props && props.sessions && props.sessions.list) || (sessionsService && sessionsService.list)
      var pair = React.useState(function () { return resolveSessionId(props) || sessionIdFromSnapshot(source && source.getSnapshot ? source.getSnapshot() : null) })
      var value = pair[0]
      var setValue = pair[1]
      React.useEffect(function () {
        var direct = resolveSessionId(props)
        if (direct) { setValue(direct); return undefined }
        if (!source || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return undefined
        function update() { setValue(sessionIdFromSnapshot(source.getSnapshot())) }
        update()
        return source.subscribe(update)
      }, [source, props && props.sessionId, props && props.id])
      return value
    }

    function request(path, options) {
      var config = Object.assign({ cache: 'no-store' }, options || {})
      if (config.body && typeof config.body !== 'string') {
        config.headers = Object.assign({ 'content-type': 'application/json' }, config.headers || {})
        config.body = JSON.stringify(config.body)
      }
      return fetch(BASE + path, config).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (body) {
          if (!response.ok || body.ok === false) throw new Error(body.error || 'Graph Job 请求失败。')
          return body
        })
      })
    }

    function defaultNodePosition(index) { return { x: 32 + (index % 3) * 218, y: 32 + Math.floor(index / 3) * 142 } }

    function layoutGraph(graph) {
      var value = clone(graph || {}) || {}
      value.nodes = (value.nodes || []).map(function (node, index) { return Object.assign({}, node, { ui: node.ui || defaultNodePosition(index) }) })
      return value
    }

    function edgePath(from, to) {
      var sx = Number(from && from.x || 0) + 174
      var sy = Number(from && from.y || 0) + 42
      var tx = Number(to && to.x || 0)
      var ty = Number(to && to.y || 0) + 42
      var mid = (sx + tx) / 2
      return 'M ' + sx + ' ' + sy + ' C ' + mid + ' ' + sy + ', ' + mid + ' ' + ty + ', ' + tx + ' ' + ty
    }

    function statusLabel(status) { return STATUS_LABELS[String(status || '')] || String(status || '未知') }

    function nodeById(graph, id) { return (graph && graph.nodes || []).filter(function (node) { return node.id === id })[0] }

    function updateNode(graph, nodeId, patch) {
      var next = clone(graph)
      next.nodes = (next.nodes || []).map(function (node) { return node.id === nodeId ? Object.assign({}, node, patch) : node })
      return next
    }

    function addTask(graph, profiles, kind) {
      var next = clone(graph)
      var index = (next.nodes || []).length + 1
      var id = 'node-' + index
      while ((next.nodes || []).some(function (node) { return node.id === id })) { index += 1; id = 'node-' + index }
      var profile = (profiles || []).filter(function (item) { return item.enabled !== false })[0]
      var node = {
        id: id,
        kind: kind || 'task',
        title: kind === 'merge' ? '汇总节点 ' + index : '任务节点 ' + index,
        instruction: kind === 'merge' ? '' : '请完成这个节点的具体任务，并按输出契约返回 JSON。',
        agentProfileId: kind === 'merge' ? '' : (profile ? profile.id : ''),
        access: 'read',
        outputContract: { fields: ['text', 'artifactRefs'], requireText: true, allowEmptyText: false, allowArtifactRefs: true },
        failurePolicy: 'pause',
        ui: defaultNodePosition(index - 1)
      }
      next.nodes = (next.nodes || []).concat([node])
      return next
    }

    function appendEdge(graph, from, to) {
      if (!from || !to || from === to) return graph
      var seen = {}
      var pending = [to]
      while (pending.length) {
        var current = pending.shift()
        if (current === from) return graph
        if (seen[current]) continue
        seen[current] = true
        ;(graph.edges || []).filter(function (edge) { return edge.from === current }).forEach(function (edge) { pending.push(edge.to) })
      }
      var next = clone(graph)
      next.edges = (next.edges || []).some(function (edge) { return edge.from === from && edge.to === to }) ? next.edges : (next.edges || []).concat([{ from: from, to: to }])
      return next
    }

    function GraphCanvas(props) {
      var graph = props.graph || { nodes: [], edges: [] }
      var nodes = graph.nodes || []
      var byId = {}
      nodes.forEach(function (node) { byId[node.id] = node })
      var canvasRef = React.useRef(null)
      function positionFromEvent(event) {
        var rect = canvasRef.current && canvasRef.current.getBoundingClientRect()
        return { x: Math.max(10, (event.clientX || 0) - (rect ? rect.left : 0) - 80), y: Math.max(10, (event.clientY || 0) - (rect ? rect.top : 0) - 30) }
      }
      function onDrop(event) {
        event.preventDefault()
        var kind = event.dataTransfer && event.dataTransfer.getData('application/x-graph-node')
        var id = event.dataTransfer && event.dataTransfer.getData('application/x-graph-existing')
        var position = positionFromEvent(event)
        if (id) props.onChange(updateNode(graph, id, { ui: position }))
        else if (kind === 'task' || kind === 'merge') {
          var next = addTask(graph, props.profiles, kind)
          next.nodes[next.nodes.length - 1].ui = position
          props.onChange(next)
        }
      }
      function startNew(event, kind) { event.dataTransfer && event.dataTransfer.setData('application/x-graph-node', kind) }
      function startExisting(event, id) { event.dataTransfer && event.dataTransfer.setData('application/x-graph-existing', id) }
      return React.createElement('div', { className: 'gjo-canvas-wrap' }, [
        React.createElement('div', { key: 'palette', className: 'gjo-palette' }, [
          React.createElement('span', { key: 'label' }, '拖入节点'),
          React.createElement('button', { key: 'task', type: 'button', draggable: true, onDragStart: function (event) { startNew(event, 'task') }, onClick: function () { props.onChange(addTask(graph, props.profiles, 'task')) } }, '＋任务'),
          React.createElement('button', { key: 'merge', type: 'button', draggable: true, onDragStart: function (event) { startNew(event, 'merge') }, onClick: function () { props.onChange(addTask(graph, props.profiles, 'merge')) } }, '＋汇总'),
          React.createElement('span', { key: 'hint', className: 'gjo-muted' }, props.connectFrom ? '请选择目标节点完成连接' : '点击节点查看详情')
        ]),
        React.createElement('div', { key: 'canvas', ref: canvasRef, className: 'gjo-canvas', onDragOver: function (event) { event.preventDefault() }, onDrop: onDrop }, [
          React.createElement('svg', { key: 'edges', className: 'gjo-edges', width: '100%', height: '100%', 'aria-hidden': 'true' }, [
            React.createElement('defs', { key: 'defs' }, React.createElement('marker', { id: 'gjo-arrow', markerWidth: '8', markerHeight: '8', refX: '7', refY: '3', orient: 'auto' }, React.createElement('path', { d: 'M0,0 L0,6 L7,3 z', fill: 'currentColor' }))),
            (graph.edges || []).map(function (edge, index) { return React.createElement('path', { key: edge.from + '-' + edge.to + '-' + index, d: edge.from === 'root' ? edgePath({ x: 8, y: 14 }, byId[edge.to] && byId[edge.to].ui) : edgePath(byId[edge.from] && byId[edge.from].ui, byId[edge.to] && byId[edge.to].ui), className: 'gjo-edge', markerEnd: 'url(#gjo-arrow)' }) })
          ]),
          React.createElement('div', { key: 'root', className: 'gjo-root-node', style: { left: 8, top: 14 } }, 'ROOT'),
          nodes.map(function (node) {
            var selected = props.selectedId === node.id
            var position = node.ui || { x: 20, y: 20 }
            return React.createElement('div', {
              key: node.id,
              className: 'gjo-node' + (selected ? ' is-selected' : ''),
              style: { left: position.x, top: position.y },
              draggable: true,
              onDragStart: function (event) { startExisting(event, node.id) },
              onClick: function () { props.onSelect(node.id) },
              onDoubleClick: function () { props.onConnect(node.id) }
            }, [
              React.createElement('div', { key: 'head', className: 'gjo-node-head' }, [React.createElement('span', { key: 'kind', className: 'gjo-kind' }, node.kind === 'merge' ? 'MERGE' : 'TASK'), React.createElement('strong', { key: 'title' }, node.title || node.id)]),
              React.createElement('div', { key: 'meta', className: 'gjo-node-meta' }, [React.createElement('span', { key: 'access' }, node.access === 'write' ? '写入' : '读取'), React.createElement('span', { key: 'profile' }, node.agentProfileId || '内置汇总')]),
              React.createElement('div', { key: 'actions', className: 'gjo-node-actions' }, [React.createElement('button', { key: 'connect', type: 'button', onClick: function (event) { event.stopPropagation(); props.onConnect(node.id) } }, props.connectFrom === node.id ? '取消连接' : '连接'), React.createElement('button', { key: 'remove', type: 'button', onClick: function (event) { event.stopPropagation(); props.onRemove(node.id) } }, '删除')])
            ])
          })
        ])
      ])
    }

    function NodeInspector(props) {
      var node = props.node
      if (!node) return React.createElement('div', { className: 'gjo-inspector gjo-empty' }, '选择一个节点编辑其任务、Profile 和读写模式。')
      function change(patch) { props.onChange(updateNode(props.graph, node.id, patch)) }
      return React.createElement('aside', { className: 'gjo-inspector' }, [
        React.createElement('div', { key: 'head', className: 'gjo-inspector-head' }, [React.createElement('div', { key: 'label' }, [React.createElement('span', { key: 'kind', className: 'gjo-eyebrow' }, node.kind === 'merge' ? 'MERGE NODE' : 'TASK NODE'), React.createElement('h3', { key: 'title' }, node.title || node.id)]), React.createElement('button', { key: 'close', type: 'button', onClick: function () { props.onSelect('') } }, '×')]),
        React.createElement('label', { key: 'title' }, ['标题', React.createElement('input', { key: 'input', value: node.title || '', onChange: function (event) { change({ title: event.target.value }) } })]),
        node.kind === 'task' ? React.createElement('label', { key: 'instruction' }, ['任务指令', React.createElement('textarea', { key: 'input', rows: 7, value: node.instruction || '', onChange: function (event) { change({ instruction: event.target.value }) } })]) : React.createElement('p', { key: 'merge-note', className: 'gjo-note' }, '汇总节点会等待所有直接前置节点完成，并稳定合并 text 与 artifactRefs。'),
        React.createElement('label', { key: 'access' }, ['访问模式', React.createElement('select', { key: 'input', value: node.access || 'read', onChange: function (event) { change({ access: event.target.value }) } }, [React.createElement('option', { key: 'read', value: 'read' }, 'read：可并行'), React.createElement('option', { key: 'write', value: 'write' }, 'write：串行')])]),
        node.kind === 'task' ? React.createElement('label', { key: 'profile' }, ['Agent Profile', React.createElement('select', { key: 'input', value: node.agentProfileId || '', onChange: function (event) { change({ agentProfileId: event.target.value }) } }, [React.createElement('option', { key: 'empty', value: '' }, '请选择'), (props.profiles || []).map(function (profile) { return React.createElement('option', { key: profile.id, value: profile.id }, profile.name + ' · ' + profile.executor) })])]) : null,
        React.createElement('div', { key: 'edge-list', className: 'gjo-edge-list' }, [React.createElement('h4', { key: 'h' }, '直接连线'), (props.graph.edges || []).filter(function (edge) { return edge.from === node.id || edge.to === node.id }).map(function (edge, index) { return React.createElement('button', { key: edge.from + '-' + edge.to + '-' + index, type: 'button', onClick: function () { props.onRemoveEdge(edge) } }, edge.from + ' → ' + edge.to + ' ×') }), !props.graph.edges.some(function (edge) { return edge.from === node.id || edge.to === node.id }) ? React.createElement('span', { key: 'none', className: 'gjo-muted' }, '暂无显式连线；无前置节点时由虚拟 ROOT 进入。') : null])
      ])
    }

    function ValidationPanel(props) {
      var validation = props.validation
      if (!validation) return null
      var errors = validation.errors || []
      var warnings = validation.warnings || []
      return React.createElement('div', { className: 'gjo-validation ' + (validation.valid ? 'is-valid' : 'is-invalid') }, [
        React.createElement('strong', { key: 'title' }, validation.valid ? 'DAG / capability 校验通过' : 'Graph 需要修正'),
        errors.concat(warnings).slice(0, 8).map(function (item, index) { return React.createElement('div', { key: item.path + '-' + index, className: errors.indexOf(item) >= 0 ? 'gjo-validation-error' : 'gjo-validation-warning' }, (item.path ? item.path + '：' : '') + item.message) })
      ])
    }

    function GraphJobView(props) {
      var sessionId = useSessionId(props)
       var state = React.useState({ graph: null, profiles: [], capabilities: null, templates: [], templateId: '', templateScope: 'workspace', run: null, preview: null, templatePreview: null, loading: true, saving: false, error: '', message: '', selectedId: '', connectFrom: '' })
      var store = state[0]
      var setStore = state[1]
      function patch(next) { setStore(function (current) { return Object.assign({}, current, next) }) }
      function load() {
        if (!sessionId) { patch({ loading: false, error: '当前没有可用的会话。' }); return }
        patch({ loading: true, error: '' })
         Promise.all([request('/graphs?sessionId=' + encodeURIComponent(sessionId)), request('/profiles'), request('/capabilities'), request('/templates?sessionId=' + encodeURIComponent(sessionId))]).then(function (values) {
          var body = values[0]
           patch({ graph: body.graph ? layoutGraph(body.graph) : null, run: body.binding && body.binding.activeRunId ? null : null, profiles: values[1].profiles || [], capabilities: values[2].capabilities || null, templates: values[3].templates || [], loading: false })
          if (body.binding && body.binding.activeRunId) request('/runs/' + encodeURIComponent(body.binding.activeRunId)).then(function (runBody) { patch({ run: runBody.run }) }).catch(function () {})
        }).catch(function (error) { patch({ loading: false, error: error.message || String(error) }) })
      }
      React.useEffect(load, [sessionId])

      function save() {
        if (!store.graph || store.saving) return
        patch({ saving: true, error: '', message: '' })
        request('/graphs/' + encodeURIComponent(store.graph.graphId), { method: 'PATCH', body: { sessionId: sessionId, graph: store.graph } }).then(function (body) {
          patch({ graph: layoutGraph(body.graph), saving: false, message: '手工 revision 已保存，旧 revision 保留。' })
        }).catch(function (error) { patch({ saving: false, error: error.message || String(error) }) })
      }
      function preview() {
        if (!store.graph) return
        patch({ error: '', message: '正在生成静态预览…' })
        request('/graphs/' + encodeURIComponent(store.graph.graphId) + '/preview', { method: 'POST', body: { sessionId: sessionId, graph: store.graph, source: 'manual', allowEmpty: false } }).then(function (body) { patch({ preview: body, message: body.validation && body.validation.valid ? '预览通过；点击“确认 revision”后才可运行。' : '预览返回校验错误，请先修正 Graph。' }) }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function confirmPreview() {
        if (!store.preview || !store.preview.confirmationToken) return
        request('/graphs/' + encodeURIComponent(store.graph.graphId) + '/confirm', { method: 'POST', body: { sessionId: sessionId, confirmationToken: store.preview.confirmationToken } }).then(function (body) { patch({ preview: body, graph: layoutGraph(body.graph), message: '用户确认已记录；现在可以运行该 revision。' }) }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function run() {
        if (!store.preview || !store.preview.confirmed) { patch({ error: '必须先完成预览并点击“确认 revision”。' }); return }
        request('/graphs/' + encodeURIComponent(store.graph.graphId) + '/run', { method: 'POST', body: { sessionId: sessionId, confirmationToken: store.preview.confirmationToken, confirmed: true } }).then(function (body) { patch({ run: body.run, message: 'Graph 已启动；事件会实时显示。' }); subscribeRun(body.run && body.run.runId) }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function previewTemplate(mode) {
        if (!store.graph) return
         var selectedMode = mode || 'saveAs'
         var payload = { sessionId: sessionId, mode: selectedMode, scope: store.templateScope || 'workspace', name: store.graph.goal || 'Graph Job 模板', graph: store.graph }
         if (selectedMode === 'overwrite') payload.templateId = store.templateId
         request('/templates/preview', { method: 'POST', body: payload }).then(function (body) { patch({ templatePreview: body.preview, message: '模板保存预览已生成；确认后才会写入模板库。' }) }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function confirmTemplate() {
        if (!store.templatePreview || !store.templatePreview.confirmationToken) return
         request('/templates/confirm', { method: 'POST', body: { sessionId: sessionId, confirmationToken: store.templatePreview.confirmationToken } }).then(function () { patch({ templatePreview: null, message: '模板已保存；历史 revision 仍保留。' }); load() }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function bindTemplate() {
        if (!store.templateId) return
        request('/templates/' + encodeURIComponent(store.templateId) + '/bind', { method: 'POST', body: { sessionId: sessionId } }).then(function (body) {
          patch({ graph: layoutGraph(body.graph), preview: null, run: null, message: '模板已快照为当前会话的新 Graph Instance。' })
        }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function subscribeRun(runId) {
        if (!runId || typeof EventSource === 'undefined') return
        var source = new EventSource(BASE + '/runs/' + encodeURIComponent(runId) + '/events')
        source.addEventListener('snapshot', function (event) { try { patch({ run: JSON.parse(event.data).run }) } catch (_) {} })
        source.addEventListener('update', function (event) { try { var body = JSON.parse(event.data); patch({ run: body.run }) } catch (_) {} })
        source.onerror = function () { if (store.run && ['completed', 'cancelled', 'terminated'].indexOf(store.run.status) >= 0) source.close() }
      }
      function newGraph() {
        request('/graphs', { method: 'POST', body: { sessionId: sessionId, mode: 'save', goal: '请填写任务图目标。', nodes: [], edges: [], agentProfiles: store.profiles, allowEmpty: true } }).then(function (body) { patch({ graph: layoutGraph(body.graph), preview: null, run: null, selectedId: '', message: '已创建新的空 Graph。' }) }).catch(function (error) { patch({ error: error.message || String(error) }) })
      }
      function removeNode(id) {
        var next = clone(store.graph)
        next.nodes = (next.nodes || []).filter(function (node) { return node.id !== id })
        next.edges = (next.edges || []).filter(function (edge) { return edge.from !== id && edge.to !== id })
        patch({ graph: next, selectedId: store.selectedId === id ? '' : store.selectedId, preview: null })
      }
      function connect(id) {
        if (!store.connectFrom) { patch({ connectFrom: id }); return }
        if (store.connectFrom === id) { patch({ connectFrom: '' }); return }
        patch({ graph: appendEdge(store.graph, store.connectFrom, id), connectFrom: '', preview: null })
      }
      function removeEdge(edge) { patch({ graph: Object.assign({}, clone(store.graph), { edges: (store.graph.edges || []).filter(function (item) { return item.from !== edge.from || item.to !== edge.to }) }), preview: null }) }
      function updateGoal(event) { patch({ graph: Object.assign({}, store.graph, { goal: event.target.value }), preview: null }) }
      var selected = nodeById(store.graph, store.selectedId)
      if (store.loading) return React.createElement('div', { className: 'gjo-shell gjo-empty' }, '正在加载 Graph Job…')
      if (!store.graph) return React.createElement('div', { className: 'gjo-shell gjo-empty' }, [React.createElement('div', { key: 'icon', className: 'gjo-icon' }, '◇'), React.createElement('h2', { key: 'h' }, '当前会话还没有 Graph Job'), React.createElement('p', { key: 'p' }, '从空白任务图开始，或让当前对话中的 Planner 先提出一个受限草案。'), React.createElement('button', { key: 'create', type: 'button', className: 'gjo-primary', onClick: newGraph }, '创建任务图')])
      return React.createElement('div', { className: 'gjo-shell' }, [
        React.createElement('header', { key: 'header', className: 'gjo-header' }, [React.createElement('div', { key: 'copy' }, [React.createElement('div', { key: 'eyebrow', className: 'gjo-eyebrow' }, 'GRAPH JOB / SESSION ' + sessionId.slice(0, 12)), React.createElement('h2', { key: 'title' }, '多 Subagent 任务图'), React.createElement('p', { key: 'sub' }, 'Revision ' + store.graph.revision + ' · ' + (store.graph.manualLock ? '手工锁定' : 'Planner 草案')), React.createElement('div', { key: 'actions', className: 'gjo-header-actions' }, [React.createElement('button', { key: 'new', type: 'button', className: 'gjo-secondary', onClick: newGraph }, '新建'), React.createElement('button', { key: 'refresh', type: 'button', className: 'gjo-secondary', onClick: load }, '刷新'), React.createElement('button', { key: 'save', type: 'button', className: 'gjo-secondary', disabled: store.saving, onClick: save }, store.saving ? '保存中…' : '保存 revision'), React.createElement('button', { key: 'template', type: 'button', className: 'gjo-secondary', onClick: function () { previewTemplate('saveAs') } }, '另存模板'), React.createElement('select', { key: 'scope', className: 'gjo-template-select', value: store.templateScope || 'workspace', onChange: function (event) { patch({ templateScope: event.target.value }) } }, [React.createElement('option', { key: 'workspace', value: 'workspace' }, 'workspace 模板'), React.createElement('option', { key: 'global', value: 'global' }, 'global 模板')]), store.templates.length ? React.createElement('select', { key: 'template-select', className: 'gjo-template-select', value: store.templateId || '', onChange: function (event) { var id = event.target.value; var selected = (store.templates || []).filter(function (template) { return template.id === id })[0]; patch({ templateId: id, templateScope: selected && selected.scope || 'workspace' }) } }, [React.createElement('option', { key: 'empty', value: '' }, '选择覆盖模板'), store.templates.map(function (template) { return React.createElement('option', { key: template.id, value: template.id }, (template.name || template.id) + ' · ' + (template.scope || 'workspace')) })]) : null, React.createElement('button', { key: 'bind', type: 'button', className: 'gjo-secondary', disabled: !store.templateId, onClick: bindTemplate }, '切换到模板'), React.createElement('button', { key: 'overwrite', type: 'button', className: 'gjo-secondary', disabled: !store.templateId, onClick: function () { previewTemplate('overwrite') } }, '覆盖模板'), React.createElement('button', { key: 'preview', type: 'button', className: 'gjo-primary', onClick: preview }, '预览 DAG')])])]),
        React.createElement('div', { key: 'goal', className: 'gjo-goal-bar' }, [React.createElement('label', { key: 'label' }, '目标'), React.createElement('textarea', { key: 'input', rows: 2, value: store.graph.goal || '', onChange: updateGoal, placeholder: '这个 Graph 要完成什么？' }), React.createElement('div', { key: 'limit', className: 'gjo-limit-copy' }, 'maxParallel ' + (store.graph.limits && store.graph.limits.maxParallel || 4) + ' · write 串行 · 失败暂停')]),
        store.error ? React.createElement('div', { key: 'error', className: 'gjo-error' }, store.error) : null,
        store.message ? React.createElement('div', { key: 'message', className: 'gjo-message' }, store.message) : null,
         store.preview ? React.createElement(ValidationPanel, { key: 'validation', validation: store.preview.validation }) : null,
         store.preview ? React.createElement('div', { key: 'preview', className: 'gjo-preview-bar' }, [React.createElement('div', { key: 'summary' }, [React.createElement('strong', { key: 'title' }, store.preview.validation && store.preview.validation.valid ? '预览通过' : '预览未通过'), React.createElement('span', { key: 'copy' }, ' 节点 ' + (store.preview.summary && store.preview.summary.nodeCount || 0) + ' · 深度 ' + (store.preview.summary && store.preview.summary.depth || 0))]), React.createElement('div', { key: 'actions' }, [React.createElement('button', { key: 'confirm', type: 'button', className: 'gjo-secondary', disabled: !store.preview.confirmationToken || store.preview.confirmed, onClick: confirmPreview }, store.preview.confirmed ? '已确认' : '确认 revision'), React.createElement('button', { key: 'run', type: 'button', className: 'gjo-primary', disabled: !store.preview.confirmed, onClick: run }, '运行 Graph')])]) : null,
        store.templatePreview ? React.createElement('div', { key: 'template-preview', className: 'gjo-preview-bar' }, [React.createElement('span', { key: 'copy' }, '模板保存预览：' + store.templatePreview.templateId), React.createElement('button', { key: 'confirm', type: 'button', className: 'gjo-secondary', disabled: !store.templatePreview.confirmationToken, onClick: confirmTemplate }, '确认保存模板')]) : null,
        React.createElement('main', { key: 'main', className: 'gjo-main' }, [React.createElement(GraphCanvas, { key: 'canvas', graph: store.graph, profiles: store.profiles, selectedId: store.selectedId, connectFrom: store.connectFrom, onChange: function (graph) { patch({ graph: graph, preview: null }) }, onSelect: function (id) { patch({ selectedId: id }) }, onConnect: connect, onRemove: removeNode }), React.createElement(NodeInspector, { key: 'inspector', graph: store.graph, node: selected, profiles: store.profiles, onSelect: function (id) { patch({ selectedId: id }) }, onChange: function (graph) { patch({ graph: graph, preview: null }) }, onRemoveEdge: removeEdge })]),
         store.run ? React.createElement('section', { key: 'run', className: 'gjo-run-card' }, [React.createElement('div', { key: 'run-head', className: 'gjo-run-head' }, [React.createElement('div', { key: 'copy' }, [React.createElement('span', { key: 'eyebrow', className: 'gjo-eyebrow' }, 'RUN ' + store.run.runId.slice(0, 12)), React.createElement('strong', { key: 'status', className: 'gjo-status', 'data-status': store.run.status }, statusLabel(store.run.status))]), React.createElement('div', { key: 'buttons', className: 'gjo-run-actions' }, [React.createElement('button', { key: 'retry', type: 'button', className: 'gjo-secondary', disabled: store.run.status !== 'paused', onClick: function () { request('/runs/' + encodeURIComponent(store.run.runId) + '/retry', { method: 'POST' }).then(function (body) { patch({ run: body.run }) }).catch(function (error) { patch({ error: error.message || String(error) }) }) } }, 'Retry 失败节点'), React.createElement('button', { key: 'cancel', type: 'button', className: 'gjo-secondary', disabled: ['running', 'paused'].indexOf(store.run.status) < 0, onClick: function () { request('/runs/' + encodeURIComponent(store.run.runId) + '/cancel', { method: 'POST' }).then(function (body) { patch({ run: body.run }) }).catch(function (error) { patch({ error: error.message || String(error) }) }) } }, '取消'), React.createElement('button', { key: 'terminate', type: 'button', className: 'gjo-secondary', disabled: ['running', 'paused'].indexOf(store.run.status) < 0, onClick: function () { request('/runs/' + encodeURIComponent(store.run.runId) + '/terminate', { method: 'POST' }).then(function (body) { patch({ run: body.run }) }).catch(function (error) { patch({ error: error.message || String(error) }) }) } }, '终止')])]), React.createElement('div', { key: 'nodes', className: 'gjo-run-nodes' }, Object.keys(store.run.nodeStates || {}).map(function (id) { var item = store.run.nodeStates[id]; return React.createElement('div', { key: id, className: 'gjo-run-node', 'data-status': item.status }, [React.createElement('span', { key: 'dot' }), React.createElement('span', { key: 'id' }, id), React.createElement('em', { key: 'state' }, statusLabel(item.status)), item.error ? React.createElement('small', { key: 'error' }, item.error) : null]) }))]) : null
      ])
    }

    function ProfileSettings() {
      var state = React.useState({ profiles: [], capabilities: null, draft: null, loading: true, saving: false, error: '', message: '' })
      var store = state[0]
      var setStore = state[1]
      React.useEffect(function () { Promise.all([request('/profiles'), request('/capabilities')]).then(function (values) { setStore({ profiles: values[0].profiles || [], draft: clone(values[0].profiles || []), capabilities: values[1].capabilities, loading: false, saving: false, error: '', message: '' }) }).catch(function (error) { setStore(function (value) { return Object.assign({}, value, { loading: false, error: error.message || String(error) }) }) }) }, [])
      function update(index, patch) { setStore(function (value) { var draft = clone(value.draft || []); draft[index] = Object.assign({}, draft[index], patch); return Object.assign({}, value, { draft: draft }) }) }
      function save() { setStore(function (value) { return Object.assign({}, value, { saving: true, error: '' }) }); request('/profiles', { method: 'PUT', body: { profiles: store.draft } }).then(function (body) { setStore(function (value) { return Object.assign({}, value, { profiles: body.profiles, draft: clone(body.profiles), saving: false, message: 'Agent Profile 已保存。' }) }) }).catch(function (error) { setStore(function (value) { return Object.assign({}, value, { saving: false, error: error.message || String(error) }) }) }) }
      if (store.loading) return React.createElement('div', { className: 'gjo-settings gjo-empty' }, '正在读取 Agent Profile…')
      return React.createElement('div', { className: 'gjo-settings' }, [React.createElement('div', { key: 'head', className: 'gjo-settings-head' }, [React.createElement('div', { key: 'copy' }, [React.createElement('h2', { key: 'h' }, 'Graph Job Agent Profiles'), React.createElement('p', { key: 'p' }, 'revision 创建时会快照 Provider/Model；Codex reasoningEffort 只有能力快照支持时才会发送。')]), React.createElement('button', { key: 'save', type: 'button', className: 'gjo-primary', disabled: store.saving, onClick: save }, store.saving ? '保存中…' : '保存')]), store.error ? React.createElement('div', { key: 'error', className: 'gjo-error' }, store.error) : null, store.message ? React.createElement('div', { key: 'message', className: 'gjo-message' }, store.message) : null, React.createElement('div', { key: 'list', className: 'gjo-profile-list' }, (store.draft || []).map(function (profile, index) { return React.createElement('article', { key: profile.id, className: 'gjo-profile-card' }, [React.createElement('div', { key: 'top', className: 'gjo-profile-top' }, [React.createElement('strong', { key: 'name' }, profile.name || profile.id), React.createElement('span', { key: 'executor', className: 'gjo-pill' }, profile.executor)]), React.createElement('label', { key: 'provider' }, ['Provider', React.createElement('input', { key: 'input', value: profile.provider || '', placeholder: 'revision 时继承默认', onChange: function (event) { update(index, { provider: event.target.value }) } })]), React.createElement('label', { key: 'model' }, ['Model', React.createElement('input', { key: 'input', value: profile.model || '', placeholder: 'revision 时继承默认', onChange: function (event) { update(index, { model: event.target.value }) } })]), React.createElement('label', { key: 'persona' }, ['Persona', React.createElement('textarea', { key: 'input', rows: 3, value: profile.persona || '', onChange: function (event) { update(index, { persona: event.target.value }) } })]), React.createElement('p', { key: 'caps', className: 'gjo-muted' }, '工具 ' + ((profile.capabilities && profile.capabilities.tools || []).join(', ') || '无') + ' · Skills ' + ((profile.capabilities && profile.capabilities.skills || []).join(', ') || '无') + (profile.executor === 'codex' ? ' · reasoningEffort 由能力快照校验' : ''))]) }))])
    }

    function ProfileSettingsV2() {
      var state = React.useState({ profiles: [], capabilities: null, draft: null, loading: true, saving: false, error: '', message: '' })
      var store = state[0]
      var setStore = state[1]
      React.useEffect(function () {
        Promise.all([request('/profiles'), request('/capabilities')]).then(function (values) {
          setStore({ profiles: values[0].profiles || [], draft: clone(values[0].profiles || []), capabilities: values[1].capabilities || {}, loading: false, saving: false, error: '', message: '' })
        }).catch(function (error) { setStore(function (value) { return Object.assign({}, value, { loading: false, error: error.message || String(error) }) }) })
      }, [])
      function update(index, patch) {
        setStore(function (value) {
          var draft = clone(value.draft || [])
          draft[index] = Object.assign({}, draft[index], patch)
          return Object.assign({}, value, { draft: draft })
        })
      }
      function listValues(value) {
        return Array.from(new Set((value || []).map(function (item) { return String(item || '').trim() }).filter(Boolean)))
      }
      function providersFor(profile) {
        var capabilities = store.capabilities || {}
        var providers = (capabilities.subagentProviders || []).filter(function (item) { return profile.executor !== 'codex' || /codex/i.test(item.name || '') }).map(function (item) { return item.name }).filter(Boolean)
        if (profile.executor === 'codex') providers = listValues((capabilities.executors && capabilities.executors.codex && capabilities.executors.codex.providers) || providers)
        else if (capabilities.executors && capabilities.executors.dsh && capabilities.executors.dsh.provider) providers.unshift(capabilities.executors.dsh.provider)
        if (profile.provider) providers.unshift(profile.provider)
        return listValues(providers)
      }
      function modelsFor(profile) {
        var values = (store.capabilities && store.capabilities.models || []).filter(function (item) { return typeof item === 'string' || !profile.provider || item.provider === profile.provider }).map(function (item) { return typeof item === 'string' ? item : item.model })
        var provider = (store.capabilities && store.capabilities.subagentProviders || []).filter(function (item) { return item.name === profile.provider })[0]
        values = values.concat(provider && provider.models || [])
        if (profile.model) values.unshift(profile.model)
        return listValues(values)
      }
      function reasoningFor(profile) {
        if (profile.executor !== 'codex') return []
        var provider = (store.capabilities && store.capabilities.subagentProviders || []).filter(function (item) { return item.name === profile.provider })[0]
        var values = provider && provider.capabilities && provider.capabilities.reasoningEfforts || (store.capabilities && store.capabilities.executors && store.capabilities.executors.codex && store.capabilities.executors.codex.reasoningEfforts) || []
        return listValues(values)
      }
      function changeExecutor(index, executor) {
        var profile = (store.draft || [])[index] || {}
        var next = Object.assign({}, profile, { executor: executor, reasoningEffort: executor === 'codex' ? profile.reasoningEffort || '' : '' })
        var providers = providersFor(next)
        if (providers.length && providers.indexOf(next.provider) < 0) next.provider = providers[0]
        var models = modelsFor(next)
        if (models.length && models.indexOf(next.model) < 0) next.model = models[0]
        update(index, next)
      }
      function save() {
        setStore(function (value) { return Object.assign({}, value, { saving: true, error: '' }) })
        request('/profiles', { method: 'PUT', body: { profiles: store.draft } }).then(function (body) { setStore(function (value) { return Object.assign({}, value, { profiles: body.profiles, draft: clone(body.profiles), saving: false, message: 'Agent Profile 已保存。' }) }) }).catch(function (error) { setStore(function (value) { return Object.assign({}, value, { saving: false, error: error.message || String(error) }) }) })
      }
      if (store.loading) return React.createElement('div', { className: 'gjo-settings gjo-empty' }, '正在读取 Agent Profile…')
      return React.createElement('div', { className: 'gjo-settings' }, [
        React.createElement('div', { key: 'head', className: 'gjo-settings-head' }, [React.createElement('div', { key: 'copy' }, [React.createElement('h2', { key: 'h' }, 'Graph Job Agent Profiles'), React.createElement('p', { key: 'p' }, 'revision 创建时会快照 Provider/Model；普通 DSH 不显示 reasoningEffort，Codex 只显示能力快照公布的值。')]), React.createElement('button', { key: 'save', type: 'button', className: 'gjo-primary', disabled: store.saving, onClick: save }, store.saving ? '保存中…' : '保存')]),
        store.error ? React.createElement('div', { key: 'error', className: 'gjo-error' }, store.error) : null,
        store.message ? React.createElement('div', { key: 'message', className: 'gjo-message' }, store.message) : null,
        React.createElement('div', { key: 'list', className: 'gjo-profile-list' }, (store.draft || []).map(function (profile, index) {
          var providers = providersFor(profile)
          var models = modelsFor(profile)
          var reasoning = reasoningFor(profile)
          return React.createElement('article', { key: profile.id, className: 'gjo-profile-card' }, [
            React.createElement('div', { key: 'top', className: 'gjo-profile-top' }, [React.createElement('strong', { key: 'name' }, profile.name || profile.id), React.createElement('span', { key: 'executor', className: 'gjo-pill' }, profile.executor)]),
            React.createElement('label', { key: 'executor' }, ['Executor', React.createElement('select', { key: 'input', value: profile.executor || 'dsh', onChange: function (event) { changeExecutor(index, event.target.value) } }, [React.createElement('option', { key: 'dsh', value: 'dsh' }, 'DSH in-process'), React.createElement('option', { key: 'codex', value: 'codex', disabled: !(store.capabilities && store.capabilities.executors && store.capabilities.executors.codex && store.capabilities.executors.codex.available) }, 'Codex')])]),
            React.createElement('label', { key: 'provider' }, ['Provider', providers.length ? React.createElement('select', { key: 'input', value: profile.provider || '', onChange: function (event) { update(index, { provider: event.target.value }) } }, [React.createElement('option', { key: 'empty', value: '' }, '选择 Provider'), providers.map(function (item) { return React.createElement('option', { key: item, value: item }, item) })]) : React.createElement('input', { key: 'input', value: profile.provider || '', placeholder: 'revision 时继承默认', onChange: function (event) { update(index, { provider: event.target.value }) } })]),
            React.createElement('label', { key: 'model' }, ['Model', models.length ? React.createElement('select', { key: 'input', value: profile.model || '', onChange: function (event) { update(index, { model: event.target.value }) } }, [React.createElement('option', { key: 'empty', value: '' }, '选择 Model'), models.map(function (item) { return React.createElement('option', { key: item, value: item }, item) })]) : React.createElement('input', { key: 'input', value: profile.model || '', placeholder: 'revision 时继承默认', onChange: function (event) { update(index, { model: event.target.value }) } })]),
            profile.executor === 'codex' ? React.createElement('label', { key: 'reasoning' }, ['Reasoning effort', reasoning.length ? React.createElement('select', { key: 'input', value: profile.reasoningEffort || '', onChange: function (event) { update(index, { reasoningEffort: event.target.value }) } }, [React.createElement('option', { key: 'empty', value: '' }, '不设置'), reasoning.map(function (item) { return React.createElement('option', { key: item, value: item }, item) })]) : React.createElement('span', { key: 'empty', className: 'gjo-muted' }, '当前 Codex capability 未公布可选值')]) : null,
            React.createElement('label', { key: 'permission' }, ['Permission mode', React.createElement('select', { key: 'input', value: profile.permissionMode || 'default', onChange: function (event) { update(index, { permissionMode: event.target.value }) } }, [React.createElement('option', { key: 'default', value: 'default' }, 'default'), React.createElement('option', { key: 'never', value: 'never' }, 'never'), React.createElement('option', { key: 'approve', value: 'approve-for-me' }, 'approve-for-me')])]),
            React.createElement('label', { key: 'persona' }, ['Persona', React.createElement('textarea', { key: 'input', rows: 3, value: profile.persona || '', onChange: function (event) { update(index, { persona: event.target.value }) } } )]),
            React.createElement('p', { key: 'caps', className: 'gjo-muted' }, '工具 ' + ((profile.capabilities && profile.capabilities.tools || []).join(', ') || '无') + ' · Skills ' + ((profile.capabilities && profile.capabilities.skills || []).join(', ') || '无') + (profile.executor === 'codex' ? ' · reasoningEffort 由 capability 校验' : ''))
          ])
        }))
      ])
    }

    var CSS = `
.gjo-shell,.gjo-settings{height:100%;min-height:0;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base,var(--dsh-surface,#17191f));color:var(--dsw-alias-label-primary,var(--dsh-text,#e7e9ee));font:13px/1.5 var(--dsh-font,Inter,system-ui,sans-serif)}
.gjo-shell{display:flex;flex-direction:column;overflow:hidden}.gjo-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:16px 22px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsh-border,#2b2f38));background:var(--dsw-alias-bg-layer-1,#ffffff04)}.gjo-header h2,.gjo-settings h2{margin:2px 0 2px;font-size:19px;letter-spacing:-.02em}.gjo-header p,.gjo-settings p{margin:0;color:var(--dsw-alias-label-secondary,var(--dsh-muted,#9ea5b1));font-size:11px}.gjo-eyebrow{color:var(--dsw-alias-label-secondary,#8f96a3);font-size:10px;letter-spacing:.11em;text-transform:uppercase}.gjo-header-actions,.gjo-run-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.gjo-primary,.gjo-secondary,.gjo-node-actions button,.gjo-palette button,.gjo-edge-list button{border:1px solid var(--dsw-alias-border-l2,#30343e);border-radius:7px;padding:7px 11px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px}.gjo-primary{border-color:var(--dsw-alias-button-info-fill,#356fe5);background:var(--dsw-alias-button-info-fill,#356fe5);color:var(--dsw-alias-label-primary-foreground,#fff)}.gjo-primary:hover{background:var(--dsw-alias-button-info-hover,#4f8cff)}.gjo-secondary:hover,.gjo-node-actions button:hover,.gjo-palette button:hover,.gjo-edge-list button:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0d);border-color:var(--dsw-alias-state-business-primary,#4f8cff)}button:disabled{cursor:not-allowed;opacity:.45}.gjo-goal-bar{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px 22px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f38)}.gjo-goal-bar label{color:var(--dsw-alias-label-secondary,#9ea5b1);font-size:11px}.gjo-goal-bar textarea,.gjo-inspector input,.gjo-inspector textarea,.gjo-inspector select,.gjo-settings input,.gjo-settings textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2,#30343e);border-radius:7px;background:var(--dsw-specific-input-major,#101217);color:inherit;padding:7px 9px;font:inherit;font-size:12px;resize:vertical}.gjo-limit-copy{color:var(--dsw-alias-label-secondary,#858c99);font:11px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}.gjo-error,.gjo-message,.gjo-validation{margin:10px 22px 0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary,#a44646);border-radius:7px;background:var(--dsw-alias-interactive-bg-hover-danger,#a4464618);color:var(--dsw-alias-state-error-primary,#ffb2b2);font-size:12px}.gjo-message{border-color:var(--dsw-alias-state-business-primary,#356fe5);background:var(--dsw-alias-state-business-tertiary,#356fe518);color:var(--dsw-alias-label-primary,#a9c6ff)}.gjo-preview-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 22px 0;padding:9px 11px;border:1px solid var(--dsw-alias-state-business-primary,#4f8cff);border-radius:8px;background:var(--dsw-alias-state-business-tertiary,#356fe514)}.gjo-preview-bar span{margin-left:8px;color:var(--dsw-alias-label-secondary,#9ea5b1);font-size:11px}.gjo-main{display:grid;grid-template-columns:minmax(0,1fr) 276px;gap:0;min-height:0;flex:1}.gjo-canvas-wrap{min-width:0;display:flex;flex-direction:column;overflow:hidden}.gjo-palette{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f38);color:var(--dsw-alias-label-secondary,#9ea5b1);font-size:11px}.gjo-palette button{padding:5px 8px}.gjo-muted{color:var(--dsw-alias-label-secondary,#858c99);font-size:11px}.gjo-palette .gjo-muted{margin-left:auto}.gjo-canvas{position:relative;min-height:390px;flex:1;overflow:auto;background-image:linear-gradient(var(--dsw-alias-border-l2,#ffffff06) 1px,transparent 1px),linear-gradient(90deg,var(--dsw-alias-border-l2,#ffffff06) 1px,transparent 1px);background-size:24px 24px;background-color:var(--dsw-alias-bg-base,#17191f)}.gjo-edges{position:absolute;inset:0;min-width:760px;min-height:600px;overflow:visible;color:var(--dsw-alias-state-business-primary,#5d91ff);pointer-events:none}.gjo-edge{fill:none;stroke:currentColor;stroke-width:1.6;opacity:.8}.gjo-root-node,.gjo-node{position:absolute;z-index:1;width:174px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#30343e);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#1d2028);box-shadow:0 5px 15px #0003}.gjo-root-node{width:52px;padding:5px 4px;text-align:center;border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#9ec0ff);font:9px ui-monospace,monospace}.gjo-node{padding:9px;cursor:grab}.gjo-node:active{cursor:grabbing}.gjo-node.is-selected{border-color:var(--dsw-alias-state-business-primary,#4f8cff);box-shadow:0 0 0 2px var(--dsw-alias-state-business-tertiary,#4f8cff22),0 6px 18px #0004}.gjo-node-head{display:flex;align-items:flex-start;gap:7px;min-height:25px}.gjo-node-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.gjo-kind{flex:none;padding:2px 4px;border-radius:4px;background:var(--dsw-alias-state-business-tertiary,#356fe522);color:var(--dsw-alias-state-business-primary,#9ec0ff);font:9px ui-monospace,monospace}.gjo-node-meta{display:flex;justify-content:space-between;gap:5px;margin-top:7px;color:var(--dsw-alias-label-secondary,#9ea5b1);font-size:10px}.gjo-node-meta span:last-child{max-width:94px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gjo-node-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:7px}.gjo-node-actions button{padding:3px 6px;font-size:10px}.gjo-inspector{overflow:auto;padding:15px;border-left:1px solid var(--dsw-alias-border-l2,#2b2f38);background:var(--dsw-alias-bg-layer-1,#ffffff04)}.gjo-inspector-head,.gjo-settings-head,.gjo-run-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.gjo-inspector-head h3{margin:3px 0 15px;font-size:15px}.gjo-inspector-head button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9ea5b1);font-size:19px;cursor:pointer}.gjo-inspector label,.gjo-settings label{display:flex;flex-direction:column;gap:5px;margin:11px 0;color:var(--dsw-alias-label-secondary,#a0a6b2);font-size:11px}.gjo-note{padding:8px;border-radius:7px;background:var(--dsw-alias-state-success-tertiary,#13b88714);color:var(--dsw-alias-state-success-primary,#8fd9c4);font-size:11px}.gjo-edge-list{margin-top:16px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,#30343e)}.gjo-edge-list h4{margin:0 0 7px;color:var(--dsw-alias-label-secondary,#9ea5b1);font-size:11px}.gjo-edge-list button{display:block;width:100%;margin:5px 0;text-align:left;padding:5px 7px;font-size:10px}.gjo-run-card{flex:none;margin:10px 22px 18px;padding:12px;border:1px solid var(--dsw-alias-border-l2,#30343e);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#ffffff04)}.gjo-status{display:inline-block;margin-top:4px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#ffffff0b);font-size:11px}.gjo-status[data-status=running]{background:var(--dsw-alias-state-business-tertiary,#4f8cff22);color:var(--dsw-alias-state-business-primary,#9ec0ff)}.gjo-status[data-status=completed]{background:var(--dsw-alias-state-success-tertiary,#13b88722);color:var(--dsw-alias-state-success-primary,#7ce0c3)}.gjo-status[data-status=paused],.gjo-status[data-status=failed]{background:var(--dsw-alias-interactive-bg-hover-danger,#a4464618);color:var(--dsw-alias-state-error-primary,#ff9e9e)}.gjo-run-nodes{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.gjo-run-node{display:flex;align-items:center;gap:5px;max-width:240px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,#30343e);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#0002);font-size:10px}.gjo-run-node span:first-child{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary,#858c99)}.gjo-run-node[data-status=succeeded]{border-color:var(--dsw-alias-state-success-primary,#13b88788)}.gjo-run-node[data-status=succeeded] span:first-child{background:var(--dsw-alias-state-success-primary,#13b887)}.gjo-run-node[data-status=failed]{border-color:var(--dsw-alias-state-error-primary,#a44646)}.gjo-run-node[data-status=running]{border-color:var(--dsw-alias-state-business-primary,#4f8cff)}.gjo-run-node em{margin-left:auto;color:var(--dsw-alias-label-secondary,#9ea5b1);font-style:normal}.gjo-run-node small{display:none}.gjo-empty{display:grid;place-content:center;text-align:center;padding:40px;overflow:auto}.gjo-empty h2{margin:14px 0 4px;font-size:19px}.gjo-empty p{max-width:440px;margin:0 auto 15px;color:var(--dsw-alias-label-secondary,#9ea5b1)}.gjo-icon{display:grid;place-items:center;width:46px;height:46px;margin:auto;border-radius:14px;background:var(--dsw-alias-state-business-tertiary,#4f8cff22);color:var(--dsw-alias-state-business-primary,#9ec0ff);font-size:25px}.gjo-settings{padding:22px;overflow:auto}.gjo-settings-head{max-width:880px;margin-bottom:18px}.gjo-profile-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;max-width:880px}.gjo-profile-card{padding:12px;border:1px solid var(--dsw-alias-border-l2,#30343e);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#ffffff04)}.gjo-profile-top{display:flex;justify-content:space-between;align-items:center}.gjo-pill{padding:3px 6px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,#356fe522);color:var(--dsw-alias-state-business-primary,#9ec0ff);font:10px ui-monospace,monospace}.gjo-validation{margin:10px 0 0}.gjo-validation.is-valid{border-color:var(--dsw-alias-state-success-primary,#13b887);background:var(--dsw-alias-state-success-tertiary,#13b88714);color:var(--dsw-alias-state-success-primary,#8fd9c4)}.gjo-validation-error,.gjo-validation-warning{margin-top:4px}.gjo-validation-warning{color:var(--dsw-alias-state-warn-label,#ffc383)}
@media(max-width:820px){.gjo-main{grid-template-columns:1fr}.gjo-inspector{border-left:0;border-top:1px solid var(--dsw-alias-border-l2,#2b2f38);max-height:330px}.gjo-header{padding:13px}.gjo-goal-bar{grid-template-columns:1fr;padding:10px 13px}.gjo-limit-copy{white-space:normal}.gjo-preview-bar{margin-left:13px;margin-right:13px}.gjo-run-card{margin-left:13px;margin-right:13px}}
`

    function activateConversationView() {
      var labels = ['Graph Job', '任务图']
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'))
      var target = tabs.filter(function (tab) { var label = String(tab.textContent || '').trim(); return labels.some(function (expected) { return label === expected || label.indexOf(expected) >= 0 }) })[0]
      if (!target || typeof target.click !== 'function') return false
      target.click()
      return true
    }

    function headerAction() { return React.createElement('button', { type: 'button', className: 'gjo-secondary', onClick: activateConversationView }, 'Graph Job') }

    function apply(ctx) {
      sessionsService = ctx.sessions || (ctx.get && ctx.get('sessions'))
      ctx.effect(function () { var style = document.createElement('style'); style.dataset.plugin = PLUGIN_ID; style.textContent = CSS; document.head.appendChild(style); return function () { style.remove() } })
      ctx.effect(function () {
        function onDesktopMessage(event) {
          if (event.source !== window.parent) return
          var data = event.data
          if (data && data.source === 'dsh-desktop' && data.type === 'plugin-rpc' && data.pluginId === PLUGIN_ID && data.method === DESKTOP_RPC_METHOD) activateConversationView()
        }
        window.addEventListener('message', onDesktopMessage)
        return function () { window.removeEventListener('message', onDesktopMessage) }
      })
      ctx.slots.inject('conversation.view', function () { return ctx.slots.register({ name: 'conversation.view', id: 'graph-job-orchestrator', order: 35, label: 'Graph Job' }, function (props) { return React.createElement(GraphJobView, props) }) })
      ctx.slots.inject('settings.section', function () { return ctx.slots.register({ name: 'settings.section', id: 'graph-job-orchestrator', order: 75, label: 'Graph Job' }, function () { return React.createElement(ProfileSettingsV2) }) })
      ctx.slots.inject('conversation.session.header.actions', function () { return ctx.slots.register({ name: 'conversation.session.header.actions', id: 'graph-job-orchestrator', order: 35, label: 'Graph Job' }, headerAction) })
    }

    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    exports.activateConversationView = activateConversationView
    exports.layoutGraph = layoutGraph
    exports.edgePath = edgePath
    exports.statusLabel = statusLabel
    return module.exports
  }
})
