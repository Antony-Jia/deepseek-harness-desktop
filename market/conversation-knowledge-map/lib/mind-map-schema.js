export const MIND_MAP_SCHEMA_VERSION = 1
export const MAX_MIND_MAP_NODES = 80

export class MindMapValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MindMapValidationError'
  }
}

function asText(value, label, max = 20000) {
  const text = String(value ?? '').trim()
  if (!text) throw new MindMapValidationError(`${label} 不能为空。`)
  if (text.length > max) throw new MindMapValidationError(`${label} 超出长度限制。`)
  return text
}

function normalizeRefs(refs, selectedSessionIds) {
  if (!Array.isArray(refs)) return []
  const selected = new Set(selectedSessionIds || [])
  return refs.map((ref) => {
    const sessionId = asText(ref?.sessionId, '来源 Session ID', 256)
    if (selected.size && !selected.has(sessionId)) throw new MindMapValidationError(`来源 Session 不在本次选择中：${sessionId}`)
    const eventSeqs = Array.isArray(ref?.eventSeqs)
      ? [...new Set(ref.eventSeqs.filter((seq) => Number.isInteger(seq) && seq >= 0))]
      : []
    if (!eventSeqs.length) throw new MindMapValidationError(`来源 ${sessionId} 缺少事件序号。`)
    return { sessionId, eventSeqs }
  }).slice(0, 12)
}

function detectCycle(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new MindMapValidationError('思维导图层级存在循环。')
    visiting.add(id)
    const parentId = byId.get(id)?.parentId
    if (parentId) visit(parentId)
    visiting.delete(id)
    visited.add(id)
  }
  for (const node of nodes) visit(node.id)
}

export function validateMindMap(input, { selectedSessionIds = [], strict = false } = {}) {
  if (!input || typeof input !== 'object') throw new MindMapValidationError('思维导图结果必须是对象。')
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : []
  if (!rawNodes.length) throw new MindMapValidationError('思维导图至少需要一个节点。')
  if (rawNodes.length > MAX_MIND_MAP_NODES) throw new MindMapValidationError(`思维导图节点不能超过 ${MAX_MIND_MAP_NODES} 个。`)
  const rootId = asText(input.rootId || rawNodes[0]?.id, '思维导图 rootId', 256)
  const ids = new Set()
  const nodes = rawNodes.map((raw, index) => {
    const id = asText(raw?.id || `mind-node-${index + 1}`, '思维导图节点 ID', 256)
    if (ids.has(id)) throw new MindMapValidationError(`思维导图节点 ID 重复：${id}`)
    ids.add(id)
    const parentId = raw?.parentId === null || raw?.parentId === undefined || raw?.parentId === '' ? null : asText(raw.parentId, 'parentId', 256)
    const title = asText(raw?.title ?? raw?.label, `节点 ${id} 标题`, 120)
    const narrative = asText(raw?.narrative ?? raw?.summary, `节点 ${id} 阶段性说明`, 2000)
    if (narrative.length < 20) throw new MindMapValidationError(`节点 ${id} 的阶段性说明过短，不能只使用关键词。`)
    const sourceRefs = normalizeRefs(raw?.sourceRefs, selectedSessionIds)
    if (strict && !sourceRefs.length) throw new MindMapValidationError(`严格约束要求节点 ${id} 带来源引用。`)
    const primarySourceSessionId = raw?.primarySourceSessionId ? asText(raw.primarySourceSessionId, '主要来源 Session ID', 256) : (sourceRefs[0]?.sessionId || '')
    if (primarySourceSessionId && selectedSessionIds.length && !selectedSessionIds.includes(primarySourceSessionId)) {
      throw new MindMapValidationError(`节点 ${id} 的主要来源不在本次选择中。`)
    }
    const openQuestions = Array.isArray(raw?.openQuestions)
      ? raw.openQuestions.map((question) => String(question || '').trim()).filter(Boolean).slice(0, 3)
      : []
    return {
      id,
      parentId,
      type: asText(raw?.type || 'stage', `节点 ${id} 类型`, 40),
      title,
      narrative,
      primarySourceSessionId,
      sourceRefs,
      openQuestions
    }
  })
  if (!ids.has(rootId)) throw new MindMapValidationError(`rootId 不存在：${rootId}`)
  const rootNodes = nodes.filter((node) => node.parentId === null)
  if (rootNodes.length !== 1 || rootNodes[0].id !== rootId) throw new MindMapValidationError('思维导图必须只有一个根节点。')
  for (const node of nodes) if (node.parentId && !ids.has(node.parentId)) throw new MindMapValidationError(`节点 ${node.id} 的父节点不存在。`)
  detectCycle(nodes)
  return {
    schemaVersion: MIND_MAP_SCHEMA_VERSION,
    rootId,
    nodes,
    edges: nodes.filter((node) => node.parentId).map((node) => ({ from: node.parentId, to: node.id }))
  }
}
