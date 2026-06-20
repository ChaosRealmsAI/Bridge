use super::*;

pub(crate) fn settings_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("desktop-settings.json"))
}

pub(crate) fn legacy_settings_path() -> Result<PathBuf, String> {
    Ok(legacy_state_dir()?.join("desktop-settings.json"))
}

pub(crate) fn load_settings_with_api(api_base: &str) -> DesktopSettings {
    let mut settings = read_primary_or_legacy(settings_path(), legacy_settings_path())
        .ok()
        .and_then(|text| serde_json::from_str::<DesktopSettings>(&text).ok())
        .unwrap_or_else(default_settings);
    normalize_settings(&mut settings, api_base);
    settings
}

pub(crate) fn default_settings() -> DesktopSettings {
    DesktopSettings {
        launch_at_login: default_launch_at_login(),
        appearance: default_appearance(),
        language: default_language(),
        api_base: default_api_base(),
        cloud_profiles: vec![official_cloud_profile()],
        selected_cloud_profile_id: "official".to_string(),
    }
}

pub(crate) fn save_settings(settings: &DesktopSettings) -> Result<(), String> {
    let mut persisted = settings.clone();
    let active_api = persisted.api_base.clone();
    normalize_settings(&mut persisted, &active_api);
    write_file(
        &settings_path()?,
        &serde_json::to_string_pretty(&persisted).map_err(|error| error.to_string())?,
    )
}

pub(crate) fn update_settings(params: &Value) -> Result<DesktopSettings, String> {
    let api_base = load_credentials()
        .map(|credentials| credentials.api_base)
        .unwrap_or_else(|_| DEFAULT_API.to_string());
    let mut settings = load_settings_with_api(&api_base);
    if let Some(value) = params.get("launch_at_login").and_then(Value::as_bool) {
        settings.launch_at_login = value;
    }
    if let Some(value) = params.get("appearance").and_then(Value::as_str) {
        settings.appearance = match value {
            "auto" | "light" | "dark" => value.to_string(),
            other => return Err(format!("invalid appearance: {other}")),
        };
    }
    if let Some(value) = params.get("language").and_then(Value::as_str) {
        settings.language = match value {
            "auto" | "zh-CN" | "zh-TW" | "en" | "ja" => value.to_string(),
            other => return Err(format!("invalid language: {other}")),
        };
    }
    save_settings(&settings)?;
    if params
        .get("launch_at_login")
        .and_then(Value::as_bool)
        .is_some()
    {
        if let Err(error) = apply_launch_at_login(settings.launch_at_login) {
            eprintln!("[launch-at-login] {error}");
        }
    }
    Ok(settings)
}
