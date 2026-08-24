import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { KnowledgeGenerationOrchestrator } from './generation-orchestrator.js'
import { errorMessage, jsonResponse, loggerFacade, logMessage, methodOf, parseUrl, readJson, safeId, sseWrite, shortText } from './protocol.js'
import { listWorkspaceSessions, normalizeWorkspacePath, resolveAnchorSession } from './session-source.js'
import { WorkspaceRevisionError, WorkspaceStorage } from './workspace-storage.js'

const BASE_PATH = '/conversation-knowledge-map'
const PLUGIN_ID = '@p-dsh-market/conversation-knowledge-map'
const SKILL_PATH = fileURLToPath(new URL('../skills/conversation-knowledge-map/SKILL.md', import.meta.url))
const SKILL_DIR_PATH = fileURLToPath(new URL('../skills/conversation-knowledge-map/', import.meta.url))
const CONFIRMATION_TTL = 5 * 60 * 1000

function getService(ctx, name) {
  return ctx?.get?.(name) ?? ctx?.[name]
}

function registerEffect(ctx, service, value) {
  if (!service?.register) return
  const register = () => service.register(value)
  if (typeof ctx?.effect === 'function') ctx.effect(register)
  else register()
}

function writeError(res, error, status = 400) {
  return jsonResponse(res, status, { ok: false, error: errorMessage(error) })
}

function parsePath(req) {
  const pathname = parseUrl(req).pathname
  if (pathname === BASE_PATH || pathname === `${BASE_PATH}/`) return []
  if (!pathname.startsWith(`${BASE_PATH}/`)) return null
  return pathname.slice(`${BASE_PATH}/`.length).split('/').filter(Boolean).map((item) => decodeURIComponent(item))
}

function normalizeOutputMode(value) {
  const mode = String(value || 'both').trim()
  if (!['mind-map', 'knowledge-graph', 'both'].includes(mode)) throw new Error('生成内容必须是 mind-map、knowledge-graph 或 both。')
  return mode
}

function normalizeModelSelection(value) {
  if (value === undefined || value === null || value === '') return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型选择必须是包含 Provider 和 Model 的对象。')
  const provider = String(value.provider || '').trim()
  const model = String(value.model || '').trim()
  if (!provider && !model) return null
  if (!provider || !model) throw new Error('Provider 和 Model 必须同时填写。')
  if (provider.length > 160 || model.length > 240) throw new Error('Provider 或 Model 名称过长。')
  return { provider, model }
}

function currentModelSelection(service) {
  try {
    return normalizeModelSelection(service?.currentSelection?.())
  } catch {
    return null
  }
}

function normalizeGenerationInput(body = {}) {
  const selectedSessionIds = [...new Set((Array.isArray(body.selectedSessionIds) ? body.selectedSessionIds : []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (!selectedSessionIds.length) throw new Error('至少选择一个对话。')
  const prompt = String(body.prompt || '').trim()
  if (prompt.length > 4000) throw new Error('额外 Prompt 不能超过 4000 个字符。')
  const expectedRevision = Number(body.expectedRevision)
  const sourceMode = body.sourceMode === 'answer-only' ? 'answer-only' : 'conversation'
  return {
    anchorSessionId: safeId(body.anchorSessionId, '锚点 Session ID'),
    selectedSessionIds,
    outputMode: normalizeOutputMode(body.outputMode),
    sourceMode,
    prompt,
    strict: body.strict !== false,
    includeSubagents: body.includeSubagents === true,
    model: normalizeModelSelection(body.model),
    expectedRevision: Number.isInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : 0
  }
}

function canonicalPayload(value) {
  return JSON.stringify({
    anchorSessionId: value.anchorSessionId,
    cwd: normalizeWorkspacePath(value.cwd),
    selectedSessionIds: [...value.selectedSessionIds].map(String).sort(),
    outputMode: value.outputMode,
    sourceMode: value.sourceMode,
    prompt: value.prompt,
    strict: value.strict === true,
    includeSubagents: value.includeSubagents === true,
    model: value.model ? { provider: value.model.provider, model: value.model.model } : null,
    expectedRevision: Number(value.expectedRevision || 0)
  })
}

function statusForError(error) {
  if (error instanceof WorkspaceRevisionError) return 409
  if (/不存在|无效|不能为空|至少|不属于|没有|必须|不能|超出|缺少|已过期|确认/.test(errorMessage(error))) return 400
  return 409
}

export function createHost(options = {}) {
  const host = {
    inject: ['agentDefaultModel', 'agents', 'llm', 'sessionQuery', 'sessions', 'skills', 'webServer'],

    apply(ctx) {
      const sessionQuery = options.sessionQuery || getService(ctx, 'sessionQuery')
      const sessions = options.sessions || getService(ctx, 'sessions')
      const agents = options.agents || getService(ctx, 'agents')
      const agentDefaultModel = options.agentDefaultModel || getService(ctx, 'agentDefaultModel')
      const llm = options.llm || getService(ctx, 'llm')
      const skills = options.skills || getService(ctx, 'skills')
      const webServer = options.webServer || getService(ctx, 'webServer')
      const logger = loggerFacade(options.logger || getService(ctx, 'logger') || ctx?.logger || console)
      const storage = options.storage || new WorkspaceStorage(options.storageOptions)
      const sessionEventSource = options.sessionEventSource || (typeof ctx?.on === 'function' ? (listener) => ctx.on('session/event', listener) : null)
      const orchestrator = options.orchestrator || new KnowledgeGenerationOrchestrator({
        sessionQuery,
        sessions,
        agents,
        agentDefaultModel,
        storage,
        modelRunner: options.modelRunner,
        sessionEventSource,
        logger
      })
      const confirmations = new Map()
      const sseClients = new Set()
      logMessage(logger, 'info', 'host apply plugin=%s services sessionQuery=%s sessions=%s agents=%s llm=%s webServer=%s sessionEvents=%s', PLUGIN_ID, Boolean(sessionQuery), Boolean(sessions), Boolean(agents?.create), Boolean(llm), Boolean(webServer?.register), Boolean(sessionEventSource))

      async function contextFor(sessionId) {
        const anchor = await resolveAnchorSession({ sessionQuery, sessions }, sessionId)
        const header = anchor?.header || anchor?.session || null
        if (!header?.id) return { ready: false, state: 'no-session', sessionId: '', cwd: '' }
        const cwd = normalizeWorkspacePath(header.cwd)
        if (!cwd) return { ready: false, state: 'session-without-cwd', sessionId: String(header.id), cwd: '' }
        return { ready: true, state: 'ready', sessionId: String(header.id), cwd, origin: String(header.origin || '') }
      }

      async function modelCatalog() {
        const defaultModel = currentModelSelection(agentDefaultModel)
        const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
        const groups = (await Promise.all(providers.map(async (provider) => {
          const providerId = String(provider?.id || '').trim()
          if (!providerId || typeof llm?.listModels !== 'function') return null
          try {
            const models = await llm.listModels(providerId)
            const entries = (Array.isArray(models) ? models : []).map((item) => ({
              id: String(item?.id || '').trim(),
              name: String(item?.name || item?.id || '').trim()
            })).filter((item) => item.id)
            return entries.length ? {
              id: providerId,
              name: String(provider?.name || providerId).trim(),
              models: entries
            } : null
          } catch {
            return null
          }
        }))).filter(Boolean)
        if (defaultModel) {
          const group = groups.find((item) => item.id === defaultModel.provider)
          if (!group) groups.unshift({ id: defaultModel.provider, name: defaultModel.provider, models: [{ id: defaultModel.model, name: defaultModel.model }] })
          else if (!group.models.some((item) => item.id === defaultModel.model)) group.models.unshift({ id: defaultModel.model, name: defaultModel.model })
        }
        logMessage(logger, 'info', 'model catalog default=%s providers=%d groups=%d', defaultModel ? `${defaultModel.provider}/${defaultModel.model}` : 'none', providers.length, groups.length)
        return { default: defaultModel, groups }
      }

      async function sessionsFor(body) {
        const context = await contextFor(body.anchorSessionId)
        if (!context.ready) throw new Error('请先打开一个有明确工作路径的已有对话。')
        return { context, sessions: await listWorkspaceSessions({ sessionQuery, sessions }, context.cwd, context.sessionId, body.includeSubagents === true) }
      }

      async function confirmGeneration(body) {
        const input = normalizeGenerationInput(body)
        const { context, sessions: available } = await sessionsFor(input)
        const allowed = new Set(available.map((item) => item.id))
        for (const id of input.selectedSessionIds) if (!allowed.has(id)) throw new Error(`所选对话不属于当前工作路径或已不可用：${id}`)
        const state = await storage.readState(context.cwd)
        if (input.expectedRevision !== state.revision) throw new WorkspaceRevisionError(input.expectedRevision, state.revision)
        const model = input.model || currentModelSelection(agentDefaultModel)
        if (!model) throw new Error('当前没有可用的 Provider/Model，请先在模型设置中配置默认模型。')
        const payload = { ...input, model, anchorSessionId: context.sessionId, cwd: context.cwd, expectedRevision: state.revision }
        const token = randomUUID()
        confirmations.set(token, { payload, expiresAt: Date.now() + CONFIRMATION_TTL, used: false })
        logMessage(logger, 'info', 'generation confirmed cwd=%s anchorSession=%s selectedSessions=%d outputMode=%s sourceMode=%s strict=%s model=%s expectedRevision=%d', shortText(context.cwd, 180), shortText(context.sessionId, 96), input.selectedSessionIds.length, input.outputMode, input.sourceMode, input.strict, `${model.provider}/${model.model}`, state.revision)
        return {
          token,
          expiresAt: Date.now() + CONFIRMATION_TTL,
          revision: state.revision,
          context,
          selectedSessions: available.filter((item) => input.selectedSessionIds.includes(item.id)),
          outputMode: input.outputMode,
          sourceMode: input.sourceMode,
          strict: input.strict,
          model,
          promptSummary: shortText(input.prompt, 300),
          overwrite: state.exists
        }
      }

      function consumeConfirmation(token, body) {
        const value = confirmations.get(String(token || ''))
        if (!value || value.used || value.expiresAt < Date.now()) throw new Error('生成确认已过期，请返回配置重新确认。')
        const supplied = normalizeGenerationInput({ ...body, anchorSessionId: body.anchorSessionId || value.payload.anchorSessionId, selectedSessionIds: body.selectedSessionIds || value.payload.selectedSessionIds, outputMode: body.outputMode || value.payload.outputMode, sourceMode: body.sourceMode ?? value.payload.sourceMode, prompt: body.prompt ?? value.payload.prompt, strict: body.strict ?? value.payload.strict, includeSubagents: body.includeSubagents ?? value.payload.includeSubagents, model: body.model ?? value.payload.model, expectedRevision: body.expectedRevision ?? value.payload.expectedRevision })
        const expected = canonicalPayload(value.payload)
        const actual = canonicalPayload({ ...supplied, cwd: value.payload.cwd })
        if (expected !== actual) throw new Error('确认内容已变化，请返回配置重新确认。')
        value.used = true
        return { ...value.payload }
      }

      async function handleGeneration(req, res) {
        const path = parsePath(req)
        const method = methodOf(req)
        if (!path) return jsonResponse(res, 404, { ok: false, error: 'Not found' })
        const routeLabel = path.join('/') || '(root)'
        logMessage(logger, 'info', 'route start method=%s path=%s', method, routeLabel)
        try {
          if (path.length === 0 && method === 'GET') {
            return jsonResponse(res, 200, { ok: true, plugin: PLUGIN_ID })
          }
          if (path[0] === 'health' && method === 'GET') {
            return jsonResponse(res, 200, { ok: true, agentsAvailable: Boolean(agents?.create), sessionQueryAvailable: Boolean(sessionQuery), activeGenerations: sseClients.size })
          }
          if (path[0] === 'context' && method === 'GET') {
            const sessionId = parseUrl(req).searchParams.get('sessionId') || ''
            return jsonResponse(res, 200, { ok: true, context: await contextFor(sessionId) })
          }
          if (path[0] === 'models' && method === 'GET') {
            return jsonResponse(res, 200, { ok: true, catalog: await modelCatalog() })
          }
          if (path[0] === 'sessions' && method === 'GET') {
            const anchorSessionId = parseUrl(req).searchParams.get('anchorSessionId') || ''
            const includeSubagents = parseUrl(req).searchParams.get('includeSubagents') === 'true'
            const { context, sessions: available } = await sessionsFor({ anchorSessionId, includeSubagents })
            return jsonResponse(res, 200, { ok: true, context, sessions: available })
          }
          if (path[0] === 'state' && method === 'GET') {
            const context = await contextFor(parseUrl(req).searchParams.get('anchorSessionId') || '')
            if (!context.ready) return jsonResponse(res, 200, { ok: true, context, state: null })
            const state = await storage.readState(context.cwd)
            return jsonResponse(res, 200, { ok: true, context, state })
          }
          if (path[0] === 'confirm' && method === 'POST') {
            return jsonResponse(res, 200, { ok: true, confirmation: await confirmGeneration(await readJson(req)) })
          }
          if (path[0] === 'generations' && path.length === 1 && method === 'POST') {
            const body = await readJson(req)
            const request = consumeConfirmation(body.token, body)
            const task = orchestrator.start(request)
            logMessage(logger, 'info', 'generation accepted id=%s outputMode=%s model=%s', shortText(task.id, 96), request.outputMode, `${request.model.provider}/${request.model.model}`)
            return jsonResponse(res, 202, { ok: true, generation: task })
          }
          if (path[0] === 'generations' && path[1] && path[2] === 'events' && method === 'GET') {
            return handleEvents(req, res, path[1], orchestrator, sseClients)
          }
          if (path[0] === 'generations' && path[1] && path[2] === 'cancel' && method === 'POST') {
            return jsonResponse(res, 200, { ok: true, generation: orchestrator.cancel(path[1]) })
          }
          if (path[0] === 'generations' && path[1] && path.length === 2 && method === 'GET') {
            const generation = orchestrator.get(path[1])
            return generation ? jsonResponse(res, 200, { ok: true, generation }) : jsonResponse(res, 404, { ok: false, error: '生成任务不存在。' })
          }
          if (path[0] === 'mind-map' && path[1] === 'follow-up-question' && method === 'POST') {
            const body = await readJson(req)
            const context = await contextFor(body.anchorSessionId)
            if (!context.ready) throw new Error('当前对话没有可用工作路径。')
            const state = await storage.readState(context.cwd)
            const node = state.mindMap?.nodes?.find((item) => item.id === body.nodeId)
            if (!node) throw new Error('思维导图节点不存在。')
            const targetSessionId = safeId(body.targetSessionId || node.primarySourceSessionId || node.sourceRefs?.[0]?.sessionId, '目标 Session ID')
            if (!state.manifest?.sourceSessionIds?.includes(targetSessionId)) throw new Error('目标对话不是本次生成的来源对话。')
            const result = await orchestrator.formFollowUp({ cwd: context.cwd, node, targetSessionId, strict: state.manifest.strict !== false, model: state.manifest.model })
            return jsonResponse(res, 200, { ok: true, followUp: result, context, revision: state.revision })
          }
          if (path[0] === 'navigation' && path[1] === 'confirm' && method === 'POST') {
            const body = await readJson(req)
            const context = await contextFor(body.anchorSessionId)
            if (!context.ready) throw new Error('当前对话没有可用工作路径。')
            const state = await storage.readState(context.cwd)
            const targetSessionId = safeId(body.targetSessionId, '目标 Session ID')
            if (!state.manifest?.sourceSessionIds?.includes(targetSessionId)) throw new Error('目标对话不是本次生成的来源对话。')
            const question = String(body.question || '').trim()
            if (!question || question.length > 2000) throw new Error('后续问题不能为空且不能超过 2000 个字符。')
            const navigation = await storage.appendNavigation({
              cwd: context.cwd,
              expectedRevision: state.revision,
              navigation: { id: randomUUID(), nodeId: body.nodeId, targetSessionId, question }
            })
            return jsonResponse(res, 200, { ok: true, navigation: { ...navigation.navigation, question, targetSessionId }, context })
          }
          return jsonResponse(res, 404, { ok: false, error: 'Not found' })
        } catch (error) {
          const status = statusForError(error)
          logMessage(logger, 'error', 'route failed method=%s path=%s status=%d error=%s', method, routeLabel, status, errorMessage(error))
          return writeError(res, error, status)
        }
      }

      registerEffect(ctx, webServer, { kind: 'prefix', path: BASE_PATH, handler: handleGeneration })
      registerEffect(ctx, skills, {
        name: 'conversation-knowledge-map',
        description: '从同一工作路径的多个历史对话生成思维导图和静态知识图谱。',
        whenToUse: '用户明确要求整理多个对话、生成脑图、知识图谱或从脑图节点继续探索时。',
        source: 'runtime',
        content: readFileSync(SKILL_PATH, 'utf8').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, ''),
        resourceBase: { kind: 'directory', path: SKILL_DIR_PATH }
      })
      logMessage(logger, 'info', 'host registrations complete plugin=%s', PLUGIN_ID)
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => {
          for (const client of sseClients.values()) client.close?.()
          sseClients.clear()
          for (const task of orchestrator.tasks?.values?.() || []) task.controller?.abort?.(new Error('插件停止。'))
        })
      }
    }
  }
  return host
}

async function handleEvents(req, res, id, orchestrator, sseClients) {
  const snapshot = orchestrator.get(id)
  if (!snapshot) return jsonResponse(res, 404, { ok: false, error: '生成任务不存在。' })
  res.writeHead?.(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  const since = Number(parseUrl(req).searchParams.get('since') || 0)
  const client = {
    closed: false,
    unsubscribe: null,
    close() {
      if (client.closed) return
      client.closed = true
      client.unsubscribe?.()
      sseClients.delete(client)
      try { res.end?.() } catch { /* response already closed */ }
    }
  }
  sseClients.add(client)
  client.unsubscribe = orchestrator.subscribe(id, (event, current) => {
    if (event.id <= since || client.closed) return
    try { sseWrite(res, 'update', { event, generation: current }, event.id) } catch { client.close() }
  }, since)
  sseWrite(res, 'snapshot', { generation: orchestrator.get(id) }, snapshot.events?.at(-1)?.id || 0)
  req.on?.('close', () => client.close())
  res.on?.('close', () => client.close())
}

const host = createHost()
host.pluginId = PLUGIN_ID
export { BASE_PATH }
export default host
