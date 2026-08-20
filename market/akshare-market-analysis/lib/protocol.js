import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const PLUGIN_ID = '@p-dsh-market/akshare-market-analysis'
export const TOOL_NAMES = Object.freeze({
  snapshot: 'akshare_market_snapshot',
  history: 'akshare_stock_history',
  analysis: 'akshare_technical_analysis'
})
export const MARKETS = new Set(['a-share', 'hk', 'us'])
export const PERIODS = new Set(['daily', 'weekly', 'monthly'])
export const ADJUSTMENTS = new Set(['none', 'qfq', 'hfq'])
export const SNAPSHOT_FIELDS = new Set(['price', 'changePct', 'volume', 'amount', 'turnoverRate'])
export const INDICATORS = new Set(['sma', 'macd', 'rsi', 'boll', 'volume-ma', 'atr'])
export const MAX_SNAPSHOT_LIMIT = 100
export const MAX_HISTORY_BARS = 600
export const MAX_PRESENTATION_BARS = 240

export class ProtocolError extends Error {
  constructor(message, code = 'INVALID_ARGUMENT') {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertKeys(value, allowed, label) {
  if (!isObject(value)) throw new ProtocolError(`${label} 必须是对象。`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ProtocolError(`${label} 包含未知字段: ${key}`)
  }
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProtocolError(`${label} 必须是有限数字。`)
  return value
}

export function normalizeSymbol(market, value) {
  if (!MARKETS.has(market)) throw new ProtocolError('market 必须是 a-share、hk 或 us。')
  if (market === 'us') {
    const raw = typeof value === 'string' ? value.trim().toUpperCase() : ''
    if (!/^[A-Z0-9._-]{1,15}$/.test(raw) || !/[A-Z0-9]/.test(raw)) throw new ProtocolError('美股 symbol 必须是 1 到 15 位 ticker 字符串。')
    return raw
  }
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d+$/.test(raw)) throw new ProtocolError('symbol 只能包含数字。')
  const width = market === 'a-share' ? 6 : 5
  if (raw.length > width) throw new ProtocolError(`${market} symbol 最多 ${width} 位数字。`)
  return raw.padStart(width, '0')
}

function normalizeDate(value, label) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{8}$/.test(raw) && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ProtocolError(`${label} 必须是 YYYYMMDD 或 YYYY-MM-DD。`)
  const compact = raw.replaceAll('-', '')
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new ProtocolError(`${label} 不是有效日期。`)
  return compact
}

function defaultDates() {
  const end = new Date()
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000)
  const format = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  return { start: format(start), end: format(end) }
}

export function normalizeSnapshotArgs(input = {}) {
  assertKeys(input, new Set(['market', 'query', 'filters', 'sort', 'limit']), 'snapshot')
  const market = input.market
  if (!MARKETS.has(market)) throw new ProtocolError('market 必须是 a-share、hk 或 us。')
  const query = input.query === undefined ? '' : input.query
  if (typeof query !== 'string' || query.length > 100) throw new ProtocolError('query 必须是有限长度字符串。')
  if (market === 'us' && !query.trim()) throw new ProtocolError('美股快照需要在 query 中传入 ticker，例如 AAPL。')
  const filtersInput = input.filters === undefined || input.filters === null ? {} : input.filters
  assertKeys(filtersInput, SNAPSHOT_FIELDS, 'filters')
  const filters = {}
  for (const [field, range] of Object.entries(filtersInput)) {
    assertKeys(range, new Set(['gte', 'lte']), `filters.${field}`)
    const normalized = {}
    for (const operator of ['gte', 'lte']) {
      if (range[operator] !== undefined) normalized[operator] = finiteNumber(range[operator], `filters.${field}.${operator}`)
    }
    if (normalized.gte !== undefined && normalized.lte !== undefined && normalized.gte > normalized.lte) throw new ProtocolError(`filters.${field}.gte 不能大于 lte。`)
    filters[field] = normalized
  }
  let sort = null
  if (input.sort !== undefined && input.sort !== null) {
    assertKeys(input.sort, new Set(['field', 'direction']), 'sort')
    if (!SNAPSHOT_FIELDS.has(input.sort.field) || !['asc', 'desc'].includes(input.sort.direction)) throw new ProtocolError('sort.field 或 sort.direction 不在白名单内。')
    sort = { field: input.sort.field, direction: input.sort.direction }
  }
  const limit = input.limit === undefined ? 20 : input.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_LIMIT) throw new ProtocolError(`limit 必须是 1 到 ${MAX_SNAPSHOT_LIMIT} 的整数。`)
  return { market, query: query.trim(), filters, sort, limit }
}

export function normalizeHistoryArgs(input = {}, { analysis = false } = {}) {
  const allowed = new Set(['market', 'symbol', 'period', 'startDate', 'endDate', 'adjust', 'maxBars'])
  if (analysis) allowed.add('indicators')
  assertKeys(input, allowed, 'history')
  const market = input.market
  if (!MARKETS.has(market)) throw new ProtocolError('market 必须是 a-share、hk 或 us。')
  const symbol = normalizeSymbol(market, input.symbol)
  const dates = defaultDates()
  const startDate = normalizeDate(input.startDate === undefined ? dates.start : input.startDate, 'startDate')
  const endDate = normalizeDate(input.endDate === undefined ? dates.end : input.endDate, 'endDate')
  if (startDate > endDate) throw new ProtocolError('startDate 不能晚于 endDate。')
  const period = input.period === undefined ? 'daily' : input.period
  if (!PERIODS.has(period)) throw new ProtocolError('period 必须是 daily、weekly 或 monthly。')
  const adjust = input.adjust === undefined ? 'none' : input.adjust
  if (!ADJUSTMENTS.has(adjust)) throw new ProtocolError('adjust 必须是 none、qfq 或 hfq。')
  if (market === 'us' && adjust === 'hfq') throw new ProtocolError('当前美股新浪接口不提供 hfq，改用 none 或 qfq。')
  const maxBars = input.maxBars === undefined ? 240 : input.maxBars
  if (!Number.isInteger(maxBars) || maxBars < 1 || maxBars > MAX_HISTORY_BARS) throw new ProtocolError(`maxBars 必须是 1 到 ${MAX_HISTORY_BARS} 的整数。`)
  const result = { market, symbol, period, startDate, endDate, adjust, maxBars }
  if (analysis) {
    const indicators = input.indicators === undefined ? [...INDICATORS].sort() : input.indicators
    if (!Array.isArray(indicators) || indicators.length === 0 || indicators.some((item) => typeof item !== 'string' || !INDICATORS.has(item))) throw new ProtocolError('indicators 必须是固定白名单字符串数组。')
    result.indicators = [...new Set(indicators)]
  }
  return result
}

function jsonReplacer(_key, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value, jsonReplacer)
}

export function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function compactSnapshot(value) {
  if (!isObject(value) || !Array.isArray(value.bars)) return null
  const bars = value.bars.slice(-MAX_PRESENTATION_BARS).map((bar) => [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null, bar.amount ?? null])
  const source = {
    schemaVersion: SCHEMA_VERSION,
    kind: value.kind,
    market: value.market,
    symbol: value.symbol,
    name: value.name,
    period: value.period,
    adjust: value.adjust,
    currency: value.currency,
    startDate: value.startDate,
    endDate: value.endDate,
    fetchedAt: value.fetchedAt,
    source: value.source,
    akshareVersion: value.akshareVersion,
    bars,
    quality: value.quality,
    truncated: Boolean(value.quality?.truncated)
  }
  if (value.kind === 'analysis') {
    const series = {}
    for (const [key, entries] of Object.entries(value.series || {})) series[key] = Array.isArray(entries) ? entries.slice(-bars.length) : []
    source.series = series
    source.indicators = value.indicators || []
    source.metrics = value.metrics || {}
    source.analysisSummary = value.analysisSummary || { trend: '', momentum: '', volatility: '', volumePrice: '', warnings: [] }
  }
  return { ...source, analysisId: `sha256:${sha256(source)}` }
}

export function snapshotPresentationMeta(_args, value) {
  if (!isObject(value)) return null
  if (value.kind === 'snapshot') return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'snapshot',
    market: value.market,
    query: value.query,
    filters: value.filters,
    sort: value.sort,
    rows: Array.isArray(value.rows) ? value.rows.slice(0, MAX_SNAPSHOT_LIMIT) : [],
    totalMatched: value.totalMatched,
    truncated: Boolean(value.truncated),
    fetchedAt: value.fetchedAt,
    source: value.source,
    delayMinutes: value.delayMinutes ?? null,
    quality: value.quality
  }
  return compactSnapshot(value)
}

export function contentText(value) {
  if (!isObject(value)) return '行情工具返回了空结果。'
  if (value.kind === 'snapshot') {
    const lines = [`市场：${value.market}；数据时间：${value.fetchedAt}；来源：${value.source}；匹配 ${value.totalMatched} 条${value.truncated ? '，结果已截断' : ''}。`]
    if (value.delayMinutes) {
      const marketLabel = value.market === 'hk' ? '港股' : value.market === 'us' ? '美股' : '行情'
      lines.push(`${marketLabel}数据源可能延迟约 ${value.delayMinutes} 分钟，快照可能代表最近交易日数据。`)
    }
    for (const row of (value.rows || []).slice(0, 20)) lines.push(`${row.symbol} ${row.name}：价格 ${row.price ?? '—'}，涨跌幅 ${row.changePct ?? '—'}%，成交额 ${row.amount ?? '—'}。`)
    return lines.join('\n')
  }
  const summary = value.analysisSummary
  const lines = [`${value.symbol} ${value.name || ''}：${value.period}，${value.adjust}，数据时间 ${value.fetchedAt}，来源 ${value.source}。`, `区间 ${value.startDate} 至 ${value.endDate}，共 ${(value.bars || []).length} 根${value.quality?.truncated ? '（已截断）' : ''}。`]
  if (summary) lines.push(`趋势：${summary.trend}`, `动量：${summary.momentum}`, `波动：${summary.volatility}`, `量价：${summary.volumePrice}`, ...(summary.warnings?.length ? [`数据质量：${summary.warnings.join('；')}`] : []))
  return lines.join('\n')
}
