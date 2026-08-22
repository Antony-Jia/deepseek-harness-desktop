import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { analyzeSessionImages, createVisionToolDefinition } from './tool.js'

const SKILL_PATH = fileURLToPath(new URL('../skills/deepseek-vision-bridge/SKILL.md', import.meta.url))

function service(ctx, name) {
  return ctx?.get?.(name) ?? ctx?.[name]
}

export default {
  inject: ['llm', 'skills', 'tools'],

  apply(ctx) {
    const llm = service(ctx, 'llm')
    const skills = service(ctx, 'skills')
    const tools = service(ctx, 'tools')

    ctx.effect(() => skills.register({
      name: 'deepseek-vision-bridge',
      description: '在非视觉模型中使用 DeepSeek V4 Flash Vision Exp 分析当前会话图片',
      whenToUse: '当前模型不支持视觉输入，而用户要求描述图片、OCR、读图表、检查截图或回答图片问题时',
      source: 'runtime',
      content: readFileSync(SKILL_PATH, 'utf8')
    }))

    ctx.effect(() => tools.register(createVisionToolDefinition((args, exec) => analyzeSessionImages(llm, args, exec))))
  }
}
