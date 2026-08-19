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
pub const DEFAULT_SKIN_ID: &str = "builtin.default";
pub const DEFAULT_BACKGROUND_INTENSITY: f32 = 0.32;

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
    #[serde(default = "default_appearance_mode")]
    pub appearance_mode: String,
    #[serde(default = "default_skin_id")]
    pub skin_id: String,
    #[serde(default = "default_background_intensity")]
    pub background_intensity: f32,
    #[serde(default)]
    pub reduce_effects: bool,
    /// Compatibility-only field for state.json written by versions before
    /// Theme Pack support. It is migrated on load and never written back.
    #[serde(rename = "theme", default, skip_serializing)]
    pub legacy_theme: Option<String>,
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
            appearance_mode: THEME_SYSTEM.to_string(),
            skin_id: DEFAULT_SKIN_ID.to_string(),
            background_intensity: DEFAULT_BACKGROUND_INTENSITY,
            reduce_effects: false,
            legacy_theme: None,
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
    pub appearance_mode: String,
    pub skin_id: String,
    pub background_intensity: f32,
    pub reduce_effects: bool,
    pub theme_preview_until: Option<u64>,
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
            appearance_mode: THEME_SYSTEM.to_string(),
            skin_id: DEFAULT_SKIN_ID.to_string(),
            background_intensity: DEFAULT_BACKGROUND_INTENSITY,
            reduce_effects: false,
            theme_preview_until: None,
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
        let mut migrated = false;
        if let Some(theme) = state.legacy_theme.take() {
            state.appearance_mode = theme;
            migrated = true;
        }
        if !matches!(
            state.appearance_mode.as_str(),
            THEME_LIGHT | THEME_DARK | THEME_SYSTEM
        ) {
            state.appearance_mode = THEME_SYSTEM.to_string();
            migrated = true;
        }
        if state.skin_id.trim().is_empty() {
            state.skin_id = DEFAULT_SKIN_ID.to_string();
            migrated = true;
        }
        if !state.background_intensity.is_finite() {
            state.background_intensity = DEFAULT_BACKGROUND_INTENSITY;
            migrated = true;
        }
        let clamped_intensity = state.background_intensity.clamp(0.0, 1.0);
        if clamped_intensity != state.background_intensity {
            state.background_intensity = clamped_intensity;
            migrated = true;
        }
        if migrated {
            self.save_unlocked(&state)?;
        }
        Ok(state)
    }

    pub fn save(&self, state: &PersistedState) -> io::Result<()> {
        let _guard = self.lock.lock().expect("state lock poisoned");
        self.save_unlocked(state)
    }

    fn save_unlocked(&self, state: &PersistedState) -> io::Result<()> {
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

fn default_appearance_mode() -> String {
    THEME_SYSTEM.to_string()
}

fn default_skin_id() -> String {
    DEFAULT_SKIN_ID.to_string()
}

fn default_background_intensity() -> f32 {
    DEFAULT_BACKGROUND_INTENSITY
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn migrates_legacy_theme_into_appearance_mode_and_writes_new_shape() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dsh-state-{suffix}.json"));
        fs::write(&path, r#"{"pinned":"0.1.0-rc.6","theme":"dark"}"#).expect("write legacy state");
        let store = StateStore::new(path.clone());
        let state = store.load().expect("load migrated state");
        assert_eq!(state.appearance_mode, THEME_DARK);
        assert_eq!(state.skin_id, DEFAULT_SKIN_ID);
        let persisted = fs::read_to_string(&path).expect("read migrated state");
        assert!(persisted.contains("appearanceMode"));
        assert!(!persisted.contains("\"theme\""));
        let _ = fs::remove_file(path);
    }
}
