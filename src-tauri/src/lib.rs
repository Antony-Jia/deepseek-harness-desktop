#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod control;
mod plugin;
mod process;
mod runtime;
mod single_instance;
mod state;

use control::ControlServer;
use plugin::ensure_profile_plugin;
use process::DshProcess;
use runtime::{validate_version, LocalRuntime, RegistryInfo, RuntimeManager};
use state::{
    DesktopStatus, LocalRuntimeSummary, RuntimeSummary, StateStore, WindowBounds,
    RUNTIME_SOURCE_LOCAL, RUNTIME_SOURCE_MANAGED, THEME_DARK, THEME_LIGHT, THEME_SYSTEM,
};
use std::{
    collections::BTreeMap,
    env,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};

#[derive(Clone)]
pub struct DesktopContext {
    manager: Arc<RuntimeManager>,
    store: StateStore,
    dsh_home: PathBuf,
    local_runtime: Arc<Mutex<Option<LocalRuntime>>>,
    plugin_source: Arc<Mutex<Option<PathBuf>>>,
    control: Arc<Mutex<Option<ControlServer>>>,
    process: Arc<Mutex<Option<DshProcess>>>,
    status: Arc<Mutex<DesktopStatus>>,
    logs: Arc<Mutex<Vec<String>>>,
    start_lock: Arc<Mutex<()>>,
    allow_close: Arc<AtomicBool>,
    window_save_revision: Arc<AtomicU64>,
}

impl DesktopContext {
    fn new() -> Self {
        let base_dir = env::var_os("DSH_DESKTOP_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::data_local_dir().map(|path| path.join("dsh-desktop")))
            .unwrap_or_else(|| env::temp_dir().join("dsh-desktop"));
        let dsh_home = env::var_os("DSH_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|path| path.join(".dsh")))
            .unwrap_or_else(|| env::temp_dir().join(".dsh"));
        let manager = Arc::new(RuntimeManager::new(base_dir.clone()));
        let store = StateStore::new(base_dir.join("state.json"));
        let _ = manager.ensure_layout();
        Self {
            manager,
            store,
            dsh_home,
            local_runtime: Arc::new(Mutex::new(None)),
            plugin_source: Arc::new(Mutex::new(None)),
            control: Arc::new(Mutex::new(None)),
            process: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(DesktopStatus::default())),
            logs: Arc::new(Mutex::new(Vec::new())),
            start_lock: Arc::new(Mutex::new(())),
            allow_close: Arc::new(AtomicBool::new(false)),
            window_save_revision: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let instance = match single_instance::SingleInstance::acquire("Global\\dsh-desktop") {
        Ok(Some(instance)) => instance,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[dsh-desktop] cannot acquire single-instance lock: {error}");
            return;
        }
    };
    let context = DesktopContext::new();
    let context_for_setup = context.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(context)
        .invoke_handler(tauri::generate_handler![
            get_status,
            choose_workspace,
            start_dsh,
            detect_local_runtime,
            set_runtime_source,
            check_for_updates,
            install_and_switch,
            rollback_to_last_good,
            cleanup_runtimes,
            open_logs,
            quit_app,
            stop_dsh,
            set_theme,
            minimize_window,
            toggle_maximize,
            hide_window,
            start_window_dragging
        ])
        .setup(move |app| {
            restore_window_bounds(app, &context_for_setup);
            configure_tray(app)?;
            let plugin_source = plugin_source_candidates();
            if let Ok(mut source) = context_for_setup.plugin_source.lock() {
                *source = plugin_source;
            }
            if let Err(error) = context_for_setup
                .manager
                .ensure_bundled_node(node_source_candidates().as_deref())
            {
                eprintln!("[dsh-desktop] bundled Node bootstrap failed: {error}");
            }
            if let Ok(mut local_runtime) = context_for_setup.local_runtime.lock() {
                *local_runtime = context_for_setup.manager.detect_local();
            }
            let server =
                ControlServer::start(app.handle().clone(), context_for_setup.store.clone())?;
            if let Ok(mut control) = context_for_setup.control.lock() {
                *control = Some(server);
            }
            refresh_common(&context_for_setup);
            spawn_start(app.handle().clone(), context_for_setup.clone(), None);
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle().clone();
            let context = app.state::<DesktopContext>().inner().clone();
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    schedule_window_bounds_save(app, &context);
                }
                WindowEvent::CloseRequested { api, .. } => {
                    persist_window_bounds(&app, &context);
                    if !context.allow_close.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building DSH Desktop")
        .run(move |app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let context = app.state::<DesktopContext>();
                context.allow_close.store(true, Ordering::Relaxed);
                persist_window_bounds(app, &context);
                stop_current(&context);
            }
            let _ = &instance;
        });
}

#[tauri::command]
fn get_status(context: tauri::State<'_, DesktopContext>) -> Result<DesktopStatus, String> {
    refresh_common(&context);
    context
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "状态锁已损坏".to_string())
}

#[tauri::command]
fn choose_workspace(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("选择 DSH 工作区")
        .pick_folder()
    else {
        return Ok(None);
    };
    let mut persisted = context.store.load().map_err(io_error)?;
    persisted.remember_workspace(&path);
    context.store.save(&persisted).map_err(io_error)?;
    let detail = path.to_string_lossy().to_string();
    set_status(
        &context,
        &app,
        "starting",
        "工作区已选择，正在启动",
        &detail,
        None,
        None,
    );
    spawn_start(app, context.inner().clone(), None);
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn start_dsh(app: AppHandle, context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    spawn_start(app, context.inner().clone(), None);
    Ok(())
}

#[tauri::command]
fn detect_local_runtime(
    context: tauri::State<'_, DesktopContext>,
) -> Result<Option<LocalRuntimeSummary>, String> {
    let detected = context.manager.detect_local();
    cache_local_runtime(&context, detected.clone());
    refresh_common(&context);
    Ok(detected.as_ref().map(local_runtime_summary))
}

#[tauri::command]
fn set_runtime_source(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
    source: String,
) -> Result<(), String> {
    if !matches!(
        source.as_str(),
        RUNTIME_SOURCE_LOCAL | RUNTIME_SOURCE_MANAGED
    ) {
        return Err(format!("不支持的运行来源: {source}"));
    }
    if source == RUNTIME_SOURCE_LOCAL {
        let detected = context.manager.detect_local().ok_or_else(|| {
            "当前系统没有可用的本地 @deepseek-ai/dsh，请先执行 npx @deepseek-ai/dsh。".to_string()
        })?;
        cache_local_runtime(&context, Some(detected));
    }
    let mut state = context.store.load().map_err(io_error)?;
    state.runtime_source = source.clone();
    context.store.save(&state).map_err(io_error)?;
    set_status(
        &context,
        &app,
        "starting",
        if source == RUNTIME_SOURCE_LOCAL {
            "将使用本地 DSH"
        } else {
            "将使用桌面托管 DSH"
        },
        "正在按新的运行来源重启 DSH。",
        None,
        None,
    );
    spawn_start(app, context.inner().clone(), None);
    Ok(())
}

#[tauri::command]
fn check_for_updates(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
) -> Result<RegistryInfoResponse, String> {
    set_status(
        &context,
        &app,
        "checking",
        "正在检查上游版本",
        "只读取 npm registry 的 dist-tags 与版本列表。",
        None,
        None,
    );
    let registry = context.manager.registry_info()?;
    let mut state = context.store.load().map_err(io_error)?;
    if registry.latest != state.pinned {
        state.available = Some(registry.latest.clone());
    } else {
        state.available = None;
    }
    context.store.save(&state).map_err(io_error)?;
    set_versions(&context, &registry);
    set_status(
        &context,
        &app,
        "stopped",
        if state.available.is_some() {
            "发现可用更新"
        } else {
            "已是最新固定版本"
        },
        &format!(
            "当前固定版本 {}，latest 为 {}。不会自动安装或切换。",
            state.pinned, registry.latest
        ),
        None,
        None,
    );
    Ok(RegistryInfoResponse {
        latest: registry.latest,
        versions: registry.versions,
    })
}

#[tauri::command]
fn install_and_switch(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
    version: String,
) -> Result<(), String> {
    validate_version(&version)?;
    let state = context.store.load().map_err(io_error)?;
    let rollback = state
        .last_good
        .clone()
        .or_else(|| Some(state.pinned.clone()));
    let context = context.inner().clone();
    thread::spawn(move || {
        let version_for_log = version.clone();
        set_status_arc(
            &context,
            &app,
            "installing",
            "正在安装运行时",
            &format!("准备安装 @deepseek-ai/dsh@{version_for_log}。"),
            None,
            Some(5),
        );
        let context_for_log = context.clone();
        let result = if context.manager.is_ready(&version) {
            add_log(
                &context,
                format!("运行时 {version} 已存在，跳过 npm install。"),
            );
            Ok(())
        } else {
            context.manager.install(&version, move |line| {
                add_log(&context_for_log, line);
            })
        };
        if let Err(error) = result {
            set_status_arc(
                &context,
                &app,
                "failed",
                "运行时安装失败",
                "固定版本没有变化，可以重试或继续使用 lastGood。",
                Some(error),
                None,
            );
            return;
        }
        match context.store.load() {
            Ok(mut state) => {
                state.pinned = version.clone();
                state.available = None;
                state.runtime_source = RUNTIME_SOURCE_MANAGED.to_string();
                if let Err(error) = context.store.save(&state) {
                    set_status_arc(
                        &context,
                        &app,
                        "failed",
                        "保存运行时状态失败",
                        "新运行时已下载，但 state.json 没有更新。",
                        Some(error.to_string()),
                        None,
                    );
                    return;
                }
            }
            Err(error) => {
                set_status_arc(
                    &context,
                    &app,
                    "failed",
                    "读取运行时状态失败",
                    "没有切换固定版本。",
                    Some(error.to_string()),
                    None,
                );
                return;
            }
        }
        set_status_arc(
            &context,
            &app,
            "updating",
            "新运行时已安装，正在重启",
            &format!("尝试启动固定版本 {version}。"),
            None,
            Some(90),
        );
        spawn_start(app, context, rollback);
    });
    Ok(())
}

#[tauri::command]
fn rollback_to_last_good(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
) -> Result<(), String> {
    let mut state = context.store.load().map_err(io_error)?;
    let version = state
        .last_good
        .clone()
        .ok_or_else(|| "没有可回滚的 lastGood 版本".to_string())?;
    state.pinned = version;
    context.store.save(&state).map_err(io_error)?;
    spawn_start(app, context.inner().clone(), None);
    Ok(())
}

#[tauri::command]
fn cleanup_runtimes(context: tauri::State<'_, DesktopContext>) -> Result<Vec<String>, String> {
    let state = context.store.load().map_err(io_error)?;
    let removed = context.manager.cleanup(&state, 3)?;
    refresh_common(&context);
    Ok(removed)
}

#[tauri::command]
fn open_logs(context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    context.manager.ensure_layout().map_err(io_error)?;
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(context.manager.logs_dir())
            .spawn()
            .map_err(|error| format!("打开日志目录失败: {error}"))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open")
            .arg(context.manager.logs_dir())
            .spawn()
            .map_err(|error| format!("打开日志目录失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle, context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    context.allow_close.store(true, Ordering::Relaxed);
    persist_window_bounds(&app, &context);
    stop_current(&context);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn stop_dsh(app: AppHandle, context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    stop_current(&context);
    set_status(
        &context,
        &app,
        "stopped",
        "DSH 已关闭",
        "可以返回首页重新启动。",
        None,
        None,
    );
    Ok(())
}

#[tauri::command]
fn set_theme(context: tauri::State<'_, DesktopContext>, theme: String) -> Result<(), String> {
    if !matches!(theme.as_str(), THEME_LIGHT | THEME_DARK | THEME_SYSTEM) {
        return Err(format!("不支持的主题模式: {theme}"));
    }
    let mut state = context.store.load().map_err(io_error)?;
    state.theme = theme;
    context.store.save(&state).map_err(io_error)?;
    refresh_common(&context);
    Ok(())
}

#[tauri::command]
fn minimize_window(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
) -> Result<(), String> {
    persist_window_bounds(&app, &context);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    persist_window_bounds(&app, &context);
    Ok(maximized)
}

#[tauri::command]
fn hide_window(app: AppHandle, context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    persist_window_bounds(&app, &context);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_window_dragging(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    window.start_dragging().map_err(|error| error.to_string())
}

fn restore_window_bounds(app: &mut tauri::App, context: &DesktopContext) {
    let Ok(state) = context.store.load() else {
        return;
    };
    let Some(bounds) = state.window_bounds else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let width = bounds.width.max(560).min(10_000);
    let height = bounds.height.max(520).min(10_000);
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
    let _ = window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y));
    if bounds.maximized {
        let _ = window.maximize();
    }
}

fn persist_window_bounds(app: &AppHandle, context: &DesktopContext) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let bounds = WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };
    let Ok(mut state) = context.store.load() else {
        return;
    };
    if state.window_bounds.as_ref() == Some(&bounds) {
        return;
    }
    state.window_bounds = Some(bounds);
    let _ = context.store.save(&state);
}

fn schedule_window_bounds_save(app: AppHandle, context: &DesktopContext) {
    let revision = context.window_save_revision.fetch_add(1, Ordering::Relaxed) + 1;
    let context = context.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(250));
        if context.window_save_revision.load(Ordering::Relaxed) != revision {
            return;
        }
        persist_window_bounds(&app, &context);
    });
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistryInfoResponse {
    latest: String,
    versions: Vec<String>,
}

fn configure_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "check-updates", "检查上游更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DSH Desktop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &updates, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("DSH Desktop · idle");
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.on_menu_event(|app, event| {
        let context = app.state::<DesktopContext>().inner().clone();
        match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "check-updates" => {
                let _ = check_for_updates(app.clone(), app.state::<DesktopContext>());
            }
            "quit" => {
                context.allow_close.store(true, Ordering::Relaxed);
                stop_current(&context);
                app.exit(0);
            }
            _ => {}
        }
    })
    .build(app)?;
    Ok(())
}

fn spawn_start(app: AppHandle, context: DesktopContext, rollback: Option<String>) {
    thread::spawn(move || {
        let result = {
            let _guard = context.start_lock.lock().expect("start lock poisoned");
            start_once(&app, &context)
        };
        match result {
            Ok(process) => {
                let url = process.url.clone();
                if let Ok(mut slot) = context.process.lock() {
                    *slot = Some(process);
                }
                if let Ok(mut state) = context.store.load() {
                    state.last_good = Some(state.pinned.clone());
                    let _ = context.store.save(&state);
                }
                set_status_arc(
                    &context,
                    &app,
                    "ready",
                    "DSH 已启动",
                    &format!("WebView 正在打开 {url}。"),
                    None,
                    Some(100),
                );
                spawn_process_watch(app, context);
            }
            Err(error) => {
                let current_status = context
                    .status
                    .lock()
                    .map(|status| status.status.clone())
                    .unwrap_or_default();
                if matches!(
                    current_status.as_str(),
                    "needs_workspace" | "needs_install" | "needs_local"
                ) {
                    return;
                }
                let should_rollback = rollback
                    .as_ref()
                    .zip(context.store.load().ok())
                    .map(|(fallback, state)| fallback != &state.pinned)
                    .unwrap_or(false);
                if should_rollback {
                    let fallback = rollback.expect("rollback checked");
                    if let Ok(mut state) = context.store.load() {
                        state.pinned = fallback.clone();
                        let _ = context.store.save(&state);
                    }
                    set_status_arc(
                        &context,
                        &app,
                        "updating",
                        "新版本启动失败，正在回滚",
                        &format!("已保留失败版本，恢复到 lastGood {fallback}。"),
                        Some(error),
                        Some(10),
                    );
                    spawn_start(app, context, None);
                } else {
                    set_status_arc(
                        &context,
                        &app,
                        "failed",
                        "DSH 启动失败",
                        "请查看日志，或回滚到 lastGood 后重试。",
                        Some(error),
                        None,
                    );
                }
            }
        }
    });
}

fn start_once(app: &AppHandle, context: &DesktopContext) -> Result<DshProcess, String> {
    stop_current(context);
    let mut state = context.store.load().map_err(io_error)?;
    let workspace = state
        .last_workspace
        .clone()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or_else(|| {
            set_status(
                context,
                app,
                "needs_workspace",
                "请选择一个工作区",
                "dsh 会以工作区作为进程 cwd。",
                None,
                None,
            );
            "尚未选择有效工作区".to_string()
        })?;
    if state.runtime_source == RUNTIME_SOURCE_LOCAL {
        let local = context.manager.detect_local();
        cache_local_runtime(context, local.clone());
        if let Some(local) = local {
            if let Ok(source) = context.plugin_source.lock() {
                let _ = ensure_profile_plugin(source.as_deref(), &context.dsh_home);
            }
            let (control_url, token) = control_credentials(context)?;
            set_status(
                context,
                app,
                "starting",
                "正在启动本地 DSH",
                &format!(
                    "本地版本 {} · 工作区 {}",
                    local.version,
                    workspace.display()
                ),
                None,
                Some(15),
            );
            let context_for_log = context.clone();
            return DshProcess::spawn_local(
                &context.manager,
                &local,
                &workspace,
                &context.dsh_home,
                &control_url,
                &token,
                move |line| add_log(&context_for_log, line),
            );
        }
        if !context.manager.is_ready(&state.pinned) {
            set_status(
                context,
                app,
                "needs_local",
                "没有检测到本地 DSH",
                "请先在系统终端执行 npx @deepseek-ai/dsh，或切换为桌面托管版本。",
                None,
                None,
            );
            return Err("没有检测到可用的本地 @deepseek-ai/dsh".to_string());
        }
        state.runtime_source = RUNTIME_SOURCE_MANAGED.to_string();
        context.store.save(&state).map_err(io_error)?;
        add_log(
            context,
            format!("本地 DSH 未检测到，自动切换到托管运行时 {}。", state.pinned),
        );
    }
    if !context.manager.is_ready(&state.pinned) {
        set_status(
            context,
            app,
            "needs_install",
            "需要先安装固定运行时",
            &format!(
                "找不到 @deepseek-ai/dsh@{}，请点击安装并切换。",
                state.pinned
            ),
            None,
            None,
        );
        return Err(format!("运行时 {} 未安装", state.pinned));
    }
    if let Ok(source) = context.plugin_source.lock() {
        let _ = ensure_profile_plugin(source.as_deref(), &context.dsh_home);
    }
    let (control_url, token) = control_credentials(context)?;
    set_status(
        context,
        app,
        "starting",
        "正在启动 DSH",
        &format!("版本 {} · 工作区 {}", state.pinned, workspace.display()),
        None,
        Some(15),
    );
    let context_for_log = context.clone();
    DshProcess::spawn(
        &context.manager,
        &state.pinned,
        &workspace,
        &context.dsh_home,
        &control_url,
        &token,
        move |line| add_log(&context_for_log, line),
    )
}

fn spawn_process_watch(app: AppHandle, context: DesktopContext) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let exited = context
            .process
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|process| !process.is_running()))
            .unwrap_or(false);
        if exited {
            if let Ok(mut slot) = context.process.lock() {
                let _ = slot.take();
            }
            set_status_arc(
                &context,
                &app,
                "failed",
                "DSH 进程已退出",
                "可以点击重试启动，或打开日志目录查看退出原因。",
                None,
                None,
            );
            break;
        }
        if context
            .process
            .lock()
            .map(|slot| slot.is_none())
            .unwrap_or(true)
        {
            break;
        }
    });
}

fn stop_current(context: &DesktopContext) {
    if let Ok(mut slot) = context.process.lock() {
        if let Some(process) = slot.take() {
            let _ = process.stop();
        }
    }
}

fn control_credentials(context: &DesktopContext) -> Result<(String, String), String> {
    let control = context
        .control
        .lock()
        .map_err(|_| "控制端口锁已损坏".to_string())?;
    let control = control
        .as_ref()
        .ok_or_else(|| "控制端口尚未启动".to_string())?;
    Ok((control.base_url.clone(), control.token.clone()))
}

fn cache_local_runtime(context: &DesktopContext, runtime: Option<LocalRuntime>) {
    if let Ok(mut cached) = context.local_runtime.lock() {
        *cached = runtime;
    }
}

fn local_runtime_summary(runtime: &LocalRuntime) -> LocalRuntimeSummary {
    LocalRuntimeSummary {
        version: runtime.version.clone(),
        command: runtime.command.to_string_lossy().to_string(),
        source: "系统 PATH / npx 缓存".to_string(),
    }
}

fn refresh_common(context: &DesktopContext) {
    let state = context.store.load().unwrap_or_default();
    let mut versions = context.manager.list_installed().unwrap_or_default();
    for version in [Some(state.pinned.clone()), state.available.clone()]
        .into_iter()
        .flatten()
    {
        if !versions.iter().any(|item| item.version == version) {
            versions.push(RuntimeSummary {
                version,
                installed: false,
                ready: false,
            });
        }
    }
    let logs = context
        .logs
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default();
    let local_runtime = context
        .local_runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.as_ref().map(local_runtime_summary));
    let web_url = context
        .process
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|process| process.url.clone()));
    if let Ok(mut status) = context.status.lock() {
        status.web_url = web_url;
        status.pinned = state.pinned;
        status.last_good = state.last_good;
        status.available = state.available;
        status.workspace = state.last_workspace;
        status.runtime_source = state.runtime_source;
        status.theme = state.theme;
        status.local_runtime = local_runtime;
        status.versions = versions;
        status.logs = logs;
    }
}

fn set_versions(context: &DesktopContext, registry: &RegistryInfo) {
    let installed = context
        .manager
        .list_installed()
        .unwrap_or_default()
        .into_iter()
        .map(|item| (item.version.clone(), item))
        .collect::<BTreeMap<_, _>>();
    let mut versions = registry
        .versions
        .iter()
        .map(|version| RuntimeSummary {
            version: version.clone(),
            installed: installed.contains_key(version),
            ready: installed
                .get(version)
                .map(|item| item.ready)
                .unwrap_or(false),
        })
        .collect::<Vec<_>>();
    for (version, item) in installed {
        if !versions.iter().any(|entry| entry.version == version) {
            versions.push(item);
        }
    }
    if let Ok(mut status) = context.status.lock() {
        status.versions = versions;
    }
}

fn add_log(context: &DesktopContext, line: String) {
    let snapshot = {
        if let Ok(mut logs) = context.logs.lock() {
            logs.push(line);
            if logs.len() > 240 {
                let drain = logs.len() - 240;
                logs.drain(0..drain);
            }
            logs.clone()
        } else {
            return;
        }
    };
    if let Ok(mut status) = context.status.lock() {
        status.logs = snapshot;
    }
}

fn set_status(
    context: &DesktopContext,
    app: &AppHandle,
    status: &str,
    message: &str,
    detail: &str,
    error: Option<String>,
    progress: Option<u8>,
) {
    set_status_arc(context, app, status, message, detail, error, progress);
}

fn set_status_arc(
    context: &DesktopContext,
    app: &AppHandle,
    status: &str,
    message: &str,
    detail: &str,
    error: Option<String>,
    progress: Option<u8>,
) {
    refresh_common(context);
    let snapshot = {
        let Ok(mut current) = context.status.lock() else {
            return;
        };
        current.status = status.to_string();
        current.message = message.to_string();
        current.detail = detail.to_string();
        current.error = error;
        current.progress = progress;
        current.clone()
    };
    let _ = app.emit("desktop://status", snapshot);
}

fn plugin_source_candidates() -> Option<PathBuf> {
    let candidates = [
        env::var_os("DSH_DESKTOP_PLUGIN_SOURCE").map(PathBuf::from),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/dsh-desktop-bridge")),
        env::current_exe().ok().and_then(|path| {
            path.parent()
                .map(|parent| parent.join("resources/dsh-desktop-bridge"))
        }),
        env::current_exe().ok().and_then(|path| {
            path.parent()
                .map(|parent| parent.join("dsh-desktop-bridge"))
        }),
    ];
    candidates.into_iter().flatten().find(|path| path.is_dir())
}

fn node_source_candidates() -> Option<PathBuf> {
    let candidates = [
        env::var_os("DSH_DESKTOP_NODE_SOURCE").map(PathBuf::from),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime-assets/node")),
        env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.join("resources/node"))),
        env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.join("node"))),
    ];
    candidates.into_iter().flatten().find(|path| {
        path.is_dir()
            && path
                .join(if cfg!(windows) { "node.exe" } else { "node" })
                .is_file()
    })
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}
