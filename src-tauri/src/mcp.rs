use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MCP_BEGIN: &str = "# BEGIN DSH Desktop MCP integration";
const MCP_END: &str = "# END DSH Desktop MCP integration";
const TAVILY_PACKAGE: &str = "tavily-mcp@0.2.22";
const FIRECRAWL_PACKAGE: &str = "firecrawl-mcp@3.24.0";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredServer {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    custom: bool,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    server_name: String,
    #[serde(default)]
    transport: String,
    #[serde(default)]
    package: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    #[serde(default)]
    servers: BTreeMap<String, StoredServer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSummary {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub package: String,
    pub built_in: bool,
    pub server_name: String,
    pub transport: String,
    pub command: String,
    pub url: String,
    pub secret_names: Vec<String>,
    pub enabled: bool,
    pub api_key_configured: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSecretInput {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCustomServerInput {
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    pub server_name: String,
    pub transport: String,
    #[serde(default)]
    pub package: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub env: Vec<McpSecretInput>,
    #[serde(default)]
    pub headers: Vec<McpSecretInput>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigResult {
    pub servers: Vec<McpServerSummary>,
    pub restart_required: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeServer {
    pub id: String,
    pub status: String,
    pub tool_count: usize,
    pub tools: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeResult {
    pub dsh_running: bool,
    pub bridge_ready: bool,
    pub servers: Vec<McpRuntimeServer>,
    pub message: String,
}

#[derive(Clone)]
pub struct McpManager {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl McpManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            path: base_dir.join("mcp.json"),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn list(&self) -> Result<McpConfigResult, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let config = self.load_unlocked()?;
        Ok(result(&config, false, "MCP 配置已加载。"))
    }

    pub fn save_server(
        &self,
        dsh_home: &Path,
        command: &Path,
        command_args: &[String],
        id: &str,
        enabled: bool,
        api_key: Option<String>,
        clear_api_key: bool,
    ) -> Result<McpConfigResult, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let mut config = self.load_unlocked()?;
        let built_in = definition(id).is_ok();
        if !built_in
            && !config
                .servers
                .get(id)
                .map(|server| server.custom)
                .unwrap_or(false)
        {
            return Err(format!("MCP 服务不存在: {id}"));
        }
        let server = config.servers.entry(id.to_string()).or_default();
        if built_in && clear_api_key {
            server.api_key.clear();
        } else if built_in {
            if let Some(value) = api_key
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                if value.len() > 512 {
                    return Err("API Key 过长。".to_string());
                }
                server.api_key = protect_secret(value.as_bytes())?;
            }
        }
        if built_in && enabled && server.api_key.is_empty() {
            return Err("请先填写 API Key，再启用该 MCP 服务。".to_string());
        }
        server.enabled = enabled;
        self.save_unlocked(&config)?;
        sync_profile_unlocked(dsh_home, command, command_args, &config)?;
        Ok(result(
            &config,
            true,
            "配置已保存；重启 DSH 后会按当前开关注册 MCP 工具。",
        ))
    }

    pub fn add_custom_server(
        &self,
        dsh_home: &Path,
        command: &Path,
        command_args: &[String],
        input: McpCustomServerInput,
    ) -> Result<McpConfigResult, String> {
        validate_custom_input(&input)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let mut config = self.load_unlocked()?;
        if config
            .servers
            .values()
            .filter(|server| server.custom)
            .count()
            >= 20
        {
            return Err("自定义 MCP 服务最多 20 个。".to_string());
        }
        if definitions().iter().any(|definition| {
            definition
                .server_name
                .eq_ignore_ascii_case(&input.server_name)
        }) || config.servers.values().any(|server| {
            server.custom && server.server_name.eq_ignore_ascii_case(&input.server_name)
        }) {
            return Err(format!("serverName 已存在: {}", input.server_name));
        }
        let id = format!("custom-{}", input.server_name.to_ascii_lowercase());
        let mut env = BTreeMap::new();
        for item in input.env {
            env.insert(item.name, protect_secret(item.value.as_bytes())?);
        }
        let mut headers = BTreeMap::new();
        for item in input.headers {
            headers.insert(item.name, protect_secret(item.value.as_bytes())?);
        }
        config.servers.insert(
            id,
            StoredServer {
                enabled: input.enabled,
                custom: true,
                display_name: input.display_name.trim().to_string(),
                description: input.description.trim().to_string(),
                server_name: input.server_name.trim().to_string(),
                transport: input.transport,
                package: input.package.trim().to_string(),
                command: input.command.trim().to_string(),
                args: input.args,
                url: input.url.trim().to_string(),
                env,
                headers,
                ..StoredServer::default()
            },
        );
        self.save_unlocked(&config)?;
        sync_profile_unlocked(dsh_home, command, command_args, &config)?;
        Ok(result(
            &config,
            true,
            "自定义 MCP 已添加；启用后重启 DSH 生效。",
        ))
    }

    pub fn delete_custom_server(
        &self,
        dsh_home: &Path,
        command: &Path,
        command_args: &[String],
        id: &str,
    ) -> Result<McpConfigResult, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let mut config = self.load_unlocked()?;
        if !config
            .servers
            .get(id)
            .map(|server| server.custom)
            .unwrap_or(false)
        {
            return Err("只能删除自定义 MCP 服务。".to_string());
        }
        config.servers.remove(id);
        self.save_unlocked(&config)?;
        sync_profile_unlocked(dsh_home, command, command_args, &config)?;
        Ok(result(&config, true, "自定义 MCP 已删除；重启 DSH 生效。"))
    }

    pub fn sync_profile(
        &self,
        dsh_home: &Path,
        command: &Path,
        command_args: &[String],
    ) -> Result<(), String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let config = self.load_unlocked()?;
        sync_profile_unlocked(dsh_home, command, command_args, &config)
    }

    pub fn process_environment(&self) -> Result<BTreeMap<String, String>, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let config = self.load_unlocked()?;
        let mut environment = BTreeMap::new();
        for definition in definitions() {
            if let Some(server) = config
                .servers
                .get(definition.id)
                .filter(|server| server.enabled && !server.api_key.is_empty())
            {
                environment.insert(
                    definition.desktop_env.to_string(),
                    unprotect_secret(&server.api_key)?,
                );
            }
        }
        for (id, server) in config
            .servers
            .iter()
            .filter(|(_, server)| server.custom && server.enabled)
        {
            for (name, value) in &server.env {
                environment.insert(
                    desktop_secret_env(id, "ENV", name),
                    unprotect_secret(value)?,
                );
            }
            for (name, value) in &server.headers {
                environment.insert(
                    desktop_secret_env(id, "HEADER", name),
                    unprotect_secret(value)?,
                );
            }
        }
        Ok(environment)
    }

    pub fn runtime_status(
        &self,
        dsh_running: bool,
        tools: Vec<String>,
        bridge_error: Option<String>,
    ) -> Result<McpRuntimeResult, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let config = self.load_unlocked()?;
        let bridge_ready = dsh_running && bridge_error.is_none();
        let mut runtime_definitions = definitions()
            .into_iter()
            .map(|definition| {
                let enabled = config
                    .servers
                    .get(definition.id)
                    .map(|server| server.enabled && !server.api_key.is_empty())
                    .unwrap_or(false);
                (
                    definition.id.to_string(),
                    definition.server_name.to_string(),
                    enabled,
                )
            })
            .collect::<Vec<_>>();
        runtime_definitions.extend(config.servers.iter().filter_map(|(id, server)| {
            server
                .custom
                .then(|| (id.clone(), server.server_name.clone(), server.enabled))
        }));
        let servers = runtime_definitions
            .into_iter()
            .map(|(id, server_name, enabled)| {
                let prefix = format!("mcp__{server_name}__");
                let server_tools = tools
                    .iter()
                    .filter(|name| name.starts_with(&prefix))
                    .cloned()
                    .collect::<Vec<_>>();
                let (status, message) = if !enabled {
                    ("disabled", "服务未启用。".to_string())
                } else if !dsh_running {
                    ("stopped", "DSH 未运行，MCP 尚未启动。".to_string())
                } else if !server_tools.is_empty() {
                    (
                        "connected",
                        format!("已连接并注册 {} 个工具。", server_tools.len()),
                    )
                } else if let Some(error) = bridge_error.as_ref() {
                    ("unavailable", format!("无法读取 DSH 工具注册表：{error}"))
                } else {
                    (
                        "not_connected",
                        "DSH 正在运行，但尚未发现该 MCP 的注册工具；可能仍在启动或启动失败。"
                            .to_string(),
                    )
                };
                McpRuntimeServer {
                    id,
                    status: status.to_string(),
                    tool_count: server_tools.len(),
                    tools: server_tools,
                    message,
                }
            })
            .collect::<Vec<_>>();
        let connected = servers
            .iter()
            .filter(|server| server.status == "connected")
            .count();
        let enabled = servers
            .iter()
            .filter(|server| server.status != "disabled")
            .count();
        Ok(McpRuntimeResult {
            dsh_running,
            bridge_ready,
            servers,
            message: if !dsh_running {
                "DSH 当前未运行。".to_string()
            } else if let Some(error) = bridge_error {
                format!("MCP 状态桥接不可用：{error}")
            } else {
                format!("已连接 {connected}/{enabled} 个启用的 MCP 服务。")
            },
        })
    }

    fn load_unlocked(&self) -> Result<StoredConfig, String> {
        if !self.path.exists() {
            return Ok(StoredConfig::default());
        }
        let bytes = fs::read(&self.path).map_err(io_error)?;
        serde_json::from_slice(&bytes).map_err(|error| format!("MCP 配置文件无效: {error}"))
    }

    fn save_unlocked(&self, config: &StoredConfig) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "MCP 配置路径无父目录".to_string())?;
        fs::create_dir_all(parent).map_err(io_error)?;
        let payload = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
        atomic_write(&self.path, &payload).map_err(io_error)
    }
}

struct ServerDefinition {
    id: &'static str,
    display_name: &'static str,
    description: &'static str,
    package: &'static str,
    server_name: &'static str,
    server_env: &'static str,
    desktop_env: &'static str,
}

fn definitions() -> [ServerDefinition; 2] {
    [
        ServerDefinition {
            id: "tavily",
            display_name: "Tavily Search",
            description: "实时网页搜索、提取、地图与站点抓取。",
            package: TAVILY_PACKAGE,
            server_name: "tavily",
            server_env: "TAVILY_API_KEY",
            desktop_env: "DSH_DESKTOP_MCP_TAVILY_API_KEY",
        },
        ServerDefinition {
            id: "firecrawl",
            display_name: "Firecrawl",
            description: "网页搜索、抓取、爬取、结构化提取与深度研究。",
            package: FIRECRAWL_PACKAGE,
            server_name: "firecrawl",
            server_env: "FIRECRAWL_API_KEY",
            desktop_env: "DSH_DESKTOP_MCP_FIRECRAWL_API_KEY",
        },
    ]
}

fn definition(id: &str) -> Result<ServerDefinition, String> {
    definitions()
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("不支持的 MCP 服务: {id}"))
}

fn result(config: &StoredConfig, restart_required: bool, message: &str) -> McpConfigResult {
    let mut servers = definitions()
        .into_iter()
        .map(|definition| {
            let stored = config.servers.get(definition.id);
            McpServerSummary {
                id: definition.id.to_string(),
                display_name: definition.display_name.to_string(),
                description: definition.description.to_string(),
                package: definition.package.to_string(),
                built_in: true,
                server_name: definition.server_name.to_string(),
                transport: "stdio".to_string(),
                command: String::new(),
                url: String::new(),
                secret_names: vec![definition.server_env.to_string()],
                enabled: stored.map(|item| item.enabled).unwrap_or(false),
                api_key_configured: stored.map(|item| !item.api_key.is_empty()).unwrap_or(false),
            }
        })
        .collect::<Vec<_>>();
    let mut custom = config
        .servers
        .iter()
        .filter_map(|(id, server)| {
            server.custom.then(|| McpServerSummary {
                id: id.clone(),
                display_name: server.display_name.clone(),
                description: server.description.clone(),
                package: server.package.clone(),
                built_in: false,
                server_name: server.server_name.clone(),
                transport: server.transport.clone(),
                command: server.command.clone(),
                url: server.url.clone(),
                secret_names: server
                    .env
                    .keys()
                    .cloned()
                    .chain(server.headers.keys().map(|name| format!("Header: {name}")))
                    .collect(),
                enabled: server.enabled,
                api_key_configured: !server.env.is_empty() || !server.headers.is_empty(),
            })
        })
        .collect::<Vec<_>>();
    custom.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    servers.extend(custom);
    McpConfigResult {
        servers,
        restart_required,
        message: message.to_string(),
    }
}

fn sync_profile_unlocked(
    dsh_home: &Path,
    command: &Path,
    command_args: &[String],
    config: &StoredConfig,
) -> Result<(), String> {
    let profile = dsh_home.join("profiles").join("web");
    fs::create_dir_all(&profile).map_err(io_error)?;
    let patch_path = profile.join("cordis.patch.yml");
    let existing = fs::read_to_string(&patch_path).unwrap_or_default();
    let mut content = remove_managed_block(&existing);
    let enabled = definitions()
        .into_iter()
        .filter(|definition| {
            config
                .servers
                .get(definition.id)
                .map(|item| item.enabled && !item.api_key.is_empty())
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    let enabled_custom = config
        .servers
        .iter()
        .filter(|(_, server)| server.custom && server.enabled)
        .collect::<Vec<_>>();
    if !enabled.is_empty() || !enabled_custom.is_empty() {
        if !content.is_empty() {
            content.push_str("\n\n");
        }
        content.push_str(MCP_BEGIN);
        content.push('\n');
        content.push_str("- insert:\n");
        for item in enabled {
            let mut args = command_args.to_vec();
            args.push("-y".to_string());
            args.push(item.package.to_string());
            content.push_str(&format!(
                "    - id: dsh-desktop-mcp-{}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: {}\n        transport: stdio\n        command: {}\n        args: [{}]\n        env:\n          {}: !!js process.env.{}\n        failOnStartupError: false\n",
                item.id,
                item.server_name,
                yaml_quote(&command.to_string_lossy()),
                args.iter().map(|value| yaml_quote(value)).collect::<Vec<_>>().join(", "),
                item.server_env,
                item.desktop_env,
            ));
        }
        for (id, server) in enabled_custom {
            content.push_str(&format!(
                "    - id: dsh-desktop-mcp-{}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: {}\n        transport: {}\n",
                id,
                server.server_name,
                server.transport,
            ));
            if server.transport == "stdio" {
                let (server_command, args) = if server.package.is_empty() {
                    (server.command.clone(), server.args.clone())
                } else {
                    let mut args = command_args.to_vec();
                    args.push("-y".to_string());
                    args.push(server.package.clone());
                    args.extend(server.args.clone());
                    (command.to_string_lossy().to_string(), args)
                };
                content.push_str(&format!(
                    "        command: {}\n        args: [{}]\n",
                    yaml_quote(&server_command),
                    args.iter()
                        .map(|value| yaml_quote(value))
                        .collect::<Vec<_>>()
                        .join(", "),
                ));
                if !server.env.is_empty() {
                    content.push_str("        env:\n");
                    for name in server.env.keys() {
                        content.push_str(&format!(
                            "          {}: !!js process.env.{}\n",
                            name,
                            desktop_secret_env(id, "ENV", name),
                        ));
                    }
                }
            } else {
                content.push_str(&format!("        url: {}\n", yaml_quote(&server.url)));
                if !server.headers.is_empty() {
                    content.push_str("        headers:\n");
                    for name in server.headers.keys() {
                        content.push_str(&format!(
                            "          {}: !!js process.env.{}\n",
                            yaml_quote(name),
                            desktop_secret_env(id, "HEADER", name),
                        ));
                    }
                }
            }
            content
                .push_str("        toolCallTimeoutMs: 60000\n        failOnStartupError: false\n");
        }
        content.push_str(MCP_END);
        content.push('\n');
    } else if !content.is_empty() {
        content.push('\n');
    }
    if content != existing {
        atomic_write(&patch_path, content.as_bytes()).map_err(io_error)?;
    }
    Ok(())
}

fn remove_managed_block(existing: &str) -> String {
    let mut content = existing.to_string();
    while let Some(start) = content.find(MCP_BEGIN) {
        let after = start + MCP_BEGIN.len();
        let end = content[after..]
            .find(MCP_END)
            .map(|offset| after + offset + MCP_END.len())
            .unwrap_or(content.len());
        content.replace_range(start..end, "");
    }
    content.trim().to_string()
}

fn validate_custom_input(input: &McpCustomServerInput) -> Result<(), String> {
    let display_name = input.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 80 {
        return Err("显示名称必须为 1-80 个字符。".to_string());
    }
    if input.description.chars().count() > 400 {
        return Err("描述不能超过 400 个字符。".to_string());
    }
    let server_name = input.server_name.trim();
    if server_name.is_empty()
        || server_name.len() > 32
        || !server_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("serverName 必须匹配 [A-Za-z0-9_-]{1,32}。".to_string());
    }
    if !matches!(input.transport.as_str(), "stdio" | "streamable-http") {
        return Err("transport 只能是 stdio 或 streamable-http。".to_string());
    }
    if input.args.len() > 32
        || input
            .args
            .iter()
            .any(|arg| arg.len() > 512 || arg.contains(['\r', '\n', '\0']))
    {
        return Err("参数最多 32 个，每项不超过 512 字符且不能包含换行。".to_string());
    }
    if input.transport == "stdio" {
        let package = input.package.trim();
        let command = input.command.trim();
        if package.is_empty() == command.is_empty() {
            return Err("stdio 服务必须且只能填写 npm 包或本地命令之一。".to_string());
        }
        if !package.is_empty()
            && (package.len() > 160
                || package.contains("..")
                || !package.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'/' | b'.' | b'_' | b'-')
                }))
        {
            return Err("npm 包名或版本格式不安全。".to_string());
        }
        if !command.is_empty() && (command.len() > 512 || command.contains(['\r', '\n', '\0'])) {
            return Err("本地命令不合法。".to_string());
        }
    } else {
        if !input.package.trim().is_empty() || !input.command.trim().is_empty() {
            return Err("HTTP MCP 不应填写 npm 包或本地命令。".to_string());
        }
        let parsed =
            url::Url::parse(input.url.trim()).map_err(|error| format!("MCP URL 无效: {error}"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("MCP URL 必须是无内嵌凭据的 http/https 地址。".to_string());
        }
    }
    validate_secret_inputs(&input.env, true)?;
    validate_secret_inputs(&input.headers, false)?;
    Ok(())
}

fn validate_secret_inputs(items: &[McpSecretInput], environment: bool) -> Result<(), String> {
    if items.len() > 32 {
        return Err("环境变量或 Header 最多 32 项。".to_string());
    }
    let mut names = BTreeSet::new();
    for item in items {
        let name = item.name.trim();
        let valid_name = if environment {
            !name.is_empty()
                && name.len() <= 80
                && name.bytes().enumerate().all(|(index, byte)| {
                    byte == b'_'
                        || byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit())
                })
        } else {
            !name.is_empty()
                && name.len() <= 100
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b':')
        };
        if !valid_name {
            return Err(format!(
                "{}名称不合法: {name}",
                if environment {
                    "环境变量"
                } else {
                    "Header"
                }
            ));
        }
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(format!("重复的配置名称: {name}"));
        }
        if item.value.is_empty() || item.value.len() > 4096 {
            return Err(format!("{name} 的值必须为 1-4096 个字符。"));
        }
    }
    Ok(())
}

fn desktop_secret_env(id: &str, group: &str, name: &str) -> String {
    let suffix = format!("{id}_{group}_{name}")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();
    format!("DSH_DESKTOP_MCP_{suffix}")
}

fn yaml_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn protect_secret(value: &[u8]) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let mut input = value.to_vec();
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_mut_ptr(),
    };
    let mut output_blob = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input_blob,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
    };
    if ok == 0 {
        return Err(format!(
            "使用 Windows DPAPI 保护 API Key 失败: {}",
            io::Error::last_os_error()
        ));
    }
    let protected = unsafe {
        std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output_blob.pbData.cast());
    }
    Ok(format!("dpapi:{}", BASE64.encode(protected)))
}

#[cfg(windows)]
fn unprotect_secret(value: &str) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let encoded = value
        .strip_prefix("dpapi:")
        .ok_or_else(|| "MCP API Key 不是受支持的 DPAPI 密文。".to_string())?;
    let mut protected = BASE64
        .decode(encoded)
        .map_err(|error| format!("MCP API Key 密文无效: {error}"))?;
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_mut_ptr(),
    };
    let mut output_blob = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input_blob,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output_blob,
        )
    };
    if ok == 0 {
        return Err(format!(
            "使用 Windows DPAPI 解密 API Key 失败: {}",
            io::Error::last_os_error()
        ));
    }
    let clear = unsafe {
        std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec()
    };
    unsafe {
        LocalFree(output_blob.pbData.cast());
    }
    String::from_utf8(clear).map_err(|_| "MCP API Key 不是有效的 UTF-8。".to_string())
}

#[cfg(not(windows))]
fn protect_secret(value: &[u8]) -> Result<String, String> {
    Ok(format!("local:{}", BASE64.encode(value)))
}

#[cfg(not(windows))]
fn unprotect_secret(value: &str) -> Result<String, String> {
    let encoded = value
        .strip_prefix("local:")
        .ok_or_else(|| "MCP API Key 密文格式无效。".to_string())?;
    let clear = BASE64
        .decode(encoded)
        .map_err(|error| format!("MCP API Key 密文无效: {error}"))?;
    String::from_utf8(clear).map_err(|_| "MCP API Key 不是有效的 UTF-8。".to_string())
}

fn atomic_write(path: &Path, content: &[u8]) -> io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
    fs::write(&tmp, content)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(tmp, path)
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("dsh-mcp-{suffix}"))
    }

    #[test]
    fn defaults_are_disabled_and_do_not_expose_keys() {
        let manager = McpManager::new(temp_root());
        let result = manager.list().unwrap();
        assert_eq!(result.servers.len(), 2);
        assert!(result
            .servers
            .iter()
            .all(|item| !item.enabled && !item.api_key_configured));
    }

    #[test]
    fn enabled_server_writes_owned_patch_and_environment() {
        let root = temp_root();
        let manager = McpManager::new(root.join("data"));
        let dsh_home = root.join("dsh");
        let node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        let args = vec![r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js".to_string()];
        manager
            .save_server(
                &dsh_home,
                &node,
                &args,
                "tavily",
                true,
                Some("tvly-secret".to_string()),
                false,
            )
            .unwrap();
        let patch = fs::read_to_string(dsh_home.join("profiles/web/cordis.patch.yml")).unwrap();
        assert!(patch.contains("dsh-desktop-mcp-tavily"));
        assert!(patch.contains("tavily-mcp@0.2.22"));
        assert!(patch.contains("npx-cli.js"));
        assert!(!patch.contains("tvly-secret"));
        let stored = fs::read_to_string(root.join("data/mcp.json")).unwrap();
        assert!(!stored.contains("tvly-secret"));
        assert_eq!(
            manager
                .process_environment()
                .unwrap()
                .get("DSH_DESKTOP_MCP_TAVILY_API_KEY")
                .map(String::as_str),
            Some("tvly-secret")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_status_reports_registered_tools_per_server() {
        let root = temp_root();
        let manager = McpManager::new(root.join("data"));
        let dsh_home = root.join("dsh");
        manager
            .save_server(
                &dsh_home,
                Path::new("node"),
                &[],
                "tavily",
                true,
                Some("tvly-secret".to_string()),
                false,
            )
            .unwrap();
        let status = manager
            .runtime_status(
                true,
                vec![
                    "mcp__tavily__search".to_string(),
                    "mcp__tavily__extract".to_string(),
                ],
                None,
            )
            .unwrap();
        assert_eq!(status.servers[0].status, "connected");
        assert_eq!(status.servers[0].tool_count, 2);
        assert_eq!(status.servers[1].status, "disabled");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_stdio_server_is_encrypted_injected_and_reported() {
        let root = temp_root();
        let manager = McpManager::new(root.join("data"));
        let dsh_home = root.join("dsh");
        manager
            .add_custom_server(
                &dsh_home,
                Path::new("node"),
                &["npx-cli.js".to_string()],
                McpCustomServerInput {
                    display_name: "GitHub MCP".to_string(),
                    description: "Repository tools".to_string(),
                    server_name: "github".to_string(),
                    transport: "stdio".to_string(),
                    package: "@example/github-mcp@1.2.3".to_string(),
                    command: String::new(),
                    args: vec!["--readonly".to_string()],
                    url: String::new(),
                    env: vec![McpSecretInput {
                        name: "GITHUB_TOKEN".to_string(),
                        value: "github-secret".to_string(),
                    }],
                    headers: vec![],
                    enabled: true,
                },
            )
            .unwrap();

        let patch = fs::read_to_string(dsh_home.join("profiles/web/cordis.patch.yml")).unwrap();
        assert!(patch.contains("dsh-desktop-mcp-custom-github"));
        assert!(patch.contains("serverName: github"));
        assert!(patch.contains("@example/github-mcp@1.2.3"));
        assert!(patch.contains("DSH_DESKTOP_MCP_CUSTOM_GITHUB_ENV_GITHUB_TOKEN"));
        assert!(!patch.contains("github-secret"));
        let stored = fs::read_to_string(root.join("data/mcp.json")).unwrap();
        assert!(!stored.contains("github-secret"));
        assert_eq!(
            manager
                .process_environment()
                .unwrap()
                .get("DSH_DESKTOP_MCP_CUSTOM_GITHUB_ENV_GITHUB_TOKEN")
                .map(String::as_str),
            Some("github-secret")
        );
        let listed = manager.list().unwrap();
        let github = listed
            .servers
            .iter()
            .find(|server| server.server_name == "github")
            .unwrap();
        assert!(!github.built_in);
        assert_eq!(github.secret_names, vec!["GITHUB_TOKEN"]);
        let status = manager
            .runtime_status(
                true,
                vec!["mcp__github__list_repositories".to_string()],
                None,
            )
            .unwrap();
        let github_status = status
            .servers
            .iter()
            .find(|server| server.id == "custom-github")
            .unwrap();
        assert_eq!(github_status.status, "connected");
        assert_eq!(github_status.tool_count, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_http_server_uses_encrypted_header_and_can_be_deleted() {
        let root = temp_root();
        let manager = McpManager::new(root.join("data"));
        let dsh_home = root.join("dsh");
        manager
            .add_custom_server(
                &dsh_home,
                Path::new("node"),
                &[],
                McpCustomServerInput {
                    display_name: "Remote Search".to_string(),
                    description: String::new(),
                    server_name: "remote_search".to_string(),
                    transport: "streamable-http".to_string(),
                    package: String::new(),
                    command: String::new(),
                    args: vec![],
                    url: "https://mcp.example.test/api".to_string(),
                    env: vec![],
                    headers: vec![McpSecretInput {
                        name: "Authorization".to_string(),
                        value: "Bearer remote-secret".to_string(),
                    }],
                    enabled: true,
                },
            )
            .unwrap();
        let patch_path = dsh_home.join("profiles/web/cordis.patch.yml");
        let patch = fs::read_to_string(&patch_path).unwrap();
        assert!(patch.contains("transport: streamable-http"));
        assert!(patch.contains("https://mcp.example.test/api"));
        assert!(patch.contains("DSH_DESKTOP_MCP_CUSTOM_REMOTE_SEARCH_HEADER_AUTHORIZATION"));
        assert!(!patch.contains("remote-secret"));

        manager
            .delete_custom_server(&dsh_home, Path::new("node"), &[], "custom-remote_search")
            .unwrap();
        assert!(!fs::read_to_string(&patch_path)
            .unwrap()
            .contains("custom-remote_search"));
        assert_eq!(manager.list().unwrap().servers.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_server_validation_rejects_unsafe_values() {
        let input = McpCustomServerInput {
            display_name: "Bad".to_string(),
            description: String::new(),
            server_name: "bad name".to_string(),
            transport: "stdio".to_string(),
            package: "../unsafe".to_string(),
            command: String::new(),
            args: vec![],
            url: String::new(),
            env: vec![],
            headers: vec![],
            enabled: false,
        };
        assert!(validate_custom_input(&input).is_err());
    }
}
