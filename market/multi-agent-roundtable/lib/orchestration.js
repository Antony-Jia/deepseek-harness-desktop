import { randomUUID } from 'node:crypto'

import {
  MAX_CONTEXT_CHARS,
  MAX_DISCUSSION_EVENTS,
  MAX_DISCUSSION_MESSAGES,
  contentText,
  eventSummary,
  makeUserMessage,
  messageOf,
  messageMarkdown,
  messageReasoning,
  safePathSegment,
  shortText
} from './protocol.js'
import { normalizeConfig, normalizeDiscussionInput } from './role-schema.js'

function nowValue(now) {
  return typeof now === 'function' ? now() : Date.now()
}

function messageKey(turn, step) {
  return `${Number.isInteger(turn) ? turn : 0}:${Number.isInteger(step) ? step : 0}`
}

function roleMap(roles) {
  return new Map((Array.isArray(roles) ? roles : []).map((role) => [role.id, role]))
}

function childSessionId(discussionId, roleId) {
  return `roundtable-${safePathSegment(discussionId)}-${safePathSegment(roleId)}-${randomUUID().slice(0, 8)}`
}

function errorMessage(error) {
  return shortText(messageOf(error), 1200)
}

export function buildReviewContext(messages, excludeRoleId = '') {
  const sections = []
  let total = 0
  for (const message of messages || []) {
    if (message.roleId === excludeRoleId || message.roleId === 'user' || !message.content) continue
    const section = `### ${message.roleName || message.roleId}\n\n${shortText(message.content, 4200)}`
    if (total + section.length > MAX_CONTEXT_CHARS) break
    sections.push(section)
    total += section.length
  }
  return sections.join('\n\n')
}

export async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  const max = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 1, list.length || 1))
  let cursor = 0
  const results = new Array(list.length)
  async function pump() {
    while (true) {
      const index = cursor++
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, list.length) }, () => pump()))
  return results
}

export class RoundtableOrchestrator {
  constructor(options = {}) {
    this.agents = options.agents
    this.agentDefaultModel = options.agentDefaultModel
    this.agentPresets = options.agentPresets
    this.sessions = options.sessions
    this.sessionQuery = options.sessionQuery
    this.settingsScope = options.settingsScope
    this.now = options.now || (() => Date.now())
    this.idFactory = options.idFactory || (() => `discussion-${randomUUID()}`)
    this.onPersist = options.onPersist
    this.maxStoredDiscussions = options.maxStoredDiscussions || 100
    this.discussions = new Map()
    this.sessionIndex = new Map()
    this.listeners = new Map()
    this.config = normalizeConfig(options.config)
    this.persistPending = false
    this.disposed = false
  }

  setConfig(value) {
    this.config = normalizeConfig(value, this.config)
    for (const state of this.discussions.values()) this.refreshRolePresentation(state)
    return this.getConfig()
  }

  getConfig() {
    return normalizeConfig(this.config)
  }

  hydrate(metadata) {
    if (!Array.isArray(metadata)) return
    for (const item of metadata.slice(-this.maxStoredDiscussions)) {
      try {
        const normalized = normalizeDiscussionInput({
          parentSessionId: item.parentSessionId,
          prompt: item.prompt || '已恢复的多 Agent 讨论',
          mode: item.mode,
          rounds: item.rounds,
          hostRoleId: item.hostRoleId,
          participantIds: (item.participants || []).map((participant) => participant.roleId)
        }, this.config)
        normalized.conversationId = String(item.conversationId || `conversation-${item.id}`)
        const state = this.createState(item.id, normalized, {
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          currentRound: item.currentRound,
          // A process-local run cannot survive a DSH restart. Keep the
          // session recoverable instead of presenting a permanently running
          // discussion with no worker loop behind it.
          status: item.status === 'running' ? 'created' : item.status,
          error: item.error,
          finalMessageId: item.finalMessageId,
          messages: item.messages,
          restored: true,
          participantMetadata: item.participants
        })
        if (state.messages.length === 0) this.appendUserMessage(state, state.prompt, 0)
        this.discussions.set(state.id, state)
        this.indexStateSessions(state)
        if (!state.messages.some((message) => message.roleId !== 'user')) this.restoreSessionProjection(state)
      } catch {
        // A removed role or malformed old record must not prevent DSH boot.
      }
    }
  }

  createState(id, request, extras = {}) {
    const roles = roleMap(request.roles)
    const participants = request.participantIds.map((roleId) => {
      const role = roles.get(roleId)
      const saved = extras.participantMetadata?.find((item) => item.roleId === roleId)
      return {
        roleId,
        roleName: role?.name || roleId,
        color: role?.color || '#4f8cff',
        childSessionId: saved?.childSessionId || childSessionId(id, roleId),
        status: String(saved?.status || 'idle'),
        error: String(saved?.error || ''),
        turnError: '',
        activeRound: Number.isInteger(saved?.activeRound) ? saved.activeRound : 0,
        cancelled: false,
        handle: null,
        restored: extras.restored === true
      }
    })
    const time = nowValue(this.now)
    return {
      id,
      parentSessionId: request.parentSessionId || '',
      conversationId: request.conversationId || '',
      prompt: request.prompt,
      mode: request.mode,
      rounds: request.rounds,
      maxParallel: request.maxParallel,
      hostRoleId: request.hostRoleId || '',
      roleDefinitions: request.roles,
      participants,
      messages: (Array.isArray(extras.messages) ? extras.messages : []).map((message) => ({
        id: String(message?.id || `restored-${randomUUID()}`),
        roleId: String(message?.roleId || ''),
        roleName: String(message?.roleName || message?.roleId || ''),
        color: String(message?.color || '#4f8cff'),
        round: Number.isInteger(message?.round) ? message.round : 0,
        content: shortText(message?.content || '', 20000),
        reasoning: shortText(message?.reasoning || '', 20000),
        status: String(message?.status || 'complete'),
        createdAt: Number.isFinite(message?.createdAt) ? message.createdAt : time,
        updatedAt: Number.isFinite(message?.updatedAt) ? message.updatedAt : time
      })).filter((message) => message.roleId),
      events: [],
      nextEventId: 1,
      currentRound: extras.currentRound || 0,
      status: extras.status || 'created',
      error: String(extras.error || ''),
      finalMessageId: String(extras.finalMessageId || ''),
      createdAt: extras.createdAt || time,
      updatedAt: extras.updatedAt || time,
      startedAt: 0,
      restored: extras.restored === true,
      cancelled: false,
      restoringProjection: false,
      runPromise: null
    }
  }

  refreshRolePresentation(state) {
    const roles = roleMap(this.config.roles)
    state.roleDefinitions = this.config.roles.map((role) => ({ ...role }))
    for (const participant of state.participants) {
      const role = roles.get(participant.roleId)
      if (role) {
        participant.roleName = role.name
        participant.color = role.color
      }
    }
  }

  indexStateSessions(state) {
    for (const participant of state.participants) {
      this.sessionIndex.set(participant.childSessionId, { state, participant })
    }
  }

  restoreSessionProjection(state) {
    let restored = 0
    const previousUpdatedAt = state.updatedAt
    state.restoringProjection = true
    try {
      for (const participant of state.participants) {
        const session = this.sessions?.get?.(participant.childSessionId)
        if (!session || !Array.isArray(session.events)) continue
        participant.activeRound = state.currentRound || 1
        for (const event of session.events) {
          if (Number.isInteger(event?.data?.turn) && event.data.turn > 0) participant.activeRound = event.data.turn
          this.onSessionEvent(session, event)
        }
        restored += 1
      }
    } finally {
      state.restoringProjection = false
      state.updatedAt = previousUpdatedAt
    }
    return restored
  }

  async restorePersistedProjection(id) {
    const state = this.requireState(id)
    if (state.messages.some((message) => message.roleId !== 'user')) return this.toPublic(state)
    if (this.restoreSessionProjection(state) > 0) {
      this.schedulePersist()
      return this.toPublic(state)
    }
    if (typeof this.sessionQuery?.readSession !== 'function') return this.toPublic(state)
    let restored = 0
    const previousUpdatedAt = state.updatedAt
    state.restoringProjection = true
    try {
      for (const participant of state.participants) {
        try {
          const snapshot = await this.sessionQuery.readSession(participant.childSessionId)
          if (!snapshot || !Array.isArray(snapshot.events)) continue
          participant.activeRound = state.currentRound || 1
          const session = { id: participant.childSessionId, header: snapshot.header, events: snapshot.events }
          for (const event of snapshot.events) {
            if (Number.isInteger(event?.data?.turn) && event.data.turn > 0) participant.activeRound = event.data.turn
            this.onSessionEvent(session, event)
          }
          restored += 1
        } catch { /* one missing legacy child log must not hide the other roles */ }
      }
    } finally {
      state.restoringProjection = false
      state.updatedAt = previousUpdatedAt
    }
    if (restored > 0) this.schedulePersist()
    return this.toPublic(state)
  }

  appendEvent(state, type, payload = {}) {
    const event = {
      id: state.nextEventId++,
      type,
      at: nowValue(this.now),
      ...payload
    }
    state.events.push(event)
    if (state.events.length > MAX_DISCUSSION_EVENTS) state.events.splice(0, state.events.length - MAX_DISCUSSION_EVENTS)
    state.updatedAt = event.at
    this.notify(state, event)
    return event
  }

  notify(state, event) {
    for (const listener of this.listeners.get(state.id) || []) {
      try { listener(event, this.toPublic(state)) } catch { /* UI observers cannot break orchestration */ }
    }
  }

  subscribe(id, listener, since = 0) {
    const state = this.discussions.get(id)
    if (!state) return null
    const events = state.events.filter((event) => event.id > since)
    for (const event of events) listener(event, this.toPublic(state))
    const listeners = this.listeners.get(id) || new Set()
    listeners.add(listener)
    this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(id)
    }
  }

  schedulePersist() {
    if (this.persistPending || typeof this.onPersist !== 'function') return
    this.persistPending = true
    queueMicrotask(async () => {
      this.persistPending = false
      if (this.disposed) return
      try { await this.onPersist(this.persistedMetadata()) } catch { /* persistence failure is surfaced on the next read */ }
    })
  }

  persistedMetadata() {
    return [...this.discussions.values()].slice(-this.maxStoredDiscussions).map((state) => ({
      id: state.id,
      parentSessionId: state.parentSessionId,
      conversationId: state.conversationId,
      prompt: state.prompt,
      mode: state.mode,
      rounds: state.rounds,
      hostRoleId: state.hostRoleId,
      currentRound: state.currentRound,
      status: state.status,
      error: state.error,
      finalMessageId: state.finalMessageId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      participants: state.participants.map((participant) => ({
        roleId: participant.roleId,
        childSessionId: participant.childSessionId,
        status: participant.status,
        error: participant.error,
        activeRound: participant.activeRound
      })),
      messages: state.messages.map((message) => ({
        id: message.id,
        roleId: message.roleId,
        roleName: message.roleName,
        color: message.color,
        round: message.round,
        content: message.content,
        reasoning: message.reasoning || '',
        status: message.status,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      }))
    }))
  }

  async create(input) {
    if (this.disposed) throw new Error('多 Agent 讨论插件已停止。')
    const request = normalizeDiscussionInput(input, this.config)
    request.conversationId = String(input?.conversationId || '').trim()
    const id = this.idFactory()
    if (this.discussions.has(id)) throw new Error(`讨论 ID 重复：${id}`)
    const state = this.createState(id, request)
    this.appendUserMessage(state, state.prompt, 0)
    this.discussions.set(id, state)
    this.indexStateSessions(state)
    this.appendEvent(state, 'discussion/created', {
      parentSessionId: state.parentSessionId,
      conversationId: state.conversationId,
      participantIds: state.participants.map((participant) => participant.roleId)
    })
    this.schedulePersist()
    state.runPromise = this.run(state, state.prompt).catch((error) => {
      if (state.status !== 'cancelled') {
        state.status = 'failed'
        state.error = errorMessage(error)
        this.appendEvent(state, 'discussion/failed', { error: state.error })
        this.schedulePersist()
      }
    })
    return this.toPublic(state)
  }

  async continueDiscussion(id, content) {
    const state = this.requireState(id)
    if (state.status === 'running') throw new Error('讨论正在运行中，请等待当前轮次结束。')
    const prompt = String(content || '').trim()
    if (!prompt) throw new Error('追加内容不能为空。')
    state.prompt = prompt
    if (state.status === 'cancelled') {
      for (const participant of state.participants) {
        participant.cancelled = false
        participant.status = 'idle'
        participant.error = ''
      }
    }
    state.cancelled = false
    state.error = ''
    state.status = 'running'
    const round = Math.max(1, state.currentRound + 1)
    this.appendUserMessage(state, prompt, round)
    this.appendEvent(state, 'discussion/message', { content: shortText(prompt, 12000), round })
    state.runPromise = this.run(state, prompt, round).catch((error) => {
      if (state.status !== 'cancelled') {
        state.status = 'failed'
        state.error = errorMessage(error)
        this.appendEvent(state, 'discussion/failed', { error: state.error })
        this.schedulePersist()
      }
    })
    return this.toPublic(state)
  }

  get(id) {
    const state = this.discussions.get(id)
    return state ? this.toPublic(state) : null
  }

  async waitForCompletion(id, signal) {
    const state = this.requireState(id)
    const cancelFromSignal = () => {
      if (state.status === 'running') this.cancel(id)
    }
    if (signal?.aborted) cancelFromSignal()
    else signal?.addEventListener?.('abort', cancelFromSignal, { once: true })
    try {
      await state.runPromise
    } finally {
      signal?.removeEventListener?.('abort', cancelFromSignal)
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('多智能体讨论已取消。')
    return this.toPublic(state)
  }

  requireState(id) {
    const state = this.discussions.get(id)
    if (!state) throw new Error(`讨论不存在：${id}`)
    return state
  }

  appendUserMessage(state, content, round) {
    state.messages.push({
      id: `user-${state.id}-${state.messages.length + 1}`,
      roleId: 'user',
      roleName: '你',
      color: '#4f8cff',
      round,
      content: shortText(content, 20000),
      reasoning: '',
      status: 'complete',
      createdAt: nowValue(this.now),
      updatedAt: nowValue(this.now)
    })
    if (state.messages.length > MAX_DISCUSSION_MESSAGES) state.messages.splice(0, state.messages.length - MAX_DISCUSSION_MESSAGES)
  }

  async run(state, prompt, startRound = 1) {
    state.status = 'running'
    state.startedAt = state.startedAt || nowValue(this.now)
    this.appendEvent(state, 'discussion/started', { round: startRound })
    const roles = roleMap(state.roleDefinitions)
    const selected = state.participants.filter((participant) => roles.has(participant.roleId))
    if (selected.length === 0) throw new Error('没有可运行的参与角色。')

    if (state.mode === 'host') {
      const host = selected.find((participant) => participant.roleId === state.hostRoleId)
      const workers = selected.filter((participant) => participant !== host)
      await this.runRound(state, workers, roles, prompt, startRound, false)
      if (state.cancelled) return
      if (!host) throw new Error('主持人角色不存在。')
      const context = buildReviewContext(state.messages.filter((message) => message.round === startRound), host.roleId)
      await this.runRound(state, [host], roles, `${prompt}\n\n请根据以下角色意见主持并总结：\n\n${context}`, startRound + 1, true)
    } else {
      for (let offset = 0; offset < state.rounds; offset += 1) {
        const round = startRound + offset
        const review = state.mode === 'review' && round > startRound
        await this.runRound(state, selected, roles, prompt, round, review)
        if (state.cancelled) return
      }
    }

    if (state.cancelled) return
    const final = state.mode === 'host'
      ? [...state.messages].reverse().find((message) => message.roleId === state.hostRoleId && message.status === 'complete')
      : [...state.messages].reverse().find((message) => message.status === 'complete')
    state.finalMessageId = final?.id || ''
    state.currentRound = Math.max(state.currentRound, startRound + (state.mode === 'host' ? 1 : state.rounds - 1))
    state.status = 'completed'
    for (const participant of state.participants) {
      if (participant.status === 'running') participant.status = 'completed'
    }
    this.appendEvent(state, 'discussion/completed', { finalMessageId: state.finalMessageId, round: state.currentRound })
    this.schedulePersist()
  }

  async runRound(state, participants, roles, prompt, round, review) {
    if (participants.length === 0) return
    state.currentRound = round
    const priorMessages = review ? state.messages.filter((message) => message.round < round) : []
    await runWithConcurrency(participants, state.maxParallel, async (participant) => {
      if (state.cancelled || participant.cancelled) return
      const role = roles.get(participant.roleId)
      // A reviewer sees other roles only. Its own durable child-session history
      // already contains its prior answer, so echoing that answer into the relay
      // would duplicate and amplify its own wording.
      const reviewContext = review ? buildReviewContext(priorMessages, participant.roleId) : ''
      const rolePrompt = this.rolePrompt(state, role, prompt, round, reviewContext)
      await this.runRole(state, participant, role, rolePrompt, round)
    })
    const activeParticipants = state.participants.filter((participant) => !participant.cancelled)
    if (activeParticipants.length > 0 && activeParticipants.every((participant) => participant.status === 'failed')) {
      const details = activeParticipants.map((participant) => `${participant.roleName}：${participant.error || '未知错误'}`).join('\n')
      throw new Error(`所有参与角色均执行失败，请检查模型配置。\n${details}`)
    }
    if (activeParticipants.length === 0) {
      state.cancelled = true
      state.status = 'cancelled'
      return
    }
    this.appendEvent(state, 'discussion/round-completed', { round, review })
    this.schedulePersist()
  }

  rolePrompt(state, role, prompt, round, context) {
    const reviewText = context
      ? `\n\n以下是前序轮次的其他角色意见，请逐条复核并指出你同意、反对和需要补充的地方：\n\n${context}`
      : ''
    return [
      `这是一个多 Agent 圆桌讨论。当前第 ${round} 轮。`,
      `讨论主题：${prompt}`,
      `你的角色：${role?.name || '参与者'}。`,
      '请使用 Markdown 输出，先给结论，再给关键依据、风险和可执行建议。不要声称看到了其他角色未提供的内容。',
      reviewText
    ].join('\n\n')
  }

  async runRole(state, participant, role, prompt, round) {
    participant.status = 'running'
    participant.error = ''
    participant.turnError = ''
    participant.activeRound = round
    this.appendEvent(state, 'participant/started', { roleId: participant.roleId, round })
    try {
      const handle = await this.ensureAgent(state, participant, role)
      handle.agent.followup(makeUserMessage(prompt, `roundtable-${state.id}-${participant.roleId}-${round}-${randomUUID()}`))
      await handle.agent.whenIdle()
      if (participant.turnError) throw new Error(participant.turnError)
      if (!state.cancelled && !participant.cancelled) {
        participant.status = 'completed'
        this.appendEvent(state, 'participant/completed', { roleId: participant.roleId, round })
      } else if (participant.cancelled) {
        participant.status = 'cancelled'
      }
    } catch (error) {
      participant.status = state.cancelled || participant.cancelled ? 'cancelled' : 'failed'
      participant.error = errorMessage(error)
      this.appendEvent(state, 'participant/failed', { roleId: participant.roleId, round, error: participant.error })
    }
  }

  async ensureAgent(state, participant, role) {
    if (participant.handle) return participant.handle
    if (!this.agents?.create && !this.agents?.resume) throw new Error('当前 DSH 运行时未提供 agents.create。')
    let inherited = {}
    try { inherited = this.agentDefaultModel?.currentSelection?.() || {} } catch { inherited = {} }
    const roleProvider = String(role?.provider || '').trim()
    const roleModel = String(role?.model || '').trim()
    if (roleProvider && !roleModel && roleProvider !== inherited.provider) {
      throw new Error(`角色“${role?.name || participant.roleName}”指定了 Provider，但没有指定对应 Model。`)
    }
    const provider = roleProvider || String(inherited.provider || '').trim()
    const model = roleModel || String(inherited.model || '').trim()
    if (!provider || !model) {
      throw new Error(`角色“${role?.name || participant.roleName}”没有可用的 Provider/Model；请配置角色模型或设置 DSH 默认模型。`)
    }
    const agentOptions = { provider, model }
    if (role?.maxTokens) agentOptions.maxTokens = role.maxTokens
    const parentAgent = state.parentSessionId ? this.agents?.get?.(state.parentSessionId) : null
    const parentHeader = parentAgent?.session?.header
    const composedPreset = parentAgent?.ctx
      ? this.agentPresets?.composedPreset?.(parentAgent.ctx)
      : undefined
    const setup = async (agentCtx) => {
      if (parentAgent?.ctx) {
        this.agentPresets?.composeFrom?.(agentCtx, parentAgent.ctx)
      } else if (this.agentPresets?.mount) {
        await this.agentPresets.mount(agentCtx)
      }
      if (agentCtx?.systemPrompt?.section) {
        agentCtx.systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          text: role?.prompt || ''
        })
        agentCtx.systemPrompt.section({
          name: 'roundtable:protocol',
          order: 1,
          text: '你是圆桌讨论中的独立角色。只代表自己的专业视角，不要冒充用户或其他角色。'
        })
      }
      // Child roles may use the parent's tools, MCP and Skills, but must not
      // recursively create another roundtable from inside this roundtable.
      try { agentCtx?.tools?.restrict?.({ deny: ['multi_agent_discuss'] }) } catch { /* older runtimes keep the execute-time guard */ }
    }
    const meta = { origin: 'subagent' }
    if (state.parentSessionId) meta.parentSession = state.parentSessionId
    if (parentHeader?.cwd) meta.cwd = parentHeader.cwd
    if (composedPreset !== undefined) meta.agentPreset = composedPreset
    if (Number.isInteger(parentHeader?.delegationDepth)) meta.delegationDepth = parentHeader.delegationDepth + 1
    const options = {
      sessionId: participant.childSessionId,
      meta,
      agentOptions,
      setup
    }
    let handle
    if (state.restored && this.agents.resume) {
      handle = await this.agents.resume({ resumeSessionId: participant.childSessionId, agentOptions, setup })
    } else {
      const existing = this.agents?.get?.(participant.childSessionId)
      handle = existing
        ? { agent: existing, dispose: async () => existing.cancel?.({ kind: 'disposed' }) }
        : await this.agents.create(options)
    }
    participant.handle = handle
    participant.restored = false
    this.sessionIndex.set(participant.childSessionId, { state, participant })
    return handle
  }

  cancel(id, roleId = '') {
    const state = this.requireState(id)
    const participants = roleId ? state.participants.filter((participant) => participant.roleId === roleId) : state.participants
    if (participants.length === 0) throw new Error(`角色不存在：${roleId}`)
    for (const participant of participants) {
      participant.cancelled = true
      try { participant.handle?.agent?.cancel?.({ kind: 'user' }) } catch (error) { participant.error = errorMessage(error) }
      participant.status = 'cancelled'
    }
    if (roleId) {
      this.appendEvent(state, 'participant/cancelled', { roleId })
    } else {
      state.cancelled = true
      state.status = 'cancelled'
      this.appendEvent(state, 'discussion/cancelled', {})
    }
    this.schedulePersist()
    return this.toPublic(state)
  }

  remove(id) {
    const state = this.requireState(id)
    if (state.status === 'running') throw new Error('讨论运行中，不能删除。')
    for (const participant of state.participants) {
      this.sessionIndex.delete(participant.childSessionId)
      try { participant.handle?.dispose?.() } catch { /* removal keeps child logs but releases live handles */ }
    }
    this.listeners.delete(id)
    this.discussions.delete(id)
    this.schedulePersist()
  }

  onSessionEvent(session, event) {
    const sessionId = String(session?.id || session?.header?.id || '')
    const link = this.sessionIndex.get(sessionId)
    if (!link || !event) return
    const { state, participant } = link
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const summary = eventSummary(event)
    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk
      const delta = chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' ? chunk.text : ''
      if (delta) {
        const key = messageKey(data.turn, data.step)
        let message = state.messages.find((item) => item.streamKey === key && item.roleId === participant.roleId)
        if (!message) {
          message = {
            id: `stream-${participant.childSessionId}-${key}`,
            streamKey: key,
            roleId: participant.roleId,
            roleName: participant.roleName,
            color: participant.color,
            round: participant.activeRound || state.currentRound,
            content: '',
            reasoning: '',
            status: 'streaming',
            createdAt: nowValue(this.now),
            updatedAt: nowValue(this.now)
          }
          state.messages.push(message)
        }
        if (chunk?.type === 'reasoning-delta') message.reasoning += delta
        else message.content += delta
        message.updatedAt = nowValue(this.now)
        participant.status = 'running'
        this.appendEvent(state, 'message/stream', { roleId: participant.roleId, messageId: message.id, event: summary })
      }
      return
    }
    if (event.type === 'assistant/message') {
      const message = data.message
      const content = messageMarkdown(message)
      const reasoning = messageReasoning(message)
      const key = messageKey(data.turn, data.step)
      const existing = state.messages.find((item) => item.streamKey === key && item.roleId === participant.roleId)
      const projected = {
        id: String(message?.id || `message-${participant.childSessionId}-${key}`),
        roleId: participant.roleId,
        roleName: participant.roleName,
        color: participant.color,
        round: participant.activeRound || state.currentRound,
        content: shortText(content, 20000),
        reasoning: shortText(reasoning, 20000),
        status: 'complete',
        createdAt: existing?.createdAt || nowValue(this.now),
        updatedAt: nowValue(this.now),
        streamKey: key
      }
      if (existing) Object.assign(existing, projected)
      else state.messages.push(projected)
      if (state.messages.length > MAX_DISCUSSION_MESSAGES) state.messages.splice(0, state.messages.length - MAX_DISCUSSION_MESSAGES)
      participant.status = 'running'
      this.appendEvent(state, 'message/complete', {
        roleId: participant.roleId,
        messageId: projected.id,
        content: shortText(content, 20000),
        round: projected.round,
        event: summary
      })
      if (!state.restoringProjection) this.schedulePersist()
      return
    }
    if (event.type === 'turn/start') {
      participant.status = 'running'
      this.appendEvent(state, 'session/turn-start', { roleId: participant.roleId, event: summary })
    } else if (event.type === 'turn/end') {
      if (data.reason?.kind === 'error') {
        participant.turnError = errorMessage(data.reason.message || data.reason.error || data.reason)
        participant.error = participant.turnError
      }
      this.appendEvent(state, 'session/turn-end', { roleId: participant.roleId, event: summary })
    }
  }

  toPublic(state) {
    return {
      id: state.id,
      parentSessionId: state.parentSessionId,
      conversationId: state.conversationId,
      prompt: state.prompt,
      mode: state.mode,
      rounds: state.rounds,
      currentRound: state.currentRound,
      status: state.status,
      error: state.error,
      finalMessageId: state.finalMessageId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      participants: state.participants.map((participant) => ({
        roleId: participant.roleId,
        roleName: participant.roleName,
        color: participant.color,
        childSessionId: participant.childSessionId,
        status: participant.status,
        error: participant.error,
        activeRound: participant.activeRound
      })),
      messages: state.messages.map((message) => ({
        id: message.id,
        roleId: message.roleId,
        roleName: message.roleName,
        color: message.color,
        round: message.round,
        content: message.content,
        reasoning: message.reasoning || '',
        status: message.status,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      })),
      events: state.events.map((event) => ({ ...event })),
      lastEventId: state.nextEventId - 1
    }
  }

  async dispose() {
    this.disposed = true
    for (const state of this.discussions.values()) {
      state.cancelled = true
      for (const participant of state.participants) {
        try { participant.handle?.agent?.cancel?.({ kind: 'disposed' }) } catch { /* teardown is best effort */ }
      }
    }
    this.listeners.clear()
    this.sessionIndex.clear()
  }
}
