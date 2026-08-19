// dsh-open-workspace — browser half
// 1) 外层标题栏/会话头部按钮：开/关右侧文件浏览器
// 2) details 右侧停靠面板：左=目录/文件列表，右=多 tab 预览（Markdown / HTML / 代码）
// 3) conversation.composer.dock 下方嵌入 PowerShell 面板
// 4) 使用 DSH 原生 details 列，外层宽度由布局拖拽手柄控制
window.__ModuleLoader__.load({
  id: '@p-dsh-market/dsh-open-workspace',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var inject = ['slots', 'workspaces', 'timer', 'layout']

    // ── 共享面板状态 ────────────────────────────────────────────────
    // 右侧预览区默认占 details 面板的 64%；拖拽后也始终保留至少 61%。
    var store = { open: false, dir: null, width: 560, split: 0.36 }
    var layoutController = null
    var listeners = []
    var terminalStore = { open: false, cwd: null }
    var terminalListeners = []
    function announceDesktop(type, payload) {
      if (window.parent === window) return
      window.parent.postMessage(Object.assign({ source: 'dsh-open-workspace', type: type }, payload || {}), '*')
    }
    function getState() { return store }
    function setState(patch) {
      store = Object.assign({}, store, patch)
      for (var i = 0; i < listeners.length; i++) listeners[i]()
      announceDesktop('workspace-panel-state', { open: store.open })
    }
    function subscribe(fn) {
      listeners.push(fn)
      return function () { listeners = listeners.filter(function (f) { return f !== fn }) }
    }
    function usePanelState() {
      var pair = React.useState(getState())
      var snap = pair[0]
      var setSnap = pair[1]
      React.useEffect(function () { return subscribe(function () { setSnap(getState()) }) }, [])
      return snap
    }
    function getTerminalState() { return terminalStore }
    function setTerminalState(patch) {
      terminalStore = Object.assign({}, terminalStore, patch)
      for (var i = 0; i < terminalListeners.length; i++) terminalListeners[i]()
      announceDesktop('terminal-panel-state', { open: terminalStore.open })
    }
    function useTerminalState() {
      var pair = React.useState(getTerminalState())
      var snap = pair[0]
      var setSnap = pair[1]
      React.useEffect(function () { return subscribeTerminal(function () { setSnap(getTerminalState()) }) }, [])
      return snap
    }
    function subscribeTerminal(fn) {
      terminalListeners.push(fn)
      return function () { terminalListeners = terminalListeners.filter(function (f) { return f !== fn }) }
    }
    function openPanel() {
      setState({ open: true, dir: null })
      if (layoutController !== null) layoutController.openDetails()
    }
    function closePanel() {
      setState({ open: false })
      if (layoutController !== null) layoutController.closeDetails()
    }
    function togglePanel() { if (store.open) closePanel(); else openPanel() }
    function toggleTerminal(cwd) {
      if (terminalStore.open) setTerminalState({ open: false })
      else setTerminalState({ open: true, cwd: cwd || terminalStore.cwd || null })
    }

    // ── 小工具 ─────────────────────────────────────────────────────
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
    function formatSize(bytes) {
      if (bytes === null || bytes === undefined) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }
    function parentDir(path) {
      if (typeof path !== 'string' || path === '') return null
      var i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      if (i <= 0) return null
      return path.slice(0, i)
    }
    function baseName(path) {
      if (typeof path !== 'string' || path === '') return ''
      var i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return i >= 0 ? path.slice(i + 1) : path
    }
    function extOf(name) {
      var i = name.lastIndexOf('.')
      return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
    }
    // 可预览类型：md/html → 渲染；其余文本类 → 等宽文本；null → 用默认应用打开
    var TEXT_EXTS = ['txt', 'log', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'css', 'scss', 'less', 'yml', 'yaml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'kt', 'swift', 'dart', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'csv', 'svg', 'rst', 'diff', 'patch']
    function previewKind(name) {
      var e = extOf(name)
      if (e === 'md' || e === 'markdown' || e === 'mdown') return 'md'
      if (e === 'html' || e === 'htm') return 'html'
      if (TEXT_EXTS.indexOf(e) >= 0) return 'text'
      return null
    }

    var LANGUAGE_ALIASES = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', ps1: 'powershell', psm1: 'powershell',
      sh: 'shell', bash: 'shell', zsh: 'shell', bat: 'batch', cmd: 'batch',
      yml: 'yaml', md: 'markdown', mdown: 'markdown', html: 'markup', htm: 'markup',
      xml: 'markup', svg: 'markup', cs: 'csharp', 'c++': 'cpp', rs: 'rust',
      kt: 'kotlin', golang: 'go'
    }
    var LANGUAGE_KEYWORDS = {
      generic: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined'.split(' '),
      javascript: 'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined'.split(' '),
      typescript: 'as abstract any async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace never new null number object of private protected public readonly return set static string super switch this throw true try type typeof undefined unknown var void while with yield'.split(' '),
      python: 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match None not or pass raise return try while with yield True False'.split(' '),
      powershell: 'begin break catch class continue data define do dynamicparam else elseif end exit filter finally for foreach from function if in trap param process return switch throw try until using while'.split(' '),
      shell: 'case do done elif else esac fi for function if in select then time until while coproc return export local readonly set unset true false'.split(' '),
      batch: 'call cd cls echo else endlocal exit for goto if in pause rem set shift start'.split(' '),
      ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' '),
      java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'.split(' '),
      csharp: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' '),
      cpp: 'alignas alignof asm auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend if inline int long namespace new nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile wchar_t while'.split(' '),
      go: 'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'.split(' '),
      rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' '),
      sql: 'select from where and or not null is as between like in join inner left right full outer on group by having order asc desc insert into values update set delete create alter drop table index view distinct union all exists case when then else end primary key foreign references'.split(' '),
      css: 'and as at charset container counter-style from import keyframes media namespace supports'.split(' '),
      yaml: 'true false null yes no on off'.split(' '),
      json: 'true false null'.split(' ')
    }
    function languageForName(name) {
      var e = extOf(String(name || ''))
      return LANGUAGE_ALIASES[e] || e || 'text'
    }
    function normalizeLanguage(language) {
      var value = String(language || '').trim().toLowerCase().split(/\s+/)[0].replace(/^language-/, '')
      return LANGUAGE_ALIASES[value] || value || 'text'
    }
    function tokenSpan(kind, value) {
      return '<span class="owsp-token owsp-token-' + kind + '">' + escHtml(value) + '</span>'
    }
    function hashComments(language) {
      return language === 'python' || language === 'powershell' || language === 'shell' || language === 'batch' || language === 'ruby' || language === 'yaml' || language === 'toml' || language === 'ini'
    }
    function slashComments(language) {
      return language !== 'markup' && language !== 'markdown' && language !== 'yaml' && language !== 'toml' && language !== 'ini' && language !== 'sql'
    }
    function highlightCode(text, language) {
      var source = String(text == null ? '' : text)
      var lang = normalizeLanguage(language)
      var keywords = LANGUAGE_KEYWORDS[lang] || LANGUAGE_KEYWORDS.generic
      var keywordSet = Object.create(null)
      for (var ki = 0; ki < keywords.length; ki++) keywordSet[keywords[ki]] = true
      var out = []
      var i = 0
      while (i < source.length) {
        var ch = source.charAt(i)
        var next = source.charAt(i + 1)
        if (lang === 'markup' && source.slice(i, i + 4) === '<!--') {
          var commentEnd = source.indexOf('-->', i + 4)
          if (commentEnd < 0) commentEnd = source.length - 3
          var commentValue = source.slice(i, commentEnd + 3)
          out.push(tokenSpan('comment', commentValue))
          i = commentEnd + 3
          continue
        }
        if (slashComments(lang) && ch === '/' && next === '/') {
          var slashEnd = source.indexOf('\n', i)
          if (slashEnd < 0) slashEnd = source.length
          out.push(tokenSpan('comment', source.slice(i, slashEnd)))
          i = slashEnd
          continue
        }
        if (ch === '/' && next === '*') {
          var blockEnd = source.indexOf('*/', i + 2)
          if (blockEnd < 0) blockEnd = source.length - 2
          out.push(tokenSpan('comment', source.slice(i, blockEnd + 2)))
          i = blockEnd + 2
          continue
        }
        if (hashComments(lang) && ch === '#') {
          var hashEnd = source.indexOf('\n', i)
          if (hashEnd < 0) hashEnd = source.length
          out.push(tokenSpan('comment', source.slice(i, hashEnd)))
          i = hashEnd
          continue
        }
        if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'javascript' || lang === 'typescript' || lang === 'shell' || lang === 'powershell'))) {
          var quote = ch
          var stringEnd = i + 1
          while (stringEnd < source.length) {
            if (source.charAt(stringEnd) === '\\') { stringEnd += 2; continue }
            if (source.charAt(stringEnd) === quote) { stringEnd++; break }
            stringEnd++
          }
          out.push(tokenSpan('string', source.slice(i, stringEnd)))
          i = stringEnd
          continue
        }
        if (/\d/.test(ch) && (i === 0 || !/[A-Za-z_$]/.test(source.charAt(i - 1)))) {
          var numberMatch = /^(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(source.slice(i))
          if (numberMatch) {
            out.push(tokenSpan('number', numberMatch[0]))
            i += numberMatch[0].length
            continue
          }
        }
        if (/[A-Za-z_$]/.test(ch)) {
          var wordMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
          var word = wordMatch ? wordMatch[0] : ch
          var after = i + word.length
          while (after < source.length && /\s/.test(source.charAt(after))) after++
          var before = i > 0 ? source.charAt(i - 1) : ''
          var kind = keywordSet[word] ? 'keyword' : (word === 'true' || word === 'false' || word === 'null' || word === 'undefined' || word === 'None' || word === 'True' || word === 'False' ? 'constant' : (source.charAt(after) === '(' ? 'function' : (source.charAt(after) === ':' || before === '.' ? 'property' : null)))
          out.push(kind ? tokenSpan(kind, word) : escHtml(word))
          i += word.length
          continue
        }
        if (/^[{}[\]();,.:]/.test(ch)) {
          out.push(tokenSpan('punctuation', ch))
          i++
          continue
        }
        if (/^[=+!*%&|?<>~^\-]/.test(ch)) {
          var opMatch = /^[=+!*%&|?<>~^\-]+/.exec(source.slice(i))
          out.push(tokenSpan('operator', opMatch ? opMatch[0] : ch))
          i += opMatch ? opMatch[0].length : 1
          continue
        }
        out.push(escHtml(ch))
        i++
      }
      return out.join('')
    }

    // ── Markdown 渲染（先转义再变换，安全；HTML 预览走 sandbox iframe）──
    function escHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }
    function inlineMd(s) {
      var codeSpans = []
      s = s.replace(/`([^`]+)`/g, function (_, c) { codeSpans.push(c); return '\u0000' + (codeSpans.length - 1) + '\u0000' })
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codeSpans[Number(i)] + '</code>' })
      return s
    }
    function isTableSep(r) {
      return /^\s*\|?\s*:?-+:?\s*\|?\s*$/.test(r)
    }
    function renderTable(rows) {
      function cells(r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim() }) }
      var head = cells(rows[0])
      var body = rows.slice(1)
      if (body.length > 0 && isTableSep(body[0])) body = body.slice(1)
      var html = '<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(escHtml(c)) + '</th>' }).join('') + '</tr></thead><tbody>'
      html += body.map(function (r) { return '<tr>' + cells(r).map(function (c) { return '<td>' + inlineMd(escHtml(c)) + '</td>' }).join('') + '</tr>' }).join('')
      return html + '</tbody></table>'
    }
    function renderMarkdown(text) {
      var lines = String(text).replace(/\r\n/g, '\n').split('\n')
      var out = []
      var list = []
      function flushList() {
        if (list.length === 0) return
        var tag = list[0].type
        out.push('<' + tag + '>' + list.map(function (it) { return '<li>' + it.html + '</li>' }).join('') + '</' + tag + '>')
        list = []
      }
      var i = 0
      while (i < lines.length) {
        var line = lines[i]
        if (/^```/.test(line)) {
          flushList()
          var lang = line.slice(3).trim()
          var buf = []
          i++
          while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
          i++
          var codeLanguage = normalizeLanguage(lang)
          out.push('<pre class="owsp-code" data-language="' + escHtml(codeLanguage) + '"><code>' + highlightCode(buf.join('\n'), codeLanguage) + '</code></pre>')
          continue
        }
        var h = /^(#{1,6})\s+(.*)$/.exec(line)
        if (h) { flushList(); out.push('<h' + h[1].length + '>' + inlineMd(escHtml(h[2])) + '</h' + h[1].length + '>'); i++; continue }
        if (/^\s*([-*_])\s*(\1\s*){2,}\s*$/.test(line)) { flushList(); out.push('<hr/>'); i++; continue }
        if (/^>\s?/.test(line)) {
          flushList()
          var q = []
          while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++ }
          out.push('<blockquote>' + q.map(function (l) { return inlineMd(escHtml(l)) }).join('<br/>') + '</blockquote>')
          continue
        }
        if (/^\s*\|/.test(line)) {
          flushList()
          var rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++ }
          out.push(renderTable(rows))
          continue
        }
        var um = /^\s*[-*+]\s+(.*)$/.exec(line)
        var om = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (um || om) {
          var type = um ? 'ul' : 'ol'
          if (list.length === 0 || list[0].type !== type) { flushList() }
          list.push({ type: type, html: inlineMd(escHtml((um ? um[1] : om[1]).trim())) })
          i++
          continue
        }
        if (line.trim() === '') { flushList(); i++; continue }
        flushList()
        var para = []
        while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i]) && !/^>\s?/.test(lines[i])) { para.push(lines[i]); i++ }
        out.push('<p>' + inlineMd(escHtml(para.join(' '))) + '</p>')
      }
      flushList()
      return out.join('\n')
    }

    // ── 图标 ───────────────────────────────────────────────────────
    function svgIcon(children, size) {
      return React.createElement('svg', { width: size || 15, height: size || 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, children)
    }
    function folderIcon() { return svgIcon(React.createElement('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' })) }
    function fileIcon() { return svgIcon([React.createElement('path', { key: 'a', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }), React.createElement('path', { key: 'b', d: 'M14 2v6h6' })]) }
    function refreshIcon() { return svgIcon([React.createElement('path', { key: 'a', d: 'M21 12a9 9 0 1 1-2.64-6.36' }), React.createElement('path', { key: 'b', d: 'M21 3v6h-6' })]) }
    function upIcon() { return svgIcon([React.createElement('path', { key: 'a', d: 'M12 19V5' }), React.createElement('path', { key: 'b', d: 'M5 12l7-7 7 7' })]) }
    function plusIcon() { return svgIcon([React.createElement('path', { key: 'a', d: 'M12 5v14' }), React.createElement('path', { key: 'b', d: 'M5 12h14' })]) }
    function closeIcon() { return svgIcon([React.createElement('path', { key: 'a', d: 'M18 6L6 18' }), React.createElement('path', { key: 'b', d: 'M6 6l12 12' })]) }
    function xIcon() { return svgIcon(React.createElement('path', { d: 'M18 6L6 18M6 6l12 12' }), 11) }

    // ── 样式 ───────────────────────────────────────────────────────
    var CSS = '.owsp-layer{flex:none;align-items:center;width:100%;height:36px;margin:4px 0 0;display:flex;position:relative}' +
      '.owsp-layer.owsp-rail{width:36px;height:36px;margin:0}' +
      '.owsp-btn{width:100%;height:36px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-family:inherit;font-size:13px;display:inline-flex;overflow:hidden}' +
      '.owsp-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}' +
      '.owsp-btn[data-active]{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.owsp-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}' +
      '.owsp-rail .owsp-btn{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}' +
      '.owsp-hbtn{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:50%;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}' +
      '.owsp-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.owsp-hbtn[data-active]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.owsp-panel{box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);flex-direction:column;display:flex;overflow:hidden;font-size:13px}' +
      '.owsp-phead{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;min-height:40px;gap:2px;padding:6px 8px;display:flex}' +
      '.owsp-ptitle{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;overflow:hidden;font-size:13px;font-weight:500}' +
      '.owsp-pbtn{cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:8px;flex:none;width:28px;height:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}' +
      '.owsp-pbtn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}' +
      '.owsp-pbtn[disabled]{opacity:.4;cursor:default}' +
      '.owsp-note{color:var(--dsw-alias-label-secondary);padding:10px 12px;font-size:12px;line-height:18px}' +
      '.owsp-error{color:var(--dsw-alias-state-error-primary);padding:10px 12px;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}' +
      '.owsp-loading{color:var(--dsw-alias-label-secondary);padding:10px 12px;font-size:12px}' +
      '.owsp-main{flex:1;min-height:0;display:flex;position:relative}' +
      '.owsp-left{flex:none;min-width:0;display:flex;flex-direction:column}' +
      '.owsp-lbody{flex:1;min-height:0;overflow-y:auto;padding:4px}' +
      '.owsp-row{cursor:pointer;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;width:100%;padding:5px 8px;display:flex;font-family:inherit;font-size:13px;text-align:left}' +
      '.owsp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.owsp-row.owsp-hidden{opacity:.55}' +
      '.owsp-rowicon{flex:none;display:inline-flex;color:var(--dsw-alias-label-secondary)}' +
      '.owsp-rowname{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;overflow:hidden}' +
      '.owsp-rowsize{color:var(--dsw-alias-label-secondary);flex:none;font-size:12px;font-variant-numeric:tabular-nums}' +
      '.owsp-divider{flex:none;width:5px;cursor:col-resize;background:0 0;position:relative}' +
      '.owsp-divider:hover{background:var(--dsw-alias-interactive-bg-hover)}' +
      '.owsp-right{flex:1;min-width:0;display:flex;flex-direction:column}' +
      '.owsp-tabs{flex:none;display:flex;align-items:center;gap:2px;padding:4px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}' +
      '.owsp-tab{cursor:pointer;display:inline-flex;align-items:center;gap:4px;max-width:170px;padding:4px 8px;border-radius:6px 6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;white-space:nowrap;font-family:inherit}' +
      '.owsp-tab:hover{color:var(--dsw-alias-label-primary)}' +
      '.owsp-tab[data-active]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}' +
      '.owsp-tabname{text-overflow:ellipsis;overflow:hidden;min-width:0}' +
      '.owsp-tabclose{cursor:pointer;flex:none;display:inline-flex;border-radius:4px;padding:1px;color:var(--dsw-alias-label-secondary)}' +
      '.owsp-tabclose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}' +
      '.owsp-preview{flex:1;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base)}' +
      '.owsp-phint{color:var(--dsw-alias-label-secondary);padding:28px 16px;text-align:center;font-size:12px;line-height:20px}' +
      '.owsp-md{box-sizing:border-box;padding:12px 14px;font-size:13px;line-height:1.65;word-break:break-word}' +
      '.owsp-md h1{font-size:18px;margin:12px 0 8px}' +
      '.owsp-md h2{font-size:16px;margin:10px 0 6px}' +
      '.owsp-md h3,.owsp-md h4{font-size:14px;margin:8px 0 4px}' +
      '.owsp-md p{margin:6px 0}' +
      '.owsp-md code{font-family:ui-monospace,Consolas,monospace;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 4px;font-size:12px}' +
      '.owsp-md pre.owsp-code{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;overflow:auto;margin:8px 0}' +
      '.owsp-md pre.owsp-code code{background:0 0;padding:0}' +
      '.owsp-md a{color:var(--dsw-alias-brand-primary)}' +
      '.owsp-md blockquote{border-left:3px solid var(--dsw-alias-border-l2);margin:8px 0;padding:2px 12px;color:var(--dsw-alias-label-secondary)}' +
      '.owsp-md table{border-collapse:collapse;margin:8px 0;width:100%;font-size:12px}' +
      '.owsp-md th,.owsp-md td{border:1px solid var(--dsw-alias-border-l2);padding:4px 8px;text-align:left}' +
      '.owsp-md th{background:var(--dsw-alias-bg-layer-2)}' +
      '.owsp-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2);margin:10px 0}' +
      '.owsp-md ul,.owsp-md ol{margin:6px 0;padding-left:22px}' +
      '.owsp-text{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:12px 14px;line-height:1.5;margin:0}' +
      '.owsp-code-preview{box-sizing:border-box;min-height:100%;background:var(--dsw-alias-markdown-code-block);border:0;border-radius:0;overflow:auto;tab-size:2}' +
      '.owsp-code-preview code{font:inherit;color:var(--shiki-foreground,var(--dsw-alias-label-primary))}' +
      '.owsp-code .owsp-token,.owsp-code-preview .owsp-token{font:inherit}' +
      '.owsp-token-comment{color:var(--shiki-token-comment,var(--dsw-alias-label-tertiary));font-style:italic}' +
      '.owsp-token-string{color:var(--shiki-token-string,var(--dsw-alias-state-success-primary))}' +
      '.owsp-token-keyword{color:var(--shiki-token-keyword,var(--dsw-alias-brand-primary))}' +
      '.owsp-token-constant{color:var(--shiki-token-constant,var(--dsw-alias-state-business-primary))}' +
      '.owsp-token-number{color:var(--shiki-token-number,var(--dsw-alias-state-business-primary))}' +
      '.owsp-token-function{color:var(--shiki-token-function,var(--dsw-alias-brand-primary-new-colorprimary-new-color))}' +
      '.owsp-token-property{color:var(--shiki-token-property,var(--dsw-alias-state-warn-label))}' +
      '.owsp-token-punctuation{color:var(--shiki-token-punctuation,var(--dsw-alias-label-secondary))}' +
      '.owsp-token-operator{color:var(--shiki-token-operator,var(--dsw-alias-label-primary))}' +
      '.owsp-linkbtn{cursor:pointer;color:var(--dsw-alias-brand-primary);background:0 0;border:none;padding:0;font-size:12px;font-family:inherit;text-decoration:underline}' +
      '.owsp-terminal{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);color-scheme:inherit;overflow:hidden;margin:8px 0 0}' +
      '.owsp-terminal-head{min-height:34px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}' +
      '.owsp-terminal-title{font-size:12px;font-weight:600;flex:none}' +
      '.owsp-terminal-cwd{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}' +
      '.owsp-terminal-action{cursor:pointer;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);min-width:26px;height:25px;padding:0 6px;font-family:inherit;font-size:12px}' +
      '.owsp-terminal-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}' +
      '.owsp-terminal-output{box-sizing:border-box;height:190px;max-height:30vh;overflow:auto;margin:0;padding:10px 12px;background:var(--dsw-alias-markdown-code-block);color:var(--shiki-foreground,var(--dsw-alias-label-primary));font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}' +
      '.owsp-terminal-error{box-sizing:border-box;padding:7px 10px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:pre-wrap;word-break:break-word}' +
      '.owsp-terminal-form{display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}' +
      '.owsp-terminal-prompt{color:var(--dsw-alias-state-success-primary);font:12px ui-monospace,Consolas,monospace;flex:none}' +
      '.owsp-terminal-input{box-sizing:border-box;min-width:0;flex:1;height:27px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px ui-monospace,Consolas,monospace;outline:none}' +
      '.owsp-terminal-input:focus{border-color:var(--dsw-alias-brand-primary)}' +
      '.owsp-terminal-send{cursor:pointer;flex:none;border:0;border-radius:6px;height:27px;padding:0 10px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:12px inherit}' +
      '.owsp-terminal-send:hover{filter:brightness(1.08)}'

    function stripAnsi(value) {
      return String(value == null ? '' : value)
        .replace(/[\u001b\u009b]\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/[\u001b\u009b][()][0-2]/g, '')
    }
    function terminalRequest(path, options) {
      return fetch(path, options).then(function (res) {
        return res.json().catch(function () { throw new Error('Terminal 服务不可用（HTTP ' + res.status + '）') })
      })
    }
    function TerminalPanel(props) {
      var snap = useTerminalState()
      var sessionCwd = props && props.session && props.session.header ? props.session.header.cwd : null
      var cwd = snap.cwd || sessionCwd || null
      var outputPair = React.useState('')
      var output = outputPair[0]
      var setOutput = outputPair[1]
      var statusPair = React.useState('closed')
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]
      var inputPair = React.useState('')
      var input = inputPair[0]
      var setInput = inputPair[1]
      var outputRef = React.useRef(null)
      var offsetRef = React.useRef(0)

      React.useEffect(function () {
        if (!snap.open) return
        var cancelled = false
        offsetRef.current = 0
        setOutput('')
        setError(cwd ? null : '当前会话没有工作区路径。')
        setStatus(cwd ? 'opening' : 'error')
        if (!cwd) return
        var timer = null
        function append(data) {
          var clean = stripAnsi(data)
          if (!clean) return
          setOutput(function (previous) {
            var next = previous + clean
            return next.length > 120000 ? next.slice(-120000) : next
          })
        }
        function poll() {
          if (cancelled) return
          terminalRequest('/open-workspace/terminal/read?since=' + encodeURIComponent(String(offsetRef.current)))
            .then(function (data) {
              if (cancelled) return
              if (data && data.error) throw new Error(data.error)
              if (data && data.output) append(data.output)
              if (data && typeof data.offset === 'number') offsetRef.current = data.offset
              if (data && data.status) setStatus(data.status)
              if (!data || (data.status !== 'done' && data.status !== 'error')) timer = window.setTimeout(poll, 350)
            })
            .catch(function (err) {
              if (cancelled) return
              setError(String(err && err.message ? err.message : err))
              setStatus('error')
            })
        }
        terminalRequest('/open-workspace/terminal/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: cwd })
        }).then(function (data) {
          if (cancelled) return
          if (data && data.error) throw new Error(data.error)
          setStatus(data && data.status ? data.status : 'running')
          if (data && typeof data.offset === 'number') offsetRef.current = data.offset
          if (data && data.output) append(data.output)
          poll()
        }).catch(function (err) {
          if (cancelled) return
          setError(String(err && err.message ? err.message : err))
          setStatus('error')
        })
        return function () {
          cancelled = true
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [snap.open, cwd])

      React.useEffect(function () {
        if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
      }, [output])

      function send(data) {
        if (!snap.open || !data) return Promise.resolve()
        setError(null)
        return terminalRequest('/open-workspace/terminal/write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: data })
        }).then(function (result) {
          if (result && result.error) throw new Error(result.error)
        }).catch(function (err) {
          setError(String(err && err.message ? err.message : err))
        })
      }
      function submit(event) {
        event.preventDefault()
        var value = input
        if (!value) return
        setInput('')
        send(value + '\r')
      }
      function close() {
        terminalRequest('/open-workspace/terminal/close', { method: 'POST' }).catch(function () {}).finally(function () {
          setTerminalState({ open: false })
        })
      }
      if (!snap.open) return null
      return React.createElement('section', { className: 'owsp-terminal', role: 'region', 'aria-label': 'PowerShell 终端' }, [
        React.createElement('div', { key: 'head', className: 'owsp-terminal-head' }, [
          React.createElement('span', { key: 'title', className: 'owsp-terminal-title' }, 'PowerShell'),
          React.createElement('span', { key: 'cwd', className: 'owsp-terminal-cwd', title: cwd || '' }, cwd || '未设置工作区'),
          React.createElement('span', { key: 'status', className: 'owsp-terminal-cwd' }, status === 'running' || status === 'opening' ? '运行中' : status === 'done' ? '已结束' : status === 'error' ? '错误' : ''),
          React.createElement('button', { key: 'clear', type: 'button', className: 'owsp-terminal-action', title: '清空输出', onClick: function () { setOutput('') } }, '清空'),
          React.createElement('button', { key: 'close', type: 'button', className: 'owsp-terminal-action', title: '关闭 PowerShell 面板', onClick: close }, '×')
        ]),
        error ? React.createElement('div', { key: 'error', className: 'owsp-terminal-error' }, error) : null,
        React.createElement('pre', { key: 'output', ref: outputRef, className: 'owsp-terminal-output' }, output || '正在连接 PowerShell…'),
        React.createElement('form', { key: 'form', className: 'owsp-terminal-form', onSubmit: submit }, [
          React.createElement('span', { key: 'prompt', className: 'owsp-terminal-prompt' }, '>'),
          React.createElement('input', { key: 'input', className: 'owsp-terminal-input', value: input, onChange: function (event) { setInput(event.target.value) }, onKeyDown: function (event) { if (event.key === 'c' && event.ctrlKey) { event.preventDefault(); send('\u0003') } }, placeholder: '输入 PowerShell 命令，回车执行', disabled: status === 'done' || status === 'error' }),
          React.createElement('button', { key: 'send', type: 'submit', className: 'owsp-terminal-send', disabled: status === 'done' || status === 'error' }, '发送')
        ])
      ])
    }

    function apply(ctx) {
      layoutController = ctx.layout
      ctx.effect(function () {
        return function () {
          if (layoutController === ctx.layout) layoutController = null
          setState({ open: false, dir: null })
          setTerminalState({ open: false, cwd: null })
          ctx.layout.closeDetails()
        }
      })
      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.dataset.plugin = '@p-dsh-market/dsh-open-workspace'
        tag.dataset.pluginCss = '@p-dsh-market/dsh-open-workspace/styles'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () { tag.remove() }
      })

      // Tauri 外层标题栏通过 postMessage 控制插件，不再在侧边栏底部
      // 注册“文件”按钮，避免与外层入口和 desktop bridge 重复。
      ctx.effect(function () {
        function onDesktopMessage(event) {
          if (event.source !== window.parent) return
          var data = event.data
          if (!data || data.source !== 'dsh-desktop') return
          if (data.type === 'workspace-panel-toggle') togglePanel()
          else if (data.type === 'workspace-panel-open') openPanel()
          else if (data.type === 'workspace-panel-close') closePanel()
          else if (data.type === 'terminal-panel-toggle') toggleTerminal(data.cwd)
          else if (data.type === 'terminal-panel-open') setTerminalState({ open: true, cwd: data.cwd || terminalStore.cwd || null })
          else if (data.type === 'terminal-panel-close') setTerminalState({ open: false })
          else if (data.type === 'workspace-panel-state-request') announceDesktop('workspace-panel-state', { open: store.open })
          else if (data.type === 'terminal-panel-state-request') announceDesktop('terminal-panel-state', { open: terminalStore.open })
        }
        window.addEventListener('message', onDesktopMessage)
        announceDesktop('workspace-panel-state', { open: store.open })
        announceDesktop('terminal-panel-state', { open: terminalStore.open })
        return function () { window.removeEventListener('message', onDesktopMessage) }
      })

      // 会话头部按钮
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'open-workspace-header', order: 15, label: '文件' },
          function () {
            var snap = usePanelState()
            return React.createElement('button', {
              type: 'button',
              className: 'owsp-hbtn',
              'data-active': snap.open || undefined,
              'aria-label': '文件浏览器（工作区）',
              title: '文件浏览器（工作区）',
              onClick: togglePanel
            }, folderIcon())
          }
        )
      })

      // composer.dock 位于输入框所属 card 的下方；input.dock 会渲染到
      // card 上方，不能用于这里的终端面板。
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'open-workspace-terminal', order: 10, label: 'Terminal' },
          function (props) { return React.createElement(TerminalPanel, props) }
        )
      })

      // 对话右侧停靠面板：details 是 DSH 原生三列布局中的右列，
      // 不使用 shell.overlay，避免文件浏览器覆盖在消息流上方。
      ctx.slots.inject('details', function () {
        return ctx.slots.register(
          // `details` 是单槽位；优先级必须与内置 DetailsPanel 不同。
          // DSH 的单槽位按最低优先级渲染，因此 -1 明确 shadow 内置的 0。
          { name: 'details', priority: -1 },
          function (props) {
            var snap = usePanelState()
            var useWorkspaces = props.useWorkspaces
            var useSessions = props.useSessions
            var sessionId = props.sessionId
            if (typeof useWorkspaces !== 'function' || typeof useSessions !== 'function') return null

            var sessionCwd = useSessions(function (s) { return sessionId !== undefined && s.byId[sessionId] ? s.byId[sessionId].cwd : null })
            var recentId = useWorkspaces(function (s) { return s.recentWorkspaceId })
            var items = useWorkspaces(function (s) { return s.items })
            var root = sessionCwd || null
            if (recentId !== undefined) {
              var found = items.find(function (w) { return w.workspaceId === recentId })
              if (root === null && found !== undefined) root = found.path
            }
            if (root === null && items.length > 0) root = items[0].path

            var dir = snap.dir !== null ? snap.dir : root

            var listPair = React.useState(null)
            var listing = listPair[0]
            var setListing = listPair[1]
            var loadPair = React.useState(false)
            var loading = loadPair[0]
            var setLoading = loadPair[1]
            var revPair = React.useState(0)
            var revision = revPair[0]
            var setRevision = revPair[1]
            var notePair = React.useState(null)
            var note = notePair[0]
            var setNote = notePair[1]
            var tabsPair = React.useState([])
            var tabs = tabsPair[0]
            var setTabs = tabsPair[1]
            var activePair = React.useState(null)
            var active = activePair[0]
            var setActive = activePair[1]

            var firstSessionRef = React.useRef(sessionId)
            React.useEffect(function () {
              if (firstSessionRef.current === sessionId) return
              firstSessionRef.current = sessionId
              setState({ open: false, dir: null })
            }, [sessionId])

            React.useEffect(function () {
              if (note === null) return
              var dispose = ctx.timeout(function () { setNote(null) }, 3000)
              return dispose
            }, [note])

            React.useEffect(function () {
              if (!snap.open) return
              if (dir === null) {
                setListing({ error: '当前没有可用的工作区' })
                return
              }
              var cancelled = false
              setLoading(true)
              fetch('/open-workspace/list?path=' + encodeURIComponent(dir))
                .then(function (res) {
                  return res.json().catch(function () {
                    throw new Error('文件列表服务不可用（HTTP ' + res.status + '）——若刚更新过插件，请重启 dsh 后再试')
                  })
                })
                .then(function (data) {
                  if (cancelled) return
                  setListing(data)
                  setLoading(false)
                })
                .catch(function (err) {
                  if (cancelled) return
                  setListing({ error: String(err && err.message ? err.message : err) })
                  setLoading(false)
                })
              return function () { cancelled = true }
            }, [snap.open, dir, revision])

            function openEntry(entry) {
              if (entry.type === 'directory') {
                setState({ dir: entry.path })
                return
              }
              var kind = previewKind(entry.name)
              if (kind === null) {
                setNote('正在用默认应用打开…')
                ctx.workspaces.openPath(entry.path)
                  .then(function () { setNote('已打开：' + entry.name) })
                  .catch(function (err) { setNote('打开失败：' + (err && err.message ? err.message : String(err))) })
                return
              }
              var existing = tabs.find(function (t) { return t.path === entry.path })
              if (existing !== undefined) { setActive(existing.path); return }
              setActive(entry.path)
              setTabs(function (prev) {
                var next = prev.slice()
                if (next.length >= 15) next.shift()
                next.push({ path: entry.path, name: baseName(entry.path), kind: kind, status: 'loading' })
                return next
              })
              fetch('/open-workspace/read?path=' + encodeURIComponent(entry.path))
                .then(function (res) {
                  return res.json().catch(function () { throw new Error('读取服务不可用（HTTP ' + res.status + '）') })
                })
                .then(function (data) {
                  setTabs(function (prev) {
                    return prev.map(function (t) {
                      if (t.path !== entry.path) return t
                      if (data && data.error && !data.content) return { path: t.path, name: t.name, kind: t.kind, status: 'error', error: data.error }
                      if (data && data.tooLarge) return { path: t.path, name: t.name, kind: t.kind, status: 'toolarge', size: data.size }
                      if (data && data.binary) return { path: t.path, name: t.name, kind: t.kind, status: 'binary' }
                      return { path: t.path, name: t.name, kind: t.kind, status: 'ready', content: data.content || '' }
                    })
                  })
                })
                .catch(function (err) {
                  setTabs(function (prev) {
                    return prev.map(function (t) {
                      return t.path === entry.path ? { path: t.path, name: t.name, kind: t.kind, status: 'error', error: String(err && err.message ? err.message : err) } : t
                    })
                  })
                })
            }

            function closeTab(path) {
              var idx = tabs.findIndex(function (t) { return t.path === path })
              var next = tabs.filter(function (t) { return t.path !== path })
              setTabs(next)
              if (active === path) {
                var neighbor = next[idx] || next[next.length - 1] || null
                setActive(neighbor ? neighbor.path : null)
              }
            }

            function openNative(entry) {
              ctx.workspaces.openPath(entry.path)
                .then(function () { setNote('已打开：' + entry.name) })
                .catch(function (err) { setNote('打开失败：' + (err && err.message ? err.message : String(err))) })
            }

            function onSplitStart(e) {
              e.preventDefault()
              var startX = e.clientX
              var startSplit = store.split || 0.42
              var w = store.width || 560
              function move(ev) {
                // 预览区至少保留 61%，代码阅读不会被左侧目录挤窄。
                setState({ split: clamp(startSplit + (ev.clientX - startX) / w, 0.22, 0.39) })
              }
              function up() {
                window.removeEventListener('mousemove', move)
                window.removeEventListener('mouseup', up)
              }
              window.addEventListener('mousemove', move)
              window.addEventListener('mouseup', up)
            }

            if (!snap.open) return null

            var panelWidth = store.width || 560
            var leftWidth = Math.round(panelWidth * (store.split || 0.36))

            var headerBtns = []
            var parent = parentDir(dir)
            headerBtns.push(React.createElement('button', { key: 'up', type: 'button', className: 'owsp-pbtn', title: '上级目录', disabled: dir === null || parent === null, onClick: function () { setState({ dir: parent }) } }, upIcon()))
            headerBtns.push(React.createElement('button', { key: 'refresh', type: 'button', className: 'owsp-pbtn', title: '刷新', disabled: dir === null, onClick: function () { setRevision(revision + 1) } }, refreshIcon()))
            headerBtns.push(React.createElement('button', { key: 'new', type: 'button', className: 'owsp-pbtn', title: '新建文件夹', disabled: dir === null, onClick: function () {
              var name = window.prompt('新建文件夹名称', '新建文件夹')
              if (name === null || name.trim() === '') return
              ctx.workspaces.createDirectory(dir, name.trim())
                .then(function () { setRevision(revision + 1) })
                .catch(function (err) { setNote('创建失败：' + (err && err.message ? err.message : String(err))) })
            } }, plusIcon()))
            headerBtns.push(React.createElement('button', { key: 'close', type: 'button', className: 'owsp-pbtn', title: '关闭右侧文件面板', onClick: closePanel }, closeIcon()))

            var listBody
            if (dir === null) {
              listBody = React.createElement('div', { className: 'owsp-note' }, '当前没有可用的工作区')
            } else if (loading) {
              listBody = React.createElement('div', { className: 'owsp-loading' }, '加载中…')
            } else if (listing && listing.error) {
              listBody = React.createElement('div', { className: 'owsp-error' }, String(listing.error))
            } else if (listing && listing.entries && listing.entries.length === 0) {
              listBody = React.createElement('div', { className: 'owsp-note' }, '（空目录）')
            } else {
              var rows = (listing && listing.entries ? listing.entries : []).map(function (entry) {
                var isDir = entry.type === 'directory'
                return React.createElement('button', {
                  key: entry.path,
                  type: 'button',
                  className: entry.name.charAt(0) === '.' ? 'owsp-row owsp-hidden' : 'owsp-row',
                  title: entry.path,
                  onClick: function () { openEntry(entry) }
                }, [
                  React.createElement('span', { className: 'owsp-rowicon' }, isDir ? folderIcon() : fileIcon()),
                  React.createElement('span', { className: 'owsp-rowname' }, entry.name),
                  React.createElement('span', { className: 'owsp-rowsize' }, isDir ? '' : formatSize(entry.size))
                ])
              })
              listBody = React.createElement('div', { className: 'owsp-lbody' }, rows)
            }

            var activeTab = null
            for (var ti = 0; ti < tabs.length; ti++) { if (tabs[ti].path === active) { activeTab = tabs[ti]; break } }

            var preview
            if (activeTab === null) {
              preview = React.createElement('div', { className: 'owsp-phint' }, '点击左侧文件在右侧预览\n支持 Markdown / HTML / 文本')
            } else if (activeTab.status === 'loading') {
              preview = React.createElement('div', { className: 'owsp-loading' }, '加载中…')
            } else if (activeTab.status === 'error') {
              preview = React.createElement('div', { className: 'owsp-error' }, String(activeTab.error))
            } else if (activeTab.status === 'toolarge') {
              preview = React.createElement('div', { className: 'owsp-note' }, [
                '文件过大（' + formatSize(activeTab.size) + '），无法在面板内预览。',
                React.createElement('br'),
                React.createElement('button', { type: 'button', className: 'owsp-linkbtn', onClick: function () { openNative({ path: activeTab.path, name: activeTab.name }) } }, '用默认应用打开')
              ])
            } else if (activeTab.status === 'binary') {
              preview = React.createElement('div', { className: 'owsp-note' }, [
                '这是二进制文件，无法预览文本内容。',
                React.createElement('br'),
                React.createElement('button', { type: 'button', className: 'owsp-linkbtn', onClick: function () { openNative({ path: activeTab.path, name: activeTab.name }) } }, '用默认应用打开')
              ])
            } else if (activeTab.kind === 'html') {
              preview = React.createElement('iframe', { sandbox: '', srcDoc: activeTab.content, style: { width: '100%', height: '100%', border: 'none', display: 'block', background: '#ffffff' } })
            } else if (activeTab.kind === 'md') {
              preview = React.createElement('div', { className: 'owsp-md', dangerouslySetInnerHTML: { __html: renderMarkdown(activeTab.content) } })
            } else {
              var codeLanguage = languageForName(activeTab.name)
              preview = React.createElement('pre', { className: 'owsp-text owsp-code-preview', 'data-language': codeLanguage, dangerouslySetInnerHTML: { __html: '<code>' + highlightCode(activeTab.content, codeLanguage) + '</code>' } })
            }

            var tabBar = React.createElement('div', { className: 'owsp-tabs' },
              tabs.map(function (t) {
                return React.createElement('div', {
                  key: t.path,
                  className: 'owsp-tab',
                  'data-active': t.path === active || undefined,
                  title: t.path,
                  onClick: function () { setActive(t.path) }
                }, [
                  React.createElement('span', { className: 'owsp-tabname' }, t.name),
                  React.createElement('span', {
                    className: 'owsp-tabclose',
                    role: 'button',
                    'aria-label': '关闭 ' + t.name,
                    onClick: function (e) { e.stopPropagation(); closeTab(t.path) }
                  }, xIcon())
                ])
              })
            )

            return React.createElement('div', { className: 'owsp-panel', role: 'region', 'aria-label': '文件浏览器' },
              React.createElement('div', { className: 'owsp-phead' },
                React.createElement('span', { className: 'owsp-ptitle', title: dir !== null ? dir : '文件浏览器' }, dir !== null ? baseName(dir) : '文件浏览器'),
                headerBtns
              ),
              note !== null ? React.createElement('div', { className: note && note.indexOf('失败') >= 0 ? 'owsp-error' : 'owsp-note' }, note) : null,
              React.createElement('div', { className: 'owsp-main' },
                React.createElement('div', { className: 'owsp-left', style: { width: leftWidth + 'px' } }, listBody),
                React.createElement('div', { className: 'owsp-divider', onMouseDown: onSplitStart, title: '拖拽调整左右比例' }),
                React.createElement('div', { className: 'owsp-right' },
                  tabBar,
                  React.createElement('div', { className: 'owsp-preview' }, preview)
                )
              )
            )
          }
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
