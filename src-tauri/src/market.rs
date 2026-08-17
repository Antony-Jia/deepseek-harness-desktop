use crate::{
    runtime::{LocalRuntime, RuntimeManager},
    state::PersistedState,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

pub const MARKET_SCOPE: &str = "@p-dsh-market/";
pub const PINNED_PNPM_VERSION: &str = "10.12.4";

const MAX_QUERY_LENGTH: usize = 120;
const MAX_PACKAGE_NAME_LENGTH: usize = 128;
const MAX_VERSION_LENGTH: usize = 128;
const MAX_CAPTURE_BYTES: usize = 512 * 1024;
const MAX_LOG_BYTES: usize = 16 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub installed: bool,
    pub installed_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSearchResult {
    pub query: String,
    pub plugins: Vec<MarketPlugin>,
    pub runtime_ready: bool,
    pub package_manager_ready: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketOperationResult {
    pub ok: bool,
    pub operation: String,
    pub name: String,
    pub version: Option<String>,
    pub message: String,
    pub log: String,
    pub restart_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketSearchCandidate {
    pub name: String,
    pub version: Option<String>,
    pub description: String,
}

#[derive(Debug, Clone)]
struct PnpmTool {
    executable: PathBuf,
    bin_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct RuntimeCommand {
    program: PathBuf,
    prefix: Vec<String>,
    version: String,
}

#[derive(Debug)]
struct CommandResult {
    code: Option<i32>,
    timed_out: bool,
    stdout: String,
    stderr: String,
    log: String,
}

pub struct MarketManager {
    tools_dir: PathBuf,
    pnpm_lock: Mutex<()>,
}

impl MarketManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            tools_dir: base_dir.join("tools"),
            pnpm_lock: Mutex::new(()),
        }
    }

    pub fn search(
        &self,
        runtime: &RuntimeManager,
        state: &PersistedState,
        dsh_home: &Path,
        query: &str,
    ) -> Result<MarketSearchResult, String> {
        let query = normalize_query(query)?;
        let selected = match select_runtime(runtime, state) {
            Ok(selected) => selected,
            Err(message) => {
                return Ok(MarketSearchResult {
                    query,
                    plugins: Vec::new(),
                    runtime_ready: false,
                    package_manager_ready: false,
                    message,
                })
            }
        };
        let pnpm = match self.prepare_pnpm(runtime) {
            Ok(pnpm) => pnpm,
            Err(error) => {
                return Ok(MarketSearchResult {
                    query,
                    plugins: Vec::new(),
                    runtime_ready: true,
                    package_manager_ready: false,
                    message: format!("私有 pnpm 准备失败：{error}"),
                })
            }
        };

        let search_term = if query.is_empty() {
            MARKET_SCOPE.to_string()
        } else {
            query.clone()
        };
        let search_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &[
                "search".to_string(),
                search_term,
                "--json".to_string(),
                "--search-limit".to_string(),
                "50".to_string(),
            ],
        )?;
        ensure_command_success("插件搜索", &search_result)?;
        let candidates = parse_search_json(&combined_output(&search_result))?;

        let mut plugins = BTreeMap::new();
        let mut rejected = 0_usize;
        for candidate in candidates.into_iter().take(50) {
            if validate_market_package_name(&candidate.name).is_err() {
                continue;
            }
            let view_result = self.run_dsh(
                &selected,
                &pnpm,
                dsh_home,
                &[
                    "view".to_string(),
                    candidate.name.clone(),
                    "--json".to_string(),
                ],
            )?;
            if !view_result_success(&view_result) {
                rejected += 1;
                continue;
            }
            let manifest = match parse_manifest(&combined_output(&view_result))
                .and_then(|value| validate_market_manifest(&candidate.name, &value))
            {
                Ok(manifest) => manifest,
                Err(_) => {
                    rejected += 1;
                    continue;
                }
            };
            let plugin = MarketPlugin {
                name: manifest.name.clone(),
                display_name: manifest.display_name,
                version: manifest.version,
                description: if manifest.description.is_empty() {
                    candidate.description
                } else {
                    manifest.description
                },
                capabilities: manifest.capabilities,
                installed: false,
                installed_version: None,
            };
            plugins.insert(plugin.name.clone(), plugin);
        }

        let list_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &[
                "list".to_string(),
                "--depth".to_string(),
                "0".to_string(),
                "--json".to_string(),
            ],
        )?;
        ensure_command_success("读取已安装插件", &list_result)?;
        let installed = parse_installed_json(&combined_output(&list_result));
        for plugin in plugins.values_mut() {
            if let Some(version) = installed.get(&plugin.name) {
                plugin.installed = true;
                plugin.installed_version = Some(version.clone());
            }
        }

        let message = if plugins.is_empty() {
            if rejected > 0 {
                format!("没有找到符合市场协议的插件，已过滤 {rejected} 个候选包。")
            } else {
                "没有找到符合条件的插件。".to_string()
            }
        } else if rejected > 0 {
            format!("已过滤 {rejected} 个不符合市场协议的候选包。")
        } else {
            String::new()
        };
        Ok(MarketSearchResult {
            query,
            plugins: plugins.into_values().collect(),
            runtime_ready: true,
            package_manager_ready: true,
            message,
        })
    }

    pub fn install(
        &self,
        runtime: &RuntimeManager,
        state: &PersistedState,
        dsh_home: &Path,
        name: &str,
        version: &str,
        restart_required: bool,
    ) -> Result<MarketOperationResult, String> {
        validate_market_package_name(name)?;
        validate_market_version(version)?;
        let selected = select_runtime(runtime, state)?;
        let pnpm = self.prepare_pnpm(runtime)?;
        let target = format!("{name}@{version}");

        let view_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &["view".to_string(), target.clone(), "--json".to_string()],
        )?;
        ensure_command_success("校验插件清单", &view_result)?;
        let manifest = parse_manifest(&combined_output(&view_result))
            .and_then(|value| validate_market_manifest(name, &value))?;
        if manifest.version != version {
            return Err(format!(
                "远端插件版本已变化：请求 {version}，清单返回 {}。请重新搜索。",
                manifest.version
            ));
        }

        let list_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &[
                "list".to_string(),
                "--depth".to_string(),
                "0".to_string(),
                "--json".to_string(),
            ],
        )?;
        ensure_command_success("读取已安装插件", &list_result)?;
        if let Some(installed) = parse_installed_json(&combined_output(&list_result)).get(name) {
            return Err(format!("插件 {name} 已安装，当前版本为 {installed}。"));
        }

        let add_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &["add".to_string(), target].to_vec(),
        )?;
        ensure_command_success("安装插件", &add_result)?;
        let after_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &[
                "list".to_string(),
                "--depth".to_string(),
                "0".to_string(),
                "--json".to_string(),
            ],
        )?;
        ensure_command_success("复核已安装插件", &after_result)?;
        let installed_version = parse_installed_json(&combined_output(&after_result))
            .get(name)
            .cloned();
        if installed_version.as_deref() != Some(version) {
            return Err(format!(
                "插件安装命令已完成，但 profile 中没有确认到 {name}@{version}。"
            ));
        }

        Ok(MarketOperationResult {
            ok: true,
            operation: "install".to_string(),
            name: name.to_string(),
            version: Some(version.to_string()),
            message: if restart_required {
                format!("已安装 {name}@{version}，重启 DSH 后生效。")
            } else {
                format!("已安装 {name}@{version}，将在下次启动 DSH 时生效。")
            },
            log: add_result.log,
            restart_required,
        })
    }

    pub fn uninstall(
        &self,
        runtime: &RuntimeManager,
        state: &PersistedState,
        dsh_home: &Path,
        name: &str,
        restart_required: bool,
    ) -> Result<MarketOperationResult, String> {
        validate_market_package_name(name)?;
        let selected = select_runtime(runtime, state)?;
        let pnpm = self.prepare_pnpm(runtime)?;
        let list_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &[
                "list".to_string(),
                "--depth".to_string(),
                "0".to_string(),
                "--json".to_string(),
            ],
        )?;
        ensure_command_success("读取已安装插件", &list_result)?;
        if !parse_installed_json(&combined_output(&list_result)).contains_key(name) {
            return Err(format!("插件 {name} 当前未安装，无法卸载。"));
        }

        let remove_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &["remove".to_string(), name.to_string()],
        )?;
        ensure_command_success("卸载插件", &remove_result)?;
        let after_result = self.run_dsh(
            &selected,
            &pnpm,
            dsh_home,
            &[
                "list".to_string(),
                "--depth".to_string(),
                "0".to_string(),
                "--json".to_string(),
            ],
        )?;
        ensure_command_success("复核已卸载插件", &after_result)?;
        if parse_installed_json(&combined_output(&after_result)).contains_key(name) {
            return Err(format!("卸载命令已完成，但 profile 中仍然存在 {name}。"));
        }

        Ok(MarketOperationResult {
            ok: true,
            operation: "uninstall".to_string(),
            name: name.to_string(),
            version: None,
            message: if restart_required {
                format!("已卸载 {name}，重启 DSH 后生效。")
            } else {
                format!("已卸载 {name}，将在下次启动 DSH 时生效。")
            },
            log: remove_result.log,
            restart_required,
        })
    }

    fn prepare_pnpm(&self, runtime: &RuntimeManager) -> Result<PnpmTool, String> {
        let _guard = match self.pnpm_lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        fs::create_dir_all(&self.tools_dir)
            .map_err(|error| format!("创建私有 pnpm 目录失败: {error}"))?;
        let bin_dir = self.tools_dir.join("node_modules").join(".bin");
        let executable = bin_dir.join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" });
        if pnpm_version_matches(&executable, &self.tools_dir) {
            return Ok(PnpmTool {
                executable,
                bin_dir,
            });
        }

        let package_json = self.tools_dir.join("package.json");
        if !package_json.exists() {
            let manifest = serde_json::json!({
                "name": "dsh-desktop-tools",
                "private": true,
                "dependencies": { "pnpm": PINNED_PNPM_VERSION }
            });
            fs::write(
                &package_json,
                serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
            )
            .map_err(|error| format!("写入私有 pnpm package.json 失败: {error}"))?;
        }

        let (program, npm_cli) = runtime.npm_command();
        let mut args = Vec::new();
        if let Some(cli) = npm_cli {
            args.push(cli.to_string_lossy().to_string());
        }
        args.extend([
            "install".to_string(),
            "--prefix".to_string(),
            self.tools_dir.to_string_lossy().to_string(),
            "--no-save".to_string(),
            "--package-lock=false".to_string(),
            "--ignore-scripts".to_string(),
            "--no-audit".to_string(),
            "--no-fund".to_string(),
            format!("pnpm@{PINNED_PNPM_VERSION}"),
        ]);
        let result = run_command(&program, &args, &self.tools_dir, &self.tools_dir, None)
            .map_err(|error| format!("无法准备私有 pnpm: {error}"))?;
        ensure_command_success("安装私有 pnpm", &result)?;
        if !pnpm_version_matches(&executable, &self.tools_dir) {
            return Err(format!(
                "私有 pnpm 已安装，但版本不是固定版本 {PINNED_PNPM_VERSION}。"
            ));
        }
        Ok(PnpmTool {
            executable,
            bin_dir,
        })
    }

    fn run_dsh(
        &self,
        selected: &RuntimeCommand,
        pnpm: &PnpmTool,
        dsh_home: &Path,
        operation: &[String],
    ) -> Result<CommandResult, String> {
        let mut args = selected.prefix.clone();
        args.extend([
            "plugin".to_string(),
            "--profile".to_string(),
            "web".to_string(),
        ]);
        args.extend(operation.iter().cloned());
        let workdir = profile_workdir(dsh_home)?;
        let _ = &pnpm.executable;
        run_command(
            &selected.program,
            &args,
            &workdir,
            dsh_home,
            Some(&pnpm.bin_dir),
        )
        .map_err(|error| {
            format!(
                "执行 DSH 插件命令失败（运行时 {}）: {error}",
                selected.version
            )
        })
    }
}

fn select_runtime(
    runtime: &RuntimeManager,
    state: &PersistedState,
) -> Result<RuntimeCommand, String> {
    if state.runtime_source == crate::state::RUNTIME_SOURCE_LOCAL {
        let local = runtime
            .detect_local()
            .ok_or_else(|| "当前选择的本地 DSH 运行时不可用，市场已保持只读。".to_string())?;
        return Ok(local_runtime_command(local));
    }
    if !runtime.is_ready(&state.pinned) {
        return Err(format!(
            "桌面托管 DSH@{} 尚未准备好，请先安装运行时。",
            state.pinned
        ));
    }
    let bin = runtime.dsh_bin(&state.pinned)?;
    Ok(RuntimeCommand {
        program: runtime.node_command(),
        prefix: vec![bin.to_string_lossy().to_string()],
        version: state.pinned.clone(),
    })
}

fn local_runtime_command(local: LocalRuntime) -> RuntimeCommand {
    RuntimeCommand {
        program: local.command,
        prefix: vec!["--no-install".to_string(), "@deepseek-ai/dsh".to_string()],
        version: local.version,
    }
}

fn profile_workdir(dsh_home: &Path) -> Result<PathBuf, String> {
    let profile = dsh_home.join("profiles").join("web");
    if profile.is_dir() {
        return Ok(profile);
    }
    fs::create_dir_all(&profile)
        .map_err(|error| format!("创建 web profile 工作目录失败: {error}"))?;
    Ok(profile)
}

fn pnpm_version_matches(executable: &Path, cwd: &Path) -> bool {
    if !executable.is_file() {
        return false;
    }
    let Ok(result) = run_command(executable, &["--version".to_string()], cwd, cwd, None) else {
        return false;
    };
    result.code == Some(0)
        && first_version(&combined_output(&result)).as_deref() == Some(PINNED_PNPM_VERSION)
}

fn run_command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    dsh_home: &Path,
    prepend_path: Option<&Path>,
) -> Result<CommandResult, String> {
    let mut command = Command::new(program);
    hide_console_window(&mut command);
    command
        .args(args)
        .current_dir(cwd)
        .env("DSH_HOME", dsh_home)
        .env("npm_config_update_notifier", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_audit", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(prepend_path) = prepend_path {
        let mut paths = vec![prepend_path.to_path_buf()];
        if let Some(existing) = env::var_os("PATH") {
            paths.extend(env::split_paths(&existing));
        }
        let joined =
            env::join_paths(paths).map_err(|error| format!("构造子进程 PATH 失败: {error}"))?;
        command.env("PATH", joined);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败: {error}", program.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel::<(bool, Vec<u8>)>();
    if let Some(stdout) = stdout {
        spawn_pipe_reader(stdout, tx.clone(), true);
    }
    if let Some(stderr) = stderr {
        spawn_pipe_reader(stderr, tx.clone(), false);
    }
    drop(tx);

    let deadline = Instant::now() + COMMAND_TIMEOUT;
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut status = None;
    let mut timed_out = false;
    loop {
        drain_output(&rx, &mut stdout_bytes, &mut stderr_bytes);
        match child.try_wait() {
            Ok(Some(exit)) => {
                status = exit.code();
                break;
            }
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("读取子进程状态失败: {error}"));
            }
        }
    }
    for _ in 0..20 {
        drain_output(&rx, &mut stdout_bytes, &mut stderr_bytes);
        thread::sleep(Duration::from_millis(10));
    }
    drain_output(&rx, &mut stdout_bytes, &mut stderr_bytes);

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
    let mut log = sanitize_log(&format!("{stdout}\n{stderr}"));
    if timed_out {
        log = format!("命令执行超时（{} 秒）。\n{log}", COMMAND_TIMEOUT.as_secs());
    }
    Ok(CommandResult {
        code: status,
        timed_out,
        stdout,
        stderr,
        log: truncate_log(&log),
    })
}

fn spawn_pipe_reader<R>(mut reader: R, tx: mpsc::Sender<(bool, Vec<u8>)>, stdout: bool)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        let _ = tx.send((stdout, bytes));
    });
}

fn drain_output(rx: &mpsc::Receiver<(bool, Vec<u8>)>, stdout: &mut Vec<u8>, stderr: &mut Vec<u8>) {
    while let Ok((is_stdout, bytes)) = rx.try_recv() {
        if is_stdout {
            append_capture(stdout, &bytes);
        } else {
            append_capture(stderr, &bytes);
        }
    }
}

fn append_capture(target: &mut Vec<u8>, bytes: &[u8]) {
    target.extend_from_slice(bytes);
    if target.len() > MAX_CAPTURE_BYTES {
        let keep_head = MAX_CAPTURE_BYTES / 2;
        let tail = target.len() - (MAX_CAPTURE_BYTES - keep_head);
        let mut compact = target[..keep_head].to_vec();
        compact.extend_from_slice(&target[tail..]);
        *target = compact;
    }
}

fn view_result_success(result: &CommandResult) -> bool {
    !result.timed_out && result.code == Some(0)
}

fn ensure_command_success(label: &str, result: &CommandResult) -> Result<(), String> {
    if view_result_success(result) {
        return Ok(());
    }
    let code = result
        .code
        .map(|value| value.to_string())
        .unwrap_or_else(|| "未知".to_string());
    Err(format!("{label}失败，退出码 {code}。\n{}", result.log))
}

fn combined_output(result: &CommandResult) -> String {
    if result.stderr.trim().is_empty() {
        result.stdout.clone()
    } else {
        format!("{}\n{}", result.stdout, result.stderr)
    }
}

pub fn normalize_query(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.chars().count() > MAX_QUERY_LENGTH {
        return Err(format!("插件搜索词不能超过 {MAX_QUERY_LENGTH} 个字符。"));
    }
    if query
        .chars()
        .any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err("插件搜索词不能包含换行或控制字符。".to_string());
    }
    Ok(query.to_string())
}

pub fn validate_market_package_name(name: &str) -> Result<(), String> {
    let Some(suffix) = name.strip_prefix(MARKET_SCOPE) else {
        return Err(format!("插件必须属于 {MARKET_SCOPE} scope。"));
    };
    if name.chars().count() > MAX_PACKAGE_NAME_LENGTH
        || suffix.is_empty()
        || !suffix
            .chars()
            .next()
            .map(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
            .unwrap_or(false)
        || suffix.chars().any(|ch| {
            !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
        })
    {
        return Err(format!("非法市场插件包名: {name}"));
    }
    Ok(())
}

pub fn validate_market_version(version: &str) -> Result<(), String> {
    if version.is_empty()
        || version.chars().count() > MAX_VERSION_LENGTH
        || version
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+' | '_')))
    {
        return Err(format!("非法插件版本: {version}"));
    }
    Ok(())
}

pub fn parse_search_json(raw: &str) -> Result<Vec<MarketSearchCandidate>, String> {
    let mut line_values = Vec::new();
    for line in raw.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            if value.is_array() {
                line_values.extend(search_values(&value).into_iter().cloned());
            } else if value.is_object() {
                line_values.push(value);
            }
        }
    }
    if !line_values.is_empty() {
        return Ok(line_values
            .iter()
            .filter_map(candidate_from_value)
            .collect());
    }
    let value = parse_json_value(raw).map_err(|error| format!("插件搜索 JSON 无效: {error}"))?;
    let values = search_values(&value);
    Ok(values
        .into_iter()
        .filter_map(candidate_from_value)
        .collect())
}

pub fn validate_market_manifest(
    expected_name: &str,
    manifest: &Value,
) -> Result<MarketManifestPublic, String> {
    validate_market_package_name(expected_name)?;
    let actual_name =
        string_field(manifest, "name").ok_or_else(|| "清单缺少 name。".to_string())?;
    if actual_name != expected_name {
        return Err(format!("清单 name 与请求不一致：{actual_name}"));
    }
    let version =
        string_field(manifest, "version").ok_or_else(|| "清单缺少 version。".to_string())?;
    validate_market_version(&version)?;
    if !string_field(manifest, "main")
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        return Err("清单 main 必须是非空字符串。".to_string());
    }
    let client_export = manifest
        .get("exports")
        .and_then(Value::as_object)
        .and_then(|exports| exports.get("./client"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if client_export.is_none() {
        return Err("清单 exports[\"./client\"] 缺失。".to_string());
    }
    let dsh = manifest
        .get("dsh")
        .and_then(Value::as_object)
        .ok_or_else(|| "清单缺少 dsh 字段。".to_string())?;
    let platform = dsh
        .get("client")
        .and_then(Value::as_object)
        .and_then(|client| client.get("platform"))
        .and_then(Value::as_str);
    if platform != Some("web") {
        return Err("dsh.client.platform 必须为 web。".to_string());
    }
    let patch = dsh
        .get("bundle")
        .and_then(Value::as_object)
        .and_then(|bundle| bundle.get("patch"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if patch.is_none() {
        return Err("dsh.bundle.patch 必须是非空字符串。".to_string());
    }
    let market = dsh
        .get("market")
        .and_then(Value::as_object)
        .ok_or_else(|| "清单缺少 dsh.market 字段。".to_string())?;
    let display_name = market
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "dsh.market.displayName 必须是非空字符串。".to_string())?;
    let capabilities = market
        .get("capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| "dsh.market.capabilities 必须是字符串数组。".to_string())?;
    let capabilities = capabilities
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "dsh.market.capabilities 必须只包含字符串。".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    for required in ["skills", "host", "client"] {
        if !capabilities.iter().any(|item| item == required) {
            return Err(format!("dsh.market.capabilities 缺少 {required}。"));
        }
    }
    Ok(MarketManifestPublic {
        name: actual_name,
        version,
        display_name: display_name.to_string(),
        description: string_field(manifest, "description").unwrap_or_default(),
        capabilities,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketManifestPublic {
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub capabilities: Vec<String>,
}

pub fn parse_installed_json(raw: &str) -> BTreeMap<String, String> {
    let Ok(value) = parse_json_value(raw) else {
        return BTreeMap::new();
    };
    let mut installed = BTreeMap::new();
    collect_installed(&value, &mut installed, None);
    installed
}

fn parse_json_value(raw: &str) -> Result<Value, serde_json::Error> {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }
    for line in trimmed.lines().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            return Ok(value);
        }
    }
    for (index, ch) in trimmed.char_indices() {
        if !matches!(ch, '[' | '{') {
            continue;
        }
        let mut stream = serde_json::Deserializer::from_str(&trimmed[index..]).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next() {
            return Ok(value);
        }
    }
    serde_json::from_str(trimmed)
}

fn search_values(value: &Value) -> Vec<&Value> {
    if let Some(items) = value.as_array() {
        return items.iter().collect();
    }
    if let Some(object) = value.as_object() {
        for key in ["objects", "packages", "results", "items"] {
            if let Some(items) = object.get(key).and_then(Value::as_array) {
                return items.iter().collect();
            }
        }
    }
    vec![value]
}

fn candidate_from_value(value: &Value) -> Option<MarketSearchCandidate> {
    let object = value.as_object()?;
    let nested = object.get("package").and_then(Value::as_object);
    let source = nested.unwrap_or(object);
    let name = source.get("name").and_then(Value::as_str)?.to_string();
    let version = source
        .get("version")
        .or_else(|| source.get("latest"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = source
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(MarketSearchCandidate {
        name,
        version,
        description,
    })
}

fn parse_manifest(raw: &str) -> Result<Value, String> {
    let value = parse_json_value(raw).map_err(|error| format!("插件清单 JSON 无效: {error}"))?;
    if let Some(items) = value.as_array() {
        items
            .first()
            .cloned()
            .ok_or_else(|| "插件清单为空。".to_string())
    } else {
        Ok(value)
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn collect_installed(
    value: &Value,
    installed: &mut BTreeMap<String, String>,
    hinted_name: Option<&str>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_installed(item, installed, hinted_name);
            }
        }
        Value::Object(object) => {
            let own_name = object.get("name").and_then(Value::as_str).or(hinted_name);
            if let (Some(name), Some(version)) =
                (own_name, object.get("version").and_then(Value::as_str))
            {
                if validate_market_package_name(name).is_ok() {
                    installed.insert(name.to_string(), version.to_string());
                }
            }
            for key in ["dependencies", "devDependencies", "optionalDependencies"] {
                if let Some(dependencies) = object.get(key).and_then(Value::as_object) {
                    for (name, dependency) in dependencies {
                        if validate_market_package_name(name).is_ok() {
                            let version = dependency
                                .get("version")
                                .and_then(Value::as_str)
                                .or_else(|| dependency.as_str());
                            if let Some(version) = version {
                                installed.insert(name.clone(), version.to_string());
                            }
                        }
                        collect_installed(dependency, installed, Some(name));
                    }
                }
            }
            for key in ["packages", "results", "objects", "items"] {
                if let Some(value) = object.get(key) {
                    collect_installed(value, installed, None);
                }
            }
        }
        _ => {}
    }
}

fn first_version(value: &str) -> Option<String> {
    value
        .split_whitespace()
        .map(|part| {
            part.trim_matches(|ch: char| {
                !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-' && ch != '+' && ch != '_'
            })
        })
        .find(|part| {
            !part.is_empty()
                && part.chars().next().is_some_and(|ch| ch.is_ascii_digit())
                && validate_market_version(part).is_ok()
        })
        .map(str::to_string)
}

fn sanitize_log(raw: &str) -> String {
    raw.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("token")
                || lower.contains("password")
                || lower.contains("authorization")
                || lower.contains("_auth")
                || lower.contains("npmrc")
            {
                "[日志已脱敏]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_log(log: &str) -> String {
    if log.len() <= MAX_LOG_BYTES {
        return log.to_string();
    }
    let tail_start = log.len() - (MAX_LOG_BYTES - 80);
    format!("[日志过长，已截断]\n{}", &log[tail_start..])
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn valid_manifest(name: &str) -> Value {
        serde_json::json!({
            "name": name,
            "version": "1.2.3",
            "description": "测试插件",
            "main": "lib/index.js",
            "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
            "dsh": {
                "client": { "platform": "web" },
                "bundle": { "patch": "./cordis.patch.yml" },
                "market": { "displayName": "测试插件", "capabilities": ["skills", "host", "client"] }
            }
        })
    }

    #[test]
    fn accepts_only_market_scope_names() {
        assert!(validate_market_package_name("@p-dsh-market/example").is_ok());
        assert!(validate_market_package_name("@p-dsh-market/a.b-c_1").is_ok());
        for invalid in [
            "example",
            "@other/example",
            "@p-dsh-market/Example",
            "@p-dsh-market/../escape",
            "@p-dsh-market/a/b",
            "@p-dsh-market/",
        ] {
            assert!(validate_market_package_name(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn parses_search_array_and_ignores_malformed_entries_later() {
        let parsed = parse_search_json(
            r#"[{"name":"@p-dsh-market/example","version":"1.0.0","description":"ok"},{"name":3},"bad"]"#,
        )
        .expect("search JSON should parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "@p-dsh-market/example");
    }

    #[test]
    fn parses_newline_delimited_json_and_json_with_trailing_logs() {
        let parsed = parse_search_json(
            "{\"name\":\"@p-dsh-market/one\",\"version\":\"1.0.0\"}\n{\"name\":\"@p-dsh-market/two\",\"version\":\"2.0.0\"}\n",
        )
        .expect("NDJSON should parse");
        assert_eq!(parsed.len(), 2);
        let manifest = parse_manifest(
            "{\"name\":\"@p-dsh-market/example\",\"version\":\"1.2.3\"}\nwarning: done",
        )
        .expect("JSON before a warning should parse");
        assert_eq!(manifest["version"], "1.2.3");
    }

    #[test]
    fn validates_the_full_market_manifest_contract() {
        let manifest = valid_manifest("@p-dsh-market/example");
        let result = validate_market_manifest("@p-dsh-market/example", &manifest)
            .expect("manifest should be accepted");
        assert_eq!(result.display_name, "测试插件");
        assert_eq!(result.capabilities.len(), 3);

        let mut broken = manifest;
        broken["dsh"]["market"]["capabilities"] = serde_json::json!(["host", "client"]);
        assert!(validate_market_manifest("@p-dsh-market/example", &broken).is_err());
    }

    #[test]
    fn parses_pnpm_installed_dependency_shapes() {
        let installed = parse_installed_json(
            r#"[{"name":"web","dependencies":{"@p-dsh-market/example":{"version":"1.2.3"},"@p-dsh-market/other":"2.0.0"}}]"#,
        );
        assert_eq!(
            installed.get("@p-dsh-market/example"),
            Some(&"1.2.3".to_string())
        );
        assert_eq!(
            installed.get("@p-dsh-market/other"),
            Some(&"2.0.0".to_string())
        );
    }

    #[test]
    fn constructs_managed_and_local_plugin_argv_without_shell_text() {
        let managed = RuntimeCommand {
            program: PathBuf::from("node.exe"),
            prefix: vec![PathBuf::from("C:\\runtime dir\\bin.js")
                .to_string_lossy()
                .to_string()],
            version: "1.0.0".to_string(),
        };
        let mut managed_args = managed.prefix.clone();
        managed_args.extend(
            [
                "plugin",
                "--profile",
                "web",
                "add",
                "@p-dsh-market/example@1.0.0",
            ]
            .map(str::to_string),
        );
        assert_eq!(managed_args[1..3], ["plugin", "--profile"]);
        assert!(!managed_args
            .iter()
            .any(|item| item == "cmd" || item == "/c"));

        let local = local_runtime_command(LocalRuntime {
            version: "1.0.0".to_string(),
            command: PathBuf::from("npx.cmd"),
        });
        assert_eq!(local.prefix, vec!["--no-install", "@deepseek-ai/dsh"]);
    }

    #[test]
    fn truncates_and_redacts_sensitive_logs() {
        let sanitized = sanitize_log("password=secret\nnormal output");
        assert!(!sanitized.contains("secret"));
        assert!(sanitized.contains("normal output"));
        assert!(truncate_log(&"x".repeat(MAX_LOG_BYTES + 100)).starts_with("[日志过长"));
    }
}
