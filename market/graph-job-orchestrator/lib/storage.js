import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { clone } from './graph-schema.js'

export const STORAGE_SCHEMA_VERSION = 1
export const PLUGIN_STORAGE_FOLDER = 'graph-job-orchestrator'

export function resolveStorageRoot(env = process.env) {
  const localAppData = String(env.LOCALAPPDATA || '').trim() || join(homedir(), 'AppData', 'Local')
  return resolve(localAppData, 'dsh-desktop', 'plugin-data', PLUGIN_STORAGE_FOLDER)
}

function safeSegment(value, label) {
  const item = String(value || '').trim()
  if (!item || item === '.' || item === '..' || /[\\/\0]/.test(item)) throw new Error(`${label} 不是安全的路径片段。`)
  return item
}

export function atomicWriteJson(filePath, value) {
  const target = resolve(filePath)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  try {
    renameSync(temporary, target)
  } catch (error) {
    // Windows does not replace an existing file with renameSync in every
    // filesystem configuration. The destination is plugin-owned and the
    // temporary file has already been fully written, so replace it here.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') throw error
    try { unlinkSync(target) } catch (removeError) { if (removeError?.code !== 'ENOENT') throw removeError }
    renameSync(temporary, target)
  } finally {
    try { unlinkSync(temporary) } catch { /* already renamed */ }
  }
  return target
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return clone(fallback)
  }
}

function writeImmutableRevision(filePath, value, label) {
  if (existsSync(filePath)) {
    const previous = readJson(filePath, undefined)
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      const error = new Error(`${label} revision 已存在且不可覆盖。`)
      error.code = 'IMMUTABLE_REVISION'
      throw error
    }
    return filePath
  }
  return atomicWriteJson(filePath, value)
}

export function appendJsonl(filePath, value) {
  const target = resolve(filePath)
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
  return target
}

export function readJsonl(filePath) {
  if (!existsSync(filePath)) return []
  const result = []
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      result.push(JSON.parse(line))
    } catch {
      // An incomplete final line must not make an otherwise consistent run
      // unreadable. Events are append-only, so stop at the first bad record.
      break
    }
  }
  return result
}

function listDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

export class GraphJobStorage {
  constructor(options = {}) {
    this.root = resolve(options.root || resolveStorageRoot(options.env || process.env))
    this.profilesPath = join(this.root, 'agent-profiles.json')
    this.templatesRoot = join(this.root, 'templates')
    this.graphsRoot = join(this.root, 'graphs')
    this.bindingsPath = join(this.root, 'session-bindings.json')
  }

  ensure() {
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.templatesRoot, { recursive: true })
    mkdirSync(this.graphsRoot, { recursive: true })
    return this
  }

  loadAgentProfiles() {
    const value = readJson(this.profilesPath, { schemaVersion: STORAGE_SCHEMA_VERSION, profiles: [] })
    return Array.isArray(value?.profiles) ? value.profiles : []
  }

  saveAgentProfiles(profiles) {
    this.ensure()
    atomicWriteJson(this.profilesPath, { schemaVersion: STORAGE_SCHEMA_VERSION, profiles: clone(profiles) || [] })
  }

  templateDirectory(templateId) {
    return join(this.templatesRoot, safeSegment(templateId, 'templateId'))
  }

  graphDirectory(graphId) {
    return join(this.graphsRoot, safeSegment(graphId, 'graphId'))
  }

  saveTemplate(template) {
    const id = safeSegment(template.id || template.templateId, 'templateId')
    const directory = this.templateDirectory(id)
    mkdirSync(join(directory, 'revisions'), { recursive: true })
    const manifestPath = join(directory, 'manifest.json')
    const previousManifest = readJson(manifestPath, null)
    const currentRevision = Number(template.currentRevision || template.revision || 1)
    if (previousManifest && currentRevision < Number(previousManifest.currentRevision || 0)) {
      const error = new Error(`Template revision 不能回退：当前为 ${previousManifest.currentRevision}，收到 ${currentRevision}。`)
      error.code = 'GRAPH_REVISION_CONFLICT'
      throw error
    }
    const manifest = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      id,
      name: String(template.name || id),
      description: String(template.description || ''),
      scope: String(template.scope || 'workspace').toLowerCase() === 'global' ? 'global' : 'workspace',
      workspaceId: String(template.workspaceId || '').trim(),
      currentRevision,
      updatedAt: Number(template.updatedAt || Date.now())
    }
    if (template.graph) writeImmutableRevision(join(directory, 'revisions', `${currentRevision}.json`), clone(template.graph), 'Template')
    atomicWriteJson(manifestPath, manifest)
    return this.readTemplate(id)
  }

  readTemplate(templateId, revision) {
    const id = safeSegment(templateId, 'templateId')
    const directory = this.templateDirectory(id)
    const manifest = readJson(join(directory, 'manifest.json'), null)
    if (!manifest) return null
    const selectedRevision = Number(revision || manifest.currentRevision)
    const graph = readJson(join(directory, 'revisions', `${selectedRevision}.json`), null)
    return { ...manifest, graph }
  }

  listTemplates() {
    return listDirectories(this.templatesRoot).map((id) => this.readTemplate(id)).filter(Boolean)
  }

  saveGraphRevision(graph) {
    const id = safeSegment(graph.graphId, 'graphId')
    const directory = this.graphDirectory(id)
    mkdirSync(join(directory, 'revisions'), { recursive: true })
    mkdirSync(join(directory, 'runs'), { recursive: true })
    const revision = Number(graph.revision || 1)
    const manifestPath = join(directory, 'manifest.json')
    const manifest = readJson(manifestPath, {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      id,
      currentRevision: revision,
      createdAt: graph.createdAt || Date.now(),
      updatedAt: graph.updatedAt || Date.now()
    })
    if (revision < Number(manifest.currentRevision || 0)) {
      const error = new Error(`Graph revision 不能回退：当前为 ${manifest.currentRevision}，收到 ${revision}。`)
      error.code = 'GRAPH_REVISION_CONFLICT'
      throw error
    }
    manifest.currentRevision = revision
    manifest.updatedAt = graph.updatedAt || Date.now()
    writeImmutableRevision(join(directory, 'revisions', `${revision}.json`), clone(graph), 'Graph')
    atomicWriteJson(manifestPath, manifest)
    return clone(graph)
  }

  readGraph(graphId, revision) {
    const id = safeSegment(graphId, 'graphId')
    const directory = this.graphDirectory(id)
    const manifest = readJson(join(directory, 'manifest.json'), null)
    if (!manifest) return null
    const selectedRevision = Number(revision || manifest.currentRevision)
    return readJson(join(directory, 'revisions', `${selectedRevision}.json`), null)
  }

  listGraphs() {
    return listDirectories(this.graphsRoot).map((id) => {
      const manifest = readJson(join(this.graphDirectory(id), 'manifest.json'), null)
      return manifest ? { ...manifest, graph: this.readGraph(id, manifest.currentRevision) } : null
    }).filter(Boolean)
  }

  saveRun(run) {
    const graphId = safeSegment(run.graphId, 'graphId')
    const runId = safeSegment(run.runId, 'runId')
    const directory = this.graphDirectory(graphId)
    mkdirSync(join(directory, 'runs'), { recursive: true })
    atomicWriteJson(join(directory, 'runs', `${runId}.json`), clone(run))
    return clone(run)
  }

  readRun(graphId, runId) {
    return readJson(join(this.graphDirectory(graphId), 'runs', `${safeSegment(runId, 'runId')}.json`), null)
  }

  listRuns(graphId) {
    const directory = join(this.graphDirectory(graphId), 'runs')
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => readJson(join(directory, entry.name), null))
        .filter(Boolean)
    } catch {
      return []
    }
  }

  appendRunEvent(graphId, runId, event) {
    const directory = this.graphDirectory(graphId)
    return appendJsonl(join(directory, 'runs', `${safeSegment(runId, 'runId')}.events.jsonl`), clone(event))
  }

  readRunEvents(graphId, runId) {
    return readJsonl(join(this.graphDirectory(graphId), 'runs', `${safeSegment(runId, 'runId')}.events.jsonl`))
  }

  loadBindings() {
    const value = readJson(this.bindingsPath, { schemaVersion: STORAGE_SCHEMA_VERSION, bindings: {} })
    return value?.bindings && typeof value.bindings === 'object' ? value.bindings : {}
  }

  saveBindings(bindings) {
    this.ensure()
    atomicWriteJson(this.bindingsPath, { schemaVersion: STORAGE_SCHEMA_VERSION, bindings: clone(bindings) || {} })
  }
}
