import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

import {
  defaultConfig,
  normalizeConfig,
  normalizeDiscussionInput
} from '../market/multi-agent-roundtable/lib/role-schema.js'
import {
  RoundtableOrchestrator,
  buildReviewContext,
  runWithConcurrency
} from '../market/multi-agent-roundtable/lib/orchestration.js'
import { makeUserMessage, messageMarkdown, messageReasoning } from '../market/multi-agent-roundtable/lib/protocol.js'
import {
  readPluginConfig,
  resolvePluginConfigPath,
  writePluginConfig
} from '../market/multi-agent-roundtable/lib/config-storage.js'
import {
  createConversation,
  normalizeConversationIndex,
  readConversationIndex,
  resolveConversationIndexPath,
  writeConversationIndex
} from '../market/multi-agent-roundtable/lib/conversation-storage.js'
import {
  createRoundtableToolDefinition,
  roundtableToolValue
} from '../market/multi-agent-roundtable/lib/tool.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const text = (relativePath) => readFileSync(`${root}/${relativePath}`, 'utf8')

test('multi-agent roundtable package exposes the planned host/client contract', () => {
  const manifest = JSON.parse(text('market/multi-agent-roundtable/package.json'))
  const patch = text('market/multi-agent-roundtable/cordis.patch.yml')
  const client = text('market/multi-agent-roundtable/lib/client.js')
  const host = text('market/multi-agent-roundtable/lib/index.js')
  const orchestration = text('market/multi-agent-roundtable/lib/orchestration.js')

  assert.equal(manifest.name, '@p-dsh-market/multi-agent-roundtable')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./conversation-storage'], './lib/conversation-storage.js')
  assert.equal(manifest.dsh.protocolVersion, 1)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.market.capabilities.sort(), ['client', 'desktop-shell', 'host', 'skills'])
  assert.deepEqual(manifest.dsh.desktop.permissions, ['shell:titlebar'])
  assert.equal(manifest.dsh.desktop.contributes.titlebarActions[0].action.method, 'multiAgentRoundtable.open')
  assert.match(patch, /inject: \[agentDefaultModel, agentPresets, agents, settings, sessions, skills, tools, webServer\]/)
  assert.match(host, /BASE_PATH.*config/)
  assert.match(host, /BASE_PATH.*discussions/)
  assert.match(host, /BASE_PATH.*conversations/)
  assert.match(host, /text\/event-stream/)
  assert.match(client, /name: 'conversation\.view', id: 'multi-agent-roundtable'/)
  assert.match(client, /name: 'settings\.section', id: 'multi-agent-roundtable'/)
  assert.match(client, /name: 'conversation\.session\.header\.actions', id: 'multi-agent-roundtable'/)
  assert.match(client, /name: 'shell\.overlay', id: 'multi-agent-roundtable'/)
  assert.match(client, /multiAgentRoundtable\.open/)
  assert.match(client, /Multi-Agent 对话模式/)
  assert.match(client, /activateConversationView/)
  assert.match(client, /setDirectConversationMode/)
  assert.match(client, /LLM Provider/)
  assert.match(client, /mar-message-bubble/)
  assert.match(client, /mar-message-toggle/)
  assert.match(client, /mar-reasoning/)
  assert.match(client, /新建群聊/)
  assert.match(client, /群聊历史记录/)
  assert.match(host, /writePluginConfig/)
  assert.match(host, /createRoundtableToolDefinition/)
  assert.match(orchestration, /composeFrom/)
  assert.match(client, /EventSource/)
  assert.match(client, /safeHref/)
  assert.doesNotMatch(client, /dangerouslySetInnerHTML/)
})

test('roundtable tool exposes formal role messages as a native tool result', async () => {
  const discussion = {
    id: 'discussion-native-tool',
    conversationId: 'conversation-native-tool',
    status: 'completed',
    prompt: '请多角色评审方案',
    participants: [{ roleId: 'architect', roleName: '架构师', status: 'completed' }],
    messages: [
      { roleId: 'user', roleName: '你', round: 0, status: 'complete', content: '问题' },
      { roleId: 'architect', roleName: '架构师', round: 1, status: 'complete', content: '正式意见', reasoning: '内部思考' }
    ]
  }
  const value = roundtableToolValue(discussion)
  assert.equal(value.messages.length, 1)
  assert.equal(value.messages[0].content, '正式意见')
  assert.equal('reasoning' in value.messages[0], false)

  let received
  const definition = createRoundtableToolDefinition(async (args, exec) => {
    received = { args, exec }
    return value
  })
  const exec = { signal: new AbortController().signal }
  assert.equal(definition.name, 'multi_agent_discuss')
  assert.equal(await definition.execute({ topic: discussion.prompt }, exec), value)
  assert.equal(received.args.topic, discussion.prompt)
  assert.equal(definition.output.render({}, value)[0].type, 'text')
  assert.match(definition.output.render({}, value)[0].text, /架构师/)
})

test('conversation index persists independently and migrates legacy discussions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roundtable-conversations-'))
  try {
    const path = resolveConversationIndexPath({ LOCALAPPDATA: root })
    const legacy = [{
      id: 'discussion-legacy',
      parentSessionId: 'parent-1',
      prompt: '旧讨论主题',
      mode: 'review',
      rounds: 2,
      status: 'completed',
      createdAt: 10,
      updatedAt: 20,
      participants: [{ roleId: 'architect', childSessionId: 'child-1' }]
    }]
    const migrated = normalizeConversationIndex(null, legacy)
    assert.equal(migrated.conversations[0].discussionId, 'discussion-legacy')
    assert.equal(migrated.conversations[0].discussion.participants[0].childSessionId, 'child-1')
    migrated.conversations.unshift(createConversation({ id: 'conversation-new', boundSessionId: '' }, 30))
    await writeConversationIndex(path, migrated)
    const restored = readConversationIndex(path)
    assert.equal(restored.conversations.length, 2)
    assert.equal(restored.conversations[0].id, 'conversation-new')
    assert.match(path, /dsh-desktop[\\/]plugin-data[\\/]multi-agent-roundtable[\\/]conversations\.json$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('role configuration persists under the plugin-owned data directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roundtable-'))
  try {
    const path = resolvePluginConfigPath({ LOCALAPPDATA: root })
    const config = defaultConfig()
    config.roles[0].prompt = '插件专属角色 Prompt'
    config.roles[0].provider = 'provider-a'
    config.roles[0].model = 'model-a'
    await writePluginConfig(path, config)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(stored.roles[0].prompt, '插件专属角色 Prompt')
    assert.equal(stored.roles[0].provider, 'provider-a')
    assert.equal(stored.roles[0].model, 'model-a')
    assert.equal(stored.discussions, undefined)
    assert.equal(readPluginConfig(path, defaultConfig()).roles[0].prompt, '插件专属角色 Prompt')
    assert.match(path, /dsh-desktop[\\/]plugin-data[\\/]multi-agent-roundtable[\\/]roles\.json$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('roundtable configuration keeps host role and selected participants valid', () => {
  const config = defaultConfig()
  assert.equal(config.roles.find((role) => role.id === 'facilitator').enabled, true)

  const request = normalizeDiscussionInput({
    prompt: '评审一个新功能',
    mode: 'host',
    participantIds: ['product-manager', 'architect']
  }, config)
  assert.equal(request.hostRoleId, 'facilitator')
  assert.deepEqual(request.participantIds, ['product-manager', 'architect', 'facilitator'])

  assert.throws(() => normalizeConfig({
    ...config,
    roles: config.roles.concat([config.roles[0]])
  }), /角色 ID 重复/)
})

test('review context is bounded and concurrency limit is honored', async () => {
  const context = buildReviewContext([
    { roleId: 'a', roleName: 'A', content: '观点 A' },
    { roleId: 'b', roleName: 'B', content: '观点 B' }
  ])
  assert.match(context, /### A/)
  assert.match(context, /### B/)
  assert.doesNotMatch(buildReviewContext([{ roleId: 'a', roleName: 'A', content: 'skip' }], 'a'), /skip/)

  let active = 0
  let peak = 0
  const result = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
    return value * 2
  })
  assert.deepEqual(result, [2, 4, 6, 8, 10])
  assert.equal(peak, 2)
})

test('orchestrator creates child sessions and projects assistant output', async () => {
  let orchestrator
  const created = []
  const agents = {
    async create(options) {
      const session = { id: options.sessionId }
      options.setup?.({
        systemPrompt: {
          section() {}
        }
      })
      const agent = {
        followup(message) {
          assert.equal(message.role, 'user')
          assert.equal(message.source.kind, 'plugin')
          assert.equal(message.source.form, 'relay')
          orchestrator.onSessionEvent(session, {
            type: 'assistant/chunk',
            data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '这是' } }
          })
          orchestrator.onSessionEvent(session, {
            type: 'assistant/message',
            data: {
              turn: 1,
              step: 1,
              message: { id: `answer-${options.sessionId}`, content: [
                { type: 'reasoning', text: '这是内部思考，不应混入正式回答。' },
                { type: 'text', text: '这是一个可执行结论。' }
              ] }
            }
          })
        },
        async whenIdle() {},
        cancel() {}
      }
      created.push({ session, options })
      return { agent, dispose() {} }
    }
  }
  orchestrator = new RoundtableOrchestrator({
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'openrouter', model: 'deepseek/test-model' }) },
    config: defaultConfig(),
    idFactory: () => 'discussion-test',
    now: () => 1700000000000
  })

  const createdDiscussion = await orchestrator.create({
    conversationId: 'conversation-test',
    prompt: '验证多 Agent 讨论',
    mode: 'independent',
    rounds: 1,
    maxParallel: 2,
    participantIds: ['product-manager', 'architect'],
    parentSessionId: 'parent-session'
  })
  assert.equal(createdDiscussion.id, 'discussion-test')
  assert.equal(createdDiscussion.conversationId, 'conversation-test')
  await orchestrator.discussions.get('discussion-test').runPromise

  const discussion = orchestrator.get('discussion-test')
  assert.equal(discussion.status, 'completed')
  assert.equal(discussion.participants.length, 2)
  assert.equal(created.length, 2)
  assert.deepEqual(created[0].options.agentOptions, { provider: 'openrouter', model: 'deepseek/test-model', maxTokens: 4096 })
  assert.ok(discussion.messages.some((message) => message.content.includes('可执行结论')))
  assert.ok(discussion.messages.some((message) => message.reasoning.includes('内部思考')))
  assert.ok(discussion.messages.every((message) => !message.content.includes('内部思考')))
  assert.ok(discussion.events.some((event) => event.type === 'discussion/completed'))

  const metadata = orchestrator.persistedMetadata()[0]
  assert.equal(metadata.conversationId, 'conversation-test')
  const restoredSessions = new Map(metadata.participants.map((participant) => [participant.childSessionId, {
    id: participant.childSessionId,
    events: [{
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { id: `restored-${participant.roleId}`, content: [{ type: 'text', text: '恢复的历史消息。' }] } }
    }]
  }]))
  const restored = new RoundtableOrchestrator({
    sessions: { get(id) { return restoredSessions.get(id) } },
    config: defaultConfig(),
    now: () => 1700000000001
  })
  restored.hydrate([metadata])
  assert.equal(restored.get('discussion-test').status, 'completed')
  assert.ok(restored.get('discussion-test').messages.some((message) => message.content === '恢复的历史消息。'))
  await restored.dispose()

  const userMessage = makeUserMessage('hello', 'message-1')
  assert.equal(userMessage.id, 'message-1')
  const splitMessage = { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] }
  assert.equal(messageMarkdown(splitMessage), 'answer')
  assert.equal(messageReasoning(splitMessage), 'think')
  await orchestrator.dispose()
})

test('orchestrator surfaces child LLM turn errors instead of reporting false completion', async () => {
  let orchestrator
  const agents = {
    async create(options) {
      const session = { id: options.sessionId }
      return {
        agent: {
          followup() {
            orchestrator.onSessionEvent(session, {
              type: 'turn/end',
              data: { reason: { kind: 'error', message: 'provider unavailable' } }
            })
          },
          async whenIdle() {},
          cancel() {}
        },
        dispose() {}
      }
    }
  }
  orchestrator = new RoundtableOrchestrator({
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'openrouter', model: 'deepseek/test-model' }) },
    config: defaultConfig(),
    idFactory: () => 'discussion-error'
  })

  await orchestrator.create({
    prompt: '验证错误投影',
    mode: 'independent',
    rounds: 1,
    participantIds: ['product-manager']
  })
  await orchestrator.discussions.get('discussion-error').runPromise

  const discussion = orchestrator.get('discussion-error')
  assert.equal(discussion.status, 'failed')
  assert.equal(discussion.participants[0].status, 'failed')
  assert.match(discussion.participants[0].error, /provider unavailable/)
  assert.match(discussion.error, /所有参与角色均执行失败/)
  await orchestrator.dispose()
})

test('roundtable child inherits parent preset, cwd and tools while blocking recursive roundtables', async () => {
  let orchestrator
  const parentCtx = { name: 'parent-agent-context' }
  const parent = {
    session: { header: { id: 'parent-with-tools', cwd: 'D:\\Code\\deepseek-harness', delegationDepth: 0 } },
    ctx: parentCtx
  }
  const compositionCalls = []
  const restrictions = []
  const created = []
  const agents = {
    get(id) { return id === parent.session.header.id ? parent : undefined },
    async create(options) {
      const childCtx = {
        systemPrompt: { section() {} },
        tools: { restrict(filter) { restrictions.push(filter) } }
      }
      await options.setup(childCtx)
      const session = { id: options.sessionId }
      const agent = {
        followup() {
          orchestrator.onSessionEvent(session, {
            type: 'assistant/message',
            data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '继承能力后的回答' }] } }
          })
        },
        async whenIdle() {},
        cancel() {}
      }
      created.push(options)
      return { agent, dispose() {} }
    }
  }
  const agentPresets = {
    composedPreset(ctx) {
      assert.equal(ctx, parentCtx)
      return 'workspace-preset'
    },
    composeFrom(childCtx, sourceCtx) { compositionCalls.push({ childCtx, sourceCtx }) }
  }
  orchestrator = new RoundtableOrchestrator({
    agents,
    agentPresets,
    agentDefaultModel: { currentSelection: () => ({ provider: 'openrouter', model: 'deepseek/test-model' }) },
    config: defaultConfig(),
    idFactory: () => 'discussion-inherits-parent'
  })

  await orchestrator.create({
    parentSessionId: parent.session.header.id,
    prompt: '验证能力继承',
    mode: 'independent',
    rounds: 1,
    participantIds: ['architect']
  })
  await orchestrator.waitForCompletion('discussion-inherits-parent')
  assert.equal(compositionCalls.length, 1)
  assert.equal(compositionCalls[0].sourceCtx, parentCtx)
  assert.deepEqual(restrictions, [{ deny: ['multi_agent_discuss'] }])
  assert.equal(created[0].meta.cwd, 'D:\\Code\\deepseek-harness')
  assert.equal(created[0].meta.agentPreset, 'workspace-preset')
  assert.equal(created[0].meta.parentSession, 'parent-with-tools')
  assert.equal(created[0].meta.delegationDepth, 1)
  await orchestrator.dispose()
})

test('client bundle exports safe markdown helpers through the DSH loader', () => {
  let loaded
  let selectedTab = ''
  const tabs = [
    { textContent: '聊天', click() { selectedTab = 'chat' } },
    { textContent: '多 Agent 讨论', click() { selectedTab = 'multi-agent-roundtable' } }
  ]
  vm.runInNewContext(text('market/multi-agent-roundtable/lib/client.js'), {
    Symbol,
    URL,
    document: { querySelectorAll(selector) { return selector === '[role="tab"]' ? tabs : [] } },
    window: { location: { href: 'http://dsh.local/' }, __ModuleLoader__: { load(spec) { loaded = spec } } }
  })
  const React = {
    createElement(type, props, ...children) { return { type, props, children } }
  }
  const client = loaded.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual(Array.from(client.inject), ['slots', 'sessions'])
  assert.ok(client.markdownBlocks('## 标题\n\n- 安全内容').some((block) => block.type === 'heading'))
  assert.ok(client.markdownBlocks('| 角色 | 结论 |\n| --- | --- |\n| 架构师 | 可行 |').some((block) => block.type === 'table'))
  assert.equal(client.safeHref('javascript:alert(1)'), '#')
  assert.match(client.safeHref('https://example.com'), /^https:\/\//)
  assert.equal(client.activateConversationView(true), true)
  assert.equal(selectedTab, 'multi-agent-roundtable')
  assert.equal(client.activateConversationView(false), true)
  assert.equal(selectedTab, 'chat')
})
