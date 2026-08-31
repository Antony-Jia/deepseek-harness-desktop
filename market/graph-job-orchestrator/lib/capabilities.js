import { GRAPH_SCHEMA_VERSION } from './graph-schema.js'

async function callService(service, method, ...args) {
  const fn = service?.[method]
  if (typeof fn !== 'function') return undefined
  try {
    return await fn.call(service, ...args)
  } catch {
    return undefined
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.providers)) return value.providers
  if (Array.isArray(value?.models)) return value.models
  if (Array.isArray(value?.skills)) return value.skills
  return []
}

function stringArray(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []
}

function providerOf(item) {
  return String(item?.provider || item?.providerName || item?.sourceProvider || '').trim()
}

export function isPluginSkill(candidate = {}) {
  return Boolean(
    candidate.metadata?.plugin ||
    candidate.plugin ||
    candidate.metadata?.group === 'market' ||
    providerOf(candidate) === 'desktop-skills' ||
    /^@p-dsh-market\//i.test(providerOf(candidate)) ||
    /graph-job-orchestrator/i.test(providerOf(candidate)) ||
    ['plugin', 'market', 'desktop-plugin'].includes(String(candidate.source || '').toLowerCase())
  )
}

export function normalizeSkillCandidate(candidate = {}) {
  if (typeof candidate === 'string') candidate = { name: candidate }
  const plugin = isPluginSkill(candidate)
  const source = String(candidate.source || '').trim()
  const provider = providerOf(candidate)
  let origin = 'unknown'
  if (plugin) origin = 'plugin'
  else if (['runtime', 'builtin', 'user', 'workspace', 'local', 'project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'bundled'].includes(source.toLowerCase())) {
    const normalizedSource = source.toLowerCase()
    if (['local', 'project-dsh', 'project-agents'].includes(normalizedSource)) origin = 'workspace'
    else if (['user-dsh', 'user-agents'].includes(normalizedSource)) origin = 'user'
    else if (normalizedSource === 'bundled') origin = 'runtime'
    else origin = normalizedSource
  }
  else if (provider === 'runtime' || provider === 'builtin') origin = provider
  const name = String(candidate.name || candidate.id || '').trim()
  return {
    name,
    description: String(candidate.description || '').trim(),
    source,
    provider,
    origin,
    allowed: origin !== 'plugin' && origin !== 'unknown',
    metadata: candidate.metadata && typeof candidate.metadata === 'object' ? { ...candidate.metadata } : undefined,
    locator: candidate.locator || undefined,
    path: candidate.path || undefined
  }
}

export function filterSkills(candidates, allowlist = []) {
  const allowedNames = new Set(stringArray(allowlist))
  const normalized = (Array.isArray(candidates) ? candidates : []).map(normalizeSkillCandidate).filter((item) => item.name)
  const allowed = normalized.filter((item) => allowedNames.has(item.name) && item.allowed)
  const denied = normalized.filter((item) => !allowedNames.has(item.name) || !item.allowed)
  return { allowed, denied }
}

function normalizeToolName(item) {
  if (typeof item === 'string') return item.trim()
  return String(item?.name || item?.id || item?.key || '').trim()
}

async function listTools(tools) {
  const values = await callService(tools, 'schemas') ?? await callService(tools, 'list') ?? await callService(tools, 'getAll')
  return [...new Set(asArray(values).map(normalizeToolName).filter(Boolean))].sort()
}

async function listSkills(skills, cwd) {
  // dsh-skill accepts an optional cwd and defaults to the union of its
  // registered layers. Do not invent a scope key here: the runtime's scope
  // type is intentionally not the string "all".
  const values = await callService(skills, 'list', { cwd }) ?? await callService(skills, 'list')
  return asArray(values).map(normalizeSkillCandidate).filter((item) => item.name)
}

function providerCapabilities(item) {
  const value = item?.capabilities || item?.capability || {}
  return {
    outputSchema: Boolean(value.outputSchema),
    depthLimit: Boolean(value.depthLimit),
    toolFilter: Boolean(value.toolFilter),
    skillFilter: Boolean(value.skillFilter),
    persona: Boolean(value.persona),
    permissionMode: Boolean(value.permissionMode || value.permissionModes),
    permissionModes: stringArray(value.permissionModes),
    reasoningEfforts: stringArray(value.reasoningEfforts || value.reasoningEffort)
  }
}

function normalizeProvider(item) {
  if (typeof item === 'string') return { name: item, capabilities: {} }
  return {
    name: String(item?.name || item?.id || item?.providerName || '').trim(),
    inheritsParentContext: item?.inheritsParentContext === true,
    models: asArray(item?.models || item?.capabilities?.models).map((model) => typeof model === 'string' ? model : String(model?.id || model?.name || '').trim()).filter(Boolean),
    capabilities: providerCapabilities(item)
  }
}

async function listSubagentProviders(subagents) {
  const values = asArray(await callService(subagents, 'list'))
  const result = []
  for (const item of values) {
    const name = typeof item === 'string' ? item.trim() : String(item?.name || item?.id || item?.providerName || '').trim()
    if (!name) continue
    const descriptor = typeof item === 'object' ? item : await callService(subagents, 'getProvider', name)
    result.push(normalizeProvider({ ...(descriptor || {}), name }))
  }
  return result
}

function extractReasoningEfforts(value) {
  if (!value || typeof value !== 'object') return []
  return stringArray(value.reasoningEfforts || value.reasoningEffort || value.capabilities?.reasoningEfforts || value.capabilities?.reasoningEffort)
}

async function discoverModels(llm) {
  const providers = asArray(await callService(llm, 'listProviders'))
  const result = []
  for (const providerEntry of providers) {
    const provider = typeof providerEntry === 'string' ? providerEntry : String(providerEntry?.name || providerEntry?.id || '').trim()
    if (!provider) continue
    const models = asArray(await callService(llm, 'listModels', provider))
    for (const modelEntry of models) {
      const model = typeof modelEntry === 'string' ? modelEntry : String(modelEntry?.id || modelEntry?.name || '').trim()
      if (model) result.push({ provider, model, reasoningEfforts: extractReasoningEfforts(modelEntry) })
    }
  }
  return result
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export async function buildCapabilityCatalog(options = {}) {
  const cwd = String(options.cwd || '').trim()
  const selection = await callService(options.agentDefaultModel, 'currentSelection') || {}
  const defaultModel = {
    provider: String(selection.provider || selection.providerName || '').trim(),
    model: String(selection.model || selection.modelName || '').trim(),
    reasoningEffort: String(selection.reasoningEffort || '').trim()
  }
  const subagentProviders = await listSubagentProviders(options.subagents)
  const skills = await listSkills(options.skills, cwd)
  const tools = await listTools(options.tools)
  const models = await discoverModels(options.llm)
  const codexProviders = subagentProviders.filter((item) => /codex/i.test(item.name))
  const codexReasoning = [...new Set(codexProviders.flatMap((item) => item.capabilities.reasoningEfforts))]
  const modelReasoning = models.flatMap((item) => item.reasoningEfforts)
  const reasoningEfforts = [...new Set([...codexReasoning, ...modelReasoning])]
  const catalog = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    capturedAt: Date.now(),
    runtimeVersion: String(options.runtimeVersion || process.env.DSH_RUNTIME_VERSION || 'unknown'),
    defaultModel,
    executors: {
      dsh: {
        available: typeof options.agents?.create === 'function' || subagentProviders.some((item) => item.name === 'spawn'),
        provider: subagentProviders.find((item) => item.name === 'spawn')?.name || 'spawn'
      },
      codex: {
        available: codexProviders.length > 0,
        providers: codexProviders.map((item) => item.name),
        reasoningEfforts
      }
    },
    subagentProviders,
    models,
    tools,
    skills,
    skillPolicy: {
      allowlist: 'explicit',
      pluginSkills: 'deny',
      unknownSource: 'deny',
      runtimeFallback: 'deny-all-when-scoped-filter-unavailable'
    },
    recursionGuard: {
      deniedTools: ['graphjob_plan', 'graphjob_run', 'graphjob_patch', 'graph_job'],
      deniedSkillOrigins: ['plugin', 'unknown']
    }
  }
  return deepFreeze(catalog)
}

export function profileSkillSelection(catalog, names = []) {
  const { allowed, denied } = filterSkills(catalog?.skills || [], names)
  return {
    names: allowed.map((item) => item.name).sort(),
    denied: denied.map((item) => ({ name: item.name, origin: item.origin, source: item.source }))
  }
}
