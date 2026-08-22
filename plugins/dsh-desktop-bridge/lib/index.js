import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTROL = process.env.DSH_DESKTOP_CTRL
const TOKEN = process.env.DSH_DESKTOP_TOKEN
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WEB_PROFILE_PATH = process.env.DSH_DESKTOP_WEB_PROFILE || resolve(PACKAGE_ROOT, '..', '..')
const DSH_HOME = resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'))
const AGENTS_HOME = resolve(process.env.DSH_AGENTS_HOME || resolve(homedir(), '.agents'))
const MARKET_SKILL_STATE_PATH = process.env.DSH_DESKTOP_MARKET_SKILLS_PATH || resolve(
  process.env.LOCALAPPDATA || DSH_HOME,
  process.env.LOCALAPPDATA ? 'dsh-desktop' : '.',
  'market-skills.json',
)
const MARKET_SKILL_PROVIDER = 'desktop-skills'
const MANAGED_RANKS = {
  'workspace-dsh': 50,
  'workspace-agents': 60,
  market: 70,
  'user-dsh': 80,
  'user-agents': 90,
}

export default {
  // The plugin remains inert in a normal dsh web process. The client can
  // therefore share the user's profile with command-line DSH.
  inject: ['sessions', 'skills', 'tools', 'webServer'],

  apply(ctx) {
    if (!CONTROL || !TOKEN) return

    const sessionService = ctx.get('sessions') ?? ctx.sessions
    const skillService = ctx.get('skills') ?? ctx.skills
    const toolService = ctx.get('tools') ?? ctx.tools
    const marketSkillControl = createMarketSkillControl({
      path: MARKET_SKILL_STATE_PATH,
      profilePath: WEB_PROFILE_PATH,
      dshHome: DSH_HOME,
      agentsHome: AGENTS_HOME,
    })
    const subscriptions = []
    const startedAt = new Map()

    skillService.registerProvider((control) => marketSkillControl.provider(control))
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
        registerJsonMethodsRoute(ctx, '/dsh-desktop-bridge/market-skills', {
          GET: async (req) => {
            const cwd = sessionCwd(sessionService, requestSessionId(req))
            return marketSkillControl.snapshot(cwd, await skillService.list(cwd ? { cwd } : {}))
          },
          POST: async (req) => {
            const input = await readJson(req)
            const cwd = sessionCwd(sessionService, input.sessionId)
            marketSkillControl.setEnabled(input.name, input.enabled, cwd)
            return marketSkillControl.snapshot(cwd, await skillService.list(cwd ? { cwd } : {}))
          },
        }),
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

export function createMarketSkillControl(options = {}) {
  const path = options.path || MARKET_SKILL_STATE_PATH
  const profilePath = options.profilePath || WEB_PROFILE_PATH
  const dshHome = resolve(options.dshHome || DSH_HOME)
  const agentsHome = resolve(options.agentsHome || AGENTS_HOME)
  const settings = readSkillSettings(path)
  let invalidate = () => {}
  const managedSkills = (cwd) => discoverManagedSkills({ profilePath, dshHome, agentsHome, cwd })
  const winnerMap = (cwd) => {
    const winners = new Map()
    for (const skill of managedSkills(cwd).sort(compareManagedSkills)) {
      if (!winners.has(skill.name)) winners.set(skill.name, skill)
    }
    return winners
  }
  const disabledFor = (skill, cwd) => {
    if (skill.group !== 'workspace') return settings.globalDisabled.has(skill.name)
    return settings.workspaces.get(workspaceKey(cwd))?.has(skill.name) === true
  }
  const invocationFor = (skill, cwd) => disabledFor(skill, cwd)
    ? { modelInvocable: false, userInvocable: false }
    : skill.invocation
  const candidateFor = (skill, cwd) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    invocation: invocationFor(skill, cwd),
    source: 'custom',
    provider: MARKET_SKILL_PROVIDER,
    resourceBase: { kind: 'directory', path: skill.directory },
    rank: skill.rank,
    locator: skill,
    path: skill.path,
    metadata: { plugin: skill.plugin, group: skill.group },
  })
  const api = {
    provider(control) {
      invalidate = control.invalidate
      control.signal.addEventListener('abort', () => { invalidate = () => {} }, { once: true })
      return {
        name: MARKET_SKILL_PROVIDER,
        list: async (lookup) => managedSkills(lookup.cwd).map((skill) => candidateFor(skill, lookup.cwd)),
        get: async (candidate, lookup) => {
          const skill = candidate.locator
          if (!skill || !validSkillName(skill.name)) return undefined
          return {
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
            invocation: invocationFor(skill, lookup.cwd),
            source: 'custom',
            provider: MARKET_SKILL_PROVIDER,
            resourceBase: { kind: 'directory', path: skill.directory },
            path: skill.path,
            metadata: { plugin: skill.plugin, group: skill.group },
            content: skill.content,
          }
        },
      }
    },
    setEnabled(name, enabled, cwd) {
      if (!validSkillName(name) || typeof enabled !== 'boolean') throw new Error('Skill 开关参数无效。')
      const skill = winnerMap(cwd).get(name)
      if (!skill) throw new Error(`Skill 不存在或不可管理: ${name}`)
      const target = skill.group === 'workspace'
        ? settings.workspaces.get(workspaceKey(cwd)) || new Set()
        : settings.globalDisabled
      const previous = !target.has(name)
      if (previous === enabled) return
      const next = cloneSkillSettings(settings)
      const nextTarget = skill.group === 'workspace'
        ? next.workspaces.get(workspaceKey(cwd)) || new Set()
        : next.globalDisabled
      if (skill.group === 'workspace' && !next.workspaces.has(workspaceKey(cwd))) next.workspaces.set(workspaceKey(cwd), nextTarget)
      if (enabled) nextTarget.delete(name)
      else nextTarget.add(name)
      writeSkillSettings(path, next)
      applySkillSettings(settings, next)
      invalidate()
    },
    snapshot(cwd, available = []) {
      const managed = winnerMap(cwd)
      const skills = [...managed.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        plugin: skill.plugin,
        enabled: !disabledFor(skill, cwd),
        canDisable: true,
        group: skill.group,
        sourceLabel: skill.sourceLabel,
      }))
      for (const skill of available) {
        if (managed.has(skill.name)) continue
        skills.push({
          name: skill.name,
          description: skill.description,
          plugin: skill.provider || skill.source || '',
          enabled: skill.invocation?.modelInvocable !== false || skill.invocation?.userInvocable !== false,
          canDisable: false,
          group: 'other',
          sourceLabel: '系统或其他来源',
        })
      }
      skills.sort(compareSkillViews)
      return { ok: true, cwd: cwd || '', skills, observedAt: Date.now() }
    },
  }
  return api
}

export function discoverMarketSkills(profilePath) {
  const catalog = new Map()
  const profile = readJsonFile(resolve(profilePath, 'package.json'))
  const bundles = profile?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return catalog
  for (const packageName of bundles.filter((name) => typeof name === 'string' && name.startsWith('@p-dsh-market/')).sort()) {
    const packagePath = resolvePackagePath(profilePath, packageName)
    if (!packagePath) continue
    const manifest = readJsonFile(resolve(packagePath, 'package.json'))
    if (manifest?.name !== packageName || !manifest?.dsh?.market?.capabilities?.includes('skills')) continue
    const skillsPath = resolve(packagePath, 'skills')
    let entries
    try { entries = readdirSync(skillsPath, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const directory = resolve(skillsPath, entry.name)
      const skillPath = resolve(directory, 'SKILL.md')
      const skill = readMarketSkill(skillPath, directory, packageName, manifest.description)
      if (skill && !catalog.has(skill.name)) catalog.set(skill.name, skill)
    }
  }
  return catalog
}

export function discoverManagedSkills(options = {}) {
  const skills = [...discoverMarketSkills(options.profilePath || WEB_PROFILE_PATH).values()]
  skills.push(...discoverSkillRoot(resolve(options.dshHome || DSH_HOME, 'skills'), {
    group: 'user', source: 'user-dsh', sourceLabel: '用户级 · ~/.dsh/skills', rank: MANAGED_RANKS['user-dsh'], skipSystem: true,
  }))
  skills.push(...discoverSkillRoot(resolve(options.agentsHome || AGENTS_HOME, 'skills'), {
    group: 'user', source: 'user-agents', sourceLabel: '用户级 · ~/.agents/skills', rank: MANAGED_RANKS['user-agents'],
  }))
  if (options.cwd) {
    const cwd = resolve(options.cwd)
    skills.push(...discoverSkillRoot(resolve(cwd, '.dsh', 'skills'), {
      group: 'workspace', source: 'workspace-dsh', sourceLabel: '当前工作区 · .dsh/skills', rank: MANAGED_RANKS['workspace-dsh'],
    }))
    skills.push(...discoverSkillRoot(resolve(cwd, '.agents', 'skills'), {
      group: 'workspace', source: 'workspace-agents', sourceLabel: '当前工作区 · .agents/skills', rank: MANAGED_RANKS['workspace-agents'],
    }))
  }
  return skills
}

function discoverSkillRoot(root, metadata) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const skills = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (metadata.skipSystem && entry.name === '.system') continue
    const entryPath = resolve(root, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(entryPath)
        isDirectory = target.isDirectory()
        isFile = target.isFile()
      } catch { continue }
    }
    const directory = isDirectory ? entryPath : root
    const path = isDirectory
      ? resolve(directory, 'SKILL.md')
      : isFile && entry.name.endsWith('.md') ? entryPath : ''
    if (!path) continue
    const skill = readFileSkill(path, directory, metadata)
    if (skill) skills.push(skill)
  }
  return skills
}

function readFileSkill(path, directory, metadata) {
  let source
  try { source = readFileSync(path, 'utf8') } catch { return undefined }
  const parsed = parseFrontmatter(source)
  if (!parsed.hasFrontmatter) return undefined
  const name = parsed.data.name
  const description = parsed.data.description
  if (!validSkillName(name) || !description) return undefined
  return {
    name,
    description,
    whenToUse: parsed.data.whenToUse || '',
    invocation: {
      modelInvocable: parsed.data['disable-model-invocation'] !== 'true',
      userInvocable: parsed.data['user-invocable'] !== 'false',
    },
    plugin: metadata.sourceLabel,
    group: metadata.group,
    source: metadata.source,
    sourceLabel: metadata.sourceLabel,
    rank: metadata.rank,
    path,
    directory,
    content: parsed.body.trim(),
  }
}

function compareManagedSkills(left, right) {
  return left.rank - right.rank || left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
}

function compareSkillViews(left, right) {
  const order = { market: 0, user: 1, workspace: 2, other: 3 }
  return (order[left.group] ?? 3) - (order[right.group] ?? 3) || left.name.localeCompare(right.name)
}

function workspaceKey(cwd) {
  if (!cwd) return ''
  const key = resolve(cwd)
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function readMarketSkill(path, directory, plugin, fallbackDescription) {
  let source
  try { source = readFileSync(path, 'utf8') } catch { return undefined }
  const parsed = parseFrontmatter(source)
  const directoryName = directory.split(sep).pop()
  const name = parsed.data.name || directoryName
  const description = parsed.data.description || String(fallbackDescription || '').trim()
  if (!validSkillName(name) || !description) return undefined
  return {
    name,
    description,
    whenToUse: parsed.data.whenToUse || parsed.data['when-to-use'] || '',
    invocation: {
      modelInvocable: parsed.data['disable-model-invocation'] !== 'true',
      userInvocable: parsed.data['user-invocable'] !== 'false',
    },
    plugin,
    group: 'market',
    source: 'market',
    sourceLabel: '市场插件',
    rank: MANAGED_RANKS.market,
    path,
    directory,
    content: parsed.body.trim(),
  }
}

function parseFrontmatter(source) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source, hasFrontmatter: false }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9-]+):\s*(.*?)\s*$/.exec(line)
    if (!field || !field[2]) continue
    data[field[1]] = field[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_value, double, single) => double ?? single)
  }
  return { data, body: source.slice(match[0].length), hasFrontmatter: true }
}

function resolvePackagePath(profilePath, packageName) {
  const nodeModules = resolve(profilePath, 'node_modules')
  const candidate = resolve(nodeModules, ...packageName.split('/'))
  const rel = relative(nodeModules, candidate)
  return rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) ? candidate : undefined
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

function requestSessionId(req) {
  try { return new URL(String(req.url || ''), 'http://127.0.0.1').searchParams.get('sessionId') || '' } catch { return '' }
}

function sessionCwd(sessionService, sessionId) {
  if (!sessionId || typeof sessionService?.get !== 'function') return undefined
  const session = sessionService.get(sessionId)
  return typeof session?.header?.cwd === 'string' && session.header.cwd ? session.header.cwd : undefined
}

function registerJsonRoute(ctx, method, path, handler) {
  return registerJsonMethodsRoute(ctx, path, { [method]: handler })
}

function registerJsonMethodsRoute(ctx, path, handlers) {
  const server = ctx.get('webServer') ?? ctx.webServer
  if (!server?.register) return () => {}
  return ctx.effect(() => server.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase()
      const handler = handlers[method]
      if (!handler) {
        res.writeHead(405, { allow: Object.keys(handlers).join(', '), 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
        return
      }
      try {
        const body = JSON.stringify(await handler(req))
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
    handler: async (req, res) => {
      if (String(req.method || 'GET').toUpperCase() !== method) {
        res.writeHead(405, { allow: method, 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
        return
      }
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

async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16 * 1024) throw new Error('请求体过大。')
    chunks.push(buffer)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new Error('请求体必须是 JSON。') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象。')
  return value
}

function readSkillSettings(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    const globalDisabled = Array.isArray(value.globalDisabled) ? value.globalDisabled : Array.isArray(value.disabled) ? value.disabled : []
    const workspaces = new Map()
    if (value.workspaces && typeof value.workspaces === 'object' && !Array.isArray(value.workspaces)) {
      for (const [cwd, entry] of Object.entries(value.workspaces)) {
        const disabled = Array.isArray(entry?.disabled) ? entry.disabled.filter(validSkillName) : []
        if (disabled.length) workspaces.set(workspaceKey(cwd), new Set(disabled))
      }
    }
    return { globalDisabled: new Set(globalDisabled.filter(validSkillName)), workspaces }
  } catch {
    return { globalDisabled: new Set(), workspaces: new Map() }
  }
}

function cloneSkillSettings(settings) {
  return {
    globalDisabled: new Set(settings.globalDisabled),
    workspaces: new Map([...settings.workspaces].map(([cwd, disabled]) => [cwd, new Set(disabled)])),
  }
}

function applySkillSettings(target, source) {
  target.globalDisabled.clear()
  for (const name of source.globalDisabled) target.globalDisabled.add(name)
  target.workspaces.clear()
  for (const [cwd, disabled] of source.workspaces) {
    if (disabled.size) target.workspaces.set(cwd, new Set(disabled))
  }
}

function writeSkillSettings(path, settings) {
  const workspaces = {}
  for (const [cwd, disabled] of [...settings.workspaces].sort(([left], [right]) => left.localeCompare(right))) {
    if (disabled.size) workspaces[cwd] = { disabled: [...disabled].sort() }
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({
    schemaVersion: 2,
    globalDisabled: [...settings.globalDisabled].sort(),
    workspaces,
  }, null, 2) + '\n', 'utf8')
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(path, { force: true })
    try { renameSync(temporary, path) } catch (renameError) {
      rmSync(temporary, { force: true })
      throw renameError
    }
  }
}

function validSkillName(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
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
