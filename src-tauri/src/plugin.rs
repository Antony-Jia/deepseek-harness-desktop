use std::{
    fs, io,
    path::{Path, PathBuf},
};

const PLUGIN_NAME: &str = "dsh-desktop-bridge";
const DESKTOP_BEGIN: &str = "# BEGIN DSH Desktop integration";
const DESKTOP_END: &str = "# END DSH Desktop integration";
const LEGACY_DESKTOP_MARKER: &str = "# Added by DSH Desktop";

pub fn ensure_profile_plugin(source: Option<&Path>, dsh_home: &Path) -> Result<bool, String> {
    let Some(source) = source.filter(|path| path.is_dir()) else {
        return Ok(false);
    };
    let profile = dsh_home.join("profiles").join("web");
    let target = profile.join("node_modules").join(PLUGIN_NAME);
    if !target.exists() {
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| "插件目标目录没有父目录".to_string())?,
        )
        .map_err(io_error)?;
        copy_dir(source, &target).map_err(io_error)?;
    }
    let patch_path = profile.join("cordis.patch.yml");
    let existing = fs::read_to_string(&patch_path).unwrap_or_default();
    let mut content = remove_desktop_overlay(&existing);
    if !content.is_empty() {
        content.push_str("\n\n");
    }
    content.push_str(&format!(
        "{DESKTOP_BEGIN}\n- insert:\n    - id: {PLUGIN_NAME}\n      name: {PLUGIN_NAME}\n      inject: [sessions, webServer]\n{DESKTOP_END}\n"
    ));
    if content != existing {
        atomic_write(&patch_path, content.as_bytes()).map_err(io_error)?;
    }
    Ok(true)
}

fn remove_desktop_overlay(existing: &str) -> String {
    let mut content = existing.to_string();
    while let Some(start) = content.find(DESKTOP_BEGIN) {
        let after_start = start + DESKTOP_BEGIN.len();
        let end = content[after_start..]
            .find(DESKTOP_END)
            .map(|offset| after_start + offset + DESKTOP_END.len())
            .unwrap_or(content.len());
        content.replace_range(start..end, "");
    }
    while let Some(start) = content.find(LEGACY_DESKTOP_MARKER) {
        let after_start = start + LEGACY_DESKTOP_MARKER.len();
        let end = content[after_start..]
            .find("\n# ")
            .map(|offset| after_start + offset + 1)
            .unwrap_or(content.len());
        content.replace_range(start..end, "");
    }
    remove_desktop_insert_entries(&content).trim().to_string()
}

fn remove_desktop_insert_entries(content: &str) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let mut kept = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if lines[index] == "- insert:" {
            let mut end = index + 1;
            while end < lines.len()
                && !is_top_level_entry(lines[end])
                && !lines[end].starts_with("# ")
            {
                end += 1;
            }
            let block = lines[index..end].join("\n");
            if !block.contains(&format!("id: {PLUGIN_NAME}")) {
                kept.extend_from_slice(&lines[index..end]);
            }
            index = end;
            continue;
        }
        kept.push(lines[index]);
        index += 1;
    }
    kept.join("\n")
}

fn is_top_level_entry(line: &str) -> bool {
    line.starts_with("- ") && !line.starts_with("  ")
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
    use super::remove_desktop_overlay;

    #[test]
    fn removes_legacy_malformed_desktop_overlay() {
        let input = "# user patch\n- insert:\n    - id: open-workspace\n      name: dsh-open-workspace\n\n# Added by DSH Desktop; remove this block to disable native desktop integration.\n- insert:\n- id: dsh-desktop-bridge\nname: dsh-desktop-bridge\ninject: [sessions]\n";
        let cleaned = remove_desktop_overlay(input);
        assert!(cleaned.contains("id: open-workspace"));
        assert!(!cleaned.contains("Added by DSH Desktop"));
        assert!(!cleaned.contains("id: dsh-desktop-bridge"));
    }

    #[test]
    fn removes_previous_valid_desktop_overlay_before_rebuilding() {
        let input = "- insert:\n    - id: dsh-desktop-bridge\n      name: dsh-desktop-bridge\n      inject: [sessions]\n";
        let cleaned = remove_desktop_overlay(input);
        assert!(cleaned.is_empty());
    }
}
