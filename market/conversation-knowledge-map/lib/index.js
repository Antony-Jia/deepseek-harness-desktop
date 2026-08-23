import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { KnowledgeGenerationOrchestrator } from './generation-orchestrator.js'
import { errorMessage, jsonResponse, methodOf, parseUrl, readJson, safeId, sseWrite, shortText } from './protocol.js'
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

function normalizeGenerationInput(body = {}) {
  const selectedSessionIds = [...new Set((Array.isArray(body.selectedSessionIds) ? body.selectedSessionIds : []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (!selectedSessionIds.length) throw new Error('至少选择一个对话。')
  const prompt = String(body.prompt || '').trim()
  if (prompt.length > 4000) throw new Error('额外 Prompt 不能超过 4000 个字符。')
  const expectedRevision = Number(body.expectedRevision)
  return {
    anchorSessionId: safeId(body.anchorSessionId, '锚点 Session ID'),
    selectedSessionIds,
    outputMode: normalizeOutputMode(body.outputMode),
    prompt,
    strict: body.strict !== false,
    includeSubagents: body.includeSubagents === true,
    expectedRevision: Number.isInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : 0
  }
}

function canonicalPayload(value) {
  return JSON.stringify({
    anchorSessionId: value.anchorSessionId,
    cwd: normalizeWorkspacePath(value.cwd),
    selectedSessionIds: [...value.selectedSessionIds].map(String).sort(),
    outputMode: value.outputMode,
    prompt: value.prompt,
    strict: value.strict === true,
    includeSubagents: value.includeSubagents === true,
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
    inject: ['agentDefaultModel', 'agents', 'sessionQuery', 'sessions', 'skills', 'webServer'],

    apply(ctx) {
      const sessionQuery = options.sessionQuery || getService(ctx, 'sessionQuery')
      const sessions = options.sessions || getService(ctx, 'sessions')
      const agents = options.agents || getService(ctx, 'agents')
      const agentDefaultModel = options.agentDefaultModel || getService(ctx, 'agentDefaultModel')
      const skills = options.skills || getService(ctx, 'skills')
      const webServer = options.webServer || getService(ctx, 'webServer')
      const storage = options.storage || new WorkspaceStorage(options.storageOptions)
      const orchestrator = options.orchestrator || new KnowledgeGenerationOrchestrator({
        sessionQuery,
        sessions,
        agents,
        agentDefaultModel,
        storage,
        modelRunner: options.modelRunner
      })
      const confirmations = new Map()
      const sseClients = new Set()

      async function contextFor(sessionId) {
        const anchor = await resolveAnchorSession({ sessionQuery, sessions }, sessionId)
        const header = anchor?.header || anchor?.session || null
        if (!header?.id) return { ready: false, state: 'no-session', sessionId: '', cwd: '' }
        const cwd = normalizeWorkspacePath(header.cwd)
        if (!cwd) return { ready: false, state: 'session-without-cwd', sessionId: String(header.id), cwd: '' }
        return { ready: true, state: 'ready', sessionId: String(header.id), cwd, origin: String(header.origin || '') }
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
        const payload = { ...input, anchorSessionId: context.sessionId, cwd: context.cwd, expectedRevision: state.revision }
        const token = randomUUID()
        confirmations.set(token, { payload, expiresAt: Date.now() + CONFIRMATION_TTL, used: false })
        return {
          token,
          expiresAt: Date.now() + CONFIRMATION_TTL,
          revision: state.revision,
          context,
          selectedSessions: available.filter((item) => input.selectedSessionIds.includes(item.id)),
          outputMode: input.outputMode,
          strict: input.strict,
          promptSummary: shortText(input.prompt, 300),
          overwrite: state.exists
        }
      }

      function consumeConfirmation(token, body) {
        const value = confirmations.get(String(token || ''))
        if (!value || value.used || value.expiresAt < Date.now()) throw new Error('生成确认已过期，请返回配置重新确认。')
        const supplied = normalizeGenerationInput({ ...body, anchorSessionId: body.anchorSessionId || value.payload.anchorSessionId, selectedSessionIds: body.selectedSessionIds || value.payload.selectedSessionIds, outputMode: body.outputMode || value.payload.outputMode, prompt: body.prompt ?? value.payload.prompt, strict: body.strict ?? value.payload.strict, includeSubagents: body.includeSubagents ?? value.payload.includeSubagents, expectedRevision: body.expectedRevision ?? value.payload.expectedRevision })
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
            const result = await orchestrator.formFollowUp({ cwd: context.cwd, node, targetSessionId, strict: state.manifest.strict !== false })
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
          return writeError(res, error, statusForError(error))
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
