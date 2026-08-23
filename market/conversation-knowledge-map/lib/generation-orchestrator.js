import { randomUUID } from 'node:crypto'

import { validateKnowledgeGraph } from './knowledge-graph-schema.js'
import { validateMindMap } from './mind-map-schema.js'
import { clone, diagnosticSummary, errorMessage, logMessage, makeUserMessage, shortText } from './protocol.js'
import { chunkSourceText, readSelectedSurfaces } from './session-source.js'

const MAX_SUMMARY_CHARS = 2400

function modelLabel(selection) {
  const provider = String(selection?.provider || '').trim()
  const model = String(selection?.model || '').trim()
  return provider && model ? `${provider}/${model}` : 'default'
}

function logId(value) {
  const text = String(value || '')
  return text.length > 96 ? `${text.slice(0, 40)}…${text.slice(-40)}` : text
}

function phaseMessage(status) {
  return {
    confirming: '等待用户确认生成范围…',
    'reading-sources': '正在读取已确认的对话表面…',
    summarizing: '正在分段整理对话并保留来源…',
    'building-mind-map': '正在生成思维导图…',
    'building-knowledge-graph': '正在生成知识图谱…',
    validating: '正在校验结构化图数据…',
    saving: '正在原子保存工作区结果…',
    completed: '知识视图生成完成。',
    failed: '知识视图生成失败。',
    cancelled: '知识视图生成已取消。'
  }[status] || status
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const wrapperKeys = ['result', 'value', 'output', 'data', 'message', 'content', 'text']
    for (const key of wrapperKeys) {
      if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) return asObject(value[key])
    }
    if (wrapperKeys.some((key) => typeof value[key] === 'string')) return null
    return value
  }
  return null
}

function textFromContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((block) => {
      if (!block || typeof block !== 'object' || block.type === 'reasoning') return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.value === 'string') return block.value
      if (block.type === 'tool-result') return textFromContent(block.content)
      return ''
    }).filter(Boolean).join('\n\n')
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.value === 'string') return value.value
    for (const key of ['content', 'result', 'output', 'data', 'message']) {
      if (value[key] !== undefined) return textFromContent(value[key])
    }
  }
  return ''
}

function findJsonObject(text) {
  const candidates = []
  const fenced = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1])
  candidates.push(String(text || ''))
  for (const candidate of candidates) {
    for (let start = 0; start < candidate.length; start += 1) {
      if (candidate[start] !== '{') continue
      let depth = 0
      let inString = false
      let escaped = false
      for (let index = start; index < candidate.length; index += 1) {
        const char = candidate[index]
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') {
          inString = true
          continue
        }
        if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            const fragment = candidate.slice(start, index + 1)
            try {
              const parsed = JSON.parse(fragment)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
            } catch {
              // Try the next opening brace in case prose contained an example.
            }
            break
          }
        }
      }
    }
  }
  return null
}

export function parseStructuredOutput(value) {
  const object = asObject(value)
  if (object) return object
  const text = textFromContent(value).replace(/^\uFEFF/, '').trim()
  const parsed = findJsonObject(text)
  if (parsed) return parsed
  if (!text) throw new Error('模型没有返回 JSON 对象。')
  throw new Error('模型返回了文本，但其中没有可解析的 JSON 对象。')
}

function sourceRefsFromChunk(source, chunk) {
  const refs = chunk.sourceRefs?.length ? chunk.sourceRefs : (source.events || []).slice(0, 4).map((event) => ({
    sessionId: source.sessionId,
    eventSeqs: [event.seq]
  }))
  return refs
}

function sanitizeSourceRefs(refs, source, fallback) {
  const allowed = new Set((source.events || []).flatMap((event) => [event.seq, ...(event.sourceEventSeqs || [])]))
  const normalized = Array.isArray(refs) ? refs.map((ref) => ({
    sessionId: String(ref?.sessionId || ''),
    eventSeqs: Array.isArray(ref?.eventSeqs) ? [...new Set(ref.eventSeqs.filter((seq) => Number.isInteger(seq) && allowed.has(seq)))] : []
  })).filter((ref) => ref.sessionId === source.sessionId && ref.eventSeqs.length).slice(0, 12) : []
  return normalized.length ? normalized : fallback
}

function normalizeSummary(value, source, chunk) {
  const result = parseStructuredOutput(value)
  const summary = shortText(result.summary || result.narrative || result.text, MAX_SUMMARY_CHARS)
  if (!summary) throw new Error(`对话 ${source.sessionId} 的摘要为空。`)
  const keyPoints = Array.isArray(result.keyPoints)
    ? result.keyPoints.map((item) => shortText(item, 500)).filter(Boolean).slice(0, 12)
    : []
  const sourceRefs = sanitizeSourceRefs(result.sourceRefs, source, sourceRefsFromChunk(source, chunk))
  return {
    sessionId: source.sessionId,
    title: source.title,
    summary,
    keyPoints,
    sourceRefs
  }
}

function assertOutputSourceRefs(value, sources) {
  const allowed = new Map(sources.map((source) => [source.sessionId, new Set((source.events || []).flatMap((event) => [event.seq, ...(event.sourceEventSeqs || [])]))]))
  const check = (ref, label) => {
    const sessionId = String(ref?.sessionId || '')
    const seqs = allowed.get(sessionId)
    if (!seqs) throw new Error(`${label} 引用了未读取的来源 Session：${sessionId}`)
    for (const seq of ref.eventSeqs || []) if (!seqs.has(seq)) throw new Error(`${label} 引用了未读取的事件序号：${sessionId}/${seq}`)
  }
  for (const node of value?.mindMap?.nodes || []) for (const ref of node.sourceRefs || []) check(ref, `思维导图节点 ${node.id}`)
  for (const entity of value?.knowledgeGraph?.entities || []) for (const ref of entity.sourceRefs || []) check(ref, `知识图谱实体 ${entity.id}`)
  for (const relation of value?.knowledgeGraph?.relations || []) for (const ref of relation.evidence || []) check(ref, `知识图谱关系 ${relation.id}`)
}

function outputPrompt(kind, summaries, prompt, strict) {
  const rules = [
    '只输出一个 JSON 对象，不要 Markdown 代码围栏，不要额外解释。',
    '所有 sourceRefs/evidence 必须使用给定的 sessionId 和 eventSeqs，不能虚构来源。',
    strict ? '严格模式：没有直接来源的内容不要写成 confirmed 事实；知识图谱每条关系必须带 evidence。' : '对没有直接依据的内容使用 inferred 或 conflicted。'
  ]
  const context = JSON.stringify(summaries)
  if (kind === 'mind-map') {
    return [
      '请根据以下多个对话摘要生成阶段性思维导图。节点不是关键词，narrative 必须是至少一段完整说明，包含背景、当前认识和下一步/未决点。',
      'JSON 形状：{"rootId":"...","nodes":[{"id":"...","parentId":null,"type":"theme|stage|question|decision|solution|risk|conclusion","title":"...","narrative":"...","primarySourceSessionId":"...","sourceRefs":[{"sessionId":"...","eventSeqs":[1]}],"openQuestions":[]}]}。',
      ...rules,
      `额外要求：${shortText(prompt, 2000) || '没有额外要求。'}`,
      `对话摘要：${context}`
    ].join('\n\n')
  }
  return [
    '请根据以下多个对话摘要生成静态知识图谱。抽取实体、概念、模块、接口、决策、风险和外部系统，并只建立有依据的关系。',
    'JSON 形状：{"entities":[{"id":"...","type":"...","name":"...","summary":"...","confidence":"confirmed|inferred|conflicted","sourceRefs":[{"sessionId":"...","eventSeqs":[1]}]}],"relations":[{"id":"...","from":"...","to":"...","type":"depends_on|calls|supports|constrains|belongs_to|derived_from","confidence":"confirmed|inferred|conflicted","evidence":[{"sessionId":"...","eventSeqs":[1]}]}]}。',
    ...rules,
    `额外要求：${shortText(prompt, 2000) || '没有额外要求。'}`,
    `对话摘要：${context}`
  ].join('\n\n')
}

function summaryPrompt(source, chunk, strict) {
  return [
    '请把一段 DSH 对话整理成带来源的结构化摘要。不要复述完整聊天，不要添加对话中没有的事实。',
    '只输出 JSON：{"summary":"完整阶段性说明","keyPoints":["..."],"sourceRefs":[{"sessionId":"...","eventSeqs":[1]}]}。',
    strict ? '严格模式：每个关键点都要能回指给定事件。' : '允许标记尚未确认的冲突，但不能编造事件序号。',
    `Session：${source.sessionId}`,
    `标题：${source.title}`,
    `分段：${chunk.text}`
  ].join('\n\n')
}

function followUpPrompt(node, source, targetSessionId, strict) {
  return [
    '请根据思维导图节点和目标对话最近内容，形成一个用于继续原对话的推进问题。不要回答问题，不要自动发送。',
    '只输出 JSON：{"targetSessionId":"...","question":"...","alternatives":["..."],"reason":"..."}。',
    strict ? '问题必须只依赖节点、来源引用和目标对话，不得引入其他会话内容。' : '问题应优先推动验证、决策或下一步行动。',
    `节点：${JSON.stringify(node)}`,
    `目标对话：${targetSessionId}`,
    `目标对话最近内容：${shortText(source?.text, 5000)}`
  ].join('\n\n')
}

function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  return textFromContent(message.content) || textFromContent(message.text) || textFromContent(message.value) || textFromContent(message.message)
}

function extractAgentText(surface) {
  const events = Array.isArray(surface?.events) ? surface.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const text = messageText(data.message || data) || messageText(data)
      if (text) return text
    }
  }
  const chunks = events.filter((event) => event?.type === 'assistant/chunk').map((event) => {
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    return textFromContent(data.chunk || data.text || data.content)
  }).filter(Boolean)
  return chunks.join('')
}

async function readAgentText(sessionQuery, sessionId, signal, { logger, diagnostics } = {}) {
  const stats = diagnostics || { surfaceReads: 0, sessionReads: 0 }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error('生成已取消。')
    stats.surfaceReads += 1
    const surface = await sessionQuery?.readSurface?.(sessionId)
    const text = extractAgentText(surface)
    const eventCount = Array.isArray(surface?.events) ? surface.events.length : 0
    stats.lastSurfaceEventCount = eventCount
    stats.lastSurfaceShape = diagnosticSummary(surface)
    stats.lastSurfaceTextLength = text.length
    logMessage(logger, 'info', 'agent surface read session=%s attempt=%d events=%d extractedTextLength=%d shape=%s', logId(sessionId), attempt + 1, eventCount, text.length, stats.lastSurfaceShape)
    if (text.trim()) return text
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
  }
  if (typeof sessionQuery?.readSession === 'function') {
    stats.sessionReads += 1
    const log = await sessionQuery.readSession(sessionId)
    const text = extractAgentText(log)
    const eventCount = Array.isArray(log?.events) ? log.events.length : 0
    stats.lastSessionEventCount = eventCount
    stats.lastSessionShape = diagnosticSummary(log)
    stats.lastSessionTextLength = text.length
    logMessage(logger, 'info', 'agent session read session=%s events=%d extractedTextLength=%d shape=%s', logId(sessionId), eventCount, text.length, stats.lastSessionShape)
    if (text.trim()) return text
  }
  return ''
}

function normalizeModelSelection(value) {
  if (value === undefined || value === null || value === '') return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型选择必须是包含 Provider 和 Model 的对象。')
  const provider = String(value.provider || '').trim()
  const model = String(value.model || '').trim()
  if (!provider && !model) return null
  if (!provider || !model) throw new Error('Provider 和 Model 必须同时填写。')
  return { provider, model }
}

export class KnowledgeGenerationOrchestrator {
  constructor({
    sessionQuery,
    sessions,
    agents,
    agentDefaultModel,
    storage,
    modelRunner,
    sessionEventSource,
    logger,
    sourceReader = readSelectedSurfaces,
    now = () => Date.now(),
    idFactory = () => randomUUID()
  } = {}) {
    this.sessionQuery = sessionQuery
    this.sessions = sessions
    this.agents = agents
    this.agentDefaultModel = agentDefaultModel
    this.storage = storage
    this.modelRunner = modelRunner
    this.sessionEventSource = sessionEventSource
    this.logger = logger
    this.sourceReader = sourceReader
    this.now = now
    this.idFactory = idFactory
    this.tasks = new Map()
    this.busyByWorkspace = new Map()
  }

  taskView(task) {
    return {
      id: task.id,
      status: task.status,
      message: task.message,
      phase: task.status,
      error: task.error || '',
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      revision: task.revision || 0,
      result: task.result ? clone(task.result) : null,
      events: task.events.slice(-40)
    }
  }

  get(id) {
    const task = this.tasks.get(String(id || ''))
    return task ? this.taskView(task) : null
  }

  subscribe(id, listener, since = 0) {
    const task = this.tasks.get(String(id || ''))
    if (!task) return null
    for (const event of task.events) if (event.id > since) listener(event, this.taskView(task))
    task.listeners.add(listener)
    return () => task.listeners.delete(listener)
  }

  update(task, status, extra = {}) {
    task.status = status
    task.message = phaseMessage(status)
    task.updatedAt = this.now()
    Object.assign(task, extra)
    const event = { id: task.nextEventId++, status, message: task.message, at: task.updatedAt, ...extra }
    task.events.push(event)
    if (task.events.length > 120) task.events.splice(0, task.events.length - 120)
    for (const listener of task.listeners) {
      try { listener(event, this.taskView(task)) } catch { /* UI observers cannot break generation */ }
    }
  }

  start(request) {
    const key = String(request.cwd || '').toLowerCase()
    if (this.busyByWorkspace.has(key)) throw new Error('当前工作路径已有生成任务在运行，请先取消或等待完成。')
    const task = {
      id: this.idFactory(),
      status: 'created',
      message: phaseMessage('created'),
      error: '',
      result: null,
      revision: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      nextEventId: 1,
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      promise: null
    }
    this.tasks.set(task.id, task)
    this.busyByWorkspace.set(key, task.id)
    logMessage(this.logger, 'info', 'generation start id=%s cwd=%s outputMode=%s selectedSessions=%d strict=%s model=%s', logId(task.id), shortText(request.cwd, 180), request.outputMode, Array.isArray(request.selectedSessionIds) ? request.selectedSessionIds.length : 0, request.strict === true, modelLabel(request.model))
    this.update(task, 'created', { request: { ...request, prompt: shortText(request.prompt, 500) } })
    task.promise = this.run(task, request).finally(() => {
      if (this.busyByWorkspace.get(key) === task.id) this.busyByWorkspace.delete(key)
    })
    return this.taskView(task)
  }

  cancel(id) {
    const task = this.tasks.get(String(id || ''))
    if (!task) throw new Error('生成任务不存在。')
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return this.taskView(task)
    task.controller.abort(new Error('用户取消了生成。'))
    return this.taskView(task)
  }

  assertNotCancelled(task) {
    if (task.controller.signal.aborted) throw task.controller.signal.reason || new Error('生成已取消。')
  }

  async run(task, request) {
    try {
      this.update(task, 'reading-sources')
      const sources = await this.sourceReader({ sessionQuery: this.sessionQuery, sessions: this.sessions }, {
        cwd: request.cwd,
        sessionIds: request.selectedSessionIds,
        includeSubagents: request.includeSubagents === true
      })
      this.assertNotCancelled(task)
      logMessage(this.logger, 'info', 'generation sources loaded id=%s sources=%d events=%d', logId(task.id), sources.length, sources.reduce((total, source) => total + (Array.isArray(source.events) ? source.events.length : 0), 0))
      this.update(task, 'summarizing', { sourceCount: sources.length })
      const summaries = []
      for (const source of sources) {
        for (const chunk of chunkSourceText(source)) {
          this.assertNotCancelled(task)
          const value = await this.runModel({
            kind: 'summary',
            prompt: summaryPrompt(source, chunk, request.strict === true),
            cwd: request.cwd,
            strict: request.strict === true,
            selectedSessionIds: request.selectedSessionIds,
            model: request.model,
            signal: task.controller.signal
          })
          summaries.push(normalizeSummary(value, source, chunk))
        }
      }
      this.assertNotCancelled(task)
      let mindMap = null
      let knowledgeGraph = null
      if (request.outputMode === 'mind-map' || request.outputMode === 'both') {
        this.update(task, 'building-mind-map')
        const value = await this.runModel({
          kind: 'mind-map',
          prompt: outputPrompt('mind-map', summaries, request.prompt, request.strict === true),
          cwd: request.cwd,
          strict: request.strict === true,
          selectedSessionIds: request.selectedSessionIds,
          model: request.model,
          signal: task.controller.signal
        })
        mindMap = validateMindMap(value, { selectedSessionIds: request.selectedSessionIds, strict: request.strict === true })
      }
      if (request.outputMode === 'knowledge-graph' || request.outputMode === 'both') {
        this.update(task, 'building-knowledge-graph')
        const value = await this.runModel({
          kind: 'knowledge-graph',
          prompt: outputPrompt('knowledge-graph', summaries, request.prompt, request.strict === true),
          cwd: request.cwd,
          strict: request.strict === true,
          selectedSessionIds: request.selectedSessionIds,
          model: request.model,
          signal: task.controller.signal
        })
        knowledgeGraph = validateKnowledgeGraph(value, { selectedSessionIds: request.selectedSessionIds, strict: request.strict === true })
      }
      assertOutputSourceRefs({ mindMap, knowledgeGraph }, sources)
      this.assertNotCancelled(task)
      this.update(task, 'validating')
      this.update(task, 'saving')
      const saved = await this.storage.saveBundle({
        cwd: request.cwd,
        expectedRevision: request.expectedRevision,
        generationId: task.id,
        sourceSessionIds: request.selectedSessionIds,
        prompt: request.prompt,
        strict: request.strict,
        outputMode: request.outputMode,
        model: request.model,
        mindMap,
        knowledgeGraph
      })
      task.revision = saved.revision
      task.result = { revision: saved.revision, manifest: saved.manifest, mindMap, knowledgeGraph }
      logMessage(this.logger, 'info', 'generation completed id=%s revision=%d elapsedMs=%d', logId(task.id), saved.revision, this.now() - task.createdAt)
      this.update(task, 'completed', { revision: saved.revision, result: task.result })
    } catch (error) {
      if (task.controller.signal.aborted || /取消|cancel/i.test(errorMessage(error))) {
        this.update(task, 'cancelled', { error: '' })
      } else {
        logMessage(this.logger, 'error', 'generation failed id=%s status=%s error=%s', logId(task.id), task.status, errorMessage(error))
        this.update(task, 'failed', { error: errorMessage(error) })
      }
    }
    return this.taskView(task)
  }

  async runModel(input) {
    const parseModelOutput = (value, source, diagnostics = {}) => {
      try {
        const result = parseStructuredOutput(value)
        logMessage(this.logger, 'info', 'agent output parsed kind=%s source=%s value=%s result=%s', input.kind, source, diagnosticSummary(value), diagnosticSummary(result))
        return result
      } catch (error) {
        logMessage(this.logger, 'error', 'agent output parse failed kind=%s source=%s value=%s diagnostics=%s error=%s', input.kind, source, diagnosticSummary(value), JSON.stringify(diagnostics), errorMessage(error))
        throw error
      }
    }
    if (typeof this.modelRunner === 'function') {
      logMessage(this.logger, 'info', 'model runner start kind=%s model=%s promptLength=%d', input.kind, modelLabel(input.model), String(input.prompt || '').length)
      const value = await this.modelRunner(input)
      return parseModelOutput(value, 'model-runner')
    }
    if (!this.agents?.create) throw new Error('当前 DSH Runtime 未提供 agents.create，无法生成知识视图。')
    let selection = normalizeModelSelection(input.model)
    if (!selection) {
      try {
        selection = normalizeModelSelection(this.agentDefaultModel?.currentSelection?.())
      } catch (error) {
        logMessage(this.logger, 'warn', 'default model selection failed kind=%s error=%s', input.kind, shortText(errorMessage(error), 500))
        selection = null
      }
    }
    const provider = String(selection?.provider || '').trim()
    const model = String(selection?.model || '').trim()
    if (!provider || !model) {
      logMessage(this.logger, 'error', 'agent call has no usable model kind=%s requestedModel=%s defaultModel=%s', input.kind, modelLabel(input.model), modelLabel(selection))
      throw new Error('当前没有可用的默认 Provider/Model。')
    }
    const sessionId = `knowledge-map-${this.idFactory()}`
    const liveEvents = []
    const diagnostics = {
      liveEvents: 0,
      liveAssistantMessages: 0,
      liveAssistantChunks: 0,
      liveOtherEvents: 0,
      surfaceReads: 0,
      sessionReads: 0,
      lastSurfaceEventCount: 0,
      lastSessionEventCount: 0
    }
    logMessage(this.logger, 'info', 'agent call start kind=%s session=%s provider=%s model=%s promptLength=%d', input.kind, logId(sessionId), provider, model, String(input.prompt || '').length)
    let unsubscribe
    if (typeof this.sessionEventSource === 'function') {
      try {
        unsubscribe = this.sessionEventSource((session, event) => {
          const eventSessionId = String(session?.id || session?.header?.id || '')
          if (eventSessionId !== sessionId || !event) return
          liveEvents.push(event)
          diagnostics.liveEvents += 1
          if (event.type === 'assistant/message') diagnostics.liveAssistantMessages += 1
          else if (event.type === 'assistant/chunk') diagnostics.liveAssistantChunks += 1
          else diagnostics.liveOtherEvents += 1
          logMessage(this.logger, 'info', 'agent event session=%s type=%s data=%s', logId(sessionId), String(event.type || 'unknown'), diagnosticSummary(event.data))
        })
        logMessage(this.logger, 'info', 'agent event subscription ready session=%s', logId(sessionId))
      } catch (error) {
        logMessage(this.logger, 'warn', 'agent event subscription failed session=%s error=%s', logId(sessionId), errorMessage(error))
      }
    }
    let handle
    try {
      handle = await this.agents.create({
        sessionId,
        meta: { cwd: input.cwd, origin: 'subagent' },
        agentOptions: { provider, model, maxTokens: input.kind === 'summary' ? 2500 : 6000 },
        signal: input.signal,
        setup: async (agentCtx) => {
          agentCtx?.systemPrompt?.section?.({
            name: 'knowledge-map:protocol',
            order: 0,
            text: '你是 DSH 知识视图生成器。只输出调用方要求的 JSON；不要调用外部网络、文件写入或其他 Agent 工具。'
          })
          try {
            agentCtx?.tools?.restrict?.({ deny: ['multi_agent_discuss', 'shell', 'filesystem', 'web_search', 'browser'] })
          } catch { /* older runtimes may not expose tool restriction */ }
        }
      })
      handle.agent.followup(makeUserMessage(input.prompt, `${sessionId}-${input.kind}`))
      await handle.agent.whenIdle()
      const liveText = extractAgentText({ events: liveEvents })
      logMessage(this.logger, 'info', 'agent idle session=%s liveEvents=%d assistantMessages=%d assistantChunks=%d otherEvents=%d liveTextLength=%d', logId(sessionId), diagnostics.liveEvents, diagnostics.liveAssistantMessages, diagnostics.liveAssistantChunks, diagnostics.liveOtherEvents, liveText.length)
      if (liveText.trim()) return parseModelOutput(liveText, 'live-events', diagnostics)
      const persistedText = await readAgentText(this.sessionQuery, sessionId, input.signal, { logger: this.logger, diagnostics })
      logMessage(this.logger, 'info', 'agent persisted output session=%s textLength=%d surfaceReads=%d sessionReads=%d', logId(sessionId), persistedText.length, diagnostics.surfaceReads, diagnostics.sessionReads)
      return parseModelOutput(persistedText, 'persisted-session', diagnostics)
    } catch (error) {
      logMessage(this.logger, 'error', 'agent call failed kind=%s session=%s liveEvents=%d surfaceReads=%d sessionReads=%d error=%s', input.kind, logId(sessionId), diagnostics.liveEvents, diagnostics.surfaceReads, diagnostics.sessionReads, errorMessage(error))
      throw error
    } finally {
      if (typeof unsubscribe === 'function') await unsubscribe()
      await handle?.dispose?.()
      logMessage(this.logger, 'info', 'agent call disposed kind=%s session=%s', input.kind, logId(sessionId))
    }
  }

  async formFollowUp({ cwd, node, targetSessionId, strict = true, model, signal }) {
    const sources = await this.sourceReader({ sessionQuery: this.sessionQuery, sessions: this.sessions }, {
      cwd,
      sessionIds: [targetSessionId],
      includeSubagents: false
    })
    const value = await this.runModel({
      kind: 'follow-up',
      prompt: followUpPrompt(node, sources[0], targetSessionId, strict),
      cwd,
      strict,
      selectedSessionIds: [targetSessionId],
      model,
      signal
    })
    const result = parseStructuredOutput(value)
    const question = shortText(result.question, 2000)
    if (!question) throw new Error('模型没有形成后续问题。')
    return {
      targetSessionId,
      question,
      alternatives: Array.isArray(result.alternatives) ? result.alternatives.map((item) => shortText(item, 500)).filter(Boolean).slice(0, 2) : [],
      reason: shortText(result.reason, 800)
    }
  }
}
