use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
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
    pub enabled: bool,
    pub api_key_configured: bool,
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
        definition(id)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "MCP 配置锁已损坏".to_string())?;
        let mut config = self.load_unlocked()?;
        let server = config.servers.entry(id.to_string()).or_default();
        if clear_api_key {
            server.api_key.clear();
        } else if let Some(value) = api_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            if value.len() > 512 {
                return Err("API Key 过长。".to_string());
            }
            server.api_key = protect_secret(value.as_bytes())?;
        }
        if enabled && server.api_key.is_empty() {
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
        let servers = definitions()
            .into_iter()
            .map(|definition| {
                let enabled = config
                    .servers
                    .get(definition.id)
                    .map(|server| server.enabled && !server.api_key.is_empty())
                    .unwrap_or(false);
                let prefix = format!("mcp__{}__", definition.server_name);
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
                    id: definition.id.to_string(),
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
    McpConfigResult {
        servers: definitions()
            .into_iter()
            .map(|definition| {
                let stored = config.servers.get(definition.id);
                McpServerSummary {
                    id: definition.id.to_string(),
                    display_name: definition.display_name.to_string(),
                    description: definition.description.to_string(),
                    package: definition.package.to_string(),
                    enabled: stored.map(|item| item.enabled).unwrap_or(false),
                    api_key_configured: stored
                        .map(|item| !item.api_key.is_empty())
                        .unwrap_or(false),
                }
            })
            .collect(),
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
    if !enabled.is_empty() {
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
}
