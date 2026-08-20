import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const DATA_FOLDER = 'multi-agent-roundtable'
const CONFIG_FILE = 'roles.json'

export function resolvePluginConfigPath(env = process.env) {
  const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : ''
  if (localAppData) return resolve(localAppData, 'dsh-desktop', 'plugin-data', DATA_FOLDER, CONFIG_FILE)
  const dshHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (dshHome) return resolve(dshHome, 'plugin-data', DATA_FOLDER, CONFIG_FILE)
  return resolve(process.cwd(), '.dsh-plugin-data', DATA_FOLDER, CONFIG_FILE)
}

export function readPluginConfig(path, fallback) {
  if (!existsSync(path)) return fallback
  const document = JSON.parse(readFileSync(path, 'utf8'))
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('插件角色配置文件格式无效。')
  return {
    ...fallback,
    roles: document.roles,
    teams: document.teams,
    defaults: document.defaults
  }
}

export async function writePluginConfig(path, config) {
  const document = {
    schemaVersion: 1,
    roles: config.roles,
    teams: config.teams,
    defaults: config.defaults
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return path
}
