import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import { RoundtableOrchestrator } from './orchestration.js'
import { createConversation, normalizeConversationIndex, readConversationIndex, resolveConversationIndexPath, writeConversationIndex } from './conversation-storage.js'
import { readPluginConfig, resolvePluginConfigPath, writePluginConfig } from './config-storage.js'
import { clientConfig, defaultConfig, normalizeConfig, normalizeDiscussionInput, SETTINGS_NAMESPACE } from './role-schema.js'
import { eventSummary, jsonResponse, messageOf, parseUrl, readJson } from './protocol.js'
import { createRoundtableToolDefinition, roundtableToolValue } from './tool.js'

const BASE_PATH = '/multi-agent-roundtable'
const MAX_SSE_CLIENTS = 32
const SKILL_PATH = fileURLToPath(new URL('../skills/multi-agent-roundtable/SKILL.md', import.meta.url))

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
  conversationId: z.string().default(''),
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

function parseConversationPath(req) {
  const pathname = parseUrl(req).pathname
  if (!pathname.startsWith(`${BASE_PATH}/conversations`)) return null
  const suffix = pathname.slice(`${BASE_PATH}/conversations`.length).replace(/^\/+|\/+$/g, '')
  const segments = suffix ? suffix.split('/').map((segment) => decodeURIComponent(segment)) : []
  return { pathname, segments }
}

function conversationTitle(prompt) {
  const title = String(prompt || '').replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, 48) : '新建 Multi-Agent 群聊'
}

function readRoundtableSkill() {
  return readFileSync(SKILL_PATH, 'utf8').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '')
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
    inject: ['agentDefaultModel', 'agentPresets', 'agents', 'settings', 'sessions', 'skills', 'tools', 'webServer'],

    apply(ctx) {
      const agents = options.agents || getService(ctx, 'agents')
      const agentDefaultModel = options.agentDefaultModel || getService(ctx, 'agentDefaultModel')
      const agentPresets = options.agentPresets || getService(ctx, 'agentPresets')
      const sessions = options.sessions || getService(ctx, 'sessions')
      const sessionQuery = options.sessionQuery || getService(ctx, 'sessionQuery')
      const skills = options.skills || getService(ctx, 'skills')
      const tools = options.tools || getService(ctx, 'tools')
      const webServer = options.webServer || getService(ctx, 'webServer')
      const settings = options.settings || getService(ctx, 'settings')
      let settingsScope
      let orchestrator
      let initialized = false
      const sseClients = new Map()
      const pluginConfigPath = options.pluginConfigPath || resolvePluginConfigPath(options.env || process.env)
      const conversationIndexPath = options.conversationIndexPath || resolveConversationIndexPath(options.env || process.env)
      let conversationIndex = { schemaVersion: 1, conversations: [] }
      let conversationWrite = Promise.resolve()

      const persistConversationIndex = () => {
        const snapshot = JSON.parse(JSON.stringify(conversationIndex))
        conversationWrite = conversationWrite.catch(() => {}).then(() => writeConversationIndex(conversationIndexPath, snapshot))
        return conversationWrite
      }

      const findConversation = (id) => conversationIndex.conversations.find((item) => item.id === id)

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
        let legacyConfig
        try { legacyConfig = normalizeConfig(settingsScope.get(), initial) } catch { legacyConfig = initial }
        let config
        let canMigratePluginConfig = true
        try {
          config = normalizeConfig(readPluginConfig(pluginConfigPath, legacyConfig), legacyConfig)
        } catch {
          config = legacyConfig
          canMigratePluginConfig = false
        }
        try {
          conversationIndex = readConversationIndex(conversationIndexPath, config.discussions)
        } catch {
          conversationIndex = normalizeConversationIndex(null, config.discussions)
        }
        const indexedDiscussions = conversationIndex.conversations.map((item) => item.discussion).filter(Boolean)
        let hydrationDiscussions = config.discussions
        if (indexedDiscussions.length) {
          const byId = new Map(config.discussions.map((item) => [item.id, item]))
          for (const discussion of indexedDiscussions) byId.set(discussion.id, discussion)
          hydrationDiscussions = [...byId.values()]
          config = normalizeConfig({ ...config, discussions: hydrationDiscussions }, config)
        }
        for (const discussion of config.discussions) {
          const conversation = conversationIndex.conversations.find((item) => item.discussionId === discussion.id)
          if (conversation) discussion.conversationId = conversation.id
        }
        // First start migrates role configuration and discussion metadata into
        // plugin-owned files. Settings remains a compatibility projection;
        // child Sessions remain the transcript source of truth.
        if (canMigratePluginConfig) void writePluginConfig(pluginConfigPath, config).catch(() => {})
        orchestrator = new RoundtableOrchestrator({
          agents,
          agentDefaultModel,
          agentPresets,
          sessions,
          sessionQuery,
          settingsScope,
          config,
          onPersist: async (discussions) => {
            for (const discussion of discussions) {
              let conversation = findConversation(discussion.conversationId)
              if (!conversation) {
                conversation = createConversation({
                  id: discussion.conversationId || `conversation-${discussion.id}`,
                  title: discussion.prompt,
                  boundSessionId: discussion.parentSessionId,
                  discussionId: discussion.id
                }, discussion.createdAt)
                conversationIndex.conversations.unshift(conversation)
              }
              conversation.discussionId = discussion.id
              conversation.discussion = { ...discussion, conversationId: conversation.id }
              conversation.boundSessionId = discussion.parentSessionId || conversation.boundSessionId
              conversation.title = conversationTitle(discussion.prompt)
              conversation.updatedAt = discussion.updatedAt
            }
            const compatibilityDiscussions = discussions.map((discussion) => ({
              id: discussion.id,
              conversationId: discussion.conversationId,
              parentSessionId: discussion.parentSessionId,
              prompt: discussion.prompt,
              mode: discussion.mode,
              rounds: discussion.rounds,
              hostRoleId: discussion.hostRoleId,
              currentRound: discussion.currentRound,
              status: discussion.status,
              createdAt: discussion.createdAt,
              updatedAt: discussion.updatedAt,
              participants: discussion.participants.map((participant) => ({
                roleId: participant.roleId,
                childSessionId: participant.childSessionId
              }))
            }))
            await Promise.all([settingsScope.update({ discussions: compatibilityDiscussions }), persistConversationIndex()])
          }
        })
        orchestrator.hydrate(hydrationDiscussions)
        void persistConversationIndex().catch(() => {})

        registerEffect(ctx, skills, {
          name: 'multi-agent-roundtable',
          description: '在当前对话中调用多个独立角色进行讨论、评审、会诊或头脑风暴。',
          whenToUse: '用户明确要求多个角色、专家或智能体共同讨论、评审、会诊或头脑风暴时。',
          source: 'runtime',
          content: readRoundtableSkill(),
          resourceBase: { kind: 'directory', path: dirname(SKILL_PATH) }
        })

        registerEffect(ctx, tools, createRoundtableToolDefinition(async (args, exec) => {
          const parentAgent = exec?.agent
          const parentHeader = parentAgent?.session?.header
          if (!parentAgent || !parentHeader?.id) throw new Error('multi_agent_discuss 只能从一个正在运行的 DSH 主对话调用。')
          if (parentHeader.origin === 'subagent') throw new Error('圆桌角色不能递归开启新的多智能体讨论。')
          const conversation = createConversation({
            title: args?.topic,
            boundSessionId: parentHeader.id
          })
          conversationIndex.conversations.unshift(conversation)
          await persistConversationIndex()
          let discussion
          try {
            discussion = await orchestrator.create({
              conversationId: conversation.id,
              parentSessionId: parentHeader.id,
              prompt: args?.topic,
              participantIds: args?.participantIds,
              mode: args?.mode,
              rounds: args?.rounds
            })
          } catch (error) {
            conversationIndex.conversations = conversationIndex.conversations.filter((item) => item.id !== conversation.id)
            await persistConversationIndex()
            throw error
          }
          conversation.discussionId = discussion.id
          conversation.updatedAt = discussion.updatedAt
          await persistConversationIndex()
          const completed = await orchestrator.waitForCompletion(discussion.id, exec.signal)
          if (completed.status !== 'completed') {
            throw new Error(`多智能体讨论未完成（${completed.status}）：${completed.error || '请打开 Multi-Agent 对话页面查看角色状态。'}`)
          }
          return roundtableToolValue(completed)
        }))

        if (typeof settingsScope.watch === 'function') {
          ctx.effect(() => settingsScope.watch((next) => {
            try {
              const current = orchestrator.getConfig()
              orchestrator.setConfig({ ...current, discussions: next.discussions })
            } catch { /* invalid external settings keep the last valid config */ }
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
              await writePluginConfig(pluginConfigPath, next)
              // Keep the namespace projection synchronized for old clients,
              // while roles.json remains the durable authority after migration.
              await settingsScope.update({ roles: next.roles, teams: next.teams, defaults: next.defaults })
              orchestrator.setConfig(next)
              return jsonResponse(res, 200, { ok: true, config: clientConfig(next) })
            } catch (error) {
              return writeError(res, 400, error)
            }
          }
        })

        registerEffect(ctx, webServer, {
          kind: 'prefix',
          path: `${BASE_PATH}/conversations`,
          handler: async (req, res) => {
            const parsed = parseConversationPath(req)
            if (!parsed) return jsonResponse(res, 404, { ok: false, error: 'Not found' })
            const method = methodOf(req)
            const [id] = parsed.segments
            try {
              if (parsed.segments.length === 0) {
                if (method === 'GET') {
                  const boundSessionId = String(parseUrl(req).searchParams.get('boundSessionId') || '').trim()
                  const conversations = [...conversationIndex.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
                  const suggested = boundSessionId ? conversations.find((item) => item.boundSessionId === boundSessionId) : conversations.find((item) => !item.boundSessionId)
                  return jsonResponse(res, 200, { ok: true, conversations, suggestedId: suggested?.id || '' })
                }
                if (method === 'POST') {
                  const body = await readJson(req)
                  const conversation = createConversation({
                    title: body.title,
                    boundSessionId: body.boundSessionId
                  })
                  conversationIndex.conversations.unshift(conversation)
                  await persistConversationIndex()
                  return jsonResponse(res, 201, { ok: true, conversation })
                }
                return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/POST。' })
              }
              const conversation = findConversation(id)
              if (!conversation) return jsonResponse(res, 404, { ok: false, error: '群聊会话不存在。' })
              if (method === 'GET') return jsonResponse(res, 200, { ok: true, conversation })
              if (method === 'PATCH') {
                const body = await readJson(req)
                if (body.title !== undefined) conversation.title = conversationTitle(body.title)
                if (body.boundSessionId !== undefined) conversation.boundSessionId = String(body.boundSessionId || '').trim()
                conversation.updatedAt = Date.now()
                await persistConversationIndex()
                return jsonResponse(res, 200, { ok: true, conversation })
              }
              if (method === 'DELETE') {
                const discussion = conversation.discussionId ? orchestrator.get(conversation.discussionId) : null
                if (discussion?.status === 'running') return jsonResponse(res, 409, { ok: false, error: '讨论运行中，不能删除该群聊记录。' })
                if (discussion) orchestrator.remove(discussion.id)
                conversationIndex.conversations = conversationIndex.conversations.filter((item) => item.id !== id)
                await persistConversationIndex()
                return jsonResponse(res, 200, { ok: true })
              }
              return jsonResponse(res, 405, { ok: false, error: '仅支持 GET/PATCH/DELETE。' })
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
                let conversation = findConversation(String(body.conversationId || '').trim())
                if (!conversation) {
                  conversation = createConversation({ title: body.prompt, boundSessionId: body.parentSessionId })
                  conversationIndex.conversations.unshift(conversation)
                  body.conversationId = conversation.id
                }
                if (conversation.discussionId) return jsonResponse(res, 409, { ok: false, error: '该群聊已经存在讨论记录，请继续讨论或新建群聊。' })
                body.parentSessionId = body.parentSessionId || conversation.boundSessionId
                const discussion = await orchestrator.create(body)
                conversation.discussionId = discussion.id
                conversation.discussion = { ...orchestrator.persistedMetadata().find((item) => item.id === discussion.id), conversationId: conversation.id }
                conversation.boundSessionId = discussion.parentSessionId || conversation.boundSessionId
                conversation.title = conversationTitle(discussion.prompt)
                conversation.updatedAt = discussion.updatedAt
                await persistConversationIndex()
                return jsonResponse(res, 202, { ok: true, discussion, conversation })
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
                let discussion = orchestrator.get(id)
                if (!discussion) return jsonResponse(res, 404, { ok: false, error: '讨论不存在。' })
                if (!discussion.messages.some((message) => message.roleId !== 'user')) discussion = await orchestrator.restorePersistedProjection(id)
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
