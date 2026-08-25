import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { MAX_STATE_BYTES, SCHEMA_VERSION, createPresentationId, sessionFileKey } from './protocol.js'

export class AmapStateError extends Error {
  constructor(message, code = 'STATE_ERROR') {
    super(message)
    this.name = 'AmapStateError'
    this.code = code
  }
}

function defaultRoot() {
  return process.env.DSH_AMAP_MAP_DATA_DIR || join(
    process.env.LOCALAPPDATA || homedir(),
    'dsh-desktop',
    'plugin-data',
    'amap-map-assistant'
  )
}

function assertSessionId(sessionId) {
  const value = String(sessionId || '').trim()
  if (!value || value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new AmapStateError('地图状态 Session ID 无效。', 'INVALID_SESSION')
  return value
}

export class SessionStateStore {
  constructor(options = {}) {
    this.root = options.root || defaultRoot()
    this.sessionsDir = join(this.root, 'sessions')
    this.maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : MAX_STATE_BYTES
    this.writes = new Map()
  }

  pathFor(sessionId) {
    return join(this.sessionsDir, `${sessionFileKey(assertSessionId(sessionId))}.json`)
  }

  async ensureDirectories() {
    await mkdir(this.sessionsDir, { recursive: true })
  }

  async read(sessionId) {
    const id = assertSessionId(sessionId)
    const path = this.pathFor(id)
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: null, revision: 0 }
      throw new AmapStateError(`地图状态读取失败：${error.message || error}`, 'STATE_READ_FAILED')
    }
    try {
      if (Buffer.byteLength(raw) > this.maxBytes) throw new Error('状态文件超出大小上限。')
      const state = JSON.parse(raw)
      if (!state || typeof state !== 'object' || state.schemaVersion !== SCHEMA_VERSION || state.sessionId !== id) throw new Error('状态文件结构不匹配。')
      return { state, revision: Number.isInteger(state.revision) ? state.revision : 0 }
    } catch (error) {
      const quarantine = `${path}.corrupt-${Date.now()}`
      try { await rename(path, quarantine) } catch { /* retain the original if quarantine is unavailable */ }
      throw new AmapStateError(`地图状态文件损坏，已隔离并保留原文件：${error.message || error}`, 'STATE_CORRUPT')
    }
  }

  async write(sessionId, state) {
    const id = assertSessionId(sessionId)
    if (!state || typeof state !== 'object' || state.sessionId !== id) throw new AmapStateError('地图状态与当前 Session 不匹配。', 'STATE_SESSION_MISMATCH')
    const payload = JSON.stringify(state)
    if (Buffer.byteLength(payload) > this.maxBytes) throw new AmapStateError('地图状态超出 512KB 大小上限。', 'STATE_TOO_LARGE')
    await this.ensureDirectories()
    const path = this.pathFor(id)
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temp, path)
    } catch (error) {
      // Windows cannot replace an existing file with rename. The target is a
      // single hashed plugin-owned state file, so the fallback remains scoped.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error
      await rm(path, { force: true })
      await rename(temp, path)
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
    return state
  }

  enqueue(sessionId, operation) {
    const id = assertSessionId(sessionId)
    const previous = this.writes.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.writes.set(id, next.finally(() => {
      if (this.writes.get(id) === next) this.writes.delete(id)
    }))
    return next
  }

  commit(sessionId, presentation, idempotencyKey = '') {
    const id = assertSessionId(sessionId)
    const callId = String(idempotencyKey || '').trim().slice(0, 256)
    return this.enqueue(id, async () => {
      let current
      try {
        current = await this.read(id)
      } catch (error) {
        if (error?.code !== 'STATE_CORRUPT') throw error
        current = { state: null, revision: 0 }
      }
      if (callId && current.state?.lastToolCallId === callId) return current.state
      const now = new Date().toISOString()
      const next = {
        ...presentation,
        id: createPresentationId(),
        sessionId: id,
        revision: current.revision + 1,
        createdAt: now,
        updatedAt: now,
        ...(callId ? { lastToolCallId: callId } : {})
      }
      await this.write(id, next)
      return next
    })
  }
}
