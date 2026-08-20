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
const LOG_NAME = 'akshare-market-analysis'
const MAX_LOG_TEXT = 512

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

function loggerFacade(service, name = LOG_NAME) {
  if (!service) return null
  try {
    const logger = typeof service === 'function' ? service(name) : service
    return logger && typeof logger === 'object' ? logger : null
  } catch {
    return null
  }
}

function logMessage(logger, level, format, ...params) {
  try { logger?.[level]?.(format, ...params) } catch { /* logging must not affect the plugin */ }
}

function logText(value, maxLength = MAX_LOG_TEXT) {
  const text = String(value ?? '')
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function payloadSummary(payload) {
  if (!payload || typeof payload !== 'object') return '{}'
  const summary = {
    market: payload.market,
    symbol: payload.symbol,
    queryPresent: typeof payload.query === 'string' && payload.query.length > 0,
    filters: payload.filters ? Object.keys(payload.filters) : [],
    sort: payload.sort ? `${payload.sort.field}:${payload.sort.direction}` : undefined,
    limit: payload.limit,
    period: payload.period,
    adjust: payload.adjust,
    maxBars: payload.maxBars,
    indicators: Array.isArray(payload.indicators) ? payload.indicators : undefined
  }
  return logText(JSON.stringify(summary), 1024)
}

function resultSummary(value) {
  if (!value || typeof value !== 'object') return typeof value
  const summary = {
    kind: value.kind,
    rows: Array.isArray(value.rows) ? value.rows.length : undefined,
    bars: Array.isArray(value.bars) ? value.bars.length : undefined,
    cacheHit: value.cache?.hit
  }
  return logText(JSON.stringify(summary), 512)
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

function attachSidecarStderr(handle, logger) {
  const stream = handle?.stderr
  if (!stream) return false
  let buffer = ''
  const flush = (final = false) => {
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) logMessage(logger, 'info', 'sidecar stderr: %s', logText(line))
    }
    if (final && buffer.trim()) {
      logMessage(logger, 'info', 'sidecar stderr: %s', logText(buffer.trim()))
      buffer = ''
    }
    if (buffer.length > 16 * 1024) buffer = buffer.slice(-16 * 1024)
  }
  streamChunks(
    stream,
    (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
      flush()
    },
    () => flush(true),
    (error) => logMessage(logger, 'error', 'sidecar stderr stream failed: %s', messageOf(error))
  )
  return true
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
    this.logger = loggerFacade(options.logger)
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
    const startedAt = Date.now()
    logMessage(this.logger, 'info', 'sidecar start runtime=%s cacheDir=%s', this.runtimePath, this.cacheDir)
    let handle
    try {
      handle = this.subprocess.spawn({
        argv: [this.runtimePath],
        cwd: dirname(this.runtimePath),
        env: { DSH_AKSHARE_TOKEN: token, DSH_AKSHARE_CACHE_DIR: this.cacheDir },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 2000
      })
    } catch (error) {
      logMessage(this.logger, 'error', 'sidecar spawn failed elapsedMs=%d error=%s', Date.now() - startedAt, messageOf(error))
      throw error
    }
    this.handle = handle
    this.token = token
    attachSidecarStderr(handle, this.logger)
    try {
      const ready = await waitForReady(handle, this.startupTimeoutMs, signal)
      this.baseUrl = `http://127.0.0.1:${ready.port}`
      logMessage(this.logger, 'info', 'sidecar ready port=%d elapsedMs=%d', ready.port, Date.now() - startedAt)
      return { baseUrl: this.baseUrl, nonce: ready.nonce || null }
    } catch (error) {
      logMessage(this.logger, 'error', 'sidecar start failed elapsedMs=%d error=%s', Date.now() - startedAt, messageOf(error))
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
    const startedAt = Date.now()
    logMessage(this.logger, 'info', 'sidecar request start endpoint=%s payload=%s', endpoint, payloadSummary(payload))
    try {
      if (this.requestImpl) {
        const value = await this.requestImpl(endpoint, payload, signal)
        logMessage(this.logger, 'info', 'sidecar request success endpoint=%s status=mock elapsedMs=%d result=%s', endpoint, Date.now() - startedAt, resultSummary(value))
        return value
      }
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
        logMessage(this.logger, 'info', 'sidecar request success endpoint=%s status=%d elapsedMs=%d bytes=%d result=%s', endpoint, response.status, Date.now() - startedAt, text.length, resultSummary(value))
        return value
      } finally {
        signal?.removeEventListener?.('abort', onAbort)
      }
    } catch (error) {
      logMessage(this.logger, 'error', 'sidecar request failed endpoint=%s elapsedMs=%d code=%s status=%s retryable=%s error=%s', endpoint, Date.now() - startedAt, error?.code ?? '', error?.status ?? '', error?.retryable ?? false, messageOf(error))
      throw error
    }
  }

  async health(signal) {
    const startedAt = Date.now()
    logMessage(this.logger, 'info', 'sidecar health start')
    try {
      if (this.requestImpl) {
        const value = await this.requestImpl('/health', null, signal)
        logMessage(this.logger, 'info', 'sidecar health success status=mock elapsedMs=%d', Date.now() - startedAt)
        return value
      }
      await this.ensure(signal)
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { headers: { Authorization: `Bearer ${this.token}` }, signal })
      const value = await response.json()
      if (!response.ok) throw responseError(response.status, value)
      logMessage(this.logger, 'info', 'sidecar health success status=%d elapsedMs=%d', response.status, Date.now() - startedAt)
      return value
    } catch (error) {
      logMessage(this.logger, 'error', 'sidecar health failed elapsedMs=%d error=%s', Date.now() - startedAt, messageOf(error))
      throw error
    }
  }

  async dispose() {
    const handle = this.handle
    this.handle = null
    this.baseUrl = ''
    this.token = ''
    this.starting = null
    logMessage(this.logger, 'info', 'sidecar dispose active=%s', Boolean(handle))
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

function registrationEffect(register, value) {
  return () => {
    const disposer = register(value)
    return typeof disposer === 'function' ? disposer : undefined
  }
}

function endpointFor(name) {
  if (name === TOOL_NAMES.snapshot) return '/v1/market/snapshot'
  if (name === TOOL_NAMES.history) return '/v1/stock/history'
  if (name === TOOL_NAMES.analysis) return '/v1/stock/analysis'
  throw new Error(`未知行情工具: ${name}`)
}

export function createHost(options = {}) {
  return {
    // DSH 0.1.0-rc.7 does not expose a `logger` service. Keep logging as an
    // optional capability discovered from the context instead of making it a
    // hard Cordis dependency that leaves the whole plugin pending.
    inject: ['skills', 'tools', 'subprocess', 'webServer'],
    apply(ctx) {
      const skills = ctx.get?.('skills') || ctx.skills
      const tools = ctx.get?.('tools') || ctx.tools
      const subprocess = ctx.get?.('subprocess') || ctx.subprocess
      const webServer = ctx.get?.('webServer') || ctx.webServer
      const logger = loggerFacade(options.logger || ctx.get?.('logger') || ctx.logger)
      logMessage(logger, 'info', 'host apply plugin=%s runtime=%s', PLUGIN_ID, options.runtimePath || DEFAULT_RUNTIME_PATH)
      const manager = options.manager || new SidecarManager({
        subprocess,
        runtimePath: options.runtimePath || DEFAULT_RUNTIME_PATH,
        packageRoot: PACKAGE_ROOT,
        cacheDir: options.cacheDir,
        fetchImpl: options.fetchImpl,
        requestImpl: options.requestImpl,
        logger
      })

      if (skills?.register) {
        ctx.effect(registrationEffect(skills.register.bind(skills), {
          name: 'akshare-market-analysis',
          description: '使用固定 AKShare 数据源查询 A 股或港股行情并分析 K 线。',
          whenToUse: '用户询问股票行情、历史走势、K 线、技术指标或要求对比筛选时。',
          source: 'runtime',
          content: readSkill(),
          resourceBase: { kind: 'directory', path: join(PACKAGE_ROOT, 'skills', 'akshare-market-analysis') }
        }))
        logMessage(logger, 'info', 'skill registered name=akshare-market-analysis')
      }

      if (tools?.register) {
        const definitions = createToolDefinitions(async (name, args, exec) => {
          const startedAt = Date.now()
          logMessage(logger, 'info', 'tool call start name=%s args=%s', name, payloadSummary(args))
          try {
            const normalized = name === TOOL_NAMES.snapshot
              ? normalizeSnapshotArgs(args)
              : normalizeHistoryArgs(args, { analysis: name === TOOL_NAMES.analysis })
            const result = await manager.request(endpointFor(name), normalized, exec?.signal)
            logMessage(logger, 'info', 'tool call success name=%s elapsedMs=%d result=%s', name, Date.now() - startedAt, resultSummary(result))
            return result
          } catch (error) {
            logMessage(logger, 'error', 'tool call failed name=%s elapsedMs=%d code=%s status=%s error=%s', name, Date.now() - startedAt, error?.code ?? '', error?.status ?? '', messageOf(error))
            throw error
          }
        })
        for (const definition of definitions) ctx.effect(registrationEffect(tools.register.bind(tools), definition))
        logMessage(logger, 'info', 'tools registered count=%d names=%s', definitions.length, definitions.map((definition) => definition.name).join(','))
      }

      if (webServer?.register) ctx.effect(registrationEffect(webServer.register.bind(webServer), {
        kind: 'exact',
        path: '/akshare-market/health',
        handler: async (_req, res) => {
          logMessage(logger, 'info', 'health route request start')
          try {
            const health = await manager.health()
            jsonResponse(res, 200, health)
            logMessage(logger, 'info', 'health route request success status=200')
          } catch (error) {
            jsonResponse(res, 503, { ok: false, error: messageOf(error) })
            logMessage(logger, 'error', 'health route request failed status=503 error=%s', messageOf(error))
          }
        }
      }))

      ctx.effect(() => () => {
        logMessage(logger, 'info', 'host dispose start')
        void manager.dispose()
      })
    }
  }
}

const host = createHost()
host.pluginId = PLUGIN_ID
host.packageRoot = PACKAGE_ROOT
host.runtimePath = DEFAULT_RUNTIME_PATH

export { PACKAGE_ROOT, DEFAULT_RUNTIME_PATH }
export default host
