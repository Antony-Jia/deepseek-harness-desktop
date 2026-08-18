// dsh-open-workspace — host half
// 1) /workspace 指令：在系统文件管理器中打开当前会话的工作区目录（或参数路径）
// 2) /open-workspace/list 路由：只读列出目录内容（含文件）
// 3) /open-workspace/read 路由：读取文本文件内容（带大小上限与二进制判定）
// 4) /open-workspace/terminal/* 路由：为对话框下方面板提供 PowerShell 会话
const MAX_READ_BYTES = 1000000
const MAX_TERMINAL_OUTPUT = 200000
const MAX_TERMINAL_WRITE = 16000

export default {
  inject: ['commands', 'fs', 'webServer', 'subprocess'],

  apply(ctx) {
    const commands = ctx.get('commands')
    const fs = ctx.get('fs')
    const webServer = ctx.get('webServer')
    const subprocess = ctx.get('subprocess')
    const terminal = {
      handle: null,
      cwd: null,
      output: '',
      baseOffset: 0,
      status: 'closed',
      error: null,
      transport: null,
      write: null,
      generation: 0,
      opening: null
    }

    const terminalSnapshot = () => ({
      cwd: terminal.cwd,
      status: terminal.status,
      error: terminal.error,
      transport: terminal.transport,
      output: terminal.output,
      offset: terminal.baseOffset + terminal.output.length
    })
    const appendTerminalOutput = (value, generation) => {
      if (generation !== terminal.generation) return
      const text = typeof value === 'string' ? value : (value && typeof value.toString === 'function' ? value.toString() : String(value ?? ''))
      if (!text) return
      terminal.output += text
      if (terminal.output.length > MAX_TERMINAL_OUTPUT) {
        const trim = terminal.output.length - MAX_TERMINAL_OUTPUT
        terminal.output = terminal.output.slice(trim)
        terminal.baseOffset += trim
      }
    }
    const attachOutputStream = (output, generation) => {
      if (!output) return
      if (typeof output.on === 'function') {
        output.on('data', (chunk) => appendTerminalOutput(chunk, generation))
        output.on('error', (error) => {
          if (generation !== terminal.generation) return
          terminal.error = messageOf(error)
          terminal.status = 'error'
        })
        return
      }
      if (typeof output[Symbol.asyncIterator] === 'function') {
        void (async () => {
          try {
            for await (const chunk of output) appendTerminalOutput(chunk, generation)
          } catch (error) {
            if (generation !== terminal.generation) return
            terminal.error = messageOf(error)
            terminal.status = 'error'
          }
        })()
      }
    }
    const attachTerminalOutput = (handle, generation) => {
      if (handle && handle.output) {
        attachOutputStream(handle.output, generation)
        return
      }
      // Windows runtime 0.1.0-rc.7 cannot allocate a PTY because its
      // process-inspector implementation has no win32 backend. The pipe
      // fallback still gives the embedded PowerShell a working stdin/stdout.
      attachOutputStream(handle && handle.stdout, generation)
      attachOutputStream(handle && handle.stderr, generation)
    }
    const writePipe = (stream, data) => new Promise((resolve, reject) => {
      if (!stream || typeof stream.write !== 'function') return reject(new Error('Terminal stdin 不可用'))
      try {
        stream.write(data, (error) => error ? reject(error) : resolve())
      } catch (error) {
        reject(error)
      }
    })
    const terminateTerminal = async () => {
      const handle = terminal.handle
      terminal.generation += 1
      terminal.handle = null
      terminal.write = null
      terminal.cwd = null
      terminal.status = 'closed'
      terminal.error = null
      terminal.transport = null
      if (handle && typeof handle.terminate === 'function') {
        try { await handle.terminate() } catch { /* already exited */ }
      }
    }
    const startTerminal = async (cwd) => {
      if (typeof subprocess.spawnTerminal !== 'function') throw new Error('当前 DSH 运行时不支持 PTY Terminal')
      if (terminal.opening) await terminal.opening
      const target = await fs.resolve(String(cwd))
      const cwdPath = fs.processPath(target)
      if (terminal.handle && terminal.status === 'running' && terminal.cwd === cwdPath) return terminalSnapshot()
      if (terminal.handle) await terminateTerminal()
      const opening = (async () => {
        terminal.generation += 1
        const generation = terminal.generation
        terminal.cwd = cwdPath
        terminal.output = ''
        terminal.baseOffset = 0
        terminal.error = null
        terminal.status = 'opening'
        let handle
        if (process.platform === 'win32') {
          handle = subprocess.spawn({
            argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NoExit'],
            cwd: cwdPath,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
            graceMs: 2000
          })
          terminal.transport = 'pipe'
          terminal.write = (data) => writePipe(handle.stdin, data)
        } else {
          const argv = process.platform === 'darwin' ? ['/bin/zsh', '-i'] : ['/bin/bash', '-i']
          handle = await subprocess.spawnTerminal({ argv, cwd: cwdPath, rows: 28, cols: 120, graceMs: 2000 })
          terminal.transport = 'pty'
          terminal.write = (data) => handle.write(data)
        }
        if (generation !== terminal.generation) {
          if (handle && typeof handle.terminate === 'function') await handle.terminate()
          throw new Error('Terminal 已被关闭')
        }
        terminal.handle = handle
        terminal.status = 'running'
        attachTerminalOutput(handle, generation)
        if (handle && handle.done && typeof handle.done.then === 'function') {
          handle.done.then((outcome) => {
            if (generation !== terminal.generation) return
            terminal.status = 'done'
            if (outcome && outcome.error) terminal.error = messageOf(outcome.error)
          }).catch((error) => {
            if (generation !== terminal.generation) return
            terminal.status = 'error'
            terminal.error = messageOf(error)
          })
        }
        return terminalSnapshot()
      })()
      terminal.opening = opening
      try { return await opening } finally {
        if (terminal.opening === opening) terminal.opening = null
      }
    }
    const readTerminalOutput = (since) => {
      const current = terminal.baseOffset + terminal.output.length
      const requested = Number.isFinite(since) && since >= 0 ? since : 0
      const output = requested < terminal.baseOffset
        ? terminal.output
        : terminal.output.slice(Math.max(0, requested - terminal.baseOffset))
      return { output, offset: current, status: terminal.status, cwd: terminal.cwd, error: terminal.error }
    }

    ctx.effect(() => commands.register({
      name: 'workspace',
      description: '在系统文件管理器（Windows 资源管理器）中打开当前会话的工作区目录；可附加一个路径参数打开指定目录',
      handler: async (invocation) => {
        const raw = invocation.rawInput.trim()
        const target = raw !== '' ? raw : invocation.agent?.session?.header?.cwd
        if (!target) {
          return { kind: 'error', text: '没有可打开的工作区目录：当前会话未设置 cwd，也未提供路径参数（用法：/workspace [路径]）' }
        }
        try {
          await openNativePath(String(target))
          return { kind: 'success', text: `已打开：${target}` }
        } catch (error) {
          return { kind: 'error', text: `打开失败：${error instanceof Error ? error.message : String(error)}` }
        }
      }
    }))

    // 列目录
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/open-workspace/list',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          const path = queryParam(req, 'path')
          if (path === '') return writeJson(400, { error: 'missing path' })
          const target = await fs.resolve(path)
          const entries = await fs.listDir(target)
          const rows = entries.map((entry) => ({
            name: entry.name,
            type: entry.type,
            path: fs.processPath(entry.target),
            size: entry.size ?? null
          }))
          rows.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
          writeJson(200, { path: fs.processPath(target), entries: rows })
        } catch (error) {
          writeJson(500, { error: messageOf(error) })
        }
      }
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/open-workspace/terminal/open',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          const body = await readJson(req)
          if (typeof body.cwd !== 'string' || body.cwd.trim() === '') return writeJson(400, { error: 'missing cwd' })
          await startTerminal(body.cwd)
          writeJson(200, terminalSnapshot())
        } catch (error) {
          terminal.status = 'error'
          terminal.error = messageOf(error)
          writeJson(500, { error: terminal.error, status: terminal.status })
        }
      }
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/open-workspace/terminal/read',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          const raw = queryParam(req, 'since')
          const since = raw === '' ? 0 : Number(raw)
          writeJson(200, readTerminalOutput(since))
        } catch (error) {
          writeJson(500, { error: messageOf(error) })
        }
      }
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/open-workspace/terminal/write',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          const body = await readJson(req)
          const data = typeof body.data === 'string' ? body.data : ''
          if (!data) return writeJson(400, { error: 'missing data' })
          if (data.length > MAX_TERMINAL_WRITE) return writeJson(413, { error: 'terminal input too large' })
          if (!terminal.handle || terminal.status !== 'running' || typeof terminal.write !== 'function') {
            return writeJson(409, { error: 'Terminal 未运行', status: terminal.status })
          }
          await terminal.write(data)
          writeJson(200, { ok: true })
        } catch (error) {
          writeJson(500, { error: messageOf(error) })
        }
      }
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/open-workspace/terminal/close',
      handler: async (_req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          await terminateTerminal()
          writeJson(200, terminalSnapshot())
        } catch (error) {
          writeJson(500, { error: messageOf(error) })
        }
      }
    }))

    ctx.effect(() => () => { void terminateTerminal() })

    // 读文件内容
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/open-workspace/read',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          const path = queryParam(req, 'path')
          if (path === '') return writeJson(400, { error: 'missing path' })
          const target = await fs.resolve(path)
          const info = await fs.stat(target)
          if (info !== undefined && typeof info.size === 'number' && info.size > MAX_READ_BYTES) {
            return writeJson(200, { tooLarge: true, size: info.size })
          }
          try {
            const content = await fs.readText(target)
            writeJson(200, { content, size: info?.size ?? null })
          } catch (error) {
            writeJson(200, { binary: true, size: info?.size ?? null, error: messageOf(error) })
          }
        } catch (error) {
          writeJson(500, { error: messageOf(error) })
        }
      }
    }))

    // 与产品 host.openPath 同一机制：Windows 走 powershell Invoke-Item，
    // macOS 走 open，Linux 走 xdg-open。
    async function openNativePath(path) {
      const platform = process.platform
      let argv
      if (platform === 'win32') {
        const literal = `'${path.replace(/'/g, "''")}'`
        argv = ['powershell.exe', '-NoProfile', '-Command', `Invoke-Item -LiteralPath ${literal}`]
      } else if (platform === 'darwin') {
        argv = ['open', path]
      } else {
        argv = ['xdg-open', path]
      }
      subprocess.spawn({
        argv,
        cwd: path,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: 2000
      })
    }
  }
}

function queryParam(req, name) {
  const query = (req.url ?? '').split('?')[1] ?? ''
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1))
  }
  return ''
}
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  const raw = chunks.join('').trim()
  if (!raw) return {}
  const value = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid JSON body')
  return value
}
function messageOf(error) {
  return typeof error === 'object' && error !== null && typeof error.message === 'string' ? error.message : String(error)
}
