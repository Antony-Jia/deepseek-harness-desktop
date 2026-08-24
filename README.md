# DSH Desktop

简体中文： [README.zh-CN.md](README.zh-CN.md)

DSH Desktop is a Windows/Tauri desktop shell for the `@deepseek-ai/dsh` npm
runtime. It manages the runtime process, desktop experience, themes, and a
validated plugin marketplace without vendoring or rebuilding upstream DSH
code.

![DSH Desktop home](images/%E9%A6%96%E9%A1%B5.png)

## Download and install

The current Windows x64 installer is available from the
[v0.1.8 GitHub release](https://github.com/Antony-Jia/deepseek-harness-desktop/releases/tag/v0.1.8):

[Download DSH Desktop for Windows](https://github.com/Antony-Jia/deepseek-harness-desktop/releases/download/v0.1.8/DSH.Desktop_0.1.8_x64-setup.exe)

The installer includes a checksum-verified Node.js v24.19.0 x64 runtime, so
the target machine does not need Node.js, npm, or npx installed. The first
managed-runtime setup still needs network access to download the selected
`@deepseek-ai/dsh` version from the npm registry.

After installation, launch DSH Desktop and use the home page to start DSH or
enter the already-running DSH page. The client opens the loopback Web UI in
its embedded WebView; no manual browser URL copy is required.

## What the desktop shell provides

- Starts DSH as a separate Node process with an explicit working directory.
- Uses loopback-only Web/control ports, a random Bearer token, and a Windows
  Job Object configured with `KILL_ON_JOB_CLOSE`.
- Supports the local system DSH runtime or an isolated, desktop-managed DSH
  runtime. Managed versions are installed independently and do not overwrite
  the system npm installation.
- Provides a validated marketplace for installing and uninstalling Web-profile
  plugins and theme packs, with installed/enabled/protocol compatibility gates.
- Caches validated marketplace scans, shows pending plugin updates in the title
  bar, and provides an explicit refresh action when the remote catalog changes.
- Adds `@p-dsh-market/conversation-knowledge-map` for turning selected
  same-workspace conversations into a mind map or a read-only knowledge graph.
- Adds the DeepSeek Vision Bridge plugin for non-vision models, with a `/vision`
  command and a guarded `deepseek_vision_analyze` tool for persisted session images.
- Keeps desktop plugin actions responsive with an overflow menu and exposes the
  standard home and restart actions in the title bar.
- Provides a centralized title-bar Skills control for market packages, user-level
  Skills, and the current workspace's `.dsh/skills` or `.agents/skills`.
- Adds MCP management beside the marketplace and registers tools through DSH's
  official MCP client. It includes opt-in Tavily Search, Firecrawl, and local-only
  Chrome DevTools presets and
  user-managed stdio/npm, local-command, and Streamable HTTP servers.
- Keeps the custom MCP editor aligned with light, dark, system, and installed
  Theme Pack appearances.
- Supports controlled desktop title-bar contributions, workspace browsing,
  terminal access, stock market analysis, and multi-Agent roundtable sessions.
- Shows startup, installation, update, and failure logs in the recovery page.
- Provides a visible tray icon, native notification bridge, and custom
  borderless window controls.
- Remembers window position, size, maximized state, and the selected light,
  dark, or system theme in `%LOCALAPPDATA%/dsh-desktop/state.json`.

### MCP management

The MCP view beside the marketplace manages opt-in Tavily Search, Firecrawl, and
local-only Chrome DevTools presets, plus user-added stdio npm packages, local
commands, or Streamable HTTP servers. npm packages are installed by the
desktop-managed Node/npm on first
enabled startup. DSH registers each service through the official
`@deepseek-ai/dsh-mcp-client` as `mcp__<serverName>__*`. API keys, environment
variables, and HTTP headers are protected with Windows DPAPI and never shown in
the UI. The page reports connection state, registered tool count, and tool names;
every service remains disabled until explicitly enabled.
The Chrome preset uses local stdio to launch an isolated local Chrome and does not
accept a remote browser URL.
An optional `autoConnect` toggle connects to the current local Chrome; when it is
off, the preset continues to launch a separate isolated browser.
The readiness panel separately reports local Node/npm availability, npm registry
reachability, exact-version cache state, Web-profile insertion, and live tool
registration so download failures are distinguishable from MCP process failures.

### Skills management

The title-bar Skills control combines Skills from installed market packages,
`~/.dsh/skills`, `~/.agents/skills`, and the current workspace's `.dsh/skills` or
`.agents/skills`. It exposes managed enable/disable state through the DSH Skills
provider while keeping unmanaged upstream Skills visible and read-only.

### DeepSeek Vision Bridge

The marketplace includes `@p-dsh-market/deepseek-vision-bridge` for DSH models
that cannot accept images natively. After installing the plugin and restarting
DSH, attach images and run `/vision your question`; the plugin uses the official
`deepseek-official/deepseek-v4-flash-vision-exp` model through a guarded
`deepseek_vision_analyze` tool. It only reads persisted DSH session attachments,
supports up to eight explicitly selected images, and never reads arbitrary local
paths or remote URLs. Native vision models bypass the bridge and keep the tool
hidden. The command records the original question and images as a normal user
message, while bridge guidance stays in the system prompt so the conversation
shows the expected user bubble and image gallery.

### Conversation Knowledge Map

The marketplace includes `@p-dsh-market/conversation-knowledge-map`. Select
multiple historical conversations from the same workspace to generate a staged
mind map, a read-only source-linked knowledge graph, or both. Generation requires
an explicit in-app confirmation, supports provider/model and extraction-scope
selection, and persists graph data plus source metadata under
`.g-dsh-market-knowledge/` without copying full chat transcripts. The view also
provides a progress timeline, failure diagnostics, batch generation, zoom,
spacing, and one-hop filtering for graph exploration.

## Screenshots

### Plugin marketplace

Search, inspect, install, and uninstall validated plugins and theme packs for
the DSH Web profile.

![DSH plugin marketplace](images/%E6%8F%92%E4%BB%B6%E5%B8%82%E5%9C%BA.png)

### Workspace files and terminal

Browse workspace files with Markdown, HTML, and code previews while keeping an
integrated PowerShell terminal available below the DSH conversation.

![Workspace file browser and terminal](images/%E5%B7%A5%E4%BD%9C%E5%8C%BA%E6%96%87%E4%BB%B6%E4%B8%8E%E7%BB%88%E7%AB%AF.png)

### Stock analysis plugin

The AKShare plugin renders market snapshots, historical candlesticks, and
technical-analysis results directly in the conversation and side panel.

![AKShare stock analysis plugin](images/%E8%82%A1%E7%A5%A8%E6%8F%92%E4%BB%B6.png)

### Multi-Agent roundtable

Run independent Agent sessions with configurable roles, cross-review rounds,
streamed Markdown messages, and a final moderator summary.

![Multi-Agent roundtable](images/%E5%A4%9A%E4%BA%BA%E8%AE%A8%E8%AE%BA.png)

## Runtime and data locations

- `%LOCALAPPDATA%/dsh-desktop/state.json` stores the pinned and last-good DSH
  versions, available updates, runtime source, desktop preferences, and
  window bounds.
- Managed DSH versions are stored under
  `%LOCALAPPDATA%/dsh-desktop/runtimes/<version>`.
- Application logs are stored under `%LOCALAPPDATA%/dsh-desktop/logs`.
- A bundled Node runtime is copied to `%LOCALAPPDATA%/dsh-desktop/node` on
  first launch when the installer resource contains it.

## Local development

The repository uses Node/npm to run checks and the Tauri CLI. Install the
development dependencies and start the development shell with:

```powershell
npm install
npm run check
npm test
npm run tauri dev
```

Development mode uses Node on `PATH` unless a portable runtime is present in
`runtime-assets/node/`. The Node binaries are intentionally ignored by Git;
only `runtime-assets/node/README.md` is tracked.

## Building an installer

To reproduce the current release build, download the official Node.js 24 x64
portable ZIP, verify it, and extract its contents directly into
`runtime-assets/node/`:

- File: `node-v24.19.0-win-x64.zip`
- SHA256: `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`
- Official release directory:
  <https://nodejs.org/download/release/latest-v24.x/>

The directory must contain `node.exe` and
`node_modules/npm/bin/npm-cli.js`. Then run:

```powershell
npm run check
npm test
npm run build
```

The Windows NSIS installer is generated at:

```text
src-tauri/target/release/bundle/nsis/DSH Desktop_0.1.8_x64-setup.exe
```

`src-tauri/target/`, `dist/bundle/`, portable Node binaries, and installer
files are ignored by `.gitignore`; they are release-build inputs or outputs,
not source files to commit.

The Tauri configuration embeds the WebView2 bootstrapper. Code signing is
left to the distribution environment.

## Runtime smoke test

The isolated runtime probe is available at
`scripts/e1-runtime-smoke.ps1`. It installs rc.6 into a temporary directory,
checks the loopback page, and removes only that temporary directory.
