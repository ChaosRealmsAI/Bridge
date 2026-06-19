use super::*;

#[cfg(test)]
pub(crate) fn credentials_products(credentials: &Credentials) -> Vec<ProductGrant> {
    public_product_grants(&aggregate_authorized_products(&credentials_connections(
        credentials,
    )))
}

pub(crate) fn credentials_products_for_profile(
    credentials: &Credentials,
    profile: &CloudProfile,
) -> Vec<ProductGrant> {
    public_product_grants(&aggregate_authorized_products(&connections_for_profile(
        credentials,
        profile,
    )))
}

pub(crate) fn connections_for_selected_profile(credentials: &Credentials) -> Vec<Credentials> {
    let settings = load_settings_with_api(&credentials.api_base);
    let profile = selected_profile_for_settings(&settings);
    connections_for_profile(credentials, &profile)
}

pub(crate) fn connections_for_profile(
    credentials: &Credentials,
    profile: &CloudProfile,
) -> Vec<Credentials> {
    let allow_catalog = profile_catalog_entries(profile);
    credentials_connections(credentials)
        .into_iter()
        .filter_map(|connection| connection_for_profile(connection, profile, &allow_catalog))
        .collect()
}

pub(crate) fn connection_for_profile(
    mut connection: Credentials,
    profile: &CloudProfile,
    allow_catalog: &[DesktopProductCatalogEntry],
) -> Option<Credentials> {
    if connection.api_base != profile.api_base {
        return None;
    }
    let products: Vec<ProductGrant> = connection_products(&connection)
        .into_iter()
        .filter(|grant| profile_catalog_allows_grant(allow_catalog, profile, grant))
        .collect();
    if products.is_empty() {
        return None;
    }
    connection.authorized_products = products;
    Some(connection_without_nested(connection))
}

pub(crate) fn public_product_grants(products: &[ProductGrant]) -> Vec<ProductGrant> {
    products
        .iter()
        .cloned()
        .map(|mut product| {
            product.local_roots = LocalRootBindings::default();
            product
        })
        .collect()
}

pub(crate) fn connection_products(credentials: &Credentials) -> Vec<ProductGrant> {
    if !credentials.authorized_products.is_empty() {
        return credentials
            .authorized_products
            .iter()
            .cloned()
            .map(product_without_accounts)
            .map(normalize_product_grant_brand)
            .collect();
    }
    match (&credentials.product_id, &credentials.product_name) {
        (Some(id), Some(name)) => vec![normalize_product_grant_brand(ProductGrant {
            id: id.clone(),
            name: name.clone(),
            origin: credentials.cloud_origin.clone(),
            authorization: AuthorizationState::Active,
            capabilities: Vec::new(),
            policy: Value::Null,
            epoch: 1,
            accounts: Vec::new(),
            local_roots: LocalRootBindings::default(),
            authorized_at: credentials.claimed_at.clone(),
        })],
        _ => Vec::new(),
    }
}

pub(crate) fn active_connection_products(credentials: &Credentials) -> Vec<ProductGrant> {
    connection_products(credentials)
        .into_iter()
        .filter(|product| product.authorization.is_active())
        .collect()
}

pub(crate) fn product_without_accounts(mut product: ProductGrant) -> ProductGrant {
    product.accounts.clear();
    product
}

pub(crate) fn connection_without_nested(mut credentials: Credentials) -> Credentials {
    credentials.connections.clear();
    credentials.authorized_products = connection_products(&credentials);
    credentials
}

pub(crate) fn credentials_connections(credentials: &Credentials) -> Vec<Credentials> {
    if !credentials.connections.is_empty() {
        return credentials
            .connections
            .iter()
            .cloned()
            .map(connection_without_nested)
            .filter(|item| {
                !item.device_id.trim().is_empty() && !item.device_token.trim().is_empty()
            })
            .collect();
    }
    if credentials.device_id.trim().is_empty() || credentials.device_token.trim().is_empty() {
        return Vec::new();
    }
    vec![connection_without_nested(credentials.clone())]
}

#[cfg(test)]
pub(crate) fn authorized_connections(credentials: &Credentials) -> Vec<Credentials> {
    credentials_connections(credentials)
        .into_iter()
        .filter(|item| !active_connection_products(item).is_empty())
        .collect()
}

pub(crate) fn has_selected_profile_authorized_connections(credentials: &Credentials) -> bool {
    connections_for_selected_profile(credentials)
        .iter()
        .any(|item| !active_connection_products(item).is_empty())
}

pub(crate) fn aggregate_authorized_products(connections: &[Credentials]) -> Vec<ProductGrant> {
    let mut products: Vec<ProductGrant> = Vec::new();
    for connection in connections {
        for product in connection_products(connection) {
            let device = ProductGrantDevice {
                id: connection.device_id.clone(),
                name: connection.device_name.clone(),
                online: connection.device_online,
                last_seen_at: connection.device_last_seen_at.clone(),
                authorized_at: product.authorized_at.clone(),
            };
            let account = ProductGrantAccount {
                id: connection.account_id.clone(),
                email: connection.account_display.clone(),
                display_name: connection.account_display.clone(),
                device_id: Some(connection.device_id.clone()),
                origin: product
                    .origin
                    .clone()
                    .or_else(|| connection.cloud_origin.clone()),
                authorized: product.authorization,
                connected: connection.device_online,
                connection: Some(
                    if product.authorization.is_active() && connection.device_online == Some(true) {
                        "connected".to_string()
                    } else if product.authorization.is_active() {
                        "reconnecting".to_string()
                    } else {
                        "disabled".to_string()
                    },
                ),
                authorized_at: product.authorized_at.clone(),
                devices: vec![device],
            };
            if let Some(existing) = products.iter_mut().find(|item| item.id == product.id) {
                existing.name = product.name.clone();
                existing.origin = product.origin.clone().or_else(|| existing.origin.clone());
                existing.capabilities = product.capabilities.clone();
                existing.authorized_at = product.authorized_at.clone();
                existing.local_roots = LocalRootBindings::default();
                if let Some(existing_account) = existing
                    .accounts
                    .iter_mut()
                    .find(|item| item.id.as_deref() == connection.account_id.as_deref())
                {
                    if !existing_account
                        .devices
                        .iter()
                        .any(|item| item.id == connection.device_id)
                    {
                        existing_account.devices.push(account.devices[0].clone());
                    }
                    if existing_account.device_id.is_none() {
                        existing_account.device_id = Some(connection.device_id.clone());
                    }
                    if existing_account.email.is_none() {
                        existing_account.email = connection.account_display.clone();
                    }
                    if existing_account.display_name.is_none() {
                        existing_account.display_name = connection.account_display.clone();
                    }
                    if product.authorization.is_active() {
                        existing_account.authorized = AuthorizationState::Active;
                    }
                    if account.connected == Some(true) {
                        existing_account.connected = Some(true);
                        existing_account.connection = Some("connected".to_string());
                    } else if existing_account.connected != Some(true)
                        && existing_account.authorized.is_active()
                    {
                        existing_account.connection = Some("reconnecting".to_string());
                    }
                } else {
                    existing.accounts.push(account);
                }
            } else {
                let mut next = product_without_accounts(product);
                next.local_roots = LocalRootBindings::default();
                next.accounts.push(account);
                products.push(next);
            }
        }
    }
    products
}

pub(crate) fn credentials_from_connections(
    connections: Vec<Credentials>,
    preferred: Option<&Credentials>,
    fallback: Option<&Credentials>,
) -> Credentials {
    let mut sanitized: Vec<Credentials> = connections
        .into_iter()
        .map(connection_without_nested)
        .collect();
    sanitized.sort_by(|a, b| {
        let left = format!(
            "{}:{}:{}",
            a.api_base,
            a.account_id.clone().unwrap_or_default(),
            a.device_id
        );
        let right = format!(
            "{}:{}:{}",
            b.api_base,
            b.account_id.clone().unwrap_or_default(),
            b.device_id
        );
        left.cmp(&right)
    });
    let preferred_key = preferred.map(connection_key);
    let authorized = authorized_connections_from_slice(&sanitized);
    let primary = preferred_key
        .as_ref()
        .and_then(|key| sanitized.iter().find(|item| connection_key(item) == *key))
        .or_else(|| authorized.first())
        .or_else(|| sanitized.first())
        .or(fallback)
        .cloned()
        .unwrap_or_else(empty_credentials);
    let active_products = aggregate_authorized_products(&sanitized);
    let primary_direct_products = connection_products(&primary);
    let primary_product = primary_direct_products.first();
    Credentials {
        api_base: primary.api_base.clone(),
        device_id: primary.device_id.clone(),
        device_name: primary.device_name.clone(),
        device_token: primary.device_token.clone(),
        install_id: primary.install_id.clone(),
        account_id: primary.account_id.clone(),
        account_display: primary.account_display.clone(),
        product_id: primary_product.map(|item| item.id.clone()),
        product_name: primary_product.map(|item| item.name.clone()),
        cloud_origin: primary_product
            .and_then(|item| item.origin.clone())
            .or_else(|| primary.cloud_origin.clone()),
        authorized_products: active_products,
        device_token_expires_at: primary.device_token_expires_at.clone(),
        device_token_rotated_at_unix: primary.device_token_rotated_at_unix,
        install_identity_bound: primary.install_identity_bound,
        device_online: primary.device_online,
        device_last_seen_at: primary.device_last_seen_at.clone(),
        connections: sanitized,
        claimed_at: primary.claimed_at.clone(),
    }
}

pub(crate) fn authorized_connections_from_slice(connections: &[Credentials]) -> Vec<Credentials> {
    connections
        .iter()
        .filter(|item| !active_connection_products(item).is_empty())
        .cloned()
        .collect()
}

pub(crate) fn empty_credentials() -> Credentials {
    Credentials {
        api_base: DEFAULT_API.to_string(),
        device_id: String::new(),
        device_name: device_name(),
        device_token: String::new(),
        install_id: None,
        account_id: None,
        account_display: None,
        product_id: None,
        product_name: None,
        cloud_origin: None,
        authorized_products: Vec::new(),
        device_token_expires_at: None,
        device_token_rotated_at_unix: None,
        install_identity_bound: None,
        device_online: None,
        device_last_seen_at: None,
        connections: Vec::new(),
        claimed_at: now_string(),
    }
}

pub(crate) fn connection_key(credentials: &Credentials) -> String {
    if !credentials.device_id.trim().is_empty() {
        return format!("device:{}:{}", credentials.api_base, credentials.device_id);
    }
    if let Some(account_id) = credentials.account_id.as_deref() {
        return format!("account:{}:{}", credentials.api_base, account_id);
    }
    format!(
        "install:{}:{}",
        credentials.api_base,
        credentials.install_id.clone().unwrap_or_default()
    )
}

pub(crate) fn upsert_connection(connections: &mut Vec<Credentials>, next: Credentials) {
    let key = connection_key(&next);
    if let Some(index) = connections
        .iter()
        .position(|item| connection_key(item) == key || item.device_id == next.device_id)
    {
        connections[index] = connection_without_nested(next);
    } else {
        connections.push(connection_without_nested(next));
    }
}

pub(crate) fn merge_authorized_products(
    existing: Option<&Credentials>,
    product_id: Option<String>,
    product_name: Option<String>,
    cloud_origin: Option<String>,
    capabilities: Vec<String>,
    policy: Value,
    epoch: u64,
    authorization: AuthorizationState,
) -> Vec<ProductGrant> {
    let mut products = existing.map(connection_products).unwrap_or_default();
    if let Some(id) = product_id {
        let name = product_name.unwrap_or_else(|| id.clone());
        let mut grant = ProductGrant {
            id: id.clone(),
            name,
            origin: cloud_origin,
            authorization,
            capabilities,
            policy,
            epoch: epoch.max(1),
            accounts: Vec::new(),
            local_roots: LocalRootBindings::default(),
            authorized_at: now_string(),
        };
        if let Some(index) = products.iter().position(|item| item.id == id) {
            grant.local_roots = products[index].local_roots.clone();
            products[index] = grant;
        } else {
            products.push(grant);
        }
    }
    products
}

pub(crate) fn ensure_credentials_install_id(
    mut credentials: Credentials,
) -> Result<Credentials, String> {
    let mut changed = false;
    let install_id = credentials_install_id(Some(&credentials));
    if !credentials
        .install_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        credentials.install_id = Some(install_id.clone());
        changed = true;
    }
    for connection in credentials.connections.iter_mut() {
        if !connection
            .install_id
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            connection.install_id = Some(install_id.clone());
            changed = true;
        }
    }
    if !changed {
        return Ok(credentials);
    }
    let normalized = if credentials.connections.is_empty() {
        credentials
    } else {
        let connections = credentials_connections(&credentials);
        credentials_from_connections(connections, None, Some(&credentials))
    };
    save_credentials(&normalized)?;
    write_connector_state(&normalized)?;
    Ok(normalized)
}

pub(crate) fn credentials_install_id(existing: Option<&Credentials>) -> String {
    if let Some(value) = existing
        .and_then(|credentials| credentials.install_id.clone())
        .filter(|value| !value.trim().is_empty())
    {
        return value;
    }
    if let Some(value) = existing
        .and_then(|credentials| {
            credentials
                .connections
                .iter()
                .find_map(|connection| connection.install_id.clone())
        })
        .filter(|value| !value.trim().is_empty())
    {
        return value;
    }
    if let Ok(value) = env::var("PANDA_BRIDGE_INSTALL_ID") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    random_install_id()
}

pub(crate) fn random_install_id() -> String {
    let mut bytes = [0_u8; 32];
    if fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_ok()
    {
        return format!("pbi_{}", hex_bytes(&bytes));
    }
    format!("pbi_{}_{}", unix_seconds(), std::process::id())
}

pub(crate) fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub(crate) fn cloud_device_online(
    devices: &Option<Vec<CloudDevice>>,
    device_id: &str,
) -> Option<bool> {
    devices
        .as_ref()
        .and_then(|items| items.iter().find(|item| item.id == device_id))
        .and_then(|item| item.online)
}

pub(crate) fn cloud_device_last_seen_at(
    devices: &Option<Vec<CloudDevice>>,
    device_id: &str,
) -> Option<String> {
    devices
        .as_ref()
        .and_then(|items| items.iter().find(|item| item.id == device_id))
        .and_then(|item| item.last_seen_at.clone())
}

pub(crate) fn apply_cloud_devices_to_connections(
    connections: &mut Vec<Credentials>,
    api_base: &str,
    account_id: Option<&str>,
    devices: Option<&[CloudDevice]>,
) -> bool {
    let Some(devices) = devices else {
        return false;
    };
    let Some(account_id) = account_id else {
        return false;
    };
    let device_ids: HashSet<&str> = devices.iter().map(|item| item.id.as_str()).collect();
    let device_map: HashMap<&str, &CloudDevice> = devices
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let before_len = connections.len();
    connections.retain(|connection| {
        connection.api_base != api_base
            || connection.account_id.as_deref() != Some(account_id)
            || device_ids.contains(connection.device_id.as_str())
    });
    let mut changed = connections.len() != before_len;
    for connection in connections.iter_mut().filter(|connection| {
        connection.api_base == api_base && connection.account_id.as_deref() == Some(account_id)
    }) {
        if let Some(device) = device_map.get(connection.device_id.as_str()) {
            if let Some(name) = device.name.as_ref().filter(|name| !name.trim().is_empty()) {
                if connection.device_name != *name {
                    connection.device_name = name.clone();
                    changed = true;
                }
            }
            if connection.device_online != device.online {
                connection.device_online = device.online;
                changed = true;
            }
            if connection.device_last_seen_at != device.last_seen_at {
                connection.device_last_seen_at = device.last_seen_at.clone();
                changed = true;
            }
        }
    }
    changed
}
