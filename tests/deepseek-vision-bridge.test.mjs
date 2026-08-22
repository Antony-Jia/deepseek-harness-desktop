import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import visionBridgePlugin from '../market/deepseek-vision-bridge/lib/index.js'
import {
  MODEL,
  PROVIDER,
  TOOL_NAME,
  analyzeSessionImages,
  createVisionCommandDefinition,
  createVisionToolDefinition,
  hideVisionToolForCapableModel,
  selectSessionImages
} from '../market/deepseek-vision-bridge/lib/tool.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const text = (relativePath) => readFileSync(`${root}/${relativePath}`, 'utf8')
const image = (attachmentId, name) => ({
  attachmentId,
  mediaType: 'image/png',
  bytes: 128,
  width: 16,
  height: 16,
  name
})
const session = (refs) => ({
  deriveMessages: () => [{
    id: 'message-1',
    role: 'user',
    source: { kind: 'user' },
    content: refs.map((attachment) => ({ type: 'image', attachment }))
  }]
})

test('vision bridge package is market-installable and registered in the catalog', () => {
  const manifest = JSON.parse(text('market/deepseek-vision-bridge/package.json'))
  const patch = text('market/deepseek-vision-bridge/cordis.patch.yml')
  const catalog = JSON.parse(text('market/catalog-v1.json'))

  assert.equal(manifest.name, '@p-dsh-market/deepseek-vision-bridge')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.market.capabilities.sort(), ['client', 'host', 'skills'])
  assert.equal(manifest.dsh.desktop, undefined)
  assert.match(patch, /inject: \[commands, llm, skills, systemPrompt, tools\]/)
  assert.ok(catalog.packages.includes(manifest.name))
})

test('host registers the skill and tool through reversible effects', () => {
  const registered = { commands: [], events: [], skills: [], tools: [] }
  const services = {
    commands: { register(value) { registered.commands.push(value); return () => {} } },
    llm: {},
    skills: { register(value) { registered.skills.push(value); return () => {} } },
    tools: { register(value) { registered.tools.push(value); return () => {} } }
  }
  const effects = []
  const ctx = {
    get: (name) => services[name],
    effect(factory) { effects.push(factory()) },
    on(name, listener) { registered.events.push({ name, listener }); return () => {} }
  }

  visionBridgePlugin.apply(ctx)

  assert.equal(registered.commands[0].name, 'vision')
  assert.equal(registered.commands[0].input.images, true)
  assert.equal(registered.skills[0].name, 'deepseek-vision-bridge')
  assert.match(registered.skills[0].content, /deepseek_vision_analyze/)
  assert.equal(registered.tools[0].name, TOOL_NAME)
  assert.equal(registered.events[0].name, 'system-prompt/assemble')
  assert.equal(effects.length, 3)
  assert.ok(effects.every((dispose) => typeof dispose === 'function'))
})

test('image selection defaults to the latest session image group and supports explicit ids', () => {
  const first = image('sha256:first', 'first.png')
  const second = image('sha256:second', 'second.png')

  assert.deepEqual(selectSessionImages(session([first, second])), [first, second])
  assert.deepEqual(selectSessionImages(session([first, second]), ['sha256:first']), [first])
  assert.throws(
    () => selectSessionImages(session([first]), ['sha256:missing']),
    /当前会话中找不到图片附件/
  )
})

test('vision analysis routes current-session image refs through the official vision model', async () => {
  const calls = []
  const llm = {
    async resolveModelInfo(provider, model) {
      calls.push({ kind: 'resolve', provider, model })
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      calls.push({ kind: 'stream', options })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '图片中有一只' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '图片中有一只猫。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const ref = image('sha256:cat', 'cat.png')
  const signal = new AbortController().signal
  const value = await analyzeSessionImages(llm, { query: '请描述图片' }, { agent: { session: session([ref]) }, signal })

  assert.equal(value.answer, '图片中有一只猫。')
  assert.equal(value.provider, PROVIDER)
  assert.equal(value.model, MODEL)
  assert.equal(value.truncated, false)
  assert.deepEqual(value.attachments, [{ attachmentId: 'sha256:cat', name: 'cat.png', width: 16, height: 16 }])
  assert.deepEqual(calls[0], { kind: 'resolve', provider: PROVIDER, model: MODEL })
  assert.equal(calls[1].options.provider, PROVIDER)
  assert.equal(calls[1].options.model, MODEL)
  assert.equal(calls[1].options.signal, signal)
  assert.equal(calls[1].options.messages[0].content[0].type, 'image')
  assert.equal(calls[1].options.messages[0].content[0].attachment, ref)
})

test('vision command admits image blocks and asks the current agent to use the bridge only when needed', async () => {
  const ref = image('sha256:command', 'screen.png')
  let message
  const definition = createVisionCommandDefinition()
  const result = await definition.handler({
    rawInput: ' 读取截图中的错误 ',
    attachments: [{ type: 'image', attachment: ref }],
    agent: { followup(value) { message = value } }
  })

  assert.equal(definition.name, 'vision')
  assert.equal(definition.input.images, true)
  assert.equal(result.kind, 'success')
  assert.equal(message.content[0].type, 'image')
  assert.equal(message.content[0].attachment, ref)
  assert.match(message.content[1].text, /读取截图中的错误/)
  assert.match(message.content[1].text, /非视觉模型/)
})

test('vision-capable model does not receive the bridge tool schema', async () => {
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    }
  }
  const bridge = { name: TOOL_NAME, description: 'bridge', parameters: {} }
  const other = { name: 'other_tool', description: 'other', parameters: {} }
  const assembly = { sections: [], contexts: [], variables: { provider: 'visual', model: 'visual-model' }, tools: [bridge, other] }
  const filtered = await hideVisionToolForCapableModel(llm, assembly, {})

  assert.deepEqual(filtered.tools, [other])
  assert.deepEqual(assembly.tools, [bridge, other])
})

test('vision-capable caller is prevented from invoking the bridge tool', async () => {
  const ref = image('sha256:visual', 'visual.png')
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    },
    async *stream() {
      assert.fail('vision model must not reach the bridge stream')
    }
  }
  const agent = {
    session: {
      ...session([ref]),
      events: [{ type: 'request/header', data: { header: { config: { provider: 'visual-provider', model: 'visual-model' } } } }]
    }
  }

  await assert.rejects(
    analyzeSessionImages(llm, { query: '描述图片' }, { agent, signal: new AbortController().signal }),
    /当前模型已经支持图片/
  )
})

test('tool definition exposes a bounded image-analysis contract', async () => {
  const expected = {
    answer: '结果',
    attachments: [],
    provider: PROVIDER,
    model: MODEL,
    truncated: false
  }
  const definition = createVisionToolDefinition(async () => expected)

  assert.equal(definition.name, TOOL_NAME)
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, ['query'])
  assert.equal(definition.parameters.properties.attachmentIds.maxItems, 8)
  assert.equal(await definition.execute({ query: '识别文字' }, {}), expected)
  assert.equal(definition.output.render({}, expected)[0].text, '结果')
})
