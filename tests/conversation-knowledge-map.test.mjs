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
import { makeUserMessage } from '../market/conversation-knowledge-map/lib/protocol.js'
import { chunkSourceText, listWorkspaceSessions, readSelectedSurfaces } from '../market/conversation-knowledge-map/lib/session-source.js'
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
  assert.match(client, /role: 'progressbar'/)
  assert.match(client, /progress\.current.*progress\.total/)
  assert.match(client, /生成过程时间线/)
  assert.match(client, /aria-expanded/)
  assert.match(client, /ckm-timeline-toggle/)
  assert.match(client, /ckm-tree-children/)
  assert.match(client, /ckm-tree-children>\.ckm-tree-branch:after/)
  assert.match(client, /知识图谱缩放控制/)
  assert.match(client, /知识图谱节点间距控制/)
  assert.match(client, /局部一跳/)
  assert.match(client, /按住空白区域自由拖动/)
  assert.match(client, /onPointerDown: beginPan/)
  assert.match(client, /ckm-graph-node,\.ckm-graph-toolbar,button,input,select/)
  assert.match(client, /ckm-graph-layout\{height:100%;min-height:0;overflow:hidden/)
  assert.match(client, /ckm-graph-viewport\{position:relative;flex:1;min-height:360px;overflow:hidden/)
  assert.match(client, /function setStagePan/)
  assert.match(client, /stage\.style\.transform = 'translate\('/)
  assert.match(client, /pan\.panY \+ event\.clientY - pan\.y/)
  assert.doesNotMatch(client, /viewport\.scrollLeft/)
  assert.match(client, /var viewBox = \['0'/)
  assert.match(client, /setZoom\(1\)/)
  assert.match(client, /setSpacing\(1\)/)
  assert.match(client, /function graphLayout/)
  assert.match(client, /function graphLabelLines/)
  assert.match(client, /markerEnd: 'url\(#ckm-arrow\)'/)
  assert.match(client, /React\.createElement\('rect'/)
  assert.match(client, /ckm-graph-stage\{position:absolute/)
  assert.doesNotMatch(client, /ckm-graph-node circle/)
  assert.match(client, /已总结.*个对话/)
  assert.match(client, /知识图谱位于固定视口内/)
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
  const answerOnly = await readSelectedSurfaces({ sessionQuery }, { cwd, sessionIds: ['session-1'], sourceMode: 'answer-only' })
  assert.doesNotMatch(answerOnly[0].text, /用户提出 session-1 的问题/)
  assert.match(answerOnly[0].text, /助手给出 session-1 的阶段性结论/)
  assert.deepEqual(answerOnly[0].events.map((event) => event.role), ['assistant'])
  assert.doesNotMatch(answerOnly[0].text, /内部推理|内部工具细节/)
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

test('session source reads persisted events when an unopened conversation has an empty surface', async () => {
  const cwd = 'D:\\Code\\knowledge-workspace'
  const sessionQuery = {
    async filterSessions() { return [record('session-old', cwd, 20)] },
    async readSurface() { return { session: { id: 'session-old', cwd }, events: [] } },
    async readSession() {
      return {
        session: { id: 'session-old', cwd },
        events: [
          { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '持久化的用户问题' }] } },
          { seq: 2, type: 'user/message', data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: '内部系统快照' }] } },
          { seq: 3, type: 'assistant/message', data: { source: { kind: 'model' }, content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '持久化的助手结论' }] } },
          { seq: 4, type: 'tool/result', data: { content: [{ type: 'text', text: '内部工具结果' }] } }
        ]
      }
    }
  }

  const sources = await readSelectedSurfaces({ sessionQuery }, { cwd, sessionIds: ['session-old'] })
  assert.deepEqual(sources.map((source) => source.sessionId), ['session-old'])
  assert.match(sources[0].text, /持久化的用户问题/)
  assert.match(sources[0].text, /持久化的助手结论/)
  assert.doesNotMatch(sources[0].text, /内部系统快照|内部推理|内部工具结果/)
})

test('session source falls back to the current conversation with truthful provenance', async () => {
  const cwd = 'D:\\Code\\knowledge-workspace'
  const records = [record('session-empty', cwd, 20), record('session-current', cwd, 30)]
  const sessionQuery = {
    async filterSessions(filters) {
      return records.filter((item) => filters[0].values.includes(item.header.id))
    },
    async readSurface(id) {
      if (id === 'session-empty') return { session: { id, cwd }, events: [] }
      return makeSurface(id, cwd, '当前对话')
    },
    async readSession(id) { return { session: { id, cwd }, events: [] } }
  }

  const sources = await readSelectedSurfaces({ sessionQuery }, {
    cwd,
    sessionIds: ['session-empty'],
    fallbackSessionId: 'session-current'
  })
  assert.deepEqual(sources.map((source) => source.sessionId), ['session-current'])
  assert.match(sources[0].text, /用户提出 session-current 的问题/)
})

test('session source chunks at about 5000 characters without breaking normal paragraphs', () => {
  const first = '甲'.repeat(3000)
  const second = '乙'.repeat(2500)
  const third = '丙'.repeat(100)
  const source = {
    sessionId: 'session-1',
    events: [
      { seq: 1, role: 'user', text: first },
      { seq: 2, role: 'assistant', text: second },
      { seq: 3, role: 'user', text: third }
    ],
    text: `用户：${first}\n\n助手：${second}\n\n用户：${third}`
  }

  const chunks = chunkSourceText(source)

  assert.equal(chunks.length, 2)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), source.text)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 5000))
  assert.match(chunks[0].text, /^用户：甲+/)
  assert.doesNotMatch(chunks[0].text, /助手：/)
  assert.match(chunks[1].text, /^助手：乙+/)
  assert.deepEqual(chunks[0].sourceRefs, sourceRefs('session-1', 1))
  assert.deepEqual(chunks[1].sourceRefs, [...sourceRefs('session-1', 2), ...sourceRefs('session-1', 3)])
})

test('session source splits only an oversized paragraph and keeps its source on every piece', () => {
  const body = `${'长'.repeat(4300)}。${'尾'.repeat(1900)}`
  const source = {
    sessionId: 'session-long',
    events: [{ seq: 7, role: 'assistant', text: body }],
    text: `助手：${body}`
  }

  const chunks = chunkSourceText(source)

  assert.equal(chunks.length, 2)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), source.text)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 5000))
  assert.ok(chunks[0].text.endsWith('。'))
  assert.deepEqual(chunks.map((chunk) => chunk.sourceRefs), [sourceRefs('session-long', 7), sourceRefs('session-long', 7)])
})

test('mind-map and knowledge-graph schemas reject unsupported or untraceable structures', () => {
  const mindMap = validateMindMap(validMindMap(), { selectedSessionIds: ['session-1'], strict: true })
  assert.equal(mindMap.schemaVersion, 1)
  assert.deepEqual(mindMap.edges, [{ from: 'root', to: 'decision' }])
  assert.throws(() => validateMindMap({ rootId: 'root', nodes: [validMindMap().nodes[0]] }, { minNodes: 4 }), /至少需要 4 个有效节点/)

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
      sourceSessions: [{ sessionId: 'session-1', title: '主对话' }],
      sourceWarnings: { skippedRefs: 2, skippedItems: 1 },
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
    assert.deepEqual(state.manifest.sourceSessions, [{ sessionId: 'session-1', title: '主对话' }])
    assert.deepEqual(state.manifest.sourceWarnings, { skippedRefs: 2, skippedItems: 1 })
    assert.equal(state.manifest.sourceMode, 'conversation')
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

test('workspace storage preserves the view not targeted by a single-view generation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-preserve-view-'))
  try {
    const storage = new WorkspaceStorage({ now: () => 1700000000000 })
    await storage.saveBundle({
      cwd,
      expectedRevision: 0,
      generationId: 'both',
      sourceSessionIds: ['session-1'],
      outputMode: 'both',
      mindMap: validMindMap(),
      knowledgeGraph: validGraph()
    })
    const graphOnly = validGraph()
    graphOnly.entities[0].name = '更新后的 Runtime'
    const graphSaved = await storage.saveBundle({
      cwd,
      expectedRevision: 1,
      generationId: 'graph-only',
      sourceSessionIds: ['session-1'],
      outputMode: 'knowledge-graph',
      mindMap: null,
      knowledgeGraph: graphOnly
    })
    assert.equal(graphSaved.mindMap.nodes[0].title, '阶段主题')
    assert.equal(graphSaved.knowledgeGraph.entities[0].name, '更新后的 Runtime')

    const mindOnly = validMindMap()
    mindOnly.nodes[0].title = '更新后的阶段主题'
    const mindSaved = await storage.saveBundle({
      cwd,
      expectedRevision: 2,
      generationId: 'mind-only',
      sourceSessionIds: ['session-1'],
      outputMode: 'mind-map',
      mindMap: mindOnly,
      knowledgeGraph: null
    })
    assert.equal(mindSaved.mindMap.nodes[0].title, '更新后的阶段主题')
    assert.equal(mindSaved.knowledgeGraph.entities[0].name, '更新后的 Runtime')
    const state = await storage.readState(cwd)
    assert.equal(state.mindMap.nodes[0].title, '更新后的阶段主题')
    assert.equal(state.knowledgeGraph.entities[0].name, '更新后的 Runtime')
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
    assert.equal(completed.progress.percent, 100)
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

test('orchestrator retries an invalid empty mind map once and reports conversation progress', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-map-retry-'))
  try {
    let mindMapCalls = 0
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-retry-mind-map',
      sourceReader: async () => [{
        sessionId: 'session-1',
        title: '需要整理的对话',
        events: [{ seq: 1, text: '问题', role: 'user' }, { seq: 2, text: '结论', role: 'assistant' }],
        text: '用户：问题\n\n助手：结论'
      }],
      modelRunner: async (input) => {
        if (input.kind === 'summary') return { summary: '这是包含背景、当前认识和下一步的完整摘要。', sourceRefs: sourceRefs() }
        mindMapCalls += 1
        return mindMapCalls === 1 ? { rootId: 'root', nodes: [] } : validMindMap()
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: ['session-1'], outputMode: 'mind-map',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.equal(mindMapCalls, 2)
    assert.equal(completed.progress.percent, 100)
    assert.ok(completed.events.some((event) => event.progress?.label === '已完成摘要：需要整理的对话' && event.progress.current === 1))
    assert.ok(completed.timeline.some((item) => item.type === 'retry' && /思维导图.*1\/3/.test(item.message)))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('orchestrator retries a malformed summary shape instead of reporting it as empty', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-summary-retry-'))
  try {
    let summaryCalls = 0
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-retry-summary',
      sourceReader: async () => [{
        sessionId: 'session-1', title: '旧对话',
        events: [{ seq: 1, text: '问题', role: 'user' }, { seq: 2, text: '结论', role: 'assistant' }],
        text: '用户：问题\n\n助手：结论'
      }],
      modelRunner: async (input) => {
        if (input.kind === 'summary') {
          summaryCalls += 1
          return summaryCalls === 1 ? { sessionId: 'session-1', eventSeqs: [1] } : { summary: '这是自动修复后包含背景、认识和下一步的摘要。', sourceRefs: sourceRefs() }
        }
        return validMindMap()
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: ['session-1'], outputMode: 'mind-map',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.equal(summaryCalls, 2)
    assert.ok(completed.timeline.some((item) => item.type === 'retry' && /摘要失败.*1\/3/.test(item.message)))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('orchestrator summarizes conversations with at most three workers and merges chunks before the final view', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-parallel-'))
  try {
    const sources = Array.from({ length: 5 }, (_, index) => {
      const sessionId = `session-${index + 1}`
      const text = index === 0 ? `问题-${sessionId}\n${'背景内容。'.repeat(3500)}` : `问题-${sessionId}\n阶段结论。`
      return {
        sessionId,
        title: `对话 ${index + 1}`,
        events: [{ seq: 1, text: `问题-${sessionId}`, role: 'user' }, { seq: 2, text: '阶段结论。', role: 'assistant' }],
        text
      }
    })
    let activeSummaries = 0
    let maxActiveSummaries = 0
    let summaryCalls = 0
    let summariesCompleted = 0
    const activeSessions = new Set()
    let finalSummaries = null
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-parallel-summary',
      sourceReader: async () => sources,
      modelRunner: async (input) => {
        if (input.kind === 'summary') {
          const sessionId = input.prompt.match(/Session：([^\n]+)/)?.[1]
          assert.ok(sessionId)
          assert.equal(activeSessions.has(sessionId), false, '同一对话的分段必须顺序处理')
          activeSessions.add(sessionId)
          activeSummaries += 1
          summaryCalls += 1
          maxActiveSummaries = Math.max(maxActiveSummaries, activeSummaries)
          await new Promise((resolve) => setImmediate(resolve))
          activeSummaries -= 1
          activeSessions.delete(sessionId)
          summariesCompleted += 1
          return { summary: `${sessionId} 的阶段摘要。`, keyPoints: [`${sessionId} 的关键点`], sourceRefs: sourceRefs(sessionId) }
        }
        assert.equal(summariesCompleted, summaryCalls, '最终视图必须等待全部对话摘要完成')
        const marker = '对话摘要：'
        finalSummaries = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf(marker) + marker.length))
        return validMindMap()
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: sources.map((source) => source.sessionId), outputMode: 'mind-map',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.equal(maxActiveSummaries, 3)
    assert.equal(summaryCalls, 8)
    assert.equal(finalSummaries.length, 5)
    assert.deepEqual(finalSummaries.map((summary) => summary.sessionId), sources.map((source) => source.sessionId))
    assert.ok(completed.events.some((event) => /并行整理/.test(event.progress?.label || '')))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('knowledge graph generation keeps chunk-level evidence and uses a dynamic high-recall budget', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-graph-coverage-'))
  try {
    const longAnswer = '模块接口与决策证据。'.repeat(900)
    const source = {
      sessionId: 'session-1',
      title: '长对话',
      events: [
        { seq: 1, text: '请分析系统。', role: 'user' },
        { seq: 2, text: longAnswer, role: 'assistant' }
      ],
      text: `用户：请分析系统。\n\n助手：${longAnswer}`
    }
    let summaryCall = 0
    const graphPrompts = []
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-graph-coverage',
      sourceReader: async () => [source],
      modelRunner: async (input) => {
        if (input.kind === 'summary') {
          summaryCall += 1
          return {
            summary: `第 ${summaryCall} 个分段保留的模块、接口、决策和风险。`,
            keyPoints: [`分段 ${summaryCall} 的具名知识项`],
            sourceRefs: sourceRefs('session-1', summaryCall === 1 ? 1 : 2)
          }
        }
        graphPrompts.push(input.prompt)
        return validGraph()
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: ['session-1'], outputMode: 'knowledge-graph',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.ok(summaryCall >= 2)
    assert.equal(graphPrompts.length, summaryCall)
    assert.ok(graphPrompts.every((prompt) => /对话分段证据/.test(prompt)))
    assert.ok(graphPrompts.some((prompt) => /"chunk":2/.test(prompt) && /第 2 个分段保留的模块/.test(prompt)))
    assert.ok(graphPrompts.every((prompt) => /上限为 \d+ 个实体、\d+ 条关系/.test(prompt)))
    assert.ok(graphPrompts.every((prompt) => !/最多生成 20 个实体、30 条关系/.test(prompt)))
    assert.equal(completed.result.knowledgeGraph.entities.length, 2)
    assert.equal(completed.result.knowledgeGraph.relations.length, 1)
    assert.ok(completed.timeline.some((item) => item.type === 'graph-coverage' && /合并去重后保留 2 个实体、1 条关系/.test(item.message)))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('knowledge graph retries only the overflowing batch with a lower output budget', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-graph-token-retry-'))
  try {
    const graphPrompts = []
    let graphCalls = 0
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-graph-token-retry',
      sourceReader: async () => [{
        sessionId: 'session-1', title: '单批对话',
        events: [{ seq: 1, text: '系统包含模块和接口。', role: 'user' }, { seq: 2, text: '模块调用接口。', role: 'assistant' }],
        text: '用户：系统包含模块和接口。\n\n助手：模块调用接口。'
      }],
      modelRunner: async (input) => {
        if (input.kind === 'summary') return { summary: '系统包含模块和接口，模块调用接口。', keyPoints: ['模块', '接口', '调用关系'], sourceRefs: sourceRefs() }
        graphCalls += 1
        graphPrompts.push(input.prompt)
        if (graphCalls === 1) {
          const error = new Error('模型输出达到最大 Token 限制，JSON 尚未完成。')
          error.tokenLimit = true
          throw error
        }
        return validGraph()
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: ['session-1'], outputMode: 'knowledge-graph',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.equal(graphCalls, 2)
    const firstLimit = Number(graphPrompts[0].match(/上限为 (\d+) 个实体/)?.[1])
    const retryLimit = Number(graphPrompts[1].match(/上限为 (\d+) 个实体/)?.[1])
    assert.ok(retryLimit < firstLimit)
    assert.ok(completed.timeline.some((item) => item.type === 'retry' && /降低本批输出预算/.test(item.message)))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('orchestrator filters hallucinated source sessions and records the conversations actually summarized', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-source-filter-'))
  try {
    const invalidSessionId = 'session-1a18c8ce-81aa-4e98-adbd-21951fc830c'
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-source-filter',
      sourceReader: async () => [{
        sessionId: 'session-1', title: '实际总结的对话',
        events: [{ seq: 1, text: '问题', role: 'user' }, { seq: 2, text: '结论', role: 'assistant' }],
        text: '用户：问题\n\n助手：结论'
      }],
      modelRunner: async (input) => {
        if (input.kind === 'summary') return { summary: '这是实际对话的阶段摘要。', sourceRefs: sourceRefs() }
        if (input.kind === 'mind-map') {
          const map = validMindMap()
          map.nodes[1].primarySourceSessionId = invalidSessionId
          map.nodes[1].sourceRefs = sourceRefs(invalidSessionId, 2)
          return map
        }
        const graph = validGraph()
        graph.entities[1].sourceRefs = sourceRefs(invalidSessionId, 2)
        return graph
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: ['session-1'], outputMode: 'both',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.result.mindMap, null)
    assert.deepEqual(completed.result.knowledgeGraph.entities.map((entity) => entity.id), ['runtime'])
    assert.equal(completed.result.knowledgeGraph.relations.length, 0)
    assert.deepEqual(completed.result.sourceWarnings, { skippedRefs: 1, skippedItems: 2 })
    assert.deepEqual(completed.result.manifest.sourceSessions, [{ sessionId: 'session-1', title: '实际总结的对话' }])
    assert.match(completed.message, /已总结 1 个对话.*过滤 2 个/)
    assert.ok(completed.timeline.some((item) => item.type === 'view-failed' && /思维导图/.test(item.message)))
    assert.ok(completed.events.some((event) => event.progress?.label === '过滤无效来源'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('orchestrator gives three reset retries, skips failed conversations, and preserves a successful partial view', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-knowledge-retry-isolation-'))
  try {
    const summaryCalls = { 'session-1': 0, 'session-2': 0 }
    let graphCalls = 0
    const sources = ['session-1', 'session-2'].map((sessionId, index) => ({
      sessionId,
      title: index === 0 ? '始终失败的对话' : '可以总结的对话',
      events: [{ seq: 1, text: '问题', role: 'user' }, { seq: 2, text: '结论', role: 'assistant' }],
      text: '用户：问题\n\n助手：结论'
    }))
    const orchestrator = new KnowledgeGenerationOrchestrator({
      storage: new WorkspaceStorage(),
      idFactory: () => 'generation-retry-isolation',
      sourceReader: async () => sources,
      modelRunner: async (input) => {
        if (input.kind === 'summary') {
          const sessionId = input.prompt.match(/Session：([^\n]+)/)?.[1]
          summaryCalls[sessionId] += 1
          if (sessionId === 'session-1') return '这是一段始终无法解析为 JSON 的普通文本。'
          return { summary: '第二个对话成功生成了合法摘要。', sourceRefs: sourceRefs('session-2') }
        }
        if (input.kind === 'mind-map') return validMindMap('session-2')
        graphCalls += 1
        return '知识图谱也始终没有返回 JSON。'
      }
    })
    const started = orchestrator.start({
      anchorSessionId: 'session-1', cwd, selectedSessionIds: ['session-1', 'session-2'], outputMode: 'both',
      strict: true, expectedRevision: 0, model: { provider: 'test-provider', model: 'test-model' }
    })
    const completed = await waitForGeneration(orchestrator, started.id)
    assert.equal(completed.status, 'completed')
    assert.deepEqual(summaryCalls, { 'session-1': 4, 'session-2': 1 })
    assert.equal(graphCalls, 4)
    assert.ok(completed.result.mindMap)
    assert.equal(completed.result.knowledgeGraph, null)
    assert.deepEqual(completed.result.manifest.sourceSessionIds, ['session-2'])
    assert.deepEqual(completed.result.manifest.failedSources.map((source) => source.sessionId), ['session-1'])
    assert.equal(completed.timeline.filter((item) => item.type === 'retry' && /始终失败的对话/.test(item.message)).length, 3)
    assert.ok(completed.timeline.some((item) => item.type === 'skipped' && /始终失败的对话/.test(item.message)))
    assert.ok(completed.timeline.some((item) => item.type === 'view-failed' && /知识图谱/.test(item.message)))
    assert.ok(completed.result.manifest.generationTimeline.some((item) => item.type === 'save'))
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
            data: { message: { text: `结果如下：\n\n\`\`\`JSON\n${JSON.stringify({ summary: '结构化摘要', sourceRefs: [] })}\n\`\`\`` } }
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
  assert.deepEqual(result, { summary: '结构化摘要', sourceRefs: [] })
  assert.equal(reads, 2)
  assert.deepEqual(createOptions.agentOptions, { provider: 'chosen-provider', model: 'chosen-model', maxTokens: 12000 })
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
                data: { message: { content: [
                  { type: 'reasoning', text: '{"rootId":"reasoning-must-be-ignored","nodes":[]}' },
                  { type: 'text', text: '{"rootId":"root","nodes":[]}' }
                ] } }
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
  assert.deepEqual(result, { rootId: 'root', nodes: [] })
  assert.equal(surfaceReads, 0)
  const serializedLogs = JSON.stringify(logs)
  assert.match(serializedLogs, /agent event/)
  assert.match(serializedLogs, /agent idle/)
  assert.doesNotMatch(serializedLogs, /\{"ok":true\}/)
})

test('agent follow-up messages include the runtime-required plugin source', () => {
  const message = makeUserMessage('输出 JSON', 'knowledge-map-message')
  assert.deepEqual(message, {
    id: 'knowledge-map-message',
    role: 'user',
    content: [{ type: 'text', text: '输出 JSON' }],
    source: {
      kind: 'plugin',
      plugin: '@p-dsh-market/conversation-knowledge-map',
      form: 'generation'
    }
  })
})

test('agent runner surfaces persisted turn errors instead of misreporting empty JSON', async () => {
  const logs = []
  const logger = {
    info(format, ...params) { logs.push(['info', format, ...params]) },
    warn(format, ...params) { logs.push(['warn', format, ...params]) },
    error(format, ...params) { logs.push(['error', format, ...params]) }
  }
  const orchestrator = new KnowledgeGenerationOrchestrator({
    idFactory: () => 'persisted-turn-error',
    logger,
    agents: {
      async create() {
        return { agent: { followup() {}, async whenIdle() {} }, async dispose() {} }
      }
    },
    sessionQuery: {
      async readSurface() { return { events: [] } },
      async readSession() {
        return {
          events: [{
            type: 'turn/end',
            data: { reason: { kind: 'error', error: { code: 'UNKNOWN', message: "Cannot read properties of undefined (reading 'kind')" } } }
          }]
        }
      }
    }
  })

  await assert.rejects(
    orchestrator.runModel({ kind: 'summary', prompt: '输出 JSON', cwd: 'D:\\Code\\knowledge-workspace', model: { provider: 'test-provider', model: 'test-model' } }),
    (error) => {
      assert.match(error.message, /Agent Runtime 生成失败.*UNKNOWN.*Cannot read properties of undefined.*kind/)
      return true
    }
  )
  const serializedLogs = JSON.stringify(logs)
  assert.match(serializedLogs, /agent turn failure/)
  assert.doesNotMatch(serializedLogs, /agent output parse failed/)
})

test('agent runner stops immediately when a live turn error arrives', async () => {
  let publish
  let surfaceReads = 0
  const orchestrator = new KnowledgeGenerationOrchestrator({
    idFactory: () => 'live-turn-error',
    sessionEventSource(listener) {
      publish = listener
      return () => {}
    },
    agents: {
      async create() {
        return {
          agent: {
            followup() {
              publish({ id: 'knowledge-map-live-turn-error' }, {
                type: 'turn/end',
                data: { reason: { kind: 'error', message: 'provider unavailable' } }
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

  await assert.rejects(
    orchestrator.runModel({ kind: 'mind-map', prompt: '输出 JSON', cwd: 'D:\\Code\\knowledge-workspace', model: { provider: 'test-provider', model: 'test-model' } }),
    /Agent Runtime 生成失败.*provider unavailable/
  )
  assert.equal(surfaceReads, 0)
})

test('agent runner reports a token limit instead of a generic JSON parse failure', async () => {
  const orchestrator = new KnowledgeGenerationOrchestrator({
    idFactory: () => 'token-limit',
    agents: {
      async create() {
        return { agent: { followup() {}, async whenIdle() {} }, async dispose() {} }
      }
    },
    sessionQuery: {
      async readSurface() {
        return {
          events: [
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '```json\n{"summary":"未完成' }] } } },
            { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }
          ]
        }
      }
    }
  })

  await assert.rejects(
    orchestrator.runModel({ kind: 'summary', prompt: '输出 JSON', cwd: 'D:\\Code\\knowledge-workspace', model: { provider: 'test-provider', model: 'test-model' } }),
    /达到最大 Token 限制.*JSON 尚未完成/
  )
})

test('agent runner logs empty output diagnostics without logging prompt content', async () => {
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

test('agent runner logs bounded model output and distinguishes malformed JSON from a wrong shape', async () => {
  const logs = []
  const logger = {
    info(format, ...params) { logs.push(['info', format, ...params]) },
    warn(format, ...params) { logs.push(['warn', format, ...params]) },
    error(format, ...params) { logs.push(['error', format, ...params]) }
  }
  let response = 'JSON 如下：\n```json\n{"summary":"未闭合"\n```'
  const orchestrator = new KnowledgeGenerationOrchestrator({
    logger,
    modelRunner: async () => response
  })
  await assert.rejects(
    orchestrator.runModel({ kind: 'summary', prompt: '不要写入日志的提示词', cwd: 'D:\\Code\\knowledge-workspace' }),
    /没有可解析的 JSON/
  )
  response = 'JSON 如下：{"keyPoints":["只有关键点"]}'
  await assert.rejects(
    orchestrator.runModel({ kind: 'summary', prompt: '不要写入日志的提示词', cwd: 'D:\\Code\\knowledge-workspace' }),
    /没有可解析的 JSON/
  )
  response = '{"summary":"","keyPoints":[]}'
  assert.deepEqual(
    await orchestrator.runModel({ kind: 'summary', prompt: '不要写入日志的提示词', cwd: 'D:\\Code\\knowledge-workspace' }),
    { summary: '', keyPoints: [] }
  )
  const serializedLogs = JSON.stringify(logs)
  assert.match(serializedLogs, /summary.*未闭合/)
  assert.match(serializedLogs, /unclosed-object/)
  assert.match(serializedLogs, /valid-json-wrong-shape/)
  assert.match(serializedLogs, /summary.*keyPoints/)
  assert.doesNotMatch(serializedLogs, /不要写入日志的提示词/)
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
        if (input.kind === 'summary') return { summary: '这是一个带有来源和下一步的完整摘要。', sourceRefs: sourceRefs('session-1', 2) }
        const map = validMindMap()
        map.nodes.forEach((node) => { node.sourceRefs = sourceRefs('session-1', 2) })
        return map
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

    result = await call('POST', '/conversation-knowledge-map/confirm', { anchorSessionId: 'session-1', selectedSessionIds: ['session-1'], outputMode: 'mind-map', sourceMode: 'answer-only', prompt: '保留来源', strict: true, model: { provider: 'chosen-provider', model: 'chosen-model' }, expectedRevision: 0 })
    assert.equal(result.status, 200)
    assert.ok(result.body.confirmation.token)
    assert.deepEqual(result.body.confirmation.model, { provider: 'chosen-provider', model: 'chosen-model' })
    assert.equal(result.body.confirmation.sourceMode, 'answer-only')
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
    assert.equal(result.body.state.manifest.sourceMode, 'answer-only')
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
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /sourceMode: confirmation\.sourceMode/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /仅助手回答正文/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /reasoning \/ thinking、工具结果和流式过程块/)
  assert.match(text('market/conversation-knowledge-map/lib/client.js'), /setOverlayOpen\(false\)/)
})

test('structured model output accepts fenced JSON but never treats plain prose as valid data', () => {
  assert.deepEqual(parseStructuredOutput('```json\n{"ok":true}\n```'), { ok: true })
  assert.deepEqual(parseStructuredOutput('模型说明：```JSON\n{"ok":true,"nested":{"value":1}}\n```'), { ok: true, nested: { value: 1 } })
  assert.deepEqual(parseStructuredOutput({ result: '前缀 {"ok":true} 后缀' }), { ok: true })
  assert.deepEqual(parseStructuredOutput('```json\n{"entities":[]}\n```', 'knowledge-graph'), { entities: [], relations: [] })
  assert.throws(() => parseStructuredOutput('没有 JSON'), /没有可解析的 JSON/)
  assert.throws(
    () => parseStructuredOutput('{"summary":"未闭合 \"keyPoints\":[{"sessionId":"session-1","eventSeqs":[1]}]}', 'summary'),
    /没有可解析的 JSON/
  )
})
