import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ID = '@p-dsh-market/multi-agent-roundtable'
export const SETTINGS_NAMESPACE = 'multi-agent-roundtable'
export const MODES = Object.freeze(['independent', 'review', 'host'])
export const DISCUSSION_STATUSES = Object.freeze(['created', 'running', 'completed', 'cancelled', 'failed'])

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ROLES_PATH = resolve(PACKAGE_ROOT, 'presets', 'default-roles.json')
const ROLE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const HEX_COLOR = /^#[0-9a-f]{6}$/i

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function text(value, fallback = '', max = 16000) {
  if (typeof value !== 'string') return fallback
  const result = value.trim()
  return result.length > max ? result.slice(0, max) : result
}

function optionalText(value, max = 256) {
  if (value === undefined || value === null || value === '') return undefined
  const result = text(value, '', max)
  return result || undefined
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

export function loadDefaultRoles(path = DEFAULT_ROLES_PATH) {
  const document = JSON.parse(readFileSync(path, 'utf8'))
  if (!document || !Array.isArray(document.roles)) throw new Error('默认角色模板格式无效。')
  return document.roles.map(normalizeRole)
}

export function normalizeRole(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('角色必须是对象。')
  const id = text(value.id, '', 48)
  if (!ROLE_ID.test(id)) throw new Error(`角色 ID 无效：${id || '(empty)'}`)
  const name = text(value.name, '', 80)
  const prompt = text(value.prompt, '', 16000)
  if (!name) throw new Error(`角色 ${id} 缺少名称。`)
  if (!prompt) throw new Error(`角色 ${id} 缺少 Prompt。`)
  const color = text(value.color, '#4f8cff', 16)
  if (!HEX_COLOR.test(color)) throw new Error(`角色 ${id} 的颜色必须是六位十六进制颜色。`)
  const maxTokens = value.maxTokens === undefined ? 4096 : Number(value.maxTokens)
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) {
    throw new Error(`角色 ${id} 的 maxTokens 必须在 256 到 32768 之间。`)
  }
  return {
    id,
    name,
    prompt,
    color: color.toLowerCase(),
    enabled: value.enabled !== false,
    provider: optionalText(value.provider, 120) || '',
    model: optionalText(value.model, 200) || '',
    maxTokens
  }
}

function normalizeRoles(value, fallback) {
  const source = value === undefined ? fallback : value
  if (!Array.isArray(source)) throw new Error('roles 必须是数组。')
  const roles = source.map(normalizeRole)
  if (roles.length === 0) throw new Error('至少需要一个角色。')
  if (roles.length > 32) throw new Error('最多支持 32 个角色。')
  const ids = new Set()
  for (const role of roles) {
    if (ids.has(role.id)) throw new Error(`角色 ID 重复：${role.id}`)
    ids.add(role.id)
  }
  return roles
}

function normalizeTeam(value, roleIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('团队必须是对象。')
  const id = text(value.id, '', 48)
  if (!TEAM_ID.test(id)) throw new Error(`团队 ID 无效：${id || '(empty)'}`)
  const name = text(value.name, '', 80)
  if (!name) throw new Error(`团队 ${id} 缺少名称。`)
  const participantIds = uniqueStrings(Array.isArray(value.participantIds) ? value.participantIds : [])
    .filter((roleId) => roleIds.has(roleId))
  if (participantIds.length === 0) throw new Error(`团队 ${id} 至少需要一个有效角色。`)
  if (participantIds.length > 32) throw new Error(`团队 ${id} 最多支持 32 个角色。`)
  return { id, name, participantIds }
}

function normalizeTeams(value, fallback, roleIds) {
  const source = value === undefined ? fallback : value
  if (!Array.isArray(source)) throw new Error('teams 必须是数组。')
  if (source.length > 16) throw new Error('最多支持 16 个团队组合。')
  const teams = source.map((team) => normalizeTeam(team, roleIds))
  const ids = new Set()
  for (const team of teams) {
    if (ids.has(team.id)) throw new Error(`团队 ID 重复：${team.id}`)
    ids.add(team.id)
  }
  return teams
}

function normalizeDefaults(value, fallback, roles, teams) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const base = fallback && typeof fallback === 'object' ? fallback : {}
  const mode = source.mode === undefined ? base.mode || 'review' : text(source.mode, '', 32)
  if (!MODES.includes(mode)) throw new Error(`不支持的讨论模式：${mode}`)
  const rounds = source.rounds === undefined ? Number(base.rounds || 2) : Number(source.rounds)
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds 必须在 1 到 5 之间。')
  const maxParallel = source.maxParallel === undefined ? Number(base.maxParallel || 3) : Number(source.maxParallel)
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error('maxParallel 必须在 1 到 8 之间。')
  const teamId = source.teamId === undefined ? base.teamId : optionalText(source.teamId, 48)
  const selectedTeam = teams.find((team) => team.id === teamId) || teams[0]
  const fallbackParticipants = selectedTeam?.participantIds || roles.filter((role) => role.enabled).slice(0, 3).map((role) => role.id)
  const participantIds = uniqueStrings(
    source.participantIds === undefined ? (base.participantIds || fallbackParticipants) : source.participantIds
  ).filter((roleId) => roles.some((role) => role.id === roleId && role.enabled))
  if (participantIds.length === 0) throw new Error('默认讨论至少需要一个启用角色。')
  return { teamId: selectedTeam?.id || '', mode, rounds, maxParallel, participantIds }
}

function normalizeDiscussionMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('讨论元数据必须是对象。')
  const id = text(value.id, '', 120)
  if (!id) throw new Error('讨论元数据缺少 id。')
  const participants = Array.isArray(value.participants) ? value.participants : []
  return {
    id,
    parentSessionId: optionalText(value.parentSessionId, 160) || '',
    prompt: text(value.prompt, '', 12000),
    mode: MODES.includes(value.mode) ? value.mode : 'review',
    rounds: Number.isInteger(value.rounds) ? Math.min(5, Math.max(1, value.rounds)) : 2,
    hostRoleId: optionalText(value.hostRoleId, 48) || '',
    currentRound: Number.isInteger(value.currentRound) ? Math.max(0, Math.min(100, value.currentRound)) : 0,
    status: DISCUSSION_STATUSES.includes(value.status) ? value.status : 'created',
    createdAt: Number.isSafeInteger(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : Date.now(),
    participants: participants.slice(0, 32).map((participant) => ({
      roleId: text(participant?.roleId, '', 48),
      childSessionId: text(participant?.childSessionId, '', 180)
    })).filter((participant) => participant.roleId && participant.childSessionId)
  }
}

function normalizeDiscussions(value, fallback) {
  const source = value === undefined ? fallback : value
  if (!Array.isArray(source)) throw new Error('discussions 必须是数组。')
  return source.slice(-100).map(normalizeDiscussionMetadata)
}

const DEFAULT_ROLES = loadDefaultRoles()
const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  roles: DEFAULT_ROLES,
  teams: [{
    id: 'product-review',
    name: '产品评审组',
    participantIds: ['product-manager', 'architect', 'market-analyst']
  }],
  defaults: {
    teamId: 'product-review',
    mode: 'review',
    rounds: 2,
    maxParallel: 3,
    participantIds: ['product-manager', 'architect', 'market-analyst']
  },
  discussions: []
})

export function defaultConfig() {
  return clone(DEFAULT_CONFIG)
}

export function normalizeConfig(value, fallback = DEFAULT_CONFIG) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_CONFIG
  const roles = normalizeRoles(source.roles, base.roles)
  const roleIds = new Set(roles.map((role) => role.id))
  const teams = normalizeTeams(source.teams, base.teams, roleIds)
  const defaults = normalizeDefaults(source.defaults, base.defaults, roles, teams)
  const discussions = normalizeDiscussions(source.discussions, base.discussions)
  return { schemaVersion: 1, roles, teams, defaults, discussions }
}

export function clientConfig(value) {
  const config = normalizeConfig(value)
  return {
    schemaVersion: config.schemaVersion,
    roles: config.roles,
    teams: config.teams,
    defaults: config.defaults
  }
}

export function normalizeDiscussionInput(value, configValue = DEFAULT_CONFIG) {
  const config = normalizeConfig(configValue)
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const prompt = text(source.prompt ?? source.content, '', 12000)
  if (!prompt) throw new Error('讨论主题不能为空。')
  const mode = source.mode === undefined ? config.defaults.mode : text(source.mode, '', 32)
  if (!MODES.includes(mode)) throw new Error(`不支持的讨论模式：${mode}`)
  const rounds = source.rounds === undefined ? config.defaults.rounds : Number(source.rounds)
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds 必须在 1 到 5 之间。')
  const maxParallel = source.maxParallel === undefined ? config.defaults.maxParallel : Number(source.maxParallel)
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error('maxParallel 必须在 1 到 8 之间。')
  const requested = source.participantIds === undefined ? config.defaults.participantIds : source.participantIds
  if (!Array.isArray(requested)) throw new Error('participantIds 必须是数组。')
  const enabled = new Map(config.roles.filter((role) => role.enabled).map((role) => [role.id, role]))
  const participantIds = uniqueStrings(requested).filter((roleId) => enabled.has(roleId))
  if (participantIds.length === 0) throw new Error('至少选择一个启用角色。')
  let hostRoleId = optionalText(source.hostRoleId, 48) || ''
  if (mode === 'host') {
    hostRoleId = hostRoleId || (enabled.has('facilitator') ? 'facilitator' : '')
    if (!hostRoleId || !enabled.has(hostRoleId)) throw new Error('主持人模式需要一个启用的主持人角色。')
    if (!participantIds.includes(hostRoleId)) participantIds.push(hostRoleId)
  }
  return {
    parentSessionId: optionalText(source.parentSessionId, 160) || '',
    prompt,
    mode,
    rounds,
    maxParallel,
    participantIds,
    hostRoleId,
    roles: config.roles.map((role) => ({ ...role }))
  }
}

export { DEFAULT_CONFIG, DEFAULT_ROLES, PACKAGE_ROOT }
