import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

import { buildCapabilityCatalog } from './capabilities.js'
import { createExecutorMap } from './executors.js'
import { clone, diffGraph, normalizeGraph, normalizeProfile, resolveProfileDefaults, graphSummary } from './graph-schema.js'
import { normalizePlannerDraft, restrictedPlannerPatch } from './planner.js'
import { GraphJobStorage } from './storage.js'
import { GraphScheduler } from './scheduler.js'
import { validateGraph } from './validator.js'

const DEFAULT_PROFILE = {
  id: 'dsh-default',
  name: 'DSH 默认 Agent',
  executor: 'dsh',
  provider: '',
  model: '',
  capabilities: { tools: [], skills: [] },
  permissionMode: 'default',
  maxOutputTokens: 4096,
  enabled: true
}

function nowValue(now) {
  return typeof now === 'function' ? Number(now()) : Date.now()
}

function errorWithCode(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function activeRunStatus(status) {
  return ['created', 'running', 'paused'].includes(status)
}

function normalizeTemplateScope(value) {
  return String(value || '').trim().toLowerCase() === 'global' ? 'global' : 'workspace'
}

function normalizeWorkspaceId(value, asPath = false) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return (asPath ? resolvePath(raw) : raw).replace(/[\\/]+$/, '').toLowerCase()
}

function workspaceIdFor(input = {}, fallbackCwd = '') {
  if (input.workspaceId) return normalizeWorkspaceId(input.workspaceId)
  return normalizeWorkspaceId(input.cwd || fallbackCwd || process.cwd(), true)
}

function templateVisible(template, workspaceId) {
  if (normalizeTemplateScope(template?.scope) === 'global') return true
  return Boolean(workspaceId) && normalizeWorkspaceId(template?.workspaceId) === normalizeWorkspaceId(workspaceId)
}

function publicProfile(profile) {
  const value = clone(profile)
  if (!value) return value
  delete value.secret
  delete value.apiKey
  delete value.token
  return value
}

export class GraphJobOrchestrator {
  constructor(options = {}) {
    this.options = options
    this.services = options.services || {}
    this.storage = options.storage || new GraphJobStorage({ root: options.storageRoot, env: options.env || process.env })
    this.now = options.now || (() => Date.now())
    this.idFactory = options.idFactory || ((kind) => `${kind}-${randomUUID()}`)
    this.profiles = new Map()
    this.templates = new Map()
    this.graphs = new Map()
    this.bindings = {}
    this.previews = new Map()
    this.templatePreviews = new Map()
    this.schedulers = new Map()
    this.startLocks = new Map()
    this.listeners = new Map()
    this.capabilityCache = new Map()
    this.initialized = false
  }

  initialize() {
    if (this.initialized) return this
    this.initialized = true
    this.storage.ensure?.()
    const persistedProfiles = this.storage.loadAgentProfiles?.() || []
    const profiles = persistedProfiles.length ? persistedProfiles : [DEFAULT_PROFILE]
    for (const item of profiles) {
      const profile = normalizeProfile(item)
      if (profile.id) this.profiles.set(profile.id, profile)
    }
    if (!persistedProfiles.length) this.storage.saveAgentProfiles?.([...this.profiles.values()])
    for (const item of this.storage.listTemplates?.() || []) if (item?.id) this.templates.set(item.id, item)
    for (const item of this.storage.listGraphs?.() || []) if (item?.id && item.graph) this.graphs.set(item.id, item.graph)
    this.bindings = this.storage.loadBindings?.() || {}
    return this
  }

  getProfiles() {
    this.initialize()
    return [...this.profiles.values()].map(publicProfile)
  }

  setProfiles(input, options = {}) {
    this.initialize()
    if (!Array.isArray(input)) throw new Error('Agent Profiles 必须是数组。')
    const next = new Map()
    for (const item of input) {
      const profile = normalizeProfile(item)
      if (!profile.id) throw new Error('Agent Profile id 不能为空。')
      if (next.has(profile.id)) throw new Error(`Agent Profile id 重复：${profile.id}`)
      next.set(profile.id, profile)
    }
    if (!next.size) next.set(DEFAULT_PROFILE.id, normalizeProfile(DEFAULT_PROFILE))
    const capabilities = options.capabilities || this.capabilityCache.get(options.cwd || process.cwd())
    if (capabilities && options.validateCapabilities !== false) {
      const resolved = [...next.values()].map((profile) => normalizeProfile(profile, {
        defaultModel: this.defaultModel(),
        resolveDefaults: true
      }))
      const report = validateGraph({
        schemaVersion: 1,
        graphId: 'profile-validation',
        revision: 1,
        goal: 'profile-validation',
        agentProfiles: resolved,
        nodes: [],
        edges: [],
        capabilitySnapshot: capabilities
      }, { capabilities, allowEmpty: true, enforceExecutorAvailability: true })
      if (!report.valid) {
        const error = errorWithCode(report.errors[0]?.message || 'Agent Profile capability 校验失败。', 'PROFILE_CAPABILITY_MISMATCH')
        error.errors = report.errors
        throw error
      }
    }
    this.profiles = next
    this.storage.saveAgentProfiles?.([...this.profiles.values()])
    return this.getProfiles()
  }

  async capabilities(options = {}) {
    this.initialize()
    const cwd = String(options.cwd || '').trim() || process.cwd()
    if (!options.refresh && this.capabilityCache.has(cwd)) return clone(this.capabilityCache.get(cwd))
    const catalog = options.catalog || await buildCapabilityCatalog({
      ...this.services,
      runtimeVersion: this.options.runtimeVersion,
      cwd
    })
    this.capabilityCache.set(cwd, catalog)
    return clone(catalog)
  }

  defaultModel() {
    try {
      return clone(this.services.agentDefaultModel?.currentSelection?.() || {}) || {}
    } catch {
      return {}
    }
  }

  graphForSession(sessionId) {
    const binding = this.bindings[String(sessionId || '').trim()]
    if (!binding?.activeGraphId) return null
    return (binding.activeRevision
      ? this.storage.readGraph?.(binding.activeGraphId, binding.activeRevision)
      : null) || this.graphs.get(binding.activeGraphId) || null
  }

  getBinding(sessionId) {
    this.initialize()
    const binding = this.bindings[String(sessionId || '').trim()]
    return binding ? clone(binding) : null
  }

  activeRunForSession(sessionId) {
    const binding = this.getBinding(sessionId)
    if (!binding?.activeRunId) return null
    return this.getRun(binding.activeRunId)
  }

  assertNoActiveRun(sessionId, { allowPaused = false } = {}) {
    const activeRun = this.activeRunForSession(sessionId)
    const blocked = activeRun && (activeRun.status === 'created' || activeRun.status === 'running' || (!allowPaused && activeRun.status === 'paused'))
    if (blocked) {
      throw errorWithCode('当前会话的 Graph Run 仍处于 active 状态；请先取消、终止或等待它结束后再创建新 revision。', 'GRAPH_RUN_ACTIVE')
    }
  }

  assertPendingRevisionEditAllowed(sessionId, currentGraph, nextGraph) {
    const activeRun = this.activeRunForSession(sessionId)
    if (!activeRun || !activeRunStatus(activeRun.status)) return
    if (activeRun.status !== 'paused') {
      throw errorWithCode('Graph Run 正在执行，不能修改其 revision；请先取消或终止后再编辑。', 'GRAPH_RUN_ACTIVE')
    }
    if (!currentGraph || currentGraph.graphId !== activeRun.graphId || nextGraph.graphId !== activeRun.graphId) {
      throw errorWithCode('暂停中的 Graph Run 只允许在同一 Graph 上编辑 pending 节点或边。', 'GRAPH_RUN_ACTIVE')
    }
    const protectedIds = new Set(Object.values(activeRun.nodeStates || {})
      .filter((item) => ['running', 'succeeded', 'failed'].includes(item.status))
      .map((item) => item.nodeId))
    const beforeNodes = new Map(currentGraph.nodes.map((node) => [node.id, JSON.stringify(node)]))
    const afterNodes = new Map(nextGraph.nodes.map((node) => [node.id, JSON.stringify(node)]))
    for (const id of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
      if (protectedIds.has(id) && beforeNodes.get(id) !== afterNodes.get(id)) {
        throw errorWithCode(`节点 ${id} 已经 running/succeeded/failed，不能在原 revision 上修改。`, 'GRAPH_RUN_ACTIVE')
      }
    }
    const edgeKey = (edge) => `${edge.from}\u0000${edge.to}`
    const beforeEdges = new Map(currentGraph.edges.map((edge) => [edgeKey(edge), edge]))
    const afterEdges = new Map(nextGraph.edges.map((edge) => [edgeKey(edge), edge]))
    for (const key of new Set([...beforeEdges.keys(), ...afterEdges.keys()])) {
      if (beforeEdges.has(key) === afterEdges.has(key)) continue
      const edge = afterEdges.get(key) || beforeEdges.get(key)
      const endpoints = [edge.from, edge.to].filter((id) => id !== 'root')
      if (endpoints.every((id) => protectedIds.has(id))) {
        throw errorWithCode(`边 ${edge.from} -> ${edge.to} 触及已完成节点，不能在暂停 run 上修改。`, 'GRAPH_RUN_ACTIVE')
      }
    }
  }

  chooseProfiles(input, preserveSnapshot = false) {
    const current = this.profiles
    const entries = Array.isArray(input) ? input : []
    if (!entries.length) return [...current.values()].map(clone)
    const selected = []
    for (const entry of entries) {
      const id = String(typeof entry === 'string' ? entry : entry?.id || '').trim()
      if (!id) throw errorWithCode('Agent Profile id 不能为空。', 'MISSING_PROFILE')
      if (preserveSnapshot && typeof entry === 'object') {
        selected.push(normalizeProfile(entry))
        continue
      }
      const profile = current.get(id)
      if (!profile) throw errorWithCode(`Agent Profile 不存在：${id}`, 'MISSING_PROFILE')
      selected.push(clone(profile))
    }
    return selected
  }

  async prepareGraph(input = {}, options = {}) {
    this.initialize()
    const sessionId = String(options.sessionId || input.sessionId || '').trim()
    const cwd = String(options.cwd || '').trim() || process.cwd()
    const catalog = options.catalog || await this.capabilities({ cwd })
    const existing = options.existingGraph || (input.graphId ? this.graphs.get(String(input.graphId)) : this.graphForSession(sessionId))
    const graphId = String(options.graphId || input.graphId || existing?.graphId || this.idFactory('graph')).trim()
    const source = options.source || input.source || 'manual'
    const preserveSnapshot = options.preserveSnapshot === true
    const supplied = input.graph || input.draft || input
    const profiles = this.chooseProfiles(supplied.agentProfiles, preserveSnapshot)
    let graph = normalizeGraph({
      ...supplied,
      graphId,
      sessionId,
      source,
      manualLock: source === 'manual' || source === 'template',
      agentProfiles: profiles,
      capabilitySnapshot: catalog,
      createdAt: existing?.createdAt || supplied.createdAt,
      revision: supplied.revision || existing?.revision || 1
    }, {
      defaultModel: this.defaultModel(),
      resolveDefaults: true,
      now: nowValue(this.now)
    })
    if (existing && graph.revision <= existing.revision) graph.revision = existing.revision + 1
    graph = resolveProfileDefaults(graph, this.defaultModel())
    graph.graphId = graphId
    graph.sessionId = sessionId
    graph.source = source
    graph.manualLock = source === 'manual' || source === 'template'
    graph.capabilitySnapshot = clone(catalog)
    graph.updatedAt = nowValue(this.now)
    return { graph, catalog, existing, cwd }
  }

  makePreview(prepared, options = {}) {
    const { graph, catalog } = prepared
    const validation = validateGraph(graph, {
      capabilities: catalog,
      allowEmpty: options.allowEmpty === true
    })
    const previewId = this.idFactory('preview')
    const record = {
      previewId,
      graph: clone(graph),
      diff: prepared.existing ? diffGraph(prepared.existing, graph) : null,
      validation,
      sessionId: graph.sessionId,
      cwd: prepared.cwd,
      createdAt: nowValue(this.now),
      expiresAt: nowValue(this.now) + 30 * 60 * 1000,
      confirmed: false,
      confirmationToken: validation.valid ? this.idFactory('confirm') : ''
    }
    this.previews.set(previewId, record)
    return {
      previewId,
      graph: clone(graph),
      diff: clone(record.diff),
      validation: clone(validation),
      summary: graphSummary(graph, validation),
      confirmationRequired: true,
      confirmationToken: record.confirmationToken || null,
      expiresAt: record.expiresAt
    }
  }

  async preview(input = {}) {
    const prepared = await this.prepareGraph(input, {
      ...input,
      source: input.source || 'manual',
      preserveSnapshot: input.preserveSnapshot === true
    })
    return this.makePreview(prepared, { allowEmpty: input.allowEmpty === true })
  }

  async previewEmpty({ sessionId = '', goal = '', cwd = '' } = {}) {
    const prepared = await this.prepareGraph({
      sessionId,
      goal,
      source: 'manual',
      agentProfiles: this.getProfiles(),
      nodes: [],
      edges: [],
      limits: {}
    }, { sessionId, cwd, source: 'manual' })
    return this.makePreview(prepared, { allowEmpty: true })
  }

  async previewPlanner(input = {}) {
    this.initialize()
    const sessionId = String(input.sessionId || '').trim()
    const binding = this.getBinding(sessionId)
    const manualTemplateEdit = binding?.manualLock === true
    if (manualTemplateEdit && !['saveAs', 'overwrite'].includes(input.templateMode)) {
      throw errorWithCode('当前会话的 Graph 已被手工编辑锁定；模型修订只能作为候选，并必须选择 saveAs 或 overwrite 模板。', 'TEMPLATE_DECISION_REQUIRED')
    }
    const cwd = String(input.cwd || '').trim() || process.cwd()
    const catalog = await this.capabilities({ cwd })
    const activeGraph = this.graphForSession(sessionId)
    if (input.patch && input.baseGraph && activeGraph && (
      String(input.baseGraph.graphId || '') !== String(activeGraph.graphId || '') ||
      Number(input.baseGraph.revision || 0) !== Number(activeGraph.revision || 0)
    )) {
      throw errorWithCode('Planner patch 的 baseGraph 不是当前会话活动 revision。', 'GRAPH_REVISION_CONFLICT')
    }
    const baseGraph = input.patch ? activeGraph : (input.baseGraph || null)
    let draft
    if (input.patch) {
      if (!baseGraph) throw errorWithCode('Planner patch 找不到当前 Graph。', 'GRAPH_NOT_FOUND')
      draft = restrictedPlannerPatch(baseGraph, input.patch, { roster: this.getProfiles(), now: nowValue(this.now) })
      draft.source = 'auto'
      draft.manualLock = false
      draft.goal = String(input.goal || draft.goal || '').trim()
    } else {
      draft = normalizePlannerDraft(input.draft || input, {
        graphId: input.graphId || baseGraph?.graphId || this.idFactory('graph'),
        sessionId,
        goal: input.goal,
        roster: this.getProfiles(),
        defaultModel: this.defaultModel(),
        capabilitySnapshot: catalog,
        source: 'auto'
      })
    }
    const prepared = await this.prepareGraph({ ...draft, graph: draft }, {
      sessionId,
      cwd,
      source: 'auto',
      existingGraph: baseGraph,
      preserveSnapshot: true,
      catalog
    })
    prepared.graph.source = 'auto'
    prepared.graph.manualLock = false
    if (manualTemplateEdit) {
      const templatePreview = await this.previewTemplate({
        mode: input.templateMode,
        templateId: input.templateId,
        name: input.templateName || prepared.graph.goal || 'Graph Job 模板',
        description: input.templateDescription || '',
        scope: input.templateScope,
        graph: prepared.graph,
        sessionId,
        cwd,
        catalog
      })
      return {
        ...templatePreview,
        templateDecision: { mode: templatePreview.mode, templateId: templatePreview.templateId, scope: templatePreview.scope }
      }
    }
    return this.makePreview(prepared, { allowEmpty: false })
  }

  requirePreview(token, sessionId) {
    const value = String(token || '').trim()
    const record = [...this.previews.values()].find((item) => item.confirmationToken === value)
    if (!record || record.expiresAt < nowValue(this.now)) throw errorWithCode('确认 token 无效或已过期，请重新预览。', 'CONFIRMATION_REQUIRED')
    if (record.sessionId !== String(sessionId || '').trim()) throw errorWithCode('确认 token 不属于当前会话。', 'CONFIRMATION_SESSION_MISMATCH')
    return record
  }

  persistGraph(graph) {
    const saved = this.storage.saveGraphRevision(graph)
    this.graphs.set(graph.graphId, clone(saved))
    return clone(saved)
  }

  bindSession(sessionId, graph, activeRunId = '') {
    const id = String(sessionId || graph.sessionId || '').trim()
    if (!id) return null
    this.bindings[id] = {
      sessionId: id,
      activeGraphId: graph.graphId,
      activeRevision: graph.revision,
      activeRunId: activeRunId || '',
      manualLock: graph.manualLock === true,
      updatedAt: nowValue(this.now)
    }
    this.storage.saveBindings(this.bindings)
    return clone(this.bindings[id])
  }

  confirmPreview({ token, sessionId } = {}) {
    const record = this.requirePreview(token, sessionId)
    if (!record.validation.valid) throw errorWithCode('Graph 仍未通过 DAG/capability 校验，不能确认。', 'GRAPH_VALIDATION_FAILED')
    if (!record.confirmed) {
      this.assertNoActiveRun(record.sessionId, { allowPaused: true })
      const current = this.graphForSession(record.sessionId)
      if (current && current.graphId === record.graph.graphId && current.revision >= record.graph.revision) {
        throw errorWithCode(`预览基于旧 Graph revision：当前为 ${current.revision}，预览为 ${record.graph.revision}。`, 'GRAPH_REVISION_CONFLICT')
      }
      record.confirmed = true
      this.persistGraph(record.graph)
      this.bindSession(record.sessionId, record.graph)
    }
    return { ...this.publicPreview(record), confirmed: true }
  }

  publicPreview(record) {
    return {
      previewId: record.previewId,
      graph: clone(record.graph),
      diff: clone(record.diff),
      validation: clone(record.validation),
      summary: graphSummary(record.graph, record.validation),
      confirmationRequired: true,
      confirmationToken: record.confirmationToken || null,
      confirmed: record.confirmed === true,
      expiresAt: record.expiresAt
    }
  }

  getPreview(previewId) {
    const record = this.previews.get(String(previewId || '').trim())
    if (!record || record.expiresAt < nowValue(this.now)) return null
    return this.publicPreview(record)
  }

  saveManualGraph(input = {}) {
    this.initialize()
    const graphInput = input.graph || input
    const sessionId = String(input.sessionId || graphInput.sessionId || '').trim()
    const binding = this.getBinding(sessionId)
    const current = graphInput.graphId && binding?.activeGraphId === graphInput.graphId
      ? this.graphForSession(sessionId)
      : graphInput.graphId ? this.graphs.get(graphInput.graphId) : this.graphForSession(sessionId)
    const suppliedRevision = graphInput.baseRevision ?? graphInput.revision
    if (current && suppliedRevision !== undefined && Number(suppliedRevision) !== Number(current.revision)) {
      throw errorWithCode(`Graph revision 冲突：当前为 ${current.revision}，收到 ${suppliedRevision}。`, 'GRAPH_REVISION_CONFLICT')
    }
    const graph = normalizeGraph({ ...graphInput, graphId: graphInput.graphId || current?.graphId || this.idFactory('graph'), sessionId, source: 'manual', manualLock: true, revision: current ? current.revision + 1 : 1 }, { now: nowValue(this.now) })
    this.assertPendingRevisionEditAllowed(sessionId, current, graph)
    // Manual revisions reference the current user-owned Profile definitions;
    // the resolved Provider/Model snapshot is created by the preview boundary,
    // not trusted from a browser payload.
    const profiles = this.chooseProfiles(graphInput.agentProfiles, false)
    graph.agentProfiles = resolveProfileDefaults({ ...graph, agentProfiles: profiles }, this.defaultModel()).agentProfiles
    // A browser/manual payload cannot smuggle a capability allowlist into a
    // persisted revision. The preview and run boundaries obtain a fresh
    // runtime snapshot; this save path only stores the editable draft.
    graph.capabilitySnapshot = null
    const catalog = this.capabilityCache.get(input.cwd || process.cwd()) || null
    const validation = validateGraph(graph, { capabilities: catalog, allowEmpty: input.allowEmpty === true })
    if (!validation.valid) {
      const error = errorWithCode(validation.errors[0]?.message || 'Graph 校验失败。', 'GRAPH_VALIDATION_FAILED')
      error.errors = validation.errors
      throw error
    }
    const saved = this.persistGraph(graph)
    this.bindSession(sessionId, saved)
    return { graph: clone(saved), validation: clone(validation), summary: graphSummary(saved, validation) }
  }

  getGraph(graphId, revision) {
    this.initialize()
    const id = String(graphId || '').trim()
    if (!id) return null
    if (!revision) return clone(this.graphs.get(id) || this.storage.readGraph?.(id))
    return clone(this.storage.readGraph?.(id, revision) || (this.graphs.get(id)?.revision === Number(revision) ? this.graphs.get(id) : null))
  }

  listGraphs(sessionId = '') {
    this.initialize()
    const binding = this.getBinding(sessionId)
    const graph = binding?.activeGraphId ? this.getGraph(binding.activeGraphId, binding.activeRevision) : null
    return { binding, graph, graphs: [...this.graphs.values()].map(clone).filter(Boolean) }
  }

  listTemplates(options = {}) {
    this.initialize()
    const workspaceId = workspaceIdFor(options, this.resolveSessionCwd(options.sessionId))
    const filterVisible = options.filterVisible !== false
    return [...this.templates.values()]
      .filter((template) => !filterVisible || templateVisible(template, workspaceId))
      .map(clone)
  }

  saveTemplate(input = {}) {
    this.initialize()
    const id = String(input.id || input.templateId || this.idFactory('template')).trim()
    const current = this.templates.get(id)
    const scope = input.scope === undefined ? normalizeTemplateScope(current?.scope) : normalizeTemplateScope(input.scope)
    const workspaceId = scope === 'global'
      ? ''
      : workspaceIdFor(input, current?.workspaceId)
    const graph = normalizeGraph({ ...(input.graph || {}), graphId: `template-${id}`, source: 'template', manualLock: true, revision: current ? Number(current.currentRevision) + 1 : 1 }, { now: nowValue(this.now) })
    const saved = this.storage.saveTemplate({ id, name: input.name || id, description: input.description || '', scope, workspaceId, currentRevision: graph.revision, updatedAt: nowValue(this.now), graph })
    this.templates.set(id, saved)
    return clone(saved)
  }

  async previewTemplate(input = {}) {
    this.initialize()
    const mode = input.mode === 'overwrite' ? 'overwrite' : 'saveAs'
    const templateId = String(input.templateId || input.id || '').trim()
    const currentTemplate = templateId ? this.templates.get(templateId) : null
    const scope = input.scope === undefined && mode === 'overwrite'
      ? normalizeTemplateScope(currentTemplate?.scope)
      : normalizeTemplateScope(input.scope)
    const workspaceId = scope === 'global' ? '' : workspaceIdFor(input, currentTemplate?.workspaceId)
    if (mode === 'overwrite' && (!templateId || !currentTemplate || !templateVisible(currentTemplate, workspaceId))) {
      throw errorWithCode(`待覆盖的 Template 不存在：${templateId || '(empty)'}`, 'TEMPLATE_NOT_FOUND')
    }
    const cwd = String(input.cwd || '').trim() || process.cwd()
    const catalog = input.catalog || await this.capabilities({ cwd })
    const graphInput = input.graph || {}
    const graph = normalizeGraph({
      ...graphInput,
      graphId: `template-${templateId || this.idFactory('template')}`,
      source: 'template',
      manualLock: true,
      agentProfiles: this.chooseProfiles(graphInput.agentProfiles, false),
      capabilitySnapshot: catalog,
      revision: mode === 'overwrite' ? Number(currentTemplate.currentRevision || 0) + 1 : 1
    }, { defaultModel: this.defaultModel(), resolveDefaults: true, now: nowValue(this.now) })
    const validation = validateGraph(graph, { capabilities: catalog, allowEmpty: false })
    const previewId = this.idFactory('template-preview')
    const record = {
      previewId,
      mode,
      templateId: templateId || graph.graphId.slice('template-'.length),
      scope,
      workspaceId,
      name: String(input.name || templateId || graph.graphId),
      description: String(input.description || ''),
      graph: clone(graph),
      diff: currentTemplate?.graph ? diffGraph(currentTemplate.graph, graph) : null,
      validation,
      sessionId: String(input.sessionId || '').trim(),
      confirmationToken: validation.valid ? this.idFactory('template-confirm') : '',
      expiresAt: nowValue(this.now) + 30 * 60 * 1000
    }
    this.templatePreviews.set(previewId, record)
    return {
      previewId,
      mode,
      templateId: record.templateId,
      scope: record.scope,
      graph: clone(graph),
      diff: clone(record.diff),
      validation: clone(validation),
      summary: graphSummary(graph, validation),
      confirmationRequired: true,
      confirmationToken: record.confirmationToken || null,
      expiresAt: record.expiresAt
    }
  }

  getTemplatePreview(previewId) {
    const record = this.templatePreviews.get(String(previewId || '').trim())
    if (!record || record.expiresAt < nowValue(this.now)) return null
    return {
      previewId: record.previewId,
      mode: record.mode,
      templateId: record.templateId,
      scope: record.scope,
      graph: clone(record.graph),
      diff: clone(record.diff),
      validation: clone(record.validation),
      summary: graphSummary(record.graph, record.validation),
      confirmationRequired: true,
      confirmationToken: record.confirmationToken || null,
      confirmed: record.confirmed === true,
      expiresAt: record.expiresAt
    }
  }

  confirmTemplate({ token, sessionId } = {}) {
    const value = String(token || '').trim()
    const record = [...this.templatePreviews.values()].find((item) => item.confirmationToken === value)
    if (!record || record.expiresAt < nowValue(this.now)) throw errorWithCode('Template 确认 token 无效或已过期，请重新预览。', 'CONFIRMATION_REQUIRED')
    if (record.sessionId && record.sessionId !== String(sessionId || '').trim()) throw errorWithCode('Template 确认 token 不属于当前会话。', 'CONFIRMATION_SESSION_MISMATCH')
    if (!record.validation.valid) throw errorWithCode('Template Graph 未通过校验，不能保存。', 'GRAPH_VALIDATION_FAILED')
    if (record.confirmed) {
      return { ...(this.templates.get(record.templateId) || {}), confirmed: true, previewId: record.previewId }
    }
    const template = this.saveTemplate({
      id: record.templateId,
      name: record.name,
      description: record.description,
      scope: record.scope,
      workspaceId: record.workspaceId,
      graph: record.graph,
      _confirmed: true
    })
    record.confirmed = true
    return { ...template, confirmed: true, previewId: record.previewId }
  }

  bindTemplate({ sessionId = '', templateId = '', cwd = '', workspaceId = '' } = {}) {
    this.initialize()
    this.assertNoActiveRun(sessionId)
    const template = this.templates.get(String(templateId).trim()) || this.storage.readTemplate?.(templateId)
    if (!template?.graph) throw errorWithCode(`Template 不存在：${templateId}`, 'TEMPLATE_NOT_FOUND')
    const visibleWorkspace = workspaceIdFor({ workspaceId, cwd }, this.resolveSessionCwd(sessionId))
    if (!templateVisible(template, visibleWorkspace)) throw errorWithCode(`Template 不属于当前 workspace：${templateId}`, 'TEMPLATE_NOT_FOUND')
    const graph = normalizeGraph({ ...template.graph, graphId: this.idFactory('graph'), sessionId, source: 'template', manualLock: true, revision: 1 }, { now: nowValue(this.now) })
    const saved = this.persistGraph(graph)
    this.bindSession(sessionId, saved)
    return clone(saved)
  }

  getRun(runId) {
    const id = String(runId || '').trim()
    const scheduler = this.schedulers.get(id)
    if (scheduler) return scheduler.snapshot()
    for (const graph of this.graphs.values()) {
      const run = this.storage.readRun?.(graph.graphId, id)
      if (run) return run
    }
    return null
  }

  async startRun(input = {}) {
    const sessionId = String(input.sessionId || '').trim()
    const previous = this.startLocks.get(sessionId) || Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const chain = previous.catch(() => {}).then(() => gate)
    this.startLocks.set(sessionId, chain)
    try {
      await previous.catch(() => {})
      return await this.startRunUnlocked(input)
    } finally {
      release()
      if (this.startLocks.get(sessionId) === chain) this.startLocks.delete(sessionId)
    }
  }

  async startRunUnlocked(input = {}) {
    this.initialize()
    const sessionId = String(input.sessionId || '').trim()
    if (!input.confirmationToken || input.confirmed !== true) throw errorWithCode('运行前必须提交预览返回的 confirmationToken，并明确 confirmed=true。', 'CONFIRMATION_REQUIRED')
    const record = this.requirePreview(input.confirmationToken, sessionId)
    if (!record.confirmed) this.confirmPreview({ token: input.confirmationToken, sessionId })
    const graph = this.getGraph(record.graph.graphId, record.graph.revision)
    if (!graph) throw errorWithCode('确认的 Graph revision 不存在。', 'GRAPH_NOT_FOUND')
    const binding = this.getBinding(sessionId)
    if (binding && (binding.activeGraphId !== graph.graphId || Number(binding.activeRevision) !== Number(graph.revision))) {
      throw errorWithCode(`confirmationToken 对应的 Graph revision 不是当前活动 revision：${binding.activeRevision || '(none)'}。`, 'GRAPH_REVISION_CONFLICT')
    }
    const existingRun = binding?.activeRunId ? this.getRun(binding.activeRunId) : null
    if (existingRun && activeRunStatus(existingRun.status)) throw errorWithCode('当前会话已有 active Graph Run。', 'ACTIVE_RUN_EXISTS')
    const historicalRuns = this.storage.listRuns?.(graph.graphId) || []
    if (historicalRuns.length >= graph.limits.maxTotalRuns) {
      throw errorWithCode(`Graph 已达到 maxTotalRuns=${graph.limits.maxTotalRuns}。`, 'RUN_LIMIT')
    }
    const cwd = String(input.cwd || '').trim() || this.resolveSessionCwd(sessionId) || process.cwd()
    const catalog = input.executorFactory
      ? (graph.capabilitySnapshot || await this.capabilities({ cwd }))
      : await this.capabilities({ cwd, refresh: true })
    const validation = validateGraph(graph, {
      capabilities: catalog,
      allowEmpty: false,
      enforceExecutorAvailability: !input.executorFactory
    })
    if (!validation.valid) throw errorWithCode(validation.errors[0]?.message || 'Graph 校验失败。', 'GRAPH_VALIDATION_FAILED')
    const parentAgent = input.parentAgent || this.services.agents?.get?.(sessionId)
    const executors = input.executorFactory ? null : createExecutorMap({
      services: this.services,
      capabilityCatalog: catalog,
      cwd,
      skillScopeAvailable: this.options.skillScopeAvailable === true
    })
    const executor = input.executorFactory
      ? input.executorFactory({ graph, catalog, cwd, sessionId })
      : async (request) => {
          const selected = executors[request.profile.executor]
          if (!selected) throw errorWithCode(`没有 executor：${request.profile.executor}`, 'CAPABILITY_MISMATCH')
          return selected.runNode(request)
        }
    const runId = String(input.runId || this.idFactory('run'))
    const scheduler = new GraphScheduler({
      graph,
      validation,
      executor,
      storage: this.storage,
      sessionId,
      parentAgent,
      cwd,
      runId,
      now: this.now,
      idFactory: () => runId,
      onEvent: (event, snapshot) => this.onSchedulerEvent(event, snapshot)
    })
    this.schedulers.set(runId, scheduler)
    this.bindSession(sessionId, graph, runId)
    try {
      const snapshot = scheduler.start({ confirmed: true })
      void scheduler.wait().then((finished) => this.onRunFinished(finished)).catch(() => {})
      return snapshot
    } catch (error) {
      this.schedulers.delete(runId)
      this.bindSession(sessionId, graph, '')
      throw error
    }
  }

  resolveSessionCwd(sessionId) {
    const agent = this.services.agents?.get?.(sessionId)
    return String(agent?.session?.header?.cwd || '').trim()
  }

  onSchedulerEvent(event, snapshot) {
    const listeners = this.listeners.get(snapshot.runId)
    for (const listener of listeners || []) {
      try { listener(event, snapshot) } catch { /* one subscriber cannot stop run events */ }
    }
  }

  onRunFinished(snapshot) {
    const binding = this.bindings[snapshot.sessionId]
    if (binding?.activeRunId !== snapshot.runId) return
    if (!activeRunStatus(snapshot.status)) {
      binding.activeRunId = ''
      binding.updatedAt = nowValue(this.now)
      this.storage.saveBindings(this.bindings)
    }
  }

  async retryRun(runId) {
    const id = String(runId || '').trim()
    const scheduler = this.schedulers.get(id)
    if (!scheduler) throw errorWithCode('当前进程没有可继续的 run；重启后不能自动恢复执行。', 'RUN_NOT_LIVE')
    const run = scheduler.snapshot()
    if (run.sessionId && this.getBinding(run.sessionId)?.activeRunId !== id) {
      throw errorWithCode('该 run 已不是当前会话的 active run，不能绕过当前 Graph revision 重试。', 'RUN_NOT_ACTIVE')
    }
    return scheduler.retryFailed()
  }

  async cancelRun(runId) {
    const scheduler = this.schedulers.get(String(runId || '').trim())
    if (!scheduler) throw errorWithCode('Run 不在当前进程中。', 'RUN_NOT_LIVE')
    return scheduler.cancel()
  }

  async terminateRun(runId) {
    const scheduler = this.schedulers.get(String(runId || '').trim())
    if (!scheduler) throw errorWithCode('Run 不在当前进程中。', 'RUN_NOT_LIVE')
    return scheduler.terminate()
  }

  readEvents(runId, since = 0) {
    const id = String(runId || '').trim()
    const run = this.getRun(id)
    if (!run) return []
    return this.storage.readRunEvents?.(run.graphId, id).filter((event) => Number(event.id || 0) > Number(since || 0)) || []
  }

  subscribe(runId, listener, since = 0) {
    const id = String(runId || '').trim()
    for (const event of this.readEvents(id, since)) listener(event, this.getRun(id))
    const listeners = this.listeners.get(id) || new Set()
    listeners.add(listener)
    this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(id)
    }
  }

  dispose() {
    for (const scheduler of this.schedulers.values()) scheduler.dispose()
    this.schedulers.clear()
    this.listeners.clear()
    this.previews.clear()
    this.templatePreviews.clear()
    this.startLocks.clear()
  }
}
