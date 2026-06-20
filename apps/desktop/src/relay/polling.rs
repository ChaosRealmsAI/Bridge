use super::*;

pub(crate) fn poll_all_connections(credentials: &Credentials) -> Result<Value, String> {
    let connections = connections_for_selected_profile(credentials)
        .into_iter()
        .filter(|item| !active_connection_products(item).is_empty())
        .collect::<Vec<_>>();
    if connections.is_empty() {
        return Ok(json!({
            "ok": true,
            "count": 0,
            "connections": [],
            "errors": [],
            "message": "worker tick ok, jobs=0"
        }));
    }
    let mut total = 0_usize;
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut synced_connections = credentials_connections(credentials);
    for connection in connections.iter() {
        match heartbeat(connection).and_then(|heartbeat| {
            let _ = sync_relay_key_bootstrap(connection);
            poll_once(connection).map(|count| (heartbeat, count))
        }) {
            Ok((heartbeat, count)) => {
                if heartbeat.devices.is_some() {
                    apply_cloud_devices_to_connections(
                        &mut synced_connections,
                        &connection.api_base,
                        connection.account_id.as_deref(),
                        heartbeat.devices.as_deref(),
                    );
                    let next = credentials_from_connections(
                        synced_connections.clone(),
                        Some(connection),
                        Some(credentials),
                    );
                    let _ = save_credentials(&next).and_then(|_| write_connector_state(&next));
                }
                total += count;
                results.push(json!({
                    "ok": true,
                    "account_id": connection.account_id.clone(),
                    "account_display": connection.account_display.clone(),
                    "device_id": connection.device_id.clone(),
                    "products": connection_products(connection).into_iter().map(|item| item.id).collect::<Vec<_>>(),
                    "count": count
                }));
            }
            Err(error) => {
                let redacted = redact_error_text(&error);
                errors.push(json!({
                    "account_id": connection.account_id.clone(),
                    "account_display": connection.account_display.clone(),
                    "device_id": connection.device_id.clone(),
                    "error": redacted
                }));
            }
        }
    }
    if results.is_empty() && !errors.is_empty() {
        let detail = serde_json::to_string(&errors).unwrap_or_else(|_| "[]".to_string());
        return Err(format!(
            "all connection polls failed: {}; errors={detail}",
            errors.len()
        ));
    }
    Ok(json!({
        "ok": true,
        "count": total,
        "connections": results,
        "errors": errors,
            "message": format!("worker tick ok, relay_envelopes={total}")
    }))
}

pub(crate) fn poll_once(credentials: &Credentials) -> Result<usize, String> {
    let url = format!("{}/v1/connectors/relay/envelopes", credentials.api_base);
    let payload: RelayEnvelopesResponse = get_json_with_install(
        &url,
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    let count = payload.items.len();
    for envelope in payload.items {
        if !connection_authorizes_product_active(credentials, &envelope.product_id) {
            continue;
        }
        route_and_ack_relay_envelope(credentials, &envelope)?;
    }
    Ok(count)
}

pub(crate) fn sync_relay_key_bootstrap(credentials: &Credentials) -> Result<usize, String> {
    let mut synced = 0_usize;
    for product in active_connection_products(credentials) {
        let bootstrap_endpoint =
            match adapter_url_for_product_path(&product.id, "/v1/relay-key/bootstrap") {
                Some(url) => url,
                None => continue,
            };
        let cloud_url = format!(
            "{}/v1/connectors/products/{}/relay-key-bootstrap",
            credentials.api_base,
            urlencoding::encode(&product.id),
        );
        let payload: Value = get_json_with_install(
            &cloud_url,
            Some(&credentials.device_token),
            credentials.install_id.as_deref(),
        )?;
        let bootstrap = payload
            .get("relay_key_bootstrap")
            .cloned()
            .unwrap_or(Value::Null);
        if bootstrap
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            != "ready"
        {
            continue;
        }
        let adapter_payload =
            adapter_relay_key_bootstrap_payload(&bootstrap, &product, credentials);
        let response = Client::new()
            .post(&bootstrap_endpoint)
            .json(&adapter_payload)
            .send()
            .map_err(|error| format!("adapter_bootstrap_failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "adapter_bootstrap_failed: status={}",
                status.as_u16()
            ));
        }
        synced += 1;
    }
    Ok(synced)
}

pub(crate) fn adapter_relay_key_bootstrap_payload(
    bootstrap: &Value,
    product: &ProductGrant,
    credentials: &Credentials,
) -> Value {
    let mut payload = bootstrap.clone();
    if let Some(payload_object) = payload.as_object_mut() {
        payload_object.insert(
            "authorization_mirror".to_string(),
            adapter_authorization_mirror(product, credentials, bootstrap),
        );
    }
    payload
}

pub(crate) fn adapter_authorization_mirror(
    product: &ProductGrant,
    credentials: &Credentials,
    bootstrap: &Value,
) -> Value {
    let policy = if product.policy.is_null() {
        json!({})
    } else {
        product.policy.clone()
    };
    let product_authorization = policy
        .get("product_authorization")
        .cloned()
        .or_else(|| policy.get("productAuthorization").cloned())
        .unwrap_or(Value::Null);
    let source_origin = product
        .origin
        .clone()
        .or_else(|| credentials.cloud_origin.clone())
        .unwrap_or_default();
    let authorization_context = json!({
        "product_id": bootstrap
            .get("product_id")
            .and_then(Value::as_str)
            .unwrap_or(product.id.as_str()),
        "device_id": bootstrap
            .get("device_id")
            .and_then(Value::as_str)
            .unwrap_or(credentials.device_id.as_str()),
        "authorization_id": bootstrap
            .get("authorization_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "authorization_epoch": bootstrap
            .get("authorization_epoch")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| product.epoch.to_string()),
        "relay_key_id": bootstrap
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
    });
    json!({
        "status": product.authorization,
        "source_origin": source_origin,
        "product_id": product.id,
        "policy": policy,
        "product_authorization": product_authorization,
        "authorization_context": authorization_context,
        "authorization_epoch": product.epoch,
    })
}

pub(crate) fn connection_authorizes_product_active(
    credentials: &Credentials,
    product_id: &str,
) -> bool {
    active_connection_products(credentials)
        .iter()
        .any(|product| product.id == product_id)
}

pub(crate) fn route_and_ack_relay_envelope(
    credentials: &Credentials,
    envelope: &RelayEnvelope,
) -> Result<(), String> {
    if envelope.device_id != credentials.device_id {
        return Err(format!(
            "relay_envelope_device_mismatch: {}",
            envelope.product_id
        ));
    }
    if let Some(response_envelope) = route_relay_envelope_to_adapter(envelope)? {
        post_connector_relay_envelope(credentials, &response_envelope)?;
    }
    let ack_url = format!(
        "{}/v1/connectors/relay/envelopes/{}/ack",
        credentials.api_base,
        urlencoding::encode(&envelope.id)
    );
    let _: Value = post_json_with_install(
        &ack_url,
        &json!({ "status": "acked" }),
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(())
}

pub(crate) fn route_relay_envelope_to_adapter(
    envelope: &RelayEnvelope,
) -> Result<Option<Value>, String> {
    let endpoint = adapter_endpoint_for_product(&envelope.product_id)
        .ok_or_else(|| format!("adapter_not_found: {}", envelope.product_id))?;
    let response = Client::new()
        .post(&endpoint)
        .json(&json!({
            "id": envelope.id,
            "product_id": envelope.product_id,
            "device_id": envelope.device_id,
            "channel_id": envelope.channel_id,
            "direction": envelope.direction,
            "seq": envelope.seq,
            "request_key": envelope.request_key,
            "ciphertext": envelope.ciphertext,
            "aad": envelope.aad,
            "nonce": envelope.nonce,
            "algorithm": envelope.algorithm,
            "sender_key_id": envelope.sender_key_id,
            "recipient_key_id": envelope.recipient_key_id,
            "meta": envelope.meta,
            "delivery_status": envelope.delivery_status,
        }))
        .send()
        .map_err(|error| format!("adapter_route_failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("adapter_route_failed: status={}", status.as_u16()));
    }
    let text = response
        .text()
        .map_err(|error| format!("adapter_route_failed: {error}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let payload: AdapterRelayResponse = serde_json::from_str(&text)
        .map_err(|error| format!("adapter_route_failed: invalid response json: {error}"))?;
    Ok(payload.response_envelope)
}

pub(crate) fn post_connector_relay_envelope(
    credentials: &Credentials,
    envelope: &Value,
) -> Result<(), String> {
    let url = format!("{}/v1/connectors/relay/envelopes", credentials.api_base);
    let _: Value = post_json_with_install(
        &url,
        envelope,
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(())
}
