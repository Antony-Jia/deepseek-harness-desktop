# DSH Desktop

简体中文： [README.zh-CN.md](README.zh-CN.md)

DSH Desktop is a thin Windows/Tauri shell around the @deepseek-ai/dsh npm
runtime. It does not vendor or rebuild upstream DSH code.

Implemented boundaries:

- %LOCALAPPDATA%/dsh-desktop/state.json stores the pinned, last-good and
  available runtime versions plus desktop preferences.
- Each DSH version is installed under its own runtime directory with an exact
  npm specifier. Failed installs are staged in a temporary directory and
  removed.
- The shell starts DSH as a separate Node process with an explicit cwd,
  loopback-only web/control ports, a random Bearer token and a Windows Job
  Object configured with KILL_ON_JOB_CLOSE.
- The splash page shows install/startup logs and failure actions. A successful
  startup navigates the WebView to DSH's loopback URL.
- A tray icon and native notification bridge are exposed through the optional
  dsh-desktop-bridge profile plugin.

## Local development

Install dependencies with:

    npm install
    npm run check
    npm run tauri dev

The development shell uses the Node executable on PATH unless
runtime-assets/node/node.exe is provided. A release bundle includes that
directory as a resource and copies it to
%LOCALAPPDATA%/dsh-desktop/node on first launch. The repository intentionally
does not commit the 50+ MB Node distribution.

To exercise the runtime installer, install the pinned version 0.1.0-rc.6 from
the splash page.

For a release build, put a portable Node 24 x64 distribution under
runtime-assets/node/, verify its SHA256 outside this repository, then run:

    npm run build

The current Tauri configuration targets the Windows NSIS bundle and embeds the
WebView2 bootstrapper. Code signing is intentionally left to the distribution
environment.

The isolated runtime probe used during development is available at
scripts/e1-runtime-smoke.ps1. It installs rc.6 into a temporary directory,
checks the loopback page, and removes only that temporary directory.
