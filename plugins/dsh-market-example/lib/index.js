export default {
  inject: ['skills', 'webServer'],

  apply(ctx) {
    ctx.effect(() => {
      const skills = ctx.get('skills') ?? ctx.skills
      const disposer = skills?.register?.({
        id: '@p-dsh-market/example/hello',
        name: '市场示例 Skill',
        description: '用于验证市场插件宿主入口已加载。',
        execute: async () => ({ ok: true, message: '市场示例 Skill 已运行。' }),
      })
      return () => disposer?.()
    })
  },
}
