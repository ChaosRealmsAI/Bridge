use super::*;

pub(crate) fn status(state: &AppState) -> DesktopStatus {
    let credentials = load_credentials().ok();
    let settings = load_settings_with_api(
        credentials
            .as_ref()
            .map(|item| item.api_base.as_str())
            .unwrap_or(DEFAULT_API),
    );
    let profile = selected_profile_for_settings(&settings);
    let products = desktop_products(credentials.as_ref(), state, &settings);
    let selected_profile = selected_profile_live_status(credentials.as_ref(), state, &settings);
    DesktopStatus {
        api_base: credentials.as_ref().map(|item| item.api_base.clone()),
        device_id: credentials.as_ref().map(|item| item.device_id.clone()),
        device_name: credentials.as_ref().map(|item| item.device_name.clone()),
        local_device: local_device_info(),
        account_id: credentials
            .as_ref()
            .and_then(|item| item.account_id.clone()),
        account_display: credentials
            .as_ref()
            .and_then(|item| item.account_display.clone()),
        product_id: credentials
            .as_ref()
            .and_then(|item| item.product_id.clone()),
        product_name: credentials
            .as_ref()
            .and_then(|item| item.product_name.clone()),
        cloud_origin: credentials
            .as_ref()
            .and_then(|item| item.cloud_origin.clone()),
        authorized_products: credentials
            .as_ref()
            .map(|item| credentials_products_for_profile(item, &profile))
            .unwrap_or_default(),
        products,
        settings,
        selected_profile,
        worker_running: state.worker_running.load(Ordering::SeqCst),
        realtime_connected: state.realtime_connected.load(Ordering::SeqCst),
    }
}

#[derive(Clone, Copy)]
pub(crate) struct KnownProduct {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) origin: &'static str,
    pub(crate) web_url: &'static str,
}

pub(crate) fn known_products() -> [KnownProduct; 1] {
    [KnownProduct {
        id: "panda-burn",
        name: "Burn",
        origin: "https://token-burn.com",
        web_url: "https://token-burn.com/authorize",
    }]
}

pub(crate) fn desktop_products(
    credentials: Option<&Credentials>,
    _state: &AppState,
    settings: &DesktopSettings,
) -> Vec<DesktopProductStatus> {
    let connections = credentials.map(credentials_connections).unwrap_or_default();
    let profile = selected_profile_for_settings(settings);
    let allow_catalog = profile_catalog_entries(&profile);
    let mut catalog = allow_catalog.clone();
    for connection in connections
        .iter()
        .filter(|connection| connection.api_base == profile.api_base)
    {
        for grant in connection_products(connection) {
            if !profile_catalog_allows_grant(&allow_catalog, &profile, &grant) {
                continue;
            }
            if catalog
                .iter()
                .any(|product| catalog_matches_grant(product, &grant, &profile))
            {
                continue;
            }
            upsert_catalog_product(
                &mut catalog,
                product_entry_from_grant(&grant, &profile.api_base),
            );
        }
    }
    catalog
        .into_iter()
        .map(|product| {
            let mut accounts: Vec<DesktopAccountStatus> = Vec::new();
            for connection in connections
                .iter()
                .filter(|connection| connection.api_base == profile.api_base)
            {
                for grant in connection_products(connection)
                    .into_iter()
                    .filter(|grant| profile_catalog_allows_grant(&allow_catalog, &profile, grant))
                    .filter(|grant| catalog_matches_grant(&product, grant, &profile))
                {
                    upsert_desktop_account_status(&mut accounts, connection, &grant);
                }
            }
            accounts.sort_by(|left, right| left.email.cmp(&right.email));
            let connected = accounts.iter().any(|account| account.connected);
            let reconnecting = accounts.iter().any(|account| {
                account.authorized.is_active() && account.connection == "reconnecting"
            });
            DesktopProductStatus {
                id: product.id,
                name: product.name,
                origin: product
                    .origin
                    .clone()
                    .or_else(|| product.official_origin.clone())
                    .unwrap_or_else(|| profile.api_base.clone()),
                web_url: product
                    .web_url
                    .clone()
                    .or_else(|| product.origin.clone())
                    .unwrap_or_else(|| {
                        profile
                            .web_origin
                            .clone()
                            .unwrap_or_else(|| profile.api_base.clone())
                    }),
                accounts,
                connected,
                connection: if connected {
                    "connected".to_string()
                } else if reconnecting {
                    "reconnecting".to_string()
                } else {
                    "offline".to_string()
                },
            }
        })
        .collect()
}

pub(crate) fn selected_profile_for_settings(settings: &DesktopSettings) -> CloudProfile {
    selected_cloud_profile(settings)
        .cloned()
        .unwrap_or_else(official_cloud_profile)
}

pub(crate) fn fixed_product_catalog_entries() -> Vec<DesktopProductCatalogEntry> {
    known_products()
        .into_iter()
        .map(product_entry_from_known)
        .collect()
}

pub(crate) fn profile_catalog_entries(_profile: &CloudProfile) -> Vec<DesktopProductCatalogEntry> {
    fixed_product_catalog_entries()
}

pub(crate) fn profile_catalog_allows_grant(
    catalog: &[DesktopProductCatalogEntry],
    profile: &CloudProfile,
    grant: &ProductGrant,
) -> bool {
    catalog.is_empty()
        || catalog
            .iter()
            .any(|product| catalog_matches_grant(product, grant, profile))
}

pub(crate) fn upsert_desktop_account_status(
    accounts: &mut Vec<DesktopAccountStatus>,
    connection: &Credentials,
    grant: &ProductGrant,
) {
    let email = connection
        .account_display
        .clone()
        .or_else(|| connection.account_id.clone())
        .unwrap_or_else(|| "Panda Account".to_string());
    let connection_enabled = grant.connection_enabled;
    let connected = grant.authorization.is_active()
        && connection_enabled
        && connection.device_online == Some(true);
    let connection_state = if connected {
        "connected"
    } else if grant.authorization.is_active() && connection_enabled {
        "reconnecting"
    } else {
        "disabled"
    };
    let key = connection
        .account_id
        .as_deref()
        .unwrap_or(email.as_str())
        .to_string();
    if let Some(existing) = accounts.iter_mut().find(|item| {
        item.id.as_deref() == Some(key.as_str())
            || item.email == email
            || connection
                .account_display
                .as_deref()
                .map(|display| item.email == display)
                .unwrap_or(false)
    }) {
        if grant.authorization.is_active() {
            existing.authorized = AuthorizationState::Active;
        }
        if connection_enabled {
            existing.connection_enabled = true;
        }
        if connected {
            existing.connected = true;
            existing.connection = "connected".to_string();
        } else if !existing.connected && existing.authorized.is_active() && existing.connection_enabled
        {
            existing.connection = "reconnecting".to_string();
        } else if !existing.connected {
            existing.connection = "disabled".to_string();
        }
        if existing.product_id.is_none() {
            existing.product_id = Some(grant.id.clone());
        }
        return;
    }
    accounts.push(DesktopAccountStatus {
        id: connection.account_id.clone().or(Some(key)),
        email,
        product_id: Some(grant.id.clone()),
        device_id: connection.device_id.clone(),
        authorized: grant.authorization,
        connection_enabled,
        connected,
        connection: connection_state.to_string(),
    });
}

pub(crate) fn selected_profile_live_status(
    credentials: Option<&Credentials>,
    state: &AppState,
    settings: &DesktopSettings,
) -> SelectedProfileLiveStatus {
    let profile = selected_profile_for_settings(settings);
    let selected_connections = credentials
        .map(|item| selected_profile_credential_rows(item, &profile))
        .unwrap_or_default();
    let selected_grants = selected_profile_grants(&selected_connections, &profile);
    let server = selected_server_status(&profile, &selected_connections);
    let device = selected_device_status(&selected_connections);
    let account = selected_account_status(&selected_connections, &selected_grants);
    let local_engine = selected_local_engine_status(state, &account.product_ids);
    let transport = selected_transport_status(state, &selected_connections, &account);

    SelectedProfileLiveStatus {
        profile_id: profile.id,
        label: profile.name,
        api_base: profile.api_base,
        server,
        device,
        account,
        local_engine,
        transport,
    }
}

pub(crate) fn selected_profile_credential_rows(
    credentials: &Credentials,
    profile: &CloudProfile,
) -> Vec<Credentials> {
    credentials_connections(credentials)
        .into_iter()
        .filter(|connection| {
            connection.api_base == profile.api_base
                && !connection.device_id.trim().is_empty()
                && !connection.device_token.trim().is_empty()
        })
        .collect()
}

pub(crate) fn selected_profile_grants(
    connections: &[Credentials],
    profile: &CloudProfile,
) -> Vec<ProductGrant> {
    let allow_catalog = profile_catalog_entries(profile);
    let mut grants = Vec::new();
    for connection in connections {
        for grant in connection_products(connection) {
            if profile_catalog_allows_grant(&allow_catalog, profile, &grant) {
                grants.push(grant);
            }
        }
    }
    grants
}

fn selected_server_status(
    profile: &CloudProfile,
    _selected_connections: &[Credentials],
) -> SelectedServerLiveStatus {
    let updated_at = profile.updated_at.trim();
    if let Some(failure) = profile_probe_error(updated_at) {
        return SelectedServerLiveStatus {
            reachable: Some(false),
            compatible: Some(false),
            last_probe_at: Some(failure.at),
            probe_latency_ms: failure.latency_ms,
            health_latency_ms: failure.health_latency_ms,
            diagnostics_latency_ms: failure.diagnostics_latency_ms,
            failure_phase: failure.phase,
            error: Some(failure.error),
            source: "profile_probe_error".to_string(),
        };
    }
    let probe = profile_probe_success(updated_at);
    if let Some(probe) = probe.as_ref().filter(|probe| !probe.fresh) {
        return SelectedServerLiveStatus {
            reachable: None,
            compatible: None,
            last_probe_at: Some(probe.at.clone()),
            probe_latency_ms: None,
            health_latency_ms: probe.health_latency_ms,
            diagnostics_latency_ms: probe.diagnostics_latency_ms,
            failure_phase: None,
            error: Some("profile probe stale".to_string()),
            source: "profile_probe_stale".to_string(),
        };
    }
    let probe_latency_ms = probe.as_ref().and_then(|probe| probe.latency_ms);
    let health_latency_ms = probe.as_ref().and_then(|probe| probe.health_latency_ms);
    let diagnostics_latency_ms = probe
        .as_ref()
        .and_then(|probe| probe.diagnostics_latency_ms);
    let last_probe_at = probe.map(|probe| probe.at);
    let reachable = if last_probe_at.is_some() {
        Some(true)
    } else {
        None
    };
    let compatible = if last_probe_at.is_some() {
        Some(true)
    } else {
        None
    };
    let source = if last_probe_at.is_some() {
        "profile_probe"
    } else {
        "not_probed"
    };
    SelectedServerLiveStatus {
        reachable,
        compatible,
        last_probe_at,
        probe_latency_ms,
        health_latency_ms,
        diagnostics_latency_ms,
        failure_phase: None,
        error: None,
        source: source.to_string(),
    }
}

fn selected_device_status(selected_connections: &[Credentials]) -> SelectedDeviceLiveStatus {
    let paired = selected_connections.iter().any(|connection| {
        !connection.device_id.trim().is_empty() && !connection.device_token.trim().is_empty()
    });
    let present = if !paired {
        Some(false)
    } else if selected_connections
        .iter()
        .any(|connection| connection.device_online == Some(true))
    {
        Some(true)
    } else if selected_connections
        .iter()
        .any(|connection| connection.device_online == Some(false))
    {
        Some(false)
    } else {
        None
    };
    let last_seen_at = selected_connections
        .iter()
        .filter_map(|connection| connection.device_last_seen_at.clone())
        .max();
    let selected = selected_connections.first();
    SelectedDeviceLiveStatus {
        paired,
        present,
        last_seen_at,
        device_id: selected.map(|connection| connection.device_id.clone()),
        device_name: selected.map(|connection| connection.device_name.clone()),
    }
}

fn selected_account_status(
    selected_connections: &[Credentials],
    selected_grants: &[ProductGrant],
) -> SelectedAccountLiveStatus {
    let authorized = selected_grants
        .iter()
        .any(|grant| grant.authorization.is_active());
    let connection_enabled = selected_grants
        .iter()
        .any(|grant| grant.authorization.is_active() && grant.connection_enabled);
    let authorization_state = if authorized {
        "active"
    } else if selected_grants
        .iter()
        .any(|grant| grant.authorization == AuthorizationState::Pending)
    {
        "pending"
    } else if selected_grants
        .iter()
        .any(|grant| grant.authorization == AuthorizationState::Paused)
    {
        "paused"
    } else {
        "none"
    };
    let product_ids = selected_grants
        .iter()
        .filter(|grant| grant.authorization.is_active() && grant.connection_enabled)
        .map(|grant| grant.id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let selected = selected_connections.first();
    SelectedAccountLiveStatus {
        authorized,
        authorization_state: authorization_state.to_string(),
        connection_enabled,
        account_id: selected.and_then(|connection| connection.account_id.clone()),
        account_display: selected.and_then(|connection| connection.account_display.clone()),
        product_ids,
    }
}

fn selected_local_engine_status(
    state: &AppState,
    product_ids: &[String],
) -> SelectedLocalEngineLiveStatus {
    let mut adapter_products = product_ids
        .iter()
        .map(|product_id| selected_adapter_live_status(product_id))
        .collect::<Vec<_>>();
    adapter_products.sort_by(|left, right| left.product_id.cmp(&right.product_id));
    let adapter_running = adapter_products.iter().any(|product| product.running);
    let adapter_configured = adapter_products.iter().any(|product| product.configured);
    let adapter_health = if product_ids.is_empty() {
        "idle"
    } else if adapter_products
        .iter()
        .any(|product| product.state == "missing")
    {
        if adapter_products.iter().any(|product| product.configured) {
            "partial"
        } else {
            "missing"
        }
    } else if adapter_running {
        "running"
    } else if adapter_configured {
        "configured"
    } else {
        "unknown"
    };
    SelectedLocalEngineLiveStatus {
        running: state.worker_running.load(Ordering::SeqCst),
        adapter_health: adapter_health.to_string(),
        adapter_configured,
        adapter_running,
        adapter_products,
    }
}

fn selected_adapter_live_status(product_id: &str) -> SelectedAdapterLiveStatus {
    let managed = managed_adapter_info(product_id);
    let external = external_adapter_endpoint_for_product(product_id).is_some();
    let manifest = find_managed_adapter_manifest(product_id).is_some();
    let running = managed.is_some();
    let configured = external || manifest || running;
    let (state, endpoint_source) = if running {
        ("running", "managed_process")
    } else if external {
        ("configured", "external_env")
    } else if manifest {
        ("available", "managed_manifest")
    } else {
        ("missing", "missing")
    };
    SelectedAdapterLiveStatus {
        product_id: product_id.to_string(),
        state: state.to_string(),
        configured,
        running,
        endpoint_source: endpoint_source.to_string(),
    }
}

fn selected_transport_status(
    state: &AppState,
    selected_connections: &[Credentials],
    account: &SelectedAccountLiveStatus,
) -> SelectedTransportLiveStatus {
    let worker_running = state.worker_running.load(Ordering::SeqCst);
    let selected_keys = selected_connections
        .iter()
        .filter(|connection| !active_connection_products(connection).is_empty())
        .map(realtime_connection_key)
        .collect::<HashSet<_>>();
    let selected_realtime_registered = state
        .realtime_connection_keys
        .lock()
        .map(|keys| selected_keys.iter().any(|key| keys.contains(key)))
        .unwrap_or(false);
    let selected_realtime_connected = state
        .realtime_connected_keys
        .lock()
        .map(|keys| selected_keys.iter().any(|key| keys.contains(key)))
        .unwrap_or(false);
    let realtime_connected =
        selected_realtime_connected && selected_realtime_registered && account.connection_enabled;
    let polling_active = worker_running && account.connection_enabled;
    let realtime_state = if !account.authorized {
        "idle"
    } else if !account.connection_enabled {
        "idle"
    } else if !worker_running {
        "degraded"
    } else if realtime_connected {
        "connected"
    } else if selected_realtime_registered {
        "degraded"
    } else {
        "degraded"
    };
    let polling_state = if polling_active {
        "active"
    } else if account.authorized && account.connection_enabled {
        "stopped"
    } else {
        "idle"
    };
    let degraded_reason = if realtime_connected {
        None
    } else if polling_active && selected_realtime_registered {
        Some("realtime_disconnected_polling_fallback".to_string())
    } else if polling_active {
        Some("selected_profile_realtime_not_connected_polling_fallback".to_string())
    } else if account.authorized && account.connection_enabled {
        Some("worker_stopped".to_string())
    } else {
        None
    };

    SelectedTransportLiveStatus {
        realtime_state: realtime_state.to_string(),
        polling_state: polling_state.to_string(),
        realtime_connected,
        polling_active,
        degraded_reason,
    }
}

pub(crate) fn catalog_matches_grant(
    product: &DesktopProductCatalogEntry,
    grant: &ProductGrant,
    profile: &CloudProfile,
) -> bool {
    normalize_product_key(&product.id) == normalize_product_key(&grant.id)
        || normalize_product_key(&product.name) == normalize_product_key(&grant.name)
        || (profile.id == "official"
            && known_products()
                .into_iter()
                .find(|known| normalize_product_key(known.id) == normalize_product_key(&product.id))
                .map(|known| product_matches_known(grant, known))
                .unwrap_or(false))
}

pub(crate) fn product_matches_known(product: &ProductGrant, known: KnownProduct) -> bool {
    known_product_id_for_grant(product) == known.id
}

pub(crate) fn known_product_id_for_grant(product: &ProductGrant) -> &'static str {
    let _ = product;
    ""
}

pub(crate) fn normalize_product_grant_brand(product: ProductGrant) -> ProductGrant {
    product
}

pub(crate) fn normalize_catalog_product_brand(
    product: DesktopProductCatalogEntry,
) -> DesktopProductCatalogEntry {
    product
}

pub(crate) fn product_matches_target(product: &ProductGrant, target: &str) -> bool {
    let normalized_target = normalize_product_key(target);
    if normalized_target.is_empty() {
        return false;
    }
    normalize_product_key(&product.id) == normalized_target
        || normalize_product_key(&product.name) == normalized_target
        || known_product_id_for_grant(product) == normalized_target
}

pub(crate) fn normalize_product_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn connection_matches_account(connection: &Credentials, account: Option<&str>) -> bool {
    let Some(account) = account.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    connection.account_id.as_deref() == Some(account)
        || connection.account_display.as_deref() == Some(account)
}
