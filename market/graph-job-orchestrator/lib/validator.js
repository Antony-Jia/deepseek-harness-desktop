import {
  ACCESS_MODES,
  EXECUTORS,
  FAILURE_POLICIES,
  GRAPH_SCHEMA_VERSION,
  GRAPH_SOURCES,
  NODE_KINDS,
  VIRTUAL_ROOT_ID,
  normalizeGraph
} from './graph-schema.js'

export class GraphValidationError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'GraphValidationError'
    this.code = 'GRAPH_VALIDATION_FAILED'
    this.errors = errors
  }
}

function push(errors, path, message, code = 'INVALID') {
  errors.push({ path, message, code })
}

function maxLength(errors, path, value, limit) {
  if (String(value || '').length > limit) push(errors, path, `长度不能超过 ${limit}。`, 'SCHEMA')
}

function capabilityTools(capabilities) {
  if (!capabilities) return null
  if (Array.isArray(capabilities.tools)) return new Set(capabilities.tools.map(String))
  if (Array.isArray(capabilities.tools?.names)) return new Set(capabilities.tools.names.map(String))
  return null
}

function capabilitySkills(capabilities) {
  if (!capabilities) return null
  const values = Array.isArray(capabilities.skills) ? capabilities.skills : []
  return new Map(values.map((skill) => {
    const item = typeof skill === 'string' ? { name: skill } : skill
    return [String(item.name || item.id || ''), item]
  }).filter(([name]) => name))
}

function reasoningEfforts(capabilities) {
  if (!capabilities) return null
  const values = capabilities.reasoningEfforts || capabilities.reasoningEffort || capabilities.codex?.reasoningEfforts || capabilities.executors?.codex?.reasoningEfforts
  return Array.isArray(values) ? new Set(values.map(String)) : null
}

function availableModels(capabilities, profile) {
  if (!capabilities) return null
  const providerModels = capabilities.subagentProviders?.find?.((item) => item?.name === profile.provider)?.models
  const values = profile.executor === 'codex' && Array.isArray(providerModels) && providerModels.length
    ? providerModels.map((model) => ({ provider: profile.provider, model: String(model) }))
    : Array.isArray(capabilities.models) ? capabilities.models : []
  if (!values.length) return null
  return new Set(values.map((item) => {
    if (typeof item === 'string') return `${profile.provider}\u0000${item}`
    return `${String(item?.provider || profile.provider)}\u0000${String(item?.model || item?.id || item?.name || '')}`
  }))
}

export function validateGraph(input, options = {}) {
  const graph = normalizeGraph(input)
  const errors = []
  const warnings = []
  const allowEmpty = options.allowEmpty === true
  const capabilities = options.capabilities || graph.capabilitySnapshot || null
  const profileMap = new Map()
  const nodeMap = new Map()

  if (graph.schemaVersion !== GRAPH_SCHEMA_VERSION) push(errors, 'schemaVersion', `只支持 schemaVersion=${GRAPH_SCHEMA_VERSION}。`, 'SCHEMA_VERSION')
  if (!GRAPH_SOURCES.has(graph.source)) push(errors, 'source', `不支持的 Graph source：${graph.source}。`, 'SOURCE')
  maxLength(errors, 'goal', graph.goal, 20000)
  if (graph.agentProfiles.length > 32) push(errors, 'agentProfiles', 'Agent Profile 最多 32 个。', 'SCHEMA')
  if (graph.nodes.length > 128) push(errors, 'nodes', '节点最多 128 个。', 'SCHEMA')
  if (graph.edges.length > 512) push(errors, 'edges', '边最多 512 条。', 'SCHEMA')
  if (!graph.goal && !allowEmpty) push(errors, 'goal', 'Graph goal 不能为空。', 'REQUIRED')
  if (!graph.graphId && !allowEmpty) push(errors, 'graphId', 'Graph graphId 不能为空。', 'REQUIRED')
  if (graph.nodes.length === 0 && !allowEmpty) push(errors, 'nodes', '可运行 Graph 至少需要一个节点。', 'EMPTY_GRAPH')
  if (graph.nodes.length > graph.limits.maxNodes) push(errors, 'nodes', `节点数量超过 maxNodes=${graph.limits.maxNodes}。`, 'LIMIT')

  for (const [index, profile] of graph.agentProfiles.entries()) {
    maxLength(errors, `agentProfiles[${index}].id`, profile.id, 120)
    maxLength(errors, `agentProfiles[${index}].name`, profile.name, 200)
    maxLength(errors, `agentProfiles[${index}].provider`, profile.provider, 200)
    maxLength(errors, `agentProfiles[${index}].subagentProvider`, profile.subagentProvider, 200)
    maxLength(errors, `agentProfiles[${index}].model`, profile.model, 300)
    maxLength(errors, `agentProfiles[${index}].reasoningEffort`, profile.reasoningEffort, 40)
    maxLength(errors, `agentProfiles[${index}].persona`, profile.persona, 12000)
    if (!profile.id) push(errors, `agentProfiles[${index}].id`, 'Agent Profile id 不能为空。', 'REQUIRED')
    if (profile.id === VIRTUAL_ROOT_ID) push(errors, `agentProfiles[${index}].id`, 'Agent Profile 不能使用 root。', 'RESERVED_ID')
    if (profileMap.has(profile.id)) push(errors, `agentProfiles[${index}].id`, `Agent Profile id 重复：${profile.id}。`, 'DUPLICATE_ID')
    profileMap.set(profile.id, profile)
    if (!EXECUTORS.has(profile.executor)) push(errors, `agentProfiles[${index}].executor`, `不支持的 executor：${profile.executor}。`, 'EXECUTOR')
    if (!profile.provider) push(errors, `agentProfiles[${index}].provider`, 'provider 必须在 revision 创建时解析完成。', 'MODEL_UNRESOLVED')
    if (!profile.model) push(errors, `agentProfiles[${index}].model`, 'model 必须在 revision 创建时解析完成。', 'MODEL_UNRESOLVED')
    if (options.enforceExecutorAvailability && capabilities?.executors?.[profile.executor]) {
      const executor = capabilities.executors[profile.executor]
      if (executor.available === false) push(errors, `agentProfiles[${index}].executor`, `${profile.executor} executor 当前不可用。`, 'CAPABILITY_MISMATCH')
      if (profile.executor === 'codex' && Array.isArray(executor.providers) && executor.providers.length && !executor.providers.includes(profile.provider)) {
        push(errors, `agentProfiles[${index}].provider`, `Codex provider 当前不可用：${profile.provider}。`, 'CAPABILITY_MISMATCH')
      }
    }
    const modelSet = availableModels(capabilities, profile)
    if (modelSet && !modelSet.has(`${profile.provider}\u0000${profile.model}`)) {
      push(errors, `agentProfiles[${index}].model`, `当前 capability 不提供 ${profile.provider}/${profile.model}。`, 'CAPABILITY_MISMATCH')
    }
    if (!['default', 'never', 'approve-for-me'].includes(profile.permissionMode)) {
      push(errors, `agentProfiles[${index}].permissionMode`, `不支持的 permissionMode：${profile.permissionMode}。`, 'PERMISSION_MODE')
    }
    for (const tool of profile.capabilities.tools) {
      if (/^graph[_-]?job|^graphjob|graph-job-orchestrator/i.test(tool) || tool === '/graphjob') {
        push(errors, `agentProfiles[${index}].capabilities.tools`, `禁止将 Graph Job 自身工具授予子 Agent：${tool}。`, 'RECURSION_GUARD')
      }
    }
    if (profile.executor !== 'codex' && profile.reasoningEffort) {
      push(errors, `agentProfiles[${index}].reasoningEffort`, '只有 Codex executor 可以设置 reasoningEffort。', 'REASONING_UNSUPPORTED')
    }
    const toolSet = capabilityTools(capabilities)
    if (toolSet) {
      for (const tool of profile.capabilities.tools) {
        if (!toolSet.has(tool)) push(errors, `agentProfiles[${index}].capabilities.tools`, `工具不在当前 capability snapshot：${tool}。`, 'CAPABILITY_MISMATCH')
      }
    }
    if (profile.executor === 'codex' && profile.reasoningEffort) {
      const effortSet = reasoningEfforts(capabilities)
      if (effortSet && !effortSet.has(profile.reasoningEffort)) {
        push(errors, `agentProfiles[${index}].reasoningEffort`, `当前 Codex capability 不支持 reasoningEffort=${profile.reasoningEffort}。`, 'CAPABILITY_MISMATCH')
      }
    }
    const skillMap = capabilitySkills(capabilities)
    if (skillMap) {
      for (const skillName of profile.capabilities.skills) {
        const skill = skillMap.get(skillName)
        if (!skill) {
          push(errors, `agentProfiles[${index}].capabilities.skills`, `Skill 不在当前 allowlist：${skillName}。`, 'CAPABILITY_MISMATCH')
        } else if (skill.origin === 'plugin' || skill.metadata?.plugin || skill.provider === 'desktop-skills') {
          push(errors, `agentProfiles[${index}].capabilities.skills`, `禁止将插件 Skill 授予子 Agent：${skillName}。`, 'PLUGIN_SKILL_DENIED')
        } else if (!['runtime', 'builtin', 'user', 'workspace'].includes(String(skill.origin || '').toLowerCase()) || skill.allowed === false) {
          push(errors, `agentProfiles[${index}].capabilities.skills`, `来源不明或未被允许的 Skill：${skillName}。`, 'SKILL_SOURCE_DENIED')
        }
      }
    } else if (profile.capabilities.skills.length) {
      warnings.push({ path: `agentProfiles[${index}].capabilities.skills`, message: '运行时没有提供 Skill capability snapshot；执行时将拒绝加载 Skill。', code: 'SKILL_CAPABILITY_UNKNOWN' })
    }
  }

  for (const [index, node] of graph.nodes.entries()) {
    maxLength(errors, `nodes[${index}].id`, node.id, 120)
    maxLength(errors, `nodes[${index}].title`, node.title, 300)
    maxLength(errors, `nodes[${index}].instruction`, node.instruction, 20000)
    maxLength(errors, `nodes[${index}].agentProfileId`, node.agentProfileId, 120)
    if (!node.id) push(errors, `nodes[${index}].id`, '节点 id 不能为空。', 'REQUIRED')
    if (node.id === VIRTUAL_ROOT_ID) push(errors, `nodes[${index}].id`, 'root 是保留的虚拟节点。', 'RESERVED_ID')
    if (nodeMap.has(node.id)) push(errors, `nodes[${index}].id`, `节点 id 重复：${node.id}。`, 'DUPLICATE_ID')
    nodeMap.set(node.id, node)
    if (!NODE_KINDS.has(node.kind)) push(errors, `nodes[${index}].kind`, `不支持的节点类型：${node.kind}。`, 'NODE_KIND')
    if (!node.title) push(errors, `nodes[${index}].title`, '节点 title 不能为空。', 'REQUIRED')
    if (node.kind === 'task' && !node.instruction && !allowEmpty) push(errors, `nodes[${index}].instruction`, 'task 节点 instruction 不能为空。', 'REQUIRED')
    if (!ACCESS_MODES.has(node.access)) push(errors, `nodes[${index}].access`, `不支持的 access：${node.access}。`, 'ACCESS_MODE')
    if (!FAILURE_POLICIES.has(node.failurePolicy)) push(errors, `nodes[${index}].failurePolicy`, `不支持的 failurePolicy：${node.failurePolicy}。`, 'FAILURE_POLICY')
    if (!profileMap.has(node.agentProfileId) && node.kind === 'task') push(errors, `nodes[${index}].agentProfileId`, `节点引用的 Agent Profile 不存在：${node.agentProfileId}。`, 'MISSING_PROFILE')
    if (node.kind === 'task' && profileMap.get(node.agentProfileId)?.enabled === false) push(errors, `nodes[${index}].agentProfileId`, `节点引用的 Agent Profile 已停用：${node.agentProfileId}。`, 'PROFILE_DISABLED')
    const fields = new Set(node.outputContract.fields)
    for (const field of fields) {
      if (field !== 'text' && field !== 'artifactRefs') push(errors, `nodes[${index}].outputContract.fields`, `不支持的输出字段：${field}。`, 'OUTPUT_SCHEMA')
    }
    if (!fields.has('text') && !fields.has('artifactRefs')) push(errors, `nodes[${index}].outputContract.fields`, '输出契约至少要包含 text 或 artifactRefs。', 'OUTPUT_SCHEMA')
  }

  const adjacency = new Map([...nodeMap.keys()].map((id) => [id, []]))
  const reverse = new Map([...nodeMap.keys()].map((id) => [id, []]))
  const edgeKeys = new Set()
  for (const [index, edge] of graph.edges.entries()) {
    maxLength(errors, `edges[${index}].from`, edge.from, 120)
    maxLength(errors, `edges[${index}].to`, edge.to, 120)
    if (!edge.from || !edge.to) {
      push(errors, `edges[${index}]`, 'edge 必须包含 from/to。', 'EDGE_REQUIRED')
      continue
    }
    if (edge.to === VIRTUAL_ROOT_ID) push(errors, `edges[${index}].to`, '不能连入虚拟 Root。', 'ROOT_INCOMING')
    if (edge.from !== VIRTUAL_ROOT_ID && !nodeMap.has(edge.from)) push(errors, `edges[${index}].from`, `edge.from 节点不存在：${edge.from}。`, 'MISSING_NODE')
    if (edge.to !== VIRTUAL_ROOT_ID && !nodeMap.has(edge.to)) push(errors, `edges[${index}].to`, `edge.to 节点不存在：${edge.to}。`, 'MISSING_NODE')
    if (edge.from === edge.to) push(errors, `edges[${index}]`, '不能创建自环。', 'CYCLE')
    const key = `${edge.from}\u0000${edge.to}`
    if (edgeKeys.has(key)) push(errors, `edges[${index}]`, '重复 edge。', 'DUPLICATE_EDGE')
    edgeKeys.add(key)
    if (edge.from !== VIRTUAL_ROOT_ID && nodeMap.has(edge.from) && nodeMap.has(edge.to)) adjacency.get(edge.from).push(edge.to)
    if (nodeMap.has(edge.to) && edge.from !== VIRTUAL_ROOT_ID) reverse.get(edge.to).push(edge.from)
  }

  const indegree = new Map([...nodeMap.keys()].map((id) => [id, reverse.get(id).length]))
  const queue = [...nodeMap.values()].filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const topological = []
  while (queue.length) {
    const id = queue.shift()
    topological.push(id)
    for (const next of adjacency.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  if (topological.length !== nodeMap.size) push(errors, 'edges', 'Graph 包含环，DAG 校验失败。', 'CYCLE')

  const layers = []
  const depthById = new Map()
  for (const id of topological) {
    const parents = reverse.get(id) || []
    const depth = parents.length ? Math.max(...parents.map((parent) => depthById.get(parent) || 0)) + 1 : 0
    depthById.set(id, depth)
    if (!layers[depth]) layers[depth] = []
    layers[depth].push(id)
  }
  const depth = layers.length ? layers.length : 0
  if (depth > graph.limits.maxDepth) push(errors, 'limits.maxDepth', `Graph 深度 ${depth} 超过 maxDepth=${graph.limits.maxDepth}。`, 'LIMIT')
  for (const node of graph.nodes) {
    if (node.kind === 'merge' && (reverse.get(node.id)?.length || 0) < 2) {
      push(errors, `nodes.${node.id}`, 'merge 节点至少需要两个前置节点。', 'MERGE_INPUTS')
    }
  }

  const layerStats = layers.map((ids) => {
    const nodes = ids.map((id) => nodeMap.get(id)).filter(Boolean)
    return {
      nodeIds: ids,
      readNodes: nodes.filter((node) => node.access === 'read').length,
      writeNodes: nodes.filter((node) => node.access === 'write').length
    }
  })
  const writeNodes = graph.nodes.filter((node) => node.access === 'write').length
  const maxRead = Math.max(0, ...layerStats.map((item) => item.readNodes))
  const maxLayerWidth = Math.max(0, ...layerStats.map((item) => item.nodeIds.length))
  if (maxRead > graph.limits.maxParallel) warnings.push({ path: 'limits.maxParallel', message: `静态预览中某层有 ${maxRead} 个 read 节点，将按 maxParallel=${graph.limits.maxParallel} 分批。`, code: 'PARALLEL_LIMIT' })
  if (writeNodes > 1) warnings.push({ path: 'nodes', message: 'write 节点在运行时保持串行；不会与另一个 write 节点并发。', code: 'WRITE_SERIALIZED' })

  const report = {
    valid: errors.length === 0,
    errors,
    warnings,
    graph,
    roots: graph.nodes.filter((node) => (reverse.get(node.id) || []).length === 0).map((node) => node.id),
    leaves: graph.nodes.filter((node) => (adjacency.get(node.id) || []).length === 0).map((node) => node.id),
    topological,
    layers,
    depth,
    depthById: Object.fromEntries(depthById),
    parallelism: {
      maxRead,
      maxLayerWidth,
      writeNodes,
      writeSerialized: true,
      configuredMaxParallel: graph.limits.maxParallel
    },
    dependencies: Object.fromEntries([...reverse.entries()].map(([id, parents]) => [id, parents.length ? parents : [VIRTUAL_ROOT_ID]]))
  }
  return report
}

export function assertValidGraph(input, options = {}) {
  const report = validateGraph(input, options)
  if (!report.valid) throw new GraphValidationError(report.errors[0]?.message || 'Graph 校验失败。', report.errors)
  return report
}

export function validateGraphPatch(base, patch, options = {}) {
  const { applyGraphPatch } = options
  if (typeof applyGraphPatch !== 'function') throw new Error('validateGraphPatch 需要 options.applyGraphPatch。')
  const next = applyGraphPatch(base, patch)
  return { graph: next, validation: validateGraph(next, options) }
}
