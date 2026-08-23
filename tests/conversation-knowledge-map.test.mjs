import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

import { createHost } from '../market/conversation-knowledge-map/lib/index.js'
import { KnowledgeGenerationOrchestrator, parseStructuredOutput } from '../market/conversation-knowledge-map/lib/generation-orchestrator.js'
import { KnowledgeGraphValidationError, validateKnowledgeGraph } from '../market/conversation-knowledge-map/lib/knowledge-graph-schema.js'
import { MindMapValidationError, validateMindMap } from '../market/conversation-knowledge-map/lib/mind-map-schema.js'
import { listWorkspaceSessions, readSelectedSurfaces } from '../market/conversation-knowledge-map/lib/session-source.js'
import { WorkspaceRevisionError, WorkspaceStorage } from '../market/conversation-knowledge-map/lib/workspace-storage.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const text = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

function record(id, cwd, createdAt, origin = '') {
  return { header: { id, cwd, createdAt, origin } }
}

function sourceRefs(sessionId = 'session-1', eventSeq = 1) {
  return [{ sessionId, eventSeqs: [eventSeq] }]
}

function validMindMap(sessionId = 'session-1') {
  return {
    rootId: 'root',
    nodes: [
      {
        id: 'root',
        parentId: null,
        type: 'theme',
        title: '阶段主题',
        narrative: '这是一个有背景、当前认识和下一步的阶段性说明。',
        primarySourceSessionId: sessionId,
        sourceRefs: sourceRefs(sessionId),
        openQuestions: ['下一步如何验证？']
      },
      {
        id: 'decision',
        parentId: 'root',
        type: 'decision',
        title: '当前决策',
        narrative: '当前已经形成一个有来源依据的决策，并且仍然保留验证路径。',
        primarySourceSessionId: sessionId,
        sourceRefs: sourceRefs(sessionId, 2)
      }
    ]
  }
}

function validGraph(sessionId = 'session-1') {
  return {
    entities: [
      { id: 'runtime', type: 'module', name: 'DSH Runtime', summary: '负责提供会话与插件运行时能力。', confidence: 'confirmed', sourceRefs: sourceRefs(sessionId) },
      { id: 'view', type: 'feature', name: '知识视图', summary: '展示思维导图和静态知识图谱。', confidence: 'inferred', sourceRefs: sourceRefs(sessionId, 2) }
    ],
    relations: [
      { id: 'runtime-view', from: 'runtime', to: 'view', type: 'supports', confidence: 'confirmed', evidence: sourceRefs(sessionId, 1) }
    ]
  }
}

function makeSurface(id, cwd, title = id) {
  return {
    session: { id, cwd },
    capturedThroughSeq: 4,
    title,
    events: [
      { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: `用户提出 ${id} 的问题。` }] } } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '内部推理不应进入知识视图。' }, { type: 'text', text: `助手给出 ${id} 的阶段性结论。` }] } } },
      { seq: 3, type: 'tool/result', data: { text: '内部工具细节不应直接成为来源正文。' } }
    ]
  }
}

function makeResponse() {
  let status = 200
  let body = null
  const response = {
    writeHead(code) { status = code },
    end(value) { body = value ? JSON.parse(value) : null },
    write() {},
    on() {}
  }
  return {
    response,
    get result() { return { status, body } }
  }
}

function makeRequest(method, url, body) {
  return { method, url, body, on() {} }
}

async function waitForGeneration(orchestrator, id) {
  const task = orchestrator.tasks.get(id)
  assert.ok(task, `generation ${id} should exist`)
  await task.promise
  return orchestrator.get(id)
}

test('knowledge-map package exposes the host/client contract and safety boundaries', () => {
  const manifest = JSON.parse(text('market/conversation-knowledge-map/package.json'))
  const catalog = JSON.parse(text('market/catalog-v1.json'))
  const patch = text('market/conversation-knowledge-map/cordis.patch.yml')
  const host = text('market/conversation-knowledge-map/lib/index.js')
  const client = text('market/conversation-knowledge-map/lib/client.js')
  const skill = text('market/conversation-knowledge-map/skills/conversation-knowledge-map/SKILL.md')

  assert.equal(manifest.name, '@p-dsh-market/conversation-knowledge-map')
  assert.ok(catalog.packages.includes(manifest.name))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.protocolVersion, 1)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.market.capabilities.sort(), ['client', 'desktop-shell', 'host', 'skills'])
  assert.deepEqual(manifest.dsh.desktop.permissions.sort(), ['shell:page', 'shell:titlebar', 'workspace:read', 'workspace:write-plugin-data'])
  assert.equal(manifest.dsh.desktop.contributes.titlebarActions[0].action.method, 'conversationKnowledgeMap.open')
  assert.match(patch, /inject: \[agentDefaultModel, agents, llm, sessionQuery, sessions, skills, webServer\]/)
  assert.match(host, /POST.*confirm|path\[0\] === 'confirm'/s)
  assert.match(host, /listWorkspaceSessions/)
  assert.match(host, /WorkspaceRevisionError/)
  assert.match(host, /loggerFacade/)
  assert.match(host, /route failed/)
  assert.match(client, /name: 'conversation\.view', id: 'conversation-knowledge-map'/)
  assert.match(client, /name: 'conversation\.session\.header\.actions', id: 'conversation-knowledge-map'/)
  assert.match(client, /name: 'shell\.overlay', id: 'conversation-knowledge-map'/)
  assert.match(client, /conversationKnowledgeMap\.open/)
  assert.match(client, /知识图谱是静态结果/)
  assert.match(client, /不会自动发送/)
  assert.doesNotMatch(client, /dangerouslySetInnerHTML/)
  assert.match(skill, /用户明确点击确认后/)
  assert.match(skill, /readSurface/)
  assert.match(skill, /知识图谱是静态结果/)
})

test('session source lists same-workspace conversations and reads only selected surfaces', async () => {
  const cwd = 'D:\\Code\\knowledge-workspace'
  const otherCwd = 'D:\\Code\\other-workspace'
  const records = [
    record('session-1', cwd, 30),
    record('session-2', cwd, 20, 'subagent'),
    record('session-3', otherCwd, 40)
  ]
  const surfaces = {
    'session-1': makeSurface('session-1', cwd, '主对话')
  }
  const calls = []
  const sessionQuery = {
    async filterSessions(filters) {
      calls.push({ method: 'filterSessions', filters })
      const filter = filters[0]
      if (filter.kind === 'cwd') return records
      return records.filter((item) => filter.values.includes(item.header.id))
    },
    async readTitleSnapshots(ids) {
      calls.push({ method: 'readTitleSnapshots', ids })
      return ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: id === 'session-1' ? '主对话标题' : '子 Agent 标题' } }))
    },
    async readSurface(id) {
      calls.push({ method: 'readSurface', id })
      return surfaces[id]
    }
  }

  const visible = await listWorkspaceSessions({ sessionQuery }, cwd, 'session-1', false)
  assert.deepEqual(visible.map((item) => item.id), ['session-1'])
  assert.equal(visible[0].title, '主对话标题')
  const withSubagents = await listWorkspaceSessions({ sessionQuery }, cwd, 'session-1', true)
  assert.deepEqual(withSubagents.map((item) => item.id), ['session-1', 'session-2'])

  const sources = await readSelectedSurfaces({ sessionQuery }, { cwd, sessionIds: ['session-1'] })
  assert.equal(sources.length, 1)
  assert.equal(sources[0].title, '主对话标题')
  assert.match(sources[0].text, /用户提出 session-1 的问题/)
  assert.match(sources[0].text, /助手给出 session-1 的阶段性结论/)
  assert.doesNotMatch(sources[0].text, /内部推理/)
  assert.doesNotMatch(sources[0].text, /内部工具细节/)
  assert.ok(calls.some((call) => call.method === 'readSurface'))

  await assert.rejects(
    readSelectedSurfaces({ sessionQuery }, { cwd, sessionIds: ['session-2'] }),
    /不能选择子 Agent/
  )
  await assert.rejects(
    readSelectedSurfaces({ sessionQuery }, { cwd, sessionIds: ['session-3'] }),
    /不属于当前工作路径/
  )
})

test('mind-map and knowledge-graph schemas reject unsupported or untraceable structures', () => {
  const mindMap = validateMindMap(validMindMap(), { selectedSessionIds: ['session-1'], strict: true })
  assert.equal(mindMap.schemaVersion, 1)
  assert.deepEqual(mindMap.edges, [{ from: 'root', to: 'decision' }])

  assert.throws(() => validateMindMap({ rootId: 'root', nodes: [{ id: 'root', parentId: null, title: '短', narrative: '关键词' }] }), MindMapValidationError)
  assert.throws(() => validateMindMap({ rootId: 'root', nodes: [
    { id: 'root', parentId: null, title: '根', narrative: '这是一个足够长的根节点说明，用于覆盖合法根节点。' },
    { id: 'a', parentId: 'b', title: 'A', narrative: '这是一个足够长的阶段性说明，用来触发循环校验。' },
    { id: 'b', parentId: 'a', title: 'B', narrative: '这是另一个足够长的阶段性说明，用来触发循环校验。' }
  ] }), /循环/)
  assert.throws(() => validateMindMap({ rootId: 'root', nodes: [{ id: 'root', parentId: null, title: '根', narrative: '这是一个足够长但没有任何来源的节点说明。' }] }, { strict: true }), /来源引用/)

  const graph = validateKnowledgeGraph(validGraph(), { selectedSessionIds: ['session-1'], strict: true })
  assert.equal(graph.schemaVersion, 1)
  assert.equal(graph.relations[0].evidence[0].sessionId, 'session-1')
  assert.throws(() => validateKnowledgeGraph({ entities: validGraph().entities, relations: [{ from: 'runtime', to: 'missing', type: 'calls' }] }), KnowledgeGraphValidationError)
  assert.throws(() => validateKnowledgeGraph({ entities: [{ id: 'x', name: 'X', summary: '实体摘要', sourceRefs: [] }], relations: [] }, { strict: true }), /来源引用/)
  assert.throws(() => validateKnowledgeGraph({ entities: validGraph().entities, relations: [{ from: 'runtime', to: 'view', type: 'supports' }] }, { strict: true }), /证据/)
})

test('workspace storage atomically persists versioned results and bounded navigation metadata', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-storage-'))
  try {
    const storage = new WorkspaceStorage({ now: () => 1700000000000 })
    const saved = await storage.saveBundle({
      cwd,
      expectedRevision: 0,
      generationId: 'generation-1',
      sourceSessionIds: ['session-1'],
      prompt: '这是用于验证持久化的额外要求。',
      strict: true,
      outputMode: 'both',
      model: { provider: 'test-provider', model: 'test-model' },
      mindMap: validMindMap(),
      knowledgeGraph: validGraph()
    })
    assert.equal(saved.revision, 1)
    const state = await storage.readState(cwd)
    assert.equal(state.exists, true)
    assert.equal(state.revision, 1)
    assert.equal(state.compatibility.supported, true)
    assert.equal(state.manifest.generationId, 'generation-1')
    assert.equal(state.mindMap.nodes.length, 2)
    assert.equal(state.knowledgeGraph.entities.length, 2)
    assert.equal(state.navigationHistory.length, 0)

    await assert.rejects(
      storage.saveBundle({ cwd, expectedRevision: 0, generationId: 'stale', sourceSessionIds: ['session-1'], outputMode: 'mind-map', mindMap: validMindMap(), knowledgeGraph: null }),
      WorkspaceRevisionError
    )
    const navigation = await storage.appendNavigation({
      cwd,
      expectedRevision: 1,
      navigation: { id: 'navigation-1', nodeId: 'decision', targetSessionId: 'session-1', question: '请在原对话中验证这个决策的下一步。' }
    })
    assert.equal(navigation.navigation.id, 'navigation-1')
    const afterNavigation = await storage.readState(cwd)
    assert.equal(afterNavigation.revision, 1)
    assert.equal(afterNavigation.navigationHistory[0].questionSummary, '请在原对话中验证这个决策的下一步。')
    assert.equal(afterNavigation.manifest.promptSummary, '这是用于验证持久化的额外要求。')
    assert.doesNotMatch(JSON.stringify(afterNavigation.navigationHistory), /用户提出|助手给出/)

    const files = await readdir(state.dataDir)
    assert.deepEqual(files.sort(), ['knowledge-graph.json', 'manifest.json', 'mind-map.json', 'navigation-history.json'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('workspace storage exposes a re-generation prompt for legacy schema data', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-legacy-'))
  try {
    const dataDir = join(cwd, '.g-dsh-market-knowledge')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'manifest.json'), JSON.stringify({ schemaVersion: 0, revision: 7, cwd }), 'utf8')
    await writeFile(join(dataDir, 'mind-map.json'), JSON.stringify({ old: true }), 'utf8')
    const state = await new WorkspaceStorage().readState(cwd)
    assert.equal(state.exists, true)
    assert.equal(state.compatibility.supported, false)
    assert.equal(state.compatibility.state, 'legacy')
    assert.match(state.compatibility.message, /重新生成/)
    assert.equal(state.mindMap, null)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('orchestrator does not write before generation, validates model output, and persists both views', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-orchestrator-'))
  try {
    const storage = new WorkspaceStorage({ now: () => 1700000000100 })
    const calls = []
    const modelSelections = []
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage,
      sourceReader: async () => [{
        sessionId: 'session-1',
        title: '主对话',
        events: [{ seq: 1, text: '阶段性问题', role: 'user' }, { seq: 2, text: '阶段性结论', role: 'assistant' }],
        text: '用户：阶段性问题'
      }],
      modelRunner: async (input) => {
        calls.push(input.kind)
        modelSelections.push(input.model)
        if (input.kind === 'summary') return { summary: '这是一个带有背景和下一步的完整对话摘要。', keyPoints: ['保留来源'], sourceRefs: sourceRefs() }
        if (input.kind === 'mind-map') return validMindMap()
        if (input.kind === 'knowledge-graph') return validGraph()
        throw new Error(`unexpected kind: ${input.kind}`)
      },
      idFactory: () => 'generation-both',
      now: () => 1700000000100
    })
    assert.equal((await storage.readState(cwd)).exists, false)
    const started = orchestrator.start({
      cwd,
      selectedSessionIds: ['session-1'],
      outputMode: 'both',
      prompt: '请保留来源。',
      strict: true,
      includeSubagents: false,
      expectedRevision: 0,
      model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(calls, ['summary', 'mind-map', 'knowledge-graph'])
    assert.deepEqual(modelSelections, [
      { provider: 'test-provider', model: 'test-model' },
      { provider: 'test-provider', model: 'test-model' },
      { provider: 'test-provider', model: 'test-model' }
    ])
    const state = await storage.readState(cwd)
    assert.equal(state.revision, 1)
    assert.equal(state.manifest.generationId, 'generation-both')
    assert.deepEqual(state.manifest.model, { provider: 'test-provider', model: 'test-model' })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('agent runner waits for the assistant surface and extracts structured text from runtime message variants', async () => {
  let reads = 0
  let createOptions
  const orchestrator = new KnowledgeGenerationOrchestrator({
    idFactory: () => 'agent-output',
    agentDefaultModel: { currentSelection() { return { provider: 'default-provider', model: 'default-model' } } },
    agents: {
      async create(options) {
        createOptions = options
        return {
          agent: { followup() {}, async whenIdle() {} },
          async dispose() {}
        }
      }
    },
    sessionQuery: {
      async readSurface() {
        reads += 1
        if (reads === 1) return { events: [] }
        return {
          events: [{
            type: 'assistant/message',
            data: { message: { text: `结果如下：\n\n\`\`\`JSON\n${JSON.stringify({ ok: true, nested: { value: 1 } })}\n\`\`\`` } }
          }]
        }
      }
    }
  })
  const result = await orchestrator.runModel({
    kind: 'summary',
    prompt: '输出 JSON',
    cwd: 'D:\\Code\\knowledge-workspace',
    model: { provider: 'chosen-provider', model: 'chosen-model' }
  })
  assert.deepEqual(result, { ok: true, nested: { value: 1 } })
  assert.equal(reads, 2)
  assert.deepEqual(createOptions.agentOptions, { provider: 'chosen-provider', model: 'chosen-model', maxTokens: 2500 })
})

test('agent runner consumes live session events before querying the persisted surface', async () => {
  let publish
  let surfaceReads = 0
  const logs = []
  const logger = {
    info(format, ...params) { logs.push(['info', format, ...params]) },
    warn(format, ...params) { logs.push(['warn', format, ...params]) },
    error(format, ...params) { logs.push(['error', format, ...params]) }
  }
  const orchestrator = new KnowledgeGenerationOrchestrator({
    idFactory: () => 'live-output',
    logger,
    sessionEventSource(listener) {
      publish = listener
      return () => {}
    },
    agents: {
      async create() {
        return {
          agent: {
            followup() {
              publish({ id: 'knowledge-map-live-output' }, {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: '{"ok":true}' }] } }
              })
            },
            async whenIdle() {}
          },
          async dispose() {}
        }
      }
    },
    sessionQuery: {
      async readSurface() {
        surfaceReads += 1
        return { events: [] }
      }
    }
  })
  const result = await orchestrator.runModel({
    kind: 'mind-map',
    prompt: '输出 JSON',
    cwd: 'D:\\Code\\knowledge-workspace',
    model: { provider: 'chosen-provider', model: 'chosen-model' }
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(surfaceReads, 0)
  const serializedLogs = JSON.stringify(logs)
  assert.match(serializedLogs, /agent event/)
  assert.match(serializedLogs, /agent idle/)
  assert.doesNotMatch(serializedLogs, /\{"ok":true\}/)
})

test('agent runner logs empty output diagnostics without logging model content', async () => {
  const logs = []
  const logger = {
    info(format, ...params) { logs.push(['info', format, ...params]) },
    warn(format, ...params) { logs.push(['warn', format, ...params]) },
    error(format, ...params) { logs.push(['error', format, ...params]) }
  }
  const orchestrator = new KnowledgeGenerationOrchestrator({
    idFactory: () => 'empty-output',
    logger,
    agents: {
      async create() {
        return { agent: { followup() {}, async whenIdle() {} }, async dispose() {} }
      }
    },
    sessionQuery: {
      async readSurface() { return { events: [] } },
      async readSession() { return { events: [] } }
    }
  })
  await assert.rejects(
    orchestrator.runModel({ kind: 'summary', prompt: '输出 JSON', cwd: 'D:\\Code\\knowledge-workspace', model: { provider: 'test-provider', model: 'test-model' } }),
    /没有返回 JSON/
  )
  const serializedLogs = JSON.stringify(logs)
  assert.match(serializedLogs, /agent surface read/)
  assert.match(serializedLogs, /agent output parse failed/)
  assert.match(serializedLogs, /extractedTextLength/)
  assert.doesNotMatch(serializedLogs, /输出 JSON/)
})

test('orchestrator leaves workspace untouched when structured output fails validation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-invalid-'))
  try {
    const storage = new WorkspaceStorage()
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage,
      sourceReader: async () => [{ sessionId: 'session-1', title: '主对话', events: [{ seq: 1, text: '内容' }], text: '内容' }],
      modelRunner: async (input) => input.kind === 'summary'
        ? { summary: '这是一个足够长的摘要，用来让编排器继续进入最终校验。', sourceRefs: sourceRefs() }
        : { entities: [], relations: [] },
      idFactory: () => 'generation-invalid'
    })
    const started = orchestrator.start({ cwd, selectedSessionIds: ['session-1'], outputMode: 'knowledge-graph', strict: true, expectedRevision: 0 })
    const failed = await waitForGeneration(orchestrator, started.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /至少需要一个实体/)
    assert.equal((await storage.readState(cwd)).exists, false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('cancelling a generation before save leaves no workspace result', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-cancel-'))
  let release
  const pending = new Promise((resolve) => { release = resolve })
  try {
    const storage = new WorkspaceStorage()
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage,
      sourceReader: async () => [{ sessionId: 'session-1', title: '主对话', events: [{ seq: 1, text: '内容' }], text: '内容' }],
      modelRunner: async () => {
        await pending
        return { summary: '这是一个足够长的摘要，用来验证取消发生在写入之前。', sourceRefs: sourceRefs() }
      },
      idFactory: () => 'generation-cancelled'
    })
    const started = orchestrator.start({ cwd, selectedSessionIds: ['session-1'], outputMode: 'mind-map', strict: true, expectedRevision: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    orchestrator.cancel(started.id)
    release()
    const cancelled = await waitForGeneration(orchestrator, started.id)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal((await storage.readState(cwd)).exists, false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('host enforces metadata-only discovery, explicit confirmation, workspace boundaries, and generation routes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-host-'))
  try {
    const otherCwd = join(cwd, 'other')
    const records = [record('session-1', cwd, 20), record('session-2', otherCwd, 10)]
    let surfaceReads = 0
    const modelCalls = []
    const modelSelections = []
    const sessionQuery = {
      async filterSessions(filters) {
        const filter = filters[0]
        if (filter.kind === 'cwd') return records
        return records.filter((item) => filter.values.includes(item.header.id))
      },
      async readTitleSnapshots(ids) { return ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: `标题 ${id}` } })) },
      async readSurface(id) { surfaceReads += 1; return makeSurface(id, id === 'session-1' ? cwd : otherCwd) }
    }
    const storage = new WorkspaceStorage({ now: () => 1700000000200 })
    const orchestrator = new KnowledgeGenerationOrchestrator({
      sessionQuery,
      storage,
      modelRunner: async (input) => {
        modelCalls.push(input.kind)
        modelSelections.push(input.model)
        if (input.kind === 'summary') return { summary: '这是一个带有来源和下一步的完整摘要。', sourceRefs: sourceRefs() }
        return validMindMap()
      }
    })
    const llm = {
      listProviders() { return [{ id: 'test-provider', name: '测试 Provider' }] },
      async listModels(provider) { return provider === 'test-provider' ? [{ id: 'test-model', name: '测试模型' }] : [] }
    }
    const agentDefaultModel = { currentSelection() { return { provider: 'default-provider', model: 'default-model' } } }
    const host = createHost({ sessionQuery, storage, orchestrator, llm, agentDefaultModel, logger: { info() {}, warn() {}, error() {} } })
    const routes = []
    const cleanups = []
    const skills = []
    const ctx = {
      get(name) {
        return { sessions: null, agents: { create() {} }, agentDefaultModel: {}, skills, webServer: null }[name]
      },
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      }
    }
    const services = {
      webServer: { register(value) { routes.push(value); return () => {} } },
      skills: { register(value) { skills.push(value); return () => {} } }
    }
    ctx.get = (name) => name === 'sessionQuery' ? sessionQuery : (name === 'webServer' ? services.webServer : (name === 'skills' ? services.skills : ({ agents: { create() {} }, agentDefaultModel: {}, sessions: null }[name])))
    host.apply(ctx)
    assert.equal(routes.length, 1)
    const route = routes[0]
    assert.equal(route.path, '/conversation-knowledge-map')

    async function call(method, url, body) {
      const response = makeResponse()
      await route.handler(makeRequest(method, url, body), response.response)
      return response.result
    }

    let result = await call('GET', '/conversation-knowledge-map/context?sessionId=session-1')
    assert.equal(result.status, 200)
    assert.equal(result.body.context.cwd, cwd)
    assert.equal(surfaceReads, 0)

    result = await call('GET', '/conversation-knowledge-map/models')
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.catalog.default, { provider: 'default-provider', model: 'default-model' })
    assert.deepEqual(result.body.catalog.groups, [
      { id: 'default-provider', name: 'default-provider', models: [{ id: 'default-model', name: 'default-model' }] },
      { id: 'test-provider', name: '测试 Provider', models: [{ id: 'test-model', name: '测试模型' }] }
    ])

    result = await call('GET', '/conversation-knowledge-map/sessions?anchorSessionId=session-1')
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.sessions.map((item) => item.id), ['session-1'])
    assert.equal(surfaceReads, 0)

    result = await call('POST', '/conversation-knowledge-map/confirm', { anchorSessionId: 'session-1', selectedSessionIds: ['session-2'], outputMode: 'mind-map', expectedRevision: 0 })
    assert.equal(result.status, 400)
    assert.equal(surfaceReads, 0)

    result = await call('POST', '/conversation-knowledge-map/confirm', { anchorSessionId: 'session-1', selectedSessionIds: ['session-1'], outputMode: 'mind-map', prompt: '保留来源', strict: true, model: { provider: 'chosen-provider', model: 'chosen-model' }, expectedRevision: 0 })
    assert.equal(result.status, 200)
    assert.ok(result.body.confirmation.token)
    assert.deepEqual(result.body.confirmation.model, { provider: 'chosen-provider', model: 'chosen-model' })
    assert.equal(surfaceReads, 0)

    const token = result.body.confirmation.token
    result = await call('POST', '/conversation-knowledge-map/generations', { token, model: { provider: 'other-provider', model: 'other-model' } })
    assert.equal(result.status, 400)
    result = await call('POST', '/conversation-knowledge-map/generations', { token })
    assert.equal(result.status, 202)
    const generationId = result.body.generation.id
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      const current = await call('GET', `/conversation-knowledge-map/generations/${generationId}`)
      if (['completed', 'failed', 'cancelled'].includes(current.body.generation.status)) {
        assert.equal(current.body.generation.status, 'completed')
        break
      }
    }
    assert.equal(surfaceReads, 1)
    assert.deepEqual(modelCalls, ['summary', 'mind-map'])
    assert.deepEqual(modelSelections, [
      { provider: 'chosen-provider', model: 'chosen-model' },
      { provider: 'chosen-provider', model: 'chosen-model' }
    ])
    await orchestrator.tasks.get(generationId).promise
    const hostState = await storage.readState(cwd)
    assert.equal(hostState.revision, 1, JSON.stringify({ hostState, generationId }))

    result = await call('POST', '/conversation-knowledge-map/generations', { token })
    assert.equal(result.status, 400)
    result = await call('GET', '/conversation-knowledge-map/state?anchorSessionId=session-1')
    assert.equal(result.status, 200)
    assert.equal(result.body.state.revision, 1)
    assert.deepEqual(result.body.state.manifest.model, { provider: 'chosen-provider', model: 'chosen-model' })
    for (const cleanup of cleanups) cleanup()
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('client bundle loads through the DSH module loader and exports the expected slot dependencies', () => {
  let loaded
  vm.runInNewContext(text('market/conversation-knowledge-map/lib/client.js'), {
    Symbol,
    window: { __ModuleLoader__: { load(spec) { loaded = spec } } }
  })
  assert.ok(loaded)
  const React = { createElement(type, props, ...children) { return { type, props, children } } }
  const client = loaded.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual(Array.from(client.inject), ['slots', 'sessions'])
  assert.equal(client.resolveSessionId({ sessionId: 'active' }), null)
  assert.equal(client.resolveSessionId({ sessionId: 'session-1' }), 'session-1')
  assert.equal(client.currentSessionId({ list: { getSnapshot() { return { current: { id: 'session-2' } } } } }), 'session-2')
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /EventSource/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /navigator\.clipboard/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /request\('\/models'/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /confirmation\.model/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /setOverlayOpen\(false\)/)
})

test('structured model output accepts fenced JSON but never treats plain prose as valid data', () => {
  assert.deepEqual(parseStructuredOutput('```json\n{"ok":true}\n```'), { ok: true })
  assert.deepEqual(parseStructuredOutput('模型说明：```JSON\n{"ok":true,"nested":{"value":1}}\n```'), { ok: true, nested: { value: 1 } })
  assert.deepEqual(parseStructuredOutput({ result: '前缀 {"ok":true} 后缀' }), { ok: true })
  assert.throws(() => parseStructuredOutput('没有 JSON'), /没有可解析的 JSON/)
})
