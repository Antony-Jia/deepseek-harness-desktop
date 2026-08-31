import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const NODE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', maxLength: 40000 },
    artifactRefs: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          type: { type: 'string', maxLength: 80 },
          summary: { type: 'string', maxLength: 1000 }
        }
      }
    }
  }
})

export class GraphExecutorError extends Error {
  constructor(message, code = 'GRAPH_EXECUTOR_ERROR', category = 'fatal', details = undefined) {
    super(message)
    this.name = 'GraphExecutorError'
    this.code = code
    this.category = category
    this.details = details
  }
}

export class CapabilityMismatchError extends GraphExecutorError {
  constructor(message, details) {
    super(message, 'CAPABILITY_MISMATCH', 'capability', details)
  }
}

export class OutputContractError extends GraphExecutorError {
  constructor(message, details) {
    super(message, 'OUTPUT_CONTRACT_INVALID', 'output', details)
  }
}

function childSessionIdFromRun(run, fallback = '') {
  return String(
    run?.id ||
    run?.localAgent?.session?.header?.id ||
    run?.localAgent?.session?.id ||
    run?.localAgent?.id ||
    fallback ||
    ''
  ).trim()
}

function resultFailure(result) {
  if (!result || typeof result !== 'object') {
    return new GraphExecutorError('Subagent 没有返回结果 payload。', 'MISSING_SUBAGENT_PAYLOAD', 'fatal')
  }
  if (result.isError === true || (result.stopReason && result.stopReason !== 'completed')) {
    const stopReason = String(result.stopReason || '').toLowerCase()
    const diagnostic = String(
      result.diagnostic ||
      result.error?.message ||
      result.error?.code ||
      result.error ||
      result.code ||
      ''
    ).trim()
    if (['aborted', 'abort', 'cancelled', 'canceled'].includes(stopReason)) return new GraphExecutorError('Subagent 已取消。', 'ABORTED', 'cancelled')
    if (/auth|unauthori[sz]|credential|login|token/i.test(stopReason)) return new GraphExecutorError(diagnostic || 'Subagent 需要认证。', 'AUTH_REQUIRED', 'permission')
    if (/rate.?limit|rate_limit|too many requests|\b429\b/i.test(stopReason)) return new GraphExecutorError(diagnostic || 'Subagent 请求受到限流。', 'RATE_LIMIT', 'rate-limit')
    if (/timeout|timed.?out|network|transport|connection/i.test(stopReason)) return new GraphExecutorError(diagnostic || 'Subagent transport 失败。', 'TRANSPORT_ERROR', 'transport', { stopReason })
    if (/auth|unauthori[sz]|credential|login|token/i.test(diagnostic)) {
      return new GraphExecutorError(diagnostic || 'Subagent 需要认证。', 'AUTH_REQUIRED', 'permission')
    }
    if (/rate.?limit|too many requests|\b429\b/i.test(diagnostic)) {
      return new GraphExecutorError(diagnostic || 'Subagent 请求受到限流。', 'RATE_LIMIT', 'rate-limit')
    }
    if (/timeout|timed out|network|connection|transport|temporarily unavailable|econn/i.test(diagnostic)) {
      return new GraphExecutorError(diagnostic || 'Subagent transport 失败。', 'TRANSPORT_ERROR', 'transport', { stopReason })
    }
    return new GraphExecutorError(diagnostic || `Subagent 以 ${stopReason || 'error'} 结束。`, 'SUBAGENT_ERROR', 'fatal', { stopReason })
  }
  return null
}

function normalizeSubagentResult(result, options = {}) {
  const failure = resultFailure(result)
  if (failure) throw failure
  return normalizeNodeOutput(result, options)
}

function executionEnvelope(result, childSessionId = '') {
  return { result, childSessionId: String(childSessionId || '').trim() }
}

export function resolveChildPermission(profile = {}) {
  const requested = String(profile.permissionMode || 'default').trim()
  if (requested === 'approve-for-me') {
    throw new CapabilityMismatchError('当前 delegated child runtime 不支持在子 Agent 内交互式审批；请将 permissionMode 设为 default 或 never。')
  }
  return {
    requested,
    effectiveApproval: 'never',
    sandbox: 'inherit-parent'
  }
}

export function resolveCodexPermission(profile = {}, providerCapabilities = {}) {
  const requested = String(profile.permissionMode || 'default').trim()
  if (requested === 'default') return { mode: requested, passThrough: false }
  const supported = providerCapabilities.permissionMode === true ||
    (Array.isArray(providerCapabilities.permissionModes) && providerCapabilities.permissionModes.includes(requested))
  if (!supported) {
    throw new CapabilityMismatchError(`Codex provider 未公布 permissionMode=${requested} 的安全映射。`)
  }
  return { mode: requested, passThrough: true }
}

function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (typeof content.text === 'string') return content.text.trim()
    return contentText(content.content || content.output)
  }
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    if (block.type === 'text' || block.type === 'text-delta') return String(block.text || '')
    if (typeof block.text === 'string') return block.text
    if (block.content || block.output) return contentText(block.content || block.output)
    return ''
  }).filter(Boolean).join('\n\n').trim()
}

function balancedObject(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quoted) { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function candidateObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  const text = contentText(value)
  const candidate = balancedObject(text)
  if (!candidate) return null
  try { return JSON.parse(candidate) } catch { return null }
}

export function validateArtifactRefs(refs, options = {}) {
  const cwd = resolve(String(options.cwd || '').trim() || process.cwd())
  const canonicalCwd = existsSync(cwd) ? realpathSync(cwd) : cwd
  if (!Array.isArray(refs)) throw new OutputContractError('artifactRefs 必须是数组。')
  if (refs.length > 64) throw new OutputContractError('artifactRefs 最多 64 个。')
  return refs.map((item, index) => {
    const value = typeof item === 'string' ? { path: item } : item
    const path = String(value?.path || '').trim()
    if (path.length > 1024) throw new OutputContractError(`artifactRefs[${index}] 路径超过 1024 字符。`)
    if (!path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
      throw new OutputContractError(`artifactRefs[${index}] 必须是 workspace-relative 路径。`)
    }
    const absolute = resolve(cwd, path)
    const canonicalAbsolute = existsSync(absolute) ? realpathSync(absolute) : absolute
    const relativePath = relative(canonicalCwd, canonicalAbsolute)
    const outside = relativePath.startsWith('..') || isAbsolute(relativePath)
    if (outside) throw new OutputContractError(`artifactRefs[${index}] 路径超出 session cwd：${path}`)
    if (options.requireExisting && !existsSync(absolute)) throw new OutputContractError(`artifactRefs[${index}] 文件不存在：${path}`)
    return {
      path,
      type: String(value?.type || 'file').trim().slice(0, 80),
      summary: String(value?.summary || '').trim().slice(0, 1000)
    }
  })
}

export function normalizeNodeOutput(raw, options = {}) {
  const contract = options.contract || { requireText: true, allowEmptyText: false, allowArtifactRefs: true }
  const structured = raw?.structured && typeof raw.structured === 'object' ? raw.structured : candidateObject(raw?.output ?? raw)
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    throw new OutputContractError('Subagent 输出不是合法的 Graph Node JSON。')
  }
  const hasText = Object.prototype.hasOwnProperty.call(structured, 'text')
  const hasArtifactRefs = Object.prototype.hasOwnProperty.call(structured, 'artifactRefs')
  if (contract.requireText && !hasText) throw new OutputContractError('Graph Node 输出缺少 text。')
  if (hasText && typeof structured.text !== 'string') throw new OutputContractError('Graph Node 输出的 text 必须是字符串。')
  if (!contract.requireText && contract.allowArtifactRefs && !hasArtifactRefs) {
    throw new OutputContractError('Graph Node 输出缺少 artifactRefs。')
  }
  if (hasArtifactRefs && !Array.isArray(structured.artifactRefs)) throw new OutputContractError('Graph Node 输出的 artifactRefs 必须是数组。')
  const text = String(structured.text || '').trim()
  if (text.length > 40000) throw new OutputContractError('Graph Node 输出的 text 超过 40000 字符。')
  const artifactRefs = validateArtifactRefs(structured.artifactRefs || [], options)
  if (contract.requireText && !contract.allowEmptyText && !text) throw new OutputContractError('Graph Node 输出的 text 不能为空。')
  if (!contract.allowArtifactRefs && artifactRefs.length) throw new OutputContractError('该节点输出契约不允许 artifactRefs。')
  return { text, artifactRefs }
}

export function classifyExecutionError(error) {
  const code = String(error?.code || '').toUpperCase()
  const category = String(error?.category || '').toLowerCase()
  if (code === 'ABORT_ERR' || code === 'ABORTED' || category === 'cancelled' || error?.name === 'AbortError') return { category: 'cancelled', retryable: false }
  if (category === 'transport' || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'NETWORK_ERROR', 'FETCH_ERROR'].includes(code)) return { category: 'transport', retryable: true }
  if (category === 'rate-limit' || code === 'RATE_LIMIT' || code === 'HTTP_429' || code === '429') return { category: 'rate-limit', retryable: true }
  if (category === 'output' || code === 'OUTPUT_CONTRACT_INVALID') return { category: 'output', retryable: false }
  if (category === 'capability' || code === 'CAPABILITY_MISMATCH') return { category: 'capability', retryable: false }
  if (category === 'permission' || code === 'PERMISSION_DENIED' || code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED') return { category: 'permission', retryable: false }
  return { category: category || 'fatal', retryable: false }
}

export function buildNodePrompt({ graph, node, profile, predecessorResults = [] } = {}) {
  const inputs = predecessorResults.map((item) => ({
    nodeId: item.nodeId,
    text: String(item.result?.text || '').slice(0, 12000),
    artifactRefs: Array.isArray(item.result?.artifactRefs) ? item.result.artifactRefs : []
  }))
  return [
    '你正在执行 Graph Job 的一个独立节点。你不是 Planner，不得创建或运行新的 Graph Job。',
    `Graph goal：${String(graph?.goal || '').trim()}`,
    `当前节点：${node.id} / ${node.title}`,
    `访问模式：${node.access}。遵守当前 Agent Profile 的工具、权限和工作区范围。`,
    profile?.executor === 'codex'
      ? `权限模式：${String(profile?.permissionMode || 'default')}；审批和 sandbox 由 Codex 原生 Profile 控制。`
      : `权限模式：${String(profile?.permissionMode || 'default')}；delegated child 的有效审批策略为 never，sandbox 继承主对话。`,
    `节点任务：${node.instruction}`,
    inputs.length ? `直接前置节点的已完成输出：${JSON.stringify(inputs)}` : '没有前置节点输出。',
    '最终只能输出 JSON object：{"text":"...","artifactRefs":[{"path":"workspace-relative/path","type":"file","summary":"..."}]}；没有产物时可省略 artifactRefs。',
    '不要输出 reasoning、thinking、stderr、原始工具协议、工具调用记录或 Markdown fence。artifactRefs 只能引用当前 session cwd 内的路径。'
  ].join('\n\n')
}

export function buildToolFilter(profile, availableTools = [], options = {}) {
  const known = [...new Set((Array.isArray(availableTools) ? availableTools : []).map((item) => String(item || '').trim()).filter(Boolean))]
  const allowed = new Set((profile?.capabilities?.tools || []).map((item) => String(item || '').trim()).filter(Boolean))
  const deniedNames = new Set(['graphjob_plan', 'graphjob_run', 'graphjob_patch', 'graph_job', 'graph-job-orchestrator'])
  const isGraphJobTool = (name) => /^graph[_-]?job/i.test(name) || /graph-job-orchestrator/i.test(name) || name === '/graphjob'
  if (options.allowSkillTool !== true || !(profile?.capabilities?.skills || []).length) deniedNames.add('skill')
  else allowed.add('skill')
  if (Array.isArray(options.deniedTools)) for (const item of options.deniedTools) deniedNames.add(String(item))
  if (!known.length) return null
  if (allowed.size) {
    const allow = known.filter((name) => allowed.has(name) && !deniedNames.has(name) && !isGraphJobTool(name))
    const deny = known.filter((name) => !allowed.has(name) || deniedNames.has(name) || isGraphJobTool(name))
    return { allow, deny }
  }
  return { deny: known }
}

function abortPromise(signal) {
  if (!signal) return null
  if (signal.aborted) return Promise.reject(new GraphExecutorError('节点已取消。', 'ABORTED', 'cancelled'))
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new GraphExecutorError('节点已取消。', 'ABORTED', 'cancelled')), { once: true })
  })
}

function parentHeader(parentAgent) {
  return parentAgent?.session?.header || {}
}

function sessionOutput(agent) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const message = event.data?.message
    if (message) return message.content || message.text || message
  }
  return null
}

function userMessage(text, id) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: '@p-dsh-market/graph-job-orchestrator', form: 'node' }
  }
}

async function disposeHandle(handle) {
  try { await handle?.dispose?.() } catch { /* disposing a finished child is best effort */ }
}

export class DshInProcessExecutor {
  constructor(options = {}) {
    this.services = options.services || {}
    this.capabilityCatalog = options.capabilityCatalog || {}
    this.cwd = options.cwd || process.cwd()
    this.skillScopeAvailable = options.skillScopeAvailable === true
  }

  async runNode(request) {
    const profile = request.profile
    if (profile.capabilities.skills.length && !this.skillScopeAvailable) {
      throw new CapabilityMismatchError('当前 DSH runtime 没有可证明的 scoped Skill 过滤能力；为防止插件 Skill 泄漏，本节点拒绝执行。')
    }
    const providerName = profile.subagentProvider || this.capabilityCatalog.executors?.dsh?.provider || 'spawn'
    if (this.services.subagents?.start && request.parentAgent) {
      return this.runWithSubagent(request, providerName)
    }
    if (this.services.agents?.create) return this.runWithAgent(request)
    throw new CapabilityMismatchError('当前 runtime 没有可用的 DSH in-process Agent executor。')
  }

  async runWithSubagent(request, providerName) {
    const { graph, node, profile, predecessorResults, signal, parentAgent, attempt } = request
    resolveChildPermission(profile)
    if (profile.capabilities.skills.length && !this.skillScopeAvailable) {
      throw new CapabilityMismatchError('当前 DSH Subagent provider 未声明 scoped Skill 过滤能力；为防止插件 Skill 泄漏，本节点拒绝执行。')
    }
    const toolFilter = buildToolFilter(profile, this.capabilityCatalog.tools || [], { allowSkillTool: this.skillScopeAvailable })
    const prompt = buildNodePrompt({ graph, node, profile, predecessorResults })
    const subagentRequest = {
      label: `graph-job:${graph.graphId}:${node.id}:attempt-${attempt}`,
      prompt: [{ type: 'text', text: prompt }],
      parent: parentAgent,
      signal,
      maxDepth: graph.limits.maxDepth,
      persona: profile.persona || undefined,
      agentOptions: {
        provider: profile.provider,
        model: profile.model,
        maxTokens: profile.maxOutputTokens
      }
    }
    if (toolFilter) subagentRequest.toolFilter = toolFilter
    const descriptor = this.capabilityCatalog.subagentProviders?.find((item) => item.name === providerName)
    if (descriptor?.capabilities?.outputSchema === true) subagentRequest.outputSchema = NODE_OUTPUT_SCHEMA
    if (profile.capabilities.skills.length) subagentRequest.skillFilter = [...profile.capabilities.skills]
    const run = await this.services.subagents.start.call(this.services.subagents, providerName, subagentRequest)
    const childSessionId = childSessionIdFromRun(run)
    try {
      if (!run || typeof run.result?.then !== 'function') throw new GraphExecutorError('Subagent start 返回了缺少 result 的 payload。', 'MISSING_SUBAGENT_PAYLOAD', 'fatal')
      const result = await Promise.race([run.result, abortPromise(signal)].filter(Boolean))
      return executionEnvelope(normalizeSubagentResult(result, { cwd: request.cwd || this.cwd, contract: node.outputContract }), childSessionId)
    } catch (error) {
      if (childSessionId && error && typeof error === 'object' && !error.childSessionId) error.childSessionId = childSessionId
      throw error
    } finally {
      await run?.dispose?.()
    }
  }

  async runWithAgent(request) {
    const { graph, node, profile, predecessorResults, signal, parentAgent, attempt } = request
    const services = this.services
    const parent = parentAgent || null
    const header = parentHeader(parent)
    resolveChildPermission(profile)
    const toolFilter = buildToolFilter(profile, this.capabilityCatalog.tools || [], { allowSkillTool: this.skillScopeAvailable })
    const setup = async (agentCtx) => {
      if (parent?.ctx) services.agentPresets?.composeFrom?.(agentCtx, parent.ctx)
      else if (services.agentPresets?.mount) await services.agentPresets.mount(agentCtx)
      if (toolFilter) agentCtx?.tools?.restrict?.(toolFilter)
      if (profile.capabilities.skills.length) {
        if (!this.skillScopeAvailable || typeof agentCtx?.skills?.restrict !== 'function') {
          throw new CapabilityMismatchError('当前 DSH Agent context 未提供 scoped Skill 过滤能力；为防止插件 Skill 泄漏，本节点拒绝执行。')
        }
        await agentCtx.skills.restrict({ allow: [...profile.capabilities.skills] })
      }
      agentCtx?.systemPrompt?.section?.({
        name: 'graph-job:node-protocol',
        order: 0,
        text: 'Graph Job 节点执行器。不得调用 graphjob_* 工具或加载插件 Skill；最终只返回约定的 JSON 输出。'
      })
      if (profile.persona) agentCtx?.systemPrompt?.section?.({ name: 'graph-job:persona', order: 1, text: profile.persona })
    }
    const childSessionId = `graphjob-${graph.graphId}-${node.id}-${attempt}-${randomUUID().slice(0, 8)}`
    const meta = {
      origin: 'subagent',
      parentSession: header.id || graph.sessionId || '',
      cwd: request.cwd || header.cwd || this.cwd,
      graphJobId: graph.graphId,
      graphNodeId: node.id,
      delegationDepth: Number.isInteger(header.delegationDepth) ? header.delegationDepth + 1 : 1
    }
    const handle = await services.agents.create({
      sessionId: childSessionId,
      meta,
      agentOptions: { provider: profile.provider, model: profile.model, maxTokens: profile.maxOutputTokens },
      signal,
      setup
    })
    try {
      handle?.agent?.followup?.(userMessage(buildNodePrompt({ graph, node, profile, predecessorResults }), `graphjob-${randomUUID()}`))
      const idle = handle?.agent?.whenIdle?.() || Promise.resolve()
      await Promise.race([idle, abortPromise(signal)].filter(Boolean))
      if (signal?.aborted) throw new GraphExecutorError('节点已取消。', 'ABORTED', 'cancelled')
      return executionEnvelope(normalizeSubagentResult(sessionOutput(handle.agent), { cwd: request.cwd || header.cwd || this.cwd, contract: node.outputContract }), childSessionId)
    } finally {
      await disposeHandle(handle)
    }
  }
}

export class CodexExecutor {
  constructor(options = {}) {
    this.services = options.services || {}
    this.capabilityCatalog = options.capabilityCatalog || {}
    this.cwd = options.cwd || process.cwd()
  }

  async runNode(request) {
    const { profile, graph, node, predecessorResults, signal, parentAgent, attempt } = request
    if (!parentAgent) throw new CapabilityMismatchError('Codex executor 必须从当前主对话获得 parent Agent。')
    const start = this.services.subagents?.start
    if (typeof start !== 'function') throw new CapabilityMismatchError('当前 runtime 未注册 Codex Subagent provider。')
    const providerName = profile.provider || 'codex'
    const provider = this.services.subagents?.getProvider?.(providerName)
    if (!provider && this.capabilityCatalog.executors?.codex?.providers?.length && !this.capabilityCatalog.executors.codex.providers.includes(providerName)) {
      throw new CapabilityMismatchError(`Codex provider 不可用：${providerName}`)
    }
    const descriptor = this.capabilityCatalog.subagentProviders?.find((item) => item.name === providerName)
    const providerCapabilities = provider?.capabilities || descriptor?.capabilities || {}
    if (providerCapabilities.toolFilter !== true) throw new CapabilityMismatchError(`Codex provider ${providerName} 未明确支持安全 Tool allowlist。`)
    if (providerCapabilities.depthLimit !== true) throw new CapabilityMismatchError(`Codex provider ${providerName} 未明确支持 delegation depth 限制。`)
    if (profile.persona && providerCapabilities.persona !== true) throw new CapabilityMismatchError(`Codex provider ${providerName} 未明确支持 per-profile persona。`)
    if (profile.reasoningEffort && (!Array.isArray(providerCapabilities.reasoningEfforts) || !providerCapabilities.reasoningEfforts.includes(profile.reasoningEffort))) {
      throw new CapabilityMismatchError(`Codex provider ${providerName} 未明确支持 reasoningEffort=${profile.reasoningEffort}。`)
    }
    const permission = resolveCodexPermission(profile, providerCapabilities)
    const prompt = buildNodePrompt({ graph, node, profile, predecessorResults })
    const toolFilter = buildToolFilter(profile, this.capabilityCatalog.tools || [])
    const agentOptions = { model: profile.model, maxTokens: profile.maxOutputTokens }
    if (profile.reasoningEffort) agentOptions.reasoningEffort = profile.reasoningEffort
    const startRequest = {
      label: `graph-job:codex:${graph.graphId}:${node.id}:attempt-${attempt}`,
      prompt: [{ type: 'text', text: prompt }],
      parent: parentAgent,
      signal,
      maxDepth: graph.limits.maxDepth,
      persona: profile.persona || undefined,
      agentOptions
    }
    if (permission.passThrough) startRequest.permissionMode = permission.mode
    if (toolFilter) startRequest.toolFilter = toolFilter
    if (providerCapabilities.outputSchema) startRequest.outputSchema = NODE_OUTPUT_SCHEMA
    const run = await start.call(this.services.subagents, providerName, startRequest)
    const childSessionId = childSessionIdFromRun(run)
    try {
      if (!run || typeof run.result?.then !== 'function') throw new GraphExecutorError('Codex provider 返回了缺少 result 的 payload。', 'MISSING_SUBAGENT_PAYLOAD', 'fatal')
      const result = await Promise.race([run.result, abortPromise(signal)].filter(Boolean))
      return executionEnvelope(normalizeSubagentResult(result, { cwd: request.cwd || this.cwd, contract: node.outputContract }), childSessionId)
    } catch (error) {
      if (childSessionId && error && typeof error === 'object' && !error.childSessionId) error.childSessionId = childSessionId
      throw error
    } finally {
      await run?.dispose?.()
    }
  }
}

export function createExecutorMap(options = {}) {
  return {
    dsh: options.dshExecutor || new DshInProcessExecutor(options),
    codex: options.codexExecutor || new CodexExecutor(options)
  }
}
