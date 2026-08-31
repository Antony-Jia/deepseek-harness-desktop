import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

import { buildCapabilityCatalog, filterSkills } from '../market/graph-job-orchestrator/lib/capabilities.js'
import { CapabilityMismatchError, CodexExecutor, DshInProcessExecutor, OutputContractError, classifyExecutionError, normalizeNodeOutput, validateArtifactRefs } from '../market/graph-job-orchestrator/lib/executors.js'
import { applyGraphPatch, graphSummary, normalizeGraph, resolveProfileDefaults } from '../market/graph-job-orchestrator/lib/graph-schema.js'
import { createHost } from '../market/graph-job-orchestrator/lib/index.js'
import { GraphJobOrchestrator } from '../market/graph-job-orchestrator/lib/orchestrator.js'
import { buildPlannerContext, restrictedPlannerPatch } from '../market/graph-job-orchestrator/lib/planner.js'
import { GraphScheduler } from '../market/graph-job-orchestrator/lib/scheduler.js'
import { GraphJobStorage, resolveStorageRoot } from '../market/graph-job-orchestrator/lib/storage.js'
import { validateGraph } from '../market/graph-job-orchestrator/lib/validator.js'

function tempRoot() { return mkdtempSync(join(tmpdir(), 'dsh-graph-job-')) }

function profile(id = 'p1', extra = {}) {
  return { id, name: id, executor: 'dsh', provider: 'provider-a', model: 'model-a', capabilities: { tools: [], skills: [] }, ...extra }
}

function graph(nodes, edges = [], extra = {}) {
  return normalizeGraph({ graphId: 'graph-test', goal: '测试 Graph Job', agentProfiles: [profile()], nodes, edges, ...extra })
}

function task(id, extra = {}) {
  return { id, title: id, instruction: `执行 ${id}`, agentProfileId: 'p1', access: 'read', ...extra }
}

function noOpStorage() {
  return { saveRun() {}, appendRunEvent() {} }
}

test('Graph schema resolves model snapshot and strips DSH reasoningEffort', () => {
  const value = resolveProfileDefaults(normalizeGraph({
    graphId: 'g',
    goal: 'x',
    agentProfiles: [
      { id: 'dsh', executor: 'dsh', reasoningEffort: 'high' },
      { id: 'codex', executor: 'codex', provider: 'codex', reasoningEffort: 'high' }
    ],
    nodes: [],
    edges: []
  }), { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(value.agentProfiles[0].provider, 'deepseek')
  assert.equal(value.agentProfiles[0].model, 'deepseek-chat')
  assert.equal(value.agentProfiles[0].reasoningEffort, '')
  assert.equal(value.agentProfiles[1].reasoningEffort, 'high')
})

test('validator builds virtual-root layers, merge barrier and static write warning', () => {
  const value = graph([
    task('a'),
    task('b'),
    task('write-a', { access: 'write' }),
    task('write-b', { access: 'write' }),
    { id: 'merge', kind: 'merge', title: '汇总' }
  ], [
    { from: 'a', to: 'merge' },
    { from: 'b', to: 'merge' },
    { from: 'a', to: 'write-a' },
    { from: 'b', to: 'write-b' }
  ])
  const report = validateGraph(value)
  assert.equal(report.valid, true)
  assert.deepEqual(report.layers[0], ['a', 'b'])
  assert.deepEqual(report.dependencies.merge, ['a', 'b'])
  assert.equal(report.parallelism.writeSerialized, true)
  assert.ok(report.warnings.some((item) => item.code === 'WRITE_SERIALIZED'))
  assert.deepEqual(graphSummary(value, report).nodeCount, 5)
})

test('validator rejects cycles, missing profiles, recursive tools and plugin Skills', () => {
  const capabilitySnapshot = {
    tools: ['read_file'],
    skills: [
      { name: 'market-skill', origin: 'plugin', metadata: { plugin: '@p-dsh-market/other' } },
      { name: 'runtime-skill', origin: 'runtime' }
    ],
    reasoningEfforts: ['low']
  }
  const cycle = graph([task('a', { agentProfileId: 'missing' }), task('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], {
    capabilitySnapshot,
    agentProfiles: [profile('p1', { capabilities: { tools: ['graphjob_plan'], skills: ['market-skill'] } })]
  })
  const report = validateGraph(cycle, { capabilities: capabilitySnapshot })
  assert.equal(report.valid, false)
  assert.ok(report.errors.some((item) => item.code === 'CYCLE'))
  assert.ok(report.errors.some((item) => item.code === 'RECURSION_GUARD'))
  assert.ok(report.errors.some((item) => item.code === 'PLUGIN_SKILL_DENIED'))
  assert.ok(report.errors.some((item) => item.code === 'MISSING_PROFILE'))
  assert.equal(validateGraph(graph([task('invalid', { kind: 'approval' })], [], {
    agentProfiles: [profile('p1', { executor: 'shell' })]
  })).errors.some((item) => item.code === 'NODE_KIND' || item.code === 'EXECUTOR'), true)
})

test('artifact output only accepts paths inside session cwd and excludes raw protocol fields', () => {
  const root = tempRoot()
  try {
    assert.throws(() => validateArtifactRefs([{ path: '../outside.txt' }], { cwd: root }), OutputContractError)
    assert.throws(() => validateArtifactRefs([{ path: 'C:\\outside.txt' }], { cwd: root }), OutputContractError)
    const result = normalizeNodeOutput({ structured: { text: '完成', artifactRefs: [{ path: 'out/result.md', type: 'markdown' }], reasoning: '不要保存' } }, { cwd: root })
    assert.deepEqual(result, { text: '完成', artifactRefs: [{ path: 'out/result.md', type: 'markdown', summary: '' }] })
    assert.throws(() => normalizeNodeOutput({ output: 'not-json' }, { cwd: root }), OutputContractError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('artifactRefs are optional for text contracts and template scope is isolated', async () => {
  const root = tempRoot()
  try {
    assert.deepEqual(normalizeNodeOutput({ structured: { text: '只返回正文' } }, { cwd: root }), { text: '只返回正文', artifactRefs: [] })
    assert.deepEqual(normalizeNodeOutput({ structured: { artifactRefs: [{ path: 'out.txt' }] } }, {
      cwd: root,
      contract: { requireText: false, allowEmptyText: false, allowArtifactRefs: true }
    }), { text: '', artifactRefs: [{ path: 'out.txt', type: 'file', summary: '' }] })

    const orchestrator = new GraphJobOrchestrator({
      storageRoot: root,
      services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
    })
    orchestrator.initialize()
    orchestrator.setProfiles([profile()])
    const localPreview = await orchestrator.previewTemplate({
      mode: 'saveAs',
      scope: 'workspace',
      cwd: 'C:\\workspace-a',
      name: 'workspace template',
      graph: { goal: 'local', agentProfiles: [{ id: 'p1' }], nodes: [task('a')], edges: [] }
    })
    const local = orchestrator.confirmTemplate({ token: localPreview.confirmationToken })
    const globalPreview = await orchestrator.previewTemplate({
      mode: 'saveAs',
      scope: 'global',
      cwd: 'C:\\workspace-a',
      name: 'global template',
      graph: { goal: 'global', agentProfiles: [{ id: 'p1' }], nodes: [task('a')], edges: [] }
    })
    const global = orchestrator.confirmTemplate({ token: globalPreview.confirmationToken })
    assert.equal(local.scope, 'workspace')
    assert.equal(global.scope, 'global')
    assert.deepEqual(orchestrator.listTemplates({ cwd: 'C:\\workspace-a' }).map((item) => item.id).sort(), [global.id, local.id].sort())
    assert.deepEqual(orchestrator.listTemplates({ cwd: 'C:\\workspace-b' }).map((item) => item.id), [global.id])
    orchestrator.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('storage uses fixed plugin root, atomic JSON and recoverable append-only JSONL', () => {
  const root = tempRoot()
  try {
    assert.equal(resolveStorageRoot({ LOCALAPPDATA: 'C:\\Users\\test' }).toLowerCase(), 'c:\\users\\test\\dsh-desktop\\plugin-data\\graph-job-orchestrator'.toLowerCase())
    const storage = new GraphJobStorage({ root })
    storage.ensure()
    storage.saveAgentProfiles([profile()])
    assert.equal(storage.loadAgentProfiles()[0].id, 'p1')
    storage.saveGraphRevision(graph([task('a')]))
    storage.saveRun({ runId: 'run-1', graphId: 'graph-test', status: 'running' })
    storage.appendRunEvent('graph-test', 'run-1', { id: 1, type: 'run/started' })
    const eventFile = join(root, 'graphs', 'graph-test', 'runs', 'run-1.events.jsonl')
    // Simulate a process interruption halfway through the last JSONL record.
    appendFileSync(eventFile, '{"id":2')
    assert.deepEqual(storage.readRunEvents('graph-test', 'run-1').map((item) => item.id), [1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('restricted planner patch rejects replace and preserves revision conflict checks', () => {
  const value = graph([task('a')])
  assert.throws(() => restrictedPlannerPatch(value, { baseRevision: 1, operations: [{ op: 'replace', value: {} }] }), /不允许操作/)
  const next = applyGraphPatch(value, { baseRevision: 1, operations: [{ op: 'addNode', node: task('b') }, { op: 'addEdge', from: 'a', to: 'b' }] }, { now: 100 })
  assert.equal(next.revision, 2)
  assert.equal(next.manualLock, true)
  assert.throws(() => applyGraphPatch(value, { baseRevision: 2, operations: [] }), /revision 冲突/)
})

test('capability discovery classifies plugin and unknown Skills and finds optional Codex provider', async () => {
  const catalog = await buildCapabilityCatalog({
    cwd: 'C:\\workspace',
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agents: { create: async () => ({}) },
    subagents: {
      list: () => ['spawn', 'codex'],
      getProvider: (name) => name === 'spawn'
        ? { name, capabilities: { toolFilter: true, persona: true } }
        : { name, capabilities: { outputSchema: true, reasoningEfforts: ['low', 'high'] } }
    },
    tools: { schemas: () => [{ name: 'read_file' }, { name: 'skill' }] },
    skills: { list: () => [
      { name: 'market', source: 'runtime', provider: 'desktop-skills', metadata: { plugin: '@p-dsh-market/x' } },
      { name: 'user-skill', source: 'user', provider: 'runtime' },
      { name: 'mystery', source: 'weird-source', provider: 'unknown' }
    ] }
  })
  assert.equal(catalog.executors.codex.available, true)
  assert.deepEqual(catalog.executors.codex.providers, ['codex'])
  assert.equal(catalog.skills.find((item) => item.name === 'market').origin, 'plugin')
  assert.equal(catalog.skills.find((item) => item.name === 'mystery').allowed, false)
  const selected = filterSkills(catalog.skills, ['market', 'user-skill', 'mystery'])
  assert.deepEqual(selected.allowed.map((item) => item.name), ['user-skill'])
})

test('scheduler enforces preview confirmation, merge barrier and write serialization', async () => {
  const value = graph([
    task('a'),
    task('b'),
    task('write-a', { access: 'write' }),
    task('write-b', { access: 'write' }),
    { id: 'merge', kind: 'merge', title: '汇总' }
  ], [
    { from: 'a', to: 'merge' },
    { from: 'b', to: 'merge' },
    { from: 'a', to: 'write-a' },
    { from: 'b', to: 'write-b' }
  ], { limits: { maxParallel: 4, retryBackoffMs: 0 } })
  const validation = validateGraph(value)
  let activeWrites = 0
  let maxActiveWrites = 0
  const scheduler = new GraphScheduler({
    graph: value,
    validation,
    storage: noOpStorage(),
    executor: async ({ node }) => {
      if (node.access === 'write') {
        activeWrites += 1
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
        await new Promise((resolve) => setTimeout(resolve, 8))
        activeWrites -= 1
      }
      return { text: node.id, artifactRefs: [] }
    }
  })
  assert.throws(() => scheduler.start(), /预览/) 
  scheduler.start({ confirmed: true })
  const finished = await scheduler.wait()
  assert.equal(finished.status, 'completed')
  assert.equal(maxActiveWrites, 1)
  assert.match(finished.nodeStates.merge.result.text, /\[a\]/)
})

test('scheduler pauses on contract failure and retries only after user action', async () => {
  const value = graph([task('a')], [], { limits: { maxRetries: 0, retryBackoffMs: 0 } })
  const validation = validateGraph(value)
  let fail = true
  const scheduler = new GraphScheduler({
    graph: value,
    validation,
    storage: noOpStorage(),
    executor: async () => {
      if (fail) return { output: 'invalid output' }
      return { text: 'recovered', artifactRefs: [] }
    }
  })
  scheduler.start({ confirmed: true })
  const paused = await scheduler.wait()
  assert.equal(paused.status, 'paused')
  assert.equal(paused.nodeStates.a.status, 'failed')
  fail = false
  await scheduler.retryFailed()
  const recovered = await scheduler.wait()
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.nodeStates.a.result.text, 'recovered')
})

test('orchestrator requires confirmation token and binds one active revision/run per session', async () => {
  const root = tempRoot()
  try {
    let ids = 0
    const orchestrator = new GraphJobOrchestrator({
      storageRoot: root,
      idFactory: (kind) => `${kind}-${++ids}`,
      services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
    })
    orchestrator.initialize()
    orchestrator.setProfiles([profile()])
    const preview = await orchestrator.preview({ sessionId: 'session-1', goal: '完成测试', agentProfiles: [{ id: 'p1' }], nodes: [task('a')], edges: [] })
    assert.equal(preview.validation.valid, true)
    await assert.rejects(() => orchestrator.startRun({ sessionId: 'session-1', confirmed: true }), /confirmationToken/)
    orchestrator.confirmPreview({ sessionId: 'session-1', token: preview.confirmationToken })
    const started = await orchestrator.startRun({ sessionId: 'session-1', confirmed: true, confirmationToken: preview.confirmationToken, executorFactory: () => async () => ({ text: 'ok', artifactRefs: [] }) })
    const completed = await orchestrator.schedulers.get(started.runId).wait()
    assert.equal(completed.status, 'completed')
    assert.equal(orchestrator.getBinding('session-1').activeRunId, '')
    assert.equal(orchestrator.getGraph(preview.graph.graphId, preview.graph.revision).revision, preview.graph.revision)
    orchestrator.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('paused runs permit only pending-node revisions and reject stale or protected edits', async () => {
  const root = tempRoot()
  try {
    const orchestrator = new GraphJobOrchestrator({
      storageRoot: root,
      services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
    })
    orchestrator.initialize()
    orchestrator.setProfiles([profile()])
    const preview = await orchestrator.preview({ sessionId: 'session-edit', goal: 'revision rule', agentProfiles: [{ id: 'p1' }], nodes: [task('a')], edges: [] })
    orchestrator.confirmPreview({ sessionId: 'session-edit', token: preview.confirmationToken })
    const started = await orchestrator.startRun({
      sessionId: 'session-edit',
      confirmed: true,
      confirmationToken: preview.confirmationToken,
      executorFactory: () => async () => ({ output: 'not-json' })
    })
    const paused = await orchestrator.schedulers.get(started.runId).wait()
    assert.equal(paused.status, 'paused')
    const current = orchestrator.getGraph(preview.graph.graphId, preview.graph.revision)
    assert.throws(() => orchestrator.saveManualGraph({
      sessionId: 'session-edit',
      graph: { ...current, nodes: [task('a', { title: '不能改写失败节点' })] }
    }), (error) => error.code === 'GRAPH_RUN_ACTIVE')

    const next = await orchestrator.saveManualGraph({
      sessionId: 'session-edit',
      graph: {
        ...current,
        nodes: [...current.nodes, task('b')],
        edges: [{ from: 'a', to: 'b' }]
      }
    })
    assert.equal(next.graph.revision, current.revision + 1)
    assert.equal(orchestrator.getBinding('session-edit').activeRunId, '')
    await assert.rejects(() => orchestrator.retryRun(started.runId), (error) => error.code === 'RUN_NOT_ACTIVE')
    assert.throws(() => orchestrator.saveManualGraph({
      sessionId: 'session-edit',
      graph: { ...current, revision: current.revision, goal: 'stale edit' }
    }), (error) => error.code === 'GRAPH_REVISION_CONFLICT')
    orchestrator.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planner edits of a manual graph are template-only and require save-as/overwrite confirmation', async () => {
  const root = tempRoot()
  try {
    let ids = 0
    const orchestrator = new GraphJobOrchestrator({
      storageRoot: root,
      idFactory: (kind) => `${kind}-${++ids}`,
      services: { agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }
    })
    orchestrator.initialize()
    orchestrator.setProfiles([profile()])
    const saved = orchestrator.saveManualGraph({ sessionId: 'manual-session', goal: '手工任务', agentProfiles: [{ id: 'p1' }], nodes: [task('a')], edges: [] })
    await assert.rejects(() => orchestrator.previewPlanner({ sessionId: 'manual-session', goal: '自动改手工图', patch: { baseRevision: saved.graph.revision, operations: [] } }), (error) => error.code === 'TEMPLATE_DECISION_REQUIRED')

    const saveAs = await orchestrator.previewPlanner({
      sessionId: 'manual-session',
      templateMode: 'saveAs',
      templateName: '分析模板',
      patch: { baseRevision: saved.graph.revision, operations: [{ op: 'setGoal', value: '模板目标' }] }
    })
    assert.equal(saveAs.templateDecision.mode, 'saveAs')
    assert.equal(saveAs.validation.valid, true)
    const firstTemplate = orchestrator.confirmTemplate({ sessionId: 'manual-session', token: saveAs.confirmationToken })
    assert.equal(firstTemplate.currentRevision, 1)
    assert.equal(orchestrator.confirmTemplate({ sessionId: 'manual-session', token: saveAs.confirmationToken }).currentRevision, 1)

    const overwrite = await orchestrator.previewPlanner({
      sessionId: 'manual-session',
      templateMode: 'overwrite',
      templateId: firstTemplate.id,
      patch: { baseRevision: saved.graph.revision, operations: [{ op: 'setGoal', value: '模板目标 v2' }] }
    })
    const secondTemplate = orchestrator.confirmTemplate({ sessionId: 'manual-session', token: overwrite.confirmationToken })
    assert.equal(secondTemplate.currentRevision, 2)
    orchestrator.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Codex executor maps provider capabilities, permission, reasoning and child session output', async () => {
  const root = tempRoot()
  try {
    const value = graph([task('a')], [], {
      agentProfiles: [profile('codex', {
        executor: 'codex',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        permissionMode: 'approve-for-me'
      })]
    })
    value.nodes[0].agentProfileId = 'codex'
    const requests = []
    const services = {
      subagents: {
        getProvider: () => ({ capabilities: { toolFilter: true, depthLimit: true, persona: true, permissionMode: true, outputSchema: true, reasoningEfforts: ['high'] } }),
        start: async (_name, request) => {
          requests.push(request)
          return {
            id: 'codex-child-1',
            result: Promise.resolve({ stopReason: 'completed', structured: { text: 'Codex 完成', artifactRefs: [] } }),
            dispose() {}
          }
        }
      }
    }
    const executor = new CodexExecutor({
      services,
      cwd: root,
      capabilityCatalog: {
        tools: ['read_file', 'skill'],
        subagentProviders: [{ name: 'codex', capabilities: { toolFilter: true, depthLimit: true, persona: true, permissionMode: true, outputSchema: true, reasoningEfforts: ['high'] } }],
        executors: { codex: { providers: ['codex'] } }
      }
    })
    const output = await executor.runNode({
      graph: value,
      node: value.nodes[0],
      profile: value.agentProfiles[0],
      predecessorResults: [],
      parentAgent: { session: { header: { id: 'parent', cwd: root } } },
      attempt: 1,
      signal: new AbortController().signal,
      cwd: root
    })
    assert.deepEqual(output.result, { text: 'Codex 完成', artifactRefs: [] })
    assert.equal(output.childSessionId, 'codex-child-1')
    assert.equal(requests[0].agentOptions.model, 'gpt-5.6-sol')
    assert.equal(requests[0].agentOptions.reasoningEffort, 'high')
    assert.equal(requests[0].permissionMode, 'approve-for-me')
    assert.equal(requests[0].toolFilter.deny.includes('skill'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage 4 executor failures are fail-loud and classify auth, rate-limit, missing payload and empty output', async () => {
  const root = tempRoot()
  try {
    const value = graph([task('a')], [], {
      agentProfiles: [profile('codex', { executor: 'codex', provider: 'codex', model: 'gpt-5.6-sol' })]
    })
    value.nodes[0].agentProfileId = 'codex'
    const capabilities = {
      tools: [],
      subagentProviders: [{ name: 'codex', capabilities: { toolFilter: true, depthLimit: true } }],
      executors: { codex: { providers: ['codex'] } }
    }
    const request = {
      graph: value,
      node: value.nodes[0],
      profile: value.agentProfiles[0],
      predecessorResults: [],
      parentAgent: { session: { header: { id: 'parent', cwd: root } } },
      attempt: 1,
      signal: new AbortController().signal,
      cwd: root
    }
    const missing = new CodexExecutor({ services: { subagents: { start: async () => ({}) } }, cwd: root, capabilityCatalog: capabilities })
    await assert.rejects(() => missing.runNode(request), (error) => error.code === 'MISSING_SUBAGENT_PAYLOAD')

    const failed = (diagnostic) => new CodexExecutor({
      services: { subagents: { start: async () => ({ result: Promise.resolve({ stopReason: 'error', diagnostic }), dispose() {} }) } },
      cwd: root,
      capabilityCatalog: capabilities
    })
    await assert.rejects(() => failed('authentication required').runNode(request), (error) => error.code === 'AUTH_REQUIRED' && error.category === 'permission')
    await assert.rejects(() => failed('HTTP 429 rate limit').runNode(request), (error) => error.code === 'RATE_LIMIT' && error.category === 'rate-limit')
    assert.deepEqual(classifyExecutionError({ code: 'AUTH_REQUIRED' }), { category: 'permission', retryable: false })
    assert.deepEqual(classifyExecutionError({ code: 'RATE_LIMIT' }), { category: 'rate-limit', retryable: true })
    assert.deepEqual(normalizeNodeOutput({ output: [{ role: 'assistant', content: [{ type: 'text', text: '{"text":"variant"}' }] }] }, { cwd: root }), { text: 'variant', artifactRefs: [] })
    assert.throws(() => normalizeNodeOutput({ structured: { text: '', artifactRefs: [] } }, { cwd: root }), OutputContractError)

    const unsupported = new CodexExecutor({
      services: { subagents: { start: async () => ({ result: Promise.resolve({ stopReason: 'completed', structured: { text: 'x', artifactRefs: [] } }), dispose() {} }) } },
      cwd: root,
      capabilityCatalog: capabilities
    })
    await assert.rejects(() => unsupported.runNode({ ...request, profile: { ...request.profile, permissionMode: 'approve-for-me' } }), CapabilityMismatchError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH executor creates an independent child and strips Skill/Graph management tools', async () => {
  const root = tempRoot()
  try {
    const value = graph([task('a')])
    const requests = []
    const executor = new DshInProcessExecutor({
      cwd: root,
      capabilityCatalog: {
        tools: ['read_file', 'skill', 'graphjob_plan'],
        executors: { dsh: { provider: 'spawn' } },
        subagentProviders: [{ name: 'spawn', capabilities: { outputSchema: true } }]
      },
      services: {
        subagents: {
          start: async (_name, request) => {
            requests.push(request)
            return { id: 'dsh-child-1', result: Promise.resolve({ stopReason: 'completed', structured: { text: 'DSH 完成', artifactRefs: [] } }), dispose() {} }
          }
        }
      }
    })
    const output = await executor.runNode({
      graph: value,
      node: value.nodes[0],
      profile: value.agentProfiles[0],
      predecessorResults: [],
      parentAgent: { session: { header: { id: 'parent' } } },
      attempt: 1,
      signal: new AbortController().signal,
      cwd: root
    })
    assert.equal(output.childSessionId, 'dsh-child-1')
    assert.equal(requests[0].toolFilter.allow, undefined)
    assert.equal(requests[0].toolFilter.deny.includes('skill'), true)
    assert.equal(requests[0].toolFilter.deny.includes('graphjob_plan'), true)
    assert.deepEqual(requests[0].outputSchema.required, ['text'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('host routes expose immutable preview reads and template scope metadata', async () => {
  const root = tempRoot()
  const registrations = []
  const cleanups = []
  const promptHooks = []
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    commands: { register: () => {} },
    skills: { register: () => {} },
    tools: { register: () => {} },
    webServer: { register: (value) => { registrations.push(value); return () => {} } }
  }
  const ctx = {
    get: (name) => services[name],
    effect: (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    on: (name, handler) => { promptHooks.push({ name, handler }); return () => {} }
  }
  try {
    const host = createHost({ storageRoot: root })
    host.apply(ctx)
    const graphRoute = registrations.find((item) => item.kind === 'prefix' && item.path === '/graph-job-orchestrator/graphs')
    assert.ok(graphRoute)
    const preview = await host.orchestrator.preview({
      sessionId: 'route-session',
      goal: 'route preview',
      agentProfiles: [{ id: 'dsh-default' }],
      nodes: [task('a')],
      edges: []
    })
    const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await graphRoute.handler({ method: 'GET', url: `/graph-job-orchestrator/graphs/${preview.graph.graphId}/preview/${preview.previewId}` }, response)
    assert.equal(response.status, 200)
    assert.equal(response.body.preview.previewId, preview.previewId)
    const promptHook = promptHooks.find((item) => item.name === 'system-prompt/assemble')
    assert.ok(promptHook)
    const assembly = await promptHook.handler({}, { agent: { session: { header: { id: 'main', cwd: root } } } }, async () => ({ sections: [] }))
    assert.match(assembly.sections.find((item) => item.name === 'graph-job-orchestrator:planner-roster').text, /dsh-default/)
    assert.match(buildPlannerContext({ roster: [{ id: 'writer', name: 'Writer' }], capabilitySnapshot: { tools: ['read_file'] } }), /writer/)
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('client bundle registers the Graph Job view without executing browser code on import', () => {
  const source = readFileSync(join(process.cwd(), 'market/graph-job-orchestrator/lib/client.js'), 'utf8')
  let descriptor
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { descriptor = value } } } })
  assert.equal(descriptor.id, '@p-dsh-market/graph-job-orchestrator')
  assert.match(source, /conversation\.view/)
  assert.match(source, /settings\.section/)
  assert.match(source, /Reasoning effort/)
  assert.match(source, /DSH in-process/)
  assert.match(source, /application\/x-graph-node/)
  assert.match(source, /graphJobOrchestrator\.open/)
  assert.match(source, /previewTemplate\('overwrite'\)/)
  assert.match(source, /切换到模板/)
  assert.match(source, /key: 'terminate'/)
})
