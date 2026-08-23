import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { DATA_DIR, shortText } from './protocol.js'
import { normalizeWorkspacePath } from './session-source.js'

const FILES = {
  manifest: 'manifest.json',
  mindMap: 'mind-map.json',
  knowledgeGraph: 'knowledge-graph.json',
  navigationHistory: 'navigation-history.json'
}

export const WORKSPACE_SCHEMA_VERSION = 1

function compatibilityOf(manifest) {
  if (Number(manifest?.schemaVersion) === WORKSPACE_SCHEMA_VERSION) {
    return { supported: true, state: 'current', schemaVersion: WORKSPACE_SCHEMA_VERSION, message: '' }
  }
  const version = Number.isInteger(manifest?.schemaVersion) ? manifest.schemaVersion : null
  return {
    supported: false,
    state: 'legacy',
    schemaVersion: version,
    message: '当前工作区知识视图来自旧版本 Schema，暂不直接加载；请确认后重新生成。'
  }
}

function isNotFound(error) {
  return error?.code === 'ENOENT'
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (isNotFound(error)) return null
    throw new Error(`读取知识视图数据失败：${filePath}：${error.message}`)
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function replaceBundle(dataDir, values) {
  const id = randomUUID()
  const stagingDir = path.join(dataDir, `.staging-${id}`)
  const finals = Object.entries(values).map(([key, value]) => ({
    key,
    temp: path.join(stagingDir, FILES[key]),
    final: path.join(dataDir, FILES[key]),
    value
  }))
  const backups = []
  const installed = []
  await mkdir(stagingDir, { recursive: true })
  try {
    for (const item of finals) await writeJson(item.temp, item.value)
    for (const item of finals) {
      const backup = `${item.final}.backup-${id}`
      let hadOld = false
      try {
        await rename(item.final, backup)
        hadOld = true
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      backups.push({ final: item.final, backup, hadOld })
      await rename(item.temp, item.final)
      installed.push(item.final)
    }
    for (const backup of backups) if (backup.hadOld) await rm(backup.backup, { force: true })
    await rm(stagingDir, { recursive: true, force: true })
  } catch (error) {
    for (const filePath of installed) await rm(filePath, { force: true }).catch(() => {})
    for (const backup of backups) {
      if (backup.hadOld) await rename(backup.backup, backup.final).catch(() => {})
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function workspaceKey(cwd) {
  return process.platform === 'win32' ? cwd.toLowerCase() : cwd
}

export class WorkspaceRevisionError extends Error {
  constructor(expected, actual) {
    super(`工作区结果已被其他窗口更新（期望 revision ${expected}，当前 revision ${actual}），请重新确认后再生成。`)
    this.name = 'WorkspaceRevisionError'
    this.expected = expected
    this.actual = actual
  }
}

export class WorkspaceStorage {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.locks = new Map()
  }

  resolveDataDir(cwd) {
    const normalized = normalizeWorkspacePath(cwd)
    if (!normalized || !path.isAbsolute(normalized)) throw new Error('工作路径必须是绝对路径。')
    const dataDir = path.resolve(normalized, DATA_DIR)
    if (path.dirname(dataDir) !== normalized) throw new Error('工作区数据目录解析失败。')
    return dataDir
  }

  async readState(cwd) {
    const dataDir = this.resolveDataDir(cwd)
    const manifest = await readJsonIfExists(path.join(dataDir, FILES.manifest))
    if (!manifest) return {
      exists: false,
      dataDir,
      revision: 0,
      manifest: null,
      mindMap: null,
      knowledgeGraph: null,
      navigationHistory: [],
      compatibility: { supported: true, state: 'empty', schemaVersion: WORKSPACE_SCHEMA_VERSION, message: '' }
    }
    const compatibility = compatibilityOf(manifest)
    if (!compatibility.supported) return {
      exists: true,
      dataDir,
      revision: Number.isInteger(manifest.revision) ? manifest.revision : 0,
      manifest,
      mindMap: null,
      knowledgeGraph: null,
      navigationHistory: [],
      compatibility
    }
    const [mindMap, knowledgeGraph, navigationHistory] = await Promise.all([
      readJsonIfExists(path.join(dataDir, FILES.mindMap)),
      readJsonIfExists(path.join(dataDir, FILES.knowledgeGraph)),
      readJsonIfExists(path.join(dataDir, FILES.navigationHistory))
    ])
    return {
      exists: true,
      dataDir,
      revision: Number.isInteger(manifest.revision) ? manifest.revision : 0,
      manifest,
      mindMap,
      knowledgeGraph,
      navigationHistory: Array.isArray(navigationHistory) ? navigationHistory : [],
      compatibility
    }
  }

  async saveBundle({ cwd, expectedRevision = 0, generationId, sourceSessionIds, sourceSessions, failedSources, sourceWarnings, generationTimeline, prompt, strict, outputMode, model, mindMap, knowledgeGraph }) {
    const normalizedCwd = normalizeWorkspacePath(cwd)
    const key = workspaceKey(normalizedCwd)
    const previous = this.locks.get(key) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.readState(normalizedCwd)
      if (Number(expectedRevision) !== current.revision) throw new WorkspaceRevisionError(expectedRevision, current.revision)
      const revision = current.revision + 1
      const manifest = {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        plugin: '@p-dsh-market/conversation-knowledge-map',
        generationId: String(generationId || ''),
        revision,
        cwd: normalizedCwd,
        sourceSessionIds: [...new Set((sourceSessionIds || []).map(String))],
        sourceSessions: Array.isArray(sourceSessions) ? sourceSessions.map((source) => ({
          sessionId: String(source?.sessionId || ''),
          title: shortText(source?.title, 200)
        })).filter((source) => source.sessionId) : [],
        sourceWarnings: {
          skippedRefs: Math.max(0, Number(sourceWarnings?.skippedRefs) || 0),
          skippedItems: Math.max(0, Number(sourceWarnings?.skippedItems) || 0)
        },
        failedSources: Array.isArray(failedSources) ? failedSources.map((source) => ({
          sessionId: String(source?.sessionId || ''),
          title: shortText(source?.title, 200),
          error: shortText(source?.error, 500)
        })).filter((source) => source.sessionId) : [],
        generationTimeline: Array.isArray(generationTimeline) ? generationTimeline.slice(-80).map((item, index) => ({
          id: Number(item?.id) || index + 1,
          at: Number(item?.at) || this.now(),
          type: shortText(item?.type, 40) || 'info',
          message: shortText(item?.message, 500)
        })) : [],
        promptSummary: shortText(prompt, 500),
        strict: strict === true,
        outputMode: String(outputMode || 'both'),
        model: model ? { provider: String(model.provider || ''), model: String(model.model || '') } : null,
        generatedAt: this.now()
      }
      const navigationHistory = current.navigationHistory || []
      await replaceBundle(this.resolveDataDir(normalizedCwd), {
        manifest,
        mindMap: mindMap || null,
        knowledgeGraph: knowledgeGraph || null,
        navigationHistory
      })
      return { revision, manifest, dataDir: this.resolveDataDir(normalizedCwd) }
    })
    this.locks.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.locks.get(key) === operation) this.locks.delete(key)
    }
  }

  async appendNavigation({ cwd, expectedRevision, navigation }) {
    const normalizedCwd = normalizeWorkspacePath(cwd)
    const key = workspaceKey(normalizedCwd)
    const previous = this.locks.get(key) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.readState(normalizedCwd)
      if (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) {
        throw new WorkspaceRevisionError(expectedRevision, current.revision)
      }
      const history = [...(current.navigationHistory || []), {
        id: String(navigation.id || randomUUID()),
        nodeId: String(navigation.nodeId || ''),
        targetSessionId: String(navigation.targetSessionId || ''),
        questionSummary: shortText(navigation.question, 500),
        confirmedAt: this.now()
      }].slice(-100)
      if (!current.manifest) throw new Error('当前工作路径还没有已保存的知识视图。')
      await replaceBundle(current.dataDir, {
        manifest: current.manifest,
        mindMap: current.mindMap,
        knowledgeGraph: current.knowledgeGraph,
        navigationHistory: history
      })
      return { revision: current.revision, navigation: history.at(-1) }
    })
    this.locks.set(key, operation)
    try {
      return await operation
    } finally {
      if (this.locks.get(key) === operation) this.locks.delete(key)
    }
  }
}
