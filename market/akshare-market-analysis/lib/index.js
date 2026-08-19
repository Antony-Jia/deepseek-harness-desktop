import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse as parsePath, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { createToolDefinitions } from './schemas.js'
import {
  PLUGIN_ID,
  TOOL_NAMES,
  normalizeHistoryArgs,
  normalizeSnapshotArgs
} from './protocol.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RUNTIME_PATH = join(PACKAGE_ROOT, 'runtime', 'win32-x64', 'akshare-service.exe')
const SKILL_PATH = join(PACKAGE_ROOT, 'skills', 'akshare-market-analysis', 'SKILL.md')
const DEFAULT_CACHE_DIR = join(tmpdir(), 'dsh-akshare-market-analysis')
const STARTUP_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

function abortError() {
  const error = new Error('行情 sidecar 请求已取消。')
  error.name = 'AbortError'
  return error
}

function ensureNotAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function pathInside(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (parsePath(resolvedRoot).root.toLowerCase() !== parsePath(resolvedCandidate).root.toLowerCase()) return false
  const rel = relative(resolvedRoot, resolvedCandidate)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${'\\'}`) && !rel.includes(`../`))
}

export function validateRuntimePath(runtimePath = DEFAULT_RUNTIME_PATH, packageRoot = PACKAGE_ROOT) {
  const candidate = resolve(String(runtimePath))
  if (!pathInside(packageRoot, candidate)) throw new Error('AKShare runtime 必须位于插件包内。')
  if (!candidate.toLowerCase().endsWith('.exe')) throw new Error('AKShare runtime 必须是 Windows .exe。')
  return candidate
}

function streamChunks(stream, onChunk, onEnd, onError) {
  if (!stream) return false
  if (typeof stream.on === 'function') {
    const onData = (chunk) => onChunk(chunk)
    stream.on('data', onData)
    if (typeof stream.once === 'function') {
      stream.once('end', onEnd)
      stream.once('error', onError)
    } else {
      stream.on('end', onEnd)
      stream.on('error', onError)
    }
    return true
  }
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    void (async () => {
      try {
        for await (const chunk of stream) onChunk(chunk)
        onEnd()
      } catch (error) {
        onError(error)
      }
    })()
    return true
  }
  return false
}

function waitForReady(handle, timeoutMs, signal) {
  const stream = handle?.stdout || handle?.output
  return new Promise((resolveReady, reject) => {
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error('AKShare sidecar 启动超时。')), timeoutMs)
    const onAbort = () => finish(abortError())
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      cleanup()
      error ? reject(error) : resolveReady(value)
    }
    const inspect = (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024)
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let value
        try { value = JSON.parse(line) } catch { continue }
        if (value && value.ready === true) {
          if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return finish(new Error('AKShare sidecar 返回了无效端口。'))
          if (value.protocolVersion !== 1) return finish(new Error('AKShare sidecar 协议版本不兼容。'))
          return finish(null, value)
        }
        if (value && value.ready === false) return finish(new Error('AKShare sidecar 启动失败。'))
      }
    }
    const started = streamChunks(stream, inspect, () => finish(new Error('AKShare sidecar 在就绪前退出。')), finish)
    if (!started) {
      if (handle?.ready && typeof handle.ready.then === 'function') handle.ready.then((value) => finish(null, value)).catch(finish)
      else finish(new Error('AKShare sidecar 没有可读取的就绪通道。'))
    }
    if (handle?.done && typeof handle.done.then === 'function') {
      handle.done.then((outcome) => {
        if (outcome?.error) finish(new Error(messageOf(outcome.error)))
        else if (!settled) finish(new Error('AKShare sidecar 在就绪前退出。'))
      }).catch(finish)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function responseError(status, body) {
  const detail = body && body.error ? body.error : {}
  const error = new Error(typeof detail.message === 'string' ? detail.message : `AKShare sidecar HTTP ${status}`)
  error.code = typeof detail.code === 'string' ? detail.code : `HTTP_${status}`
  error.retryable = detail.retryable === true || status >= 500
  error.status = status
  return error
}

export class SidecarManager {
  constructor(options = {}) {
    this.subprocess = options.subprocess
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.requestImpl = options.requestImpl || null
    this.runtimePath = validateRuntimePath(options.runtimePath || DEFAULT_RUNTIME_PATH, options.packageRoot || PACKAGE_ROOT)
    this.cacheDir = String(options.cacheDir || process.env.DSH_AKSHARE_CACHE_DIR || DEFAULT_CACHE_DIR)
    this.startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) ? options.startupTimeoutMs : STARTUP_TIMEOUT_MS
    this.handle = null
    this.baseUrl = ''
    this.token = ''
    this.starting = null
  }

  async ensure(signal) {
    ensureNotAborted(signal)
    if (this.requestImpl) return { baseUrl: 'mock://akshare' }
    if (this.baseUrl) return { baseUrl: this.baseUrl }
    if (this.starting) return this.starting
    this.starting = this.start(signal).finally(() => { this.starting = null })
    return this.starting
  }

  async start(signal) {
    if (!this.subprocess || typeof this.subprocess.spawn !== 'function') throw new Error('当前 DSH 运行时不支持启动 AKShare sidecar。')
    if (!existsSync(this.runtimePath)) throw new Error(`AKShare sidecar 未随插件包提供：${this.runtimePath}`)
    const token = randomBytes(32).toString('hex')
    const handle = this.subprocess.spawn({
      argv: [this.runtimePath],
      cwd: dirname(this.runtimePath),
      env: { DSH_AKSHARE_TOKEN: token, DSH_AKSHARE_CACHE_DIR: this.cacheDir },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: 2000
    })
    this.handle = handle
    this.token = token
    try {
      const ready = await waitForReady(handle, this.startupTimeoutMs, signal)
      this.baseUrl = `http://127.0.0.1:${ready.port}`
      return { baseUrl: this.baseUrl, nonce: ready.nonce || null }
    } catch (error) {
      await this.stopHandle(handle)
      this.handle = null
      this.token = ''
      throw error
    }
  }

  async stopHandle(handle) {
    if (!handle || typeof handle.terminate !== 'function') return
    try { await handle.terminate() } catch { /* process may already have exited */ }
  }

  async request(endpoint, payload, signal) {
    ensureNotAborted(signal)
    if (this.requestImpl) return this.requestImpl(endpoint, payload, signal)
    await this.ensure(signal)
    if (typeof this.fetchImpl !== 'function') throw new Error('当前 DSH 运行时没有 fetch。')
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('AKShare sidecar 返回体超出大小限制。')
      let value
      try { value = text ? JSON.parse(text) : {} } catch { throw new Error('AKShare sidecar 返回了非法 JSON。') }
      if (!response.ok) throw responseError(response.status, value)
      return value
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  async health(signal) {
    if (this.requestImpl) return this.requestImpl('/health', null, signal)
    await this.ensure(signal)
    const response = await this.fetchImpl(`${this.baseUrl}/health`, { headers: { Authorization: `Bearer ${this.token}` }, signal })
    const value = await response.json()
    if (!response.ok) throw responseError(response.status, value)
    return value
  }

  async dispose() {
    const handle = this.handle
    this.handle = null
    this.baseUrl = ''
    this.token = ''
    this.starting = null
    await this.stopHandle(handle)
  }
}

function readSkill() {
  return readFileSync(SKILL_PATH, 'utf8').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '')
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function endpointFor(name) {
  if (name === TOOL_NAMES.snapshot) return '/v1/market/snapshot'
  if (name === TOOL_NAMES.history) return '/v1/stock/history'
  if (name === TOOL_NAMES.analysis) return '/v1/stock/analysis'
  throw new Error(`未知行情工具: ${name}`)
}

export function createHost(options = {}) {
  return {
    inject: ['skills', 'tools', 'subprocess', 'webServer'],
    apply(ctx) {
      const skills = ctx.get?.('skills') || ctx.skills
      const tools = ctx.get?.('tools') || ctx.tools
      const subprocess = ctx.get?.('subprocess') || ctx.subprocess
      const webServer = ctx.get?.('webServer') || ctx.webServer
      const manager = options.manager || new SidecarManager({
        subprocess,
        runtimePath: options.runtimePath || DEFAULT_RUNTIME_PATH,
        packageRoot: PACKAGE_ROOT,
        cacheDir: options.cacheDir,
        fetchImpl: options.fetchImpl,
        requestImpl: options.requestImpl
      })

      if (skills?.register) ctx.effect(() => skills.register({
        name: 'akshare-market-analysis',
        description: '使用固定 AKShare 数据源查询 A 股或港股行情并分析 K 线。',
        whenToUse: '用户询问股票行情、历史走势、K 线、技术指标或要求对比筛选时。',
        source: 'runtime',
        content: readSkill(),
        resourceBase: { kind: 'directory', path: join(PACKAGE_ROOT, 'skills', 'akshare-market-analysis') }
      }))

      if (tools?.register) {
        const definitions = createToolDefinitions(async (name, args, exec) => {
          const normalized = name === TOOL_NAMES.snapshot
            ? normalizeSnapshotArgs(args)
            : normalizeHistoryArgs(args, { analysis: name === TOOL_NAMES.analysis })
          return manager.request(endpointFor(name), normalized, exec?.signal)
        })
        for (const definition of definitions) ctx.effect(() => tools.register(definition))
      }

      if (webServer?.register) ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/akshare-market/health',
        handler: async (_req, res) => {
          try {
            const health = await manager.health()
            jsonResponse(res, 200, health)
          } catch (error) {
            jsonResponse(res, 503, { ok: false, error: messageOf(error) })
          }
        }
      }))

      ctx.effect(() => () => { void manager.dispose() })
      return manager
    }
  }
}

const host = createHost()
host.pluginId = PLUGIN_ID
host.packageRoot = PACKAGE_ROOT
host.runtimePath = DEFAULT_RUNTIME_PATH

export { PACKAGE_ROOT, DEFAULT_RUNTIME_PATH }
export default host
