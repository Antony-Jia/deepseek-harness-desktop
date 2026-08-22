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
  createVisionToolDefinition,
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
  assert.match(patch, /inject: \[llm, skills, tools\]/)
  assert.ok(catalog.packages.includes(manifest.name))
})

test('host registers the skill and tool through reversible effects', () => {
  const registered = { skills: [], tools: [] }
  const services = {
    llm: {},
    skills: { register(value) { registered.skills.push(value); return () => {} } },
    tools: { register(value) { registered.tools.push(value); return () => {} } }
  }
  const effects = []
  const ctx = {
    get: (name) => services[name],
    effect(factory) { effects.push(factory()) }
  }

  visionBridgePlugin.apply(ctx)

  assert.equal(registered.skills[0].name, 'deepseek-vision-bridge')
  assert.match(registered.skills[0].content, /deepseek_vision_analyze/)
  assert.equal(registered.tools[0].name, TOOL_NAME)
  assert.equal(effects.length, 2)
  assert.ok(effects.every((dispose) => typeof dispose === 'function'))
})

test('image selection defaults to the latest session image and supports explicit ids', () => {
  const first = image('sha256:first', 'first.png')
  const second = image('sha256:second', 'second.png')

  assert.deepEqual(selectSessionImages(session([first, second])), [second])
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
