import { URL } from 'node:url'

export function parseUrl(req) {
  const raw = typeof req === 'string' ? req : req?.url || '/'
  return new URL(raw, 'http://dsh.local')
}

export function methodOf(req) {
  return String(req?.method || 'GET').toUpperCase()
}

export function messageOf(error) {
  if (!error) return 'Unknown error'
  return String(error.message || error.reason || error)
}

export function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead?.(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end?.(body)
  return payload
}

export async function readJson(req) {
  if (req?.body && typeof req.body === 'object') return req.body
  if (typeof req?.json === 'function') return req.json()
  let raw = ''
  for await (const chunk of req || []) raw += chunk
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON。')
  }
}

export function writeError(res, status, error) {
  return jsonResponse(res, status, { ok: false, error: messageOf(error), code: error?.code || 'GRAPH_JOB_ERROR' })
}

export function sseWrite(res, eventName, body, id) {
  if (id !== undefined) res.write(`id: ${id}\n`)
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

