// =============================================================================
// DSH 插件模板 — 宿主半（在 Node 进程内运行，完整 Node 环境，无沙箱）
//
// 一个宿主插件 = export default 一个 Cordis 插件：
//   - 函数形式：export default (ctx) => { ... }
//   - 对象形式：export default { inject: [...], apply(ctx) { ... } }   ← 本模板用这个
//
// 规则速记：
//   - 服务访问：
//       · 可选服务   → const s = ctx.get('xxx'); if (s === undefined) return
//       · 硬依赖     → 写进 inject 数组；loader 会等这些服务存在后才调用 apply
//                     （否则 apply 可能跑得太早，服务还没就绪——dsh-open-workspace
//                       的列目录路由就因此踩过坑：webServer 未就绪时被静默跳过）
//   - 副作用必须可逆：ctx.effect(() => xxx.register(...))。
//     register/订阅类 API 返回的 disposer 就是清理函数，插件停止/更新/删除时自动执行。
//   - 不要直接 import 其它 DSH 包的内部实现；用服务（ctx.get / inject）而不是 import。
//   - 可以用 npm 包，但宿主包要能被 loader 从 profile 的 node_modules 解析到。
//
// 常用宿主服务（先 cordis_inspect 查签名再写）：
//   commands          斜杠指令  commands.register({ name, description, handler })
//   webServer         HTTP 路由  webServer.register({ kind, path, handler })
//   fs                文件系统  fs.resolve / listDir / readText / writeText / stat
//   subprocess        子进程    subprocess.spawn({ argv, cwd, stdio, graceMs })
//   workspaceRegistry 工作区     workspaceRegistry.list() / resolveByPath(path)
//   sessions / agents 会话与 Agent（如 invocation.agent.session.header.cwd）
// =============================================================================

export default {
  // 硬依赖：loader 会等这些宿主服务存在后再调用 apply。
  // 按实际需要裁剪：只要指令就留 ['commands']；只要路由就留 ['webServer', 'fs']。
  inject: ['commands', 'webServer', 'fs'],

  apply(ctx) {
    // ── 1) 斜杠指令（全局注册：任意会话输入 /xxx 直接执行，不经过模型）────
    ctx.effect(() => ctx.commands.register({
      name: 'template-echo',
      description: '示例指令：回显你输入的内容（用法：/template-echo 任意文字）',
      handler: async (invocation) => {
        const text = invocation.rawInput.trim()
        // CommandResult：{ kind: 'success', text } 或 { kind: 'error', text }
        return { kind: 'success', text: text === '' ? '（空）' : `echo: ${text}` }
      }
    }))

    // ── 2) HTTP 路由（浏览器 fetch 直连；调试用 curl 直打）───────────────
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', // 'exact' 精确匹配路径；'prefix' 匹配 p 及 p/下所有
      path: '/dsh-plugin-template/echo',
      handler: async (req, res) => {
        const writeJson = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
          res.end(JSON.stringify(body))
        }
        try {
          const text = queryParam(req, 'text') ?? ''
          writeJson(200, { ok: true, text })
        } catch (error) {
          writeJson(500, { error: messageOf(error) })
        }
      }
    }))

    // ── 3) 文件读写示例（fs 服务；复制时删掉这段注释）────────────────────
    // 读：
    //   const target = await ctx.fs.resolve('/绝对/路径')          // → FsTarget
    //   const content = await ctx.fs.readText(target)              // 文本内容
    //   const entries = await ctx.fs.listDir(target)               // 目录项 [{name,type,target,size}]
    //   const info = await ctx.fs.stat(target)                     // 元数据 {type,size}
    // 写（原子写）：
    //   await ctx.fs.writeText(target, '新内容')
    // 转成浏览器/进程可用的绝对路径：
    //   const p = ctx.fs.processPath(target)
    //
    // 经验：给浏览器的"读文件内容"路由一定要做 大小上限 + 二进制判定
    // （参考 dsh-open-workspace 的 /open-workspace/read：1MB 上限、binary 标记），
    // 否则大文件或二进制会撑爆内存或让客户端白屏。
  }
}

// —— 工具函数（按需复制） ——
function queryParam(req, name) {
  const query = (req.url ?? '').split('?')[1] ?? ''
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1))
  }
  return ''
}
function messageOf(error) {
  return typeof error === 'object' && error !== null && typeof error.message === 'string' ? error.message : String(error)
}
