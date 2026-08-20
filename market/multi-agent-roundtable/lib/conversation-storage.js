import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DATA_FOLDER = 'multi-agent-roundtable'
const CONVERSATIONS_FILE = 'conversations.json'

export function resolveConversationIndexPath(env = process.env) {
  const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : ''
  if (localAppData) return resolve(localAppData, 'dsh-desktop', 'plugin-data', DATA_FOLDER, CONVERSATIONS_FILE)
  const dshHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (dshHome) return resolve(dshHome, 'plugin-data', DATA_FOLDER, CONVERSATIONS_FILE)
  return resolve(process.cwd(), '.dsh-plugin-data', DATA_FOLDER, CONVERSATIONS_FILE)
}

function cleanConversation(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || '').trim()
  if (!id) return null
  return {
    id,
    title: String(value.title || '新建 Multi-Agent 群聊').trim().slice(0, 120) || '新建 Multi-Agent 群聊',
    boundSessionId: String(value.boundSessionId || '').trim(),
    discussionId: String(value.discussionId || '').trim(),
    discussion: cleanDiscussion(value.discussion),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
  }
}

function cleanDiscussion(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || '').trim()
  if (!id) return null
  return {
    id,
    conversationId: String(value.conversationId || '').trim(),
    parentSessionId: String(value.parentSessionId || '').trim(),
    prompt: String(value.prompt || '').slice(0, 12000),
    mode: String(value.mode || 'review'),
    rounds: Number.isInteger(value.rounds) ? value.rounds : 2,
    hostRoleId: String(value.hostRoleId || '').trim(),
    currentRound: Number.isInteger(value.currentRound) ? value.currentRound : 0,
    status: String(value.status || 'created'),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    participants: (Array.isArray(value.participants) ? value.participants : []).map((participant) => ({
      roleId: String(participant?.roleId || '').trim(),
      childSessionId: String(participant?.childSessionId || '').trim()
    })).filter((participant) => participant.roleId && participant.childSessionId)
  }
}

export function normalizeConversationIndex(value, legacyDiscussions = []) {
  const conversations = []
  const seen = new Set()
  for (const item of Array.isArray(value?.conversations) ? value.conversations : []) {
    const normalized = cleanConversation(item)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    conversations.push(normalized)
  }
  for (const discussion of Array.isArray(legacyDiscussions) ? legacyDiscussions : []) {
    const discussionId = String(discussion?.id || '').trim()
    if (!discussionId || conversations.some((item) => item.discussionId === discussionId)) continue
    const id = String(discussion?.conversationId || `conversation-${discussionId}`).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    conversations.push(cleanConversation({
      id,
      title: discussion.prompt || '已恢复的 Multi-Agent 群聊',
      boundSessionId: discussion.parentSessionId || '',
      discussionId,
      discussion,
      createdAt: discussion.createdAt,
      updatedAt: discussion.updatedAt
    }))
  }
  return { schemaVersion: 1, conversations: conversations.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt) }
}

export function readConversationIndex(path, legacyDiscussions = []) {
  if (!existsSync(path)) return normalizeConversationIndex(null, legacyDiscussions)
  const document = JSON.parse(readFileSync(path, 'utf8'))
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('插件群聊索引文件格式无效。')
  return normalizeConversationIndex(document, legacyDiscussions)
}

export async function writeConversationIndex(path, value) {
  const document = normalizeConversationIndex(value)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return path
}

export function createConversation(input = {}, now = Date.now()) {
  return cleanConversation({
    id: input.id || `roundtable-conversation-${randomUUID()}`,
    title: input.title || '新建 Multi-Agent 群聊',
    boundSessionId: input.boundSessionId || '',
    discussionId: input.discussionId || '',
    discussion: input.discussion || null,
    createdAt: now,
    updatedAt: now
  })
}
