use crate::{
    runtime::{LocalRuntime, RuntimeManager},
    state::PersistedState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MARKET_SCOPE: &str = "@p-dsh-market/";
pub const PINNED_PNPM_VERSION: &str = "10.12.4";

const MARKET_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/Antony-Jia/deepseek-harness-desktop/main/market/catalog-v1.json";
const EMBEDDED_MARKET_CATALOG: &str = include_str!("../../market/catalog-v1.json");
const MAX_QUERY_LENGTH: usize = 120;
const MAX_PACKAGE_NAME_LENGTH: usize = 128;
const MAX_VERSION_LENGTH: usize = 128;
const MAX_CATALOG_BYTES: usize = 128 * 1024;
const MAX_CATALOG_PACKAGES: usize = 50;
const MAX_CAPTURE_BYTES: usize = 512 * 1024;
const MAX_LOG_BYTES: usize = 16 * 1024;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(10);
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

pub const DESKTOP_PROTOCOL_VERSION: u32 = 1;
pub const DESKTOP_TITLEBAR_WORKSPACE_ACTIONS: &str = "desktop.titlebar.workspaceActions";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContributionsResult {
    pub protocol_version: u32,
    pub contributions: Vec<DesktopContribution>,
    pub runtime_ready: bool,
    pub dsh_running: bool,
    pub workspace_selected: bool,
    pub message: String,
}

impl DesktopContributionsResult {
    pub fn unavailable(
        message: impl Into<String>,
        dsh_running: bool,
        workspace_selected: bool,
    ) -> Self {
        Self {
            protocol_version: DESKTOP_PROTOCOL_VERSION,
            contributions: Vec::new(),
            runtime_ready: false,
            dsh_running,
            workspace_selected,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContribution {
    pub package_name: String,
    pub version: String,
    pub display_name: String,
    pub actions: Vec<DesktopTitlebarAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTitlebarAction {
    pub id: String,
    pub slot: String,
    pub label: String,
    pub icon: Option<String>,
    pub order: i32,
    pub when: Vec<String>,
    pub action: DesktopAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DesktopAction {
    Native { command: String },
    PluginRpc { method: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketSearchCandidate {
    pub name: String,
    pub version: Option<String>,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarketCatalog {
    schema_version: u32,
    packages: Vec<String>,
}

#[derive(Debug)]
struct LoadedMarketCatalog {
    packages: Vec<String>,
    source: &'static str,
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
    logs_dir: PathBuf,
    catalog_cache: PathBuf,
    pnpm_lock: Mutex<()>,
}

impl MarketManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            tools_dir: base_dir.join("tools"),
            logs_dir: base_dir.join("logs"),
            catalog_cache: base_dir.join("market-catalog-v1.json"),
            pnpm_lock: Mutex::new(()),
        }
    }

    fn debug_log(&self, message: impl AsRef<str>) {
        let _ = fs::create_dir_all(&self.logs_dir);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        let line = format!("[{timestamp}] {}\n", sanitize_log(message.as_ref()));
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.logs_dir.join("market.log"))
        {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn load_catalog(&self) -> Result<LoadedMarketCatalog, String> {
        match fetch_market_catalog() {
            Ok(raw) => match parse_market_catalog(&raw) {
                Ok(packages) => {
                    if let Some(parent) = self.catalog_cache.parent() {
                        if let Err(error) = fs::create_dir_all(parent) {
                            self.debug_log(format!("catalog cache directory failed: {error}"));
                        } else if let Err(error) = fs::write(&self.catalog_cache, raw) {
                            self.debug_log(format!("catalog cache write failed: {error}"));
                        }
                    }
                    return Ok(LoadedMarketCatalog {
                        packages,
                        source: "remote",
                    });
                }
                Err(error) => self.debug_log(format!("remote catalog rejected: {error}")),
            },
            Err(error) => self.debug_log(format!("remote catalog unavailable: {error}")),
        }

        if let Ok(raw) = fs::read_to_string(&self.catalog_cache) {
            match parse_market_catalog(&raw) {
                Ok(packages) => {
                    return Ok(LoadedMarketCatalog {
                        packages,
                        source: "cache",
                    })
                }
                Err(error) => self.debug_log(format!("cached catalog rejected: {error}")),
            }
        }

        Ok(LoadedMarketCatalog {
            packages: parse_market_catalog(EMBEDDED_MARKET_CATALOG)?,
            source: "embedded",
        })
    }

    pub async fn search(
        &self,
        runtime: &RuntimeManager,
        state: &PersistedState,
        dsh_home: &Path,
        query: &str,
    ) -> Result<MarketSearchResult, String> {
        let query = normalize_query(query)?;
        let managed_path = runtime
            .runtime_path(&state.pinned)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| "<非法版本路径>".to_string());
        self.debug_log(format!(
            "search start query={query:?} source={} pinned={} managed_path={} managed_ready={} dsh_home={}",
            state.runtime_source,
            state.pinned,
            managed_path,
            runtime.is_ready(&state.pinned),
            dsh_home.display()
        ));
        let selected = match select_runtime(runtime, state).await {
            Ok(selected) => {
                self.debug_log(format!(
                    "runtime selected version={} program={} prefix={:?}",
                    selected.version,
                    selected.program.display(),
                    selected.prefix
                ));
                selected
            }
            Err(message) => {
                self.debug_log(format!("runtime unavailable: {message}"));
                return Ok(MarketSearchResult {
                    query,
                    plugins: Vec::new(),
                    runtime_ready: false,
                    package_manager_ready: false,
                    message,
                });
            }
        };
        let pnpm = match self.prepare_pnpm(runtime) {
            Ok(pnpm) => {
                self.debug_log(format!(
                    "pnpm ready executable={} bin_dir={}",
                    pnpm.executable.display(),
                    pnpm.bin_dir.display()
                ));
                pnpm
            }
            Err(error) => {
                self.debug_log(format!("pnpm prepare failed: {error}"));
                return Ok(MarketSearchResult {
                    query,
                    plugins: Vec::new(),
                    runtime_ready: true,
                    package_manager_ready: false,
                    message: format!("私有 pnpm 准备失败：{error}"),
                });
            }
        };

        let catalog = self.load_catalog()?;
        let catalog_source = catalog.source;
        let mut candidates = catalog
            .packages
            .into_iter()
            .map(|name| MarketSearchCandidate {
                name,
                version: None,
                description: String::new(),
            })
            .collect::<Vec<_>>();
        if add_exact_query_candidate(&mut candidates, &query) {
            self.debug_log(format!(
                "catalog omitted exact market package {query}; adding direct view fallback"
            ));
        }
        let candidate_names = candidates
            .iter()
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>();
        self.debug_log(format!(
            "market catalog source={catalog_source} candidates={} names={candidate_names:?}",
            candidates.len()
        ));

        let mut plugins = BTreeMap::new();
        let mut rejected = 0_usize;
        let mut out_of_scope = 0_usize;
        for candidate in candidates.into_iter().take(MAX_CATALOG_PACKAGES) {
            if validate_market_package_name(&candidate.name).is_err() {
                out_of_scope += 1;
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
                self.debug_log(format!(
                    "candidate view failed name={} code={:?} timed_out={} log={}",
                    candidate.name, view_result.code, view_result.timed_out, view_result.log
                ));
                rejected += 1;
                continue;
            }
            let manifest = match parse_manifest(&combined_output(&view_result))
                .and_then(|value| validate_market_manifest(&candidate.name, &value))
            {
                Ok(manifest) => manifest,
                Err(error) => {
                    self.debug_log(format!(
                        "candidate rejected name={} reason={error}",
                        candidate.name
                    ));
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
            if market_plugin_matches_query(&plugin, &query) {
                plugins.insert(plugin.name.clone(), plugin);
            }
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
        if let Err(error) = ensure_command_success("读取已安装插件", &list_result) {
            self.debug_log(format!("market installed list failed: {error}"));
            return Err(error);
        }
        let installed_output = combined_output(&list_result);
        let installed = parse_installed_json(&installed_output);
        self.debug_log(format!(
            "market search installed market plugins={:?}",
            installed.keys().collect::<Vec<_>>()
        ));
        for plugin in plugins.values_mut() {
            if let Some(version) = installed.get(&plugin.name) {
                plugin.installed = true;
                plugin.installed_version = Some(version.clone());
            }
        }

        let mut messages = Vec::new();
        if catalog_source == "cache" {
            messages.push("远程市场目录暂不可用，当前使用本地缓存。".to_string());
        } else if catalog_source == "embedded" {
            messages.push("远程市场目录暂不可用，当前使用内置目录。".to_string());
        }
        if plugins.is_empty() {
            if rejected > 0 {
                messages.push(format!(
                    "没有找到符合市场协议的插件，已过滤 {rejected} 个候选包。"
                ));
            } else {
                messages.push("没有找到符合条件的插件。".to_string());
            }
        } else if rejected > 0 {
            messages.push(format!("已过滤 {rejected} 个不符合市场协议的候选包。"));
        }
        let message = messages.join(" ");
        self.debug_log(format!(
            "search complete query={query:?} accepted={} rejected_manifest_or_view={} out_of_scope={} message={message:?}",
            plugins.len(),
            rejected,
            out_of_scope
        ));
        Ok(MarketSearchResult {
            query,
            plugins: plugins.into_values().collect(),
            runtime_ready: true,
            package_manager_ready: true,
            message,
        })
    }

    pub async fn desktop_contributions(
        &self,
        runtime: &RuntimeManager,
        state: &PersistedState,
        dsh_home: &Path,
    ) -> Result<Vec<DesktopContribution>, String> {
        let selected = select_runtime(runtime, state).await?;
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
        ensure_command_success("读取已安装插件贡献", &list_result)?;

        let installed = parse_installed_json(&combined_output(&list_result));
        let mut contributions = Vec::new();
        for (name, version) in installed {
            if validate_market_package_name(&name).is_err() {
                continue;
            }
            let view_result = self.run_dsh(
                &selected,
                &pnpm,
                dsh_home,
                &[
                    "view".to_string(),
                    format!("{name}@{version}"),
                    "--json".to_string(),
                ],
            )?;
            if !view_result_success(&view_result) {
                self.debug_log(format!(
                    "desktop contribution view failed name={name} version={version} code={:?}",
                    view_result.code
                ));
                continue;
            }
            let manifest = match parse_manifest(&combined_output(&view_result))
                .and_then(|value| validate_market_manifest(&name, &value))
            {
                Ok(manifest) => manifest,
                Err(error) => {
                    self.debug_log(format!(
                        "desktop contribution rejected name={name} version={version} reason={error}"
                    ));
                    continue;
                }
            };
            let Some(desktop) = manifest.desktop else {
                continue;
            };
            if desktop.actions.is_empty() {
                continue;
            }
            contributions.push(DesktopContribution {
                package_name: manifest.name,
                version: manifest.version,
                display_name: manifest.display_name,
                actions: desktop.actions,
            });
        }
        contributions.sort_by(|left, right| left.package_name.cmp(&right.package_name));
        Ok(contributions)
    }

    pub async fn install(
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
        let selected = select_runtime(runtime, state).await?;
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

    pub async fn uninstall(
        &self,
        runtime: &RuntimeManager,
        state: &PersistedState,
        dsh_home: &Path,
        name: &str,
        restart_required: bool,
    ) -> Result<MarketOperationResult, String> {
        validate_market_package_name(name)?;
        let selected = select_runtime(runtime, state).await?;
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
        self.debug_log(format!(
            "command start version={} program={} args={args:?} cwd={} dsh_home={} pnpm_bin={}",
            selected.version,
            selected.program.display(),
            workdir.display(),
            dsh_home.display(),
            pnpm.bin_dir.display()
        ));
        let result = run_command(
            &selected.program,
            &args,
            &workdir,
            dsh_home,
            Some(&pnpm.bin_dir),
        );
        match &result {
            Ok(result) => self.debug_log(format!(
                "command end code={:?} timed_out={} stdout_bytes={} stderr_bytes={} log={}",
                result.code,
                result.timed_out,
                result.stdout.len(),
                result.stderr.len(),
                result.log
            )),
            Err(error) => self.debug_log(format!("command spawn failed: {error}")),
        }
        result.map_err(|error| {
            format!(
                "执行 DSH 插件命令失败（运行时 {}）: {error}",
                selected.version
            )
        })
    }
}

async fn select_runtime(
    runtime: &RuntimeManager,
    state: &PersistedState,
) -> Result<RuntimeCommand, String> {
    if state.runtime_source == crate::state::RUNTIME_SOURCE_LOCAL {
        let local = runtime
            .detect_local_async()
            .await
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

fn fetch_market_catalog() -> Result<String, String> {
    let response = ureq::get(MARKET_CATALOG_URL)
        .set("Accept", "application/json")
        .set("User-Agent", "dsh-desktop-market")
        .timeout(CATALOG_TIMEOUT)
        .call()
        .map_err(|error| format!("请求 GitHub Catalog 失败: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((MAX_CATALOG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 GitHub Catalog 失败: {error}"))?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(format!(
            "GitHub Catalog 超过 {MAX_CATALOG_BYTES} 字节限制。"
        ));
    }
    String::from_utf8(bytes).map_err(|error| format!("GitHub Catalog 不是 UTF-8: {error}"))
}

fn parse_market_catalog(raw: &str) -> Result<Vec<String>, String> {
    if raw.len() > MAX_CATALOG_BYTES {
        return Err(format!("市场目录超过 {MAX_CATALOG_BYTES} 字节限制。"));
    }
    let catalog: MarketCatalog =
        serde_json::from_str(raw).map_err(|error| format!("市场目录 JSON 无效: {error}"))?;
    if catalog.schema_version != 1 {
        return Err(format!(
            "不支持市场目录 schemaVersion {}。",
            catalog.schema_version
        ));
    }
    if catalog.packages.len() > MAX_CATALOG_PACKAGES {
        return Err(format!("市场目录不能超过 {MAX_CATALOG_PACKAGES} 个插件。"));
    }
    let mut packages = BTreeSet::new();
    for name in catalog.packages {
        validate_market_package_name(&name)?;
        if !packages.insert(name.clone()) {
            return Err(format!("市场目录包含重复插件: {name}"));
        }
    }
    Ok(packages.into_iter().collect())
}

fn market_plugin_matches_query(plugin: &MarketPlugin, query: &str) -> bool {
    let query = query.trim().to_ascii_lowercase();
    if query.is_empty()
        || matches!(
            query.as_str(),
            "@p-dsh-market" | "@p-dsh-market/" | "@p-dsh-market/*"
        )
    {
        return true;
    }
    plugin.name.to_ascii_lowercase().contains(&query)
        || plugin.display_name.to_ascii_lowercase().contains(&query)
        || plugin.description.to_ascii_lowercase().contains(&query)
        || plugin
            .capabilities
            .iter()
            .any(|capability| capability.to_ascii_lowercase().contains(&query))
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
    let protocol_version = dsh.get("protocolVersion").and_then(Value::as_u64);
    if dsh.contains_key("protocolVersion")
        && protocol_version != Some(u64::from(DESKTOP_PROTOCOL_VERSION))
    {
        return Err(format!(
            "dsh.protocolVersion 必须为 {DESKTOP_PROTOCOL_VERSION}。"
        ));
    }
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
    let desktop = validate_desktop_manifest(dsh, &capabilities, expected_name)?;
    Ok(MarketManifestPublic {
        name: actual_name,
        version,
        display_name: display_name.to_string(),
        description: string_field(manifest, "description").unwrap_or_default(),
        capabilities,
        desktop,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketManifestPublic {
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub desktop: Option<DesktopManifestPublic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopManifestPublic {
    pub permissions: Vec<String>,
    pub actions: Vec<DesktopTitlebarAction>,
}

fn validate_desktop_manifest(
    dsh: &serde_json::Map<String, Value>,
    capabilities: &[String],
    package_name: &str,
) -> Result<Option<DesktopManifestPublic>, String> {
    let Some(desktop_value) = dsh.get("desktop") else {
        return Ok(None);
    };
    if !capabilities.iter().any(|item| item == "desktop-shell") {
        return Err("声明 dsh.desktop 时必须包含 desktop-shell capability。".to_string());
    }
    if dsh.get("protocolVersion").and_then(Value::as_u64)
        != Some(u64::from(DESKTOP_PROTOCOL_VERSION))
    {
        return Err(format!(
            "{package_name} 的桌面贡献必须声明 dsh.protocolVersion: {DESKTOP_PROTOCOL_VERSION}。"
        ));
    }
    let desktop = desktop_value
        .as_object()
        .ok_or_else(|| "dsh.desktop 必须是对象。".to_string())?;
    let permissions = desktop
        .get("permissions")
        .and_then(Value::as_array)
        .ok_or_else(|| "dsh.desktop.permissions 必须是字符串数组。".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "dsh.desktop.permissions 必须只包含字符串。".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    const KNOWN_PERMISSIONS: &[&str] = &[
        "shell:titlebar",
        "shell:page",
        "workspace:read",
        "workspace:write-plugin-data",
        "native:open-folder",
        "native:open-terminal",
        "storage:user",
        "storage:sqlite",
    ];
    for permission in &permissions {
        if !KNOWN_PERMISSIONS.contains(&permission.as_str()) {
            return Err(format!("未知的桌面权限: {permission}"));
        }
    }

    let actions_value = desktop
        .get("contributes")
        .and_then(Value::as_object)
        .and_then(|contributes| contributes.get("titlebarActions"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let actions = actions_value
        .as_array()
        .ok_or_else(|| "dsh.desktop.contributes.titlebarActions 必须是数组。".to_string())?;
    if !actions.is_empty() && !permissions.iter().any(|item| item == "shell:titlebar") {
        return Err("标题栏贡献缺少权限 shell:titlebar。".to_string());
    }
    let mut ids = BTreeSet::new();
    let mut parsed = Vec::new();
    for (index, value) in actions.iter().enumerate() {
        let object = value.as_object().ok_or_else(|| {
            format!("dsh.desktop.contributes.titlebarActions[{index}] 必须是对象。")
        })?;
        let field = |name: &str| object.get(name).and_then(Value::as_str).map(str::to_string);
        let id = field("id")
            .ok_or_else(|| format!("dsh.desktop.contributes.titlebarActions[{index}].id 缺失。"))?;
        if !valid_contribution_id(&id) || !ids.insert(id.clone()) {
            return Err(format!("桌面贡献 ID 非法或重复: {id}"));
        }
        let slot = field("slot").ok_or_else(|| {
            format!("dsh.desktop.contributes.titlebarActions[{index}].slot 缺失。")
        })?;
        if slot != DESKTOP_TITLEBAR_WORKSPACE_ACTIONS {
            return Err(format!("未知的桌面扩展点: {slot}"));
        }
        let label = field("label")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!("dsh.desktop.contributes.titlebarActions[{index}].label 必须是非空字符串。")
            })?;
        let icon = field("icon");
        if let Some(icon) = &icon {
            if !matches!(icon.as_str(), "folder" | "terminal") {
                return Err(format!("不支持的标题栏图标: {icon}"));
            }
        }
        let order = object
            .get("order")
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("titlebarActions[{index}].order 必须是整数。"))?;
        let order = i32::try_from(order)
            .map_err(|_| format!("titlebarActions[{index}].order 超出范围。"))?;
        let when = parse_contribution_conditions(object.get("when"), index)?;
        let action = parse_desktop_action(object.get("action"), &permissions, index)?;
        parsed.push(DesktopTitlebarAction {
            id,
            slot,
            label,
            icon,
            order,
            when,
            action,
        });
    }
    parsed.sort_by(|left, right| left.order.cmp(&right.order).then(left.id.cmp(&right.id)));
    Ok(Some(DesktopManifestPublic {
        permissions,
        actions: parsed,
    }))
}

fn valid_contribution_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|ch| {
            ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
        })
}

fn parse_contribution_conditions(
    value: Option<&Value>,
    index: usize,
) -> Result<Vec<String>, String> {
    let values = match value {
        None => Vec::new(),
        Some(Value::String(item)) => vec![item.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("titlebarActions[{index}].when 必须只包含字符串。"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => {
            return Err(format!(
                "titlebarActions[{index}].when 必须是字符串或数组。"
            ))
        }
    };
    const KNOWN_CONDITIONS: &[&str] = &[
        "workspaceSelected",
        "dshRunning",
        "pluginActive",
        "restartNotRequired",
    ];
    for condition in &values {
        if !KNOWN_CONDITIONS.contains(&condition.as_str()) {
            return Err(format!("未知的桌面贡献条件: {condition}"));
        }
    }
    Ok(values)
}

fn parse_desktop_action(
    value: Option<&Value>,
    permissions: &[String],
    index: usize,
) -> Result<DesktopAction, String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("titlebarActions[{index}].action 必须是对象。"))?;
    let action_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("titlebarActions[{index}].action.type 缺失。"))?;
    match action_type {
        "native" => {
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("titlebarActions[{index}].action.command 缺失。"))?;
            let required_permission = match command {
                "workspace.openFolder" => "native:open-folder",
                "workspace.openTerminal" => "native:open-terminal",
                _ => return Err(format!("不支持的受控原生命令: {command}")),
            };
            if !permissions.iter().any(|item| item == required_permission) {
                return Err(format!(
                    "原生命令 {command} 缺少权限 {required_permission}。"
                ));
            }
            Ok(DesktopAction::Native {
                command: command.to_string(),
            })
        }
        "pluginRpc" => {
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("titlebarActions[{index}].action.method 缺失。"))?;
            if method.is_empty()
                || method.len() > 128
                || !method
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            {
                return Err(format!("非法的插件 RPC 方法: {method}"));
            }
            Ok(DesktopAction::PluginRpc {
                method: method.to_string(),
            })
        }
        other => Err(format!("不支持的桌面动作类型: {other}")),
    }
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

fn add_exact_query_candidate(candidates: &mut Vec<MarketSearchCandidate>, query: &str) -> bool {
    if validate_market_package_name(query).is_err()
        || candidates.iter().any(|candidate| candidate.name == query)
    {
        return false;
    }
    candidates.insert(
        0,
        MarketSearchCandidate {
            name: query.to_string(),
            version: None,
            description: String::new(),
        },
    );
    true
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
    fn validates_embedded_market_catalog() {
        let packages = parse_market_catalog(EMBEDDED_MARKET_CATALOG)
            .expect("embedded market catalog should be valid");
        assert_eq!(
            packages,
            vec!["@p-dsh-market/dsh-open-workspace".to_string()]
        );
        assert!(parse_market_catalog(
            r#"{"schemaVersion":2,"packages":["@p-dsh-market/example"]}"#
        )
        .is_err());
        assert!(parse_market_catalog(
            r#"{"schemaVersion":1,"packages":["@p-dsh-market/example","@p-dsh-market/example"]}"#
        )
        .is_err());
        assert!(
            parse_market_catalog(r#"{"schemaVersion":1,"packages":["@other/example"]}"#).is_err()
        );
    }

    #[test]
    fn catalog_scope_queries_list_all_and_keywords_filter_plugins() {
        let plugin = MarketPlugin {
            name: "@p-dsh-market/dsh-open-workspace".to_string(),
            display_name: "工作区文件浏览器".to_string(),
            version: "1.0.0".to_string(),
            description: "Markdown 预览".to_string(),
            capabilities: vec!["desktop-shell".to_string()],
            installed: false,
            installed_version: None,
        };
        for query in ["", "@p-dsh-market", "@p-dsh-market/", "@p-dsh-market/*"] {
            assert!(market_plugin_matches_query(&plugin, query));
        }
        assert!(market_plugin_matches_query(&plugin, "workspace"));
        assert!(market_plugin_matches_query(&plugin, "markdown"));
        assert!(market_plugin_matches_query(&plugin, "desktop-shell"));
        assert!(!market_plugin_matches_query(&plugin, "terminal-theme"));
    }

    #[test]
    fn adds_exact_market_query_when_catalog_omits_it() {
        let mut candidates = vec![MarketSearchCandidate {
            name: "@p-dsh-market/other".to_string(),
            version: Some("1.0.0".to_string()),
            description: String::new(),
        }];
        assert!(add_exact_query_candidate(
            &mut candidates,
            "@p-dsh-market/dsh-open-workspace"
        ));
        assert_eq!(candidates[0].name, "@p-dsh-market/dsh-open-workspace");
        assert!(!add_exact_query_candidate(
            &mut candidates,
            "@p-dsh-market/dsh-open-workspace"
        ));
        assert!(!add_exact_query_candidate(
            &mut candidates,
            "dsh-open-workspace"
        ));
    }

    #[test]
    fn parses_manifest_json_with_trailing_logs() {
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
    fn validates_desktop_titlebar_contributions_and_permissions() {
        let mut manifest = valid_manifest("@p-dsh-market/workspace");
        manifest["dsh"]["protocolVersion"] = serde_json::json!(1);
        manifest["dsh"]["market"]["capabilities"] =
            serde_json::json!(["skills", "host", "client", "desktop-shell"]);
        manifest["dsh"]["desktop"] = serde_json::json!({
            "permissions": ["shell:titlebar", "workspace:read", "native:open-folder"],
            "contributes": { "titlebarActions": [{
                "id": "open-folder",
                "slot": "desktop.titlebar.workspaceActions",
                "label": "文件夹",
                "icon": "folder",
                "order": 100,
                "when": ["workspaceSelected", "dshRunning"],
                "action": { "type": "native", "command": "workspace.openFolder" }
            }] }
        });
        let result = validate_market_manifest("@p-dsh-market/workspace", &manifest)
            .expect("desktop contribution should be accepted");
        let desktop = result.desktop.expect("desktop manifest should be present");
        assert_eq!(desktop.actions.len(), 1);
        assert_eq!(desktop.actions[0].slot, DESKTOP_TITLEBAR_WORKSPACE_ACTIONS);

        manifest["dsh"]["desktop"]["permissions"] = serde_json::json!(["shell:titlebar"]);
        assert!(validate_market_manifest("@p-dsh-market/workspace", &manifest).is_err());
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
