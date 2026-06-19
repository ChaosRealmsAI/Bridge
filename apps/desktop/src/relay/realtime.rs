use super::*;

#[derive(Debug, Clone)]
pub(crate) struct ReconnectBackoff {
    pub(crate) attempt: u32,
    pub(crate) base_ms: u64,
    pub(crate) max_ms: u64,
}

impl ReconnectBackoff {
    pub(crate) fn new() -> Self {
        Self {
            attempt: 0,
            base_ms: realtime_reconnect_base_ms(),
            max_ms: realtime_reconnect_max_ms(),
        }
    }

    pub(crate) fn next_delay_ms(&mut self) -> u64 {
        let delay = reconnect_delay_ms(self.attempt, self.base_ms, self.max_ms);
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    pub(crate) fn reset(&mut self) {
        self.attempt = 0;
    }
}

pub(crate) fn reconnect_delay_ms(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let shift = attempt.min(16);
    base_ms
        .max(1)
        .saturating_mul(1_u64 << shift)
        .min(max_ms.max(base_ms.max(1)))
}

pub(crate) fn realtime_reconnect_base_ms() -> u64 {
    env::var("PANDA_BRIDGE_REALTIME_RECONNECT_BASE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000)
}

pub(crate) fn realtime_reconnect_max_ms() -> u64 {
    env::var("PANDA_BRIDGE_REALTIME_RECONNECT_MAX_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000)
}

pub(crate) fn sleep_while_running(running: &Arc<AtomicBool>, duration: Duration) {
    let started = Instant::now();
    while running.load(Ordering::SeqCst) && started.elapsed() < duration {
        let remaining = duration.saturating_sub(started.elapsed());
        thread::sleep(remaining.min(Duration::from_millis(250)));
    }
}

pub(crate) fn spawn_missing_realtime_workers(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<usize, String> {
    let connections = connections_for_selected_profile(&load_credentials()?)
        .into_iter()
        .filter(|item| !active_connection_products(item).is_empty())
        .collect::<Vec<_>>();
    let mut spawned = 0_usize;
    for connection in connections {
        let key = realtime_connection_key(&connection);
        let should_spawn = {
            let mut keys = state
                .realtime_connection_keys
                .lock()
                .map_err(|_| "realtime connection registry unavailable".to_string())?;
            if keys.contains(&key) {
                false
            } else {
                keys.insert(key.clone());
                true
            }
        };
        if !should_spawn {
            continue;
        }
        spawned += 1;
        let running = state.worker_running.clone();
        let realtime_connected = state.realtime_connected.clone();
        let thread_state = state.clone();
        let thread_proxy = proxy.clone();
        thread::spawn(move || {
            push_event(
                &thread_state,
                "realtime_worker_started",
                realtime_connection_payload(&connection),
            );
            let mut backoff = ReconnectBackoff::new();
            while running.load(Ordering::SeqCst) {
                let result = run_realtime_worker(
                    &connection,
                    &running,
                    &realtime_connected,
                    &thread_state,
                    &thread_proxy,
                );
                if let Err(error) = result {
                    realtime_connected.store(false, Ordering::SeqCst);
                    let delay_ms = backoff.next_delay_ms();
                    push_event(
                        &thread_state,
                        "realtime_disconnected",
                        json!({
                            "error": redact_error_text(&error),
                            "connection": realtime_connection_payload(&connection),
                            "reconnect_in_ms": delay_ms
                        }),
                    );
                    let _ = thread_proxy.send_event(UserEvent::UiEvent(json!({
                        "type": "event",
                        "event": "log",
                        "message": "realtime disconnected; polling fallback active"
                    })));
                    push_event(
                        &thread_state,
                        "realtime_reconnect_scheduled",
                        json!({
                            "delay_ms": delay_ms,
                            "connection": realtime_connection_payload(&connection)
                        }),
                    );
                    sleep_while_running(&running, Duration::from_millis(delay_ms));
                } else {
                    backoff.reset();
                }
            }
            if let Ok(mut keys) = thread_state.realtime_connection_keys.lock() {
                keys.remove(&key);
                if keys.is_empty() {
                    realtime_connected.store(false, Ordering::SeqCst);
                }
            }
        });
    }
    Ok(spawned)
}

pub(crate) fn realtime_connection_key(credentials: &Credentials) -> String {
    format!(
        "{}|{}|{}",
        credentials.api_base,
        credentials.device_id,
        credentials
            .account_id
            .as_deref()
            .unwrap_or("unknown-account")
    )
}

pub(crate) fn realtime_connection_payload(credentials: &Credentials) -> Value {
    json!({
        "api_base": credentials.api_base,
        "device_id": credentials.device_id,
        "account_id": credentials.account_id,
        "account_display": credentials.account_display,
        "product_ids": active_connection_products(credentials)
            .into_iter()
            .map(|product| product.id)
            .collect::<Vec<_>>()
    })
}

pub(crate) fn run_realtime_worker(
    credentials: &Credentials,
    running: &Arc<AtomicBool>,
    realtime_connected: &Arc<AtomicBool>,
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<(), String> {
    let ws_url = realtime_url(credentials)?;
    let mut request = ws_url
        .into_client_request()
        .map_err(|error| format!("invalid realtime request: {error}"))?;
    let auth = format!("Bearer {}", credentials.device_token);
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&auth).map_err(|error| error.to_string())?,
    );
    if let Some(install_id) = credentials.install_id.as_deref() {
        request.headers_mut().insert(
            "x-panda-bridge-install-id",
            HeaderValue::from_str(install_id).map_err(|error| error.to_string())?,
        );
    }
    let (mut socket, _) =
        connect(request).map_err(|error| format!("realtime connect failed: {error}"))?;
    realtime_connected.store(true, Ordering::SeqCst);
    push_event(
        state,
        "realtime_connected",
        json!({
            "device_id": credentials.device_id,
            "account_id": credentials.account_id,
            "account_display": credentials.account_display,
            "product_ids": active_connection_products(credentials)
                .into_iter()
                .map(|product| product.id)
                .collect::<Vec<_>>(),
            "transport": "websocket"
        }),
    );
    let _ = proxy.send_event(UserEvent::UiEvent(json!({
        "type": "event",
        "event": "log",
        "message": "realtime connected"
    })));
    let _ = proxy.send_event(UserEvent::UiEvent(
        json!({ "type": "event", "event": "refresh" }),
    ));
    let mut processed = std::collections::HashSet::<String>::new();
    while running.load(Ordering::SeqCst) {
        let message = socket
            .read()
            .map_err(|error| format!("realtime read failed: {error}"))?;
        match message {
            Message::Text(text) => {
                let envelope: RealtimeEnvelope = serde_json::from_str(&text)
                    .map_err(|error| format!("invalid realtime message: {error}; body={text}"))?;
                if envelope.message_type == "realtime.ready" {
                    continue;
                }
                if envelope.message_type == "realtime.error" {
                    return Err(envelope
                        .error
                        .unwrap_or_else(|| "realtime error".to_string()));
                }
                if envelope.message_type == "authorization.epoch_bump" {
                    if let Some(authorization) = envelope.authorization {
                        if apply_authorization_epoch_bump(
                            &authorization.product_id,
                            authorization.status,
                            authorization.epoch,
                        )
                        .unwrap_or(false)
                        {
                            push_event(
                                state,
                                "authorization_epoch_bump",
                                json!({
                                    "product_id": authorization.product_id,
                                    "epoch": authorization.epoch
                                }),
                            );
                        }
                    }
                    continue;
                }
                if envelope.message_type == "relay.envelope" {
                    if let Some(relay) = envelope.envelope {
                        if !processed.contains(&relay.id) {
                            let current_connection = refreshed_connection(credentials);
                            if !connection_authorizes_product_active(
                                &current_connection,
                                &relay.product_id,
                            ) {
                                push_event(
                                    state,
                                    "realtime_relay_skipped",
                                    json!({
                                        "envelope_id": relay.id,
                                        "product_id": relay.product_id,
                                        "reason": "authorization_paused_locally"
                                    }),
                                );
                                continue;
                            }
                            push_event(
                                state,
                                "realtime_relay_envelope",
                                json!({
                                    "envelope_id": relay.id,
                                    "product_id": relay.product_id,
                                    "channel_id": relay.channel_id,
                                    "device_id": credentials.device_id,
                                    "account_id": credentials.account_id,
                                    "transport": "websocket"
                                }),
                            );
                            let _ = proxy.send_event(UserEvent::UiEvent(
                                json!({ "type": "event", "event": "refresh" }),
                            ));
                            route_and_ack_relay_envelope(&current_connection, &relay)?;
                            processed.insert(relay.id.clone());
                        }
                    }
                }
            }
            Message::Ping(payload) => {
                let _ = socket.send(Message::Pong(payload));
            }
            Message::Close(_) => return Err("realtime socket closed".to_string()),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn realtime_url(credentials: &Credentials) -> Result<String, String> {
    let mut base = url::Url::parse(&credentials.api_base).map_err(|error| error.to_string())?;
    let scheme = match base.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(format!("unsupported realtime scheme: {other}")),
    };
    base.set_scheme(scheme)
        .map_err(|_| "failed to set realtime scheme".to_string())?;
    base.set_path(&format!(
        "/v1/realtime/devices/{}",
        urlencoding::encode(&credentials.device_id)
    ));
    base.set_query(Some("role=desktop"));
    Ok(base.to_string())
}
