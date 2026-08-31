import { applyGraphPatch, clone, graphSummary, normalizeGraph, resolveProfileDefaults } from './graph-schema.js'
import { validateGraph } from './validator.js'

export function buildPlannerContext({ roster = [], capabilitySnapshot = {} } = {}) {
  const publicRoster = roster.map((profile) => ({
    id: profile.id,
    name: profile.name,
    executor: profile.executor,
    provider: profile.provider,
    model: profile.model,
    capabilities: profile.capabilities,
    permissionMode: profile.permissionMode
  }))
  return [
    'Graph Job Planner 可用上下文（仅在用户明确要求任务图时使用；节点 Agent 不得把它当作可调用能力）。',
    `Agent Profile roster（只能引用这些 id）：${JSON.stringify(publicRoster)}`,
    `Capability snapshot（只读；不可由 Planner 扩大）：${JSON.stringify(capabilitySnapshot)}`
  ].join('\n\n')
}

export function buildPlannerPrompt({ goal, roster = [], capabilitySnapshot = {}, baseGraph = null } = {}) {
  return [
    '你是 Graph Job Planner。只负责提出任务图草案，不执行节点，不调用外部工具。',
    '输出必须是一个 JSON object，不要 Markdown、思考过程、stderr 或额外字段。',
    '只能使用给定 Agent Profile id；只能使用 task/merge 节点；只能使用 read/write 访问模式。',
    '所有节点必须通过有向无环图连接；未显式连接的节点由虚拟 root 进入。',
    '节点的 instruction 必须具体，merge 节点必须汇总其所有直接前置节点。',
    '输出形状：{"goal":string,"agentProfiles":[{"id":string}],"nodes":[{"id":string,"kind":"task|merge","title":string,"instruction":string,"agentProfileId":string,"access":"read|write"}],"edges":[{"from":"root|node-id","to":"node-id"}],"limits":{"maxParallel":number,"maxDepth":number}}。',
    `目标：${String(goal || '').trim()}`,
    buildPlannerContext({ roster, capabilitySnapshot }),
    baseGraph ? `当前 Graph（如需修改，只能产生受限 patch）：${JSON.stringify(baseGraph)}` : '当前没有 Graph。'
  ].join('\n')
}

function rosterMap(roster) {
  return new Map((Array.isArray(roster) ? roster : []).map((profile) => [String(profile.id), profile]))
}

function selectRoster(inputProfiles, roster) {
  const available = rosterMap(roster)
  if (!Array.isArray(inputProfiles) || inputProfiles.length === 0) return [...available.values()].map(clone)
  const selected = []
  for (const item of inputProfiles) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!id || !available.has(id)) {
      const error = new Error(`Planner 只能引用 roster 中的 Agent Profile：${id || '(empty)'}`)
      error.code = 'PLANNER_PROFILE_DENIED'
      throw error
    }
    selected.push(clone(available.get(id)))
  }
  return selected
}

export function normalizePlannerDraft(input, options = {}) {
  const roster = options.roster || []
  const value = input && typeof input === 'object' ? input : {}
  const graph = normalizeGraph({
    ...value,
    graphId: options.graphId || value.graphId,
    sessionId: options.sessionId || value.sessionId,
    goal: options.goal ?? value.goal,
    source: options.source || 'auto',
    manualLock: false,
    agentProfiles: selectRoster(value.agentProfiles, roster),
    capabilitySnapshot: options.capabilitySnapshot || value.capabilitySnapshot,
    planner: {
      mode: 'current-conversation-model',
      generatedAt: Date.now(),
      promptVersion: 1
    }
  }, {
    defaultModel: options.defaultModel,
    resolveDefaults: true
  })
  return graph
}

export function createPlannerPreview(input, options = {}) {
  const graph = input.patch
    ? applyGraphPatch(input.baseGraph, input.patch, { now: options.now })
    : normalizePlannerDraft(input.draft || input, options)
  const normalized = resolveProfileDefaults(graph, options.defaultModel || {})
  normalized.graphId = options.graphId || normalized.graphId
  normalized.sessionId = options.sessionId || normalized.sessionId
  normalized.source = input.patch ? 'manual' : 'auto'
  normalized.manualLock = false
  const validation = validateGraph(normalized, {
    capabilities: options.capabilitySnapshot || normalized.capabilitySnapshot,
    allowEmpty: options.allowEmpty === true
  })
  return {
    graph: normalized,
    validation,
    summary: graphSummary(normalized, validation),
    confirmationRequired: true,
    confirmationToken: null
  }
}

export function restrictedPlannerPatch(baseGraph, patch, options = {}) {
  if (!patch || typeof patch !== 'object' || !Array.isArray(patch.operations)) throw new Error('Planner patch 必须包含 operations 数组。')
  const denied = patch.operations.find((operation) => !['addNode', 'removeNode', 'updateNode', 'addEdge', 'removeEdge', 'updateLimits', 'setGoal'].includes(operation?.op))
  if (denied) {
    const error = new Error(`Planner patch 不允许操作：${denied.op || '(empty)'}`)
    error.code = 'PLANNER_PATCH_DENIED'
    throw error
  }
  const next = applyGraphPatch(baseGraph, patch, options)
  const roster = rosterMap(options.roster || [])
  for (const profile of next.agentProfiles) {
    if (roster.size && !roster.has(profile.id)) {
      const error = new Error(`Planner patch 引用了不在 roster 的 Agent Profile：${profile.id}`)
      error.code = 'PLANNER_PROFILE_DENIED'
      throw error
    }
  }
  return next
}
