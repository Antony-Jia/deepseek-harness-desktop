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

export function surfaceEventView(event, { fullSession = false } = {}) {
  const role = eventRole(String(event?.type || ''))
  const data = event?.data?.message || event?.data || {}
  if (fullSession && role === 'user' && data?.source?.kind !== 'user') return null
  const text = shortText(eventMessageText(event).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ''), 12000)
  if (!role || !text) return null
  return {
    seq: Number.isInteger(event?.seq) ? event.seq : 0,
    type: String(event.type),
    role,
    text,
    sourceEventSeqs: sourceSeqsOf(event)
  }
}

export async function readSelectedSurfaces({ sessionQuery, sessions }, { cwd, sessionIds, fallbackSessionId = '', includeSubagents = false, sourceMode = 'conversation' }) {
  const selected = [...new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (selected.length === 0) throw new Error('至少选择一个对话。')
  const normalizedCwd = normalizeWorkspacePath(cwd)
  if (!normalizedCwd) throw new Error('当前工作路径无效。')
  const fallbackId = String(fallbackSessionId || '').trim()
  const resolvedIds = [...new Set([...selected, ...(fallbackId ? [fallbackId] : [])])]
  const records = []
  if (typeof sessionQuery?.filterSessions === 'function') {
    records.push(...await sessionQuery.filterSessions([{ kind: 'id', values: resolvedIds }]))
  } else if (typeof sessionQuery?.listSessions === 'function') {
    const all = await sessionQuery.listSessions()
    records.push(...all.filter((record) => resolvedIds.includes(String(headerOf(record)?.id || ''))))
  }
  const recordMap = new Map(records.map((record) => [String(headerOf(record)?.id || record?.id || ''), record]))
  const readSource = async (id) => {
    const record = recordMap.get(id)
    const header = headerOf(record) || sessions?.get?.(id)?.header
    if (!header?.id) throw new Error(`所选对话不存在或已不可读：${id}`)
    if (!sameWorkspacePath(header.cwd, normalizedCwd)) throw new Error(`所选对话不属于当前工作路径：${id}`)
    if (!includeSubagents && header.origin === 'subagent') throw new Error(`不能选择子 Agent 对话：${id}`)
    if (typeof sessionQuery?.readSurface !== 'function' && typeof sessionQuery?.readSession !== 'function') {
      throw new Error('当前 DSH Runtime 未提供 sessionQuery.readSurface/readSession。')
    }
    let snapshot
    let events = []
    let surfaceError = null
    try {
      if (typeof sessionQuery?.readSurface === 'function') {
        snapshot = await sessionQuery.readSurface(id)
        events = (snapshot?.events || []).map((event) => surfaceEventView(event)).filter(Boolean)
      }
    } catch (error) {
      surfaceError = error
    }
    if (events.length === 0 && typeof sessionQuery?.readSession === 'function') {
      try {
        const full = await sessionQuery.readSession(id)
        snapshot = full || snapshot
        events = (full?.events || []).map((event) => surfaceEventView(event, { fullSession: true })).filter(Boolean)
      } catch (error) {
        if (surfaceError) throw new Error(`读取对话“${id}”失败：surface=${errorMessage(surfaceError)}；session=${errorMessage(error)}`)
        throw new Error(`读取对话“${id}”完整记录失败：${errorMessage(error)}`)
      }
    }
    if (sourceMode === 'answer-only') events = events.filter((event) => event.role === 'assistant')
    if (surfaceError && events.length === 0) throw new Error(`读取对话“${id}”失败：${errorMessage(surfaceError)}`)
    return {
      sessionId: id,
      title: `对话 ${id.slice(0, 8)}`,
      cwd: normalizeWorkspacePath(snapshot?.session?.cwd || header.cwd),
      capturedThroughSeq: Number.isInteger(snapshot?.capturedThroughSeq) ? snapshot.capturedThroughSeq : null,
      events,
      text: events.map((event) => `${event.role === 'user' ? '用户' : '助手'}：${event.text}`).join('\n\n')
    }
  }
  const sources = []
  let needsFallback = false
  for (const id of selected) {
    const source = await readSource(id)
    if (source.events.length > 0) sources.push(source)
    else needsFallback = true
  }
  if (needsFallback && fallbackId && !sources.some((source) => source.sessionId === fallbackId)) {
    const fallback = await readSource(fallbackId)
    if (fallback.events.length > 0) sources.push(fallback)
  }
  if (sources.length === 0) {
    throw new Error(fallbackId
      ? `所选对话及当前对话都没有可读取的用户/助手消息：${selected.join(', ')}`
      : `所选对话没有可读取的用户/助手消息：${selected.join(', ')}`)
  }
  if (typeof sessionQuery?.readTitleSnapshots === 'function' && sources.length) {
    const results = await sessionQuery.readTitleSnapshots(sources.map((source) => source.sessionId))
    const titles = titleResultsById(results)
    for (const source of sources) source.title = titles.get(source.sessionId) || source.title
  }
  return sources
}

export const DEFAULT_SOURCE_CHUNK_CHARS = 5000

function paragraphRanges(text) {
  const ranges = []
  const separator = /\r?\n[\t ]*\r?\n/g
  let start = 0
  let match
  while ((match = separator.exec(text)) !== null) {
    const end = match.index + match[0].length
    ranges.push({ start, end })
    start = end
  }
  if (start < text.length) ranges.push({ start, end: text.length })
  return ranges
}

function splitOversizedRange(text, range, maxChars) {
  const ranges = []
  let start = range.start
  while (start < range.end) {
    let end = Math.min(range.end, start + maxChars)
    if (end < range.end) {
      const candidate = text.slice(start, end)
      const minimumBoundary = Math.floor(maxChars * 0.6)
      let boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('。'), candidate.lastIndexOf('！'), candidate.lastIndexOf('？'), candidate.lastIndexOf('；'))
      if (boundary + 1 >= minimumBoundary) end = start + boundary + 1
    }
    ranges.push({ start, end })
    start = end
  }
  return ranges
}

function sourceEventRanges(source, text) {
  const ranges = []
  let cursor = 0
  for (const event of source.events || []) {
    const eventText = String(event?.text || '')
    if (!eventText) continue
    let start = text.indexOf(eventText, cursor)
    if (start < 0) start = text.indexOf(eventText)
    if (start < 0) continue
    const end = start + eventText.length
    ranges.push({ start, end, seq: event.seq })
    cursor = end
  }
  return ranges
}

export function chunkSourceText(source, maxChars = DEFAULT_SOURCE_CHUNK_CHARS) {
  const text = String(source?.text || '')
  if (!text) return [{ text: '', sourceRefs: [] }]
  const limit = Math.max(1, Number(maxChars) || DEFAULT_SOURCE_CHUNK_CHARS)
  const units = paragraphRanges(text).flatMap((range) => (
    range.end - range.start > limit ? splitOversizedRange(text, range, limit) : [range]
  ))
  const ranges = []
  let current = null
  for (const unit of units) {
    if (!current) {
      current = { ...unit }
      continue
    }
    if (unit.end - current.start <= limit) {
      current.end = unit.end
    } else {
      ranges.push(current)
      current = { ...unit }
    }
  }
  if (current) ranges.push(current)

  const eventRanges = sourceEventRanges(source, text)
  const chunks = []
  for (const { start, end } of ranges) {
    const chunkText = text.slice(start, end)
    const refs = eventRanges
      .filter((event) => event.start < end && event.end > start)
      .map((event) => ({ sessionId: source.sessionId, eventSeqs: [event.seq] }))
    chunks.push({ text: chunkText, sourceRefs: refs })
  }
  return chunks
}
