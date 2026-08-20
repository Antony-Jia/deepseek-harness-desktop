// 多 Agent 讨论 — browser half
//
// The host owns orchestration and child sessions. This module only renders the
// session-scoped view, keeps a small per-session projection cache, and talks to
// the plugin's same-origin HTTP/SSE bridge. It deliberately uses React nodes
// for Markdown instead of innerHTML so model output is always escaped.
window.__ModuleLoader__.load({
  id: '@p-dsh-market/multi-agent-roundtable',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var PLUGIN_ID = '@p-dsh-market/multi-agent-roundtable'
    var DESKTOP_RPC_METHOD = 'multiAgentRoundtable.open'
    var BASE = '/multi-agent-roundtable'
    var stores = Object.create(null)
    var configStore = { value: null, version: 0, loading: false, error: '', listeners: [] }
    var overlayState = { open: false, directSessionId: '', version: 0, listeners: [] }

    function conversationModeStorageKey(sessionId) {
      return 'dsh:multi-agent-roundtable:mode:' + sessionKey(sessionId)
    }

    function readConversationMode(sessionId) {
      try { return window.localStorage.getItem(conversationModeStorageKey(sessionId)) === 'on' } catch (_) { return false }
    }

    function writeConversationMode(sessionId, enabled) {
      try { window.localStorage.setItem(conversationModeStorageKey(sessionId), enabled ? 'on' : 'off') } catch (_) {}
    }

    // rc.7 keeps the active view in ui-conversation's private per-session store.
    // Third-party views do not receive that store's actions, so the supported
    // tab affordance is used as the narrowest bridge: role=tab is the runtime's
    // public accessibility contract and avoids relying on generated CSS names.
    function activateConversationView(enabled) {
      var labels = enabled ? ['多 Agent 讨论', 'Multi-Agent'] : ['聊天', 'Chat']
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'))
      var target = tabs.filter(function (tab) {
        var label = String(tab.textContent || '').trim()
        return labels.some(function (expected) { return label === expected || label.indexOf(expected) >= 0 })
      })[0]
      if (!target || typeof target.click !== 'function') return false
      target.click()
      return true
    }

    function currentConversationMode(sessionId) {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'))
      var selected = tabs.filter(function (tab) {
        return typeof tab.getAttribute === 'function' && tab.getAttribute('aria-selected') === 'true'
      })[0]
      if (selected) {
        var label = String(selected.textContent || '').trim()
        return label.indexOf('多 Agent') >= 0 || label.indexOf('Multi-Agent') >= 0
      }
      return readConversationMode(sessionId)
    }

    function announceDesktop(type, payload) {
      if (window.parent === window) return
      window.parent.postMessage(Object.assign({ source: PLUGIN_ID, type: type }, payload || {}), '*')
    }

    function setOverlayOpen(open) {
      var next = open === true
      if (overlayState.open === next) return
      overlayState.open = next
      overlayState.version += 1
      overlayState.listeners.slice().forEach(function (listener) { try { listener() } catch (_) {} })
      announceDesktop('roundtable-panel-state', { open: next })
    }

    function setDirectConversationMode(sessionId, enabled) {
      var next = enabled ? sessionKey(sessionId) : ''
      if (overlayState.directSessionId === next) return
      overlayState.directSessionId = next
      overlayState.version += 1
      overlayState.listeners.slice().forEach(function (listener) { try { listener() } catch (_) {} })
    }

    function useOverlayState() {
      var pair = React.useState(overlayState.version)
      var setVersion = pair[1]
      React.useEffect(function () {
        var listener = function () { setVersion(overlayState.version) }
        overlayState.listeners.push(listener)
        return function () { overlayState.listeners = overlayState.listeners.filter(function (item) { return item !== listener }) }
      }, [])
      return overlayState
    }

    function publishConfig(value) {
      configStore.value = value
      configStore.version += 1
      configStore.error = ''
      configStore.listeners.slice().forEach(function (listener) { try { listener() } catch (_) {} })
      Object.keys(stores).forEach(function (key) {
        stores[key].config = value
        notify(stores[key])
      })
    }

    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }

    function notify(store) {
      store.version += 1
      var listeners = store.listeners ? store.listeners.slice() : []
      listeners.forEach(function (listener) { try { listener() } catch (_) {} })
    }

    function subscribe(store, listener) {
      if (!store.listeners) store.listeners = []
      store.listeners.push(listener)
      return function () { store.listeners = store.listeners.filter(function (item) { return item !== listener }) }
    }

    function sessionKey(value) {
      var result = String(value || 'active').trim()
      return result || 'active'
    }

    function discussionStorageKey(sessionId) {
      return 'dsh:multi-agent-roundtable:discussion:' + sessionKey(sessionId)
    }

    function conversationStorageKey(sessionId) {
      return 'dsh:multi-agent-roundtable:conversation:' + sessionKey(sessionId)
    }

    function readConversationId(sessionId) {
      try { return window.localStorage.getItem(conversationStorageKey(sessionId)) || '' } catch (_) { return '' }
    }

    function writeConversationId(sessionId, id) {
      try {
        if (id) window.localStorage.setItem(conversationStorageKey(sessionId), id)
        else window.localStorage.removeItem(conversationStorageKey(sessionId))
      } catch (_) {}
    }

    function readDiscussionId(sessionId) {
      try { return window.localStorage.getItem(discussionStorageKey(sessionId)) || '' } catch (_) { return '' }
    }

    function writeDiscussionId(sessionId, id) {
      try {
        var key = discussionStorageKey(sessionId)
        if (id) window.localStorage.setItem(key, id)
        else window.localStorage.removeItem(key)
      } catch (_) {}
    }

    function getStore(sessionId) {
      var key = sessionKey(sessionId)
      if (!stores[key]) {
        stores[key] = {
          sessionId: key,
          version: 0,
          config: null,
          conversation: null,
          conversations: [],
          discussion: null,
          loading: false,
          loaded: false,
          busy: false,
          error: '',
          streamStatus: 'offline',
          stream: null,
          pollTimer: null,
          listeners: []
        }
      }
      return stores[key]
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

    function setError(store, error) {
      store.error = error && error.message ? error.message : String(error || '')
      notify(store)
    }

    function applyDiscussion(store, discussion) {
      store.discussion = discussion || null
      if (discussion && store.conversation) store.conversation.discussionId = discussion.id
      if (discussion && discussion.id) writeDiscussionId(store.sessionId, discussion.id)
      if (!discussion) writeDiscussionId(store.sessionId, '')
      notify(store)
    }

    async function loadSelectedConversation(store, conversation) {
      closeStream(store)
      store.conversation = conversation || null
      store.discussion = null
      writeConversationId(store.sessionId, conversation ? conversation.id : '')
      if (conversation && conversation.discussionId) {
        var discussionBody = await request('/discussions/' + encodeURIComponent(conversation.discussionId))
        store.discussion = discussionBody.discussion
        connectStream(store)
      }
      notify(store)
      return conversation
    }

    async function refreshConversations(store, createWhenMissing) {
      var boundSessionId = store.sessionId === 'active' ? '' : store.sessionId
      var body = await request('/conversations?boundSessionId=' + encodeURIComponent(boundSessionId))
      store.conversations = body.conversations || []
      var preferredId = readConversationId(store.sessionId)
      var selected = store.conversations.filter(function (item) { return item.id === preferredId })[0]
      if (!selected && body.suggestedId) selected = store.conversations.filter(function (item) { return item.id === body.suggestedId })[0]
      if (!selected && createWhenMissing) {
        var created = await request('/conversations', { method: 'POST', body: { boundSessionId: boundSessionId } })
        selected = created.conversation
        store.conversations.unshift(selected)
      }
      await loadSelectedConversation(store, selected || null)
      return selected
    }

    async function selectConversation(store, id) {
      if (!id || store.busy) return
      var conversation = store.conversations.filter(function (item) { return item.id === id })[0]
      if (!conversation) return
      store.busy = true
      store.error = ''
      notify(store)
      try { await loadSelectedConversation(store, conversation) } catch (error) { setError(store, error) }
      finally { store.busy = false; notify(store) }
    }

    async function newConversation(store) {
      if (store.busy) return
      store.busy = true
      store.error = ''
      notify(store)
      try {
        var boundSessionId = store.sessionId === 'active' ? '' : store.sessionId
        var body = await request('/conversations', { method: 'POST', body: { boundSessionId: boundSessionId } })
        store.conversations.unshift(body.conversation)
        await loadSelectedConversation(store, body.conversation)
      } catch (error) { setError(store, error) }
      finally { store.busy = false; notify(store) }
    }

    function stopPolling(store) {
      if (store.pollTimer) window.clearInterval(store.pollTimer)
      store.pollTimer = null
    }

    function closeStream(store) {
      stopPolling(store)
      if (store.stream) {
        try { store.stream.close() } catch (_) {}
      }
      store.stream = null
    }

    function refreshDiscussion(store) {
      if (!store.discussion || !store.discussion.id) return Promise.resolve(null)
      return request('/discussions/' + encodeURIComponent(store.discussion.id))
        .then(function (body) {
          applyDiscussion(store, body.discussion)
          return body.discussion
        })
        .catch(function (error) { setError(store, error); return null })
    }

    function connectStream(store) {
      closeStream(store)
      if (!store.discussion || !store.discussion.id || typeof window.EventSource !== 'function') {
        store.streamStatus = 'offline'
        notify(store)
        return
      }
      var id = store.discussion.id
      var since = Number(store.discussion.lastEventId || 0)
      var source = new window.EventSource(BASE + '/discussions/' + encodeURIComponent(id) + '/events?since=' + since)
      store.stream = source
      store.streamStatus = 'connecting'
      notify(store)
      function accept(event) {
        try {
          var payload = JSON.parse(event.data || '{}')
          if (payload.discussion) applyDiscussion(store, payload.discussion)
        } catch (error) { setError(store, error) }
      }
      source.addEventListener('snapshot', accept)
      source.addEventListener('update', accept)
      source.onopen = function () {
        store.streamStatus = 'live'
        stopPolling(store)
        notify(store)
      }
      source.onerror = function () {
        store.streamStatus = 'polling'
        notify(store)
        if (!store.pollTimer) {
          store.pollTimer = window.setInterval(function () {
            refreshDiscussion(store)
            if (store.discussion && ['completed', 'cancelled', 'failed'].indexOf(store.discussion.status) >= 0) stopPolling(store)
          }, 4000)
        }
      }
    }

    async function loadStore(store) {
      if (store.loading) return
      store.loading = true
      store.error = ''
      notify(store)
      try {
        var configBody = await request('/config')
        store.config = configBody.config
        publishConfig(configBody.config)
        await refreshConversations(store, true)
        store.loaded = true
      } catch (error) {
        store.error = error && error.message ? error.message : String(error)
      } finally {
        store.loading = false
        notify(store)
      }
    }

    async function createDiscussion(store, input) {
      store.busy = true
      store.error = ''
      notify(store)
      try {
        var body = await request('/discussions', { method: 'POST', body: input })
        if (body.conversation) {
          store.conversation = body.conversation
          var index = store.conversations.findIndex(function (item) { return item.id === body.conversation.id })
          if (index >= 0) store.conversations[index] = body.conversation
          else store.conversations.unshift(body.conversation)
        }
        applyDiscussion(store, body.discussion)
        connectStream(store)
        return body.discussion
      } catch (error) {
        setError(store, error)
        return null
      } finally {
        store.busy = false
        notify(store)
      }
    }

    async function continueDiscussion(store, content) {
      if (!store.discussion) return null
      store.busy = true
      store.error = ''
      notify(store)
      try {
        var body = await request('/discussions/' + encodeURIComponent(store.discussion.id) + '/messages', {
          method: 'POST', body: { content: content }
        })
        applyDiscussion(store, body.discussion)
        connectStream(store)
        return body.discussion
      } catch (error) {
        setError(store, error)
        return null
      } finally {
        store.busy = false
        notify(store)
      }
    }

    async function cancelDiscussion(store, roleId) {
      if (!store.discussion) return null
      store.busy = true
      store.error = ''
      notify(store)
      try {
        var body = await request('/discussions/' + encodeURIComponent(store.discussion.id) + '/cancel', { method: 'POST', body: roleId ? { roleId: roleId } : {} })
        applyDiscussion(store, body.discussion)
        if (!roleId) closeStream(store)
        else connectStream(store)
        return body.discussion
      } catch (error) {
        setError(store, error)
        return null
      } finally {
        store.busy = false
        notify(store)
      }
    }

    function useRoundtableStore(sessionId) {
      var store = getStore(sessionId)
      var pair = React.useState(store.version)
      var setVersion = pair[1]
      React.useEffect(function () {
        var off = subscribe(store, function () { setVersion(store.version) })
        if (!store.loaded) loadStore(store)
        return off
      }, [store])
      return store
    }

    function sessionIdFromSnapshot(snapshot) {
      if (!snapshot) return 'active'
      var current = snapshot.current || snapshot.currentId || snapshot.sessionId
      if (typeof current === 'string' && current) return current
      if (current && typeof current === 'object' && current.id) return String(current.id)
      return 'active'
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

    function useConfigStore() {
      var pair = React.useState(configStore.version)
      var setVersion = pair[1]
      React.useEffect(function () {
        var off = subscribe(configStore, function () { setVersion(configStore.version) })
        if (!configStore.value && !configStore.loading) {
          configStore.loading = true
          request('/config').then(function (body) {
            publishConfig(body.config)
          }).catch(function (error) {
            configStore.error = error && error.message ? error.message : String(error)
          }).finally(function () {
            configStore.loading = false
            notify(configStore)
          })
        }
        return off
      }, [])
      return configStore
    }

    function safeHref(value) {
      var href = String(value || '').trim()
      if (!href) return '#'
      if (href.charAt(0) === '#') return href
      try {
        var url = new URL(href, window.location.href)
        if (['http:', 'https:', 'mailto:'].indexOf(url.protocol) < 0) return '#'
        return url.href
      } catch (_) { return '#' }
    }

    function inlineMarkdown(value, prefix) {
      var source = String(value || '')
      var pattern = /(\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g
      var result = []
      var last = 0
      var match
      var index = 0
      while ((match = pattern.exec(source))) {
        if (match.index > last) result.push(source.slice(last, match.index))
        if (match[1] && match[2]) {
          result.push(React.createElement('a', { key: prefix + index++, href: safeHref(match[3]), target: '_blank', rel: 'noopener noreferrer' }, match[2]))
        } else if (match[4]) {
          result.push(React.createElement('code', { key: prefix + index++ }, match[4]))
        } else if (match[5] || match[6]) {
          result.push(React.createElement('strong', { key: prefix + index++ }, match[5] || match[6]))
        } else {
          result.push(React.createElement('em', { key: prefix + index++ }, match[7] || match[8]))
        }
        last = pattern.lastIndex
      }
      if (last < source.length) result.push(source.slice(last))
      return result
    }

    function markdownBlocks(value) {
      var lines = String(value || '').replace(/\r\n/g, '\n').split('\n')
      var blocks = []
      var paragraph = []
      var list = []
      var quote = []
      var code = null
      var codeLines = []
      var consumedThrough = -1
      var tableDivider = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/
      var flushParagraph = function () {
        if (paragraph.length) blocks.push({ type: 'paragraph', lines: paragraph.splice(0) })
      }
      var flushList = function () {
        if (list.length) blocks.push({ type: 'list', ordered: list[0].ordered, items: list.splice(0).map(function (item) { return item.text }) })
      }
      var flushQuote = function () {
        if (quote.length) blocks.push({ type: 'quote', lines: quote.splice(0) })
      }
      lines.forEach(function (line, lineIndex) {
        if (lineIndex <= consumedThrough) return
        var fence = /^\s*```\s*([\w-]*)\s*$/.exec(line)
        if (code !== null) {
          if (fence) {
            blocks.push({ type: 'code', language: code, text: codeLines.join('\n') })
            code = null
            codeLines = []
          } else codeLines.push(line)
          return
        }
        if (fence) {
          flushParagraph(); flushList(); flushQuote()
          code = fence[1] || 'text'
          return
        }
        if (line.indexOf('|') >= 0 && tableDivider.test(lines[lineIndex + 1] || '')) {
          flushParagraph(); flushList(); flushQuote()
          var rows = [line, lines[lineIndex + 1]]
          var rowIndex = lineIndex + 2
          while (rowIndex < lines.length && lines[rowIndex].indexOf('|') >= 0 && lines[rowIndex].trim()) {
            rows.push(lines[rowIndex])
            rowIndex += 1
          }
          blocks.push({ type: 'table', rows: rows })
          consumedThrough = rowIndex - 1
          return
        }
        var heading = /^(#{1,6})\s+(.+)$/.exec(line)
        if (heading) {
          flushParagraph(); flushList(); flushQuote()
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
          return
        }
        var quoteLine = /^\s*>\s?(.*)$/.exec(line)
        if (quoteLine) {
          flushParagraph(); flushList(); quote.push(quoteLine[1]); return
        }
        var item = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(line)
        if (item) {
          flushParagraph(); flushQuote()
          list.push({ ordered: /^\s*\d/.test(line), text: item[1] }); return
        }
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
          flushParagraph(); flushList(); flushQuote(); blocks.push({ type: 'rule' }); return
        }
        if (!line.trim()) {
          flushParagraph(); flushList(); flushQuote(); return
        }
        flushList(); flushQuote(); paragraph.push(line)
      })
      if (code !== null) blocks.push({ type: 'code', language: code, text: codeLines.join('\n') })
      flushParagraph(); flushList(); flushQuote()
      return blocks
    }

    function MarkdownView(props) {
      var blocks = markdownBlocks(props && props.text)
      return React.createElement('div', { className: 'mar-markdown' }, blocks.map(function (block, index) {
        var key = 'md-' + index
        if (block.type === 'heading') {
          var tag = 'h' + Math.min(6, Math.max(1, block.level))
          return React.createElement(tag, { key: key }, inlineMarkdown(block.text, key + '-'))
        }
        if (block.type === 'paragraph') return React.createElement('p', { key: key }, inlineMarkdown(block.lines.join('\n'), key + '-'))
        if (block.type === 'quote') return React.createElement('blockquote', { key: key }, inlineMarkdown(block.lines.join('\n'), key + '-'))
        if (block.type === 'rule') return React.createElement('hr', { key: key })
        if (block.type === 'code') return React.createElement('pre', { key: key, className: 'mar-code' }, React.createElement('code', null, block.text))
        if (block.type === 'table') {
          var cells = function (row) {
            return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim() })
          }
          var header = cells(block.rows[0])
          var body = block.rows.slice(2).map(cells)
          return React.createElement('div', { key: key, className: 'mar-table-wrap' }, React.createElement('table', { className: 'mar-table' }, [
            React.createElement('thead', { key: 'head' }, React.createElement('tr', null, header.map(function (cell, cellIndex) { return React.createElement('th', { key: cellIndex }, inlineMarkdown(cell, key + '-h' + cellIndex + '-')) }))),
            React.createElement('tbody', { key: 'body' }, body.map(function (row, rowIndex) { return React.createElement('tr', { key: rowIndex }, row.map(function (cell, cellIndex) { return React.createElement('td', { key: cellIndex }, inlineMarkdown(cell, key + '-r' + rowIndex + '-' + cellIndex + '-')) })) }))
          ]))
        }
        var listTag = block.ordered ? 'ol' : 'ul'
        return React.createElement(listTag, { key: key }, block.items.map(function (item, itemIndex) {
          return React.createElement('li', { key: key + '-' + itemIndex }, inlineMarkdown(item, key + '-' + itemIndex + '-'))
        }))
      }))
    }

    function RoleChip(props) {
      var role = props.role
      var active = props.active
      return React.createElement('button', {
        type: 'button',
        className: 'mar-role-chip',
        'data-active': active ? 'true' : 'false',
        disabled: role.enabled === false,
        onClick: props.onClick,
        title: role.enabled === false ? '该角色已在设置中禁用' : role.prompt
      }, [
        React.createElement('span', { key: 'dot', className: 'mar-role-dot', style: { backgroundColor: role.color } }),
        React.createElement('span', { key: 'name' }, role.name),
        active ? React.createElement('span', { key: 'check', className: 'mar-chip-check' }, '✓') : null
      ])
    }

    function StatusPill(props) {
      var status = props.status || 'created'
      var labels = { created: '待开始', running: '进行中', completed: '已完成', cancelled: '已停止', failed: '失败' }
      return React.createElement('span', { className: 'mar-status', 'data-status': status }, labels[status] || status)
    }

    function ParticipantStrip(props) {
      var participants = props.participants || []
      return React.createElement('div', { className: 'mar-participants' }, participants.map(function (participant) {
        return React.createElement('div', { key: participant.roleId, className: 'mar-participant', 'data-status': participant.status, title: participant.error || '' }, [
          React.createElement('span', { key: 'dot', className: 'mar-role-dot', style: { backgroundColor: participant.color } }),
          React.createElement('span', { key: 'name' }, participant.roleName),
          React.createElement('span', { key: 'state', className: 'mar-participant-state' }, participant.status === 'running' ? '思考中' : participant.status === 'completed' ? '完成' : participant.status === 'failed' ? '失败' : participant.status === 'cancelled' ? '已停止' : '等待'),
          participant.status === 'running' && props.onCancel ? React.createElement('button', { key: 'cancel', type: 'button', className: 'mar-participant-cancel', onClick: function () { props.onCancel(participant.roleId) }, title: '停止此角色' }, '停止') : null
        ])
      }))
    }

    function MessageCard(props) {
      var message = props.message
      var own = message.roleId === 'user'
      var name = message.roleName || message.roleId
      var content = message.content || (message.status === 'streaming' ? '正在生成正式回答…' : '（暂时没有文字输出）')
      var collapsedPair = React.useState(function () { return !own && content.length > 2400 })
      var collapsed = collapsedPair[0]
      var setCollapsed = collapsedPair[1]
      return React.createElement('article', { className: 'mar-message', 'data-status': message.status, 'data-role': message.roleId, 'data-own': own ? 'true' : 'false' }, [
        !own ? React.createElement('span', { key: 'avatar', className: 'mar-avatar', style: { backgroundColor: message.color } }, String(name || '?').slice(0, 1)) : null,
        React.createElement('div', { key: 'column', className: 'mar-message-column' }, [
          React.createElement('header', { key: 'header', className: 'mar-message-head' }, [
            React.createElement('strong', { key: 'role' }, name),
            React.createElement('span', { key: 'round', className: 'mar-message-round' }, message.round ? '第 ' + message.round + ' 轮' : ''),
            message.status === 'streaming' ? React.createElement('span', { key: 'streaming', className: 'mar-streaming' }, '正在输入…') : null,
            React.createElement('button', { key: 'collapse', type: 'button', className: 'mar-message-toggle', onClick: function () { setCollapsed(!collapsed) }, 'aria-expanded': collapsed ? 'false' : 'true' }, collapsed ? '展开消息' : '收起消息')
          ]),
          !collapsed ? React.createElement('div', { key: 'bubble', className: 'mar-message-bubble' }, [
            message.reasoning ? React.createElement('details', { key: 'reasoning', className: 'mar-reasoning' }, [
              React.createElement('summary', { key: 'summary' }, '思考过程'),
              React.createElement('div', { key: 'content', className: 'mar-reasoning-content' }, React.createElement(MarkdownView, { text: message.reasoning }))
            ]) : null,
            React.createElement(MarkdownView, { key: 'answer', text: content })
          ]) : null
        ]),
        own ? React.createElement('span', { key: 'avatar', className: 'mar-avatar mar-avatar-user' }, '我') : null
      ])
    }

    function DiscussionToolbar(props) {
      var config = props.config
      var form = props.form
      var setForm = props.setForm
      var discussion = props.discussion
      var running = discussion && discussion.status === 'running'
      var roles = (config && config.roles) || []
      var teams = (config && config.teams) || []
      var enabledRoles = roles.filter(function (role) { return role.enabled !== false })
      var hostRole = enabledRoles.filter(function (role) { return role.id === 'facilitator' })[0] || enabledRoles[0]
      function update(patch) { setForm(Object.assign({}, form, patch)) }
      function toggleRole(roleId) {
        var selected = form.participantIds.slice()
        var index = selected.indexOf(roleId)
        if (index >= 0) selected.splice(index, 1)
        else selected.push(roleId)
        update({ participantIds: selected })
      }
      function useTeam(teamId) {
        var team = teams.filter(function (item) { return item.id === teamId })[0]
        update({ teamId: teamId, participantIds: team ? team.participantIds.slice() : form.participantIds })
      }
      return React.createElement('section', { className: 'mar-toolbar' }, [
        React.createElement('div', { key: 'topic', className: 'mar-topic-row' }, [
          React.createElement('textarea', { key: 'prompt', className: 'mar-topic-input', value: form.prompt, rows: 2, onChange: function (event) { update({ prompt: event.target.value }) }, placeholder: discussion ? '继续追问或补充新的约束…' : '输入要让多个 Agent 共同讨论的问题…', onKeyDown: function (event) { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); props.onSubmit() } } }),
          React.createElement('button', { key: 'submit', type: 'button', className: 'mar-primary', onClick: props.onSubmit, disabled: props.disabled || !form.prompt.trim() }, discussion ? '继续讨论' : '开始讨论')
        ]),
        React.createElement('div', { key: 'controls', className: 'mar-control-row' }, [
          React.createElement('label', { key: 'mode', className: 'mar-control' }, [React.createElement('span', { key: 'label' }, '模式'), React.createElement('select', { key: 'select', value: form.mode, disabled: running, onChange: function (event) { update({ mode: event.target.value }) } }, [
            React.createElement('option', { key: 'review', value: 'review' }, '交叉评审'),
            React.createElement('option', { key: 'independent', value: 'independent' }, '独立回答'),
            React.createElement('option', { key: 'host', value: 'host' }, '主持人总结')
          ])]),
          React.createElement('label', { key: 'rounds', className: 'mar-control' }, [React.createElement('span', { key: 'label' }, '轮数'), React.createElement('input', { key: 'input', type: 'number', min: 1, max: 5, value: form.rounds, disabled: running, onChange: function (event) { update({ rounds: Number(event.target.value) || 1 }) } })]),
          React.createElement('label', { key: 'parallel', className: 'mar-control' }, [React.createElement('span', { key: 'label' }, '并发'), React.createElement('input', { key: 'input', type: 'number', min: 1, max: 8, value: form.maxParallel, disabled: running, onChange: function (event) { update({ maxParallel: Number(event.target.value) || 1 }) } })]),
          teams.length ? React.createElement('label', { key: 'team', className: 'mar-control mar-team-control' }, [React.createElement('span', { key: 'label' }, '团队'), React.createElement('select', { key: 'select', value: form.teamId, disabled: running, onChange: function (event) { useTeam(event.target.value) } }, teams.map(function (team) { return React.createElement('option', { key: team.id, value: team.id }, team.name) }))]) : null,
          form.mode === 'host' ? React.createElement('label', { key: 'host', className: 'mar-control' }, [React.createElement('span', { key: 'label' }, '主持人'), React.createElement('select', { key: 'select', value: form.hostRoleId || (hostRole && hostRole.id) || '', disabled: running, onChange: function (event) { update({ hostRoleId: event.target.value }) } }, enabledRoles.map(function (role) { return React.createElement('option', { key: role.id, value: role.id }, role.name) }))]) : null
        ]),
        React.createElement('div', { key: 'roles', className: 'mar-role-row' }, [React.createElement('span', { key: 'label', className: 'mar-row-label' }, '参与角色'), roles.map(function (role) { return React.createElement(RoleChip, { key: role.id, role: role, active: form.participantIds.indexOf(role.id) >= 0, onClick: function () { toggleRole(role.id) } }) })]),
        discussion && running ? React.createElement('button', { key: 'cancel', type: 'button', className: 'mar-secondary mar-cancel', onClick: props.onCancel, disabled: props.disabled }, '停止本轮') : null
      ])
    }

    function RoundtableView(props) {
      var sessionId = sessionKey(props && (props.sessionId || (props.session && props.session.id)))
      var store = useRoundtableStore(sessionId)
      var config = store.config
      var defaults = config && config.defaults ? config.defaults : {}
      var formPair = React.useState(function () {
        return { prompt: '', mode: defaults.mode || 'review', rounds: defaults.rounds || 2, maxParallel: defaults.maxParallel || 3, teamId: defaults.teamId || '', participantIds: (defaults.participantIds || []).slice(), hostRoleId: 'facilitator' }
      })
      var form = formPair[0]
      var setForm = formPair[1]
      var formInitialized = React.useRef(false)
      var hostRoleId = ((config && config.roles) || []).filter(function (role) { return role.enabled !== false && role.id === 'facilitator' })[0]
      hostRoleId = hostRoleId ? hostRoleId.id : ((((config && config.roles) || []).filter(function (role) { return role.enabled !== false })[0] || {}).id || '')
      React.useEffect(function () {
        if (!config || formInitialized.current) return
        formInitialized.current = true
        setForm({ prompt: '', mode: defaults.mode || 'review', rounds: defaults.rounds || 2, maxParallel: defaults.maxParallel || 3, teamId: defaults.teamId || '', participantIds: (defaults.participantIds || []).slice(), hostRoleId: hostRoleId })
      }, [config])
      function submit() {
        var content = form.prompt.trim()
        if (!content || store.busy) return
        if (!store.conversation) { setError(store, new Error('群聊会话尚未创建完成，请稍后重试。')); return }
        if (store.discussion && store.discussion.status === 'running') return
        var input = { prompt: content, mode: form.mode, rounds: Math.max(1, Math.min(5, Number(form.rounds) || 1)), maxParallel: Math.max(1, Math.min(8, Number(form.maxParallel) || 3)), participantIds: form.participantIds, hostRoleId: form.hostRoleId, parentSessionId: sessionId === 'active' ? '' : sessionId, conversationId: store.conversation.id }
        var action = store.discussion ? continueDiscussion(store, content) : createDiscussion(store, input)
        action.then(function (discussion) { if (discussion) setForm(Object.assign({}, form, { prompt: '' })) })
      }
      var discussion = store.discussion
      var messages = discussion && discussion.messages ? discussion.messages : []
      return React.createElement('div', { className: 'mar-shell' }, [
        React.createElement('div', { key: 'heading', className: 'mar-chat-header' }, [
          React.createElement('div', { key: 'title' }, [React.createElement('h2', { key: 'h' }, store.conversation ? store.conversation.title : 'Multi-Agent 群聊'), React.createElement('p', { key: 'p' }, ((form.participantIds || []).length || 0) + ' 个角色 · 插件独立历史')]),
          React.createElement('div', { key: 'actions', className: 'mar-chat-header-actions' }, [
            React.createElement('select', { key: 'history', className: 'mar-history-select', value: store.conversation ? store.conversation.id : '', disabled: store.busy, onChange: function (event) { selectConversation(store, event.target.value) }, 'aria-label': '群聊历史记录' }, [
              !store.conversations.length ? React.createElement('option', { key: 'empty', value: '' }, '暂无历史记录') : null
            ].concat(store.conversations.map(function (item) { return React.createElement('option', { key: item.id, value: item.id }, item.title) }))),
            React.createElement('button', { key: 'new', type: 'button', className: 'mar-secondary', disabled: store.busy, onClick: function () { newConversation(store) } }, '新建群聊'),
            discussion ? React.createElement(StatusPill, { key: 'status', status: discussion.status }) : null,
            React.createElement('button', { key: 'settings', type: 'button', className: 'mar-secondary', onClick: function () { setOverlayOpen(true) } }, '角色设置')
          ])
        ]),
        React.createElement('div', { key: 'scroll', className: 'mar-chat-scroll' }, [
          store.error ? React.createElement('div', { key: 'error', className: 'mar-error' }, store.error) : null,
          !config && store.loading ? React.createElement('div', { key: 'loading', className: 'mar-empty' }, '正在加载讨论配置…') : null,
          discussion ? React.createElement('div', { key: 'discussion', className: 'mar-discussion' }, [
          React.createElement('div', { key: 'meta', className: 'mar-discussion-meta' }, [
            React.createElement('span', { key: 'topic', className: 'mar-topic-label' }, discussion.prompt),
            React.createElement('span', { key: 'stream', className: 'mar-stream-state' }, store.streamStatus === 'live' ? '实时同步' : store.streamStatus === 'polling' ? '轮询同步' : '')
          ]),
          React.createElement(ParticipantStrip, { key: 'participants', participants: discussion.participants, onCancel: store.busy ? null : function (roleId) { cancelDiscussion(store, roleId) } }),
          messages.length ? React.createElement('div', { key: 'messages', className: 'mar-messages' }, messages.map(function (message) { return React.createElement(MessageCard, { key: message.id, message: message }) })) : React.createElement('div', { key: 'empty', className: 'mar-empty' }, discussion.status === 'running' ? 'Agent 正在准备输出…' : '还没有收到 Agent 输出。'),
          discussion.error ? React.createElement('div', { key: 'discussion-error', className: 'mar-error' }, discussion.error) : null
          ]) : React.createElement('div', { key: 'welcome', className: 'mar-welcome' }, [
          React.createElement('div', { key: 'icon', className: 'mar-welcome-icon' }, '✦'),
          React.createElement('h3', { key: 'title' }, '群聊已经就绪'),
          React.createElement('p', { key: 'copy' }, '在右侧角色栏设置 Prompt 和模型，然后从下方发送一个讨论主题。')
          ])
        ]),
        config ? React.createElement(DiscussionToolbar, { key: 'toolbar', config: config, form: form, setForm: setForm, discussion: discussion, onSubmit: submit, onCancel: function () { cancelDiscussion(store) }, disabled: store.busy || store.loading }) : null
      ])
    }

    function RoundtableHeaderAction() {
      return React.createElement('button', {
        type: 'button',
        className: 'mar-header-action',
        title: '打开 Multi-Agent 模式与角色设置',
        'aria-label': '打开 Multi-Agent 模式与角色设置',
        onClick: function () { setOverlayOpen(true) }
      }, 'Multi-Agent')
    }

    function ModeSwitch(props) {
      var pair = React.useState(function () { return currentConversationMode(props.sessionId) })
      var enabled = pair[0]
      var setEnabled = pair[1]
      React.useEffect(function () {
        if (enabled && !activateConversationView(true)) setDirectConversationMode(props.sessionId, true)
      }, [props.sessionId])
      function change(event) {
        var next = event.target.checked === true
        var activated = activateConversationView(next)
        setDirectConversationMode(props.sessionId, next && !activated)
        writeConversationMode(props.sessionId, next)
        setEnabled(next)
        props.onMessage(next ? (activated ? '已切换到中央 Multi-Agent 群聊。' : '已直接打开中央 Multi-Agent 群聊。') : '已返回普通聊天。')
        setOverlayOpen(false)
      }
      return React.createElement('section', { className: 'mar-mode-switch-card' }, [
        React.createElement('div', { key: 'copy', className: 'mar-mode-switch-copy' }, [
          React.createElement('strong', { key: 'title' }, 'Multi-Agent 对话模式'),
          React.createElement('span', { key: 'hint' }, enabled ? '中央区域正在显示群聊' : '中央区域保持普通聊天')
        ]),
        React.createElement('label', { key: 'switch', className: 'mar-switch' }, [
          React.createElement('input', { key: 'input', type: 'checkbox', checked: enabled, onChange: change }),
          React.createElement('span', { key: 'track', className: 'mar-switch-track' })
        ])
      ])
    }

    function RoleSidebar(props) {
      var source = useConfigStore()
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var selectedPair = React.useState('')
      var selectedId = selectedPair[0]
      var setSelectedId = selectedPair[1]
      var messagePair = React.useState('')
      var message = messagePair[0]
      var setMessage = messagePair[1]
      React.useEffect(function () {
        if (!source.value) return
        setDraft(clone(source.value))
        if (!selectedId && source.value.roles && source.value.roles[0]) setSelectedId(source.value.roles[0].id)
      }, [source.value])
      if (!draft) return React.createElement('div', { className: 'mar-sidebar-loading' }, source.error || '正在加载角色设置…')
      var roleIndex = draft.roles.findIndex(function (role) { return role.id === selectedId })
      if (roleIndex < 0) roleIndex = 0
      var role = draft.roles[roleIndex]
      function update(patch) { setDraft(updateRole(draft, roleIndex, patch)) }
      function save() {
        setMessage('正在保存…')
        request('/config', { method: 'PUT', body: { config: draft } }).then(function (body) {
          publishConfig(body.config)
          setDraft(clone(body.config))
          setMessage('角色配置已保存。')
        }).catch(function (error) { setMessage(error && error.message ? error.message : String(error)) })
      }
      return React.createElement('div', { className: 'mar-role-sidebar' }, [
        React.createElement(ModeSwitch, { key: 'mode', sessionId: props.sessionId, onMessage: setMessage }),
        message ? React.createElement('div', { key: 'message', className: message.indexOf('没有') >= 0 ? 'mar-error' : 'mar-note' }, message) : null,
        React.createElement('div', { key: 'roles', className: 'mar-sidebar-role-list' }, draft.roles.map(function (item) {
          return React.createElement('button', { key: item.id, type: 'button', className: 'mar-sidebar-role', 'data-active': item.id === role.id ? 'true' : 'false', onClick: function () { setSelectedId(item.id) } }, [
            React.createElement('span', { key: 'avatar', className: 'mar-mini-avatar', style: { backgroundColor: item.color } }, String(item.name || '?').slice(0, 1)),
            React.createElement('span', { key: 'name' }, item.name),
            React.createElement('span', { key: 'state', className: 'mar-sidebar-role-state' }, item.enabled === false ? '停用' : '启用')
          ])
        })),
        React.createElement('div', { key: 'editor', className: 'mar-sidebar-editor' }, [
          React.createElement('label', { key: 'enabled', className: 'mar-sidebar-check' }, [React.createElement('input', { key: 'input', type: 'checkbox', checked: role.enabled !== false, onChange: function (event) { update({ enabled: event.target.checked }) } }), '参与讨论']),
          React.createElement('label', { key: 'prompt' }, [
            '角色 Prompt',
            React.createElement('textarea', { key: 'input', rows: 8, value: role.prompt, onChange: function (event) { update({ prompt: event.target.value }) } })
          ]),
          React.createElement('label', { key: 'provider' }, [
            'LLM Provider',
            React.createElement('input', { key: 'input', value: role.provider || '', placeholder: '留空继承默认 Provider', onChange: function (event) { update({ provider: event.target.value }) } })
          ]),
          React.createElement('label', { key: 'model' }, [
            'Model',
            React.createElement('input', { key: 'input', value: role.model || '', placeholder: '留空继承默认 Model', onChange: function (event) { update({ model: event.target.value }) } })
          ]),
          React.createElement('label', { key: 'tokens' }, [
            '最大输出 Token',
            React.createElement('input', { key: 'input', type: 'number', min: 256, max: 32768, value: role.maxTokens, onChange: function (event) { update({ maxTokens: Number(event.target.value) || 4096 }) } })
          ]),
          React.createElement('p', { key: 'isolation', className: 'mar-isolation-note' }, '每个角色使用独立 Session 与 Persona。只有“交叉评审”或“主持人总结”会显式传递其他角色输出。'),
          React.createElement('button', { key: 'save', type: 'button', className: 'mar-primary mar-sidebar-save', onClick: save }, '保存角色配置')
        ])
      ])
    }

    function RoundtableOverlay(props) {
      var state = useOverlayState()
      var sessionId = useCurrentSessionId(props && props.sessions)
      var directSessionId = state.directSessionId
      React.useEffect(function () {
        if (!directSessionId || sessionId === 'active' || sessionId === directSessionId) return
        writeConversationMode(sessionId, true)
        setDirectConversationMode(sessionId, true)
      }, [sessionId, directSessionId])
      if (!state.open && !directSessionId) return null
      return React.createElement('div', {
        className: 'mar-overlay',
        'data-direct': directSessionId ? 'true' : 'false',
        role: 'presentation',
        onMouseDown: function (event) { if (event.target === event.currentTarget) setOverlayOpen(false) }
      }, [
        directSessionId ? React.createElement('main', { key: 'direct', className: 'mar-direct-stage', 'aria-label': 'Multi-Agent 群聊' }, React.createElement(RoundtableView, { sessionId: directSessionId })) : null,
        state.open ? React.createElement('section', {
        key: 'panel',
        className: 'mar-overlay-panel',
        role: 'dialog',
        'aria-label': 'Multi-Agent 模式与角色设置',
        onMouseDown: function (event) { event.stopPropagation() }
      }, [
        React.createElement('header', { key: 'header', className: 'mar-overlay-header' }, [
          React.createElement('strong', { key: 'title' }, 'Multi-Agent 设置'),
          React.createElement('button', { key: 'close', type: 'button', className: 'mar-secondary', onClick: function () { setOverlayOpen(false) } }, '关闭')
        ]),
        React.createElement('div', { key: 'body', className: 'mar-overlay-body' }, React.createElement(RoleSidebar, { sessionId: directSessionId || sessionId }))
      ]) : null
      ])
    }

    function updateRole(draft, index, patch) {
      var roles = draft.roles.slice()
      roles[index] = Object.assign({}, roles[index], patch)
      return Object.assign({}, draft, { roles: roles })
    }

    function SettingsView() {
      var source = useConfigStore()
      var pair = React.useState(null)
      var draft = pair[0]
      var setDraft = pair[1]
      var messagePair = React.useState('')
      var message = messagePair[0]
      var setMessage = messagePair[1]
      React.useEffect(function () { if (source.value && !draft) setDraft(clone(source.value)) }, [source.value])
      function save() {
        if (!draft) return
        setMessage('正在保存…')
        request('/config', { method: 'PUT', body: { config: draft } }).then(function (body) {
          publishConfig(body.config)
          setDraft(clone(body.config))
          setMessage('已保存。')
        }).catch(function (error) { setMessage(error && error.message ? error.message : String(error)) })
      }
      function addRole() {
        if (!draft) return
        var index = draft.roles.length + 1
        while (draft.roles.some(function (role) { return role.id === 'role-' + index })) index += 1
        var role = { id: 'role-' + index, name: '新角色 ' + index, prompt: '请从你的专业视角分析问题，并给出依据、风险和下一步。', color: '#4f8cff', enabled: true, provider: '', model: '', maxTokens: 4096 }
        setDraft(Object.assign({}, draft, { roles: draft.roles.concat([role]) }))
      }
      function removeRole(index) {
        if (!draft) return
        var id = draft.roles[index].id
        var roles = draft.roles.filter(function (_, itemIndex) { return itemIndex !== index })
        var teams = draft.teams.map(function (team) { return Object.assign({}, team, { participantIds: team.participantIds.filter(function (roleId) { return roleId !== id }) }) }).filter(function (team) { return team.participantIds.length })
        var defaults = Object.assign({}, draft.defaults, { participantIds: draft.defaults.participantIds.filter(function (roleId) { return roleId !== id }) })
        setDraft(Object.assign({}, draft, { roles: roles, teams: teams, defaults: defaults }))
      }
      function updateTeam(index, patch) {
        var teams = draft.teams.slice()
        teams[index] = Object.assign({}, teams[index], patch)
        setDraft(Object.assign({}, draft, { teams: teams }))
      }
      function toggleTeamRole(teamIndex, roleId) {
        var team = draft.teams[teamIndex]
        var participantIds = team.participantIds.slice()
        var roleIndex = participantIds.indexOf(roleId)
        if (roleIndex >= 0) participantIds.splice(roleIndex, 1)
        else participantIds.push(roleId)
        if (!participantIds.length) return
        updateTeam(teamIndex, { participantIds: participantIds })
      }
      function addTeam() {
        var index = draft.teams.length + 1
        var participantIds = draft.roles.filter(function (role) { return role.enabled !== false }).slice(0, 3).map(function (role) { return role.id })
        if (!participantIds.length) return
        setDraft(Object.assign({}, draft, { teams: draft.teams.concat([{ id: 'team-' + index, name: '新团队 ' + index, participantIds: participantIds }]) }))
      }
      function removeTeam(index) {
        if (draft.teams.length <= 1) return
        var removedId = draft.teams[index].id
        var teams = draft.teams.filter(function (_, itemIndex) { return itemIndex !== index })
        var defaults = draft.defaults
        if (defaults.teamId === removedId) {
          defaults = Object.assign({}, defaults, { teamId: teams[0].id, participantIds: teams[0].participantIds.slice() })
        }
        setDraft(Object.assign({}, draft, { teams: teams, defaults: defaults }))
      }
      function setDefaultTeam(teamId) {
        var team = draft.teams.filter(function (item) { return item.id === teamId })[0]
        if (!team) return
        setDraft(Object.assign({}, draft, { defaults: Object.assign({}, draft.defaults, { teamId: teamId, participantIds: team.participantIds.slice() }) }))
      }
      if (source.loading && !draft) return React.createElement('div', { className: 'mar-settings mar-empty' }, '正在加载设置…')
      if (source.error && !draft) return React.createElement('div', { className: 'mar-settings mar-error' }, source.error)
      if (!draft) return React.createElement('div', { className: 'mar-settings mar-empty' }, '没有可用的讨论设置。')
      return React.createElement('div', { className: 'mar-settings' }, [
        React.createElement('div', { key: 'header', className: 'mar-settings-header' }, [React.createElement('div', { key: 'copy' }, [React.createElement('h2', { key: 'title' }, '多 Agent 讨论设置'), React.createElement('p', { key: 'intro' }, '角色 Prompt 会作为每个子 Session 的职责边界；请避免把密钥或隐私数据写入 Prompt。')]), React.createElement('button', { key: 'save', type: 'button', className: 'mar-primary', onClick: save }, '保存设置')]),
        message ? React.createElement('div', { key: 'message', className: message.indexOf('失败') >= 0 ? 'mar-error' : 'mar-note' }, message) : null,
        React.createElement('section', { key: 'roles', className: 'mar-settings-section' }, [
          React.createElement('div', { key: 'section-head', className: 'mar-section-head' }, [React.createElement('div', { key: 'label' }, [React.createElement('h3', { key: 'title' }, '角色'), React.createElement('p', { key: 'hint' }, '启用的角色才会出现在新讨论的参与者列表中。')]), React.createElement('button', { key: 'add', type: 'button', className: 'mar-secondary', onClick: addRole }, '添加角色')]),
          React.createElement('div', { key: 'cards', className: 'mar-role-editor-list' }, draft.roles.map(function (role, index) {
            return React.createElement('article', { key: role.id, className: 'mar-role-editor' }, [
              React.createElement('div', { key: 'top', className: 'mar-role-editor-top' }, [React.createElement('span', { key: 'dot', className: 'mar-role-dot', style: { backgroundColor: role.color } }), React.createElement('input', { key: 'name', value: role.name, onChange: function (event) { setDraft(updateRole(draft, index, { name: event.target.value })) }, 'aria-label': '角色名称' }), React.createElement('label', { key: 'enabled', className: 'mar-inline-check' }, [React.createElement('input', { key: 'input', type: 'checkbox', checked: role.enabled !== false, onChange: function (event) { setDraft(updateRole(draft, index, { enabled: event.target.checked })) } }), '启用']), React.createElement('button', { key: 'remove', type: 'button', className: 'mar-icon-button', onClick: function () { removeRole(index) }, title: '删除角色' }, '×')]),
              React.createElement('div', { key: 'fields', className: 'mar-role-editor-fields' }, [React.createElement('label', { key: 'id' }, [React.createElement('span', { key: 'label' }, 'ID'), React.createElement('input', { key: 'input', value: role.id, readOnly: true })]), React.createElement('label', { key: 'color' }, [React.createElement('span', { key: 'label' }, '颜色'), React.createElement('input', { key: 'input', type: 'color', value: role.color, onChange: function (event) { setDraft(updateRole(draft, index, { color: event.target.value })) } })]), React.createElement('label', { key: 'tokens' }, [React.createElement('span', { key: 'label' }, '最大 Token'), React.createElement('input', { key: 'input', type: 'number', min: 256, max: 32768, value: role.maxTokens, onChange: function (event) { setDraft(updateRole(draft, index, { maxTokens: Number(event.target.value) || 4096 })) } })]), React.createElement('label', { key: 'provider' }, [React.createElement('span', { key: 'label' }, 'Provider'), React.createElement('input', { key: 'input', value: role.provider || '', placeholder: '默认', onChange: function (event) { setDraft(updateRole(draft, index, { provider: event.target.value })) } })]), React.createElement('label', { key: 'model' }, [React.createElement('span', { key: 'label' }, 'Model'), React.createElement('input', { key: 'input', value: role.model || '', placeholder: '默认', onChange: function (event) { setDraft(updateRole(draft, index, { model: event.target.value })) } })])]),
              React.createElement('textarea', { key: 'prompt', value: role.prompt, rows: 3, onChange: function (event) { setDraft(updateRole(draft, index, { prompt: event.target.value })) }, 'aria-label': role.name + ' Prompt' })
            ])
          }))
        ]),
        React.createElement('section', { key: 'teams', className: 'mar-settings-section' }, [
          React.createElement('div', { key: 'section-head', className: 'mar-section-head' }, [React.createElement('div', { key: 'label' }, [React.createElement('h3', { key: 'title' }, '团队组合'), React.createElement('p', { key: 'hint' }, '团队只是参与角色的快捷组合；每轮仍可在讨论页单独调整。')]), React.createElement('button', { key: 'add', type: 'button', className: 'mar-secondary', onClick: addTeam }, '添加团队')]),
          React.createElement('div', { key: 'cards', className: 'mar-team-editor-list' }, draft.teams.map(function (team, index) {
            return React.createElement('article', { key: team.id, className: 'mar-team-editor' }, [
              React.createElement('div', { key: 'top', className: 'mar-role-editor-top' }, [React.createElement('input', { key: 'name', value: team.name, onChange: function (event) { updateTeam(index, { name: event.target.value }) }, 'aria-label': '团队名称' }), React.createElement('button', { key: 'remove', type: 'button', className: 'mar-icon-button', disabled: draft.teams.length <= 1, onClick: function () { removeTeam(index) }, title: '删除团队' }, '×')]),
              React.createElement('div', { key: 'id', className: 'mar-team-id' }, team.id),
              React.createElement('div', { key: 'members', className: 'mar-team-members' }, draft.roles.map(function (role) { return React.createElement('button', { key: role.id, type: 'button', className: 'mar-team-member', 'data-active': team.participantIds.indexOf(role.id) >= 0 ? 'true' : 'false', disabled: role.enabled === false, onClick: function () { toggleTeamRole(index, role.id) } }, [React.createElement('span', { key: 'dot', className: 'mar-role-dot', style: { backgroundColor: role.color } }), role.name]) }))
            ])
          }))
        ]),
        React.createElement('section', { key: 'defaults', className: 'mar-settings-section' }, [React.createElement('h3', { key: 'title' }, '默认讨论'), React.createElement('div', { key: 'fields', className: 'mar-default-fields' }, [React.createElement('label', { key: 'team' }, ['默认团队', React.createElement('select', { key: 'input', value: draft.defaults.teamId, onChange: function (event) { setDefaultTeam(event.target.value) } }, draft.teams.map(function (team) { return React.createElement('option', { key: team.id, value: team.id }, team.name) }))]), React.createElement('label', { key: 'mode' }, ['默认模式', React.createElement('select', { key: 'input', value: draft.defaults.mode, onChange: function (event) { setDraft(Object.assign({}, draft, { defaults: Object.assign({}, draft.defaults, { mode: event.target.value }) })) } }, [React.createElement('option', { key: 'review', value: 'review' }, '交叉评审'), React.createElement('option', { key: 'independent', value: 'independent' }, '独立回答'), React.createElement('option', { key: 'host', value: 'host' }, '主持人总结')])]), React.createElement('label', { key: 'rounds' }, ['默认轮数', React.createElement('input', { key: 'input', type: 'number', min: 1, max: 5, value: draft.defaults.rounds, onChange: function (event) { setDraft(Object.assign({}, draft, { defaults: Object.assign({}, draft.defaults, { rounds: Number(event.target.value) || 1 }) })) } })]), React.createElement('label', { key: 'parallel' }, ['并发数', React.createElement('input', { key: 'input', type: 'number', min: 1, max: 8, value: draft.defaults.maxParallel, onChange: function (event) { setDraft(Object.assign({}, draft, { defaults: Object.assign({}, draft.defaults, { maxParallel: Number(event.target.value) || 1 }) })) } })])])])
      ])
    }

    var CSS = `
.mar-shell,.mar-settings{color:var(--dsh-text,#e7e9ee);font:13px/1.55 var(--dsh-font,Inter,system-ui,sans-serif);height:100%;overflow:auto;background:var(--dsh-surface,#17191f)}
.mar-shell{padding:22px 26px 48px;box-sizing:border-box}.mar-heading,.mar-settings-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.mar-heading h2,.mar-settings h2{margin:0;font-size:20px;letter-spacing:-.02em}.mar-heading p,.mar-settings-header p{margin:5px 0 0;color:var(--dsh-muted,#8f96a3)}
.mar-toolbar{position:sticky;top:0;z-index:3;margin:18px 0 20px;padding:14px;border:1px solid var(--dsh-border,#2b2f38);border-radius:14px;background:color-mix(in srgb,var(--dsh-surface,#17191f) 94%,transparent);backdrop-filter:blur(10px);box-shadow:0 8px 24px #0002}.mar-topic-row{display:flex;gap:10px}.mar-topic-input{flex:1;resize:vertical;min-height:58px;max-height:180px}.mar-topic-input,.mar-control select,.mar-control input,.mar-settings input,.mar-settings select,.mar-settings textarea{box-sizing:border-box;border:1px solid var(--dsh-border,#30343e);border-radius:8px;background:var(--dsh-input,#101217);color:inherit;padding:8px 10px;font:inherit}.mar-topic-input:focus,.mar-control select:focus,.mar-control input:focus,.mar-settings input:focus,.mar-settings textarea:focus{outline:2px solid #4f8cff55;border-color:#4f8cff}.mar-primary,.mar-secondary{border:1px solid #4f8cff;border-radius:8px;padding:8px 13px;color:#fff;background:#356fe5;cursor:pointer;font:inherit;white-space:nowrap}.mar-primary:hover{background:#4f8cff}.mar-primary:disabled,.mar-secondary:disabled{cursor:not-allowed;opacity:.5}.mar-secondary{color:var(--dsh-text,#e7e9ee);border-color:var(--dsh-border,#3a3f4a);background:transparent}.mar-cancel{margin-top:10px;color:#ffb2b2;border-color:#9d4242}.mar-control-row,.mar-role-row{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:12px}.mar-control{display:flex;align-items:center;gap:6px;color:var(--dsh-muted,#a0a6b2);font-size:12px}.mar-control select{min-width:100px;padding:6px 8px}.mar-control input{width:58px;padding:6px 8px}.mar-team-control select{min-width:135px}.mar-row-label{color:var(--dsh-muted,#a0a6b2);font-size:12px}.mar-role-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsh-border,#30343e);border-radius:999px;padding:5px 9px;color:var(--dsh-muted,#adb2be);background:transparent;cursor:pointer;font:inherit}.mar-role-chip[data-active=true]{border-color:#4f8cff;background:#356fe522;color:var(--dsh-text,#fff)}.mar-role-chip:disabled{cursor:not-allowed;opacity:.45}.mar-role-dot{display:inline-block;flex:0 0 auto;width:8px;height:8px;border-radius:50%}.mar-chip-check{color:#8db3ff}.mar-status{border-radius:999px;padding:4px 9px;font-size:12px;background:#ffffff12;color:#b5bbc7}.mar-status[data-status=running]{background:#4f8cff22;color:#9ec0ff}.mar-status[data-status=completed]{background:#13b88722;color:#7ce0c3}.mar-status[data-status=failed]{background:#d94a4a22;color:#ff9e9e}.mar-status[data-status=cancelled]{background:#e38b4322;color:#ffc383}
.mar-error,.mar-note{margin:12px 0;padding:9px 11px;border-radius:8px;border:1px solid #a44646;background:#a4464618;color:#ffb2b2}.mar-note{border-color:#356fe5;background:#356fe518;color:#a9c6ff}.mar-discussion{max-width:1040px}.mar-discussion-meta{display:flex;justify-content:space-between;gap:12px;margin:8px 0 12px;color:var(--dsh-muted,#a0a6b2)}.mar-topic-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mar-stream-state{font-size:11px;color:#7ce0c3}.mar-participants{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}.mar-participant{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:8px;background:#ffffff08;color:#c9cdd6}.mar-participant-state{font-size:11px;color:var(--dsh-muted,#858c99)}.mar-participant-cancel{border:0;border-radius:5px;padding:2px 5px;color:#ffb2b2;background:#a4464624;cursor:pointer;font-size:11px}.mar-messages{display:flex;flex-direction:column;gap:12px}.mar-message{border:1px solid var(--dsh-border,#2b2f38);border-radius:12px;padding:13px 15px;background:#ffffff05}.mar-message[data-role=user]{border-color:#356fe588;background:#356fe50c}.mar-message[data-status=streaming]{border-color:#4f8cff88}.mar-message-head{display:flex;align-items:center;gap:7px;margin-bottom:9px}.mar-message-round{font-size:11px;color:var(--dsh-muted,#858c99)}.mar-streaming{margin-left:auto;color:#8db3ff;font-size:11px}.mar-markdown{color:#d9dce3}.mar-markdown p{margin:7px 0;white-space:pre-wrap}.mar-markdown p:first-child{margin-top:0}.mar-markdown p:last-child{margin-bottom:0}.mar-markdown h1{font-size:19px}.mar-markdown h2{font-size:17px}.mar-markdown h3{font-size:15px}.mar-markdown h1,.mar-markdown h2,.mar-markdown h3,.mar-markdown h4,.mar-markdown h5,.mar-markdown h6{margin:15px 0 7px;line-height:1.3;color:#f1f3f6}.mar-markdown ul,.mar-markdown ol{margin:7px 0;padding-left:23px}.mar-markdown li{margin:4px 0}.mar-markdown blockquote{margin:8px 0;padding:5px 12px;border-left:3px solid #4f8cff;background:#4f8cff0e;color:#b8c7e4;white-space:pre-wrap}.mar-markdown code{padding:1px 4px;border-radius:4px;background:#0004;color:#b7d1ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}.mar-code{overflow:auto;margin:9px 0;padding:11px;border-radius:8px;background:#0b0d11;color:#cbd5e1;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}.mar-markdown a{color:#8db3ff}.mar-markdown hr{border:0;border-top:1px solid var(--dsh-border,#30343e);margin:14px 0}.mar-table-wrap{overflow:auto;margin:9px 0}.mar-table{border-collapse:collapse;min-width:100%;font-size:12px}.mar-table th,.mar-table td{border:1px solid var(--dsh-border,#30343e);padding:6px 8px;text-align:left;vertical-align:top}.mar-table th{background:#4f8cff14;color:#eef3ff;font-weight:600}.mar-table td{background:#0002}.mar-empty,.mar-welcome{padding:36px 18px;text-align:center;color:var(--dsh-muted,#8f96a3)}.mar-welcome{max-width:530px;margin:30px auto}.mar-welcome-icon{margin:auto;width:48px;height:48px;display:grid;place-items:center;border-radius:16px;background:#4f8cff22;color:#9ec0ff;font-size:24px}.mar-welcome h3{color:#e7e9ee;font-size:17px;margin:15px 0 5px}.mar-welcome p{margin:0}
.mar-settings{padding:24px 28px 50px;box-sizing:border-box}.mar-settings-header{max-width:980px}.mar-settings-section{max-width:980px;margin-top:22px;padding:16px;border:1px solid var(--dsh-border,#2b2f38);border-radius:13px;background:#ffffff04}.mar-settings-section h3{margin:0 0 4px;font-size:15px}.mar-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.mar-section-head p{margin:4px 0 12px;color:var(--dsh-muted,#8f96a3)}.mar-role-editor-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:11px}.mar-role-editor{padding:12px;border:1px solid var(--dsh-border,#30343e);border-radius:10px;background:#0002}.mar-role-editor-top{display:flex;align-items:center;gap:7px}.mar-role-editor-top>input{flex:1;min-width:0;font-weight:600}.mar-inline-check{display:flex;align-items:center;gap:4px;color:var(--dsh-muted,#a0a6b2);white-space:nowrap}.mar-inline-check input{accent-color:#4f8cff}.mar-icon-button{border:0;background:transparent;color:#aab1bd;font-size:20px;cursor:pointer}.mar-role-editor-fields{display:grid;grid-template-columns:1fr 75px 110px;gap:7px;margin:9px 0}.mar-role-editor label,.mar-default-fields label{display:flex;flex-direction:column;gap:4px;color:var(--dsh-muted,#9ea5b1);font-size:11px}.mar-role-editor textarea{width:100%;resize:vertical}.mar-role-editor input,.mar-role-editor textarea{font-size:12px}.mar-role-editor input[type=color]{height:34px;padding:3px}.mar-default-fields{display:flex;gap:10px;flex-wrap:wrap}.mar-default-fields label{min-width:120px}.mar-default-fields select,.mar-default-fields input{margin-top:3px}.mar-settings-header .mar-primary{margin-top:2px}
.mar-team-editor-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px}.mar-team-editor{padding:12px;border:1px solid var(--dsh-border,#30343e);border-radius:10px;background:#0002}.mar-team-id{margin:5px 0 8px;color:var(--dsh-muted,#858c99);font:11px ui-monospace,SFMono-Regular,Consolas,monospace}.mar-team-members{display:flex;gap:6px;flex-wrap:wrap}.mar-team-member{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsh-border,#30343e);border-radius:999px;padding:5px 8px;color:var(--dsh-muted,#adb2be);background:transparent;cursor:pointer;font:inherit}.mar-team-member[data-active=true]{border-color:#4f8cff;background:#356fe522;color:var(--dsh-text,#fff)}.mar-team-member:disabled{cursor:not-allowed;opacity:.4}.mar-icon-button:disabled{cursor:not-allowed;opacity:.4}
.mar-header-action{border:1px solid var(--dsh-border,#30343e);border-radius:7px;padding:5px 9px;background:transparent;color:var(--dsh-muted,#adb2be);cursor:pointer;font:inherit;font-size:12px}.mar-header-action:hover{border-color:#4f8cff;background:#356fe522;color:var(--dsh-text,#fff)}
.mar-shell{display:flex;flex-direction:column;padding:0;height:100%;min-height:0;overflow:hidden;background:var(--dsh-surface,#17191f)}.mar-chat-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:13px 20px;border-bottom:1px solid var(--dsh-border,#2b2f38);background:color-mix(in srgb,var(--dsh-surface,#17191f) 97%,#fff)}.mar-chat-header h2{margin:0;font-size:16px}.mar-chat-header p{margin:2px 0 0;color:var(--dsh-muted,#8f96a3);font-size:11px}.mar-chat-header-actions{display:flex;align-items:center;gap:8px}.mar-chat-scroll{min-height:0;flex:1;overflow:auto;padding:18px 22px 28px;background:color-mix(in srgb,var(--dsh-surface,#17191f) 96%,#8aa8ff)}.mar-discussion{max-width:920px;margin:0 auto}.mar-toolbar{position:relative;z-index:2;flex:none;margin:0;padding:12px 20px 14px;border:0;border-top:1px solid var(--dsh-border,#2b2f38);border-radius:0;background:var(--dsh-surface,#17191f);box-shadow:0 -10px 28px #0002}.mar-topic-input{min-height:44px;max-height:120px;border-radius:16px}.mar-topic-row .mar-primary{align-self:flex-end;height:40px;border-radius:14px}.mar-control-row,.mar-role-row{margin-top:8px}.mar-cancel{position:absolute;right:20px;bottom:62px;margin:0}.mar-participants{justify-content:center;margin:0 0 18px}.mar-discussion-meta{padding:0 4px}.mar-messages{gap:16px}.mar-message{display:flex;align-items:flex-start;gap:9px;width:100%;padding:0;border:0;border-radius:0;background:transparent}.mar-message[data-own=true]{justify-content:flex-end}.mar-avatar,.mar-mini-avatar{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:8px;color:#fff;font-size:13px;font-weight:700;box-shadow:0 3px 9px #0003}.mar-avatar-user{background:#356fe5}.mar-message-column{display:flex;flex-direction:column;align-items:flex-start;max-width:min(76%,720px)}.mar-message[data-own=true] .mar-message-column{align-items:flex-end}.mar-message-head{gap:6px;margin:0 2px 4px;color:var(--dsh-muted,#9ea5b1);font-size:11px}.mar-message-head strong{font-weight:500}.mar-message[data-own=true] .mar-message-head{flex-direction:row-reverse}.mar-message-bubble{position:relative;padding:10px 13px;border:1px solid var(--dsh-border,#30343e);border-radius:4px 13px 13px;background:color-mix(in srgb,var(--dsh-surface,#17191f) 88%,#fff);box-shadow:0 3px 12px #0001}.mar-message[data-own=true] .mar-message-bubble{border-color:#4b8b62;background:#63bd7b;color:#07180c;border-radius:13px 4px 13px 13px}.mar-message[data-own=true] .mar-markdown,.mar-message[data-own=true] .mar-markdown h1,.mar-message[data-own=true] .mar-markdown h2,.mar-message[data-own=true] .mar-markdown h3{color:#07180c}.mar-message[data-status=streaming] .mar-message-bubble{border-color:#4f8cff;box-shadow:0 0 0 2px #4f8cff22}.mar-streaming{margin-left:0}.mar-welcome{margin:auto;min-height:55%;display:flex;flex-direction:column;justify-content:center}.mar-overlay{position:fixed;inset:0;z-index:90;display:flex;justify-content:flex-end;background:rgba(3,8,20,.30)}.mar-overlay-panel{display:flex;flex-direction:column;width:min(420px,calc(100vw - 18px));height:100%;background:var(--dsh-surface,#17191f);color:var(--dsh-text,#e7e9ee);box-shadow:-16px 0 42px #0007}.mar-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;border-bottom:1px solid var(--dsh-border,#2b2f38);background:#ffffff05}.mar-overlay-body{min-height:0;flex:1;overflow:hidden}.mar-role-sidebar{height:100%;overflow:auto;padding:14px;box-sizing:border-box}.mar-mode-switch-card{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px;border:1px solid #4f8cff66;border-radius:13px;background:#356fe514}.mar-mode-switch-copy{display:flex;flex-direction:column;gap:3px}.mar-mode-switch-copy span{color:var(--dsh-muted,#9da4b0);font-size:11px}.mar-switch{position:relative;display:inline-flex;width:44px;height:24px;flex:none}.mar-switch input{position:absolute;opacity:0;pointer-events:none}.mar-switch-track{width:100%;border-radius:999px;background:#5a606c;cursor:pointer;transition:.18s}.mar-switch-track:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 2px 5px #0005;transition:.18s}.mar-switch input:checked+.mar-switch-track{background:#356fe5}.mar-switch input:checked+.mar-switch-track:after{transform:translateX(20px)}.mar-sidebar-role-list{display:flex;flex-direction:column;gap:5px;margin:14px 0}.mar-sidebar-role{display:flex;align-items:center;gap:9px;width:100%;padding:8px;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;text-align:left;cursor:pointer}.mar-sidebar-role:hover{background:#ffffff08}.mar-sidebar-role[data-active=true]{border-color:#4f8cff66;background:#356fe518}.mar-mini-avatar{width:28px;height:28px;border-radius:7px;font-size:11px}.mar-sidebar-role-state{margin-left:auto;color:var(--dsh-muted,#858c99);font-size:11px}.mar-sidebar-editor{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsh-border,#30343e)}.mar-sidebar-editor label{display:flex;flex-direction:column;gap:5px;color:var(--dsh-muted,#a0a6b2);font-size:11px}.mar-sidebar-editor input,.mar-sidebar-editor textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsh-border,#30343e);border-radius:8px;background:var(--dsh-input,#101217);color:var(--dsh-text,#e7e9ee);padding:8px 9px;font:12px/1.5 inherit}.mar-sidebar-editor textarea{resize:vertical}.mar-sidebar-check{flex-direction:row!important;align-items:center}.mar-isolation-note{margin:0;padding:9px;border-radius:8px;background:#13b88714;color:#8fd9c4;font-size:11px;line-height:1.55}.mar-sidebar-save{width:100%}.mar-sidebar-loading{padding:20px;color:var(--dsh-muted,#9da4b0)}
.mar-overlay[data-direct=true]{pointer-events:none;background:transparent}.mar-direct-stage{position:fixed;z-index:1;left:280px;top:119px;right:0;bottom:0;display:flex;min-width:0;min-height:0;pointer-events:auto;background:var(--dsh-surface,#17191f);color:var(--dsh-text,#e7e9ee)}.mar-direct-stage>.mar-shell{width:100%}.mar-overlay-panel{position:relative;z-index:2;pointer-events:auto}.mar-participant[data-status=failed]{background:#d94a4a18;color:#ffb2b2}.mar-participant[data-status=failed] .mar-participant-state{color:#ff9e9e}
.mar-message-toggle{margin-left:auto;border:0;border-radius:6px;padding:2px 7px;background:#ffffff0b;color:var(--dsh-muted,#9ea5b1);cursor:pointer;font:11px/1.6 inherit}.mar-message-toggle:hover{background:#ffffff16;color:var(--dsh-text,#e7e9ee)}.mar-reasoning{margin:0 0 10px;border:1px solid var(--dsh-border,#30343e);border-radius:8px;background:#0002;color:var(--dsh-muted,#a0a6b2)}.mar-reasoning summary{padding:7px 9px;cursor:pointer;user-select:none;font-size:11px}.mar-reasoning-content{padding:2px 10px 9px;border-top:1px solid var(--dsh-border,#30343e);opacity:.86}.mar-reasoning-content .mar-markdown{color:var(--dsh-muted,#aab0bc);font-size:12px}
.mar-history-select{max-width:240px;min-width:150px;border:1px solid var(--dsh-border,#30343e);border-radius:7px;padding:6px 9px;background:var(--dsh-input,#101217);color:var(--dsh-text,#e7e9ee);font:12px/1.4 inherit}.mar-history-select:disabled{opacity:.55}
@media(max-width:900px){.mar-direct-stage{left:0;top:44px}}@media(max-width:680px){.mar-chat-header{padding:10px 12px}.mar-chat-scroll{padding:14px 10px}.mar-toolbar{padding:10px 12px}.mar-topic-row{flex-direction:column}.mar-primary{align-self:flex-start}.mar-message-column{max-width:82%}.mar-settings{padding:16px 12px}.mar-settings-header{flex-direction:column}.mar-role-editor-list{grid-template-columns:1fr}.mar-role-editor-fields{grid-template-columns:1fr 65px}.mar-role-editor-fields label:last-child{grid-column:1/-1}}
`

    function apply(ctx) {
      var sessions = ctx.sessions
      if (ctx.get) sessions = ctx.get('sessions') || sessions
      ctx.effect(function () {
        var style = document.createElement('style')
        style.dataset.plugin = '@p-dsh-market/multi-agent-roundtable'
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      })
      ctx.effect(function () {
        function onDesktopMessage(event) {
          if (event.source !== window.parent) return
          var data = event.data
          if (!data || data.source !== 'dsh-desktop') return
          if (data.type === 'plugin-rpc' && data.pluginId === PLUGIN_ID && data.method === DESKTOP_RPC_METHOD) {
            setOverlayOpen(data.open === false ? false : true)
          }
          else if (data.type === 'roundtable-panel-state-request') announceDesktop('roundtable-panel-state', { open: overlayState.open })
        }
        window.addEventListener('message', onDesktopMessage)
        return function () { window.removeEventListener('message', onDesktopMessage) }
      })
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register(
          { name: 'conversation.view', id: 'multi-agent-roundtable', order: 30, label: '多 Agent 讨论' },
          function (props) { return React.createElement(RoundtableView, props) }
        )
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'multi-agent-roundtable', order: 70, label: '多 Agent 讨论' },
          function () { return React.createElement(SettingsView) }
        )
      })
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'multi-agent-roundtable', order: 30, label: '圆桌' },
          RoundtableHeaderAction
        )
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'multi-agent-roundtable', order: 120, label: '多 Agent 圆桌讨论' },
          function () { return React.createElement(RoundtableOverlay, { sessions: sessions }) }
        )
      })
    }

    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    exports.markdownBlocks = markdownBlocks
    exports.safeHref = safeHref
    exports.activateConversationView = activateConversationView
    return module.exports
  }
})
