import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { GraphJobOrchestrator } from './orchestrator.js'
import { buildPlannerContext } from './planner.js'
import { jsonResponse, messageOf, methodOf, parseUrl, readJson, sseWrite, writeError } from './protocol.js'

export const PLUGIN_ID = '@p-dsh-market/graph-job-orchestrator'
export const BASE_PATH = '/graph-job-orchestrator'
export const PLAN_TOOL_NAME = 'graphjob_plan'

const SKILL_PATH = fileURLToPath(new URL('../skills/graph-job-orchestrator/SKILL.md', import.meta.url))
const MAX_SSE_CLIENTS = 32

function service(ctx, name) {
  return ctx?.get?.(name) ?? ctx?.[name]
}

function registerEffect(ctx, register, value) {
  if (typeof register?.register !== 'function') return
  ctx.effect?.(() => register.register(value))
}

function pathSegments(req, prefix) {
  const pathname = parseUrl(req).pathname
  if (!pathname.startsWith(prefix)) return null
  const suffix = pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
  return suffix ? suffix.split('/').map((item) => decodeURIComponent(item)) : []
}

function sessionIdFrom(req, body = {}) {
  return String(body.sessionId || parseUrl(req).searchParams.get('sessionId') || '').trim()
}

function requestCwd(req, body, orchestrator, sessionId) {
  return orchestrator.resolveSessionCwd(sessionId) || String(body.cwd || parseUrl(req).searchParams.get('cwd') || '').trim() || process.cwd()
}

function commandDefinition(orchestrator) {
  return {
    name: 'graphjob',
    description: '打开并编辑当前会话的 Graph Job 多 Subagent 任务图。只创建/编辑任务图，不会自动运行。',
    input: { hint: '可选：任务图目标' },
    async handler(invocation) {
      const agent = invocation?.agent
      const sessionId = String(agent?.session?.header?.id || '').trim()
      if (!sessionId) return { kind: 'error', text: '/graphjob 只能从正在运行的 DSH 主对话调用。' }
      if (agent?.session?.header?.origin === 'subagent') return { kind: 'error', text: 'Graph Job 不能从 Subagent 递归创建。' }
      const goal = String(invocation?.rawInput || '').trim() || '请在任务图编辑器中补充目标。'
      const existing = orchestrator.graphForSession(sessionId)
      if (!existing) {
        orchestrator.saveManualGraph({
          sessionId,
          goal,
          agentProfiles: orchestrator.getProfiles(),
          nodes: [],
          edges: [],
          allowEmpty: true,
          cwd: agent.session.header.cwd
        })
      }
      return { kind: 'success', text: 'Graph Job 已创建。请打开任务图面板补充节点，完成预览和确认后再运行。' }
    }
  }
}

const planOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['previewId', 'confirmationRequired', 'summary', 'validation'],
  properties: {
    previewId: { type: 'string' },
    confirmationRequired: { type: 'boolean' },
    confirmationToken: { type: 'string' },
    summary: { type: 'object' },
    validation: { type: 'object' },
    templateDecision: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['saveAs', 'overwrite'] },
        templateId: { type: 'string' },
        scope: { enum: ['global', 'workspace'] }
      }
    }
  }
}

function planTool(orchestrator) {
  return {
    name: PLAN_TOOL_NAME,
    description: '将当前用户目标整理成受限 Graph Job 草案并返回静态预览。只能提出 Graph JSON/patch，不能启动运行；运行必须由用户在任务图界面确认。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: '用户明确提出的任务图目标。' },
        draft: { type: 'object', description: '符合 Graph Draft Schema 的任务图；只能引用 capability snapshot 中的 Agent Profile。' },
        patch: { type: 'object', description: '针对当前 Graph 的受限 patch；不允许 replace 或任意代码。' },
        baseGraph: { type: 'object', description: '可选的当前 Graph 快照。通常应使用当前会话绑定的 Graph。' },
        templateMode: { enum: ['saveAs', 'overwrite'], description: '修改手工 Graph 时必须由用户选择模板另存或覆盖。' },
        templateId: { type: 'string', description: 'templateMode=overwrite 时的目标模板 id。' },
        templateName: { type: 'string', description: '候选模板名称。' },
        templateScope: { enum: ['global', 'workspace'], description: '模板作用域，默认 workspace。' },
        templateDescription: { type: 'string', description: '候选模板说明。' }
      }
    },
    output: {
      schema: planOutputSchema,
      render: (_args, value) => [{ type: 'text', text: `Graph Job 草案已生成，等待用户预览确认。\n${JSON.stringify(value.summary)}` }]
    },
    presentCall(args) {
      return { card: 'generic', kind: 'graph-job-plan', title: '生成 Graph Job 任务图', rawInput: JSON.stringify({ goal: args?.goal || '' }) }
    },
    presentResult(_args, result) {
      if (result?.isError) return undefined
      return { card: 'generic', kind: 'graph-job-plan', title: 'Graph Job 草案待确认' }
    },
    async execute(args, exec) {
      const parentAgent = exec?.agent
      const header = parentAgent?.session?.header
      if (!parentAgent || !header?.id) throw new Error(`${PLAN_TOOL_NAME} 只能从正在运行的 DSH 主对话调用。`)
      if (header.origin === 'subagent') throw new Error('Subagent 不能递归调用 Graph Job Planner。')
      const preview = await orchestrator.previewPlanner({
        ...args,
        sessionId: header.id,
        cwd: header.cwd,
        parentAgent
      })
      return {
        previewId: preview.previewId,
        confirmationRequired: true,
        confirmationToken: preview.confirmationToken || undefined,
        summary: preview.summary,
        validation: preview.validation,
        templateDecision: preview.templateDecision
      }
    }
  }
}

function registerPlannerPromptHook(ctx, orchestrator) {
  if (typeof ctx.on !== 'function') return
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const header = context?.agent?.session?.header || {}
    const nested = header.origin === 'subagent' || header.graphJobId || header.meta?.graphJobId
    if (!header.id || nested) return assembly
    const cwd = String(header.cwd || '').trim() || process.cwd()
    let capabilitySnapshot = {}
    try { capabilitySnapshot = await orchestrator.capabilities({ cwd }) } catch { /* capability errors stay visible at the preview boundary */ }
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
    return {
      ...assembly,
      sections: [
        ...sections.filter((section) => section?.name !== 'graph-job-orchestrator:planner-roster'),
        { name: 'graph-job-orchestrator:planner-roster', text: buildPlannerContext({ roster: orchestrator.getProfiles(), capabilitySnapshot }) }
      ]
    }
  })
}

async function handleEvents(req, res, runId, orchestrator, clients) {
  const run = orchestrator.getRun(runId)
  if (!run) return jsonResponse(res, 404, { ok: false, error: 'Run 不存在。' })
  let count = 0
  for (const set of clients.values()) count += set.size
  if (count >= MAX_SSE_CLIENTS) return jsonResponse(res, 429, { ok: false, error: '实时订阅数量已达上限。' })
  const since = Number(parseUrl(req).searchParams.get('since') || 0)
  res.writeHead?.(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  const set = clients.get(runId) || new Set()
  const client = { closed: false, timer: null, close: () => {} }
  let unsubscribe = () => {}
  client.close = () => {
    if (client.closed) return
    client.closed = true
    clearInterval(client.timer)
    unsubscribe()
    set.delete(client)
    if (!set.size) clients.delete(runId)
    try { res.end?.() } catch { /* response already closed */ }
  }
  set.add(client)
  clients.set(runId, set)
  unsubscribe = orchestrator.subscribe(runId, (event, snapshot) => {
    if (event.id <= since || client.closed) return
    try { sseWrite(res, 'update', { event, run: snapshot }, event.id) } catch { client.close() }
  }, since)
  sseWrite(res, 'snapshot', { run: orchestrator.getRun(runId) }, Number(run.nextEventId || 1) - 1)
  client.timer = setInterval(() => {
    if (!client.closed) {
      try { res.write(': ping\n\n') } catch { client.close() }
    }
  }, 15000)
  req.on?.('close', () => client.close())
  res.on?.('close', () => client.close())
}

async function handleGraphRoutes(req, res, orchestrator) {
  const segments = pathSegments(req, `${BASE_PATH}/graphs`)
  if (!segments) return false
  const method = methodOf(req)
  const body = method === 'GET' ? {} : await readJson(req)
  const sessionId = sessionIdFrom(req, body)
  const [graphId, action] = segments
  if (!graphId) {
    if (method === 'GET') return jsonResponse(res, 200, { ok: true, ...orchestrator.listGraphs(sessionId) })
    if (method === 'POST') {
      if (body.mode === 'save') return jsonResponse(res, 200, { ok: true, ...orchestrator.saveManualGraph(body) })
      const preview = await orchestrator.preview({ ...body, sessionId, cwd: requestCwd(req, body, orchestrator, sessionId) })
      return jsonResponse(res, 200, { ok: true, ...preview })
    }
    return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/POST。' })
  }
  if (action === 'events') return false
  if (action === 'preview' && segments[2] && method === 'GET') {
    const preview = orchestrator.getPreview(segments[2])
    if (!preview || preview.graph?.graphId !== graphId) return jsonResponse(res, 404, { ok: false, error: 'Preview 不存在或已过期。' })
    return jsonResponse(res, 200, { ok: true, preview })
  }
  if (method === 'GET' && !action) {
    const graph = orchestrator.getGraph(graphId)
    if (!graph) return jsonResponse(res, 404, { ok: false, error: 'Graph 不存在。' })
    return jsonResponse(res, 200, { ok: true, graph, binding: orchestrator.getBinding(sessionId) })
  }
  if (method === 'PATCH' && !action) {
    const result = orchestrator.saveManualGraph({ ...body, sessionId, graph: { ...(body.graph || body), graphId } })
    return jsonResponse(res, 200, { ok: true, ...result })
  }
  if (method !== 'POST') return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/PATCH/POST。' })
  if (action === 'preview') {
    const preview = await orchestrator.preview({ ...body, graphId, sessionId, cwd: requestCwd(req, body, orchestrator, sessionId) })
    return jsonResponse(res, 200, { ok: true, ...preview })
  }
  if (action === 'confirm') return jsonResponse(res, 200, { ok: true, ...orchestrator.confirmPreview({ token: body.confirmationToken || body.token, sessionId }) })
  if (action === 'run') return jsonResponse(res, 202, { ok: true, run: await orchestrator.startRun({ ...body, graphId, sessionId, cwd: requestCwd(req, body, orchestrator, sessionId) }) })
  if (action === 'retry') return jsonResponse(res, 202, { ok: true, run: await orchestrator.retryRun(body.runId || graphId) })
  if (action === 'cancel') return jsonResponse(res, 200, { ok: true, run: await orchestrator.cancelRun(body.runId || graphId) })
  if (action === 'terminate') return jsonResponse(res, 200, { ok: true, run: await orchestrator.terminateRun(body.runId || graphId) })
  return jsonResponse(res, 404, { ok: false, error: 'Graph action 不存在。' })
}

async function handleRunRoutes(req, res, orchestrator, clients) {
  const segments = pathSegments(req, `${BASE_PATH}/runs`)
  if (!segments) return false
  const [runId, action] = segments
  if (!runId) return jsonResponse(res, 400, { ok: false, error: '缺少 runId。' })
  if (action === 'events') return handleEvents(req, res, runId, orchestrator, clients)
  if (methodOf(req) === 'GET') {
    const run = orchestrator.getRun(runId)
    return run ? jsonResponse(res, 200, { ok: true, run }) : jsonResponse(res, 404, { ok: false, error: 'Run 不存在。' })
  }
  const body = await readJson(req)
  if (methodOf(req) !== 'POST') return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/POST。' })
  if (action === 'retry') return jsonResponse(res, 202, { ok: true, run: await orchestrator.retryRun(runId) })
  if (action === 'cancel') return jsonResponse(res, 200, { ok: true, run: await orchestrator.cancelRun(runId) })
  if (action === 'terminate') return jsonResponse(res, 200, { ok: true, run: await orchestrator.terminateRun(runId) })
  return jsonResponse(res, 404, { ok: false, error: 'Run action 不存在。' })
}

async function handleTemplateRoutes(req, res, orchestrator) {
  const segments = pathSegments(req, `${BASE_PATH}/templates`)
  if (!segments) return false
  const method = methodOf(req)
  const query = parseUrl(req).searchParams
  const querySessionId = String(query.get('sessionId') || '').trim()
  const listCwd = orchestrator.resolveSessionCwd(querySessionId) || String(query.get('cwd') || '').trim() || process.cwd()
  if (!segments.length && method === 'GET') return jsonResponse(res, 200, { ok: true, templates: orchestrator.listTemplates({ cwd: listCwd, workspaceId: query.get('workspaceId') || '', filterVisible: true }) })
  const body = method === 'GET' ? {} : await readJson(req)
  if (segments[0] === 'previews' && segments[1] && method === 'GET') {
    const preview = orchestrator.getTemplatePreview(segments[1])
    return preview ? jsonResponse(res, 200, { ok: true, preview }) : jsonResponse(res, 404, { ok: false, error: 'Template preview 不存在或已过期。' })
  }
  if (segments[0] === 'preview' && method === 'POST') return jsonResponse(res, 200, { ok: true, preview: await orchestrator.previewTemplate(body) })
  if (segments[0] === 'confirm' && method === 'POST') return jsonResponse(res, 200, { ok: true, template: orchestrator.confirmTemplate({ token: body.confirmationToken || body.token, sessionId: body.sessionId }) })
  if (!segments.length && method === 'POST') return jsonResponse(res, 200, { ok: true, preview: await orchestrator.previewTemplate(body) })
  if (segments[1] === 'bind' && method === 'POST') return jsonResponse(res, 200, { ok: true, graph: orchestrator.bindTemplate({ ...body, templateId: segments[0], cwd: body.cwd || listCwd }) })
  return jsonResponse(res, 404, { ok: false, error: 'Template route 不存在。' })
}

export function createHost(options = {}) {
  const host = {
    inject: ['agentDefaultModel', 'agentPresets', 'agents', 'commands', 'llm', 'sessions', 'skills', 'subagents', 'systemPrompt', 'tools', 'webServer'],

    apply(ctx) {
      const services = {
        agentDefaultModel: options.agentDefaultModel || service(ctx, 'agentDefaultModel'),
        agentPresets: options.agentPresets || service(ctx, 'agentPresets'),
        agents: options.agents || service(ctx, 'agents'),
        commands: options.commands || service(ctx, 'commands'),
        llm: options.llm || service(ctx, 'llm'),
        sessionQuery: options.sessionQuery || service(ctx, 'sessionQuery'),
        sessions: options.sessions || service(ctx, 'sessions'),
        skills: options.skills || service(ctx, 'skills'),
        subagents: options.subagents || service(ctx, 'subagents'),
        tools: options.tools || service(ctx, 'tools'),
        webServer: options.webServer || service(ctx, 'webServer')
      }
      const orchestrator = options.orchestrator || new GraphJobOrchestrator({
        services,
        storageRoot: options.storageRoot,
        env: options.env || process.env,
        now: options.now,
        idFactory: options.idFactory,
        runtimeVersion: options.runtimeVersion,
        skillScopeAvailable: options.skillScopeAvailable
      })
      orchestrator.services = services
      orchestrator.initialize()
      host.orchestrator = orchestrator
      const clients = new Map()

      registerPlannerPromptHook(ctx, orchestrator)
      registerEffect(ctx, services.commands, commandDefinition(orchestrator))
      registerEffect(ctx, services.skills, {
        name: 'graph-job-orchestrator',
        description: '规划和运行经过用户确认的 Graph Job 多 Subagent 任务图。',
        whenToUse: '用户明确要求把复杂任务拆成多个并行/串行子任务、编排 Subagent 或使用任务图时。',
        source: 'runtime',
        provider: PLUGIN_ID,
        metadata: { plugin: PLUGIN_ID, group: 'market' },
        content: readFileSync(SKILL_PATH, 'utf8'),
        resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skills/graph-job-orchestrator/', import.meta.url)) }
      })
      registerEffect(ctx, services.tools, planTool(orchestrator))

      registerEffect(ctx, services.webServer, {
        kind: 'exact',
        path: `${BASE_PATH}/health`,
        handler: async (_req, res) => jsonResponse(res, 200, {
          ok: true,
          pluginId: PLUGIN_ID,
          runtimeVersion: options.runtimeVersion || process.env.DSH_RUNTIME_VERSION || 'unknown',
          dshExecutorAvailable: typeof services.agents?.create === 'function' || typeof services.subagents?.start === 'function',
          codexProviderAvailable: Boolean((await orchestrator.capabilities({ cwd: process.cwd() })).executors?.codex?.available),
          activeRuns: [...orchestrator.schedulers.values()].filter((item) => ['created', 'running', 'paused'].includes(item.state.status)).length,
          storageRoot: orchestrator.storage.root
        })
      })
      registerEffect(ctx, services.webServer, {
        kind: 'exact',
        path: `${BASE_PATH}/capabilities`,
        handler: async (req, res) => {
          const cwd = String(parseUrl(req).searchParams.get('cwd') || '').trim() || process.cwd()
          return jsonResponse(res, 200, { ok: true, capabilities: await orchestrator.capabilities({ cwd, refresh: parseUrl(req).searchParams.get('refresh') === '1' }) })
        }
      })
      registerEffect(ctx, services.webServer, {
        kind: 'exact',
        path: `${BASE_PATH}/profiles`,
        handler: async (req, res) => {
          if (methodOf(req) === 'GET') return jsonResponse(res, 200, { ok: true, profiles: orchestrator.getProfiles() })
          if (methodOf(req) !== 'PUT') return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/PUT。' })
          const body = await readJson(req)
          const capabilities = await orchestrator.capabilities({ cwd: process.cwd(), refresh: true })
          return jsonResponse(res, 200, { ok: true, profiles: orchestrator.setProfiles(body.profiles || body, { capabilities, cwd: process.cwd() }) })
        }
      })
      registerEffect(ctx, services.webServer, {
        kind: 'prefix',
        path: `${BASE_PATH}/graphs`,
        handler: async (req, res) => {
          try {
            const result = await handleGraphRoutes(req, res, orchestrator)
            if (result === false) return jsonResponse(res, 404, { ok: false, error: 'Not found' })
          } catch (error) {
            const status = error?.code === 'ACTIVE_RUN_EXISTS' || error?.code === 'GRAPH_RUN_ACTIVE' || error?.code === 'GRAPH_MANUAL_LOCK' || error?.code === 'GRAPH_REVISION_CONFLICT' ? 409 : ['CONFIRMATION_REQUIRED', 'TEMPLATE_DECISION_REQUIRED'].includes(error?.code) ? 412 : 400
            return writeError(res, status, error)
          }
        }
      })
      registerEffect(ctx, services.webServer, {
        kind: 'prefix',
        path: `${BASE_PATH}/runs`,
        handler: async (req, res) => {
          try {
            const result = await handleRunRoutes(req, res, orchestrator, clients)
            if (result === false) return jsonResponse(res, 404, { ok: false, error: 'Not found' })
          } catch (error) {
            return writeError(res, ['RUN_NOT_LIVE', 'RUN_NOT_ACTIVE'].includes(error?.code) ? 409 : 400, error)
          }
        }
      })
      registerEffect(ctx, services.webServer, {
        kind: 'prefix',
        path: `${BASE_PATH}/templates`,
        handler: async (req, res) => {
          try { return await handleTemplateRoutes(req, res, orchestrator) } catch (error) {
            const status = ['ACTIVE_RUN_EXISTS', 'GRAPH_RUN_ACTIVE', 'GRAPH_REVISION_CONFLICT'].includes(error?.code) ? 409 : ['CONFIRMATION_REQUIRED', 'TEMPLATE_DECISION_REQUIRED'].includes(error?.code) ? 412 : 400
            return writeError(res, status, error)
          }
        }
      })

      ctx.effect?.(() => () => {
        for (const set of clients.values()) for (const client of set) client.close()
        clients.clear()
        orchestrator.dispose()
      })
    }
  }
  host.pluginId = PLUGIN_ID
  return host
}

const host = createHost()
export default host
