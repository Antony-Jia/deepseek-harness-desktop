export const MAX_DISCUSSION_EVENTS = 300
export const MAX_DISCUSSION_MESSAGES = 240
export const MAX_CONTEXT_CHARS = 14000

export function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

export function contentText(content, kind = 'text') {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    if (block.type === kind) return typeof block.text === 'string' ? block.text : ''
    if (kind === 'text' && block.type === 'tool-call') return block.name ? `调用工具：${block.name}` : ''
    return ''
  }).filter(Boolean).join('\n\n').trim()
}

export function messageMarkdown(message) {
  return contentText(message?.content) || (typeof message?.text === 'string' ? message.text.trim() : '')
}

export function messageReasoning(message) {
  return contentText(message?.content, 'reasoning')
}

export function shortText(value, max = 8000) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}\n\n…（内容已截断）` : text
}

export function eventSummary(event) {
  if (!event || typeof event !== 'object') return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  return {
    type: String(event.type || ''),
    seq: Number.isSafeInteger(event.seq) ? event.seq : undefined,
    turn: Number.isInteger(data.turn) ? data.turn : undefined,
    step: Number.isInteger(data.step) ? data.step : undefined
  }
}

export function safePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '')
}

export async function readJson(req, maxBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    total += Buffer.byteLength(text)
    if (total > maxBytes) throw new Error('请求体过大。')
    chunks.push(text)
  }
  const raw = chunks.join('').trim()
  if (!raw) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。')
  return value
}

export function parseUrl(req) {
  return new URL(req?.url || '/', 'http://dsh.local')
}

export function jsonResponse(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

export function makeUserMessage(text, messageId) {
  return {
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: '@p-dsh-market/multi-agent-roundtable', form: 'relay' }
  }
}
