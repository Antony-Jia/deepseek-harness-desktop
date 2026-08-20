use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use crate::{
    market::THEME_CLIENT_PACKAGE,
    state::{PersistedState, DEFAULT_BACKGROUND_INTENSITY, DEFAULT_SKIN_ID},
};

pub const THEME_SCHEMA_VERSION: u32 = 1;
const MAX_THEME_BYTES: u64 = 128 * 1024;
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STRING_LENGTH: usize = 512;
const MAX_TOKEN_COUNT: usize = 64;
const MAX_IMAGE_WIDTH: u32 = 7680;
const MAX_IMAGE_HEIGHT: u32 = 4320;

const ALLOWED_TOKENS: &[&str] = &[
    "color.background.base",
    "color.surface.primary",
    "color.surface.secondary",
    "color.text.primary",
    "color.text.secondary",
    "color.border.default",
    "color.accent.primary",
    "color.accent.secondary",
    "color.success",
    "color.warning",
    "color.danger",
    "focus.ring",
    "desktop.titlebar.background",
    "desktop.panel.backdropBlur",
    "web.conversation.surface",
    "web.sidebar.surface",
    "components.button.background",
    "components.button.hoverBackground",
    "components.button.activeBackground",
    "components.button.disabledBackground",
    "components.button.text",
    "components.button.hoverText",
    "components.button.border",
    "components.button.radius",
    "components.button.shadow",
    "components.input.background",
    "components.input.border",
    "components.input.focusBorder",
    "components.input.placeholder",
    "components.input.caret",
    "components.panel.radius",
    "components.panel.shadow",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePackSummary {
    pub package_name: String,
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub source: String,
    pub installed: bool,
    pub enabled: bool,
    pub protocol_compatible: bool,
    pub appearance: String,
    pub supported_appearances: Vec<String>,
    pub preview_url: Option<String>,
    pub tokens: BTreeMap<String, String>,
    pub background: Option<ThemeBackground>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBackground {
    pub image_url: Option<String>,
    pub targets: Vec<String>,
    pub fit: String,
    pub position: String,
    pub opacity: f32,
    pub overlay: String,
    pub blur: String,
    pub fixed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeManifest {
    schema_version: u32,
    id: String,
    display_name: String,
    entry: String,
    #[serde(default)]
    preview: Option<String>,
    #[serde(default)]
    supported_appearances: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeFile {
    schema_version: u32,
    appearance: String,
    tokens: Value,
    #[serde(default)]
    background: Option<RawBackground>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBackground {
    image: String,
    #[serde(default)]
    targets: Vec<String>,
    #[serde(default = "default_fit")]
    fit: String,
    #[serde(default = "default_position")]
    position: String,
    #[serde(default = "default_opacity")]
    opacity: f32,
    #[serde(default = "default_overlay")]
    overlay: String,
    #[serde(default = "default_blur")]
    blur: String,
    #[serde(default = "default_true")]
    fixed: bool,
}

#[derive(Debug, Deserialize)]
struct PackageManifest {
    name: String,
    version: String,
    #[serde(default)]
    description: String,
    dsh: Option<DshManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshManifest {
    #[serde(default)]
    protocol_version: Option<u32>,
    client: Option<ClientManifest>,
    theme: Option<ThemeManifest>,
    #[serde(default)]
    market: Option<MarketManifest>,
}

#[derive(Debug, Deserialize)]
struct ClientManifest {
    platform: String,
    #[serde(default)]
    inject: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketManifest {
    display_name: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

pub fn list_theme_packs(dsh_home: &Path) -> Result<Vec<ThemePackSummary>, String> {
    let mut packs = vec![builtin_default()];
    let profile = dsh_home.join("profiles").join("web");
    let scope_dir = profile.join("node_modules").join("@p-dsh-market");
    let enabled_packages = profile_enabled_packages(&profile);
    if let Ok(entries) = fs::read_dir(&scope_dir) {
        for entry in entries.flatten() {
            let package_dir = entry.path();
            if !package_dir.is_dir() {
                continue;
            }
            let package_json = package_dir.join("package.json");
            let Ok(raw) = read_bounded(&package_json, MAX_THEME_BYTES) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_slice::<PackageManifest>(&raw) else {
                continue;
            };
            let Some(dsh) = manifest.dsh.as_ref() else {
                continue;
            };
            if dsh.theme.is_none() {
                continue;
            }
            let enabled = enabled_packages.contains(&manifest.name);
            match load_installed_theme(&package_dir, &manifest, enabled) {
                Ok(pack) => packs.push(pack),
                Err(error) => packs.push(invalid_pack(&manifest, enabled, error)),
            }
        }
    }

    // A built-in pack and its installed market package may share the same
    // protocol id. Prefer the profile copy so the UI and lifecycle commands
    // operate on the actual installed package rather than the fallback copy.
    let mut by_id = BTreeMap::new();
    for pack in packs {
        let replace = by_id
            .get(&pack.id)
            .map(|existing: &ThemePackSummary| {
                existing.source != "profile" || pack.source == "profile"
            })
            .unwrap_or(true);
        if replace {
            by_id.insert(pack.id.clone(), pack);
        }
    }
    Ok(by_id.into_values().collect())
}

pub fn get_theme_pack(dsh_home: &Path, id: &str) -> Result<ThemePackSummary, String> {
    validate_theme_id(id)?;
    if id == DEFAULT_SKIN_ID {
        return Ok(builtin_default());
    }
    list_theme_packs(dsh_home)?
        .into_iter()
        .find(|pack| pack.id == id)
        .ok_or_else(|| format!("未找到主题包: {id}"))
}

pub fn installed_theme_for_package(
    dsh_home: &Path,
    package_name: &str,
) -> Result<Option<ThemePackSummary>, String> {
    Ok(list_theme_packs(dsh_home)?
        .into_iter()
        .find(|pack| pack.source == "profile" && pack.package_name == package_name))
}

pub fn validate_installed_theme_package(dsh_home: &Path, package_name: &str) -> Result<(), String> {
    let Some(pack) = installed_theme_for_package(dsh_home, package_name)? else {
        return Ok(());
    };
    if !pack.protocol_compatible {
        return Err(pack
            .error
            .unwrap_or_else(|| format!("主题包 {package_name} 清单校验失败。")));
    }
    if !pack.enabled {
        return Err(format!("主题包 {package_name} 安装后未处于启用状态。"));
    }
    Ok(())
}

pub fn active_skin_id(state: &PersistedState, preview_id: Option<&str>) -> String {
    preview_id
        .map(str::to_string)
        .unwrap_or_else(|| state.skin_id.clone())
}

pub fn validate_theme_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .next()
            .map(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
            .unwrap_or(false)
        || id.chars().any(|ch| {
            !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
        })
    {
        return Err(format!("非法主题 ID: {id}"));
    }
    Ok(())
}

fn validate_theme_file(
    raw: &str,
) -> Result<(BTreeMap<String, String>, Option<RawBackground>), String> {
    if raw.len() > MAX_THEME_BYTES as usize {
        return Err("主题清单超过 128 KiB 限制。".to_string());
    }
    let file = serde_json::from_str::<ThemeFile>(raw)
        .map_err(|error| format!("主题清单 JSON 无效: {error}"))?;
    if file.schema_version != THEME_SCHEMA_VERSION {
        return Err(format!(
            "不支持的主题 schemaVersion: {}。",
            file.schema_version
        ));
    }
    if file.appearance != "dark" && file.appearance != "light" {
        return Err("主题 appearance 只能是 dark 或 light。".to_string());
    }
    let mut tokens = BTreeMap::new();
    let sections = file
        .tokens
        .as_object()
        .ok_or_else(|| "主题 tokens 必须是对象。".to_string())?;
    for (section, value) in sections {
        let prefix = match section.as_str() {
            "shared" => "",
            "desktop" => "desktop.",
            "web" => "web.",
            "components" => "components.",
            _ => return Err(format!("未知主题 token 分组: {section}")),
        };
        flatten_tokens(value, prefix, &mut tokens)?;
    }
    if tokens.len() > MAX_TOKEN_COUNT {
        return Err(format!("主题 token 数量不能超过 {MAX_TOKEN_COUNT}。"));
    }
    for (key, value) in &tokens {
        validate_token(key, value)?;
    }
    Ok((tokens, file.background))
}

fn flatten_tokens(
    value: &Value,
    prefix: &str,
    output: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "主题 token 分组必须是对象。".to_string())?;
    for (key, value) in object {
        if key.is_empty() || key.len() > MAX_STRING_LENGTH || key.contains('\0') {
            return Err("主题 token 名称非法。".to_string());
        }
        let full_key = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}{key}")
        };
        if let Some(value) = value.as_str() {
            if output.insert(full_key.clone(), value.to_string()).is_some() {
                return Err(format!("主题 token 重复: {full_key}"));
            }
        } else if value.is_object() {
            flatten_tokens(value, &format!("{full_key}."), output)?;
        } else {
            return Err(format!("主题 token {full_key} 必须是字符串。"));
        }
    }
    Ok(())
}

fn validate_token(key: &str, value: &str) -> Result<(), String> {
    if !ALLOWED_TOKENS.contains(&key) {
        return Err(format!("不允许的主题 token: {key}"));
    }
    if value.is_empty()
        || value.len() > MAX_STRING_LENGTH
        || value
            .chars()
            .any(|ch| ch == '\0' || ch == ';' || ch == '{' || ch == '}' || ch == '<' || ch == '>')
        || value.to_ascii_lowercase().contains("url(")
        || value.to_ascii_lowercase().contains("@import")
        || value.to_ascii_lowercase().contains("!important")
    {
        return Err(format!("主题 token {key} 包含不安全的 CSS 值。"));
    }
    if key.ends_with(".radius") {
        validate_px_range(key, value, 0.0, 24.0)?;
    }
    if key.ends_with(".backdropBlur") {
        validate_px_range(key, value, 0.0, 20.0)?;
    }
    Ok(())
}

fn validate_px_range(key: &str, value: &str, min: f32, max: f32) -> Result<(), String> {
    let number = value
        .strip_suffix("px")
        .ok_or_else(|| format!("主题 token {key} 必须使用 px。"))?
        .trim()
        .parse::<f32>()
        .map_err(|_| format!("主题 token {key} 不是有效的 px 值。"))?;
    if !number.is_finite() || number < min || number > max {
        return Err(format!("主题 token {key} 超出允许范围。"));
    }
    Ok(())
}

fn load_installed_theme(
    package_dir: &Path,
    package: &PackageManifest,
    enabled: bool,
) -> Result<ThemePackSummary, String> {
    let dsh = package
        .dsh
        .as_ref()
        .ok_or_else(|| "主题包缺少 dsh 清单。".to_string())?;
    if dsh.protocol_version != Some(1) {
        return Err("主题包 protocolVersion 必须为 1。".to_string());
    }
    let client = dsh
        .client
        .as_ref()
        .ok_or_else(|| "主题包缺少 dsh.client。".to_string())?;
    if client.platform != "web" {
        return Err("主题包 client.platform 必须为 web。".to_string());
    }
    if !client
        .inject
        .iter()
        .any(|item| item == THEME_CLIENT_PACKAGE)
    {
        return Err(format!(
            "主题包 dsh.client.inject 必须包含 {THEME_CLIENT_PACKAGE}。"
        ));
    }
    let theme = dsh
        .theme
        .as_ref()
        .ok_or_else(|| "主题包缺少 dsh.theme。".to_string())?;
    validate_theme_manifest(theme)?;
    let market = dsh
        .market
        .as_ref()
        .ok_or_else(|| "主题包缺少 dsh.market。".to_string())?;
    if !market.capabilities.iter().any(|item| item == "theme-pack") {
        return Err("主题包必须声明 theme-pack capability。".to_string());
    }
    let root = package_dir
        .canonicalize()
        .map_err(|error| format!("主题包路径无法 canonicalize: {error}"))?;
    let entry = safe_join(&root, &theme.entry)?;
    let raw_theme = String::from_utf8(read_bounded(&entry, MAX_THEME_BYTES)?)
        .map_err(|_| "主题清单必须是 UTF-8。".to_string())?;
    let (tokens, raw_background) = validate_theme_file(&raw_theme)?;
    let theme_base = entry.parent().unwrap_or(root.as_path());
    let background = raw_background
        .map(|raw| resolve_background(&root, theme_base, raw))
        .transpose()?;
    let preview_url = theme
        .preview
        .as_deref()
        .map(|path| safe_join(&root, path).and_then(|file| image_data_url(&file)))
        .transpose()?;
    let supported = normalized_supported_appearances(&theme.supported_appearances)?;
    let appearance = read_theme_appearance(&entry)?;
    if !supported.iter().any(|item| item == &appearance) {
        return Err("主题 appearance 不在 supportedAppearances 中。".to_string());
    }
    Ok(ThemePackSummary {
        package_name: package.name.clone(),
        id: theme.id.clone(),
        display_name: market
            .display_name
            .clone()
            .unwrap_or_else(|| theme.display_name.clone()),
        version: package.version.clone(),
        description: package.description.clone(),
        source: "profile".to_string(),
        installed: true,
        enabled,
        protocol_compatible: true,
        appearance,
        supported_appearances: supported,
        preview_url,
        tokens,
        background,
        error: None,
    })
}

fn read_theme_appearance(entry: &Path) -> Result<String, String> {
    let raw = String::from_utf8(read_bounded(entry, MAX_THEME_BYTES)?)
        .map_err(|_| "主题清单必须是 UTF-8。".to_string())?;
    let file = serde_json::from_str::<ThemeFile>(&raw)
        .map_err(|error| format!("主题清单 JSON 无效: {error}"))?;
    Ok(file.appearance)
}

fn validate_theme_manifest(theme: &ThemeManifest) -> Result<(), String> {
    if theme.schema_version != THEME_SCHEMA_VERSION {
        return Err(format!(
            "不支持的 theme.schemaVersion: {}。",
            theme.schema_version
        ));
    }
    validate_theme_id(&theme.id)?;
    if theme.display_name.trim().is_empty() || theme.display_name.len() > MAX_STRING_LENGTH {
        return Err("主题 displayName 非法。".to_string());
    }
    if theme.entry.trim().is_empty() {
        return Err("主题 entry 不能为空。".to_string());
    }
    normalized_supported_appearances(&theme.supported_appearances)?;
    Ok(())
}

fn normalized_supported_appearances(values: &[String]) -> Result<Vec<String>, String> {
    let values = if values.is_empty() {
        vec!["dark".to_string()]
    } else {
        values.to_vec()
    };
    if values
        .iter()
        .any(|value| value != "dark" && value != "light")
    {
        return Err("supportedAppearances 只能包含 dark 或 light。".to_string());
    }
    let mut result = values;
    result.sort();
    result.dedup();
    Ok(result)
}

fn resolve_background(
    root: &Path,
    base: &Path,
    raw: RawBackground,
) -> Result<ThemeBackground, String> {
    if raw.targets.is_empty() {
        return Err("主题背景 targets 不能为空。".to_string());
    }
    for target in &raw.targets {
        if !matches!(
            target.as_str(),
            "desktop.home" | "desktop.market" | "web.shell"
        ) {
            return Err(format!("未知主题背景 target: {target}"));
        }
    }
    if raw.fit != "cover" && raw.fit != "contain" {
        return Err("主题背景 fit 只能是 cover 或 contain。".to_string());
    }
    if raw.position.is_empty() || raw.position.len() > 80 || raw.position.contains(';') {
        return Err("主题背景 position 非法。".to_string());
    }
    if !raw.opacity.is_finite() || !(0.0..=1.0).contains(&raw.opacity) {
        return Err("主题背景 opacity 必须在 0..1。".to_string());
    }
    if raw.blur != "0px" {
        validate_px_range("background.blur", &raw.blur, 0.0, 20.0)?;
    }
    validate_css_value("background.overlay", &raw.overlay)?;
    let image = safe_join_from(root, base, &raw.image)?;
    Ok(ThemeBackground {
        image_url: Some(image_data_url(&image)?),
        targets: raw.targets,
        fit: raw.fit,
        position: raw.position,
        opacity: raw.opacity,
        overlay: raw.overlay,
        blur: raw.blur,
        fixed: raw.fixed,
    })
}

fn validate_css_value(key: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_STRING_LENGTH
        || value
            .chars()
            .any(|ch| ch == '\0' || ch == ';' || ch == '{' || ch == '}' || ch == '<' || ch == '>')
        || value.to_ascii_lowercase().contains("url(")
        || value.to_ascii_lowercase().contains("@import")
        || value.to_ascii_lowercase().contains("!important")
    {
        return Err(format!("{key} 包含不安全的 CSS 值。"));
    }
    Ok(())
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\0')
        || relative.contains("://")
        || Path::new(relative).is_absolute()
    {
        return Err(format!("主题资源路径非法: {relative}"));
    }
    safe_join_from(root, root, relative)
}

fn safe_join_from(root: &Path, base: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\0')
        || relative.contains("://")
        || Path::new(relative).is_absolute()
    {
        return Err(format!("主题资源路径非法: {relative}"));
    }
    let relative_path = Path::new(relative);
    if relative_path
        .components()
        .any(|component| matches!(component, Component::RootDir | Component::Prefix(_)))
    {
        return Err(format!("主题资源路径不能越界: {relative}"));
    }
    let target = base.join(relative_path);
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("主题资源不存在: {relative}: {error}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("主题资源路径逃逸包目录: {relative}"));
    }
    Ok(canonical)
}

fn image_data_url(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取主题图片失败: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err("主题图片大小不在允许范围内。".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取主题图片失败: {error}"))?;
    let mime = image_mime(path, &bytes)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn image_mime(path: &Path, bytes: &[u8]) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (mime, valid_header) = match extension.as_str() {
        "png" => ("image/png", bytes.starts_with(b"\x89PNG\r\n\x1a\n")),
        "jpg" | "jpeg" => ("image/jpeg", bytes.starts_with(&[0xff, 0xd8, 0xff])),
        "webp" => (
            "image/webp",
            bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        ),
        _ => return Err("主题图片只支持 PNG、JPEG 和 WebP。".to_string()),
    };
    if !valid_header {
        return Err("主题图片文件头无效。".to_string());
    }
    if extension == "png" {
        if bytes.len() < 24 {
            return Err("主题 PNG 文件头不完整。".to_string());
        }
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap_or([0; 4]));
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap_or([0; 4]));
        if width == 0 || height == 0 || width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT {
            return Err("主题图片尺寸异常。".to_string());
        }
    }
    Ok(mime)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("主题文件大小超过限制。".to_string());
    }
    fs::read(path).map_err(|error| error.to_string())
}

fn profile_enabled_packages(profile: &Path) -> BTreeSet<String> {
    let Ok(raw) = fs::read(profile.join("package.json")) else {
        return BTreeSet::new();
    };
    let Ok(manifest) = serde_json::from_slice::<Value>(&raw) else {
        return BTreeSet::new();
    };
    manifest
        .pointer("/dsh/profile/bundles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn invalid_pack(package: &PackageManifest, enabled: bool, error: String) -> ThemePackSummary {
    ThemePackSummary {
        package_name: package.name.clone(),
        id: package.name.clone(),
        display_name: package.name.clone(),
        version: package.version.clone(),
        description: package.description.clone(),
        source: "profile".to_string(),
        installed: true,
        enabled,
        protocol_compatible: false,
        appearance: "dark".to_string(),
        supported_appearances: Vec::new(),
        preview_url: None,
        tokens: BTreeMap::new(),
        background: None,
        error: Some(error),
    }
}

fn builtin_default() -> ThemePackSummary {
    ThemePackSummary {
        package_name: DEFAULT_SKIN_ID.to_string(),
        id: DEFAULT_SKIN_ID.to_string(),
        display_name: "默认主题".to_string(),
        version: "builtin".to_string(),
        description: "DSH Desktop 内建安全默认主题。".to_string(),
        source: "builtin".to_string(),
        installed: true,
        enabled: true,
        protocol_compatible: true,
        appearance: "light".to_string(),
        supported_appearances: vec!["dark".to_string(), "light".to_string()],
        preview_url: None,
        tokens: BTreeMap::new(),
        background: None,
        error: None,
    }
}

fn default_fit() -> String {
    "cover".to_string()
}

fn default_position() -> String {
    "center".to_string()
}

fn default_opacity() -> f32 {
    DEFAULT_BACKGROUND_INTENSITY
}

fn default_overlay() -> String {
    "rgba(1, 4, 15, 0.62)".to_string()
}

fn default_blur() -> String {
    "0px".to_string()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_neon_theme_file_section_namespaces() {
        let raw = include_str!("../../market/neon-agent-theme/theme/theme.json");
        let (tokens, _) = validate_theme_file(raw).expect("the published theme shape is valid");
        assert!(tokens.contains_key("desktop.titlebar.background"));
        assert!(tokens.contains_key("web.conversation.surface"));
        assert!(tokens.contains_key("web.sidebar.surface"));
        assert!(tokens.contains_key("components.button.radius"));
        assert!(tokens
            .keys()
            .all(|key| ALLOWED_TOKENS.contains(&key.as_str())));
    }

    #[test]
    fn rejects_css_escape_hatches_and_layout_like_tokens() {
        assert!(validate_theme_file(
            r#"{"schemaVersion":1,"appearance":"dark","tokens":{"shared":{"color.text.primary":"red; color:blue"}}}"#
        )
        .is_err());
        assert!(validate_theme_file(
            r#"{"schemaVersion":1,"appearance":"dark","tokens":{"shared":{"layout.display":"block"}}}"#
        )
        .is_err());
        assert!(validate_theme_file(
            r#"{"schemaVersion":1,"appearance":"dark","tokens":{"shared":{"color.text.primary":"url(https://example.com/a)"}}}"#
        )
        .is_err());
    }

    #[test]
    fn rejects_theme_path_escape() {
        let root = std::env::temp_dir().join("dsh-theme-test-root");
        assert!(safe_join(&root, "../outside.png").is_err());
        assert!(safe_join(&root, "https://example.com/bg.png").is_err());
    }

    #[test]
    fn discovers_an_enabled_installed_theme_from_the_web_profile() {
        let root = std::env::temp_dir().join(format!("dsh-theme-profile-{}", std::process::id()));
        let package = root
            .join("profiles")
            .join("web")
            .join("node_modules")
            .join("@p-dsh-market")
            .join("test-theme");
        fs::create_dir_all(package.join("theme")).expect("create test theme");
        fs::write(
            root.join("profiles").join("web").join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@p-dsh-market/test-theme"]}},"dependencies":{"@p-dsh-market/test-theme":"1.0.0"}}"#,
        )
        .expect("write profile manifest");
        fs::write(
            package.join("package.json"),
            r#"{"name":"@p-dsh-market/test-theme","version":"1.0.0","description":"test","dsh":{"protocolVersion":1,"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-theme"]},"market":{"displayName":"Test Theme","capabilities":["skills","host","client","theme-pack"]},"theme":{"schemaVersion":1,"id":"test-theme","displayName":"Test Theme","entry":"./theme/theme.json","supportedAppearances":["dark"]}}}"#,
        )
        .expect("write package manifest");
        fs::write(
            package.join("theme").join("theme.json"),
            r##"{"schemaVersion":1,"appearance":"dark","tokens":{"shared":{"color.text.primary":"#FFFFFF"}}}"##,
        )
        .expect("write theme manifest");

        let packs = list_theme_packs(&root).expect("list themes");
        let test_pack = packs
            .iter()
            .find(|pack| pack.id == "test-theme")
            .expect("discover installed theme");
        assert!(test_pack.installed);
        assert!(test_pack.enabled);
        assert!(test_pack.protocol_compatible);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn does_not_expose_uninstalled_or_disabled_themes_as_builtins() {
        let empty_root =
            std::env::temp_dir().join(format!("dsh-theme-empty-profile-{}", std::process::id()));
        fs::create_dir_all(&empty_root).expect("create empty root");
        let packs = list_theme_packs(&empty_root).expect("list empty themes");
        assert_eq!(packs.len(), 1);
        assert_eq!(packs[0].id, DEFAULT_SKIN_ID);
        let _ = fs::remove_dir_all(empty_root);

        let root =
            std::env::temp_dir().join(format!("dsh-theme-disabled-profile-{}", std::process::id()));
        let package = root
            .join("profiles")
            .join("web")
            .join("node_modules")
            .join("@p-dsh-market")
            .join("disabled-theme");
        fs::create_dir_all(package.join("theme")).expect("create disabled theme");
        fs::write(
            root.join("profiles").join("web").join("package.json"),
            r#"{"dsh":{"profile":{"bundles":[]}},"dependencies":{"@p-dsh-market/disabled-theme":"1.0.0"}}"#,
        )
        .expect("write disabled profile manifest");
        fs::write(
            package.join("package.json"),
            r#"{"name":"@p-dsh-market/disabled-theme","version":"1.0.0","description":"test","dsh":{"protocolVersion":1,"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-theme"]},"market":{"displayName":"Disabled Theme","capabilities":["skills","host","client","theme-pack"]},"theme":{"schemaVersion":1,"id":"disabled-theme","displayName":"Disabled Theme","entry":"./theme/theme.json","supportedAppearances":["dark"]}}}"#,
        )
        .expect("write disabled package manifest");
        fs::write(
            package.join("theme").join("theme.json"),
            r##"{"schemaVersion":1,"appearance":"dark","tokens":{"shared":{"color.text.primary":"#FFFFFF"}}}"##,
        )
        .expect("write disabled theme manifest");
        let packs = list_theme_packs(&root).expect("list disabled themes");
        let disabled = packs
            .iter()
            .find(|pack| pack.id == "disabled-theme")
            .expect("discover installed disabled theme");
        assert!(disabled.installed);
        assert!(!disabled.enabled);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_package_relative_backgrounds_from_installed_pack() {
        let root = std::env::temp_dir().join(format!(
            "dsh-theme-relative-background-{}",
            std::process::id()
        ));
        let package = root
            .join("profiles")
            .join("web")
            .join("node_modules")
            .join("@p-dsh-market")
            .join("neon-agent-theme");
        fs::create_dir_all(package.join("theme")).expect("create test theme");
        fs::create_dir_all(package.join("assets")).expect("create test assets");
        fs::write(
            root.join("profiles").join("web").join("package.json"),
            r#"{"dsh":{"profile":{"bundles":["@p-dsh-market/neon-agent-theme"]}},"dependencies":{"@p-dsh-market/neon-agent-theme":"0.2.0"}}"#,
        )
        .expect("write profile manifest");
        fs::write(
            package.join("package.json"),
            r#"{"name":"@p-dsh-market/neon-agent-theme","version":"0.2.0","description":"test","dsh":{"protocolVersion":1,"client":{"platform":"web","inject":["@deepseek-ai/dsh-client-ui-theme"]},"market":{"displayName":"Neon Agent","capabilities":["skills","host","client","theme-pack"]},"theme":{"schemaVersion":1,"id":"neon-agent","displayName":"Neon Agent","entry":"./theme/theme.json","supportedAppearances":["dark"]}}}"#,
        )
        .expect("write package manifest");
        fs::write(
            package.join("theme").join("theme.json"),
            r##"{"schemaVersion":1,"appearance":"dark","tokens":{"shared":{"color.text.primary":"#FFFFFF"}},"background":{"image":"../assets/background.png","targets":["desktop.home"],"opacity":0.2}}"##,
        )
        .expect("write theme manifest");
        let mut png = vec![0_u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&1_u32.to_be_bytes());
        png[20..24].copy_from_slice(&1_u32.to_be_bytes());
        fs::write(package.join("assets").join("background.png"), png).expect("write image");

        let packs = list_theme_packs(&root).expect("list themes");
        let neon = packs
            .iter()
            .find(|pack| pack.id == "neon-agent")
            .expect("find neon theme");
        assert_eq!(neon.source, "profile");
        assert_eq!(neon.version, "0.2.0");
        assert!(neon.background.as_ref().is_some_and(|background| {
            background
                .image_url
                .as_deref()
                .is_some_and(|url| url.starts_with("data:image/png"))
        }));
        validate_installed_theme_package(&root, "@p-dsh-market/neon-agent-theme")
            .expect("installed theme should pass validation");
        let _ = fs::remove_dir_all(root);
    }
}
