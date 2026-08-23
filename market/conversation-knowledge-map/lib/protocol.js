export const DATA_DIR = '.g-dsh-market-knowledge'
export const OUTPUT_MODES = new Set(['mind-map', 'knowledge-graph', 'both'])
export const GENERATION_STATUSES = [
  'created',
  'confirming',
  'reading-sources',
  'summarizing',
  'building-mind-map',
  'building-knowledge-graph',
  'validating',
  'saving',
  'completed',
  'failed',
  'cancelled'
]

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

export function shortText(value, max = 8000) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

export function loggerFacade(service, name = 'conversation-knowledge-map') {
  if (!service) return null
  try {
    const logger = typeof service === 'function' ? service(name) : service
    return logger && typeof logger === 'object' ? logger : null
  } catch {
    return null
  }
}

export function logMessage(logger, level, format, ...params) {
  try { logger?.[level]?.(`[conversation-knowledge-map] ${format}`, ...params) } catch { /* logging must not affect the plugin */ }
}

function diagnosticShape(value, depth = 0) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value !== 'object') return typeof value
  if (depth >= 2) return Array.isArray(value) ? `array(${value.length})` : 'object'
  if (Array.isArray(value)) return `array(${value.length})[${value.slice(0, 6).map((item) => diagnosticShape(item, depth + 1)).join(',')}]`
  const keys = Object.keys(value).sort()
  const suffix = keys.length > 12 ? ',…' : ''
  return `object{${keys.slice(0, 12).join(',')}${suffix}}`
}

export function diagnosticSummary(value) {
  return diagnosticShape(value)
}

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function parseUrl(req) {
  if (req?.url instanceof URL) return req.url
  return new URL(String(req?.url || '/'), 'http://dsh.local')
}

export async function readJson(req, maxBytes = 512 * 1024) {
  if (req?.body && typeof req.body === 'object') return req.body
  if (typeof req?.body === 'string') return JSON.parse(req.body || '{}')
  const chunks = []
  let size = 0
  for await (const chunk of req || []) {
    size += Buffer.byteLength(chunk)
    if (size > maxBytes) throw new Error('请求体过大。')
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : {}
}

export function jsonResponse(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead?.(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end?.(text)
  return body
}

export function sseWrite(res, eventName, body, id) {
  if (id !== undefined) res.write(`id: ${id}\n`)
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

export function methodOf(req) {
  return String(req?.method || 'GET').toUpperCase()
}

export function safeId(value, label = 'ID') {
  const result = String(value || '').trim()
  if (!result || result.length > 256 || /[\u0000-\u001f]/.test(result)) throw new Error(`${label} 无效。`)
  return result
}

export function contentText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object' && item.type === 'reasoning') return ''
      return contentText(item)
    }).filter(Boolean).join('')
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content !== 'undefined') return contentText(value.content)
    if (typeof value.value === 'string') return value.value
  }
  return ''
}

export function eventMessageText(event) {
  const data = event?.data || event || {}
  const message = data.message || data
  return contentText(message.content ?? message.text ?? message)
}

export function makeUserMessage(text, messageId = `knowledge-map-${Date.now()}`) {
  return {
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text: String(text || '') }],
    source: {
      kind: 'plugin',
      plugin: '@p-dsh-market/conversation-knowledge-map',
      form: 'generation'
    }
  }
}
