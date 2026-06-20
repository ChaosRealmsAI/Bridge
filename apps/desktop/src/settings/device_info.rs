use super::*;

#[derive(Debug, Serialize, Clone)]
pub(crate) struct LocalDeviceInfo {
    pub(crate) display_name: String,
    pub(crate) model: String,
    pub(crate) os: String,
    pub(crate) arch: String,
    pub(crate) fingerprint: String,
    pub(crate) identity_source: String,
}

pub(crate) fn local_device_info() -> LocalDeviceInfo {
    LocalDeviceInfo {
        display_name: device_name(),
        model: local_device_model(),
        os: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        fingerprint: local_install_fingerprint(),
        identity_source: "local_install".to_string(),
    }
}

pub(crate) fn local_device_info_value() -> Value {
    serde_json::to_value(local_device_info()).unwrap_or_else(|_| {
        json!({
            "display_name": device_name(),
            "model": "Computer",
            "os": env::consts::OS,
            "arch": env::consts::ARCH,
            "fingerprint": "PB-UNKNOWN",
            "identity_source": "local_install"
        })
    })
}

pub(crate) fn local_install_fingerprint() -> String {
    public_fingerprint_for_install_id(&local_install_identity())
}

pub(crate) fn public_fingerprint_for_install_id(install_id: &str) -> String {
    let digest =
        Sha256::digest(format!("bridge-local-device-info-v1:{install_id}").as_bytes());
    let mut out = String::from("PB-");
    for byte in digest.iter().take(6) {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

fn local_install_identity() -> String {
    if let Ok(path) = env::var("BRIDGE_INSTALL_ID_FILE") {
        return read_or_create_install_identity(PathBuf::from(path));
    }
    let path = state_dir()
        .unwrap_or_else(|_| env::temp_dir().join("bridge"))
        .join("install-identity");
    read_or_create_install_identity(path)
}

fn read_or_create_install_identity(path: PathBuf) -> String {
    if let Ok(text) = fs::read_to_string(&path) {
        let value = clean_install_identity(&text);
        if !value.is_empty() {
            return value;
        }
    }
    let seed = format!(
        "{}:{}:{}",
        now_string(),
        std::process::id(),
        env::var("BRIDGE_INSTALL_ID_SEED").unwrap_or_default()
    );
    let digest = Sha256::digest(seed.as_bytes());
    let mut value = String::new();
    for byte in digest.iter() {
        value.push_str(&format!("{byte:02x}"));
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
        #[cfg(unix)]
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    let _ = fs::write(&path, format!("{value}\n"));
    #[cfg(unix)]
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    value
}

fn clean_install_identity(input: &str) -> String {
    input
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(200)
        .collect()
}

pub(crate) fn local_computer_name() -> Option<String> {
    env::var("BRIDGE_COMPUTER_NAME")
        .ok()
        .and_then(|value| sanitize_display_field(&value, 80))
        .or_else(system_computer_name)
}

fn system_computer_name() -> Option<String> {
    let output = if cfg!(target_os = "macos") {
        Command::new("scutil")
            .arg("--get")
            .arg("ComputerName")
            .output()
            .ok()
    } else if cfg!(windows) {
        Command::new("cmd").args(["/C", "hostname"]).output().ok()
    } else {
        Command::new("hostname").output().ok()
    }?;
    if !output.status.success() {
        return None;
    }
    sanitize_display_field(&String::from_utf8_lossy(&output.stdout), 80)
}

fn local_device_model() -> String {
    env::var("BRIDGE_DEVICE_MODEL")
        .ok()
        .and_then(|value| sanitize_display_field(&value, 80))
        .or_else(system_device_model)
        .unwrap_or_else(|| fallback_model_name().to_string())
}

fn system_device_model() -> Option<String> {
    let output = if cfg!(target_os = "macos") {
        Command::new("sysctl")
            .arg("-n")
            .arg("hw.model")
            .output()
            .ok()
    } else if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", "wmic computersystem get model /value"])
            .output()
            .ok()
    } else {
        Command::new("uname").arg("-m").output().ok()
    }?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let value = raw
        .lines()
        .find_map(|line| {
            let value = line.strip_prefix("Model=").unwrap_or(line);
            sanitize_display_field(value, 80)
        })
        .unwrap_or_else(|| fallback_model_name().to_string());
    Some(value)
}

fn fallback_model_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "Mac"
    } else if cfg!(windows) {
        "Windows PC"
    } else {
        "Computer"
    }
}

fn sanitize_display_field(value: &str, max_len: usize) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() || looks_sensitive_display_field(raw) {
        return None;
    }
    let mut out = String::new();
    let mut last_space = false;
    for ch in raw.chars() {
        let safe = if ch.is_control()
            || matches!(ch, '/' | '\\' | ':' | '@' | '\0')
            || (ch.is_ascii() && !ch.is_ascii_graphic() && !ch.is_ascii_whitespace())
        {
            ' '
        } else {
            ch
        };
        if safe.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(safe);
            last_space = false;
        }
        if out.chars().count() >= max_len {
            break;
        }
    }
    let trimmed = out.trim().to_string();
    if trimmed.is_empty() || looks_sensitive_display_field(&trimmed) {
        None
    } else {
        Some(trimmed)
    }
}

fn looks_sensitive_display_field(value: &str) -> bool {
    let raw = value.trim();
    if raw.is_empty() {
        return false;
    }
    let lower = raw.to_ascii_lowercase();
    raw.contains('@')
        || raw.contains('/')
        || raw.contains('\\')
        || lower.contains("pbi_")
        || lower.contains("pbd_")
        || is_ipv4_literal(raw)
        || is_mac_literal(raw)
}

fn is_ipv4_literal(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u8>().is_ok())
}

fn is_mac_literal(value: &str) -> bool {
    let delimiter = if value.contains(':') {
        ':'
    } else if value.contains('-') {
        '-'
    } else {
        return false;
    };
    let parts: Vec<&str> = value.split(delimiter).collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|part| part.len() == 2 && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}
