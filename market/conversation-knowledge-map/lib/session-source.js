import path from 'node:path'

import { errorMessage, eventMessageText, shortText } from './protocol.js'

const WINDOWS_PATH = process.platform === 'win32'

export function normalizeWorkspacePath(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const absolute = path.resolve(raw)
  const normalized = path.normalize(absolute)
  const root = path.parse(normalized).root
  return normalized.length > root.length ? normalized.replace(/[\\/]$/, '') : normalized
}

export function sameWorkspacePath(left, right) {
  const a = normalizeWorkspacePath(left)
  const b = normalizeWorkspacePath(right)
  if (!a || !b) return false
  return WINDOWS_PATH ? a.toLowerCase() === b.toLowerCase() : a === b
}

function headerOf(record) {
  return record?.header || record?.session || record || null
}

function titleOf(value) {
  const title = value?.title ?? value?.value?.title ?? value
  if (typeof title === 'string') return shortText(title, 160)
  if (typeof title?.title === 'string') return shortText(title.title, 160)
  if (typeof title?.text === 'string') return shortText(title.text, 160)
  return ''
}

function titleResultsById(results) {
  const map = new Map()
  for (const item of results || []) {
    if (item?.status === 'fulfilled') map.set(String(item.sessionId), titleOf(item.value))
  }
  return map
}

export function sessionRecordView(record, title = '', currentSessionId = '') {
  const header = headerOf(record)
  const id = String(header?.id || record?.id || '')
  return {
    id,
    title: title || `未命名对话 ${id.slice(0, 8)}`,
    createdAt: Number(header?.createdAt || 0),
    cwd: String(header?.cwd || ''),
    parentSession: String(header?.parentSession || ''),
    origin: String(header?.origin || ''),
    live: record?.live !== false,
    persisted: record?.persisted !== false,
    current: id === currentSessionId
  }
}

export async function resolveAnchorSession({ sessionQuery, sessions }, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id || id === 'active') return null
  const live = sessions?.get?.(id)
  if (live?.header?.id || live?.id === id) {
    return { header: live.header || live, live: true, persisted: true }
  }
  if (typeof sessionQuery?.filterSessions === 'function') {
    const records = await sessionQuery.filterSessions([{ kind: 'id', values: [id] }])
    return records?.find((record) => String(headerOf(record)?.id || '') === id) || null
  }
  if (typeof sessionQuery?.listSessions === 'function') {
    const records = await sessionQuery.listSessions()
    return records?.find((record) => String(headerOf(record)?.id || '') === id) || null
  }
  return null
}

export async function listWorkspaceSessions({ sessionQuery, sessions }, cwd, currentSessionId = '', includeSubagents = false) {
  const normalizedCwd = normalizeWorkspacePath(cwd)
  if (!normalizedCwd) return []
  let records = []
  if (typeof sessionQuery?.filterSessions === 'function') {
    records = await sessionQuery.filterSessions([{ kind: 'cwd', values: [cwd] }])
  } else if (typeof sessionQuery?.listSessions === 'function') {
    records = await sessionQuery.listSessions()
  } else if (typeof sessions?.list === 'function') {
    records = await sessions.list()
  }
  records = (records || []).filter((record) => {
    const header = headerOf(record)
    return sameWorkspacePath(header?.cwd, normalizedCwd) && (includeSubagents || header?.origin !== 'subagent')
  })
  const ids = records.map((record) => String(headerOf(record)?.id || record?.id || '')).filter(Boolean)
  let titleResults = []
  if (typeof sessionQuery?.readTitleSnapshots === 'function' && ids.length) {
    titleResults = await sessionQuery.readTitleSnapshots(ids)
  }
  const titles = titleResultsById(titleResults)
  return records
    .map((record) => sessionRecordView(record, titles.get(String(headerOf(record)?.id || '')), currentSessionId))
    .filter((record) => record.id)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
}

function eventRole(type) {
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  return ''
}

function sourceSeqsOf(event) {
  const value = event?.sourceEventSeqs || event?.data?.sourceEventSeqs || []
  return Array.isArray(value) ? value.filter((item) => Number.isInteger(item) && item >= 0) : []
}

export function surfaceEventView(event) {
  const role = eventRole(String(event?.type || ''))
  const text = shortText(eventMessageText(event), 12000)
  if (!role || !text) return null
  return {
    seq: Number.isInteger(event?.seq) ? event.seq : 0,
    type: String(event.type),
    role,
    text,
    sourceEventSeqs: sourceSeqsOf(event)
  }
}

export async function readSelectedSurfaces({ sessionQuery, sessions }, { cwd, sessionIds, includeSubagents = false }) {
  const selected = [...new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (selected.length === 0) throw new Error('至少选择一个对话。')
  const normalizedCwd = normalizeWorkspacePath(cwd)
  if (!normalizedCwd) throw new Error('当前工作路径无效。')
  const records = []
  if (typeof sessionQuery?.filterSessions === 'function') {
    records.push(...await sessionQuery.filterSessions([{ kind: 'id', values: selected }]))
  } else if (typeof sessionQuery?.listSessions === 'function') {
    const all = await sessionQuery.listSessions()
    records.push(...all.filter((record) => selected.includes(String(headerOf(record)?.id || ''))))
  }
  const recordMap = new Map(records.map((record) => [String(headerOf(record)?.id || record?.id || ''), record]))
  const sources = []
  for (const id of selected) {
    const record = recordMap.get(id)
    const header = headerOf(record) || sessions?.get?.(id)?.header
    if (!header?.id) throw new Error(`所选对话不存在或已不可读：${id}`)
    if (!sameWorkspacePath(header.cwd, normalizedCwd)) throw new Error(`所选对话不属于当前工作路径：${id}`)
    if (!includeSubagents && header.origin === 'subagent') throw new Error(`不能选择子 Agent 对话：${id}`)
    if (typeof sessionQuery?.readSurface !== 'function') throw new Error('当前 DSH Runtime 未提供 sessionQuery.readSurface。')
    let surface
    try {
      surface = await sessionQuery.readSurface(id)
    } catch (error) {
      throw new Error(`读取对话“${id}”失败：${errorMessage(error)}`)
    }
    const events = (surface?.events || []).map(surfaceEventView).filter(Boolean)
    sources.push({
      sessionId: id,
      title: `对话 ${id.slice(0, 8)}`,
      cwd: normalizeWorkspacePath(surface?.session?.cwd || header.cwd),
      capturedThroughSeq: Number.isInteger(surface?.capturedThroughSeq) ? surface.capturedThroughSeq : null,
      events,
      text: events.map((event) => `${event.role === 'user' ? '用户' : '助手'}：${event.text}`).join('\n\n')
    })
  }
  if (typeof sessionQuery?.readTitleSnapshots === 'function' && sources.length) {
    const results = await sessionQuery.readTitleSnapshots(sources.map((source) => source.sessionId))
    const titles = titleResultsById(results)
    for (const source of sources) source.title = titles.get(source.sessionId) || source.title
  }
  return sources
}

export function chunkSourceText(source, maxChars = 9000) {
  const text = String(source?.text || '')
  if (!text) return [{ text: '', sourceRefs: [] }]
  const chunks = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(text.length, start + maxChars)
    const chunkText = text.slice(start, end)
    const refs = (source.events || [])
      .filter((event) => event.text && text.indexOf(event.text, start) >= start && text.indexOf(event.text, start) < end)
      .map((event) => ({ sessionId: source.sessionId, eventSeqs: [event.seq] }))
    chunks.push({ text: chunkText, sourceRefs: refs })
    start = end
  }
  return chunks
}
