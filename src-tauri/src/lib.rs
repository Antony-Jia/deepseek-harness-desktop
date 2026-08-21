#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod control;
mod market;
mod mcp;
mod plugin;
mod process;
mod runtime;
mod single_instance;
mod state;
mod theme;

use control::ControlServer;
use market::{
    DesktopContributionsResult, MarketManager, MarketOperationResult, MarketSearchResult,
};
use mcp::{McpConfigResult, McpManager, McpRuntimeResult};
use plugin::ensure_profile_plugin;
use process::DshProcess;
use runtime::{validate_version, LocalRuntime, RegistryInfo, RuntimeManager};
use state::{
    DesktopStatus, LocalRuntimeSummary, RuntimeSummary, StateStore, WindowBounds,
    DEFAULT_BACKGROUND_INTENSITY, DEFAULT_SKIN_ID, RUNTIME_SOURCE_LOCAL, RUNTIME_SOURCE_MANAGED,
    THEME_DARK, THEME_LIGHT, THEME_SYSTEM,
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
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};

#[derive(Clone)]
pub struct DesktopContext {
    manager: Arc<RuntimeManager>,
    market: Arc<MarketManager>,
    mcp: Arc<McpManager>,
    store: StateStore,
    dsh_home: PathBuf,
    local_runtime: Arc<Mutex<Option<LocalRuntime>>>,
    plugin_source: Arc<Mutex<Option<PathBuf>>>,
    control: Arc<Mutex<Option<ControlServer>>>,
    process: Arc<Mutex<Option<DshProcess>>>,
    status: Arc<Mutex<DesktopStatus>>,
    logs: Arc<Mutex<Vec<String>>>,
    start_lock: Arc<Mutex<()>>,
    market_task_lock: Arc<tauri::async_runtime::Mutex<()>>,
    theme_preview: Arc<Mutex<Option<ThemePreview>>>,
    allow_close: Arc<AtomicBool>,
    window_save_revision: Arc<AtomicU64>,
}

#[derive(Debug, Clone)]
struct ThemePreview {
    id: String,
    previous_skin_id: String,
    expires_at: u64,
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
        let market = Arc::new(MarketManager::new(base_dir.clone()));
        let mcp = Arc::new(McpManager::new(base_dir.clone()));
        let store = StateStore::new(base_dir.join("state.json"));
        let _ = manager.ensure_layout();
        Self {
            manager,
            market,
            mcp,
            store,
            dsh_home,
            local_runtime: Arc::new(Mutex::new(None)),
            plugin_source: Arc::new(Mutex::new(None)),
            control: Arc::new(Mutex::new(None)),
            process: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(DesktopStatus::default())),
            logs: Arc::new(Mutex::new(Vec::new())),
            start_lock: Arc::new(Mutex::new(())),
            market_task_lock: Arc::new(tauri::async_runtime::Mutex::new(())),
            theme_preview: Arc::new(Mutex::new(None)),
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
            get_desktop_contributions,
            choose_workspace,
            start_dsh,
            restart_dsh,
            detect_local_runtime,
            set_runtime_source,
            check_for_updates,
            install_and_switch,
            rollback_to_last_good,
            cleanup_runtimes,
            open_logs,
            open_workspace_folder,
            open_workspace_terminal,
            quit_app,
            stop_dsh,
            search_market_plugins,
            install_market_plugin,
            uninstall_market_plugin,
            list_mcp_servers,
            save_mcp_server,
            get_mcp_runtime_status,
            set_theme,
            list_theme_packs,
            get_active_theme_pack,
            preview_theme_pack,
            confirm_theme_pack,
            cancel_theme_preview,
            reset_theme_pack,
            set_background_preferences,
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
            let context_for_detect = context_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                let manager = context_for_detect.manager.clone();
                let detected = manager.detect_local_async().await;
                cache_local_runtime(&context_for_detect, detected);
                refresh_common(&context_for_detect);
            });
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
async fn get_desktop_contributions(
    context: tauri::State<'_, DesktopContext>,
) -> Result<DesktopContributionsResult, String> {
    let persisted = context.store.load().map_err(io_error)?;
    let dsh_running = context
        .process
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|process| !process.url.is_empty()))
        .unwrap_or(false);
    let workspace_selected = persisted.last_workspace.is_some();
    match context.market.desktop_contributions(&context.dsh_home) {
        Ok(contributions) => Ok(DesktopContributionsResult {
            protocol_version: market::DESKTOP_PROTOCOL_VERSION,
            contributions,
            runtime_ready: true,
            dsh_running,
            workspace_selected,
            message: if dsh_running {
                String::new()
            } else {
                "桌面插件贡献已预加载，将在 DSH 启动后显示。".to_string()
            },
        }),
        Err(error) => Ok(DesktopContributionsResult::unavailable(
            format!("读取桌面插件贡献失败：{error}"),
            dsh_running,
            workspace_selected,
        )),
    }
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
fn restart_dsh(app: AppHandle, context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    stop_current(&context);
    set_status(
        &context,
        &app,
        "starting",
        "正在重启 DSH",
        "正在停止旧进程并启动当前工作区。",
        None,
        None,
    );
    spawn_start(app, context.inner().clone(), None);
    Ok(())
}

#[tauri::command]
async fn detect_local_runtime(
    context: tauri::State<'_, DesktopContext>,
) -> Result<Option<LocalRuntimeSummary>, String> {
    let detected = context.manager.detect_local_async().await;
    cache_local_runtime(&context, detected.clone());
    refresh_common(&context);
    Ok(detected.as_ref().map(local_runtime_summary))
}

#[tauri::command]
async fn set_runtime_source(
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
        let detected = context.manager.detect_local_async().await.ok_or_else(|| {
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
async fn check_for_updates(
    app: AppHandle,
    context: tauri::State<'_, DesktopContext>,
) -> Result<RegistryInfoResponse, String> {
    do_check_for_updates(app, &context).await
}

async fn do_check_for_updates(
    app: AppHandle,
    context: &DesktopContext,
) -> Result<RegistryInfoResponse, String> {
    set_status(
        context,
        &app,
        "checking",
        "正在检查上游版本",
        "只读取 npm registry 的 dist-tags 与版本列表。",
        None,
        None,
    );
    let registry = context.manager.registry_info_async().await?;
    let mut state = context.store.load().map_err(io_error)?;
    if registry.latest != state.pinned {
        state.available = Some(registry.latest.clone());
    } else {
        state.available = None;
    }
    context.store.save(&state).map_err(io_error)?;
    set_versions(context, &registry);
    set_status(
        context,
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

fn current_workspace(context: &DesktopContext) -> Result<PathBuf, String> {
    let state = context.store.load().map_err(io_error)?;
    let workspace = state
        .last_workspace
        .map(PathBuf::from)
        .ok_or_else(|| "尚未选择工作区，请先启动 DSH 并选择一个工作区。".to_string())?;
    if !workspace.is_dir() {
        return Err(format!("工作区不存在或不是目录：{}", workspace.display()));
    }
    Ok(workspace)
}

#[tauri::command]
fn open_workspace_folder(context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    let workspace = current_workspace(&context)?;
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(&workspace)
            .spawn()
            .map_err(|error| format!("打开工作区文件夹失败：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&workspace)
            .spawn()
            .map_err(|error| format!("打开工作区文件夹失败：{error}"))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&workspace)
            .spawn()
            .map_err(|error| format!("打开工作区文件夹失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn open_workspace_terminal(context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    let workspace = current_workspace(&context)?;
    #[cfg(windows)]
    {
        // 不使用 -Command 拼接路径：current_dir 直接设置工作目录，避免路径中的
        // 引号或 PowerShell 元字符被解释，同时保留可交互的独立窗口。
        Command::new("powershell.exe")
            .args(["-NoLogo", "-NoExit"])
            .current_dir(&workspace)
            .spawn()
            .map_err(|error| format!("打开 PowerShell 失败：{error}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal"])
            .current_dir(&workspace)
            .spawn()
            .map_err(|error| format!("打开终端失败：{error}"))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("x-terminal-emulator")
            .current_dir(&workspace)
            .spawn()
            .or_else(|_| Command::new("xterm").current_dir(&workspace).spawn())
            .map_err(|error| format!("打开终端失败：{error}"))?;
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
async fn search_market_plugins(
    context: tauri::State<'_, DesktopContext>,
    query: String,
) -> Result<MarketSearchResult, String> {
    let _guard = match context.market_task_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Err("已有插件操作进行中，请稍后重试。".to_string()),
    };
    let state = context.store.load().map_err(io_error)?;
    let result = context
        .market
        .search(&context.manager, &state, &context.dsh_home, &query)
        .await;
    match &result {
        Ok(value) => add_log(
            &context,
            format!(
                "插件市场搜索 query={:?} runtimeReady={} packageManagerReady={} plugins={} message={:?}",
                value.query,
                value.runtime_ready,
                value.package_manager_ready,
                value.plugins.len(),
                value.message
            ),
        ),
        Err(error) => add_log(&context, format!("插件市场搜索失败：{error}")),
    }
    result
}

#[tauri::command]
async fn install_market_plugin(
    context: tauri::State<'_, DesktopContext>,
    name: String,
    version: String,
) -> Result<MarketOperationResult, String> {
    let _guard = match context.market_task_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Err("已有插件操作进行中，请稍后重试。".to_string()),
    };
    let state = context.store.load().map_err(io_error)?;
    let restart_required = is_dsh_running(&context);
    let mut result = context
        .market
        .install(
            &context.manager,
            &state,
            &context.dsh_home,
            &name,
            &version,
            restart_required,
        )
        .await?;
    if let Err(error) = theme::validate_installed_theme_package(&context.dsh_home, &name) {
        let rollback = context
            .market
            .uninstall(
                &context.manager,
                &state,
                &context.dsh_home,
                &name,
                restart_required,
            )
            .await;
        let detail = rollback
            .err()
            .map(|rollback_error| format!("主题包回滚卸载也失败：{rollback_error}"))
            .unwrap_or_else(|| "已回滚主题包安装。".to_string());
        return Err(format!("主题包安装后校验失败：{error} {detail}"));
    }
    if theme::installed_theme_for_package(&context.dsh_home, &name)
        .map_err(|error| format!("读取主题包状态失败：{error}"))?
        .is_some()
    {
        result.message = if restart_required {
            format!("已安装主题包 {name}@{version}，重启 DSH 后可在设置中预览。")
        } else {
            format!("已安装主题包 {name}@{version}，可在设置中预览。")
        };
    }
    refresh_common(&context);
    Ok(result)
}

#[tauri::command]
async fn uninstall_market_plugin(
    context: tauri::State<'_, DesktopContext>,
    name: String,
) -> Result<MarketOperationResult, String> {
    let _guard = match context.market_task_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Err("已有插件操作进行中，请稍后重试。".to_string()),
    };
    let state = context.store.load().map_err(io_error)?;
    let restart_required = is_dsh_running(&context);
    let state_before = state.clone();
    let preview_before = current_theme_preview(&context);
    let theme_pack = theme::installed_theme_for_package(&context.dsh_home, &name)?;
    let fallback_active = state.skin_id == name
        || preview_before
            .as_ref()
            .is_some_and(|preview| preview.id == name)
        || theme_pack.as_ref().is_some_and(|pack| {
            state.skin_id == pack.id
                || state.skin_id == pack.package_name
                || preview_before
                    .as_ref()
                    .is_some_and(|preview| preview.id == pack.id)
        });
    if fallback_active {
        let mut fallback = state.clone();
        fallback.skin_id = DEFAULT_SKIN_ID.to_string();
        context.store.save(&fallback).map_err(io_error)?;
        cancel_theme_preview_inner(&context);
        refresh_common(&context);
    }

    let result = context
        .market
        .uninstall(
            &context.manager,
            &state,
            &context.dsh_home,
            &name,
            restart_required,
        )
        .await;
    match result {
        Ok(mut result) => {
            if fallback_active {
                result.message = if restart_required {
                    format!("已卸载主题包 {name}，当前主题已回退为默认主题，重启 DSH 后生效。")
                } else {
                    format!("已卸载主题包 {name}，当前主题已回退为默认主题。")
                };
            }
            refresh_common(&context);
            Ok(result)
        }
        Err(error) => {
            if fallback_active {
                let _ = context.store.save(&state_before);
                if let Ok(mut slot) = context.theme_preview.lock() {
                    *slot = preview_before;
                }
                refresh_common(&context);
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn list_mcp_servers(context: tauri::State<'_, DesktopContext>) -> Result<McpConfigResult, String> {
    context.mcp.list()
}

#[tauri::command]
fn save_mcp_server(
    context: tauri::State<'_, DesktopContext>,
    id: String,
    enabled: bool,
    api_key: Option<String>,
    clear_api_key: bool,
) -> Result<McpConfigResult, String> {
    let running = is_dsh_running(&context);
    let (mcp_command, mcp_command_args) = context.manager.mcp_npx_command();
    let api_key_changed = api_key
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || clear_api_key;
    let mut result = context.mcp.save_server(
        &context.dsh_home,
        &mcp_command,
        &mcp_command_args,
        &id,
        enabled,
        api_key,
        clear_api_key,
    )?;
    result.restart_required = running;
    result.message = if running {
        "配置已保存。重启 DSH 后会按当前开关重新注册 MCP 工具。".to_string()
    } else {
        "配置已保存。下次启动 DSH 时会按当前开关注册 MCP 工具。".to_string()
    };
    add_log(
        &context,
        format!("MCP 配置已更新: id={id} enabled={enabled} apiKeyChanged={api_key_changed}"),
    );
    Ok(result)
}

#[tauri::command]
async fn get_mcp_runtime_status(
    context: tauri::State<'_, DesktopContext>,
) -> Result<McpRuntimeResult, String> {
    let url = context.process.lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|process| process.is_running())
            .map(|process| process.url.clone())
    });
    let manager = context.mcp.clone();
    let Some(url) = url else {
        return manager.runtime_status(false, Vec::new(), None);
    };
    tauri::async_runtime::spawn_blocking(move || match fetch_mcp_tool_names(&url) {
        Ok(tools) => manager.runtime_status(true, tools, None),
        Err(error) => manager.runtime_status(true, Vec::new(), Some(error)),
    })
    .await
    .map_err(|error| format!("读取 MCP 运行状态失败：{error}"))?
}

fn fetch_mcp_tool_names(dsh_url: &str) -> Result<Vec<String>, String> {
    let endpoint = format!(
        "{}/dsh-desktop-bridge/mcp-status",
        dsh_url.trim_end_matches('/')
    );
    let response = ureq::get(&endpoint)
        .set("Accept", "application/json")
        .set("User-Agent", "dsh-desktop-mcp-status")
        .timeout(Duration::from_secs(3))
        .call()
        .map_err(|error| format!("状态端点请求失败: {error}"))?;
    let payload = response
        .into_string()
        .map_err(|error| format!("状态端点响应读取失败: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("状态端点响应不是有效 JSON: {error}"))?;
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("状态端点返回失败。".to_string());
    }
    Ok(value
        .get("tools")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|name| name.starts_with("mcp__"))
        .map(str::to_string)
        .collect())
}

#[tauri::command]
fn set_theme(context: tauri::State<'_, DesktopContext>, theme: String) -> Result<(), String> {
    if !matches!(theme.as_str(), THEME_LIGHT | THEME_DARK | THEME_SYSTEM) {
        return Err(format!("不支持的主题模式: {theme}"));
    }
    let mut state = context.store.load().map_err(io_error)?;
    state.appearance_mode = theme;
    context.store.save(&state).map_err(io_error)?;
    refresh_common(&context);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemePreviewResult {
    id: String,
    expires_at: u64,
    seconds: u64,
}

#[tauri::command]
fn list_theme_packs(
    context: tauri::State<'_, DesktopContext>,
) -> Result<Vec<theme::ThemePackSummary>, String> {
    theme::list_theme_packs(&context.dsh_home)
}

#[tauri::command]
fn get_active_theme_pack(
    context: tauri::State<'_, DesktopContext>,
) -> Result<theme::ThemePackSummary, String> {
    let mut state = context.store.load().map_err(io_error)?;
    let preview = current_theme_preview(&context);
    let id = theme::active_skin_id(&state, preview.as_ref().map(|item| item.id.as_str()));
    match theme::get_theme_pack(&context.dsh_home, &id) {
        Ok(pack)
            if pack.id == DEFAULT_SKIN_ID
                || (pack.source == "profile"
                    && pack.installed
                    && pack.enabled
                    && pack.protocol_compatible) =>
        {
            Ok(pack)
        }
        _ => {
            state.skin_id = DEFAULT_SKIN_ID.to_string();
            context.store.save(&state).map_err(io_error)?;
            cancel_theme_preview_inner(&context);
            theme::get_theme_pack(&context.dsh_home, DEFAULT_SKIN_ID)
        }
    }
}

#[tauri::command]
fn preview_theme_pack(
    context: tauri::State<'_, DesktopContext>,
    id: String,
) -> Result<ThemePreviewResult, String> {
    let pack = theme::get_theme_pack(&context.dsh_home, &id)?;
    if pack.id != DEFAULT_SKIN_ID
        && (pack.source != "profile"
            || !pack.installed
            || !pack.protocol_compatible
            || !pack.enabled)
    {
        return Err(pack
            .error
            .unwrap_or_else(|| format!("主题包 {id} 当前不可用。")));
    }
    let state = context.store.load().map_err(io_error)?;
    if state.appearance_mode != THEME_SYSTEM
        && !pack
            .supported_appearances
            .iter()
            .any(|appearance| appearance == &state.appearance_mode)
    {
        return Err(format!(
            "主题 {} 不支持当前 {} 外观模式，请先切换外观模式。",
            pack.display_name, state.appearance_mode
        ));
    }
    let now = now_millis();
    let expires_at = now.saturating_add(15_000);
    let previous_skin_id = context
        .theme_preview
        .lock()
        .map_err(|_| "主题预览锁已损坏。".to_string())?
        .as_ref()
        .map(|item| item.previous_skin_id.clone())
        .unwrap_or_else(|| state.skin_id.clone());
    context
        .theme_preview
        .lock()
        .map_err(|_| "主题预览锁已损坏。".to_string())?
        .replace(ThemePreview {
            id: pack.id.clone(),
            previous_skin_id,
            expires_at,
        });
    refresh_common(&context);
    Ok(ThemePreviewResult {
        id: pack.id,
        expires_at,
        seconds: 15,
    })
}

#[tauri::command]
fn confirm_theme_pack(context: tauri::State<'_, DesktopContext>, id: String) -> Result<(), String> {
    let preview = context
        .theme_preview
        .lock()
        .map_err(|_| "主题预览锁已损坏。".to_string())?
        .clone()
        .ok_or_else(|| "当前没有待确认的主题预览。".to_string())?;
    if preview.expires_at <= now_millis() || preview.id != id {
        cancel_theme_preview_inner(&context);
        return Err("主题预览已过期，请重新预览。".to_string());
    }
    let pack = theme::get_theme_pack(&context.dsh_home, &id)?;
    if pack.id != DEFAULT_SKIN_ID
        && (pack.source != "profile"
            || !pack.installed
            || !pack.enabled
            || !pack.protocol_compatible)
    {
        cancel_theme_preview_inner(&context);
        return Err(format!("主题插件 {} 已不再可用。", pack.display_name));
    }
    let mut state = context.store.load().map_err(io_error)?;
    state.skin_id = id;
    context.store.save(&state).map_err(io_error)?;
    if let Ok(mut slot) = context.theme_preview.lock() {
        *slot = None;
    }
    refresh_common(&context);
    Ok(())
}

#[tauri::command]
fn cancel_theme_preview(context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    cancel_theme_preview_inner(&context);
    refresh_common(&context);
    Ok(())
}

#[tauri::command]
fn reset_theme_pack(context: tauri::State<'_, DesktopContext>) -> Result<(), String> {
    if let Ok(mut slot) = context.theme_preview.lock() {
        *slot = None;
    }
    let mut state = context.store.load().map_err(io_error)?;
    state.skin_id = DEFAULT_SKIN_ID.to_string();
    state.background_intensity = DEFAULT_BACKGROUND_INTENSITY;
    state.reduce_effects = false;
    context.store.save(&state).map_err(io_error)?;
    refresh_common(&context);
    Ok(())
}

#[tauri::command]
fn set_background_preferences(
    context: tauri::State<'_, DesktopContext>,
    intensity: f32,
    reduce_effects: bool,
) -> Result<(), String> {
    if !intensity.is_finite() || !(0.0..=1.0).contains(&intensity) {
        return Err("背景强度必须在 0..1。".to_string());
    }
    let mut state = context.store.load().map_err(io_error)?;
    state.background_intensity = intensity;
    state.reduce_effects = reduce_effects;
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
    // 跳过异常坐标（如 Windows 最小化隐藏位置 -32000），让 tauri.conf 的 center:true 生效
    if bounds.x <= -10000 || bounds.y <= -10000 {
        return;
    }
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
    // 最小化时不保存坐标：Windows 会把窗口移到 -32000 的隐藏位置
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    // 兜底：跳过异常隐藏坐标，避免把最小化位置写进 state.json
    if position.x <= -10000 || position.y <= -10000 {
        return;
    }
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
                let context = app.state::<DesktopContext>().inner().clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = do_check_for_updates(app, &context).await;
                });
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
    let (mcp_command, mcp_command_args) = context.manager.mcp_npx_command();
    context
        .mcp
        .sync_profile(&context.dsh_home, &mcp_command, &mcp_command_args)?;
    let mcp_environment = context.mcp.process_environment()?;
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
                &mcp_environment,
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
        &mcp_environment,
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

fn is_dsh_running(context: &DesktopContext) -> bool {
    context
        .process
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(DshProcess::is_running))
        .unwrap_or(false)
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
    let preview = current_theme_preview(context);
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
    let active_skin_id =
        theme::active_skin_id(&state, preview.as_ref().map(|item| item.id.as_str()));
    if let Ok(mut status) = context.status.lock() {
        status.web_url = web_url;
        status.pinned = state.pinned;
        status.last_good = state.last_good;
        status.available = state.available;
        status.workspace = state.last_workspace;
        status.runtime_source = state.runtime_source;
        status.appearance_mode = state.appearance_mode.clone();
        status.skin_id = active_skin_id;
        status.background_intensity = state.background_intensity;
        status.reduce_effects = state.reduce_effects;
        status.theme_preview_until = preview.as_ref().map(|item| item.expires_at);
        status.local_runtime = local_runtime;
        status.versions = versions;
        status.logs = logs;
    }
}

fn current_theme_preview(context: &DesktopContext) -> Option<ThemePreview> {
    let now = now_millis();
    let mut preview = context.theme_preview.lock().ok()?;
    if preview.as_ref().is_some_and(|item| item.expires_at <= now) {
        *preview = None;
    }
    preview.clone()
}

fn cancel_theme_preview_inner(context: &DesktopContext) {
    if let Ok(mut preview) = context.theme_preview.lock() {
        *preview = None;
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
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
