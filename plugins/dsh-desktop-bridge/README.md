# dsh-desktop-bridge

Optional DSH host/browser integration used by DSH Desktop.

The host half is inert unless DSH_DESKTOP_CTRL and DSH_DESKTOP_TOKEN are
present. When the desktop shell starts DSH it can therefore reuse the same
user profile under ~/.dsh from a normal command-line DSH session.

It provides:

- /dsh-desktop-bridge/pick-folder, a DSH-side proxy for the native folder picker;
- tray busy/idle updates around turn/start and turn/end;
- background turn-completion and approval notifications;
- a centralized Skill provider controlled from the desktop titlebar for market packages, user-level `~/.dsh/skills` and `~/.agents/skills`, and the current workspace's `.dsh/skills` and `.agents/skills`, without per-plugin integration.

The plugin intentionally uses feature detection for session events and
workspace methods. Upstream changes should degrade to a no-op rather than
preventing the DSH web process from starting.
