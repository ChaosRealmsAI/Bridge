use std::path::{Path, PathBuf};

use super::{NetPolicy, SandboxError, SandboxProfileKind, SandboxSpec};

pub fn render(spec: &SandboxSpec) -> Result<String, SandboxError> {
    match spec.profile {
        SandboxProfileKind::CodexWorkspace => render_codex_workspace(spec),
        SandboxProfileKind::DataKvDir => render_data_kv_dir(spec),
        SandboxProfileKind::FsReadDir => render_fs_read_dir(spec),
    }
}

fn render_codex_workspace(spec: &SandboxSpec) -> Result<String, SandboxError> {
    if spec.cwd.as_os_str().is_empty() {
        return render_error("codex sandbox cwd is empty");
    }
    if spec.write_roots.is_empty() {
        return render_error("codex sandbox requires a write root");
    }
    if spec.exec_allow.is_empty() {
        return render_error("codex sandbox requires at least one exec allow path");
    }
    let home = home_dir()?;
    let codex_home = codex_home(&home);
    let read_roots = unique_paths(spec.read_roots.iter().chain([&codex_home]));
    let write_roots = unique_paths(spec.write_roots.iter());
    let exec_paths = unique_paths(spec.exec_allow.iter());
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str("(deny default)\n");
    out.push_str("(import \"system.sb\")\n\n");
    out.push_str("(allow file-read-metadata)\n");
    out.push_str("(allow file-read*\n");
    out.push_str("  (subpath \"/System\")\n");
    out.push_str("  (subpath \"/usr/lib\")\n");
    out.push_str("  (subpath \"/usr/share\")\n");
    out.push_str("  (subpath \"/Library/Preferences\")\n");
    out.push_str("  (subpath \"/private/etc\")\n");
    out.push_str("  (literal \"/etc\")\n");
    out.push_str("  (literal \"/dev/null\")\n");
    out.push_str("  (literal \"/dev/urandom\")\n");
    out.push_str("  (literal \"/dev/random\")\n");
    for path in &read_roots {
        out.push_str(&format!("  (subpath {})\n", sb_string(path)));
    }
    for path in &exec_paths {
        out.push_str(&format!("  (literal {})\n", sb_string(path)));
        if let Some(parent) = path.parent() {
            out.push_str(&format!("  (subpath {})\n", sb_string(parent)));
        }
    }
    out.push_str(")\n");
    out.push_str("(allow file-write*\n");
    for path in &write_roots {
        out.push_str(&format!("  (subpath {})\n", sb_string(path)));
    }
    out.push_str("  (literal \"/dev/null\")\n");
    out.push_str(")\n");
    out.push_str("(allow file-write-data (literal \"/dev/stdout\") (literal \"/dev/stderr\"))\n\n");
    render_sensitive_denies(&mut out, &home);
    out.push('\n');
    out.push_str("(allow process-fork)\n");
    out.push_str("(allow process-exec\n");
    for path in &exec_paths {
        out.push_str(&format!("  (literal {})\n", sb_string(path)));
    }
    out.push_str(")\n");
    out.push_str("(deny process-exec)\n\n");
    render_net(&mut out, spec.net);
    out.push('\n');
    out.push_str("(allow mach-lookup\n");
    out.push_str("  (global-name \"com.apple.SecurityServer\")\n");
    out.push_str("  (global-name \"com.apple.system.notification_center\")\n");
    out.push_str("  (global-name \"com.apple.cfprefsd.agent\")\n");
    out.push_str("  (global-name \"com.apple.cfprefsd.daemon\")\n");
    out.push_str(")\n");
    Ok(out)
}

fn render_data_kv_dir(spec: &SandboxSpec) -> Result<String, SandboxError> {
    let db_dir = spec
        .write_roots
        .first()
        .or_else(|| spec.read_roots.first())
        .ok_or_else(|| SandboxError::ProfileRenderFailed {
            reason: "data sandbox requires a db dir".to_string(),
        })?;
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str("(deny default)\n");
    out.push_str("(import \"system.sb\")\n");
    out.push_str("(allow file-read-metadata)\n");
    out.push_str("(allow file-read*\n");
    out.push_str("  (subpath \"/System\")\n");
    out.push_str("  (subpath \"/usr/lib\")\n");
    out.push_str("  (literal \"/dev/urandom\")\n");
    out.push_str(&format!("  (subpath {})\n", sb_string(db_dir)));
    out.push_str(")\n");
    out.push_str("(allow file-write*\n");
    out.push_str(&format!("  (subpath {})\n", sb_string(db_dir)));
    out.push_str(")\n");
    out.push_str("(deny network*)\n");
    out.push_str("(deny process-exec)\n");
    out.push_str("(deny process-fork)\n");
    Ok(out)
}

fn render_fs_read_dir(spec: &SandboxSpec) -> Result<String, SandboxError> {
    if spec.read_roots.is_empty() {
        return render_error("fs.read sandbox requires at least one read root");
    }
    let cat = PathBuf::from("/bin/cat");
    let exec_paths = unique_paths(spec.exec_allow.iter());
    if exec_paths != vec![cat.clone()] {
        return render_error("fs.read sandbox only allows /bin/cat exec");
    }
    let home = home_dir()?;
    let read_roots = unique_paths(spec.read_roots.iter());
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str("(deny default)\n");
    out.push_str("(import \"system.sb\")\n");
    out.push_str("(allow file-read-metadata)\n");
    out.push_str("(allow file-read*\n");
    out.push_str("  (subpath \"/System\")\n");
    out.push_str("  (subpath \"/usr/lib\")\n");
    out.push_str("  (literal \"/dev/null\")\n");
    out.push_str("  (literal \"/dev/urandom\")\n");
    out.push_str(&format!("  (literal {})\n", sb_string(&cat)));
    for path in &read_roots {
        out.push_str(&format!("  (subpath {})\n", sb_string(path)));
    }
    out.push_str(")\n");
    render_sensitive_denies(&mut out, &home);
    out.push_str(&format!(
        "(deny file-read* (subpath {}))\n",
        sb_string(home.join("Library/Keychains"))
    ));
    out.push_str(&format!(
        "(deny file-write* (subpath {}))\n",
        sb_string(home.join("Library/Keychains"))
    ));
    out.push_str("(deny network*)\n");
    out.push_str("(allow process-exec\n");
    out.push_str(&format!("  (literal {})\n", sb_string(&cat)));
    out.push_str(")\n");
    out.push_str("(deny process-exec)\n");
    out.push_str("(deny process-fork)\n");
    Ok(out)
}

fn render_net(out: &mut String, net: NetPolicy) {
    match net {
        NetPolicy::Deny => out.push_str("(deny network*)\n"),
        NetPolicy::AllowOutbound => {
            out.push_str("(allow network-outbound)\n");
            out.push_str("(deny network-inbound)\n");
        }
    }
}

fn render_sensitive_denies(out: &mut String, home: &Path) {
    out.push_str(&format!(
        "(deny file-read* (subpath {}))\n",
        sb_string(home.join(".ssh"))
    ));
    out.push_str(&format!(
        "(deny file-read* (subpath {}))\n",
        sb_string(home.join(".aws"))
    ));
    out.push_str(&format!(
        "(deny file-write* (subpath {}))\n",
        sb_string(home.join(".ssh"))
    ));
    out.push_str(&format!(
        "(deny file-write* (subpath {}))\n",
        sb_string(home.join(".aws"))
    ));
}

fn unique_paths<'a>(paths: impl IntoIterator<Item = &'a PathBuf>) -> Vec<PathBuf> {
    let mut values = paths
        .into_iter()
        .filter(|path| !path.as_os_str().is_empty())
        .cloned()
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn home_dir() -> Result<PathBuf, SandboxError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| SandboxError::ProfileRenderFailed {
            reason: "HOME is not set".to_string(),
        })
}

fn codex_home(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".codex"))
}

fn render_error<T>(reason: &str) -> Result<T, SandboxError> {
    Err(SandboxError::ProfileRenderFailed {
        reason: reason.to_string(),
    })
}

pub fn sb_string(path: impl AsRef<Path>) -> String {
    let text = path.as_ref().to_string_lossy();
    let mut escaped = String::with_capacity(text.len() + 2);
    escaped.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped.push('"');
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::sandbox::{ResourceLimits, SandboxSpec};
    use std::process::Command;

    fn spec(exec_allow: Vec<PathBuf>) -> SandboxSpec {
        let cwd = std::env::temp_dir().join("panda-bridge-sandbox-render-test");
        SandboxSpec {
            profile: SandboxProfileKind::CodexWorkspace,
            read_roots: vec![cwd.clone()],
            write_roots: vec![cwd.clone()],
            exec_allow,
            net: NetPolicy::Deny,
            limits: ResourceLimits::codex_default(),
            env_allow: Vec::new(),
            cwd,
        }
    }

    #[test]
    fn codex_profile_is_deny_by_default() {
        let profile = render(&spec(vec![PathBuf::from("/usr/bin/true")])).unwrap();
        assert!(profile.starts_with("(version 1)\n(deny default)\n"));
        assert!(profile.contains("(deny process-exec)"));
        assert!(!profile.contains("(allow default)"));
    }

    #[test]
    fn codex_profile_denies_sensitive_home_paths() {
        let profile = render(&spec(vec![PathBuf::from("/usr/bin/true")])).unwrap();
        assert!(profile.contains("/.ssh"));
        assert!(profile.contains("/.aws"));
        assert!(profile.contains("(deny file-read*"));
    }

    #[test]
    fn codex_profile_only_allows_declared_exec_paths() {
        let profile = render(&spec(vec![PathBuf::from("/usr/bin/true")])).unwrap();
        assert!(profile.contains("(allow process-exec"));
        assert!(profile.contains("(literal \"/usr/bin/true\")"));
        assert!(profile.contains("(deny process-exec)"));
        assert!(!profile.contains("(literal \"/bin/sh\")"));
    }

    #[test]
    fn net_deny_renders_without_outbound_allow() {
        let profile = render(&spec(vec![PathBuf::from("/usr/bin/true")])).unwrap();
        assert!(profile.contains("(deny network*)"));
        assert!(!profile.contains("(allow network-outbound)"));
    }

    #[test]
    fn net_allow_outbound_renders_two_tier_network_policy() {
        let mut sandbox = spec(vec![PathBuf::from("/usr/bin/true")]);
        sandbox.net = NetPolicy::AllowOutbound;
        let profile = render(&sandbox).unwrap();
        assert!(profile.contains("(allow network-outbound)"));
        assert!(profile.contains("(deny network-inbound)"));
    }

    #[test]
    fn fs_read_profile_is_deny_by_default_read_only_and_cat_only() {
        let root = std::env::temp_dir().join("panda-bridge-fs-profile-render-test");
        let profile = render(&SandboxSpec {
            profile: SandboxProfileKind::FsReadDir,
            read_roots: vec![root.clone()],
            write_roots: Vec::new(),
            exec_allow: vec![PathBuf::from("/bin/cat")],
            net: NetPolicy::Deny,
            limits: ResourceLimits::fs_read_default(),
            env_allow: Vec::new(),
            cwd: root,
        })
        .unwrap();
        assert!(profile.starts_with("(version 1)\n(deny default)\n"));
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(allow process-exec\n  (literal \"/bin/cat\")\n)"));
        assert!(profile.contains("(deny process-exec)"));
        assert!(profile.contains("(deny process-fork)"));
        assert!(!profile.contains("(allow file-write*"));
        assert!(!profile.contains("(literal \"/bin/sh\")"));
    }

    #[test]
    fn fs_read_profile_fails_closed_without_roots_or_with_extra_exec() {
        let root = std::env::temp_dir().join("panda-bridge-fs-profile-render-test");
        let mut sandbox = SandboxSpec {
            profile: SandboxProfileKind::FsReadDir,
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            exec_allow: vec![PathBuf::from("/bin/cat")],
            net: NetPolicy::Deny,
            limits: ResourceLimits::fs_read_default(),
            env_allow: Vec::new(),
            cwd: root.clone(),
        };
        assert!(matches!(
            render(&sandbox),
            Err(SandboxError::ProfileRenderFailed { .. })
        ));
        sandbox.read_roots.push(root);
        sandbox.exec_allow.push(PathBuf::from("/bin/sh"));
        assert!(matches!(
            render(&sandbox),
            Err(SandboxError::ProfileRenderFailed { .. })
        ));
    }

    #[test]
    fn path_with_quotes_is_escaped() {
        let escaped = sb_string(PathBuf::from("/tmp/a\"b\\c"));
        assert_eq!(escaped, "\"/tmp/a\\\"b\\\\c\"");
        let profile = render(&spec(vec![PathBuf::from("/tmp/a\"b")])).unwrap();
        assert!(profile.contains("/tmp/a\\\"b"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_profile_enforces_file_exec_and_network_boundaries_with_sandbox_exec() {
        if !Path::new("/usr/bin/sandbox-exec").exists() {
            return;
        }
        let workspace_raw = std::env::temp_dir().join(format!(
            "panda-bridge-seatbelt-probe-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&workspace_raw);
        std::fs::create_dir_all(&workspace_raw).unwrap();
        let workspace = std::fs::canonicalize(&workspace_raw).unwrap();
        let cat = PathBuf::from("/bin/cat");
        let touch = PathBuf::from("/usr/bin/touch");
        let curl = PathBuf::from("/usr/bin/curl");
        let mut exec_allow = vec![cat.clone(), touch.clone()];
        if curl.exists() {
            exec_allow.push(curl.clone());
        }
        let profile = render(&SandboxSpec {
            profile: SandboxProfileKind::CodexWorkspace,
            read_roots: vec![workspace.clone()],
            write_roots: vec![workspace.clone()],
            exec_allow,
            net: NetPolicy::Deny,
            limits: ResourceLimits::codex_default(),
            env_allow: Vec::new(),
            cwd: workspace.clone(),
        })
        .unwrap();

        let ssh_probe = std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap()
            .join(".ssh/id_ed25519");
        if ssh_probe.exists() {
            let output = Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "--"])
                .arg(&cat)
                .arg(&ssh_probe)
                .output()
                .unwrap();
            assert!(!output.status.success());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains("Operation not permitted") || stderr.contains("Permission denied"),
                "unexpected cat stderr: {stderr}"
            );
        }

        let evil = std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap()
            .join(format!("panda-bridge-seatbelt-evil-{}", std::process::id()));
        let _ = std::fs::remove_file(&evil);
        let output = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "--"])
            .arg(&touch)
            .arg(&evil)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(!evil.exists());

        let ok_path = workspace.join("ok.txt");
        let output = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "--"])
            .arg(&touch)
            .arg(&ok_path)
            .output()
            .unwrap();
        assert!(output.status.success(), "workspace write should pass");
        assert!(ok_path.exists());

        let output = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "--", "/bin/sh", "-c", "echo nope"])
            .output()
            .unwrap();
        assert!(!output.status.success(), "sh must not be executable");

        if curl.exists() {
            let output = Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "--"])
                .arg(&curl)
                .args([
                    "--max-time",
                    "3",
                    "--fail",
                    "--silent",
                    "https://example.com",
                ])
                .output()
                .unwrap();
            assert!(
                !output.status.success(),
                "curl must fail when the rendered profile has net=Deny"
            );
        }

        let _ = std::fs::remove_file(&evil);
        let _ = std::fs::remove_dir_all(&workspace_raw);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fs_read_profile_enforces_outside_and_symlink_denials_with_sandbox_exec() {
        if !Path::new("/usr/bin/sandbox-exec").exists() {
            return;
        }
        let base = std::env::temp_dir().join(format!(
            "panda-bridge-fs-seatbelt-probe-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let allowed_raw = base.join("allowed");
        let outside_raw = base.join("outside");
        std::fs::create_dir_all(&allowed_raw).unwrap();
        std::fs::create_dir_all(&outside_raw).unwrap();
        let allowed = std::fs::canonicalize(&allowed_raw).unwrap();
        let outside = std::fs::canonicalize(&outside_raw).unwrap();
        let ok_file = allowed.join("ok.txt");
        let outside_file = outside.join("secret.txt");
        std::fs::write(&ok_file, "ok").unwrap();
        std::fs::write(&outside_file, "secret").unwrap();
        let link = allowed.join("link-outside.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();

        let profile = render(&SandboxSpec {
            profile: SandboxProfileKind::FsReadDir,
            read_roots: vec![allowed.clone()],
            write_roots: Vec::new(),
            exec_allow: vec![PathBuf::from("/bin/cat")],
            net: NetPolicy::Deny,
            limits: ResourceLimits::fs_read_default(),
            env_allow: Vec::new(),
            cwd: allowed.clone(),
        })
        .unwrap();

        let ok = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "--", "/bin/cat"])
            .arg(&ok_file)
            .output()
            .unwrap();
        assert!(ok.status.success(), "authorized file should read");
        assert_eq!(String::from_utf8_lossy(&ok.stdout), "ok");

        let denied = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "--", "/bin/cat"])
            .arg(&outside_file)
            .output()
            .unwrap();
        assert!(!denied.status.success(), "outside file must fail");
        let denied_stderr = String::from_utf8_lossy(&denied.stderr);
        assert!(
            denied_stderr.contains("Operation not permitted")
                || denied_stderr.contains("Permission denied"),
            "unexpected outside stderr: {denied_stderr}"
        );

        #[cfg(unix)]
        {
            let symlink_denied = Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "--", "/bin/cat"])
                .arg(&link)
                .output()
                .unwrap();
            assert!(!symlink_denied.status.success(), "symlink escape must fail");
            let stderr = String::from_utf8_lossy(&symlink_denied.stderr);
            assert!(
                stderr.contains("Operation not permitted") || stderr.contains("Permission denied"),
                "unexpected symlink stderr: {stderr}"
            );
        }

        let _ = std::fs::remove_dir_all(&base);
    }
}
