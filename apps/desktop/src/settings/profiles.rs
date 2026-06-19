use super::*;

pub(crate) fn add_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let api = string_param(params, "api")
        .or_else(|| string_param(params, "api_base"))
        .ok_or_else(|| "missing api".to_string())?;
    let api_base = clean_api(&api)?;
    let name = string_param(params, "name");
    let profile = fetch_cloud_profile(&api_base, name.as_deref())?;
    let mut settings = load_settings_with_api(&api_base);
    upsert_cloud_profile(&mut settings, profile, true);
    save_settings(&settings)?;
    Ok(settings)
}

pub(crate) fn pair_selfhost_profile(params: &Value) -> Result<DesktopSettings, String> {
    let api = string_param(params, "api")
        .or_else(|| string_param(params, "api_base"))
        .ok_or_else(|| "missing api".to_string())?;
    let api_base = clean_api(&api)?;
    let pairing_token = string_param(params, "token")
        .or_else(|| string_param(params, "pairing_token"))
        .or_else(|| string_param(params, "code"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing pairing token".to_string())?;
    let profile_name = string_param(params, "name")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "My Server".to_string());
    let profile = fetch_cloud_profile(&api_base, Some(&profile_name))?;
    let product_ids = profile
        .products
        .iter()
        .map(|product| product.id.clone())
        .collect::<Vec<_>>();
    let existing = load_credentials().ok();
    let existing_connections = existing
        .as_ref()
        .map(credentials_connections)
        .unwrap_or_default();
    let install_id = credentials_install_id(existing.as_ref());
    let body = json!({
        "code": pairing_token,
        "device_name": string_param(params, "device_name").unwrap_or_else(device_name),
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state_for_products(&product_ids),
        "install_id": install_id.clone()
    });
    let url = format!("{api_base}/v1/connectors/claim");
    let payload: ClaimResponse = post_json_with_install(&url, &body, None, Some(&install_id))?;
    let account_id = payload
        .account
        .as_ref()
        .and_then(|account| account.id.clone());
    let account_display = payload.account.as_ref().map(display_account);
    let connection = Credentials {
        api_base: api_base.clone(),
        device_id: payload.device.id.clone(),
        device_name: payload.device.device_name.clone(),
        device_token: payload.device_token,
        install_id: Some(install_id),
        account_id: account_id.clone(),
        account_display,
        product_id: None,
        product_name: None,
        cloud_origin: profile
            .web_origin
            .clone()
            .or_else(|| Some(api_base.clone())),
        authorized_products: Vec::new(),
        device_token_expires_at: payload.token_expires_at,
        device_token_rotated_at_unix: Some(unix_seconds()),
        install_identity_bound: payload.install_identity_bound,
        device_online: cloud_device_online(&payload.devices, &payload.device.id),
        device_last_seen_at: cloud_device_last_seen_at(&payload.devices, &payload.device.id),
        connections: Vec::new(),
        claimed_at: now_string(),
    };
    let mut connections = existing_connections;
    upsert_connection(&mut connections, connection.clone());
    apply_cloud_devices_to_connections(
        &mut connections,
        &api_base,
        account_id.as_deref(),
        payload.devices.as_deref(),
    );
    let credentials =
        credentials_from_connections(connections, Some(&connection), existing.as_ref());
    save_credentials(&credentials)?;
    write_connector_state(&credentials)?;
    let mut settings = load_settings_with_api(&api_base);
    let mut selected_profile = profile;
    selected_profile.source = "selfhost".to_string();
    upsert_cloud_profile(&mut settings, selected_profile, true);
    save_settings(&settings)?;
    Ok(settings)
}

pub(crate) fn select_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let mut settings = load_settings_with_api(DEFAULT_API);
    let target_id = if let Some(id) =
        string_param(params, "profile_id").or_else(|| string_param(params, "id"))
    {
        id
    } else if let Some(api) =
        string_param(params, "api").or_else(|| string_param(params, "api_base"))
    {
        let api_base = clean_api(&api)?;
        profile_id_for_api(&api_base)
    } else {
        return Err("missing profile_id or api".to_string());
    };
    if !settings
        .cloud_profiles
        .iter()
        .any(|profile| profile.id == target_id)
    {
        return Err(format!("unknown cloud profile: {target_id}"));
    }
    settings.selected_cloud_profile_id = target_id;
    if let Some(profile) = selected_cloud_profile(&settings) {
        settings.api_base = profile.api_base.clone();
    }
    save_settings(&settings)?;
    Ok(settings)
}

pub(crate) fn remove_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let target_id = string_param(params, "profile_id")
        .or_else(|| string_param(params, "id"))
        .ok_or_else(|| "missing profile_id".to_string())?;
    if target_id == "official" {
        return Err("official Bridge Cloud profile cannot be removed".to_string());
    }
    let mut settings = load_settings_with_api(DEFAULT_API);
    let before = settings.cloud_profiles.len();
    settings
        .cloud_profiles
        .retain(|profile| profile.id != target_id);
    if settings.cloud_profiles.len() == before {
        return Err(format!("unknown cloud profile: {target_id}"));
    }
    if settings.selected_cloud_profile_id == target_id {
        settings.selected_cloud_profile_id = "official".to_string();
    }
    if let Some(profile) = selected_cloud_profile(&settings) {
        settings.api_base = profile.api_base.clone();
    }
    save_settings(&settings)?;
    Ok(settings)
}

pub(crate) fn refresh_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let mut settings = load_settings_with_api(DEFAULT_API);
    let target = string_param(params, "profile_id")
        .or_else(|| string_param(params, "id"))
        .or_else(|| {
            string_param(params, "api")
                .or_else(|| string_param(params, "api_base"))
                .and_then(|api| clean_api(&api).ok())
                .map(|api| profile_id_for_api(&api))
        })
        .ok_or_else(|| "missing profile_id or api".to_string())?;
    let existing = settings
        .cloud_profiles
        .iter()
        .find(|profile| profile.id == target)
        .cloned()
        .ok_or_else(|| format!("unknown cloud profile: {target}"))?;
    let mut profile = match fetch_cloud_profile(&existing.api_base, Some(&existing.name)) {
        Ok(profile) => profile,
        Err(error) => {
            if let Some(profile) = settings
                .cloud_profiles
                .iter_mut()
                .find(|profile| profile.id == target)
            {
                profile.updated_at = profile_probe_error_marker(&error);
            }
            save_settings(&settings).map_err(|save_error| {
                format!(
                    "{}; failed to persist profile probe failure: {}",
                    redact_error_text(&error),
                    redact_error_text(&save_error)
                )
            })?;
            return Err(error);
        }
    };
    profile.id = existing.id;
    profile.source = existing.source;
    let keep_selected = settings.selected_cloud_profile_id == target;
    upsert_cloud_profile(&mut settings, profile, keep_selected);
    save_settings(&settings)?;
    Ok(settings)
}

pub(crate) struct ProfileProbeFailure {
    pub(crate) at: String,
    pub(crate) error: String,
}

pub(crate) const PROFILE_PROBE_SUCCESS_TTL_SECONDS: u64 = 120;

pub(crate) struct ProfileProbeSuccess {
    pub(crate) at: String,
    pub(crate) fresh: bool,
    pub(crate) latency_ms: Option<u64>,
}

pub(crate) fn profile_probe_at(updated_at: &str) -> Option<String> {
    updated_at
        .trim()
        .strip_prefix("probe:")
        .and_then(|value| value.split('|').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn profile_probe_success(updated_at: &str) -> Option<ProfileProbeSuccess> {
    let at = profile_probe_at(updated_at)?;
    let fresh = unix_marker_age_seconds(&at)
        .map(|age| age <= PROFILE_PROBE_SUCCESS_TTL_SECONDS)
        .unwrap_or(false);
    Some(ProfileProbeSuccess {
        at,
        fresh,
        latency_ms: profile_probe_latency_ms(updated_at),
    })
}

fn profile_probe_latency_ms(updated_at: &str) -> Option<u64> {
    updated_at
        .trim()
        .strip_prefix("probe:")?
        .split('|')
        .skip(1)
        .find_map(|part| part.trim().strip_prefix("latency_ms:"))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn profile_probe_success_marker(latency_ms: u64) -> String {
    format!("probe:{}|latency_ms:{}", now_string(), latency_ms.max(1))
}

fn unix_marker_age_seconds(marker: &str) -> Option<u64> {
    let then = marker.trim().strip_prefix("unix:")?.parse::<u64>().ok()?;
    Some(unix_seconds().saturating_sub(then))
}

pub(crate) fn profile_probe_error(updated_at: &str) -> Option<ProfileProbeFailure> {
    let value = updated_at.trim().strip_prefix("probe_error:")?;
    let (at, error) = value.split_once('|')?;
    let at = at.trim();
    if at.is_empty() {
        return None;
    }
    Some(ProfileProbeFailure {
        at: at.to_string(),
        error: sanitize_profile_probe_error(error),
    })
}

pub(crate) fn profile_probe_error_marker(error: &str) -> String {
    format!(
        "probe_error:{}|{}",
        now_string(),
        sanitize_profile_probe_error(error)
    )
}

fn sanitize_profile_probe_error(error: &str) -> String {
    let redacted = redact_error_text(error);
    let sanitized = redacted
        .replace(['\n', '\r', '|'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if sanitized.is_empty() {
        "probe failed".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn normalize_settings(settings: &mut DesktopSettings, active_api: &str) {
    if settings
        .cloud_profiles
        .iter()
        .all(|profile| profile.id != "official")
    {
        settings.cloud_profiles.insert(0, official_cloud_profile());
    }
    for profile in &mut settings.cloud_profiles {
        if profile.id == "official" {
            *profile = merge_official_profile(profile.clone());
            continue;
        }
        if profile.id.trim().is_empty() {
            profile.id = profile_id_for_api(&profile.api_base);
        }
        if profile.source.trim().is_empty() {
            profile.source = "user".to_string();
        }
        if profile.name.trim().is_empty() {
            profile.name = name_for_api(&profile.api_base);
        }
        profile.products = fixed_product_catalog_entries();
    }

    let active_clean = clean_api(active_api)
        .or_else(|_| clean_api(&settings.api_base))
        .unwrap_or_else(|_| DEFAULT_API.to_string());
    if active_clean != DEFAULT_API
        && settings
            .cloud_profiles
            .iter()
            .all(|profile| profile.api_base != active_clean)
    {
        settings
            .cloud_profiles
            .push(minimal_cloud_profile(&active_clean, None));
    }
    if settings.selected_cloud_profile_id.trim().is_empty()
        || settings
            .cloud_profiles
            .iter()
            .all(|profile| profile.id != settings.selected_cloud_profile_id)
    {
        settings.selected_cloud_profile_id = settings
            .cloud_profiles
            .iter()
            .find(|profile| profile.api_base == active_clean)
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| "official".to_string());
    }
    if let Some(profile) = selected_cloud_profile(settings) {
        settings.api_base = profile.api_base.clone();
    } else {
        settings.selected_cloud_profile_id = "official".to_string();
        settings.api_base = DEFAULT_API.to_string();
    }
}

pub(crate) fn selected_cloud_profile(settings: &DesktopSettings) -> Option<&CloudProfile> {
    settings
        .cloud_profiles
        .iter()
        .find(|profile| profile.id == settings.selected_cloud_profile_id)
        .or_else(|| {
            settings
                .cloud_profiles
                .iter()
                .find(|profile| profile.id == "official")
        })
}

pub(crate) fn official_cloud_profile() -> CloudProfile {
    CloudProfile {
        id: "official".to_string(),
        name: "Official Bridge Cloud".to_string(),
        api_base: DEFAULT_API.to_string(),
        web_origin: Some(DEFAULT_WEB.to_string()),
        products: known_products()
            .into_iter()
            .map(product_entry_from_known)
            .collect(),
        source: "official".to_string(),
        updated_at: "builtin".to_string(),
    }
}

pub(crate) fn merge_official_profile(existing: CloudProfile) -> CloudProfile {
    let mut official = official_cloud_profile();
    official.name = if existing.name.trim().is_empty() {
        official.name
    } else {
        existing.name
    };
    official.updated_at = existing.updated_at;
    official
}

pub(crate) fn minimal_cloud_profile(api_base: &str, name: Option<&str>) -> CloudProfile {
    CloudProfile {
        id: profile_id_for_api(api_base),
        name: name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| name_for_api(api_base)),
        api_base: api_base.to_string(),
        web_origin: None,
        products: fixed_product_catalog_entries(),
        source: "user".to_string(),
        updated_at: String::new(),
    }
}

pub(crate) fn fetch_cloud_profile(
    api_base: &str,
    name: Option<&str>,
) -> Result<CloudProfile, String> {
    let api_base = clean_api(api_base)?;
    let probe_started = Instant::now();
    let health_url = format!("{api_base}/v1/health");
    let health: HealthResponse = get_json(&health_url, None)?;
    validate_bridge_health(&health)?;
    let diagnostics_url = format!("{api_base}/v1/diagnostics");
    let diagnostics: DiagnosticsResponse = get_json(&diagnostics_url, None)?;
    validate_bridge_diagnostics(&api_base, &diagnostics)?;
    let latency_ms = u64::try_from(probe_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(CloudProfile {
        id: profile_id_for_api(&api_base),
        name: name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| name_for_api(&api_base)),
        api_base,
        web_origin: diagnostics.web_origin,
        products: fixed_product_catalog_entries(),
        source: "user".to_string(),
        updated_at: profile_probe_success_marker(latency_ms),
    })
}

pub(crate) fn validate_bridge_health(health: &HealthResponse) -> Result<(), String> {
    if health.ok != Some(true) {
        return Err("Bridge Cloud health did not return ok=true".to_string());
    }
    if health.protocol.as_deref() != Some(BRIDGE_PROTOCOL_VERSION) {
        return Err("Bridge Cloud health returned an unsupported protocol".to_string());
    }
    Ok(())
}

pub(crate) fn validate_bridge_diagnostics(
    api_base: &str,
    diagnostics: &DiagnosticsResponse,
) -> Result<(), String> {
    if diagnostics.ok != Some(true) {
        return Err("Bridge Cloud diagnostics did not return ok=true".to_string());
    }
    if diagnostics.protocol.as_deref() != Some(BRIDGE_PROTOCOL_VERSION) {
        return Err("Bridge Cloud diagnostics returned an unsupported protocol".to_string());
    }
    let public_api_base = diagnostics
        .api_base
        .as_deref()
        .ok_or_else(|| "Bridge Cloud diagnostics missing api_base".to_string())
        .and_then(clean_api)?;
    if public_api_base != api_base {
        return Err(
            "Bridge Cloud diagnostics api_base does not match the selected server".to_string(),
        );
    }
    let web_origin = diagnostics
        .web_origin
        .as_deref()
        .ok_or_else(|| "Bridge Cloud diagnostics missing web_origin".to_string())?;
    clean_product_origin(web_origin)
        .ok_or_else(|| "Bridge Cloud diagnostics returned an invalid web_origin".to_string())?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn validate_bridge_product(product: &ProductInfo) -> Result<(), String> {
    if !valid_product_id(&product.id) {
        return Err(format!(
            "Bridge Cloud diagnostics returned invalid product id: {}",
            product.id
        ));
    }
    if product.name.trim().is_empty() {
        return Err(format!(
            "Bridge Cloud diagnostics returned unnamed product: {}",
            product.id
        ));
    }
    let origin = product
        .official_origin
        .as_deref()
        .or(product.origin.as_deref())
        .or_else(|| product.official_origins.first().map(String::as_str))
        .ok_or_else(|| {
            format!(
                "Bridge Cloud diagnostics missing product origin: {}",
                product.id
            )
        })?;
    clean_product_origin(origin).ok_or_else(|| {
        format!(
            "Bridge Cloud diagnostics returned invalid product origin: {}",
            product.id
        )
    })?;
    for candidate in &product.official_origins {
        clean_product_origin(candidate).ok_or_else(|| {
            format!(
                "Bridge Cloud diagnostics returned invalid product origin: {}",
                product.id
            )
        })?;
    }
    if let Some(web_url) = product.web_url.as_deref() {
        clean_product_web_url(web_url).ok_or_else(|| {
            format!(
                "Bridge Cloud diagnostics returned invalid product web_url: {}",
                product.id
            )
        })?;
    }
    let allowed_capabilities = allowed_product_capabilities(&product.id);
    if product.capabilities.is_empty()
        || product
            .capabilities
            .iter()
            .any(|capability| !allowed_capabilities.contains(&capability.as_str()))
    {
        return Err(format!(
            "Bridge Cloud diagnostics returned unsupported product capabilities: {}",
            product.id
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn allowed_product_capabilities(product_id: &str) -> Vec<&'static str> {
    let _ = product_id;
    vec!["relay.envelope", "relay.ack"]
}

#[cfg(test)]
pub(crate) fn valid_product_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3 || bytes.len() > 80 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn clean_product_origin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return None;
    }
    Some(format!("{}://{}", parsed.scheme(), parsed.host_str()?))
}

#[cfg(test)]
pub(crate) fn clean_product_web_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let parsed = url::Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn profile_product<'a>(
    profile: &'a CloudProfile,
    product_id: &str,
) -> Option<&'a DesktopProductCatalogEntry> {
    let normalized = normalize_product_key(product_id);
    profile.products.iter().find(|product| {
        normalize_product_key(&product.id) == normalized
            || normalize_product_key(&product.name) == normalized
    })
}

pub(crate) fn fetch_cloud_profile_product(
    api_base: &str,
    product_id: Option<&str>,
) -> Result<CloudProfile, String> {
    let profile = fetch_cloud_profile(api_base, None)?;
    if let Some(product_id) = product_id {
        if profile_product(&profile, product_id).is_none() {
            return Err(format!(
                "Product is not in the fixed Panda catalog: {product_id}"
            ));
        }
    }
    Ok(profile)
}

pub(crate) fn register_cloud_profile_from_claim(
    api_base: &str,
    product_id: Option<&str>,
) -> Result<(), String> {
    let api_base = clean_api(api_base)?;
    let mut settings = load_settings_with_api(&api_base);
    let profile = fetch_cloud_profile_product(&api_base, product_id)?;
    upsert_cloud_profile(&mut settings, profile, true);
    save_settings(&settings)
}

pub(crate) fn upsert_cloud_profile(
    settings: &mut DesktopSettings,
    profile: CloudProfile,
    select: bool,
) {
    if let Some(existing) = settings
        .cloud_profiles
        .iter_mut()
        .find(|item| item.id == profile.id || item.api_base == profile.api_base)
    {
        *existing = profile.clone();
    } else {
        settings.cloud_profiles.push(profile.clone());
    }
    if select {
        settings.selected_cloud_profile_id = profile.id;
        settings.api_base = profile.api_base;
    }
}

pub(crate) fn product_entry_from_known(product: KnownProduct) -> DesktopProductCatalogEntry {
    normalize_catalog_product_brand(DesktopProductCatalogEntry {
        id: product.id.to_string(),
        name: product.name.to_string(),
        origin: Some(product.origin.to_string()),
        web_url: Some(product.web_url.to_string()),
        official_origin: Some(product.origin.to_string()),
        official_origins: vec![product.origin.to_string()],
    })
}

#[cfg(test)]
pub(crate) fn product_entry_from_info(
    product: &ProductInfo,
    api_base: &str,
) -> DesktopProductCatalogEntry {
    let origin = product
        .official_origin
        .clone()
        .or_else(|| product.origin.clone())
        .or_else(|| product.official_origins.first().cloned())
        .unwrap_or_else(|| api_base.to_string());
    normalize_catalog_product_brand(DesktopProductCatalogEntry {
        id: product.id.clone(),
        name: if product.name.trim().is_empty() {
            product.id.clone()
        } else {
            product.name.clone()
        },
        origin: Some(origin.clone()),
        web_url: product.web_url.clone().or(Some(origin.clone())),
        official_origin: Some(origin),
        official_origins: product.official_origins.clone(),
    })
}

pub(crate) fn product_entry_from_grant(
    grant: &ProductGrant,
    api_base: &str,
) -> DesktopProductCatalogEntry {
    let grant = normalize_product_grant_brand(grant.clone());
    let origin = grant.origin.clone().unwrap_or_else(|| api_base.to_string());
    normalize_catalog_product_brand(DesktopProductCatalogEntry {
        id: grant.id,
        name: grant.name,
        origin: Some(origin.clone()),
        web_url: Some(origin.clone()),
        official_origin: Some(origin.clone()),
        official_origins: vec![origin],
    })
}

pub(crate) fn upsert_catalog_product(
    products: &mut Vec<DesktopProductCatalogEntry>,
    product: DesktopProductCatalogEntry,
) {
    let product = normalize_catalog_product_brand(product);
    if let Some(existing) = products.iter_mut().find(|item| {
        item.id == product.id
            || normalize_product_key(&item.name) == normalize_product_key(&product.name)
    }) {
        *existing = product;
    } else {
        products.push(product);
    }
}

pub(crate) fn profile_id_for_api(api_base: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(api_base.as_bytes());
    let digest = hash.finalize();
    format!(
        "profile_{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7]
    )
}

pub(crate) fn name_for_api(api_base: &str) -> String {
    url::Url::parse(api_base)
        .ok()
        .and_then(|url| url.host_str().map(ToOwned::to_owned))
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| "Custom Bridge Cloud".to_string())
}
