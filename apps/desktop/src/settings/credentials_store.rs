use super::*;

pub(crate) fn save_credentials(credentials: &Credentials) -> Result<(), String> {
    let text = serde_json::to_string_pretty(credentials).map_err(|error| error.to_string())?;
    if let Ok(path) = env::var("BRIDGE_DESKTOP_STATE") {
        write_external_state_file(Path::new(&path), &text)?;
        return Ok(());
    }
    if keychain_enabled() {
        let _ = keychain_entry()
            .and_then(|entry| entry.set_password(&text).map_err(|error| error.to_string()));
    }
    write_file(&fallback_credentials_path()?, &text)?;
    Ok(())
}

pub(crate) fn load_credentials() -> Result<Credentials, String> {
    let text = load_credentials_text()?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

pub(crate) fn load_credentials_text() -> Result<String, String> {
    if let Ok(path) = env::var("BRIDGE_DESKTOP_STATE") {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    let fallback_path = fallback_credentials_path()?;
    let legacy_fallback_path = legacy_fallback_credentials_path()?;
    if keychain_enabled() {
        if let Ok(text) = keychain_entry()
            .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    if let Ok(text) = fs::read_to_string(&fallback_path) {
        if !text.trim().is_empty() {
            if keychain_enabled() {
                let _ = keychain_entry()
                    .and_then(|entry| entry.set_password(&text).map_err(|error| error.to_string()));
            }
            return Ok(text);
        }
    }
    if fallback_path != legacy_fallback_path {
        if let Ok(text) = fs::read_to_string(&legacy_fallback_path) {
            if !text.trim().is_empty() {
                let _ = write_file(&fallback_path, &text);
                if keychain_enabled() {
                    let _ = keychain_entry().and_then(|entry| {
                        entry.set_password(&text).map_err(|error| error.to_string())
                    });
                }
                return Ok(text);
            }
        }
    }
    Err(format!(
        "desktop state unavailable: {}",
        fallback_path.display()
    ))
}

pub(crate) fn delete_credentials() -> Result<(), String> {
    if let Ok(path) = env::var("BRIDGE_DESKTOP_STATE") {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let _ = fs::remove_file(fallback_credentials_path()?);
    let _ = fs::remove_file(legacy_fallback_credentials_path()?);
    if keychain_enabled() {
        thread::spawn(move || {
            let _ = keychain_entry()
                .and_then(|entry| entry.delete_credential().map_err(|error| error.to_string()));
        });
    }
    Ok(())
}

pub(crate) fn keychain_enabled() -> bool {
    if env_flag("BRIDGE_SKIP_KEYCHAIN") {
        return false;
    }
    // Dev/debug builds are unsigned (or ad-hoc signed), so the macOS keychain would
    // re-prompt for the login password on every launch. Default debug builds to the
    // file-backed credential store; release builds (signed + notarized for
    // distribution) use the keychain. Either default can be overridden by env.
    if cfg!(debug_assertions) {
        return env_flag("BRIDGE_USE_KEYCHAIN");
    }
    true
}

pub(crate) fn keychain_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|error| error.to_string())
}

pub(crate) fn write_connector_state(credentials: &Credentials) -> Result<(), String> {
    if env::var("BRIDGE_DESKTOP_STATE").is_ok() {
        return Ok(());
    }
    let path = fallback_credentials_path()?;
    write_file(
        &path,
        &serde_json::to_string_pretty(credentials).map_err(|error| error.to_string())?,
    )
}

pub(crate) fn fallback_credentials_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("desktop-connector.json"))
}

pub(crate) fn legacy_fallback_credentials_path() -> Result<PathBuf, String> {
    Ok(legacy_state_dir()?.join("desktop-connector.json"))
}

pub(crate) fn write_file(path: &Path, text: &str) -> Result<(), String> {
    write_file_with_parent_permissions(path, text, true)
}

pub(crate) fn write_external_state_file(path: &Path, text: &str) -> Result<(), String> {
    write_file_with_parent_permissions(path, text, false)
}

pub(crate) fn write_file_with_parent_permissions(
    path: &Path,
    text: &str,
    private_parent: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    let _ = private_parent;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if private_parent {
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
    }
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn state_dir() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("BRIDGE_DESKTOP_STATE_DIR") {
        return Ok(PathBuf::from(path));
    }
    if cfg!(target_os = "macos") {
        return Ok(home_dir()?
            .join("Library")
            .join("Application Support")
            .join("Bridge")
            .join("state"));
    }
    if cfg!(windows) {
        let base = env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| {
            home_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("AppData")
                .join("Roaming")
        });
        return Ok(base.join("Bridge").join("state"));
    }
    if let Ok(path) = env::var("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("bridge"));
    }
    Ok(home_dir()?
        .join(".local")
        .join("state")
        .join("bridge"))
}

pub(crate) fn legacy_state_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".bridge"))
}

pub(crate) fn read_primary_or_legacy(
    primary: Result<PathBuf, String>,
    legacy: Result<PathBuf, String>,
) -> Result<String, String> {
    let primary_path = primary?;
    if let Ok(text) = fs::read_to_string(&primary_path) {
        if !text.trim().is_empty() {
            return Ok(text);
        }
    }
    let legacy_path = legacy?;
    if legacy_path != primary_path {
        if let Ok(text) = fs::read_to_string(&legacy_path) {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    Err(format!(
        "state file unavailable: {}",
        primary_path.display()
    ))
}
