import { jsonResponse, methodOf, parseUrl } from './protocol.js'

const DEFAULT_UPSTREAM = 'https://restapi.amap.com'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const ALLOWED_PATHS = [
  /^\/v3\/(config|geocode|place|direction|distance|weather|ip|assistant)(\/|$)/,
  /^\/v4\/(geocode|place|direction|distance|weather|ip|assistant)(\/|$)/
]

function proxyPath(req) {
  const pathname = parseUrl(req).pathname
  const marker = '/_AMapService'
  const index = pathname.indexOf(marker)
  if (index < 0) throw new Error('高德安全代理路径无效。')
  const path = pathname.slice(index + marker.length) || '/'
  if (!path.startsWith('/') || path.includes('..') || path.includes('\\') || /%2f|%5c|%2e/i.test(path)) throw new Error('高德安全代理拒绝该路径。')
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) throw new Error('高德安全代理未允许该服务路径。')
  return path
}

async function requestBody(req) {
  if (req?.body && Buffer.isBuffer(req.body)) {
    if (req.body.length > MAX_REQUEST_BYTES) throw new Error('高德代理请求体过大。')
    return req.body
  }
  if (typeof req?.body === 'string') {
    const body = Buffer.from(req.body)
    if (body.length > MAX_REQUEST_BYTES) throw new Error('高德代理请求体过大。')
    return body
  }
  const chunks = []
  let size = 0
  for await (const chunk of req || []) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('高德代理请求体过大。')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function proxyAmapService(req, res, options = {}) {
  const method = methodOf(req)
  if (!['GET', 'POST'].includes(method)) return jsonResponse(res, 405, { ok: false, error: '高德安全代理只接受 GET 或 POST。' })
  const securityJsCode = String(options.securityJsCode || '').trim()
  if (!securityJsCode) return jsonResponse(res, 503, { ok: false, error: '高德地图安全密钥尚未配置。' })
  const path = proxyPath(req)
  const inputUrl = parseUrl(req)
  const upstreamOrigin = String(options.upstreamOrigin || DEFAULT_UPSTREAM).replace(/\/$/, '')
  if (upstreamOrigin !== DEFAULT_UPSTREAM) throw new Error('高德代理上游域名不是固定官方地址。')
  const target = new URL(`${upstreamOrigin}${path}`)
  for (const [name, value] of inputUrl.searchParams) target.searchParams.append(name, value)
  target.searchParams.delete('jscode')
  target.searchParams.set('jscode', securityJsCode)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000)
  try {
    const headers = {}
    const contentType = req?.headers?.['content-type'] || req?.headers?.get?.('content-type')
    if (contentType) headers['content-type'] = String(contentType).split(';')[0]
    const response = await (options.fetchImpl || globalThis.fetch)(target, {
      method,
      headers,
      body: method === 'POST' ? await requestBody(req) : undefined,
      redirect: 'error',
      signal: controller.signal
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error('高德代理响应体过大。')
    res.writeHead?.(response.status, {
      'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end?.(buffer)
  } catch (error) {
    if (error?.name === 'AbortError') return jsonResponse(res, 504, { ok: false, error: '高德安全代理请求超时。' })
    return jsonResponse(res, 502, { ok: false, error: '高德安全代理请求失败。' })
  } finally {
    clearTimeout(timer)
  }
}

export { ALLOWED_PATHS, DEFAULT_UPSTREAM, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, proxyPath }
