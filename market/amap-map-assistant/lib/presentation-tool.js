import { TOOL_NAME } from './protocol.js'
import { presentationMeta, presentationOutputSchema, presentationParameters, renderPresentation } from './presentation-schema.js'

export function createPresentationTool(execute) {
  if (typeof execute !== 'function') throw new TypeError('地图展示执行器必须是函数。')
  return {
    name: TOOL_NAME,
    description: '把已经由高德地图 MCP 查询并验证的地点、POI 或路线提交给 DSH 地图卡片和地图视图。不是搜索工具；必须在高德 MCP 成功返回真实坐标后调用。',
    parameters: presentationParameters,
    output: {
      schema: presentationOutputSchema,
      render: renderPresentation,
      presentationMeta: (_args, value) => value?.presentation ? presentationMeta(value.presentation) : undefined
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      return {
        card: 'generic',
        kind: 'amap-presentation',
        title: '准备地图展示',
        rawInput: JSON.stringify({ scene: args?.scene, title: args?.title })
      }
    },
    presentResult(_args, result) {
      if (result?.isError) return undefined
      return { card: 'generic', kind: 'amap-presentation', title: result?.presentation?.title || '地图展示' }
    },
    execute
  }
}
