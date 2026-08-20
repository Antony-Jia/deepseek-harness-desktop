export const ROUNDTABLE_TOOL_NAME = 'multi_agent_discuss'

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['discussionId', 'conversationId', 'status', 'topic', 'participants', 'messages'],
  properties: {
    discussionId: { type: 'string' },
    conversationId: { type: 'string' },
    status: { type: 'string' },
    topic: { type: 'string' },
    participants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['roleId', 'roleName', 'status'],
        properties: {
          roleId: { type: 'string' },
          roleName: { type: 'string' },
          status: { type: 'string' }
        }
      }
    },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['roleId', 'roleName', 'round', 'content'],
        properties: {
          roleId: { type: 'string' },
          roleName: { type: 'string' },
          round: { type: 'integer' },
          content: { type: 'string' }
        }
      }
    }
  }
}

function renderResult(value) {
  const sections = [`多智能体讨论已完成（${value.participants.length} 个角色）。`]
  for (const message of value.messages) {
    sections.push(`### ${message.roleName}（第 ${message.round} 轮）\n\n${message.content}`)
  }
  sections.push(`讨论记录：${value.conversationId}`)
  return [{ type: 'text', text: sections.join('\n\n') }]
}

export function roundtableToolValue(discussion) {
  const latestByRole = new Map()
  for (const message of discussion.messages) {
    if (message.roleId !== 'user' && message.status === 'complete' && message.content) latestByRole.set(message.roleId, message)
  }
  return {
    discussionId: discussion.id,
    conversationId: discussion.conversationId,
    status: discussion.status,
    topic: discussion.prompt,
    participants: discussion.participants.map((participant) => ({
      roleId: participant.roleId,
      roleName: participant.roleName,
      status: participant.status
    })),
    messages: discussion.participants
      .map((participant) => latestByRole.get(participant.roleId))
      .filter(Boolean)
      .map((message) => ({
        roleId: message.roleId,
        roleName: message.roleName,
        round: message.round,
        content: message.content.length > 12000 ? `${message.content.slice(0, 12000)}…` : message.content
      }))
  }
}

export function createRoundtableToolDefinition(runDiscussion) {
  if (typeof runDiscussion !== 'function') throw new TypeError('runDiscussion 必须是函数。')
  return {
    name: ROUNDTABLE_TOOL_NAME,
    description: '让多个已配置的独立角色围绕一个主题进行讨论、评审或交叉复核。用户要求“让多个角色讨论/评审/会诊/头脑风暴”时调用。各角色继承当前会话的 MCP、Skills 与工具，但拥有独立上下文和角色 Prompt。仅可从主对话调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['topic'],
      properties: {
        topic: { type: 'string', description: '需要多角色讨论的完整主题或问题。' },
        participantIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选角色 ID；省略时使用插件默认参与角色。'
        },
        mode: {
          type: 'string',
          enum: ['review', 'independent', 'host'],
          description: 'review 为交叉评审，independent 为独立回答，host 为主持人汇总。'
        },
        rounds: { type: 'integer', description: '讨论轮数；省略时使用插件默认值。' }
      }
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => renderResult(value),
      presentationMeta: (_args, value) => ({
        conversationId: value.conversationId,
        discussionId: value.discussionId,
        participantCount: value.participants.length
      })
    },
    presentCall(args) {
      return { card: 'generic', kind: 'multi-agent-roundtable', title: '多智能体讨论', rawInput: JSON.stringify(args) }
    },
    presentResult(_args, result) {
      if (result?.isError) return undefined
      return { card: 'generic', kind: 'multi-agent-roundtable', title: '多智能体讨论完成' }
    },
    async execute(args, exec) {
      return runDiscussion(args, exec)
    }
  }
}
