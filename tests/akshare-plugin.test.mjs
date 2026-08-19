import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

import {
  DEFAULT_RUNTIME_PATH,
  createHost,
  validateRuntimePath
} from '../market/akshare-market-analysis/lib/index.js'
import {
  PLUGIN_ID,
  TOOL_NAMES,
  compactSnapshot,
  normalizeHistoryArgs,
  normalizeSnapshotArgs
} from '../market/akshare-market-analysis/lib/protocol.js'
import { createToolDefinitions } from '../market/akshare-market-analysis/lib/schemas.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = `${root}/market/akshare-market-analysis`
const text = (relativePath) => readFileSync(`${root}/${relativePath}`, 'utf8')

test('AKShare package manifest and bundle patch are complete', () => {
  const manifest = JSON.parse(text('market/akshare-market-analysis/package.json'))
  assert.equal(manifest.name, PLUGIN_ID)
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.protocolVersion, 1)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.market.capabilities.includes('skills'))
  assert.ok(manifest.dsh.desktop.permissions.includes('process:execute-bundled'))
  assert.equal(manifest.dsh.desktop.contributes.titlebarActions[0].icon, 'chart-candlestick')
  assert.match(text('market/akshare-market-analysis/cordis.patch.yml'), /inject: \[skills, tools, subprocess, webServer\]/)
  assert.match(text('market/akshare-market-analysis/skills/akshare-market-analysis/SKILL.md'), /akshare_market_snapshot/)
})

test('JS protocol rejects unsafe input and compacts replay metadata', () => {
  assert.equal(normalizeSnapshotArgs({ market: 'a-share', limit: 2 }).limit, 2)
  assert.equal(normalizeHistoryArgs({ market: 'hk', symbol: 700 }).symbol, '00700')
  assert.throws(() => normalizeSnapshotArgs({ market: 'a-share', filters: { price: { gte: Number.NaN } } }))
  assert.throws(() => normalizeHistoryArgs({ market: 'a-share', symbol: '1', startDate: '2026-02-30' }))
  const compact = compactSnapshot({
    schemaVersion: 1,
    kind: 'analysis',
    market: 'a-share',
    symbol: '600519',
    bars: [['2026-08-19', 1, 2, 0.5, 1.5, 10, 20]],
    series: { sma20: [1.2] },
    indicators: ['sma'],
    metrics: { latestClose: 1.5 },
    analysisSummary: { trend: '描述', momentum: '', volatility: '', volumePrice: '', warnings: [] }
  })
  assert.match(compact.analysisId, /^sha256:/)
  assert.deepEqual(compact.series.sma20, [1.2])
})

test('tool definitions map only the three fixed sidecar endpoints', async () => {
  const calls = []
  const definitions = createToolDefinitions(async (name, args) => {
    calls.push({ name, args })
    return { schemaVersion: 1, kind: 'snapshot', rows: [] }
  })
  assert.deepEqual(definitions.map((definition) => definition.name), Object.values(TOOL_NAMES))
  await definitions[0].execute({ market: 'a-share' }, {})
  await definitions[1].execute({ market: 'hk', symbol: 700 }, {})
  await definitions[2].execute({ market: 'a-share', symbol: '600519', indicators: ['sma'] }, {})
  assert.deepEqual(calls.map((call) => call.name), Object.values(TOOL_NAMES))
  assert.equal(calls[1].args.symbol, 700)
})

test('host registers a skill, three tools, and a health route with reversible effects', async () => {
  const skills = []
  const tools = []
  const routes = []
  const cleanups = []
  let managerDisposed = 0
  const manager = {
    request: async () => ({ schemaVersion: 1, kind: 'snapshot', rows: [] }),
    health: async () => ({ ok: true }),
    dispose: async () => { managerDisposed += 1 }
  }
  const ctx = {
    get(name) {
      return { skills: { register(value) { skills.push(value); return () => skills.pop() } }, tools: { register(value) { tools.push(value); return () => tools.pop() } }, webServer: { register(value) { routes.push(value); return () => routes.pop() } } }[name]
    },
    effect(setup) {
      const cleanup = setup()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
  }
  const plugin = createHost({ manager })
  const returned = plugin.apply(ctx)
  assert.equal(returned, manager)
  assert.equal(skills.length, 1)
  assert.equal(tools.length, 3)
  assert.equal(routes[0].path, '/akshare-market/health')
  await tools[0].execute({ market: 'a-share' }, {})
  for (const cleanup of cleanups.splice(0).reverse()) {
    const result = cleanup()
    if (result && typeof result.then === 'function') await result
  }
  assert.equal(cleanups.length, 0)
  assert.equal(managerDisposed, 1)
})

test('client is a DSH module-loader bundle and does not import runtime modules', () => {
  const source = text('market/akshare-market-analysis/lib/client.js')
  let loaded
  const window = {
    parent: null,
    __ModuleLoader__: { load(spec) { loaded = spec } }
  }
  window.parent = window
  vm.runInNewContext(source, { window, Symbol, isFinite, JSON, Math, Object, String, Number, Array })
  assert.equal(loaded.id, PLUGIN_ID)
  const React = { createElement() { return null }, useState() { return [{}, () => {}] }, useEffect() {} }
  const result = loaded.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  assert.equal(Array.from(result.inject).join(','), 'slots,sessions')
  assert.equal(typeof result.apply, 'function')
  assert.doesNotMatch(source, /from ['"]|require\(['"]node:/)
})

test('runtime path is package-contained even before the binary is built', () => {
  assert.ok(DEFAULT_RUNTIME_PATH.endsWith('runtime\\win32-x64\\akshare-service.exe'))
  assert.equal(validateRuntimePath(DEFAULT_RUNTIME_PATH), DEFAULT_RUNTIME_PATH)
  assert.throws(() => validateRuntimePath('C:\\Windows\\System32\\cmd.exe'))
  assert.equal(existsSync(`${packageRoot}/python-sidecar/akshare-service.spec`), true)
})
