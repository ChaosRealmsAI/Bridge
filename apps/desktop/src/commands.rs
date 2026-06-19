use super::*;

pub(crate) fn handle_ipc(raw: String, state: AppState, proxy: EventLoopProxy<UserEvent>) {
    let message: IpcMessage = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            let _ = proxy.send_event(UserEvent::UiEvent(json!({
                "type": "event",
                "event": "log",
                "message": format!("invalid IPC: {error}")
            })));
            return;
        }
    };
    thread::spawn(move || {
        let result = run_command(&message.command, &message.params, &state, proxy.clone());
        let event = match result {
            Ok(payload) => UserEvent::Respond {
                id: message.id,
                ok: true,
                payload,
            },
            Err(error) => UserEvent::Respond {
                id: message.id,
                ok: false,
                payload: Value::String(error),
            },
        };
        let _ = proxy.send_event(event);
    });
}

pub(crate) fn run_command(
    command: &str,
    params: &Value,
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<Value, String> {
    if let Some(result) = run_profile_command(command, params) {
        let payload = result?;
        if command == "pair_selfhost_profile" {
            let _ = start_worker(state, proxy);
        }
        return Ok(payload);
    }

    match command {
        "status" => serde_json::to_value(status(state)).map_err(|error| error.to_string()),
        "preview_intent" => {
            let api = string_param(params, "api").unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = required_param(params, "intent")?;
            serde_json::to_value(preview_intent(&api, &intent)?).map_err(|error| error.to_string())
        }
        "claim_intent" => {
            let api = string_param(params, "api").unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = required_param(params, "intent")?;
            let device_name = string_param(params, "device_name").unwrap_or_else(device_name);
            let claimed = claim_intent(&api, &intent, &device_name)?;
            let _ = start_worker(state, proxy);
            serde_json::to_value(claimed).map_err(|error| error.to_string())
        }
        "claim_intent_preview" | "claim_intent_pending" => {
            let api = string_param(params, "api").unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = required_param(params, "intent")?;
            let device_name = string_param(params, "device_name").unwrap_or_else(device_name);
            let pending = claim_intent_pending(&api, &intent, &device_name)?;
            let public = store_pending_authorization(state, pending);
            push_event(state, "authorization_preview_pending", public.clone());
            let _ = proxy.send_event(UserEvent::UiEvent(json!({
                "type": "event",
                "event": "authorization_preview_pending",
                "authorization": public
            })));
            Ok(public)
        }
        "confirm_pending_intent" | "click_confirm_intent" | "click_confirm_pending_intent" => {
            let pending_id = string_param(params, "pending_id");
            let intent = string_param(params, "intent");
            let pending =
                take_pending_authorization(state, pending_id.as_deref(), intent.as_deref())?;
            let result = match confirm_pending_intent(pending.clone()) {
                Ok(value) => value,
                Err(error) => {
                    let public = store_pending_authorization(state, pending);
                    push_event(
                        state,
                        "authorization_confirm_failed",
                        json!({ "error": error.clone(), "authorization": public }),
                    );
                    return Err(error);
                }
            };
            let _ = start_worker(state, proxy);
            let payload = serde_json::to_value(result).map_err(|error| error.to_string())?;
            push_event(state, "authorization_confirmed", payload.clone());
            Ok(payload)
        }
        "toggle_authorization" => {
            let product_id = product_param(params)?;
            let account = required_param(params, "account")?;
            let payload = toggle_authorization_for_state(state, proxy, &product_id, &account)?;
            Ok(payload)
        }
        "remove_authorization" | "revoke_authorization" => {
            let product_id = product_param(params)?;
            let account_id =
                string_param(params, "account_id").or_else(|| string_param(params, "account"));
            let device_id = string_param(params, "device_id");
            revoke_authorization_for_state(
                state,
                &product_id,
                account_id.as_deref(),
                device_id.as_deref(),
            )
        }
        "start_worker" => start_worker(state, proxy),
        "stop_worker" => {
            state.worker_running.store(false, Ordering::SeqCst);
            Ok(json!({ "ok": true, "message": "worker stopped" }))
        }
        "disconnect" => {
            state.worker_running.store(false, Ordering::SeqCst);
            delete_credentials()?;
            Ok(json!({ "ok": true, "message": "disconnected" }))
        }
        "open_web" => {
            let url = open_web_url(params);
            open_url(&url)?;
            Ok(json!({ "ok": true, "message": "opened web" }))
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

pub(crate) fn run_profile_command(command: &str, params: &Value) -> Option<Result<Value, String>> {
    let result = match command {
        "settings" => {
            let api_base = load_credentials()
                .map(|credentials| credentials.api_base)
                .unwrap_or_else(|_| DEFAULT_API.to_string());
            serde_json::to_value(load_settings_with_api(&api_base))
                .map_err(|error| error.to_string())
        }
        "update_settings" => update_settings(params)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "add_cloud_profile" => add_cloud_profile(params)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "pair_selfhost_profile" => pair_selfhost_profile(params)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "select_cloud_profile" => select_cloud_profile(params)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "remove_cloud_profile" => remove_cloud_profile(params)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "refresh_cloud_profile" => refresh_cloud_profile(params)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        _ => return None,
    };
    Some(result)
}
