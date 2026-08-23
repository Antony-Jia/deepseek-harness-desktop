export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 1
export const MAX_ENTITIES = 150
export const MAX_RELATIONS = 300

export class KnowledgeGraphValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KnowledgeGraphValidationError'
  }
}

function asText(value, label, max = 4000) {
  const text = String(value ?? '').trim()
  if (!text) throw new KnowledgeGraphValidationError(`${label} 不能为空。`)
  if (text.length > max) throw new KnowledgeGraphValidationError(`${label} 超出长度限制。`)
  return text
}

function refsOf(raw, selectedSessionIds, label) {
  const refs = raw?.sourceRefs ?? raw?.evidence ?? []
  if (!Array.isArray(refs)) return []
  const selected = new Set(selectedSessionIds || [])
  return refs.map((ref) => {
    const sessionId = asText(ref?.sessionId, `${label}来源 Session ID`, 256)
    if (selected.size && !selected.has(sessionId)) throw new KnowledgeGraphValidationError(`来源 Session 不在本次选择中：${sessionId}`)
    const eventSeqs = Array.isArray(ref?.eventSeqs)
      ? [...new Set(ref.eventSeqs.filter((seq) => Number.isInteger(seq) && seq >= 0))]
      : []
    if (!eventSeqs.length) throw new KnowledgeGraphValidationError(`${label}来源缺少事件序号。`)
    return { sessionId, eventSeqs }
  }).slice(0, 12)
}

function confidenceOf(value) {
  const confidence = String(value || 'confirmed').trim()
  if (!['confirmed', 'inferred', 'conflicted'].includes(confidence)) throw new KnowledgeGraphValidationError(`不支持的置信度：${confidence}`)
  return confidence
}

export function validateKnowledgeGraph(input, { selectedSessionIds = [], strict = false } = {}) {
  if (!input || typeof input !== 'object') throw new KnowledgeGraphValidationError('知识图谱结果必须是对象。')
  const rawEntities = Array.isArray(input.entities) ? input.entities : []
  const rawRelations = Array.isArray(input.relations) ? input.relations : []
  if (!rawEntities.length) throw new KnowledgeGraphValidationError('知识图谱至少需要一个实体。')
  if (rawEntities.length > MAX_ENTITIES) throw new KnowledgeGraphValidationError(`实体不能超过 ${MAX_ENTITIES} 个。`)
  if (rawRelations.length > MAX_RELATIONS) throw new KnowledgeGraphValidationError(`关系不能超过 ${MAX_RELATIONS} 条。`)
  const ids = new Set()
  const entities = rawEntities.map((raw, index) => {
    const id = asText(raw?.id || `entity-${index + 1}`, '实体 ID', 256)
    if (ids.has(id)) throw new KnowledgeGraphValidationError(`实体 ID 重复：${id}`)
    ids.add(id)
    const sourceRefs = refsOf(raw, selectedSessionIds, `实体 ${id}`)
    if (strict && !sourceRefs.length) throw new KnowledgeGraphValidationError(`严格约束要求实体 ${id} 带来源引用。`)
    return {
      id,
      type: asText(raw?.type || 'concept', `实体 ${id} 类型`, 80),
      name: asText(raw?.name || raw?.label, `实体 ${id} 名称`, 240),
      summary: asText(raw?.summary || raw?.description, `实体 ${id} 摘要`, 1600),
      confidence: confidenceOf(raw?.confidence),
      sourceRefs
    }
  })
  const relations = rawRelations.map((raw, index) => {
    const from = asText(raw?.from, `关系 ${index + 1} from`, 256)
    const to = asText(raw?.to, `关系 ${index + 1} to`, 256)
    if (!ids.has(from) || !ids.has(to)) throw new KnowledgeGraphValidationError(`关系 ${index + 1} 引用了不存在的实体。`)
    if (from === to) throw new KnowledgeGraphValidationError(`关系 ${index + 1} 不能连接实体自身。`)
    const evidence = refsOf(raw, selectedSessionIds, `关系 ${index + 1}`)
    if (strict && !evidence.length) throw new KnowledgeGraphValidationError(`严格约束要求关系 ${index + 1} 带证据。`)
    return {
      id: String(raw?.id || `relation-${index + 1}`),
      from,
      to,
      type: asText(raw?.type || 'related_to', `关系 ${index + 1} 类型`, 80),
      confidence: confidenceOf(raw?.confidence),
      evidence
    }
  })
  const relationIds = new Set()
  for (const relation of relations) {
    if (relationIds.has(relation.id)) throw new KnowledgeGraphValidationError(`关系 ID 重复：${relation.id}`)
    relationIds.add(relation.id)
  }
  return {
    schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
    entities,
    relations
  }
}
