import { randomUUID } from 'node:crypto'

import { validateKnowledgeGraph } from './knowledge-graph-schema.js'
import { validateMindMap } from './mind-map-schema.js'
import { clone, errorMessage, makeUserMessage, shortText } from './protocol.js'
import { chunkSourceText, readSelectedSurfaces } from './session-source.js'

const MAX_SUMMARY_CHARS = 2400

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
  if (value && typeof value === 'object') {
    if (value.result && typeof value.result === 'object') return value.result
    if (value.value && typeof value.value === 'object') return value.value
    return value
  }
  return null
}

export function parseStructuredOutput(value) {
  const object = asObject(value)
  if (object) return object
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象。')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    throw new Error(`模型 JSON 无法解析：${error.message}`)
  }
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

function extractAgentText(surface) {
  const events = Array.isArray(surface?.events) ? surface.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') {
      const message = event.data?.message || event.data || {}
      const content = message.content
      if (Array.isArray(content)) return content.filter((block) => block?.type !== 'reasoning').map((block) => block?.text || block?.value || '').join('')
      if (typeof content === 'string') return content
    }
  }
  return ''
}

export class KnowledgeGenerationOrchestrator {
  constructor({
    sessionQuery,
    sessions,
    agents,
    agentDefaultModel,
    storage,
    modelRunner,
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
      this.update(task, 'completed', { revision: saved.revision, result: task.result })
    } catch (error) {
      if (task.controller.signal.aborted || /取消|cancel/i.test(errorMessage(error))) {
        this.update(task, 'cancelled', { error: '' })
      } else {
        this.update(task, 'failed', { error: errorMessage(error) })
      }
    }
    return this.taskView(task)
  }

  async runModel(input) {
    if (typeof this.modelRunner === 'function') return parseStructuredOutput(await this.modelRunner(input))
    if (!this.agents?.create) throw new Error('当前 DSH Runtime 未提供 agents.create，无法生成知识视图。')
    let selection = {}
    try { selection = this.agentDefaultModel?.currentSelection?.() || {} } catch { selection = {} }
    const provider = String(selection.provider || '').trim()
    const model = String(selection.model || '').trim()
    if (!provider || !model) throw new Error('当前没有可用的默认 Provider/Model。')
    const sessionId = `knowledge-map-${this.idFactory()}`
    const handle = await this.agents.create({
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
    try {
      handle.agent.followup(makeUserMessage(input.prompt, `${sessionId}-${input.kind}`))
      await handle.agent.whenIdle()
      const surface = await this.sessionQuery?.readSurface?.(sessionId)
      return parseStructuredOutput(extractAgentText(surface))
    } finally {
      await handle.dispose?.()
    }
  }

  async formFollowUp({ cwd, node, targetSessionId, strict = true, signal }) {
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
