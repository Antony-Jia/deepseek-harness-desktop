import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
import { makeUserMessage } from '../market/multi-agent-roundtable/lib/protocol.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const text = (relativePath) => readFileSync(`${root}/${relativePath}`, 'utf8')

test('multi-agent roundtable package exposes the planned host/client contract', () => {
  const manifest = JSON.parse(text('market/multi-agent-roundtable/package.json'))
  const patch = text('market/multi-agent-roundtable/cordis.patch.yml')
  const client = text('market/multi-agent-roundtable/lib/client.js')
  const host = text('market/multi-agent-roundtable/lib/index.js')

  assert.equal(manifest.name, '@p-dsh-market/multi-agent-roundtable')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.protocolVersion, 1)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.market.capabilities.sort(), ['client', 'host', 'skills'])
  assert.match(patch, /inject: \[agents, settings, sessions, webServer\]/)
  assert.match(host, /BASE_PATH.*config/)
  assert.match(host, /BASE_PATH.*discussions/)
  assert.match(host, /text\/event-stream/)
  assert.match(client, /name: 'conversation\.view', id: 'multi-agent-roundtable'/)
  assert.match(client, /name: 'settings\.section', id: 'multi-agent-roundtable'/)
  assert.match(client, /EventSource/)
  assert.match(client, /safeHref/)
  assert.doesNotMatch(client, /dangerouslySetInnerHTML/)
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
              message: { id: `answer-${options.sessionId}`, content: [{ type: 'text', text: '这是一个可执行结论。' }] }
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
    config: defaultConfig(),
    idFactory: () => 'discussion-test',
    now: () => 1700000000000
  })

  const createdDiscussion = await orchestrator.create({
    prompt: '验证多 Agent 讨论',
    mode: 'independent',
    rounds: 1,
    maxParallel: 2,
    participantIds: ['product-manager', 'architect'],
    parentSessionId: 'parent-session'
  })
  assert.equal(createdDiscussion.id, 'discussion-test')
  await orchestrator.discussions.get('discussion-test').runPromise

  const discussion = orchestrator.get('discussion-test')
  assert.equal(discussion.status, 'completed')
  assert.equal(discussion.participants.length, 2)
  assert.equal(created.length, 2)
  assert.ok(discussion.messages.some((message) => message.content.includes('可执行结论')))
  assert.ok(discussion.events.some((event) => event.type === 'discussion/completed'))

  const metadata = orchestrator.persistedMetadata()[0]
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
  await orchestrator.dispose()
})

test('client bundle exports safe markdown helpers through the DSH loader', () => {
  let loaded
  vm.runInNewContext(text('market/multi-agent-roundtable/lib/client.js'), {
    Symbol,
    URL,
    window: { location: { href: 'http://dsh.local/' }, __ModuleLoader__: { load(spec) { loaded = spec } } }
  })
  const React = {
    createElement(type, props, ...children) { return { type, props, children } }
  }
  const client = loaded.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual(Array.from(client.inject), ['slots'])
  assert.ok(client.markdownBlocks('## 标题\n\n- 安全内容').some((block) => block.type === 'heading'))
  assert.ok(client.markdownBlocks('| 角色 | 结论 |\n| --- | --- |\n| 架构师 | 可行 |').some((block) => block.type === 'table'))
  assert.equal(client.safeHref('javascript:alert(1)'), '#')
  assert.match(client.safeHref('https://example.com'), /^https:\/\//)
})
