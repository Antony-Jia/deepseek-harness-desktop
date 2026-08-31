export const GRAPH_SCHEMA_VERSION = 1
export const VIRTUAL_ROOT_ID = 'root'
export const NODE_KINDS = new Set(['task', 'merge'])
export const EXECUTORS = new Set(['dsh', 'codex'])
export const ACCESS_MODES = new Set(['read', 'write'])
export const FAILURE_POLICIES = new Set(['pause'])
export const GRAPH_SOURCES = new Set(['manual', 'auto', 'template'])

const AGENT_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    name: { type: 'string', maxLength: 200 },
    executor: { enum: [...EXECUTORS] },
    provider: { type: 'string', maxLength: 200 },
    subagentProvider: { type: 'string', maxLength: 200 },
    model: { type: 'string', maxLength: 300 },
    reasoningEffort: { type: 'string', maxLength: 40 },
    persona: { type: 'string', maxLength: 12000 },
    permissionMode: { enum: ['default', 'never', 'approve-for-me'] },
    maxOutputTokens: { type: 'integer', minimum: 256, maximum: 128000 },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: { type: 'array', items: { type: 'string' }, maxItems: 128 },
        skills: { type: 'array', items: { type: 'string' }, maxItems: 64 }
      }
    },
    enabled: { type: 'boolean' }
  }
}

const OUTPUT_CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fields: { type: 'array', items: { enum: ['text', 'artifactRefs'] }, maxItems: 2 },
    text: { type: 'boolean' },
    artifactRefs: { type: 'boolean' },
    requireText: { type: 'boolean' },
    allowEmptyText: { type: 'boolean' },
    allowArtifactRefs: { type: 'boolean' }
  }
}

const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'title'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    kind: { enum: [...NODE_KINDS] },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    instruction: { type: 'string', maxLength: 20000 },
    agentProfileId: { type: 'string', maxLength: 120 },
    access: { enum: [...ACCESS_MODES] },
    outputContract: OUTPUT_CONTRACT_SCHEMA,
    failurePolicy: { enum: [...FAILURE_POLICIES] },
    ui: {
      type: 'object',
      additionalProperties: false,
      properties: { x: { type: 'number' }, y: { type: 'number' } }
    }
  }
}

const EDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', minLength: 1, maxLength: 120 },
    to: { type: 'string', minLength: 1, maxLength: 120 }
  }
}

export const GRAPH_DRAFT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'nodes', 'edges'],
  properties: {
    graphId: { type: 'string' },
    goal: { type: 'string', minLength: 1, maxLength: 20000 },
    source: { enum: [...GRAPH_SOURCES] },
    manualLock: { type: 'boolean' },
    agentProfiles: { type: 'array', items: AGENT_PROFILE_SCHEMA, maxItems: 32 },
    nodes: { type: 'array', items: NODE_SCHEMA, maxItems: 128 },
    edges: { type: 'array', items: EDGE_SCHEMA, maxItems: 512 },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxParallel: { type: 'integer', minimum: 1, maximum: 32 },
        maxNodes: { type: 'integer', minimum: 1, maximum: 128 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 32 },
        maxRetries: { type: 'integer', minimum: 0, maximum: 8 },
        retryBackoffMs: { type: 'integer', minimum: 0, maximum: 60000 },
        maxTotalRuns: { type: 'integer', minimum: 1, maximum: 1000 }
      }
    }
  }
})

export const GRAPH_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['baseRevision', 'operations'],
  properties: {
    baseRevision: { type: 'integer', minimum: 1 },
    operations: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        required: ['op'],
        properties: {
          op: { enum: ['addNode', 'removeNode', 'updateNode', 'addEdge', 'removeEdge', 'updateLimits', 'setGoal'] },
          id: { type: 'string' },
          nodeId: { type: 'string' },
          node: NODE_SCHEMA,
          edge: EDGE_SCHEMA,
          value: {},
          changes: { type: 'object' },
          patch: { type: 'object' }
        }
      }
    }
  }
})

export { AGENT_PROFILE_SCHEMA, OUTPUT_CONTRACT_SCHEMA, NODE_SCHEMA, EDGE_SCHEMA }

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function text(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function int(value, fallback, min, max) {
  const candidate = Number(value)
  if (!Number.isFinite(candidate)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(candidate)))
}

export function defaultGraphLimits(input = {}) {
  return {
    maxParallel: int(input.maxParallel, 4, 1, 32),
    maxNodes: int(input.maxNodes, 32, 1, 128),
    maxDepth: int(input.maxDepth, 8, 1, 32),
    maxRetries: int(input.maxRetries, 2, 0, 8),
    retryBackoffMs: int(input.retryBackoffMs, 250, 0, 60000),
    maxTotalRuns: int(input.maxTotalRuns, 100, 1, 1000)
  }
}

function normalizeCapabilities(input = {}) {
  const tools = Array.isArray(input.tools) ? input.tools.map((item) => text(item)).filter(Boolean) : []
  const skills = Array.isArray(input.skills) ? input.skills.map((item) => text(item)).filter(Boolean) : []
  return {
    tools: [...new Set(tools)].sort(),
    skills: [...new Set(skills)].sort()
  }
}

export function normalizeProfile(input = {}, options = {}) {
  const requestedExecutor = text(input.executor)
  const executor = requestedExecutor || 'dsh'
  const defaultModel = options.defaultModel || {}
  const defaultProvider = text(defaultModel.provider)
  const defaultModelName = text(defaultModel.model)
  let provider = text(input.provider)
  let model = text(input.model)
  let modelSource = 'profile'
  if (!provider && options.resolveDefaults) {
    provider = executor === 'codex' ? 'codex' : defaultProvider
    modelSource = 'default'
  }
  if (!model && options.resolveDefaults) {
    model = defaultModelName
    modelSource = 'default'
  }
  const reasoningEffort = executor === 'codex' ? text(input.reasoningEffort) : ''
  return {
    id: text(input.id),
    name: text(input.name, text(input.id, '未命名 Agent')), 
    executor,
    provider,
    subagentProvider: text(input.subagentProvider),
    model,
    modelSource,
    reasoningEffort,
    persona: text(input.persona),
    permissionMode: text(input.permissionMode, 'default'),
    maxOutputTokens: int(input.maxOutputTokens ?? input.maxTokens, 4096, 256, 128000),
    capabilities: normalizeCapabilities(input.capabilities),
    enabled: input.enabled !== false
  }
}

export function normalizeOutputContract(input = {}) {
  const fields = Array.isArray(input.fields)
    ? input.fields.map((item) => text(item)).filter(Boolean)
    : [input.text === false ? '' : 'text', input.artifactRefs === false ? '' : 'artifactRefs'].filter(Boolean)
  const hasText = fields.includes('text')
  const hasArtifacts = fields.includes('artifactRefs')
  return {
    fields: [...new Set(fields)],
    requireText: hasText && input.requireText !== false,
    allowEmptyText: hasText && input.allowEmptyText === true,
    allowArtifactRefs: hasArtifacts && input.allowArtifactRefs !== false
  }
}

export function normalizeNode(input = {}) {
  const requestedKind = text(input.kind)
  const kind = requestedKind || 'task'
  const ui = input.ui && typeof input.ui === 'object'
    ? { x: Number(input.ui.x) || 0, y: Number(input.ui.y) || 0 }
    : undefined
  return {
    id: text(input.id),
    kind,
    title: text(input.title, kind === 'merge' ? '汇总节点' : '任务节点'),
    instruction: text(input.instruction),
    agentProfileId: text(input.agentProfileId),
    access: text(input.access, 'read'),
    outputContract: normalizeOutputContract(input.outputContract),
    failurePolicy: text(input.failurePolicy, 'pause'),
    ui
  }
}

export function normalizeEdge(input = {}) {
  return { from: text(input.from), to: text(input.to) }
}

export function normalizeGraph(input = {}, options = {}) {
  const now = Number(options.now || Date.now())
  const source = text(input.source, 'manual')
  const agentProfiles = Array.isArray(input.agentProfiles)
    ? input.agentProfiles.map((item) => normalizeProfile(item, options))
    : []
  const nodes = Array.isArray(input.nodes) ? input.nodes.map(normalizeNode) : []
  const edges = Array.isArray(input.edges) ? input.edges.map(normalizeEdge) : []
  const graph = {
    schemaVersion: input.schemaVersion === undefined ? GRAPH_SCHEMA_VERSION : Number(input.schemaVersion),
    graphId: text(input.graphId),
    revision: int(input.revision, 1, 1, 1000000000),
    sessionId: text(input.sessionId),
    goal: text(input.goal),
    source,
    manualLock: input.manualLock === true || source === 'manual',
    agentProfiles,
    nodes,
    edges,
    limits: defaultGraphLimits(input.limits),
    capabilitySnapshot: clone(input.capabilitySnapshot || null),
    planner: clone(input.planner || null),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now
  }
  if (options.graphId && !graph.graphId) graph.graphId = text(options.graphId)
  return graph
}

export function createEmptyGraph(options = {}) {
  return normalizeGraph({
    graphId: options.graphId,
    sessionId: options.sessionId,
    goal: options.goal,
    source: options.source || 'manual',
    manualLock: options.manualLock !== false,
    agentProfiles: options.agentProfiles || [],
    nodes: [],
    edges: [],
    limits: options.limits,
    capabilitySnapshot: options.capabilitySnapshot,
    planner: options.planner
  }, options)
}

export function resolveProfileDefaults(graph, defaultModel) {
  return normalizeGraph(graph, {
    defaultModel,
    resolveDefaults: true,
    now: graph.updatedAt || Date.now()
  })
}

function ensurePatchShape(patch) {
  if (!patch || typeof patch !== 'object' || !Number.isInteger(Number(patch.baseRevision))) {
    throw new Error('Graph patch 必须包含整数 baseRevision。')
  }
  if (!Array.isArray(patch.operations)) throw new Error('Graph patch.operations 必须是数组。')
  if (patch.operations.length > 128) throw new Error('单次 Graph patch 最多包含 128 个操作。')
}

export function applyGraphPatch(baseInput, patch, options = {}) {
  ensurePatchShape(patch)
  const base = normalizeGraph(baseInput)
  if (Number(patch.baseRevision) !== Number(base.revision)) {
    const error = new Error(`Graph revision 冲突：期望 ${base.revision}，收到 ${patch.baseRevision}。`)
    error.code = 'GRAPH_REVISION_CONFLICT'
    throw error
  }
  const graph = clone(base)
  const allowedNodeFields = new Set(['kind', 'title', 'instruction', 'agentProfileId', 'access', 'outputContract', 'failurePolicy', 'ui'])
  for (const operation of patch.operations) {
    if (!operation || typeof operation !== 'object') throw new Error('Graph patch 包含无效操作。')
    const op = text(operation.op)
    if (op === 'addNode') {
      const node = normalizeNode(operation.node || operation.value || {})
      if (!node.id) node.id = text(options.idFactory?.('node') || `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
      if (graph.nodes.some((item) => item.id === node.id) || node.id === VIRTUAL_ROOT_ID) throw new Error(`节点 ID 已存在：${node.id}`)
      graph.nodes.push(node)
      continue
    }
    if (op === 'removeNode') {
      const id = text(operation.id || operation.nodeId)
      if (!id || id === VIRTUAL_ROOT_ID) throw new Error('不能删除虚拟 Root。')
      graph.nodes = graph.nodes.filter((item) => item.id !== id)
      graph.edges = graph.edges.filter((edge) => edge.from !== id && edge.to !== id)
      continue
    }
    if (op === 'updateNode') {
      const id = text(operation.id || operation.nodeId)
      const node = graph.nodes.find((item) => item.id === id)
      if (!node) throw new Error(`节点不存在：${id}`)
      const value = operation.value || operation.patch || operation.changes
      if (!value || typeof value !== 'object') throw new Error('updateNode 必须包含 value。')
      for (const key of Object.keys(value)) {
        if (!allowedNodeFields.has(key)) throw new Error(`不允许更新节点字段：${key}`)
      }
      Object.assign(node, normalizeNode({ ...node, ...value, id }))
      continue
    }
    if (op === 'addEdge') {
      const edge = normalizeEdge(operation.edge || operation.value || operation)
      if (!edge.from || !edge.to) throw new Error('addEdge 必须包含 from/to。')
      if (!graph.edges.some((item) => item.from === edge.from && item.to === edge.to)) graph.edges.push(edge)
      continue
    }
    if (op === 'removeEdge') {
      const edge = normalizeEdge(operation.edge || operation.value || operation)
      graph.edges = graph.edges.filter((item) => item.from !== edge.from || item.to !== edge.to)
      continue
    }
    if (op === 'updateLimits') {
      graph.limits = defaultGraphLimits({ ...graph.limits, ...(operation.value || {}) })
      continue
    }
    if (op === 'setGoal') {
      graph.goal = text(operation.value)
      continue
    }
    throw new Error(`不允许的 Graph patch 操作：${op || '(empty)'}`)
  }
  graph.revision += 1
  graph.source = 'manual'
  graph.manualLock = true
  graph.updatedAt = Number(options.now || Date.now())
  return normalizeGraph(graph, { now: graph.updatedAt })
}

export function graphSummary(graph, validation = {}) {
  return {
    graphId: graph.graphId,
    revision: graph.revision,
    goal: graph.goal,
    source: graph.source,
    manualLock: graph.manualLock,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    depth: validation.depth || 0,
    maxParallel: validation.parallelism?.maxRead || 0,
    writeNodes: validation.parallelism?.writeNodes || 0,
    valid: validation.valid !== false
  }
}

export function diffGraph(before, after) {
  const left = normalizeGraph(before)
  const right = normalizeGraph(after)
  const changed = []
  if (left.goal !== right.goal) changed.push('goal')
  if (JSON.stringify(left.nodes) !== JSON.stringify(right.nodes)) changed.push('nodes')
  if (JSON.stringify(left.edges) !== JSON.stringify(right.edges)) changed.push('edges')
  if (JSON.stringify(left.agentProfiles) !== JSON.stringify(right.agentProfiles)) changed.push('agentProfiles')
  if (JSON.stringify(left.limits) !== JSON.stringify(right.limits)) changed.push('limits')
  return { changed, fromRevision: left.revision, toRevision: right.revision }
}
