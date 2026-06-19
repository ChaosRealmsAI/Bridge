use super::*;

pub(crate) fn preview_intent(api: &str, intent: &str) -> Result<IntentPreview, String> {
    let api_base = clean_api(api)?;
    let profile = fetch_cloud_profile(&api_base, None)?;
    let url = format!(
        "{}/v1/connect-intents/{}",
        api_base,
        urlencoding::encode(intent)
    );
    let payload: IntentResponse = get_json(&url, None)?;
    let product_id = payload.connect_intent.product_id.clone();
    let catalog_product = profile_product(&profile, &product_id)
        .ok_or_else(|| format!("Product is not in the fixed Panda catalog: {product_id}"))?;
    let fallback_product_name = payload
        .connect_intent
        .product
        .as_ref()
        .map(|product| product.name.clone())
        .unwrap_or_else(|| catalog_product.name.clone());
    let cloud_origin = payload
        .connect_intent
        .source_origin
        .clone()
        .or_else(|| {
            payload
                .connect_intent
                .product
                .as_ref()
                .and_then(|product| product.origin.clone())
        })
        .or_else(|| catalog_product.origin.clone())
        .unwrap_or_else(|| api_base.clone());
    let product_capabilities = payload
        .connect_intent
        .product
        .as_ref()
        .map(|product| product.capabilities.clone())
        .unwrap_or_default();
    let local_policy = intent_authorization_policy(
        &payload.connect_intent,
        &product_id,
        &cloud_origin,
        &product_capabilities,
    );
    let product_name =
        authorization_display_product_name(&local_policy).unwrap_or(fallback_product_name);
    let capabilities =
        authorization_policy_capabilities(&local_policy).unwrap_or(product_capabilities);
    Ok(IntentPreview {
        product_id,
        product_name,
        cloud_origin,
        capabilities,
        local_policy,
        device_name: payload
            .connect_intent
            .device_name
            .unwrap_or_else(|| "Panda Bridge Desktop".to_string()),
        user_id: payload
            .connect_intent
            .user
            .as_ref()
            .and_then(|user| user.id.clone()),
        user_display_name: payload
            .connect_intent
            .user
            .as_ref()
            .map(display_account)
            .unwrap_or_else(|| "Panda Account".to_string()),
        expires_at: payload.connect_intent.expires_at,
        confirmation_mode: "confirm".to_string(),
    })
}

pub(crate) fn claim_intent(
    api: &str,
    intent: &str,
    device_name: &str,
) -> Result<ClaimResult, String> {
    let pending = claim_intent_pending(api, intent, device_name)?;
    confirm_pending_intent(pending)
}

pub(crate) fn claim_intent_pending(
    api: &str,
    intent: &str,
    device_name: &str,
) -> Result<PendingIntentClaim, String> {
    let api_base = clean_api(api)?;
    let existing = load_credentials().ok();
    let intent_preview = preview_intent(&api_base, intent)?;
    let install_id = credentials_install_id(existing.as_ref());
    let existing_connections = existing
        .as_ref()
        .map(credentials_connections)
        .unwrap_or_default();
    let bearer_connection = intent_preview.user_id.as_deref().and_then(|user_id| {
        existing_connections.iter().find(|connection| {
            connection.api_base == api_base
                && connection.account_id.as_deref() == Some(user_id)
                && !connection.device_token.trim().is_empty()
        })
    });
    let authorization_policy = local_authorization_policy(Some(&intent_preview));
    let body = json!({
        "device_name": if device_name.trim().is_empty() { "Panda Bridge Desktop" } else { device_name.trim() },
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state_for_products(&[intent_preview.product_id.clone()]),
        "install_id": install_id.clone(),
        "policy": authorization_policy
    });
    let url = format!(
        "{}/v1/connect-intents/{}/claim",
        api_base,
        urlencoding::encode(intent)
    );
    let bearer = bearer_connection.map(|credentials| credentials.device_token.as_str());
    let payload: ClaimResponse = post_json_with_install(&url, &body, bearer, Some(&install_id))?;
    if let Some(claimed_product_id) = payload.product.as_ref().map(|product| product.id.as_str()) {
        if claimed_product_id != intent_preview.product_id {
            return Err(format!(
                "Bridge Cloud claim product mismatch: expected {}, got {}",
                intent_preview.product_id, claimed_product_id
            ));
        }
    }
    Ok(PendingIntentClaim {
        api_base,
        intent: intent.to_string(),
        device_token: payload.device_token,
        token_expires_at: payload.token_expires_at,
        install_id,
        install_identity_bound: payload.install_identity_bound,
        device: payload.device,
        account: payload.account,
        product: payload.product,
        authorization: payload.authorization,
        devices: payload.devices,
        preview: intent_preview,
    })
}

pub(crate) fn confirm_pending_intent(pending: PendingIntentClaim) -> Result<ClaimResult, String> {
    let PendingIntentClaim {
        api_base,
        intent,
        device_token,
        token_expires_at,
        install_id,
        install_identity_bound,
        device,
        account,
        product,
        authorization: _,
        devices,
        preview: intent_preview,
    } = pending;
    let confirmed = confirm_claimed_intent(&api_base, &intent, &device_token, &install_id)?;
    if confirmed.device.id != device.id {
        return Err(format!(
            "Bridge Cloud confirm device mismatch: expected {}, got {}",
            device.id, confirmed.device.id
        ));
    }
    if let Some(confirmed_product_id) = confirmed
        .product
        .as_ref()
        .map(|product| product.id.as_str())
    {
        if confirmed_product_id != intent_preview.product_id {
            return Err(format!(
                "Bridge Cloud confirm product mismatch: expected {}, got {}",
                intent_preview.product_id, confirmed_product_id
            ));
        }
    }
    let existing = load_credentials().ok();
    let existing_connections = existing
        .as_ref()
        .map(credentials_connections)
        .unwrap_or_default();
    let bearer_connection = intent_preview.user_id.as_deref().and_then(|user_id| {
        existing_connections.iter().find(|connection| {
            connection.api_base == api_base
                && connection.account_id.as_deref() == Some(user_id)
                && !connection.device_token.trim().is_empty()
        })
    });
    let authorization_state = confirmed
        .authorization
        .as_ref()
        .and_then(|authorization| authorization.status)
        .ok_or_else(|| "Bridge Cloud confirm response missing authorization status".to_string())?;
    if !authorization_state.is_active() {
        return Err(format!(
            "Bridge Cloud confirm did not activate product authorization: {:?}",
            authorization_state
        ));
    }
    let cloud_devices = confirmed.devices.clone().or_else(|| devices.clone());
    let account_display = confirmed
        .account
        .as_ref()
        .map(display_account)
        .or_else(|| account.as_ref().map(display_account))
        .or_else(|| bearer_connection.and_then(|item| item.account_display.clone()));
    let account_id = confirmed
        .account
        .as_ref()
        .and_then(|account| account.id.clone())
        .or_else(|| account.as_ref().and_then(|account| account.id.clone()))
        .or_else(|| bearer_connection.and_then(|item| item.account_id.clone()))
        .or_else(|| intent_preview.user_id.clone());
    let product_id = confirmed
        .product
        .as_ref()
        .map(|product| product.id.clone())
        .or_else(|| product.as_ref().map(|product| product.id.clone()))
        .or_else(|| Some(intent_preview.product_id.clone()));
    let product_name = confirmed
        .product
        .as_ref()
        .map(|product| product.name.clone())
        .or_else(|| product.as_ref().map(|product| product.name.clone()))
        .or_else(|| Some(intent_preview.product_name.clone()));
    let cloud_origin = confirmed
        .authorization
        .as_ref()
        .and_then(|authorization| authorization.source_origin.clone())
        .or_else(|| {
            confirmed.authorization.as_ref().and_then(|authorization| {
                authorization
                    .policy
                    .get("source_origin")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
        })
        .or_else(|| {
            confirmed
                .product
                .as_ref()
                .and_then(|product| product.origin.clone())
        })
        .or_else(|| product.as_ref().and_then(|product| product.origin.clone()))
        .or_else(|| Some(intent_preview.cloud_origin.clone()));
    let product_capabilities = confirmed
        .product
        .as_ref()
        .map(|product| product.capabilities.clone())
        .or_else(|| product.as_ref().map(|product| product.capabilities.clone()))
        .unwrap_or_else(|| intent_preview.capabilities.clone());
    let authorization_policy = confirmed
        .authorization
        .as_ref()
        .map(|authorization| authorization.policy.clone())
        .unwrap_or(Value::Null);
    let authorization_epoch = confirmed
        .authorization
        .as_ref()
        .map(|authorization| authorization.epoch)
        .unwrap_or(1);
    let grant_capabilities =
        authorization_policy_capabilities(&authorization_policy).unwrap_or(product_capabilities);
    let existing_connection = existing_connections.iter().find(|connection| {
        connection.device_id == device.id
            || (connection.api_base == api_base
                && account_id
                    .as_deref()
                    .map(|id| connection.account_id.as_deref() == Some(id))
                    .unwrap_or(false))
    });
    let authorized_products = merge_authorized_products(
        existing_connection,
        product_id.clone(),
        product_name.clone(),
        cloud_origin.clone(),
        grant_capabilities,
        authorization_policy,
        authorization_epoch,
        authorization_state,
    );
    let connection = Credentials {
        api_base: api_base.clone(),
        device_id: confirmed.device.id.clone(),
        device_name: confirmed.device.device_name.clone(),
        device_token,
        install_id: Some(install_id.clone()),
        account_id: account_id.clone(),
        account_display: account_display.clone(),
        product_id: product_id.clone(),
        product_name: product_name.clone(),
        cloud_origin: cloud_origin.clone(),
        authorized_products: authorized_products.clone(),
        device_token_expires_at: token_expires_at,
        device_token_rotated_at_unix: Some(unix_seconds()),
        install_identity_bound: confirmed.install_identity_bound.or(install_identity_bound),
        device_online: cloud_device_online(&cloud_devices, &confirmed.device.id),
        device_last_seen_at: cloud_device_last_seen_at(&cloud_devices, &confirmed.device.id),
        connections: Vec::new(),
        claimed_at: now_string(),
    };
    let mut connections = existing_connections;
    upsert_connection(&mut connections, connection.clone());
    apply_cloud_devices_to_connections(
        &mut connections,
        &api_base,
        account_id.as_deref(),
        cloud_devices.as_deref(),
    );
    let credentials =
        credentials_from_connections(connections, Some(&connection), existing.as_ref());
    register_cloud_profile_from_claim(&api_base, product_id.as_deref())?;
    save_credentials(&credentials)?;
    write_connector_state(&credentials)?;
    Ok(ClaimResult {
        device_id: confirmed.device.id,
        device_name: confirmed.device.device_name,
        account_id,
        account_display,
        product_id,
        product_name,
        cloud_origin,
        authorized_products: public_product_grants(&authorized_products),
    })
}

pub(crate) fn confirm_claimed_intent(
    api_base: &str,
    intent: &str,
    device_token: &str,
    install_id: &str,
) -> Result<ConfirmResponse, String> {
    let url = format!(
        "{}/v1/connect-intents/{}/confirm",
        api_base,
        urlencoding::encode(intent)
    );
    post_json_with_install(
        &url,
        &json!({ "confirmed": true }),
        Some(device_token),
        Some(install_id),
    )
}

pub(crate) fn toggle_authorization(product_id: &str, account: &str) -> Result<Value, String> {
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    let mut connections = credentials_connections(&credentials);
    let mut next_state: Option<AuthorizationState> = None;
    let mut changed = 0_usize;
    for connection in connections
        .iter_mut()
        .filter(|connection| connection_matches_account(connection, Some(account)))
    {
        let current_products = connection_products(connection);
        if current_products
            .iter()
            .filter(|grant| product_matches_target(grant, product_id))
            .all(|grant| !grant.authorization.is_active())
        {
            next_state.get_or_insert(AuthorizationState::Active);
        } else if current_products
            .iter()
            .any(|grant| product_matches_target(grant, product_id))
        {
            next_state.get_or_insert(AuthorizationState::Paused);
        }
        let Some(target_state) = next_state else {
            continue;
        };
        if connection.authorized_products.is_empty() {
            connection.authorized_products = current_products;
        }
        for grant in connection
            .authorized_products
            .iter_mut()
            .filter(|grant| product_matches_target(grant, product_id))
        {
            if grant.authorization != target_state {
                grant.authorization = target_state;
                changed += 1;
            }
        }
    }
    if changed == 0 {
        return Err("authorization_not_found".to_string());
    }
    let next = credentials_from_connections(connections, None, Some(&credentials));
    save_credentials(&next)?;
    write_connector_state(&next)?;
    Ok(json!({
        "ok": true,
        "product_id": product_id,
        "account": account,
        "authorized": next_state.unwrap_or(AuthorizationState::Active),
        "authorized_products": next.authorized_products
    }))
}

pub(crate) fn apply_authorization_epoch_bump(
    product_id: &str,
    status: Option<AuthorizationState>,
    epoch: u64,
) -> Result<bool, String> {
    if epoch == 0 {
        return Ok(false);
    }
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    let mut connections = credentials_connections(&credentials);
    let mut changed = false;
    for connection in &mut connections {
        if connection.authorized_products.is_empty() {
            connection.authorized_products = connection_products(connection);
        }
        for grant in connection
            .authorized_products
            .iter_mut()
            .filter(|grant| product_matches_target(grant, product_id))
        {
            if epoch > grant.epoch {
                grant.epoch = epoch;
                changed = true;
            }
            if let Some(status) = status {
                if grant.authorization != status {
                    grant.authorization = status;
                    changed = true;
                }
            }
        }
    }
    if changed {
        let next = credentials_from_connections(connections, None, Some(&credentials));
        save_credentials(&next)?;
        write_connector_state(&next)?;
    }
    Ok(changed)
}

pub(crate) fn toggle_authorization_for_state(
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
    product_id: &str,
    account: &str,
) -> Result<Value, String> {
    let payload = toggle_authorization(product_id, account)?;
    if !has_selected_profile_authorized_connections(&load_credentials()?) {
        state.worker_running.store(false, Ordering::SeqCst);
        state.realtime_connected.store(false, Ordering::SeqCst);
        if let Ok(mut keys) = state.realtime_connected_keys.lock() {
            keys.clear();
        }
    } else {
        let _ = start_worker(state, proxy);
    }
    Ok(payload)
}

pub(crate) fn revoke_authorization(
    product_id: &str,
    account_id: Option<&str>,
    device_id: Option<&str>,
) -> Result<Value, String> {
    let product_id = product_id.trim();
    if product_id.is_empty() {
        return Err("missing product_id".to_string());
    }
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    let mut connections = credentials_connections(&credentials);
    let matching: Vec<(usize, Vec<String>)> = connections
        .iter()
        .enumerate()
        .filter_map(|(index, connection)| {
            if !connection_matches_account(connection, account_id)
                || !device_id
                    .map(|id| connection.device_id == id)
                    .unwrap_or(true)
            {
                return None;
            }
            let product_ids = connection_products(connection)
                .into_iter()
                .filter(|item| product_matches_target(item, product_id))
                .map(|item| item.id)
                .collect::<Vec<_>>();
            if product_ids.is_empty() {
                None
            } else {
                Some((index, product_ids))
            }
        })
        .collect();
    if matching.is_empty() {
        return Err("authorization_not_found".to_string());
    }
    if account_id.is_none() && device_id.is_none() && matching.len() > 1 {
        return Err("ambiguous_authorization_target".to_string());
    }

    let mut remote_results = Vec::new();
    for (index, product_ids) in matching {
        let connection = connections[index].clone();
        let mut connection_remote_results = Vec::new();
        for actual_product_id in &product_ids {
            let url = format!(
                "{}/v1/connectors/products/{}/authorization",
                connection.api_base,
                urlencoding::encode(actual_product_id)
            );
            let remote_revoke: Result<Value, String> =
                if env_flag("PANDA_BRIDGE_SKIP_REMOTE_REVOKE") {
                    Ok(json!({ "ok": true, "skipped": true }))
                } else {
                    delete_json_with_install(
                        &url,
                        Some(&connection.device_token),
                        connection.install_id.as_deref(),
                    )
                };
            let (remote_revoke_ok, payload, remote_revoke_error) = match remote_revoke {
                Ok(payload) => (true, payload, Value::Null),
                Err(error) => (false, Value::Null, Value::String(redact_error_text(&error))),
            };
            connection_remote_results.push(json!({
                "remote_revoke_ok": remote_revoke_ok,
                "product_id": actual_product_id,
                "authorization": payload.get("authorization").cloned().unwrap_or(Value::Null),
                "cancelled_jobs": payload.get("cancelled_jobs").cloned().unwrap_or(Value::Null),
                "remote_revoke_error": remote_revoke_error
            }));
        }
        connections[index].authorized_products = connection_products(&connection)
            .into_iter()
            .filter(|item| !product_matches_target(item, product_id))
            .collect();
        if connections[index]
            .product_id
            .as_deref()
            .map(|id| product_ids.iter().any(|product_id| product_id == id))
            .unwrap_or(false)
        {
            connections[index].product_id = None;
            connections[index].product_name = None;
            connections[index].cloud_origin = None;
        }
        remote_results.push(json!({
            "remote_revoke_ok": connection_remote_results.iter().all(|item| item.get("remote_revoke_ok").and_then(Value::as_bool) == Some(true)),
            "account_id": connection.account_id,
            "account_display": connection.account_display,
            "device_id": connection.device_id,
            "product_ids": product_ids,
            "cancelled_jobs": connection_remote_results.iter().filter_map(|item| item.get("cancelled_jobs").and_then(Value::as_i64)).sum::<i64>(),
            "remote_revoke_error": connection_remote_results.iter().find_map(|item| {
                if item.get("remote_revoke_ok").and_then(Value::as_bool) == Some(false) {
                    item.get("remote_revoke_error").cloned()
                } else {
                    None
                }
            }).unwrap_or(Value::Null),
            "products": connection_remote_results
        }));
    }
    let next = credentials_from_connections(connections, None, Some(&credentials));
    save_credentials(&next)?;
    write_connector_state(&next)?;
    let total_cancelled = remote_results
        .iter()
        .filter_map(|item| item.get("cancelled_jobs").and_then(Value::as_i64))
        .sum::<i64>();
    let remote_revoke_ok = remote_results
        .iter()
        .all(|item| item.get("remote_revoke_ok").and_then(Value::as_bool) == Some(true));
    let first = remote_results.first().cloned().unwrap_or(Value::Null);
    Ok(json!({
        "ok": true,
        "remote_revoke_ok": remote_revoke_ok,
        "product_id": product_id,
        "account_id": account_id,
        "device_id": device_id,
        "authorization": first.get("authorization").cloned().unwrap_or(Value::Null),
        "cancelled_jobs": total_cancelled,
        "remote_revoke_error": if remote_revoke_ok { Value::Null } else { first.get("remote_revoke_error").cloned().unwrap_or(Value::Null) },
        "revoked": remote_results,
        "authorized_products": next.authorized_products
    }))
}

pub(crate) fn revoke_authorization_for_state(
    state: &AppState,
    product_id: &str,
    account_id: Option<&str>,
    device_id: Option<&str>,
) -> Result<Value, String> {
    let payload = revoke_authorization(product_id, account_id, device_id)?;
    if load_credentials()
        .map(|credentials| !has_selected_profile_authorized_connections(&credentials))
        .unwrap_or(true)
    {
        state.worker_running.store(false, Ordering::SeqCst);
        state.realtime_connected.store(false, Ordering::SeqCst);
        if let Ok(mut keys) = state.realtime_connected_keys.lock() {
            keys.clear();
        }
    }
    Ok(payload)
}

pub(crate) fn redact_error_text(error: &str) -> String {
    let mut text = error.replace('\n', " ").replace('\r', " ");
    if let Some(index) = text.find("Bearer ") {
        text.truncate(index + "Bearer ".len());
        text.push_str("[redacted]");
    }
    if text.len() > 300 {
        text.truncate(300);
    }
    text
}
