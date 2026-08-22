use crate::state::{PersistedState, RuntimeSummary};
use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    fs,
    io::{self, BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct RuntimeManager {
    runtimes_dir: PathBuf,
    node_dir: PathBuf,
    logs_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RegistryInfo {
    pub latest: String,
    pub versions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LocalRuntime {
    pub version: String,
    pub command: PathBuf,
}

impl RuntimeManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            runtimes_dir: base_dir.join("runtimes"),
            node_dir: base_dir.join("node"),
            logs_dir: base_dir.join("logs"),
        }
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub fn ensure_layout(&self) -> io::Result<()> {
        fs::create_dir_all(&self.runtimes_dir)?;
        fs::create_dir_all(&self.logs_dir)?;
        Ok(())
    }

    pub fn runtime_path(&self, version: &str) -> Result<PathBuf, String> {
        validate_version(version)?;
        Ok(self.runtimes_dir.join(version))
    }

    pub fn dsh_bin(&self, version: &str) -> Result<PathBuf, String> {
        Ok(self
            .runtime_path(version)?
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"))
    }

    pub fn is_ready(&self, version: &str) -> bool {
        self.dsh_bin(version)
            .map(|path| path.is_file())
            .unwrap_or(false)
    }

    pub fn node_command(&self) -> PathBuf {
        let portable = self
            .node_dir
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        if portable.is_file() {
            portable
        } else if cfg!(windows) {
            PathBuf::from("node.exe")
        } else {
            PathBuf::from("node")
        }
    }

    pub fn npx_command(&self) -> PathBuf {
        let portable = self
            .node_dir
            .join(if cfg!(windows) { "npx.cmd" } else { "npx" });
        if portable.is_file() {
            portable
        } else if cfg!(windows) {
            PathBuf::from("npx.cmd")
        } else {
            PathBuf::from("npx")
        }
    }

    pub fn mcp_npx_command(&self) -> (PathBuf, Vec<String>) {
        let cli = self
            .node_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npx-cli.js");
        if cli.is_file() {
            (self.node_command(), vec![cli.to_string_lossy().to_string()])
        } else {
            (self.npx_command(), Vec::new())
        }
    }

    pub fn npm_command(&self) -> (PathBuf, Option<PathBuf>) {
        let node = self.node_command();
        let portable_cli = self
            .node_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");
        if node != PathBuf::from("node.exe")
            && node != PathBuf::from("node")
            && portable_cli.is_file()
        {
            (node, Some(portable_cli))
        } else if cfg!(windows) {
            (PathBuf::from("npm.cmd"), None)
        } else {
            (PathBuf::from("npm"), None)
        }
    }

    pub fn detect_local(&self) -> Option<LocalRuntime> {
        let command = npx_command();
        let mut probe = Command::new(&command);
        hide_console_window(&mut probe);
        let output = probe
            .args(["--no-install", "@deepseek-ai/dsh", "--version"])
            .env("npm_config_update_notifier", "false")
            .env("npm_config_fund", "false")
            .env("npm_config_audit", "false")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let version = parse_version_output(&output.stdout)
            .or_else(|| parse_version_output(&output.stderr))?;
        Some(LocalRuntime { version, command })
    }

    pub async fn detect_local_async(&self) -> Option<LocalRuntime> {
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || manager.detect_local())
            .await
            .ok()
            .flatten()
    }

    pub fn ensure_bundled_node(&self, source: Option<&Path>) -> Result<bool, String> {
        let target = &self.node_dir;
        let executable = target.join(if cfg!(windows) { "node.exe" } else { "node" });
        if executable.is_file() {
            return Ok(false);
        }
        let Some(source) = source.filter(|path| path.is_dir()) else {
            return Ok(false);
        };
        let source_executable = source.join(if cfg!(windows) { "node.exe" } else { "node" });
        if !source_executable.is_file() {
            return Ok(false);
        }
        let staging = self
            .runtimes_dir
            .parent()
            .unwrap_or(&self.runtimes_dir)
            .join(format!(".node.partial-{}", Uuid::new_v4().simple()));
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(io_error)?;
        }
        copy_dir(source, &staging).map_err(io_error)?;
        if target.exists() {
            fs::remove_dir_all(target).map_err(io_error)?;
        }
        fs::rename(staging, target).map_err(io_error)?;
        Ok(true)
    }

    pub fn list_installed(&self) -> io::Result<Vec<RuntimeSummary>> {
        self.ensure_layout()?;
        let mut versions = Vec::new();
        for entry in fs::read_dir(&self.runtimes_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type()?.is_dir() || name.starts_with('.') || name.contains(".partial-") {
                continue;
            }
            if validate_version(&name).is_err() {
                continue;
            }
            versions.push(RuntimeSummary {
                ready: self.is_ready(&name),
                installed: true,
                version: name,
            });
        }
        versions.sort_by(|a, b| compare_versions(&b.version, &a.version));
        Ok(versions)
    }

    pub fn install<F>(&self, version: &str, mut on_output: F) -> Result<(), String>
    where
        F: FnMut(String) + Send,
    {
        validate_version(version)?;
        self.ensure_layout().map_err(io_error)?;
        if self.is_ready(version) {
            on_output(format!("运行时 {version} 已安装，跳过下载。"));
            return Ok(());
        }

        let target = self.runtime_path(version)?;
        let partial = self
            .runtimes_dir
            .join(format!(".{version}.partial-{}", Uuid::new_v4().simple()));
        if partial.exists() {
            fs::remove_dir_all(&partial).map_err(io_error)?;
        }
        fs::create_dir_all(&partial).map_err(io_error)?;
        let manifest = json!({
            "name": "dsh-desktop-runtime",
            "private": true,
            "dependencies": { "@deepseek-ai/dsh": version }
        });
        fs::write(
            partial.join("package.json"),
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(io_error)?;

        let (program, npm_cli) = self.npm_command();
        let mut command = Command::new(program);
        hide_console_window(&mut command);
        if let Some(cli) = npm_cli {
            command.arg(cli);
        }
        command
            .args([
                "install",
                "--prefix",
                partial.to_string_lossy().as_ref(),
                "--no-audit",
                "--no-fund",
                "--loglevel=info",
            ])
            .arg(format!("@deepseek-ai/dsh@{version}"))
            .env("npm_config_update_notifier", "false")
            .env("npm_config_fund", "false")
            .env("npm_config_audit", "false")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        on_output(format!("开始安装 @deepseek-ai/dsh@{version} …"));
        let mut child = command.spawn().map_err(|error| {
            format!(
                "无法启动 npm（使用 {}）：{error}",
                self.node_command().display()
            )
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(output) = stdout {
            spawn_output_reader(output, tx.clone());
        }
        if let Some(output) = stderr {
            spawn_output_reader(output, tx.clone());
        }
        drop(tx);
        let status = loop {
            while let Ok(line) = rx.try_recv() {
                on_output(line);
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(std::time::Duration::from_millis(80)),
                Err(error) => {
                    let _ = child.kill();
                    return Err(format!("读取 npm 状态失败: {error}"));
                }
            }
        };
        while let Ok(line) = rx.try_recv() {
            on_output(line);
        }
        if !status.success() {
            let _ = fs::remove_dir_all(&partial);
            return Err(format!("npm install 失败，退出码 {:?}", status.code()));
        }
        if !self.is_ready_in(&partial) {
            let _ = fs::remove_dir_all(&partial);
            return Err("npm install 完成，但找不到 dsh/lib/bin.js".to_string());
        }
        if target.exists() {
            fs::remove_dir_all(&target).map_err(io_error)?;
        }
        fs::rename(&partial, &target).map_err(io_error)?;
        on_output(format!("运行时 {version} 安装完成。"));
        Ok(())
    }

    pub fn registry_info(&self) -> Result<RegistryInfo, String> {
        let response = ureq::get("https://registry.npmjs.org/@deepseek-ai/dsh")
            .call()
            .map_err(|error| format!("访问 npm registry 失败: {error}"))?;
        let payload = response
            .into_string()
            .map_err(|error| format!("读取 npm registry 响应失败: {error}"))?;
        let value: Value = serde_json::from_str(&payload)
            .map_err(|error| format!("解析 npm registry 响应失败: {error}"))?;
        let latest = value
            .get("dist-tags")
            .and_then(|tags| tags.get("latest"))
            .and_then(Value::as_str)
            .ok_or_else(|| "npm registry 响应缺少 dist-tags.latest".to_string())?
            .to_string();
        let mut versions = value
            .get("versions")
            .and_then(Value::as_object)
            .map(|items| items.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        versions.sort_by(|a, b| compare_versions(b, a));
        Ok(RegistryInfo { latest, versions })
    }

    pub async fn registry_info_async(&self) -> Result<RegistryInfo, String> {
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || manager.registry_info())
            .await
            .map_err(|error| format!("检查上游版本失败: {error}"))?
    }

    pub fn cleanup(&self, state: &PersistedState, keep: usize) -> Result<Vec<String>, String> {
        let mut candidates = self
            .list_installed()
            .map_err(io_error)?
            .into_iter()
            .map(|item| item.version)
            .collect::<Vec<_>>();
        let mut preserve = vec![state.pinned.clone()];
        if let Some(last_good) = &state.last_good {
            preserve.push(last_good.clone());
        }
        candidates.sort_by(|a, b| compare_versions(b, a));
        for version in candidates.iter().take(keep) {
            preserve.push(version.clone());
        }
        preserve.sort();
        preserve.dedup();
        let mut removed = Vec::new();
        for version in candidates {
            if preserve.iter().any(|item| item == &version) {
                continue;
            }
            let path = self.runtime_path(&version)?;
            if path.exists() {
                fs::remove_dir_all(path).map_err(io_error)?;
                removed.push(version);
            }
        }
        Ok(removed)
    }

    pub fn remove(&self, version: &str) -> Result<(), String> {
        validate_version(version)?;
        let path = self.runtime_path(version)?;
        if !path.is_dir() {
            return Err(format!("运行时 {version} 未安装。"));
        }
        fs::remove_dir_all(path).map_err(io_error)
    }

    fn is_ready_in(&self, root: &Path) -> bool {
        root.join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
            .is_file()
    }
}

fn spawn_output_reader<R>(output: R, tx: mpsc::Sender<String>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
}

pub fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty()
        || version.len() > 128
        || version == "."
        || version == ".."
        || version
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+')))
    {
        return Err(format!("非法运行时版本: {version}"));
    }
    Ok(())
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn npx_command() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("npx.cmd")
    } else {
        PathBuf::from("npx")
    }
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

fn parse_version_output(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch: char| {
                    !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+'))
                })
                .trim_start_matches('v')
                .to_string()
        })
        .find(|candidate| {
            candidate
                .chars()
                .next()
                .map(|ch| ch.is_ascii_digit())
                .unwrap_or(false)
                && validate_version(candidate).is_ok()
        })
}

fn copy_dir(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path)?;
        }
    }
    Ok(())
}

#[derive(Debug, Eq, PartialEq)]
struct VersionKey {
    numbers: Vec<u64>,
    prerelease: Option<String>,
}

fn parse_version(version: &str) -> VersionKey {
    let trimmed = version.trim_start_matches('v');
    let (core, prerelease) = trimmed
        .split_once('-')
        .map(|(left, right)| (left, Some(right.to_string())))
        .unwrap_or((trimmed, None));
    VersionKey {
        numbers: core
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect(),
        prerelease,
    }
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let a = parse_version(left);
    let b = parse_version(right);
    a.numbers
        .cmp(&b.numbers)
        .then_with(|| match (&a.prerelease, &b.prerelease) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(x), Some(y)) => x.cmp(y),
        })
}

#[cfg(test)]
mod tests {
    use super::{compare_versions, validate_version};
    use std::cmp::Ordering;

    #[test]
    fn accepts_npm_prerelease_versions() {
        assert!(validate_version("0.1.0-rc.6").is_ok());
        assert!(validate_version("1.2.3").is_ok());
    }

    #[test]
    fn rejects_path_traversal_and_shell_characters() {
        assert!(validate_version("../latest").is_err());
        assert!(validate_version("1.0.0/../../x").is_err());
        assert!(validate_version("1.0.0;whoami").is_err());
    }

    #[test]
    fn release_sorts_after_prerelease() {
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc.1"), Ordering::Greater);
        assert_eq!(
            compare_versions("0.1.0-rc.7", "0.1.0-rc.6"),
            Ordering::Greater
        );
    }

    #[test]
    fn parses_local_dsh_version_output() {
        assert_eq!(
            super::parse_version_output(b"0.1.0-rc.6\r\n"),
            Some("0.1.0-rc.6".to_string())
        );
        assert_eq!(
            super::parse_version_output(b"npm warn something\nv0.2.0\n"),
            Some("0.2.0".to_string())
        );
        assert_eq!(super::parse_version_output(b"command not found\n"), None);
    }
}
