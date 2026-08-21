const CONTROL = process.env.DSH_DESKTOP_CTRL
const TOKEN = process.env.DSH_DESKTOP_TOKEN

export default {
  // The plugin remains inert in a normal dsh web process. The client can
  // therefore share the user's profile with command-line DSH.
  inject: ['sessions', 'tools', 'webServer'],

  apply(ctx) {
    if (!CONTROL || !TOKEN) return

    const sessionService = ctx.get('sessions') ?? ctx.sessions
    const toolService = ctx.get('tools') ?? ctx.tools
    const subscriptions = []
    const startedAt = new Map()

    ctx.effect(() => {
      subscriptions.push(
        registerRoute(ctx, 'POST', '/dsh-desktop-bridge/pick-folder', () => callControl('/pick-folder', 'POST')),
        registerRoute(ctx, 'POST', '/dsh-desktop-bridge/focus', () => callControl('/focus', 'POST')),
        registerRoute(ctx, 'GET', '/dsh-desktop-bridge/health', () => callControl('/health', 'GET')),
        registerJsonRoute(ctx, 'GET', '/dsh-desktop-bridge/mcp-status', () => ({
          ok: true,
          tools: mcpToolNames(toolService),
          observedAt: Date.now(),
        })),
      )

      subscriptions.push(
        listen(sessionService, 'turn/start', (event) => {
          const id = sessionIdOf(event)
          if (id) startedAt.set(id, Date.now())
          void callControl('/tray', 'POST', { state: 'busy' })
        }),
        listen(sessionService, 'turn/end', async (event) => {
          const id = sessionIdOf(event)
          const started = id ? startedAt.get(id) : undefined
          if (id) startedAt.delete(id)
          await callControl('/tray', 'POST', { state: 'idle' })

          // A short turn while the window is in front should not create a
          // notification storm. The native shell makes the final foreground
          // decision again, so this remains safe if the health request races.
          const elapsed = started ? Date.now() - started : 0
          if (elapsed < 2000 || !(await shouldNotify())) return
          void callControl('/notify', 'POST', {
            title: 'DSH 任务完成',
            body: summaryOf(event) || 'Agent 回合已完成。',
            session_id: id,
          })
        }),
        listen(sessionService, 'permission/request', (event) => {
          void callControl('/notify', 'POST', {
            title: 'DSH 需要你的确认',
            body: summaryOf(event) || '有一个操作正在等待审批。',
            session_id: sessionIdOf(event),
          })
        }),
      )

      return () => {
        for (const dispose of subscriptions.splice(0)) {
          try { dispose?.() } catch (error) { console.warn('[dsh-desktop-bridge] dispose', error) }
        }
        startedAt.clear()
      }
    })
  },
}

function registerJsonRoute(ctx, method, path, handler) {
  const server = ctx.get('webServer') ?? ctx.webServer
  if (!server?.register) return () => {}
  return ctx.effect(() => server.register({
    kind: 'exact',
    path,
    handler: async (_req, res) => {
      try {
        const body = JSON.stringify(await handler())
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: messageOf(error) }))
      }
    },
  }))
}

function mcpToolNames(toolService) {
  if (!toolService || typeof toolService.schemas !== 'function') return []
  return toolService.schemas()
    .map((schema) => schema && typeof schema.name === 'string' ? schema.name : '')
    .filter((name) => name.startsWith('mcp__'))
    .sort()
}

function registerRoute(ctx, method, path, handler) {
  const server = ctx.get('webServer') ?? ctx.webServer
  if (!server?.register) return () => {}
  return ctx.effect(() => server.register({
    kind: 'exact',
        path,
    handler: async (_req, res) => {
      try {
        const result = await handler()
        const body = await result.text()
        res.writeHead(result.status, {
          'content-type': result.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: messageOf(error) }))
      }
    },
  }))
}

async function callControl(path, method, payload) {
  const response = await fetch(CONTROL + path, {
    method,
    headers: {
      authorization: 'Bearer ' + TOKEN,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  if (!response.ok) throw new Error('desktop control ' + response.status)
  return response
}

function shouldNotify() {
  return callControl('/health', 'GET')
    .then((response) => response.json())
    .then((data) => !data.foreground)
    .catch(() => false)
}

function listen(service, event, handler) {
  if (!service) return () => {}
  if (typeof service.on === 'function') {
    const disposer = service.on(event, handler)
    return typeof disposer === 'function' ? disposer : () => service.off?.(event, handler)
  }
  if (service.events && typeof service.events.on === 'function') {
    const disposer = service.events.on(event, handler)
    return typeof disposer === 'function' ? disposer : () => service.events.off?.(event, handler)
  }
  if (typeof service.subscribe === 'function') {
    return service.subscribe(event, handler) || (() => {})
  }
  return () => {}
}

function sessionIdOf(value) {
  if (!value || typeof value !== 'object') return undefined
  return value.sessionId || value.session_id || value.session?.id || value.id
}

function summaryOf(value) {
  if (!value || typeof value !== 'object') return ''
  return String(value.summary || value.message || value.title || value.result?.summary || '').slice(0, 420)
}

function messageOf(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
