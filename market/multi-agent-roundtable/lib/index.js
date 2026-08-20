import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import { RoundtableOrchestrator } from './orchestration.js'
import { clientConfig, defaultConfig, normalizeConfig, normalizeDiscussionInput, SETTINGS_NAMESPACE } from './role-schema.js'
import { eventSummary, jsonResponse, messageOf, parseUrl, readJson } from './protocol.js'

const BASE_PATH = '/multi-agent-roundtable'
const MAX_SSE_CLIENTS = 32

const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  color: z.string().default('#4f8cff'),
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number().default(4096)
})

const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  participantIds: z.array(z.string()).default([])
})

const DiscussionMetadataSchema = z.object({
  id: z.string(),
  parentSessionId: z.string().default(''),
  prompt: z.string().default(''),
  mode: z.string().default('review'),
  rounds: z.number().default(2),
  hostRoleId: z.string().default(''),
  currentRound: z.number().default(0),
  status: z.string().default('created'),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
  participants: z.array(z.object({
    roleId: z.string(),
    childSessionId: z.string()
  })).default([])
})

export const SettingsSchema = z.object({
  schemaVersion: z.number().default(1),
  roles: z.array(RoleSchema).default([]),
  teams: z.array(TeamSchema).default([]),
  defaults: z.object({
    teamId: z.string().default(''),
    mode: z.string().default('review'),
    rounds: z.number().default(2),
    maxParallel: z.number().default(3),
    participantIds: z.array(z.string()).default([])
  }).default({}),
  discussions: z.array(DiscussionMetadataSchema).default([])
})

function getService(ctx, name) {
  return ctx?.get?.(name) ?? ctx?.[name]
}

function methodOf(req) {
  return String(req?.method || 'GET').toUpperCase()
}

function writeError(res, status, error) {
  jsonResponse(res, status, { ok: false, error: messageOf(error) })
}

function registerEffect(ctx, register, value) {
  if (!register?.register) return
  ctx.effect(() => register.register(value))
}

function parseDiscussionPath(req) {
  const pathname = parseUrl(req).pathname
  if (!pathname.startsWith(`${BASE_PATH}/discussions`)) return null
  const suffix = pathname.slice(`${BASE_PATH}/discussions`.length).replace(/^\/+|\/+$/g, '')
  const segments = suffix ? suffix.split('/').map((segment) => decodeURIComponent(segment)) : []
  return { pathname, segments }
}

function sseWrite(res, eventName, body, id) {
  if (id !== undefined) res.write(`id: ${id}\n`)
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

function createMemorySettings(initial) {
  let value = normalizeConfig(initial)
  const listeners = new Set()
  return {
    get: () => value,
    watch: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    update: async (patch) => {
      const previous = value
      value = normalizeConfig({ ...value, ...patch }, value)
      for (const listener of listeners) await listener(value, previous)
    }
  }
}

export function createHost(options = {}) {
  const host = {
    inject: ['agents', 'settings', 'sessions', 'webServer'],

    apply(ctx) {
      const agents = options.agents || getService(ctx, 'agents')
      const sessions = options.sessions || getService(ctx, 'sessions')
      const webServer = options.webServer || getService(ctx, 'webServer')
      const settings = options.settings || getService(ctx, 'settings')
      let settingsScope
      let orchestrator
      let initialized = false
      const sseClients = new Map()

      const initialize = (settingsService) => {
        if (initialized) return
        initialized = true
        const initial = defaultConfig()
        if (settingsService?.register) {
          settingsScope = settingsService.register(settingsNamespace(SETTINGS_NAMESPACE), SettingsSchema, {
            base: initial
          })
        } else {
          settingsScope = createMemorySettings(initial)
        }
        let config
        try { config = normalizeConfig(settingsScope.get(), initial) } catch { config = initial }
        orchestrator = new RoundtableOrchestrator({
          agents,
          sessions,
          settingsScope,
          config,
          onPersist: async (discussions) => settingsScope.update({ discussions })
        })
        orchestrator.hydrate(config.discussions)

        if (typeof settingsScope.watch === 'function') {
          ctx.effect(() => settingsScope.watch((next) => {
            try { orchestrator.setConfig(next) } catch { /* invalid external settings keep the last valid config */ }
          }))
        }

        ctx.effect(() => {
          const disposer = ctx.on?.('session/event', (session, event) => {
            orchestrator.onSessionEvent(session, event)
          })
          return () => disposer?.()
        })

        registerEffect(ctx, webServer, {
          kind: 'exact',
          path: `${BASE_PATH}/config`,
          handler: async (req, res) => {
            try {
              if (methodOf(req) === 'GET') {
                return jsonResponse(res, 200, { ok: true, config: clientConfig(orchestrator.getConfig()) })
              }
              if (methodOf(req) !== 'PUT') return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/PUT。' })
              const body = await readJson(req)
              const input = body.config && typeof body.config === 'object' ? body.config : body
              const current = orchestrator.getConfig()
              const next = normalizeConfig({ ...current, ...input }, current)
              await settingsScope.update({ roles: next.roles, teams: next.teams, defaults: next.defaults })
              orchestrator.setConfig(next)
              return jsonResponse(res, 200, { ok: true, config: clientConfig(next) })
            } catch (error) {
              return writeError(res, 400, error)
            }
          }
        })

        registerEffect(ctx, webServer, {
          kind: 'exact',
          path: `${BASE_PATH}/health`,
          handler: async (_req, res) => jsonResponse(res, 200, {
            ok: true,
            agentsAvailable: typeof agents?.create === 'function' || typeof agents?.resume === 'function',
            settingsAvailable: Boolean(settingsService?.register),
            activeDiscussions: orchestrator.persistedMetadata().filter((item) => item.status === 'running').length
          })
        })

        registerEffect(ctx, webServer, {
          kind: 'prefix',
          path: `${BASE_PATH}/discussions`,
          handler: async (req, res) => {
            const parsed = parseDiscussionPath(req)
            if (!parsed) return jsonResponse(res, 404, { ok: false, error: 'Not found' })
            const method = methodOf(req)
            const [id, action] = parsed.segments
            try {
              if (parsed.segments.length === 0) {
                if (method !== 'POST') return jsonResponse(res, 405, { ok: false, error: '仅支持 POST。' })
                const body = await readJson(req)
                const discussion = await orchestrator.create(body)
                return jsonResponse(res, 202, { ok: true, discussion })
              }
              if (!id) return jsonResponse(res, 404, { ok: false, error: '缺少 discussionId。' })
              if (action === 'events') return handleEvents(req, res, orchestrator, id, sseClients)
              if (action === 'cancel') {
                if (method !== 'POST') return jsonResponse(res, 405, { ok: false, error: '仅支持 POST。' })
                const body = await readJson(req)
                return jsonResponse(res, 200, { ok: true, discussion: orchestrator.cancel(id, body.roleId || '') })
              }
              if (action === 'messages') {
                if (method !== 'POST') return jsonResponse(res, 405, { ok: false, error: '仅支持 POST。' })
                const body = await readJson(req)
                return jsonResponse(res, 202, { ok: true, discussion: await orchestrator.continueDiscussion(id, body.content || body.prompt) })
              }
              if (parsed.segments.length === 1) {
                if (method !== 'GET') return jsonResponse(res, 405, { ok: false, error: '仅支持 GET。' })
                const discussion = orchestrator.get(id)
                if (!discussion) return jsonResponse(res, 404, { ok: false, error: '讨论不存在。' })
                return jsonResponse(res, 200, { ok: true, discussion })
              }
              return jsonResponse(res, 404, { ok: false, error: 'Not found' })
            } catch (error) {
              const message = messageOf(error)
              const status = /不存在|缺少|不能为空|必须|至少|不支持|需要/.test(message) ? 400 : 409
              return writeError(res, status, error)
            }
          }
        })

        ctx.effect(() => () => {
          for (const clients of sseClients.values()) for (const client of clients) client.close?.()
          sseClients.clear()
          void orchestrator.dispose()
        })
      }

      if (settings?.register) initialize(settings)
      else if (typeof ctx.inject === 'function') ctx.inject(['settings'], (settingsCtx) => initialize(settingsCtx.settings))
      else initialize(undefined)
    }
  }
  return host
}

async function handleEvents(req, res, orchestrator, id, sseClients) {
  const state = orchestrator.get(id)
  if (!state) return jsonResponse(res, 404, { ok: false, error: '讨论不存在。' })
  let activeClients = 0
  for (const clients of sseClients.values()) activeClients += clients.size
  if (activeClients >= MAX_SSE_CLIENTS) return jsonResponse(res, 429, { ok: false, error: '实时订阅数量已达上限。' })
  const url = parseUrl(req)
  const since = Number(url.searchParams.get('since') || 0)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  })
  const clients = sseClients.get(id) || new Set()
  const client = {
    timer: null,
    closed: false,
    close() {
      if (client.closed) return
      client.closed = true
      clearInterval(client.timer)
      unsubscribe?.()
      clients.delete(client)
      if (clients.size === 0) sseClients.delete(id)
      try { res.end() } catch { /* already closed */ }
    },
    flush() {
      if (!client.closed) {
        try { res.write(': ping\n\n') } catch { client.close() }
      }
    }
  }
  clients.add(client)
  sseClients.set(id, clients)
  let unsubscribe
  unsubscribe = orchestrator.subscribe(id, (event, snapshot) => {
    if (event.id <= since) return
    try { sseWrite(res, 'update', { event, discussion: snapshot }, event.id) } catch { client.close() }
  }, since)
  sseWrite(res, 'snapshot', { discussion: state }, state.lastEventId)
  client.timer = setInterval(() => client.flush(), 15000)
  req.on?.('close', () => client.close())
  res.on?.('close', () => client.close())
}

const host = createHost()
host.pluginId = '@p-dsh-market/multi-agent-roundtable'
export default host
