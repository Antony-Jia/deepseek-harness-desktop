import { TOOL_NAMES, contentText, snapshotPresentationMeta, normalizeSnapshotArgs, normalizeHistoryArgs } from './protocol.js'

const snapshotRangeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gte: { type: 'number' },
    lte: { type: 'number' }
  }
}

const snapshotParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['market'],
  properties: {
    market: { type: 'string', enum: ['a-share', 'hk', 'us'] },
    query: { type: 'string' },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        price: snapshotRangeSchema,
        changePct: snapshotRangeSchema,
        volume: snapshotRangeSchema,
        amount: snapshotRangeSchema,
        turnoverRate: snapshotRangeSchema
      }
    },
    sort: {
      type: 'object',
      additionalProperties: false,
      properties: {
        field: { type: 'string', enum: ['price', 'changePct', 'volume', 'amount', 'turnoverRate'] },
        direction: { type: 'string', enum: ['asc', 'desc'] }
      }
    },
    limit: { type: 'integer' }
  }
}

const historyParameters = (analysis = false) => ({
  type: 'object',
  additionalProperties: false,
  required: ['market', 'symbol'],
  properties: {
    market: { type: 'string', enum: ['a-share', 'hk', 'us'] },
    symbol: { type: 'string' },
    period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
    adjust: { type: 'string', enum: ['none', 'qfq', 'hfq'] },
    maxBars: { type: 'integer' },
    ...(analysis ? { indicators: { type: 'array', items: { type: 'string', enum: ['sma', 'macd', 'rsi', 'boll', 'volume-ma', 'atr'] } } } : {})
  }
})

const outputSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    schemaVersion: { type: 'integer' },
    kind: { type: 'string' },
    market: { type: 'string' },
    symbol: { type: 'string' },
    rows: { type: 'array' },
    bars: { type: 'array' },
    series: { type: 'object' },
    analysisSummary: { type: 'object' },
    presentationMeta: { type: 'object' }
  }
}

function render(_args, value) {
  return [{ type: 'text', text: contentText(value) }]
}

function presentCall(title, args) {
  return { card: 'generic', kind: 'akshare', title, rawInput: JSON.stringify(args) }
}

function presentResult(title, _args, result) {
  if (result?.isError) return undefined
  return { card: 'generic', kind: 'akshare', title }
}

export function createToolDefinitions(execute) {
  const common = (name, description, parameters, meta, title) => ({
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render,
      presentationMeta: meta
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: (args, exec) => execute(name, args, exec),
    presentCall: (args) => presentCall(title, args),
    presentResult: (args, result) => presentResult(title, args, result)
  })
  return [
    common(TOOL_NAMES.snapshot, '查询 A 股或港股实时行情快照、单股和白名单数值筛选结果。', snapshotParameters, snapshotPresentationMeta, '行情快照'),
    common(TOOL_NAMES.history, '获取 A 股或港股日线、周线或月线历史 OHLCV 数据。', historyParameters(false), snapshotPresentationMeta, '历史行情'),
    common(TOOL_NAMES.analysis, '基于历史 OHLCV 计算有限技术指标并生成描述性分析摘要。', historyParameters(true), snapshotPresentationMeta, 'K 线与技术分析')
  ]
}

export { normalizeSnapshotArgs, normalizeHistoryArgs }
