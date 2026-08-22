import { randomUUID } from 'node:crypto'

export const PROVIDER = 'deepseek-official'
export const MODEL = 'deepseek-v4-flash-vision-exp'
export const TOOL_NAME = 'deepseek_vision_analyze'

const PLUGIN_ID = '@p-dsh-market/deepseek-vision-bridge'
const MAX_IMAGES = 8
const MAX_QUERY_LENGTH = 12000
const BRIDGE_SECTION = 'deepseek-vision-bridge:protocol'

function imageRef(block) {
  const ref = block?.type === 'image' ? block.attachment : null
  if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId) return null
  return ref
}

function sessionMessages(session) {
  if (!session || typeof session.deriveMessages !== 'function') throw new Error('视觉工具只能从正在运行的 DSH 会话调用。')
  return session.deriveMessages()
}

function messageImageRefs(message) {
  const refs = new Map()
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    const ref = imageRef(block)
    if (ref) refs.set(ref.attachmentId, ref)
  }
  return [...refs.values()]
}

function sessionImageRefs(messages) {
  const refs = new Map()
  for (const message of messages) {
    for (const ref of messageImageRefs(message)) refs.set(ref.attachmentId, ref)
  }
  return [...refs.values()]
}

function normalizedIds(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`attachmentIds 必须是最多 ${MAX_IMAGES} 个附件 ID。`)
  const ids = []
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || id.length > 512) throw new Error('attachmentIds 包含无效的附件 ID。')
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export function selectSessionImages(session, attachmentIds) {
  const messages = sessionMessages(session)
  const available = sessionImageRefs(messages)
  if (available.length === 0) throw new Error('当前会话中没有可分析的图片附件，请先上传图片。')
  const ids = normalizedIds(attachmentIds)
  if (ids.length === 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const refs = messageImageRefs(messages[index])
      if (refs.length) return refs.slice(0, MAX_IMAGES)
    }
    return [available.at(-1)]
  }
  const byId = new Map(available.map((ref) => [ref.attachmentId, ref]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) throw new Error(`当前会话中找不到图片附件：${missing.join(', ')}`)
  return ids.map((id) => byId.get(id))
}

function textFromBlocks(blocks) {
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block?.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function callerTarget(agent) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const config = events[index]?.type === 'request/header' ? events[index]?.data?.header?.config : null
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') return config
  }
  const options = agent?.options
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') return options
  return null
}

export async function hideVisionToolForCapableModel(llm, assembly, context) {
  const variables = assembly?.variables || {}
  const fallback = callerTarget(context?.agent)
  const provider = typeof variables.provider === 'string' && variables.provider ? variables.provider : fallback?.provider
  const model = typeof variables.model === 'string' && variables.model ? variables.model : fallback?.model
  if (!provider || !model || !Array.isArray(assembly?.tools)) return assembly
  let supportsImages
  try {
    const modelInfo = await llm.resolveModelInfo(provider, model, context?.signal)
    supportsImages = modelInfo?.inputModalities?.includes('image') === true
  } catch {
    return assembly
  }
  if (supportsImages) return { ...assembly, tools: assembly.tools.filter((tool) => tool?.name !== TOOL_NAME) }
  if (!assembly.tools.some((tool) => tool?.name === TOOL_NAME) || assembly.sections?.some((section) => section?.name === BRIDGE_SECTION)) return assembly
  return {
    ...assembly,
    sections: [
      ...(Array.isArray(assembly.sections) ? assembly.sections : []),
      {
        name: BRIDGE_SECTION,
        text: '当用户消息包含模型无法直接读取的图片占位符时，必须调用 deepseek_vision_analyze 分析图片后再回答。分析最近一条图片消息时省略 attachmentIds，以处理该消息中的全部图片。'
      }
    ]
  }
}

async function ensureTextOnlyCaller(llm, agent, signal) {
  if (!llm || typeof llm.resolveModelInfo !== 'function') throw new Error('当前 DSH 运行时未提供完整的 llm 服务。')
  const target = callerTarget(agent)
  if (!target) return
  const modelInfo = await llm.resolveModelInfo(target.provider, target.model, signal)
  if (modelInfo?.inputModalities?.includes('image')) {
    throw new Error('当前模型已经支持图片，请直接分析图片，不要调用视觉桥接工具。')
  }
}

async function generateAnswer(llm, refs, query, signal) {
  if (!llm || typeof llm.stream !== 'function' || typeof llm.resolveModelInfo !== 'function') {
    throw new Error('当前 DSH 运行时未提供完整的 llm 服务。')
  }
  const modelInfo = await llm.resolveModelInfo(PROVIDER, MODEL, signal)
  if (!modelInfo?.inputModalities?.includes('image')) {
    throw new Error(`${PROVIDER}/${MODEL} 未在当前配置中声明图片输入能力。`)
  }
  const message = {
    id: `deepseek-vision-${randomUUID()}`,
    role: 'user',
    content: [
      ...refs.map((attachment) => ({ type: 'image', attachment })),
      { type: 'text', text: query }
    ],
    source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'relay' }
  }
  const blocks = new Map()
  let finish
  for await (const chunk of llm.stream({
    provider: PROVIDER,
    model: MODEL,
    messages: [message],
    system: '你是视觉分析助手。只根据提供的图片回答问题；看不清或无法确认时明确说明，不要臆测。使用与用户问题相同的语言，结果应可直接交给另一个模型继续处理。',
    maxTokens: 8192,
    signal
  })) {
    if (chunk?.type === 'block-start') blocks.set(chunk.index, { type: chunk.blockType, text: '' })
    else if (chunk?.type === 'text-delta') {
      const current = blocks.get(chunk.index) || { type: 'text', text: '' }
      blocks.set(chunk.index, { ...current, text: `${current.text || ''}${chunk.text || ''}` })
    } else if (chunk?.type === 'block-end') blocks.set(chunk.index, chunk.block)
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message || `视觉模型调用${finish.kind === 'aborted' ? '已取消' : '失败'}。`)
  if (finish?.kind === 'tool-calls') throw new Error('视觉模型返回了意外的工具调用。')
  const answer = textFromBlocks(blocks)
  if (!answer) throw new Error('视觉模型没有返回可用的文本结果。')
  return { answer, truncated: finish?.kind === 'max-tokens' }
}

export async function analyzeSessionImages(llm, args, exec) {
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) throw new Error('query 不能为空。')
  if (query.length > MAX_QUERY_LENGTH) throw new Error(`query 不能超过 ${MAX_QUERY_LENGTH} 个字符。`)
  await ensureTextOnlyCaller(llm, exec?.agent, exec?.signal)
  const refs = selectSessionImages(exec?.agent?.session, args?.attachmentIds)
  const generated = await generateAnswer(llm, refs, query, exec?.signal)
  return {
    ...generated,
    attachments: refs.map((ref) => ({
      attachmentId: ref.attachmentId,
      ...(ref.name ? { name: ref.name } : {}),
      width: ref.width,
      height: ref.height
    })),
    provider: PROVIDER,
    model: MODEL
  }
}

export function createVisionCommandDefinition() {
  return {
    name: 'vision',
    description: '在非视觉模型会话中提交图片，并通过 DeepSeek 视觉桥接继续处理',
    input: { hint: '输入希望针对图片完成的任务', images: true },
    async handler(invocation) {
      const attachments = Array.isArray(invocation?.attachments) ? invocation.attachments.filter((block) => imageRef(block)) : []
      if (attachments.length === 0) return { kind: 'error', text: '/vision 需要至少附加一张图片。' }
      const query = typeof invocation?.rawInput === 'string' && invocation.rawInput.trim()
        ? invocation.rawInput.trim()
        : '请详细描述图片中的内容，并指出重要文字、对象、结构和异常。'
      const message = {
        id: `deepseek-vision-command-${randomUUID()}`,
        role: 'user',
        content: [
          ...attachments,
          { type: 'text', text: query }
        ],
        source: { kind: 'user' }
      }
      invocation.agent.followup(message)
      return { kind: 'success', text: '图片已提交到视觉桥接。' }
    }
  }
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'attachments', 'provider', 'model', 'truncated'],
  properties: {
    answer: { type: 'string' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attachmentId', 'width', 'height'],
        properties: {
          attachmentId: { type: 'string' },
          name: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' }
        }
      }
    },
    provider: { type: 'string' },
    model: { type: 'string' },
    truncated: { type: 'boolean' }
  }
}

export function createVisionToolDefinition(analyze) {
  if (typeof analyze !== 'function') throw new TypeError('analyze 必须是函数。')
  return {
    name: TOOL_NAME,
    description: '仅供不支持图片输入的模型调用：使用 DeepSeek-V4-Flash-Vision-Exp 分析当前会话中的图片，提供图片描述、OCR、图表解读、界面检查和视觉问答。支持图片的模型禁止调用。未指定 attachmentIds 时分析最近一条含图片消息中的全部图片。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: MAX_QUERY_LENGTH, description: '希望视觉模型针对图片完成的具体任务或问题。' },
        attachmentIds: {
          type: 'array',
          maxItems: MAX_IMAGES,
          uniqueItems: true,
          items: { type: 'string', maxLength: 512 },
          description: '可选的当前会话图片附件 ID；省略时分析最近一条含图片消息中的全部图片。'
        }
      }
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: value.answer }],
      presentationMeta: (_args, value) => ({ model: value.model, attachmentCount: value.attachments.length, truncated: value.truncated })
    },
    presentCall(args) {
      return { card: 'generic', kind: 'deepseek-vision', title: 'DeepSeek 视觉分析', rawInput: JSON.stringify(args) }
    },
    presentResult(_args, result) {
      if (result?.isError) return undefined
      return { card: 'generic', kind: 'deepseek-vision', title: '视觉分析完成' }
    },
    execute(args, exec) {
      return analyze(args, exec)
    }
  }
}
