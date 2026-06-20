use super::*;

const DEFAULT_GITHUB_LATEST_API: &str = "https://api.github.com/repos/ChaosRealmsAI/Bridge/releases/latest";
const DEFAULT_GITHUB_RELEASE_URL: &str = "https://github.com/ChaosRealmsAI/Bridge/releases/latest";

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

pub(crate) fn check_desktop_update(params: &Value) -> Result<Value, String> {
    let manifest_url =
        string_param(params, "manifest_url").unwrap_or_else(|| DEFAULT_GITHUB_LATEST_API.to_string());
    validate_update_url(&manifest_url)?;
    let platform = string_param(params, "platform").unwrap_or_else(current_update_platform);
    let release = fetch_github_latest_release(&manifest_url)?;
    let latest_version = normalize_release_tag(&release.tag_name);
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let asset_name = update_asset_name(&platform);
    let download_url = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .map(|asset| asset.browser_download_url.clone());
    let release_url = if release.html_url.trim().is_empty() {
        DEFAULT_GITHUB_RELEASE_URL.to_string()
    } else {
        release.html_url
    };

    Ok(json!({
        "current_version": current_version,
        "latest_version": latest_version,
        "update_available": semver_is_newer(&latest_version, &current_version),
        "platform": platform,
        "asset_name": asset_name,
        "download_url": download_url,
        "release_url": release_url,
        "update_mode": "manual_download_latest",
        "auto_update": {
            "supported": false,
            "reason": "silent_auto_update_requires_signed_notarized_macos_package_and_signed_installer_update_channel"
        }
    }))
}

pub(crate) fn open_desktop_update(params: &Value) -> Result<Value, String> {
    let update = check_desktop_update(params)?;
    let url = update
        .get("download_url")
        .and_then(Value::as_str)
        .or_else(|| update.get("release_url").and_then(Value::as_str))
        .unwrap_or(DEFAULT_GITHUB_RELEASE_URL);
    open_url(url)?;
    Ok(update)
}

fn fetch_github_latest_release(url: &str) -> Result<GithubRelease, String> {
    let response = Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header("user-agent", "Bridge Desktop update checker")
        .send()
        .map_err(|error| format!("update check failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("update check returned HTTP {status}"));
    }
    response
        .json::<GithubRelease>()
        .map_err(|error| format!("update manifest is invalid: {error}"))
}

fn validate_update_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "update manifest URL is invalid".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("update manifest URL must use http or https".to_string());
    }
    Ok(())
}

fn current_update_platform() -> String {
    if cfg!(target_os = "windows") {
        "windows-x64".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "unknown".to_string()
    }
}

fn update_asset_name(platform: &str) -> &'static str {
    if platform.eq_ignore_ascii_case("windows")
        || platform.eq_ignore_ascii_case("windows-x64")
        || platform.eq_ignore_ascii_case("win32")
    {
        "bridge-windows-x64.zip"
    } else {
        "bridge-macos.dmg"
    }
}

fn normalize_release_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

fn semver_is_newer(latest: &str, current: &str) -> bool {
    compare_semver(latest, current) > 0
}

fn compare_semver(left: &str, right: &str) -> i8 {
    let a = semver_parts(left);
    let b = semver_parts(right);
    for i in 0..3 {
        if a[i] > b[i] {
            return 1;
        }
        if a[i] < b[i] {
            return -1;
        }
    }
    0
}

fn semver_parts(value: &str) -> [u64; 3] {
    let mut parts = [0, 0, 0];
    for (index, part) in value
        .split(['.', '-', '+'])
        .take(3)
        .enumerate()
    {
        parts[index] = part.parse::<u64>().unwrap_or(0);
    }
    parts
}
