use super::*;

pub(crate) fn run_headless_if_requested() -> Option<i32> {
    let mut args = env::args().skip(1);
    let command = args.next()?;
    if !command.starts_with("headless-") {
        return None;
    }
    let result = match command.as_str() {
        "headless-status" => {
            serde_json::to_value(status(&new_app_state())).map_err(|error| error.to_string())
        }
        "headless-preview-intent" => {
            let map = arg_map(args.collect());
            let api = map
                .get("api")
                .cloned()
                .unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = match map.get("intent") {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --intent")),
            };
            preview_intent(&api, &intent)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        "headless-connect" => {
            if !env_flag("BRIDGE_ALLOW_HEADLESS_CONNECT") {
                return Some(print_error(
                    "headless-connect requires BRIDGE_ALLOW_HEADLESS_CONNECT=1",
                ));
            }
            let map = arg_map(args.collect());
            let api = map
                .get("api")
                .cloned()
                .unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = match map.get("intent") {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --intent")),
            };
            let device_name = map.get("device-name").cloned().unwrap_or_else(device_name);
            claim_intent(&api, &intent, &device_name)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        "headless-add-cloud-profile" => {
            let map = arg_map(args.collect());
            let api = match map.get("api").or_else(|| map.get("api-base")) {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --api")),
            };
            let mut params = json!({ "api": api });
            if let Some(name) = map.get("name") {
                params["name"] = json!(name);
            }
            run_profile_command("add_cloud_profile", &params)
                .unwrap_or_else(|| Err("profile command unavailable".to_string()))
        }
        "headless-pair-selfhost-profile" => {
            let map = arg_map(args.collect());
            let api = match map.get("api").or_else(|| map.get("api-base")) {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --api")),
            };
            let token = match map.get("token").or_else(|| map.get("pairing-token")) {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --token")),
            };
            let mut params = json!({ "api": api, "token": token });
            if let Some(name) = map.get("name") {
                params["name"] = json!(name);
            }
            if let Some(device_name) = map.get("device-name") {
                params["device_name"] = json!(device_name);
            }
            run_profile_command("pair_selfhost_profile", &params)
                .unwrap_or_else(|| Err("profile command unavailable".to_string()))
        }
        "headless-select-cloud-profile" => {
            let map = arg_map(args.collect());
            let mut params = Map::new();
            if let Some(value) = map.get("profile-id").or_else(|| map.get("id")) {
                params.insert("profile_id".to_string(), json!(value));
            }
            if let Some(value) = map.get("api").or_else(|| map.get("api-base")) {
                params.insert("api".to_string(), json!(value));
            }
            run_profile_command("select_cloud_profile", &Value::Object(params))
                .unwrap_or_else(|| Err("profile command unavailable".to_string()))
        }
        "headless-refresh-cloud-profile" => {
            let map = arg_map(args.collect());
            let mut params = Map::new();
            if let Some(value) = map.get("profile-id").or_else(|| map.get("id")) {
                params.insert("profile_id".to_string(), json!(value));
            }
            if let Some(value) = map.get("api").or_else(|| map.get("api-base")) {
                params.insert("api".to_string(), json!(value));
            }
            run_profile_command("refresh_cloud_profile", &Value::Object(params))
                .unwrap_or_else(|| Err("profile command unavailable".to_string()))
        }
        "headless-remove-cloud-profile" => {
            let map = arg_map(args.collect());
            let profile_id = match map.get("profile-id").or_else(|| map.get("id")) {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --profile-id")),
            };
            run_profile_command("remove_cloud_profile", &json!({ "profile_id": profile_id }))
                .unwrap_or_else(|| Err("profile command unavailable".to_string()))
        }
        "headless-open-web-url" => {
            let map = arg_map(args.collect());
            let mut params = Map::new();
            if let Some(value) = map.get("product-id").or_else(|| map.get("product")) {
                params.insert("product_id".to_string(), json!(value));
            }
            Ok(json!({ "url": open_web_url(&Value::Object(params)) }))
        }
        "headless-revoke-authorization" => {
            let map = arg_map(args.collect());
            let product_id = match map.get("product-id") {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --product-id")),
            };
            revoke_authorization(
                &product_id,
                map.get("account-id").map(String::as_str),
                map.get("device-id").map(String::as_str),
            )
        }
        "headless-toggle-authorization" => {
            let map = arg_map(args.collect());
            let product_id = match map.get("product-id") {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --product-id")),
            };
            let account = match map.get("account") {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --account")),
            };
            toggle_authorization(&product_id, &account)
        }
        "headless-remove-authorization" => {
            let map = arg_map(args.collect());
            let product_id = match map.get("product-id") {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --product-id")),
            };
            revoke_authorization(
                &product_id,
                map.get("account").map(String::as_str),
                map.get("device-id").map(String::as_str),
            )
        }
        "headless-poll" => {
            load_credentials().and_then(|credentials| poll_all_connections(&credentials))
        }
        _ => Err(format!("unknown command: {command}")),
    };
    match result {
        Ok(payload) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
            );
            Some(0)
        }
        Err(error) => Some(print_error(&error)),
    }
}

pub(crate) fn print_error(error: &str) -> i32 {
    eprintln!("{error}");
    1
}

pub(crate) fn arg_map(args: Vec<String>) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut iter = args.into_iter();
    while let Some(item) = iter.next() {
        if let Some(key) = item.strip_prefix("--") {
            if let Some(value) = iter.next() {
                out.insert(key.to_string(), value);
            }
        }
    }
    out
}
