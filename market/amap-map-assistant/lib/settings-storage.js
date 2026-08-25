import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const SETTINGS_SCHEMA_VERSION = 1
export const MAX_SECRET_LENGTH = 512

export class AmapSettingsError extends Error {
  constructor(message, code = 'SETTINGS_ERROR') {
    super(message)
    this.name = 'AmapSettingsError'
    this.code = code
  }
}

function defaultPath(env = process.env) {
  const root = env.DSH_AMAP_MAP_DATA_DIR || join(
    env.LOCALAPPDATA || homedir(),
    'dsh-desktop',
    'plugin-data',
    'amap-map-assistant'
  )
  return resolve(root, 'settings.json')
}

function secret(value, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new AmapSettingsError(`${label} 必须是字符串。`, 'SETTINGS_INVALID')
  const result = value.trim()
  if (result.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new AmapSettingsError(`${label} 过长或包含非法字符。`, 'SETTINGS_INVALID')
  }
  return result
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AmapSettingsError('高德地图插件设置文件格式无效。', 'SETTINGS_CORRUPT')
  }
  if (value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new AmapSettingsError('高德地图插件设置版本不受支持。', 'SETTINGS_CORRUPT')
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    jsApiKey: secret(value.jsApiKey, 'Web JS API Key'),
    securityJsCode: secret(value.securityJsCode, 'securityJsCode')
  }
}

export class AmapSettingsStore {
  constructor(options = {}) {
    this.path = options.path || defaultPath(options.env || process.env)
    this.writes = Promise.resolve()
  }

  read() {
    if (!existsSync(this.path)) return { present: false, jsApiKey: '', securityJsCode: '' }
    try {
      return { present: true, ...normalize(JSON.parse(readFileSync(this.path, 'utf8'))) }
    } catch (error) {
      if (error instanceof AmapSettingsError) throw error
      throw new AmapSettingsError(`高德地图插件设置读取失败：${error.message || error}`, 'SETTINGS_CORRUPT')
    }
  }

  async save(values = {}) {
    const operation = async () => {
      const current = this.read()
      const next = normalize({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        jsApiKey: values.jsApiKey === undefined ? current.jsApiKey : values.jsApiKey,
        securityJsCode: values.securityJsCode === undefined ? current.securityJsCode : values.securityJsCode
      })
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        await rename(temporary, this.path)
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error
        await rm(this.path, { force: true })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true }).catch(() => {})
      }
      return { present: true, ...next }
    }
    this.writes = this.writes.catch(() => {}).then(operation)
    return this.writes
  }
}

export { defaultPath }
