use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub const DEFAULT_PINNED: &str = "0.1.0-rc.6";
pub const RUNTIME_SOURCE_MANAGED: &str = "managed";
pub const RUNTIME_SOURCE_LOCAL: &str = "local";
pub const THEME_LIGHT: &str = "light";
pub const THEME_DARK: &str = "dark";
pub const THEME_SYSTEM: &str = "system";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    #[serde(default = "default_pinned")]
    pub pinned: String,
    #[serde(default)]
    pub last_good: Option<String>,
    #[serde(default)]
    pub available: Option<String>,
    #[serde(default)]
    pub last_workspace: Option<String>,
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
    #[serde(default = "default_true")]
    pub tray_resident: bool,
    #[serde(default = "default_true")]
    pub notify_on_turn_end: bool,
    #[serde(default = "default_runtime_source")]
    pub runtime_source: String,
    #[serde(default)]
    pub window_bounds: Option<WindowBounds>,
    #[serde(default = "default_theme")]
    pub theme: String,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            pinned: DEFAULT_PINNED.to_string(),
            last_good: Some(DEFAULT_PINNED.to_string()),
            available: None,
            last_workspace: None,
            recent_workspaces: Vec::new(),
            tray_resident: true,
            notify_on_turn_end: true,
            runtime_source: RUNTIME_SOURCE_MANAGED.to_string(),
            window_bounds: None,
            theme: THEME_SYSTEM.to_string(),
        }
    }
}

impl PersistedState {
    pub fn remember_workspace(&mut self, path: &Path) {
        let value = path.to_string_lossy().to_string();
        self.last_workspace = Some(value.clone());
        self.recent_workspaces.retain(|item| item != &value);
        self.recent_workspaces.insert(0, value);
        self.recent_workspaces.truncate(12);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    pub version: String,
    pub installed: bool,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeSummary {
    pub version: String,
    pub command: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub status: String,
    pub message: String,
    pub detail: String,
    pub error: Option<String>,
    pub progress: Option<u8>,
    pub web_url: Option<String>,
    pub pinned: String,
    pub last_good: Option<String>,
    pub available: Option<String>,
    pub workspace: Option<String>,
    pub runtime_source: String,
    pub theme: String,
    pub local_runtime: Option<LocalRuntimeSummary>,
    pub versions: Vec<RuntimeSummary>,
    pub logs: Vec<String>,
}

impl Default for DesktopStatus {
    fn default() -> Self {
        Self {
            status: "checking".to_string(),
            message: "正在检查运行环境…".to_string(),
            detail: "客户端正在读取固定版本与工作区设置。".to_string(),
            error: None,
            progress: None,
            web_url: None,
            pinned: DEFAULT_PINNED.to_string(),
            last_good: Some(DEFAULT_PINNED.to_string()),
            available: None,
            workspace: None,
            runtime_source: RUNTIME_SOURCE_MANAGED.to_string(),
            theme: THEME_SYSTEM.to_string(),
            local_runtime: None,
            versions: Vec::new(),
            logs: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct StateStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl StateStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn load(&self) -> io::Result<PersistedState> {
        let _guard = self.lock.lock().expect("state lock poisoned");
        if !self.path.exists() {
            return Ok(PersistedState::default());
        }
        let bytes = fs::read(&self.path)?;
        let mut state: PersistedState = serde_json::from_slice(&bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid state.json: {error}"),
            )
        })?;
        if state.pinned.trim().is_empty() {
            state.pinned = DEFAULT_PINNED.to_string();
        }
        if state.last_good.is_none() {
            state.last_good = Some(state.pinned.clone());
        }
        if !matches!(
            state.runtime_source.as_str(),
            RUNTIME_SOURCE_MANAGED | RUNTIME_SOURCE_LOCAL
        ) {
            state.runtime_source = RUNTIME_SOURCE_MANAGED.to_string();
        }
        if !matches!(
            state.theme.as_str(),
            THEME_LIGHT | THEME_DARK | THEME_SYSTEM
        ) {
            state.theme = THEME_SYSTEM.to_string();
        }
        Ok(state)
    }

    pub fn save(&self, state: &PersistedState) -> io::Result<()> {
        let _guard = self.lock.lock().expect("state lock poisoned");
        let parent = self.path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "state path has no parent")
        })?;
        fs::create_dir_all(parent)?;
        let tmp = self.path.with_extension("json.tmp");
        let payload = serde_json::to_vec_pretty(state)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        fs::write(&tmp, payload)?;
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        fs::rename(tmp, &self.path)
    }
}

fn default_pinned() -> String {
    DEFAULT_PINNED.to_string()
}

fn default_true() -> bool {
    true
}

fn default_runtime_source() -> String {
    RUNTIME_SOURCE_MANAGED.to_string()
}

fn default_theme() -> String {
    THEME_SYSTEM.to_string()
}
