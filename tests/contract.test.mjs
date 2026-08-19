import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

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
  assert.match(host, /DSH_DESKTOP_CTRL/)
  assert.match(host, /DSH_DESKTOP_TOKEN/)
  assert.match(host, /if \(!CONTROL \|\| !TOKEN\) return/)
  assert.match(host, /turn\/end/)
  assert.doesNotMatch(client, /dsh-desktop-folder/)
  assert.doesNotMatch(client, /sidebar\.footer\.action/)
  assert.doesNotMatch(client, /pick-folder/)
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
  assert.match(javascript, /viewMode = 'market'/)
  assert.match(javascript, /search_market_plugins/)
  assert.match(javascript, /install_market_plugin/)
  assert.match(javascript, /uninstall_market_plugin/)
  assert.match(javascript, /previewMarketTheme/)
  assert.match(javascript, /卸载此主题包；当前主题会先回退默认主题/)
  assert.equal(fixture.name, '@p-dsh-market/example')
  assert.equal(fixture.exports['./client'], './lib/client.js')
  assert.equal(fixture.dsh.client.platform, 'web')
  assert.equal(fixture.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(fixture.dsh.market.capabilities.sort(), ['client', 'host', 'skills'])
  assert.equal(catalog.schemaVersion, 1)
  assert.deepEqual(catalog.packages, [
    '@p-dsh-market/dsh-open-workspace',
    '@p-dsh-market/neon-agent-theme',
  ])
  assert.match(catalogWorkflow, /schedule:/)
  assert.match(catalogWorkflow, /validate-market-catalog\.mjs/)
  assert.match(catalogValidator, /function npmView/)
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

  assert.equal(manifest.name, '@p-dsh-market/dsh-open-workspace')
  assert.equal(manifest.version, '0.1.6')
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
  assert.match(client, /currentSession\.cwd/)
  assert.match(client, /var root = sessionRoot \|\| snap\.root/)
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
  assert.match(html, /id="market-restart-dsh"/)
  assert.doesNotMatch(html, /id="titlebar-workspace"/)
  assert.doesNotMatch(html, /id="titlebar-terminal"/)
  assert.match(javascript, /workspace-panel-toggle/)
  assert.match(javascript, /terminal-panel-toggle/)
  assert.match(javascript, /get_desktop_contributions/)
  assert.match(javascript, /function restartDsh/)
  assert.match(javascript, /desktop\.titlebar\.workspaceActions/)
  assert.match(rust, /fn get_desktop_contributions/)
  assert.match(desktopRust, /DESKTOP_TITLEBAR_WORKSPACE_ACTIONS/)
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
  assert.match(html, /app-update/)
  assert.match(html, /app-upgrade/)
  assert.match(html, /app-stop/)
  assert.match(html, /toggle-dsh/)
  assert.match(html, /enter-dsh/)
  assert.match(html, /data-theme-choice="light"/)
  assert.match(html, /data-theme-choice="dark"/)
  assert.match(html, /data-theme-choice="system"/)
  assert.doesNotMatch(html, /选择文件夹/)
  assert.match(html, /运行来源/)
  assert.match(html, /use-local/)
  assert.match(html, /use-managed/)
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
  assert.equal(manifest.version, '0.1.1')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-theme'])
  assert.equal(manifest.dsh.theme.schemaVersion, 1)
  assert.deepEqual(manifest.dsh.theme.supportedAppearances, ['dark'])
  assert.ok(manifest.dsh.market.capabilities.includes('theme-pack'))
  assert.match(client, /service\.register\(/)
  assert.match(client, /id: 'neon-agent'/)
  assert.equal(theme.background.image, '../assets/background.png')
  assert.equal(existsSync(file('dist/assets/neon-agent-background.png')), true)
  assert.equal(existsSync(file('dist/assets/neon-agent-background-with-operator.png')), true)
  assert.equal(existsSync(file('market/neon-agent-theme/assets/preview.png')), true)
})

test('desktop bridge projects theme packs through the DSH Web ThemeService', () => {
  const source = text('plugins/dsh-desktop-bridge/lib/client.js')
  assert.match(source, /ctx\.get\('theme'\)/)
  assert.match(source, /service\.register\(definition\)/)
  assert.match(source, /service\.setTheme\(skinId\)/)
  assert.match(source, /--dsw-alias-bg-base/)
  assert.doesNotMatch(source, /querySelector\(/)

  let moduleExports
  const listeners = new Map()
  const messages = []
  const parent = { postMessage: (message) => messages.push(message) }
  const browserWindow = {
    parent,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  // The bundle registers itself through the module loader so the test can
  // exercise the real exported client rather than a copied helper.
  vm.runInNewContext(source, {
    Symbol,
    window: {
      ...browserWindow,
      __ModuleLoader__: {
        load: (entry) => {
          moduleExports = entry.factory(() => ({}))
        },
      },
    },
  })

  const registered = []
  let current = 'system'
  const service = {
    getTheme: () => ({ themes: [
      { id: 'light', colorScheme: 'light', tokens: {} },
      { id: 'dark', colorScheme: 'dark', tokens: {} },
      ...registered,
    ] }),
    register: (definition) => {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    setTheme: (id) => { current = id },
  }
  const client = moduleExports
  const cleanup = client.apply({ get: (name) => name === 'theme' ? service : undefined })
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
      tokens: {
        'color.background.base': '#02040D',
        'web.sidebar.surface': 'rgba(3, 8, 24, 0.88)',
      },
    },
  })
  assert.equal(current, 'neon-agent')
  assert.equal(registered[0].tokens['--dsw-alias-bg-base'], '#02040D')
  assert.equal(registered[0].tokens['--dsw-specific-sidebar-fill'], 'rgba(3, 8, 24, 0.88)')
  assert.equal(messages.at(-1).type, 'theme-applied')

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
  assert.equal(registered.length, 0)
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
