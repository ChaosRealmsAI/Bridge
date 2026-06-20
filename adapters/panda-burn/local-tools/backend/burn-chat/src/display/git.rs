use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

pub(crate) fn git_status_snapshot(project: &Path) -> Result<HashMap<String, String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project)
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-z")
        .output()
        .with_context(|| "failed to run git status")?;
    if !output.status.success() {
        bail!("git status failed");
    }
    let mut snapshot = HashMap::new();
    for raw in output.stdout.split(|byte| *byte == 0) {
        if raw.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&raw[..2]).trim().to_string();
        let path = String::from_utf8_lossy(&raw[3..]).trim().to_string();
        if !path.is_empty() {
            snapshot.insert(path, status);
        }
    }
    Ok(snapshot)
}
