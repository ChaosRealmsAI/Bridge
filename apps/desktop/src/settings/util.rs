use super::*;

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    if let Ok(home) = env::var("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        return Ok(PathBuf::from(profile));
    }
    Err("cannot determine home directory".to_string())
}

pub(crate) fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub(crate) fn open_web_url(params: &Value) -> String {
    if let Some(url) = string_param(params, "url").filter(|value| !value.trim().is_empty()) {
        return url;
    }
    let settings = load_settings_with_api(DEFAULT_API);
    if let Some(product_id) =
        string_param(params, "product_id").or_else(|| string_param(params, "product"))
    {
        let normalized = normalize_product_key(&product_id);
        if let Some(profile) = selected_cloud_profile(&settings) {
            let catalog = profile_catalog_entries(profile);
            if let Some(product) = catalog.iter().find(|product| {
                normalize_product_key(&product.id) == normalized
                    || normalize_product_key(&product.name) == normalized
            }) {
                return product
                    .web_url
                    .clone()
                    .or_else(|| product.origin.clone())
                    .unwrap_or_else(|| {
                        profile
                            .web_origin
                            .clone()
                            .unwrap_or_else(|| profile.api_base.clone())
                    });
            }
        }
    }
    selected_cloud_profile(&settings)
        .and_then(|profile| profile.web_origin.clone())
        .unwrap_or_else(|| DEFAULT_WEB.to_string())
}

pub(crate) fn open_url(url: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).status()
    } else {
        Command::new("xdg-open").arg(url).status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open url failed: {status}"))
    }
}

pub(crate) fn clean_api(api: &str) -> Result<String, String> {
    let trimmed = api.trim().trim_end_matches('/');
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("invalid Bridge API URL: {error}"))?;
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Bridge API URL cannot include credentials, query, or fragment".to_string());
    }
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Bridge API must use http or https".to_string());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn display_account(user: &ConnectUser) -> String {
    user.email
        .clone()
        .or_else(|| user.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Panda Account".to_string())
}

pub(crate) fn device_name() -> String {
    format!("Panda Bridge {}", env::consts::OS)
}

pub(crate) fn now_string() -> String {
    // Stable and parseable without adding a time formatting dependency.
    format!("unix:{}", unix_seconds())
}

pub(crate) fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn required_param(params: &Value, key: &str) -> Result<String, String> {
    string_param(params, key).ok_or_else(|| format!("missing {key}"))
}

pub(crate) fn product_param(params: &Value) -> Result<String, String> {
    string_param(params, "product_id")
        .or_else(|| string_param(params, "product"))
        .ok_or_else(|| "missing product_id".to_string())
}

pub(crate) fn string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(crate) fn initial_deep_links() -> Vec<String> {
    let mut links = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg.starts_with("panda-bridge://") {
            links.push(arg);
        } else if arg == "--connect-url" {
            if let Some(url) = args.next() {
                links.push(url);
            }
        } else if arg == "--intent" {
            if let Some(intent) = args.next() {
                let api =
                    env::var("PANDA_BRIDGE_API_BASE").unwrap_or_else(|_| DEFAULT_API.to_string());
                links.push(format!(
                    "panda-bridge://connect?intent={}&api={}",
                    urlencoding::encode(&intent),
                    urlencoding::encode(&api)
                ));
            }
        }
    }
    links
}
