import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

import { createMarketSkillControl } from '../plugins/dsh-desktop-bridge/lib/index.js'

const root = new URL('..', import.meta.url)
const file = (path) => fileURLToPath(new URL(path, root))
const text = (path) => readFileSync(file(path), 'utf8')

test('desktop shell contract is represented in the project', () => {
  const cargo = text('src-tauri/Cargo.toml')
  const rust = text('src-tauri/src/lib.rs')
  const process = text('src-tauri/src/process.rs')
  const runtime = text('src-tauri/src/runtime.rs')
  const state = text('src-tauri/src/state.rs')
  const config = text('src-tauri/tauri.conf.json')
  const readme = text('README.md')
  const chineseReadme = text('README.zh-CN.md')

  assert.match(cargo, /tauri-plugin-notification/)
  assert.match(rust, /generate_handler!/)
  assert.match(process, /KILL_ON_JOB_CLOSE/)
  assert.match(process, /127\.0\.0\.1/)
  assert.match(runtime, /@deepseek-ai\/dsh@/)
  assert.match(runtime, /--no-install/)
  assert.match(runtime, /detect_local/)
  assert.match(runtime, /ensure_bundled_node/)
  assert.match(config, /embedBootstrapper/)
  assert.match(config, /runtime-assets\/node/)
  assert.match(config, /"decorations": false/)
  assert.match(config, /icons\/icon\.ico/)
  assert.match(rust, /default_window_icon\(\)/)
  assert.match(rust, /fn minimize_window/)
  assert.match(rust, /fn toggle_maximize/)
  assert.match(rust, /fn hide_window/)
  assert.match(rust, /fn start_window_dragging/)
  assert.match(rust, /fn stop_dsh/)
  assert.match(rust, /web_url/)
  assert.match(rust, /state\.runtime_source = RUNTIME_SOURCE_MANAGED\.to_string\(\)/)
  assert.match(rust, /自动切换到托管运行时/)
  assert.match(text('src-tauri/src/main.rs'), /windows_subsystem = "windows"/)
  assert.match(process, /CREATE_NO_WINDOW/)
  assert.equal(process.match(/"--no-open"\.to_string\(\)/g)?.length, 2)
  assert.match(runtime, /CREATE_NO_WINDOW/)
  assert.match(state, /window_bounds/)
  assert.match(state, /THEME_SYSTEM/)
  assert.match(config, /frame-src 'self' http:\/\/127\.0\.0\.1:\*/) 
  assert.match(readme, /\[README\.zh-CN\.md\]\(README\.zh-CN\.md\)/)
  assert.match(chineseReadme, /\[README\.md\]\(README\.md\)/)
  assert.doesNotMatch(readme, /choose a workspace/)
  assert.doesNotMatch(chineseReadme, /选择工作区/)
  assert.doesNotMatch(rust, /choose-workspace/)
})

test('bridge plugin is inert without desktop environment variables', () => {
  const host = text('plugins/dsh-desktop-bridge/lib/index.js')
  const client = text('plugins/dsh-desktop-bridge/lib/client.js')
  const html = text('dist/index.html')
  const app = text('dist/app.js')
  assert.match(host, /DSH_DESKTOP_CTRL/)
  assert.match(host, /DSH_DESKTOP_TOKEN/)
  assert.match(host, /if \(!CONTROL \|\| !TOKEN\) return/)
  assert.match(host, /turn\/end/)
  assert.match(host, /marketSkillControl/)
  assert.match(host, /dsh-desktop-bridge\/market-skills/)
  assert.equal(host.match(/'\/dsh-desktop-bridge\/market-skills'/g)?.length, 1)
  assert.match(host, /registerJsonMethodsRoute/)
  assert.match(client, /shell\.overlay/)
  assert.match(client, /MarketSkillSelector/)
  assert.match(client, /max-height:min\(720px/)
  assert.match(client, /snapshot\.skills\.length > 10/)
  assert.match(client, /data-group/)
  assert.match(client, /市场插件 Skills/)
  assert.match(client, /用户级 Skills/)
  assert.match(client, /当前工作区 Skills/)
  assert.match(client, /不可禁用/)
  assert.match(html, /id="titlebar-skills"/)
  assert.match(app, /postDshMessage\('dsh-market-skills-open'\)/)
  assert.doesNotMatch(client, /conversation\.input\.left/)
  assert.doesNotMatch(client, /dsh-desktop-folder/)
  assert.doesNotMatch(client, /sidebar\.footer\.action/)
  assert.doesNotMatch(client, /pick-folder/)
})

test('desktop bridge centrally discovers, masks and persists managed skills', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-market-skills-'))
  const path = join(directory, 'market-skills.json')
  const packageRoot = join(directory, 'profile', 'node_modules', '@p-dsh-market', 'example')
  const skillRoot = join(packageRoot, 'skills', 'example-skill')
  try {
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(join(directory, 'profile', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@p-dsh-market/example'] } },
    }))
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@p-dsh-market/example',
      description: 'Example market skill',
      dsh: { market: { capabilities: ['skills', 'host', 'client'] } },
    }))
    writeFileSync(join(skillRoot, 'SKILL.md'), '# Example\n\nUse the example tool.')
    const userSkill = join(directory, 'dsh-home', 'skills', 'user-skill')
    const workspaceSkill = join(directory, 'workspace', '.dsh', 'skills', 'workspace-skill')
    mkdirSync(userSkill, { recursive: true })
    mkdirSync(workspaceSkill, { recursive: true })
    writeFileSync(join(userSkill, 'SKILL.md'), '---\nname: user-skill\ndescription: User skill\n---\n\nUser instructions.')
    writeFileSync(join(workspaceSkill, 'SKILL.md'), '---\nname: workspace-skill\ndescription: Workspace skill\n---\n\nWorkspace instructions.')

    let invalidations = 0
    const control = createMarketSkillControl({ path, profilePath: join(directory, 'profile'), dshHome: join(directory, 'dsh-home'), agentsHome: join(directory, 'agents-home') })
    const provider = control.provider({
      signal: new AbortController().signal,
      invalidate() { invalidations += 1 },
    })
    const cwd = join(directory, 'workspace')
    const enabled = await provider.list({ cwd })
    assert.deepEqual(enabled.map((skill) => skill.name).sort(), ['example-skill', 'user-skill', 'workspace-skill'])
    assert.equal(enabled.every((skill) => skill.rank < 250), true)
    assert.deepEqual(enabled[0].invocation, { modelInvocable: true, userInvocable: true })
    assert.match((await provider.get(enabled.find((skill) => skill.name === 'example-skill'), { cwd })).content, /Use the example tool/)
    const view = control.snapshot(cwd, [{ name: 'system-skill', description: 'System', provider: 'system', invocation: { modelInvocable: true, userInvocable: true } }])
    assert.deepEqual(view.skills.map((skill) => skill.group), ['market', 'user', 'workspace', 'other'])
    assert.equal(view.skills.at(-1).canDisable, false)

    control.setEnabled('example-skill', false, cwd)
    control.setEnabled('workspace-skill', false, cwd)
    assert.equal(invalidations, 2)
    const masked = await provider.list({ cwd })
    assert.deepEqual(masked.find((skill) => skill.name === 'example-skill').invocation, { modelInvocable: false, userInvocable: false })
    assert.deepEqual((await provider.get(masked.find((skill) => skill.name === 'workspace-skill'), { cwd })).invocation, { modelInvocable: false, userInvocable: false })

    const restored = createMarketSkillControl({ path, profilePath: join(directory, 'profile'), dshHome: join(directory, 'dsh-home'), agentsHome: join(directory, 'agents-home') })
    const restoredView = restored.snapshot(cwd)
    assert.equal(restoredView.skills.find((skill) => skill.name === 'example-skill').enabled, false)
    assert.equal(restoredView.skills.find((skill) => skill.name === 'workspace-skill').enabled, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('plugin market contract is represented in the Rust, UI and fixture layers', () => {
  const rust = text('src-tauri/src/market.rs')
  const mainRust = text('src-tauri/src/lib.rs')
  const html = text('dist/index.html')
  const javascript = text('dist/app.js')
  const fixture = JSON.parse(text('plugins/dsh-market-example/package.json'))
  const catalog = JSON.parse(text('market/catalog-v1.json'))
  const catalogWorkflow = text('.github/workflows/market-catalog.yml')
  const catalogValidator = text('scripts/validate-market-catalog.mjs')

  assert.match(mainRust, /search_market_plugins/)
  assert.match(mainRust, /install_market_plugin/)
  assert.match(mainRust, /uninstall_market_plugin/)
  assert.match(mainRust, /validate_installed_theme_package/)
  assert.match(rust, /pub struct MarketTheme/)
  assert.match(rust, /validate_theme_market_manifest/)
  assert.match(mainRust, /restart_dsh/)
  assert.match(rust, /@p-dsh-market\//)
  assert.match(rust, /dsh\.client\.platform/)
  assert.match(rust, /dsh\.bundle\.patch/)
  assert.match(rust, /dsh\.market\.capabilities/)
  assert.match(rust, /MARKET_CATALOG_URL/)
  assert.match(rust, /EMBEDDED_MARKET_CATALOG/)
  assert.match(rust, /market-catalog-v1\.json/)
  assert.doesNotMatch(rust, /"--search-limit"\.to_string\(\)/)
  assert.match(rust, /pnpm\.cmd/)
  assert.match(rust, /DSH_HOME/)
  assert.match(html, /titlebar-market/)
  assert.match(html, /id="market-view"/)
  assert.match(html, /market-search-form/)
  assert.match(html, /id="app-loading-overlay"/)
  assert.match(html, /id="market-confirm-modal"/)
  assert.match(javascript, /viewMode = 'market'/)
  assert.match(javascript, /search_market_plugins/)
  assert.match(javascript, /install_market_plugin/)
  assert.match(javascript, /uninstall_market_plugin/)
  assert.match(javascript, /function setAppLoading/)
  assert.match(javascript, /function confirmMarketOperation/)
  assert.match(javascript, /function resolveMarketConfirmation/)
  assert.doesNotMatch(javascript, /window\.confirm/)
  assert.match(javascript, /正在向 npm 确认插件信息/)
  assert.match(javascript, /正在重启 DSH/)
  assert.match(javascript, /previewMarketTheme/)
  assert.match(javascript, /卸载此主题包；当前主题会先回退默认主题/)
  assert.equal(fixture.name, '@p-dsh-market/example')
  assert.equal(fixture.exports['./client'], './lib/client.js')
  assert.equal(fixture.dsh.client.platform, 'web')
  assert.equal(fixture.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(fixture.dsh.market.capabilities.sort(), ['client', 'host', 'skills'])
  assert.equal(catalog.schemaVersion, 1)
  assert.deepEqual(catalog.packages, [
    '@p-dsh-market/akshare-market-analysis',
    '@p-dsh-market/conversation-knowledge-map',
    '@p-dsh-market/deepseek-vision-bridge',
    '@p-dsh-market/dsh-open-workspace',
    '@p-dsh-market/multi-agent-roundtable',
    '@p-dsh-market/neon-agent-theme',
  ])
  assert.match(catalogWorkflow, /schedule:/)
  assert.match(catalogWorkflow, /validate-market-catalog\.mjs/)
  assert.match(catalogValidator, /function npmView/)
})

test('MCP management registers built-in and user-managed servers through DSH', () => {
  const rust = text('src-tauri/src/mcp.rs')
  const mainRust = text('src-tauri/src/lib.rs')
  const process = text('src-tauri/src/process.rs')
  const bridge = text('plugins/dsh-desktop-bridge/lib/index.js')
  const html = text('dist/index.html')
  const javascript = text('dist/app.js')
  const styles = text('dist/styles.css')

  assert.match(mainRust, /list_mcp_servers/)
  assert.match(mainRust, /save_mcp_server/)
  assert.match(mainRust, /add_custom_mcp_server/)
  assert.match(mainRust, /delete_custom_mcp_server/)
  assert.match(mainRust, /get_mcp_runtime_status/)
  assert.match(mainRust, /check_mcp_readiness/)
  assert.match(mainRust, /sync_profile/)
  assert.match(rust, /@deepseek-ai\/dsh-mcp-client/)
  assert.match(rust, /tavily-mcp@0\.2\.22/)
  assert.match(rust, /firecrawl-mcp@3\.24\.0/)
  assert.match(rust, /chrome-devtools-mcp@1\.7\.0/)
  assert.match(rust, /TAVILY_API_KEY/)
  assert.match(rust, /FIRECRAWL_API_KEY/)
  assert.match(rust, /streamable-http/)
  assert.match(rust, /desktop_secret_env/)
  assert.match(rust, /process\.env\.\{\}/)
  assert.doesNotMatch(rust, /content\.push_str\([^)]*api_key/)
  assert.match(process, /\.envs\(environment\)/)
  assert.match(html, /id="titlebar-mcp"/)
  assert.match(html, /id="mcp-view"/)
  assert.match(html, /mcp-tavily-key/)
  assert.match(html, /mcp-firecrawl-key/)
  assert.match(html, /id="mcp-chrome-enabled"/)
  assert.match(html, /id="mcp-chrome-auto-connect"/)
  assert.match(html, /chrome:\/\/inspect\/#remote-debugging/)
  assert.match(html, /仅通过本机 stdio/)
  assert.match(html, /id="mcp-add-server"/)
  assert.match(html, /id="mcp-editor-modal"/)
  assert.match(html, /id="mcp-readiness-title"/)
  assert.match(html, /id="mcp-check-download"/)
  assert.ok(html.indexOf('id="mcp-view"') < html.indexOf('id="mcp-readiness-title"'))
  assert.ok(html.indexOf('id="mcp-readiness-title"') < html.indexOf('id="mcp-server-list"'))
  assert.match(styles, /\.market-confirm-dialog \{[\s\S]*var\(--skin-surface-primary/)
  assert.match(styles, /:root\[data-theme="light"\] \.market-confirm-dialog/)
  assert.match(styles, /data-skin\]:not\(\[data-skin="builtin\.default"\]\) \.market-confirm-dialog/)
  assert.match(styles, /var\(--skin-panel-radius/)
  assert.match(styles, /var\(--skin-text-primary/)
  assert.match(javascript, /viewMode = 'mcp'/)
  assert.match(javascript, /list_mcp_servers/)
  assert.match(javascript, /save_mcp_server/)
  assert.match(javascript, /add_custom_mcp_server/)
  assert.match(javascript, /delete_custom_mcp_server/)
  assert.match(javascript, /apiKeyConfigured/)
  assert.match(javascript, /mcpDraftEnabled/)
  assert.match(javascript, /syncMcpDrafts/)
  assert.match(javascript, /refreshMcpRuntimeStatus/)
  assert.match(javascript, /refreshMcpReadiness/)
  assert.match(javascript, /packageCached/)
  assert.match(javascript, /mcpDraftAutoConnect/)
  assert.match(javascript, /autoConnect:/)
  assert.match(rust, /--autoConnect/)
  assert.match(bridge, /dsh-desktop-bridge\/mcp-status/)
  assert.match(bridge, /toolService\.schemas\(\)/)
})

test('workspace market plugin is a floating, protocol-contributing package', () => {
  const manifest = JSON.parse(text('market/dsh-open-workspace/package.json'))
  const host = text('market/dsh-open-workspace/lib/index.js')
  const client = text('market/dsh-open-workspace/lib/client.js')
  const patch = text('market/dsh-open-workspace/cordis.patch.yml')
  const html = text('dist/index.html')
  const rust = text('src-tauri/src/lib.rs')
  const desktopRust = text('src-tauri/src/market.rs')
  const javascript = text('dist/app.js')
  const styles = text('dist/styles.css')

  assert.equal(manifest.name, '@p-dsh-market/dsh-open-workspace')
  assert.equal(manifest.version, '0.1.7')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh.market.capabilities.sort(), ['client', 'desktop-shell', 'host', 'skills'])
  assert.equal(manifest.dsh.protocolVersion, 1)
  assert.deepEqual(manifest.dsh.desktop.permissions.sort(), ['native:open-folder', 'native:open-terminal', 'shell:titlebar', 'workspace:read'])
  assert.equal(manifest.dsh.desktop.contributes.titlebarActions[0].slot, 'desktop.titlebar.workspaceActions')
  assert.match(patch, /@p-dsh-market\/dsh-open-workspace/)
  assert.match(host, /inject: \['commands', 'fs', 'webServer', 'subprocess'\]/)
  assert.match(host, /\/open-workspace\/list/)
  assert.match(host, /\/open-workspace\/read/)
  assert.match(host, /\/open-workspace\/terminal\/open/)
  assert.match(host, /\/open-workspace\/terminal\/read/)
  assert.match(host, /\/open-workspace\/terminal\/write/)
  assert.match(host, /\/open-workspace\/terminal\/close/)
  assert.match(host, /spawnTerminal/)
  assert.match(host, /subprocess\.spawn\(/)
  assert.match(host, /readJson/)
  assert.match(client, /id: '@p-dsh-market\/dsh-open-workspace'/)
  assert.match(client, /var inject = \['slots', 'workspaces', 'sessions', 'timer'\]/)
  assert.match(client, /sessions && sessions\.list/)
  assert.match(client, /snapshot\.current/)
  assert.match(client, /useSessions\(function \(snapshot\)/)
  assert.match(client, /var root = sessionRoot === undefined \? snap\.root : sessionRoot/)
  assert.match(client, /ctx\.slots\.inject\('shell\.overlay'/)
  assert.match(client, /name: 'shell\.overlay', id: 'open-workspace-floating'/)
  assert.match(client, /owsp-float-resize/)
  assert.match(client, /treeWidth/)
  assert.match(client, /treeRows/)
  assert.match(client, /pinned/)
  assert.match(client, /workspace-panel-toggle/)
  assert.match(client, /terminal-panel-toggle/)
  assert.match(client, /conversation\.composer\.dock/)
  assert.match(client, /color-scheme:inherit/)
  assert.match(client, /--dsw-alias-markdown-code-block/)
  assert.match(client, /function highlightCode/)
  assert.match(client, /owsp-token-keyword/)
  assert.match(client, /setState\(\{ width:/)
  assert.match(client, /setState\(\{ treeWidth:/)
  assert.doesNotMatch(client, /ctx\.slots\.inject\('conversation\.input\.dock'/)
  assert.doesNotMatch(client, /ctx\.slots\.inject\('sidebar\.footer\.action'/)
  assert.match(client, /Markdown \/ HTML \/ 代码高亮/)
  assert.match(html, /id="titlebar-plugin-actions"/)
  assert.match(html, /id="titlebar-plugin-actions-list"/)
  assert.match(html, /id="titlebar-plugin-overflow"/)
  assert.match(html, /id="titlebar-plugin-overflow-menu"/)
  assert.match(styles, /\.titlebar-plugin-actions \{[\s\S]*max-width: 50%/)
  assert.match(javascript, /function layoutDesktopActions/)
  assert.match(javascript, /menu\.insertBefore\(list\.lastElementChild/)
  assert.match(javascript, /window\.addEventListener\('resize', layoutDesktopActions\)/)
  assert.match(html, /id="market-restart-dsh"/)
  assert.doesNotMatch(html, /id="titlebar-workspace"/)
  assert.doesNotMatch(html, /id="titlebar-terminal"/)
  assert.match(javascript, /workspace-panel-toggle/)
  assert.match(javascript, /terminal-panel-toggle/)
  assert.match(javascript, /multiAgentRoundtable\.open/)
  assert.match(javascript, /get_desktop_contributions/)
  assert.match(javascript, /function restartDsh/)
  const restartSection = javascript.slice(
    javascript.indexOf('function restartDsh'),
    javascript.indexOf('function postDshMessage'),
  )
  assert.match(restartSection, /invokeOrThrow\('restart_dsh'\)\.then/)
  assert.match(restartSection, /pendingRestartNames = \[\]/)
  assert.match(restartSection, /desktopContributionsKey = ''/)
  assert.match(javascript, /desktop\.titlebar\.workspaceActions/)
  assert.match(rust, /fn get_desktop_contributions/)
  assert.match(desktopRust, /DESKTOP_TITLEBAR_WORKSPACE_ACTIONS/)
})

test('workspace plugin resolves cwd from the selected conversation', () => {
  const source = text('market/dsh-open-workspace/lib/client.js')
  let moduleExports
  vm.runInNewContext(source, {
    Symbol,
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          moduleExports = entry.factory((name) => name === 'react' ? {} : undefined)
        },
      },
    },
  })

  const sessions = {
    current: 'conversation-a',
    byId: {
      'conversation-a': { id: 'conversation-a', cwd: 'D:\\Code\\alpha' },
      'conversation-b': { id: 'conversation-b', cwd: 'D:\\Code\\beta' },
      'conversation-empty': { id: 'conversation-empty' },
    },
  }
  assert.equal(moduleExports.resolveSessionCwd(sessions), 'D:\\Code\\alpha')
  assert.equal(moduleExports.resolveSessionCwd({ ...sessions, current: 'conversation-b' }), 'D:\\Code\\beta')
  assert.equal(moduleExports.resolveSessionCwd({ ...sessions, current: 'conversation-empty' }), null)
  assert.equal(moduleExports.resolveSessionCwd(null), undefined)
})

test('splash page exposes recovery actions', () => {
  const html = text('dist/index.html')
  const javascript = text('dist/app.js')
  assert.match(html, />启动</)
  assert.match(html, /id="restart-dsh"/)
  assert.match(html, />进入页面</)
  assert.match(html, />重启</)
  assert.match(html, /回滚|安装并切换/)
  assert.match(html, /打开日志目录/)
  assert.match(html, /window-minimize/)
  assert.match(html, /window-maximize/)
  assert.match(html, /window-close/)
  assert.match(html, /titlebar-drag/)
  assert.match(html, /titlebar-home/)
  assert.match(html, /class="brand-mark">D<\/div>/)
  assert.match(html, /class="titlebar-dot">D<\/span>/)
  assert.match(html, /dsh-frame/)
  assert.match(html, /app-home/)
  assert.match(html, /app-restart/)
  assert.doesNotMatch(html, /app-update/)
  assert.doesNotMatch(html, /app-upgrade/)
  assert.doesNotMatch(html, /app-stop/)
  assert.match(html, /titlebar-caption[\s\S]*titlebar-tools[\s\S]*titlebar-market[\s\S]*titlebar-mcp[\s\S]*app-home[\s\S]*app-restart[\s\S]*titlebar-plugin-actions/)
  assert.match(html, /toggle-dsh/)
  assert.match(html, /enter-dsh/)
  assert.match(html, /data-theme-choice="light"/)
  assert.match(html, /data-theme-choice="dark"/)
  assert.match(html, /data-theme-choice="system"/)
  assert.doesNotMatch(html, /选择文件夹/)
  assert.match(html, /运行来源/)
  assert.match(html, /use-local/)
  assert.match(html, /use-managed/)
  assert.match(html, /id="delete-version"/)
  assert.match(javascript, /versionsOf/)
  assert.match(javascript, /toggle_maximize/)
  assert.match(javascript, /start_window_dragging/)
  assert.match(javascript, /stop_dsh/)
  assert.match(javascript, /webUrl/)
  assert.match(javascript, /loadedFrameUrl/)
  assert.match(javascript, /function enterDsh/)
  assert.match(javascript, /function toggleDsh/)
  assert.match(javascript, /function closeWindow/)
  assert.match(javascript, /set_runtime_source/)
  assert.match(javascript, /set_theme/)
  assert.match(javascript, /Apply the visual mode before the Tauri round trip/)
  assert.match(javascript, /prefers-color-scheme: dark/)
  assert.match(javascript, /detect_local_runtime/)
  assert.match(javascript, /delete_runtime/)
  assert.match(javascript, /runtime-confirm-modal/)
  assert.equal(existsSync(file('runtime-assets/node/README.md')), true)
})

test('theme pack contract keeps the skin declarative and local', () => {
  const rust = text('src-tauri/src/theme.rs')
  const mainRust = text('src-tauri/src/lib.rs')
  const state = text('src-tauri/src/state.rs')
  const html = text('dist/index.html')
  const javascript = text('dist/app.js')
  const styles = text('dist/styles.css')
  const manifest = JSON.parse(text('market/neon-agent-theme/package.json'))
  const theme = JSON.parse(text('market/neon-agent-theme/theme/theme.json'))
  const client = text('market/neon-agent-theme/lib/client.js')

  assert.match(state, /appearance_mode/)
  assert.match(state, /skin_id/)
  assert.match(state, /background_intensity/)
  assert.match(state, /reduce_effects/)
  assert.match(mainRust, /preview_theme_pack/)
  assert.match(mainRust, /confirm_theme_pack/)
  assert.match(mainRust, /cancel_theme_preview/)
  assert.match(mainRust, /reset_theme_pack/)
  assert.match(rust, /safe_join/)
  assert.match(rust, /MAX_IMAGE_BYTES/)
  assert.match(rust, /ALLOWED_TOKENS/)
  assert.match(html, /theme-background/)
  assert.match(html, /skin-options/)
  assert.match(html, /background-intensity/)
  assert.match(html, /confirm-theme-preview/)
  assert.match(javascript, /dsh-theme-apply/)
  assert.match(javascript, /preview_theme_pack/)
  assert.match(javascript, /set_background_preferences/)
  assert.match(styles, /data-skin="neon-agent"/)
  assert.equal(manifest.name, '@p-dsh-market/neon-agent-theme')
  assert.equal(manifest.version, '0.1.4')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-theme'])
  assert.equal(manifest.dsh.theme.schemaVersion, 1)
  assert.deepEqual(manifest.dsh.theme.supportedAppearances, ['dark'])
  assert.ok(manifest.dsh.market.capabilities.includes('theme-pack'))
  assert.match(client, /service\.register\(/)
  assert.match(client, /id: 'neon-agent'/)
  assert.equal(theme.background.image, '../assets/background.png')
  assert.equal(theme.background.position, '68% center')
  assert.equal(theme.background.overlay, 'rgba(1, 4, 15, 0.32)')
  assert.deepEqual(
    readFileSync(file('market/neon-agent-theme/assets/background.png')),
    readFileSync(file('feature_doc/assets/neon-agent-background-with-operator.png')),
  )
  assert.equal(existsSync(file('market/neon-agent-theme/assets/preview.png')), true)
  assert.doesNotMatch(rust, /builtin_neon/)
  const fallbackSection = javascript.slice(
    javascript.indexOf('function fallbackThemePacks'),
    javascript.indexOf('function availableThemePacks'),
  )
  assert.doesNotMatch(fallbackSection, /neon-agent/)
  assert.match(javascript, /pack\.source === 'profile'/)
  assert.match(javascript, /pack\.installed === true/)
})

test('theme client registers through the official DSH theme service', () => {
  const source = text('market/neon-agent-theme/lib/client.js')
  let moduleExports
  vm.runInNewContext(source, {
    Symbol,
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          moduleExports = entry.factory(() => ({}))
        },
      },
    },
  })

  let definition
  const service = {
    getTheme: () => ({ themes: [
      { id: 'light', colorScheme: 'light', tokens: {} },
      { id: 'dark', colorScheme: 'dark', tokens: {} },
    ] }),
    register: (value) => {
      definition = value
      return () => {}
    },
  }
  const cleanup = moduleExports.apply({ get: (name) => name === 'theme' ? service : undefined })
  assert.deepEqual(Array.from(moduleExports.inject), ['theme'])
  assert.equal(definition.id, 'neon-agent')
  assert.equal(definition.colorScheme, 'dark')
  assert.equal(definition.tokens['--dsw-alias-brand-primary'], '#1976FF')
  assert.equal(definition.tokens['--dsw-alias-button-elevated-fill'], 'rgba(22, 61, 155, 0.32)')
  cleanup()
})

test('desktop bridge projects theme packs through the DSH Web ThemeService', () => {
  const source = text('plugins/dsh-desktop-bridge/lib/client.js')
  assert.match(source, /ctx\.get\('theme'\)/)
  assert.doesNotMatch(source, /service\.register\(definition\)/)
  assert.match(source, /service\.setTheme\(skinId\)/)
  assert.match(source, /backgroundImage/)
  assert.doesNotMatch(source, /querySelector\(/)

  let moduleExports
  const listeners = new Map()
  const messages = []
  const parent = { postMessage: (message) => messages.push(message) }
  const bodyStyle = {}
  const browserWindow = {
    parent,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  // The bundle registers itself through the module loader so the test can
  // exercise the real exported client rather than a copied helper.
  const document = {
    body: { style: bodyStyle },
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  }
  vm.runInNewContext(source, {
    Symbol,
    document,
    fetch: () => Promise.reject(new Error('not used')),
    AbortController,
    window: {
      ...browserWindow,
      __ModuleLoader__: {
        load: (entry) => {
          moduleExports = entry.factory((name) => name === 'react' ? {} : {})
        },
      },
    },
  })

  const registered = [{ id: 'neon-agent', colorScheme: 'dark', tokens: {} }]
  let current = 'system'
  const service = {
    getTheme: () => ({ themes: [
      { id: 'light', colorScheme: 'light', tokens: {} },
      { id: 'dark', colorScheme: 'dark', tokens: {} },
      ...registered,
    ] }),
    setTheme: (id) => { current = id },
  }
  const client = moduleExports
  const slots = {
    inject(_name, register) { register() },
    register() { return () => {} },
  }
  const cleanup = client.apply({ get: (name) => name === 'theme' ? service : undefined, slots })
  const listener = listeners.get('message')
  assert.equal(typeof listener, 'function')
  listener({
    source: parent,
    data: {
      source: 'dsh-desktop',
      type: 'dsh-theme-apply',
      skinId: 'neon-agent',
      appearance: 'dark',
      appearanceMode: 'dark',
      backgroundIntensity: 1,
      background: {
        imageUrl: 'data:image/png;base64,AAAA',
        targets: ['web.shell'],
        fit: 'cover',
        position: '68% center',
        overlay: 'rgba(1, 4, 15, 0.52)',
        fixed: true,
      },
    },
  })
  assert.equal(current, 'neon-agent')
  assert.match(bodyStyle.backgroundImage, /data:image\/png;base64,AAAA/)
  assert.equal(bodyStyle.backgroundPosition, '68% center')
  assert.equal(messages.at(-1).type, 'theme-applied')

  registered.splice(0)
  listener({
    source: parent,
    data: {
      source: 'dsh-desktop',
      type: 'dsh-theme-apply',
      skinId: 'missing-theme',
      appearance: 'dark',
      appearanceMode: 'dark',
    },
  })
  assert.equal(messages.at(-1).type, 'theme-error')
  assert.match(messages.at(-1).message, /尚未在 DSH Web 注册/)

  listener({
    source: parent,
    data: {
      source: 'dsh-desktop',
      type: 'dsh-theme-apply',
      skinId: 'builtin.default',
      appearance: 'light',
      appearanceMode: 'light',
      tokens: {},
    },
  })
  assert.equal(current, 'light')
  assert.equal(bodyStyle.backgroundImage, '')
  cleanup()
})

test('javascript artifacts pass node syntax validation', () => {
  for (const path of [
    'dist/app.js',
    'plugins/dsh-desktop-bridge/lib/index.js',
    'plugins/dsh-desktop-bridge/lib/client.js',
    'plugins/dsh-market-example/lib/index.js',
    'plugins/dsh-market-example/lib/client.js',
    'market/dsh-open-workspace/lib/index.js',
    'market/dsh-open-workspace/lib/client.js',
    'market/neon-agent-theme/lib/index.js',
    'market/neon-agent-theme/lib/client.js',
  ]) {
    execFileSync(process.execPath, ['--check', file(path)], { stdio: 'pipe' })
  }
})
