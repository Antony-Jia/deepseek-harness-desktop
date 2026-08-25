import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHost } from '../market/amap-map-assistant/lib/index.js'
import { normalizePresentation } from '../market/amap-map-assistant/lib/protocol.js'
import { proxyPath } from '../market/amap-map-assistant/lib/amap-proxy.js'
import { AmapSettingsStore } from '../market/amap-map-assistant/lib/settings-storage.js'
import { SessionStateStore } from '../market/amap-map-assistant/lib/session-storage.js'

const root = new URL('..', import.meta.url)
const file = (path) => new URL(path, root)
const text = (path) => readFileSync(file(path), 'utf8')

function validInput(overrides = {}) {
  return {
    schemaVersion: 1,
    scene: 'route',
    title: '北京南站到国家大剧院',
    origin: { name: '北京南站', location: { longitude: 116.378, latitude: 39.865 } },
    destination: { name: '国家大剧院', location: { longitude: 116.391, latitude: 39.904 } },
    mode: 'driving',
    summary: { distanceMeters: 12600, durationSeconds: 1680, instructions: ['沿前门西大街行驶。'] },
    sourceTools: ['mcp__amap__maps_direction_driving'],
    ...overrides
  }
}

test('amap package manifest and formal slots are represented', () => {
  const manifest = JSON.parse(text('market/amap-map-assistant/package.json'))
  const patch = text('market/amap-map-assistant/cordis.patch.yml')
  const client = text('market/amap-map-assistant/lib/client.js')
  assert.equal(manifest.name, '@p-dsh-market/amap-map-assistant')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.market.capabilities.sort(), ['client', 'desktop-shell', 'host', 'persistent-storage', 'skills'])
  assert.ok(manifest.dsh.desktop.permissions.includes('shell:titlebar'))
  assert.deepEqual(manifest.dsh.desktop.contributes.titlebarActions[0].action, {
    type: 'pluginRpc',
    method: 'amapMapAssistant.openSettings'
  })
  assert.match(patch, /@p-dsh-market\/amap-map-assistant/)
  assert.match(patch, /inject: \[sessions, skills, tools, webServer\]/)
  assert.doesNotMatch(patch, /inject: \[[^\]]*\bslots\b/)
  assert.match(client, /conversation\.view/)
  assert.match(client, /name: 'conversation\.view', id: 'amap-map-assistant'/)
  assert.doesNotMatch(client, /conversation\.session\.header\.actions/)
  assert.match(client, /sidebar\.footer\.action/)
  assert.match(client, /amapMapAssistant\.openSettings/)
  assert.match(client, /tool\.call\.toolview/)
  assert.match(client, /shell\.overlay/)
  assert.match(client, /在地图中查看/)
  assert.doesNotMatch(client, /在高德中打开/)
  assert.doesNotMatch(client, /uri\.amap\.com|normalizeNavigationHref|navigationHref/)
  assert.match(client, /waypoints/)
  assert.match(client, /AMap\.Polyline/)
  assert.doesNotMatch(client, /document\.querySelectorAll\([^)]*conversation/)
})

test('presentation protocol accepts route and rejects untrusted coordinates or sources', () => {
  const normalized = normalizePresentation(validInput())
  assert.equal(normalized.scene, 'route')
  assert.equal(normalized.origin.location.longitude, 116.378)
  assert.deepEqual(normalized.sourceTools, ['mcp__amap__maps_direction_driving'])
  const multiPoint = normalizePresentation(validInput({
    waypoints: [
      { name: '前门', location: { longitude: 116.397, latitude: 39.900 } },
      { name: '天安门', location: { longitude: 116.397, latitude: 39.908 } }
    ]
  }))
  assert.equal(multiPoint.waypoints.length, 2)
  assert.throws(() => normalizePresentation(validInput({ sourceTools: ['mcp__amap__fake'] })), /sourceTools/)
  assert.throws(() => normalizePresentation(validInput({ origin: { name: 'London', location: { longitude: -0.1, latitude: 51.5 } } })), /GCJ-02/)
  assert.throws(() => normalizePresentation(validInput({ scene: 'places', origin: undefined, destination: undefined, mode: undefined, places: [] })), /places/)
  assert.throws(() => normalizePresentation(validInput({ scene: 'route', destination: undefined })), /route/)
})

test('session state is revisioned, idempotent and stored without raw conversation data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-amap-state-'))
  try {
    const storage = new SessionStateStore({ root: directory })
    const first = await storage.commit('session-main', normalizePresentation(validInput()), 'call-1')
    const replay = await storage.commit('session-main', normalizePresentation(validInput({ title: 'should not replace' })), 'call-1')
    const second = await storage.commit('session-main', normalizePresentation(validInput({ title: '第二个结果' })), 'call-2')
    assert.equal(first.revision, 1)
    assert.equal(replay.revision, 1)
    assert.equal(replay.title, first.title)
    assert.equal(second.revision, 2)
    const state = await storage.read('session-main')
    assert.equal(state.state.title, '第二个结果')
    assert.match(state.state.id, /^amap_/)
    assert.equal(state.state.lastToolCallId, 'call-2')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('host registers skill, presentation tool and controlled routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-amap-host-'))
  const registrations = { skills: [], tools: [], routes: [] }
  const sessions = { get: (id) => id === 'session-main' ? { header: { id } } : null }
  const services = {
    sessions,
    skills: { register(value) { registrations.skills.push(value); return () => {} } },
    tools: {
      register(value) { registrations.tools.push(value); return () => {} },
      schemas() { return [{ name: 'mcp__amap__maps_geo' }, { name: 'mcp__amap__maps_direction_driving' }] }
    },
    webServer: { register(value) { registrations.routes.push(value); return () => {} } }
  }
  const ctx = {
    get(name) { return services[name] },
    effect(callback) { return callback() }
  }
  try {
    createHost({ storage: new SessionStateStore({ root: directory }), allowUnverifiedRequests: true }).apply(ctx)
    assert.equal(registrations.skills.length, 1)
    assert.equal(registrations.tools.length, 1)
    assert.equal(registrations.tools[0].name, 'amap_present_map')
    assert.equal(registrations.routes.length, 2)
    const route = registrations.routes.find((item) => item.path === '/amap-map')
    const proxyRoute = registrations.routes.find((item) => item.path === '/_AMapService')
    assert.ok(route)
    assert.ok(proxyRoute)
    const result = await registrations.tools[0].execute(validInput(), {
      id: 'tool-call-1',
      agent: { session: { header: { id: 'session-main' } } }
    })
    assert.equal(result.kind, 'amap-presentation')
    assert.equal(result.presentation.revision, 1)
    assert.equal(result.presentationMeta.presentation.id, result.presentation.id)
    const replay = await registrations.tools[0].execute(validInput({ title: 'replay' }), {
      id: 'tool-call-1',
      agent: { session: { header: { id: 'session-main' } } }
    })
    assert.equal(replay.presentation.revision, 1)
    assert.equal(replay.presentation.title, result.presentation.title)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('plugin settings stores JS credentials without returning securityJsCode', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-amap-settings-'))
  const registrations = { routes: [] }
  const services = {
    sessions: { get: () => null },
    skills: { register() { return () => {} } },
    tools: { register() { return () => {} }, schemas() { return [] } },
    webServer: { register(value) { registrations.routes.push(value); return () => {} } }
  }
  const ctx = {
    get(name) { return services[name] },
    effect(callback) { return callback() }
  }
  try {
    createHost({
      storage: new SessionStateStore({ root: directory }),
      settingsStore: new AmapSettingsStore({ path: join(directory, 'settings.json') })
    }).apply(ctx)
    const route = registrations.routes.find((item) => item.path === '/amap-map')
    assert.ok(route)
    const getSettings = await route.handler({ method: 'GET', url: '/amap-map/settings' }, {})
    assert.equal(getSettings.settings.jsApiReady, false)
    const saved = await route.handler({
      method: 'PUT',
      url: '/amap-map/settings',
      body: JSON.stringify({ jsApiKey: 'js-secret', securityJsCode: 'security-secret' })
    }, {})
    assert.deepEqual(saved.settings, { jsApiConfigured: true, securityJsCodeConfigured: true, jsApiReady: true })
    assert.doesNotMatch(JSON.stringify(saved), /js-secret|security-secret/)
    const bootstrap = await route.handler({ method: 'GET', url: '/amap-map/bootstrap' }, {})
    assert.equal(bootstrap.jsApiKey, 'js-secret')
    assert.equal(bootstrap.serviceHost, '/_AMapService')
    assert.equal(Object.prototype.hasOwnProperty.call(bootstrap, 'securityJsCode'), false)
    const cleared = await route.handler({
      method: 'PUT',
      url: '/amap-map/settings',
      body: JSON.stringify({ clearSecurityJsCode: true })
    }, {})
    assert.deepEqual(cleared.settings, { jsApiConfigured: true, securityJsCodeConfigured: false, jsApiReady: false })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('service proxy only accepts fixed AMap service paths', () => {
  assert.equal(proxyPath({ url: '/amap-map/_AMapService/v3/geocode/geo' }), '/v3/geocode/geo')
  assert.equal(proxyPath({ url: '/_AMapService/v3/geocode/geo' }), '/v3/geocode/geo')
  assert.throws(() => proxyPath({ url: '/amap-map/_AMapService/https://example.com' }), /未允许|拒绝/)
  assert.throws(() => proxyPath({ url: '/amap-map/_AMapService/v3/../secret' }), /拒绝|未允许/)
})
