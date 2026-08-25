import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { proxyAmapService } from './amap-proxy.js'
import { createPresentationTool } from './presentation-tool.js'
import {
  BASE_PATH,
  PLUGIN_ID,
  TOOL_NAME,
  errorMessage,
  jsonResponse,
  methodOf,
  normalizePresentation,
  parseUrl,
  readJson
} from './protocol.js'
import { AmapSettingsStore } from './settings-storage.js'
import { SessionStateStore } from './session-storage.js'
import { presentationMeta } from './presentation-schema.js'

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = join(PACKAGE_ROOT, '..', 'skills', 'amap-map-assistant', 'SKILL.md')
const SERVICE_PROXY_PATH = '/_AMapService'

function service(ctx, name) {
  return ctx?.get?.(name) ?? ctx?.[name]
}

function logMessage(logger, level, message, ...params) {
  try { logger?.[level]?.(`[${PLUGIN_ID}] ${message}`, ...params) } catch { /* logging must not affect the plugin */ }
}

function registerEffect(ctx, serviceObject, value) {
  if (!serviceObject?.register) return
  const register = () => serviceObject.register(value)
  if (typeof ctx?.effect === 'function') ctx.effect(register)
  else register()
}

function requestPath(req) {
  const pathname = parseUrl(req).pathname
  if (pathname === BASE_PATH || pathname === `${BASE_PATH}/`) return []
  if (!pathname.startsWith(`${BASE_PATH}/`)) return null
  return pathname.slice(`${BASE_PATH}/`.length).split('/').filter(Boolean).map((item) => decodeURIComponent(item))
}

function callerSessionId(exec) {
  const session = exec?.agent?.session
  const header = session?.header || session?.session?.header
  const id = String(header?.id || '').trim()
  if (!id) throw new Error(`${TOOL_NAME} 只能从正在运行的 DSH 主对话调用。`)
  if (header?.origin === 'subagent') throw new Error(`${TOOL_NAME} 不允许由子 Agent 越权写入地图状态。`)
  return id
}

function toolCallId(exec) {
  return String(exec?.toolCallId || exec?.callId || exec?.toolCall?.id || exec?.id || '').trim()
}

function currentSessionFromSnapshot(snapshot) {
  const current = snapshot?.current || snapshot?.currentId || snapshot?.sessionId
  if (current && typeof current === 'object') return String(current.id || '')
  return String(current || '')
}

async function sessionIsAccessible(sessions, sessionId, options = {}) {
  if (typeof options.authorizeSession === 'function') return options.authorizeSession(sessionId)
  if (typeof sessions?.get === 'function') return Boolean(sessions.get(sessionId))
  const list = sessions?.list
  if (typeof list?.getSnapshot === 'function') {
    const snapshot = list.getSnapshot()
    if (snapshot?.byId && Object.prototype.hasOwnProperty.call(snapshot.byId, sessionId)) return true
    return currentSessionFromSnapshot(snapshot) === sessionId
  }
  return options.allowUnverifiedRequests === true
}

function toolNames(tools) {
  try {
    return (typeof tools?.schemas === 'function' ? tools.schemas() : [])
      .map((schema) => typeof schema?.name === 'string' ? schema.name : '')
      .filter((name) => name.startsWith('mcp__amap__'))
      .sort()
  } catch {
    return []
  }
}

function publicState(state) {
  if (!state) return null
  const { lastToolCallId: _lastToolCallId, ...safe } = state
  return safe
}

function errorStatus(error) {
  if (error?.code === 'STATE_CORRUPT' || error?.code === 'STATE_READ_FAILED') return 409
  if (/只能|不允许|无效|必须|不能为空|尚未配置|拒绝|超出|不支持/.test(errorMessage(error))) return 400
  return 500
}

export function createHost(options = {}) {
  return {
    inject: ['sessions', 'skills', 'tools', 'webServer'],

    apply(ctx) {
      const sessions = options.sessions || service(ctx, 'sessions')
      const skills = options.skills || service(ctx, 'skills')
      const tools = options.tools || service(ctx, 'tools')
      const webServer = options.webServer || service(ctx, 'webServer')
      const logger = options.logger || service(ctx, 'logger') || ctx?.logger || console
      const storage = options.storage || new SessionStateStore(options.storageOptions)
      const settingsStore = options.settingsStore || new AmapSettingsStore(options.settingsOptions)
      const webServiceKey = String(process.env.DSH_DESKTOP_MCP_AMAP_MAPS_API_KEY || process.env.AMAP_MAPS_API_KEY || '').trim()
      const environmentSettings = {
        jsApiKey: String(process.env.DSH_DESKTOP_MCP_AMAP_JS_API_KEY || process.env.AMAP_JS_API_KEY || '').trim(),
        securityJsCode: String(process.env.DSH_DESKTOP_MCP_AMAP_JS_SECURITY_CODE || process.env.AMAP_JS_SECURITY_CODE || '').trim()
      }
      let pluginSettings = settingsStore.read()

      const effectiveSettings = () => pluginSettings.present ? pluginSettings : environmentSettings
      const settingsStatus = () => {
        const current = effectiveSettings()
        return {
          jsApiConfigured: Boolean(current.jsApiKey),
          securityJsCodeConfigured: Boolean(current.securityJsCode),
          jsApiReady: Boolean(current.jsApiKey && current.securityJsCode)
        }
      }

      const saveSettings = async (body = {}) => {
        const current = effectiveSettings()
        const next = await settingsStore.save({
          jsApiKey: body.clearJsApiKey === true
            ? ''
            : body.jsApiKey === undefined || body.jsApiKey === null || body.jsApiKey === ''
              ? current.jsApiKey
              : body.jsApiKey,
          securityJsCode: body.clearSecurityJsCode === true
            ? ''
            : body.securityJsCode === undefined || body.securityJsCode === null || body.securityJsCode === ''
              ? current.securityJsCode
              : body.securityJsCode
        })
        pluginSettings = next
        return settingsStatus()
      }

      const proxyHandler = async (req, res) => {
        try {
          return await proxyAmapService(req, res, {
            securityJsCode: effectiveSettings().securityJsCode,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.proxyTimeoutMs
          })
        } catch (error) {
          logMessage(logger, 'warn', 'proxy route failed path=%s status=%d error=%s', parseUrl(req).pathname, errorStatus(error), errorMessage(error))
          return jsonResponse(res, errorStatus(error), { ok: false, error: errorMessage(error) })
        }
      }

      const bootstrap = () => {
        const current = effectiveSettings()
        const names = toolNames(tools)
        const jsApiReady = Boolean(current.jsApiKey && current.securityJsCode)
        return {
          configured: Boolean(webServiceKey),
          jsApiReady,
          jsApiConfigured: Boolean(current.jsApiKey),
          jsApiKey: jsApiReady ? current.jsApiKey : null,
          version: '2.0',
          serviceHost: SERVICE_PROXY_PATH,
          mcp: { connected: names.length > 0, toolCount: names.length, tools: names },
          mapBootstrapReady: jsApiReady,
          mapProxyReady: Boolean(current.securityJsCode)
        }
      }

      const executePresentation = async (args, exec) => {
        const sessionId = callerSessionId(exec)
        const normalized = normalizePresentation(args)
        const presentation = await storage.commit(sessionId, normalized, toolCallId(exec))
        logMessage(logger, 'info', 'presentation committed session=%s revision=%d scene=%s sourceTools=%s', sessionId.slice(0, 12), presentation.revision, presentation.scene, presentation.sourceTools.join(','))
        return {
          schemaVersion: 1,
          kind: 'amap-presentation',
          presentation,
          presentationMeta: presentationMeta(presentation)
        }
      }

      registerEffect(ctx, skills, {
        name: 'amap-map-assistant',
        description: '使用高德地图 MCP 查询真实地点、POI、天气、距离和路线，并提交地图展示。',
        whenToUse: '用户明确要求地点查询、周边搜索、天气、距离测量或驾车/公交/步行/骑行路线时。',
        source: 'runtime',
        content: readFileSync(SKILL_PATH, 'utf8').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, ''),
        resourceBase: { kind: 'directory', path: join(PACKAGE_ROOT, '..', 'skills', 'amap-map-assistant') }
      })
      registerEffect(ctx, tools, createPresentationTool(executePresentation))

      registerEffect(ctx, webServer, {
        kind: 'prefix',
        path: BASE_PATH,
        handler: async (req, res) => {
          const path = requestPath(req)
          if (!path) return jsonResponse(res, 404, { ok: false, error: 'Not found' })
          try {
            if (path.length === 0 && methodOf(req) === 'GET') return jsonResponse(res, 200, { ok: true, plugin: PLUGIN_ID })
            if (path[0] === 'health' && methodOf(req) === 'GET') {
              const info = bootstrap()
              return jsonResponse(res, 200, { ok: true, configured: info.configured, jsApiReady: info.jsApiReady, mcp: info.mcp })
            }
            if (path[0] === 'bootstrap' && methodOf(req) === 'GET') {
              res.setHeader?.('cache-control', 'no-store')
              return jsonResponse(res, 200, bootstrap())
            }
            if (path[0] === 'settings') {
              if (methodOf(req) === 'GET') return jsonResponse(res, 200, { ok: true, settings: settingsStatus() })
              if (methodOf(req) !== 'PUT') return jsonResponse(res, 405, { ok: false, error: '高德地图插件设置只支持 GET/PUT。' })
              const body = await readJson(req)
              return jsonResponse(res, 200, { ok: true, settings: await saveSettings(body) })
            }
            if (path[0] === 'state' && methodOf(req) === 'GET') {
              const sessionId = String(parseUrl(req).searchParams.get('sessionId') || '').trim()
              if (!(await sessionIsAccessible(sessions, sessionId, options))) throw new Error('当前请求不能访问该 Session 的地图状态。')
              const current = await storage.read(sessionId)
              return jsonResponse(res, 200, { state: publicState(current.state), revision: current.revision })
            }
            if (path[0] === '_AMapService') return proxyHandler(req, res)
            return jsonResponse(res, 404, { ok: false, error: 'Not found' })
          } catch (error) {
            logMessage(logger, 'warn', 'route failed path=%s status=%d error=%s', path.join('/'), errorStatus(error), errorMessage(error))
            return jsonResponse(res, errorStatus(error), { ok: false, error: errorMessage(error) })
          }
        }
      })
      registerEffect(ctx, webServer, {
        kind: 'prefix',
        path: SERVICE_PROXY_PATH,
        handler: proxyHandler
      })

      logMessage(logger, 'info', 'host ready mcpTools=%d jsApiConfigured=%s proxyConfigured=%s', bootstrap().mcp.toolCount, settingsStatus().jsApiConfigured, settingsStatus().securityJsCodeConfigured)
    }
  }
}

const host = createHost()
host.pluginId = PLUGIN_ID
export default host
export { PACKAGE_ROOT }
