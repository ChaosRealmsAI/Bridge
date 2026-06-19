use super::*;

pub(crate) fn start_worker(
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<Value, String> {
    prepare_connections_for_worker(state, &proxy)?;
    let already_running = state.worker_running.swap(true, Ordering::SeqCst);
    if !already_running {
        if let Ok(mut keys) = state.realtime_connection_keys.lock() {
            keys.clear();
        }
    }
    let spawned_realtime_connections = spawn_missing_realtime_workers(state, &proxy)?;
    if already_running {
        return Ok(json!({
            "ok": true,
            "message": "worker already running",
            "spawned_realtime_connections": spawned_realtime_connections
        }));
    }
    let running = state.worker_running.clone();
    let fallback_state = state.clone();
    let fallback_proxy = proxy.clone();
    thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            let _ = spawn_missing_realtime_workers(&fallback_state, &fallback_proxy);
            let event_payload = match load_credentials()
                .and_then(|credentials| poll_all_connections(&credentials))
            {
                Ok(payload) => payload,
                Err(error) => {
                    json!({ "message": format!("worker tick failed: {error}"), "error": error })
                }
            };
            let message = event_payload
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| {
                    event_payload
                        .get("count")
                        .and_then(Value::as_i64)
                        .map(|_| "worker tick ok")
                })
                .unwrap_or("worker tick")
                .to_string();
            push_event(&fallback_state, "worker_tick", event_payload.clone());
            let _ = fallback_proxy.send_event(UserEvent::UiEvent(json!({
                "type": "event",
                "event": "log",
                "message": message
            })));
            let _ = fallback_proxy.send_event(UserEvent::UiEvent(
                json!({ "type": "event", "event": "refresh" }),
            ));
            thread::sleep(Duration::from_millis(heartbeat_interval_ms()));
        }
    });
    push_event(
        state,
        "worker_started",
        json!({
            "message": "worker started",
            "spawned_realtime_connections": spawned_realtime_connections
        }),
    );
    Ok(json!({
        "ok": true,
        "message": "worker started",
        "spawned_realtime_connections": spawned_realtime_connections
    }))
}

pub(crate) fn heartbeat(credentials: &Credentials) -> Result<HeartbeatResponse, String> {
    let install_id = credentials_install_id(Some(credentials));
    let product_ids = active_connection_products(credentials)
        .into_iter()
        .map(|product| product.id)
        .collect::<Vec<_>>();
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state_for_products(&product_ids),
        "install_id": install_id
    });
    let url = format!("{}/v1/connectors/heartbeat", credentials.api_base);
    post_json_with_install(
        &url,
        &body,
        Some(&credentials.device_token),
        Some(&install_id),
    )
}

pub(crate) fn prepare_connections_for_worker(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<Vec<Credentials>, String> {
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    let settings = load_settings_with_api(&credentials.api_base);
    let profile = selected_profile_for_settings(&settings);
    let mut connections = connections_for_profile(&credentials, &profile);
    if connections
        .iter()
        .all(|item| active_connection_products(item).is_empty())
    {
        state.worker_running.store(false, Ordering::SeqCst);
        state.realtime_connected.store(false, Ordering::SeqCst);
        return Err("no_authorized_products".to_string());
    }
    let mut changed = false;
    for connection in connections.iter_mut() {
        if active_connection_products(connection).is_empty()
            || !device_token_rotation_due(connection)
        {
            continue;
        }
        match rotate_device_token(connection) {
            Ok(next) => {
                *connection = next.clone();
                changed = true;
                push_event(
                    state,
                    "device_token_rotated",
                    json!({
                        "device_id": next.device_id,
                        "account_id": next.account_id,
                        "token_expires_at": next.device_token_expires_at,
                        "install_identity_bound": next.install_identity_bound
                    }),
                );
                let _ = proxy.send_event(UserEvent::UiEvent(json!({
                    "type": "event",
                    "event": "refresh"
                })));
            }
            Err(error) => {
                push_event(
                    state,
                    "device_token_rotation_failed",
                    json!({
                        "device_id": connection.device_id,
                        "account_id": connection.account_id,
                        "error": error
                    }),
                );
            }
        }
    }
    if changed {
        let mut merged_connections = credentials_connections(&credentials);
        for connection in &connections {
            upsert_connection(&mut merged_connections, connection.clone());
        }
        let next = credentials_from_connections(merged_connections, None, Some(&credentials));
        save_credentials(&next)?;
        write_connector_state(&next)?;
        return Ok(connections_for_profile(&next, &profile)
            .into_iter()
            .filter(|item| !active_connection_products(item).is_empty())
            .collect());
    }
    Ok(connections
        .into_iter()
        .filter(|item| !active_connection_products(item).is_empty())
        .collect())
}

pub(crate) fn rotate_device_token(credentials: &Credentials) -> Result<Credentials, String> {
    let product_ids = active_connection_products(credentials)
        .into_iter()
        .map(|product| product.id)
        .collect::<Vec<_>>();
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state_for_products(&product_ids),
        "install_id": credentials.install_id.clone().unwrap_or_default()
    });
    let url = format!("{}/v1/connectors/token/rotate", credentials.api_base);
    let payload: RotateTokenResponse = post_json_with_install(
        &url,
        &body,
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    let _old_token_expires_at = payload.old_token_expires_at.clone();
    let mut next = credentials.clone();
    next.device_token = payload.device_token;
    next.device_token_expires_at = payload.token_expires_at;
    next.device_token_rotated_at_unix = Some(unix_seconds());
    next.install_identity_bound = payload.install_identity_bound;
    Ok(connection_without_nested(next))
}

pub(crate) fn device_token_rotation_due(credentials: &Credentials) -> bool {
    let interval = token_rotation_interval_seconds();
    if interval == 0 {
        return true;
    }
    let rotated_at = credentials.device_token_rotated_at_unix.unwrap_or(0);
    unix_seconds().saturating_sub(rotated_at) >= interval
}

pub(crate) fn token_rotation_interval_seconds() -> u64 {
    env::var("PANDA_BRIDGE_TOKEN_ROTATION_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(60 * 60 * 24)
}

pub(crate) fn heartbeat_interval_ms() -> u64 {
    env::var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000)
}
