use super::*;

pub(crate) fn capabilities() -> Value {
    json!({
        "relay": ["relay.envelope", "relay.ack"],
        "adapter_router": { "mode": "external_http", "managed_processes": true },
        "desktop": "tao-wry",
        "platform": env::consts::OS
    })
}

// Test-only convenience wrapper; production builds the local state per product
// via local_state_for_products(&product_ids) directly.
#[cfg(test)]
pub(crate) fn local_state() -> Value {
    local_state_for_products(&configured_adapter_product_ids())
}

pub(crate) fn local_state_for_products(product_ids: &[String]) -> Value {
    let products = adapter_state_for_products(product_ids);
    let adapter_configured = adapter_endpoint_for_product("").is_some()
        || products.values().any(|product| {
            product
                .get("configured")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    let mut state = json!({
        "platform": env::consts::OS,
        "device_info": local_device_info_value(),
        "relay": { "envelopes": true, "ack": true },
        "adapter_router": {
            "mode": "external_http",
            "managed_processes": true,
            "configured": adapter_configured
        }
    });
    if !products.is_empty() {
        state["adapter_router"]["products"] = Value::Object(products.clone());
    }
    if products.len() == 1 {
        if let Some(exchange) = products
            .values()
            .next()
            .and_then(|product| product.get("relay_key_exchange").cloned())
        {
            state["relay_key_exchange"] = exchange;
        }
    }
    state
}

pub(crate) fn adapter_state_for_products(product_ids: &[String]) -> Map<String, Value> {
    let mut products = Map::new();
    for product_id in product_ids
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        if products.contains_key(product_id) {
            continue;
        }
        let external = external_adapter_endpoint_for_product(product_id).is_some();
        let configured = adapter_endpoint_for_product(product_id).is_some();
        let mut product = json!({
            "configured": configured,
            "endpoint_source": if external {
                "external_env"
            } else if managed_adapter_info(product_id).is_some() {
                "managed_process"
            } else {
                "missing"
            }
        });
        if let Some(info) = managed_adapter_info(product_id) {
            product["managed"] = info;
        }
        if let Some(exchange) = adapter_relay_key_exchange_for_product(product_id) {
            product["relay_key_exchange"] = exchange;
        }
        products.insert(product_id.to_string(), product);
    }
    products
}

pub(crate) fn managed_adapter_info(product_id: &str) -> Option<Value> {
    let processes = managed_adapters().lock().ok()?;
    let process = processes.get(product_id)?;
    Some(json!({
        "running": true,
        "product_id": process.product_id.clone(),
        "manifest_path": process.manifest_path.display().to_string(),
        "product_name": process.product_name.clone(),
        "uptime_ms": process.started_at.elapsed().as_millis(),
    }))
}

#[cfg(test)]
pub(crate) fn configured_adapter_product_ids() -> Vec<String> {
    env::vars()
        .filter_map(|(key, value)| {
            if value.trim().is_empty()
                || !key.starts_with("PANDA_BRIDGE_ADAPTER_")
                || !key.ends_with("_URL")
                || key == "PANDA_BRIDGE_ADAPTER_URL"
            {
                return None;
            }
            let product = key
                .trim_start_matches("PANDA_BRIDGE_ADAPTER_")
                .trim_end_matches("_URL")
                .to_ascii_lowercase()
                .replace('_', "-");
            if product.is_empty() {
                None
            } else {
                Some(product)
            }
        })
        .collect()
}

pub(crate) fn low_tier_capabilities() -> Vec<String> {
    vec!["relay.envelope".to_string(), "relay.ack".to_string()]
}

pub(crate) fn local_policy_preview() -> Value {
    let capabilities = low_tier_capabilities();
    json!({
        "version": "BRIDGE-RELAY-AUTH-v1",
        "request_source": "desktop_default_relay",
        "capabilities": capabilities
    })
}

pub(crate) fn local_authorization_policy(preview: Option<&IntentPreview>) -> Value {
    preview
        .map(|item| item.local_policy.clone())
        .unwrap_or_else(local_policy_preview)
}

pub(crate) fn intent_authorization_policy(
    intent: &ConnectIntent,
    product_id: &str,
    source_origin: &str,
    product_capabilities: &[String],
) -> Value {
    let mut policy = if intent
        .policy
        .as_object()
        .map(|map| !map.is_empty())
        .unwrap_or(false)
    {
        intent.policy.clone()
    } else {
        local_policy_preview()
    };
    if let Some(map) = policy.as_object_mut() {
        map.entry("version".to_string())
            .or_insert_with(|| json!("BRIDGE-RELAY-AUTH-v1"));
        map.entry("request_source".to_string())
            .or_insert_with(|| json!("desktop_default_relay"));
        map.insert("product_id".to_string(), json!(product_id));
        map.insert("source_origin".to_string(), json!(source_origin));
        if !map.contains_key("capabilities") {
            let defaults = if product_capabilities.is_empty() {
                low_tier_capabilities()
            } else {
                low_tier_capabilities()
                    .into_iter()
                    .filter(|capability| product_capabilities.iter().any(|item| item == capability))
                    .collect::<Vec<_>>()
            };
            map.insert("capabilities".to_string(), json!(defaults));
        }
    }
    policy
}

pub(crate) fn authorization_policy_capabilities(policy: &Value) -> Option<Vec<String>> {
    policy
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
}
