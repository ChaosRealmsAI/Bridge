use super::*;

pub(crate) fn verify_control_enabled() -> bool {
    env_flag("PANDA_BRIDGE_VERIFY")
}

pub(crate) fn start_verify_control(
    state: AppState,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let addr = listener.local_addr().map_err(|error| error.to_string())?;
    let token = Arc::new(format!("pbv_{}_{}", std::process::id(), next_event_seq()));
    let control = json!({
        "ok": true,
        "base_url": format!("http://{}", addr),
        "token": token.as_str(),
        "pid": std::process::id(),
        "created_at": now_string()
    });
    write_file(
        &verify_control_state_path()?,
        &serde_json::to_string_pretty(&control).map_err(|error| error.to_string())?,
    )?;
    push_event(
        &state,
        "verify_control_started",
        json!({ "base_url": format!("http://{}", addr) }),
    );

    thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(stream) => {
                    let next_state = state.clone();
                    let next_proxy = proxy.clone();
                    let next_token = token.clone();
                    thread::spawn(move || {
                        if let Err(error) =
                            handle_verify_stream(stream, next_state, next_proxy, next_token)
                        {
                            eprintln!("[verify-control] {error}");
                        }
                    });
                }
                Err(error) => eprintln!("[verify-control] accept failed: {error}"),
            }
        }
    });
    Ok(())
}

pub(crate) fn handle_verify_stream(
    mut stream: TcpStream,
    state: AppState,
    proxy: EventLoopProxy<UserEvent>,
    token: Arc<String>,
) -> Result<(), String> {
    let mut buffer = vec![0_u8; 128 * 1024];
    let size = stream
        .read(&mut buffer)
        .map_err(|error| error.to_string())?;
    let raw = String::from_utf8_lossy(&buffer[..size]).to_string();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
    let mut lines = head.lines();
    let first = lines.next().unwrap_or("");
    let mut first_parts = first.split_whitespace();
    let method = first_parts.next().unwrap_or("");
    let path = first_parts.next().unwrap_or("/");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let provided = headers
        .iter()
        .find(|(key, _)| key == "x-panda-bridge-verify-token")
        .map(|(_, value)| value.as_str())
        .unwrap_or("");
    if provided != token.as_str() {
        return write_http_json(&mut stream, 401, json!({ "error": "unauthorized" }));
    }

    let path_only = path.split('?').next().unwrap_or(path);
    let (status_code, payload) = match (method, path_only) {
        ("GET", "/v1/status") => {
            let payload =
                serde_json::to_value(status(&state)).map_err(|error| error.to_string())?;
            (200, payload)
        }
        ("GET", "/v1/events") => (200, json!({ "items": state_events(&state) })),
        ("GET", "/v1/snapshot") => (200, verify_snapshot(&state)),
        ("GET", "/v1/screenshot") => (200, desktop_screenshot(&state)?),
        ("POST", "/v1/actions") => {
            let body_value: Value =
                serde_json::from_str(body).map_err(|error| error.to_string())?;
            match run_verify_action(&state, proxy, &body_value) {
                Ok(payload) => (200, payload),
                Err(error) => (
                    400,
                    json!({ "error": "verify_action_failed", "message": error }),
                ),
            }
        }
        _ => (
            404,
            json!({ "error": "not_found", "method": method, "path": path_only }),
        ),
    };
    write_http_json(&mut stream, status_code, payload)
}

pub(crate) fn run_verify_action(
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
    params: &Value,
) -> Result<Value, String> {
    let action = required_param(params, "action")?;
    let result = match action.as_str() {
        "open_deep_link" => {
            let url = required_param(params, "url")?;
            let _ = proxy.send_event(UserEvent::UiEvent(json!({
                "type": "event",
                "event": "deep_link",
                "url": url
            })));
            json!({ "ok": true, "message": "opened deep link" })
        }
        "activate_app" => {
            activate_desktop_app()?;
            json!({ "ok": true, "message": "activated app" })
        }
        other => {
            let command = verify_action_command(other);
            run_command(command, params, state, proxy.clone()).map_err(|error| {
                if error == format!("unknown command: {command}") {
                    format!("unknown verify action: {other}")
                } else {
                    error
                }
            })?
        }
    };
    push_event(state, "verify_action", json!({ "action": action }));
    let _ = proxy.send_event(UserEvent::UiEvent(
        json!({ "type": "event", "event": "refresh" }),
    ));
    Ok(result)
}

pub(crate) fn verify_action_command(action: &str) -> &str {
    match action {
        "click_allow_intent" => "claim_intent",
        "click_confirm_intent" | "click_confirm_pending_intent" => "confirm_pending_intent",
        "click_toggle_authorization" => "toggle_authorization",
        "click_revoke_authorization" => "revoke_authorization",
        "refresh_status" | "click_refresh_status" => "status",
        other => other,
    }
}

pub(crate) fn verify_snapshot(state: &AppState) -> Value {
    json!({
        "ok": true,
        "status": status(state),
        "pending_authorizations": state_pending_authorizations(state),
        "events": state_events(state)
    })
}

pub(crate) fn pending_claim_public_value(pending: &PendingIntentClaim) -> Value {
    let policy = pending
        .authorization
        .as_ref()
        .map(|authorization| authorization.policy.clone())
        .filter(|policy| !policy.is_null())
        .unwrap_or_else(|| pending.preview.local_policy.clone());
    let source_origin = pending
        .authorization
        .as_ref()
        .and_then(|authorization| authorization.source_origin.clone())
        .or_else(|| {
            policy
                .get("source_origin")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            pending
                .product
                .as_ref()
                .and_then(|product| product.origin.clone())
        })
        .unwrap_or_else(|| pending.preview.cloud_origin.clone());
    let policy_capabilities = authorization_policy_capabilities(&policy)
        .unwrap_or_else(|| pending.preview.capabilities.clone());
    let product_authorization = policy
        .get("product_authorization")
        .cloned()
        .unwrap_or(Value::Null);
    let product_display_name = authorization_display_product_name(&policy)
        .or_else(|| pending.product.as_ref().map(|product| product.name.clone()))
        .unwrap_or_else(|| pending.preview.product_name.clone());
    let product_value = pending
        .product
        .as_ref()
        .map(|product| {
            json!({
                "id": product.id,
                "name": product_display_name,
                "origin": product.origin,
                "official_origin": product.official_origin,
                "official_origins": product.official_origins,
                "web_url": product.web_url,
                "capabilities": product.capabilities
            })
        })
        .unwrap_or_else(|| {
            json!({
                "id": pending.preview.product_id,
                "name": product_display_name,
                "origin": pending.preview.cloud_origin,
                "official_origin": Value::Null,
                "official_origins": Value::Null,
                "web_url": Value::Null,
                "capabilities": pending.preview.capabilities
            })
        });
    let authorization_status = pending
        .authorization
        .as_ref()
        .and_then(|authorization| authorization.status)
        .unwrap_or(AuthorizationState::Pending);
    json!({
        "pending_id": pending_claim_id(pending),
        "status": "pending",
        "api_base": pending.api_base,
        "intent_preview": {
            "redacted": true,
            "sha256": sha256_short(&pending.intent)
        },
        "device": {
            "id": pending.device.id,
            "name": pending.device.device_name
        },
        "account": pending.account.as_ref().map(|account| json!({
            "id": account.id,
            "display_name": account.display_name,
            "email": account.email
        })),
        "product": product_value,
        "authorization": {
            "status": authorization_status,
            "source_origin": source_origin,
            "policy": policy
        },
        "policy_capabilities": policy_capabilities,
        "product_authorization": product_authorization,
        "confirmation_mode": pending.preview.confirmation_mode,
        "expires_at": pending.preview.expires_at,
        "token": {
            "redacted": true,
            "expires_at": pending.token_expires_at
        },
        "install_identity_bound": pending.install_identity_bound
    })
}

pub(crate) fn authorization_display_product_name(policy: &Value) -> Option<String> {
    policy
        .pointer("/display/product")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn sha256_short(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::new();
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub(crate) fn desktop_screenshot(state: &AppState) -> Result<Value, String> {
    let dir = state_dir()?.join("verify-screenshots");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("desktop-{}-builtin.png", next_event_seq()));
    let snapshot = verify_snapshot(state);
    write_builtin_screenshot(&path, &snapshot)?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "method": "builtin_app_png",
        "source": "desktop_builtin_renderer",
        "snapshot": snapshot
    }))
}

pub(crate) const BUILTIN_SCREENSHOT_WIDTH: usize = 1200;
pub(crate) const BUILTIN_SCREENSHOT_HEIGHT: usize = 760;

pub(crate) fn write_builtin_screenshot(path: &Path, snapshot: &Value) -> Result<(), String> {
    let mut canvas = Canvas::new(
        BUILTIN_SCREENSHOT_WIDTH,
        BUILTIN_SCREENSHOT_HEIGHT,
        [246, 248, 252],
    );
    canvas.fill_rect(0, 0, BUILTIN_SCREENSHOT_WIDTH, 86, [18, 24, 38]);
    canvas.fill_rect(0, 86, BUILTIN_SCREENSHOT_WIDTH, 4, [54, 211, 153]);
    canvas.draw_text(34, 28, "PANDA BRIDGE DESKTOP", [255, 255, 255], 4);
    canvas.draw_text(
        34,
        104,
        "SCREENSHOT GENERATED BY DESKTOP BUILT-IN RENDERER",
        [24, 32, 48],
        3,
    );

    let status = snapshot.get("status").unwrap_or(&Value::Null);
    let product_count = status
        .get("authorized_products")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let device_name = status
        .get("device_name")
        .and_then(Value::as_str)
        .unwrap_or("unbound");
    let device_id = status
        .get("device_id")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let worker = status
        .get("worker_running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let realtime = status
        .get("realtime_connected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rows = vec![
        format!("CAPTURED: {}", now_string()),
        "METHOD: BUILTIN_APP_PNG".to_string(),
        format!("DEVICE: {}", device_name),
        format!("DEVICE ID: {}", device_id),
        format!("WORKER: {}  REALTIME: {}", worker, realtime),
        format!("AUTHORIZED PRODUCTS: {}", product_count),
    ];
    let mut y = 154;
    for row in rows {
        canvas.draw_text(42, y, &truncate_ascii(&row, 88), [38, 50, 70], 2);
        y += 30;
    }

    let pending_items = snapshot
        .get("pending_authorizations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let local_section_y = if let Some(pending) = pending_items.first() {
        canvas.fill_rect(34, 308, 1132, 2, [203, 213, 225]);
        canvas.draw_text(42, 338, "PENDING AUTHORIZATION PREVIEW", [24, 32, 48], 3);
        y = 390;
        for row in pending_authorization_screenshot_rows(pending) {
            canvas.draw_text(54, y, &truncate_ascii(&row, 92), [51, 65, 85], 2);
            y += 26;
        }
        558
    } else {
        344
    };

    canvas.fill_rect(34, local_section_y, 1132, 2, [203, 213, 225]);
    canvas.draw_text(
        42,
        local_section_y + 30,
        "LOCAL AUTHORIZATION RECORDS",
        [24, 32, 48],
        3,
    );
    y = local_section_y + 82;
    if let Some(products) = status.get("authorized_products").and_then(Value::as_array) {
        if products.is_empty() {
            canvas.draw_text(
                54,
                y,
                "NO AUTHORIZED PRODUCTS IN THIS SESSION",
                [100, 116, 139],
                2,
            );
        } else {
            for product in products.iter().take(7) {
                let id = product
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let origin = product_display_origin(product);
                let account_count = product
                    .get("accounts")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                canvas.draw_text(
                    54,
                    y,
                    &truncate_ascii(&format!("PRODUCT {}  ORIGIN {}", id, origin), 88),
                    [15, 118, 110],
                    2,
                );
                y += 26;
                canvas.draw_text(
                    78,
                    y,
                    &truncate_ascii(&format!("ACCOUNTS {}", account_count), 84),
                    [51, 65, 85],
                    2,
                );
                y += 34;
            }
        }
    }

    canvas.fill_rect(34, 688, 1132, 1, [203, 213, 225]);
    canvas.draw_text(
        42,
        714,
        "TOKEN PROTECTED VERIFY CONTROL - BUILT-IN PNG - REDACTED STATUS ONLY",
        [100, 116, 139],
        2,
    );
    write_png(
        path,
        canvas.width as u32,
        canvas.height as u32,
        &canvas.pixels,
    )
}

pub(crate) fn product_display_origin(product: &Value) -> &str {
    product
        .get("policy")
        .and_then(|policy| policy.get("source_origin"))
        .and_then(Value::as_str)
        .or_else(|| product.get("origin").and_then(Value::as_str))
        .unwrap_or("unknown")
}

pub(crate) fn pending_authorization_screenshot_rows(pending: &Value) -> Vec<String> {
    let source_origin = pending
        .pointer("/authorization/source_origin")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let product_id = pending
        .pointer("/product/id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let product_name = pending
        .pointer("/product/name")
        .and_then(Value::as_str)
        .unwrap_or(product_id);
    let status = pending
        .pointer("/authorization/status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let capabilities = pending
        .get("policy_capabilities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_else(|| "none".to_string());
    let product_authorization = pending.get("product_authorization").unwrap_or(&Value::Null);
    let product_auth_owner = product_authorization
        .get("owner")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let product_auth_control = product_authorization
        .get("control")
        .or_else(|| product_authorization.get("mode"))
        .or_else(|| product_authorization.get("enforcement"))
        .and_then(Value::as_str)
        .unwrap_or("product-controlled");
    vec![
        format!("STATUS: {}  CONFIRM ACTION: confirm_pending_intent", status),
        format!("PRODUCT: {} ({})", product_name, product_id),
        format!("SOURCE ORIGIN: {}", source_origin),
        format!("POLICY CAPS: {}", capabilities),
        format!(
            "PRODUCT AUTH: OWNER {}  CONTROL {}",
            product_auth_owner, product_auth_control
        ),
    ]
}

pub(crate) fn write_png(path: &Path, width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|error| error.to_string())?;
    let writer = BufWriter::new(file);
    let mut encoder = png::Encoder::new(writer, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut png_writer = encoder.write_header().map_err(|error| error.to_string())?;
    png_writer
        .write_image_data(pixels)
        .map_err(|error| error.to_string())
}

pub(crate) struct Canvas {
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

impl Canvas {
    fn new(width: usize, height: usize, color: [u8; 3]) -> Self {
        let mut canvas = Self {
            width,
            height,
            pixels: vec![0; width * height * 3],
        };
        canvas.fill_rect(0, 0, width, height, color);
        canvas
    }

    fn fill_rect(&mut self, x: usize, y: usize, width: usize, height: usize, color: [u8; 3]) {
        let max_x = (x + width).min(self.width);
        let max_y = (y + height).min(self.height);
        for yy in y.min(self.height)..max_y {
            for xx in x.min(self.width)..max_x {
                let index = (yy * self.width + xx) * 3;
                self.pixels[index] = color[0];
                self.pixels[index + 1] = color[1];
                self.pixels[index + 2] = color[2];
            }
        }
    }

    fn draw_text(&mut self, x: usize, y: usize, text: &str, color: [u8; 3], scale: usize) {
        let mut cursor = x;
        for ch in text.chars() {
            if cursor + 6 * scale >= self.width {
                break;
            }
            let glyph = glyph_rows(ch.to_ascii_uppercase());
            for (row, bits) in glyph.iter().enumerate() {
                for (col, bit) in bits.chars().enumerate() {
                    if bit == '1' {
                        self.fill_rect(cursor + col * scale, y + row * scale, scale, scale, color);
                    }
                }
            }
            cursor += 6 * scale;
        }
    }
}

pub(crate) fn truncate_ascii(value: &str, max: usize) -> String {
    let mut out: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_graphic() || ch == ' ' {
                ch
            } else {
                '?'
            }
        })
        .collect();
    if out.len() > max {
        out.truncate(max.saturating_sub(3));
        out.push_str("...");
    }
    out
}

pub(crate) fn glyph_rows(ch: char) -> [&'static str; 7] {
    match ch {
        'A' => [
            "01110", "10001", "10001", "11111", "10001", "10001", "10001",
        ],
        'B' => [
            "11110", "10001", "10001", "11110", "10001", "10001", "11110",
        ],
        'C' => [
            "01111", "10000", "10000", "10000", "10000", "10000", "01111",
        ],
        'D' => [
            "11110", "10001", "10001", "10001", "10001", "10001", "11110",
        ],
        'E' => [
            "11111", "10000", "10000", "11110", "10000", "10000", "11111",
        ],
        'F' => [
            "11111", "10000", "10000", "11110", "10000", "10000", "10000",
        ],
        'G' => [
            "01111", "10000", "10000", "10111", "10001", "10001", "01111",
        ],
        'H' => [
            "10001", "10001", "10001", "11111", "10001", "10001", "10001",
        ],
        'I' => [
            "11111", "00100", "00100", "00100", "00100", "00100", "11111",
        ],
        'J' => [
            "00111", "00010", "00010", "00010", "10010", "10010", "01100",
        ],
        'K' => [
            "10001", "10010", "10100", "11000", "10100", "10010", "10001",
        ],
        'L' => [
            "10000", "10000", "10000", "10000", "10000", "10000", "11111",
        ],
        'M' => [
            "10001", "11011", "10101", "10101", "10001", "10001", "10001",
        ],
        'N' => [
            "10001", "11001", "10101", "10011", "10001", "10001", "10001",
        ],
        'O' => [
            "01110", "10001", "10001", "10001", "10001", "10001", "01110",
        ],
        'P' => [
            "11110", "10001", "10001", "11110", "10000", "10000", "10000",
        ],
        'Q' => [
            "01110", "10001", "10001", "10001", "10101", "10010", "01101",
        ],
        'R' => [
            "11110", "10001", "10001", "11110", "10100", "10010", "10001",
        ],
        'S' => [
            "01111", "10000", "10000", "01110", "00001", "00001", "11110",
        ],
        'T' => [
            "11111", "00100", "00100", "00100", "00100", "00100", "00100",
        ],
        'U' => [
            "10001", "10001", "10001", "10001", "10001", "10001", "01110",
        ],
        'V' => [
            "10001", "10001", "10001", "10001", "10001", "01010", "00100",
        ],
        'W' => [
            "10001", "10001", "10001", "10101", "10101", "10101", "01010",
        ],
        'X' => [
            "10001", "10001", "01010", "00100", "01010", "10001", "10001",
        ],
        'Y' => [
            "10001", "10001", "01010", "00100", "00100", "00100", "00100",
        ],
        'Z' => [
            "11111", "00001", "00010", "00100", "01000", "10000", "11111",
        ],
        '0' => [
            "01110", "10001", "10011", "10101", "11001", "10001", "01110",
        ],
        '1' => [
            "00100", "01100", "00100", "00100", "00100", "00100", "01110",
        ],
        '2' => [
            "01110", "10001", "00001", "00010", "00100", "01000", "11111",
        ],
        '3' => [
            "11110", "00001", "00001", "01110", "00001", "00001", "11110",
        ],
        '4' => [
            "00010", "00110", "01010", "10010", "11111", "00010", "00010",
        ],
        '5' => [
            "11111", "10000", "10000", "11110", "00001", "00001", "11110",
        ],
        '6' => [
            "01110", "10000", "10000", "11110", "10001", "10001", "01110",
        ],
        '7' => [
            "11111", "00001", "00010", "00100", "01000", "01000", "01000",
        ],
        '8' => [
            "01110", "10001", "10001", "01110", "10001", "10001", "01110",
        ],
        '9' => [
            "01110", "10001", "10001", "01111", "00001", "00001", "01110",
        ],
        ' ' => [
            "00000", "00000", "00000", "00000", "00000", "00000", "00000",
        ],
        ':' => [
            "00000", "00100", "00100", "00000", "00100", "00100", "00000",
        ],
        '-' => [
            "00000", "00000", "00000", "11111", "00000", "00000", "00000",
        ],
        '_' => [
            "00000", "00000", "00000", "00000", "00000", "00000", "11111",
        ],
        '.' => [
            "00000", "00000", "00000", "00000", "00000", "01100", "01100",
        ],
        '/' => [
            "00001", "00010", "00010", "00100", "01000", "01000", "10000",
        ],
        '@' => [
            "01110", "10001", "10111", "10101", "10111", "10000", "01111",
        ],
        ',' => [
            "00000", "00000", "00000", "00000", "01100", "00100", "01000",
        ],
        '+' => [
            "00000", "00100", "00100", "11111", "00100", "00100", "00000",
        ],
        '(' => [
            "00010", "00100", "01000", "01000", "01000", "00100", "00010",
        ],
        ')' => [
            "01000", "00100", "00010", "00010", "00010", "00100", "01000",
        ],
        '#' => [
            "01010", "11111", "01010", "01010", "11111", "01010", "00000",
        ],
        '?' => [
            "01110", "10001", "00001", "00010", "00100", "00000", "00100",
        ],
        _ => [
            "11111", "00001", "00010", "00100", "01000", "00000", "00100",
        ],
    }
}

pub(crate) fn activate_desktop_app() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let status = Command::new("osascript")
            .args(["-e", "tell application \"Panda Bridge\" to activate"])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("activate app failed: {status}"));
    }
    Ok(())
}

pub(crate) fn verify_control_state_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_VERIFY_CONTROL_STATE") {
        return Ok(PathBuf::from(path));
    }
    Ok(state_dir()?.join("verify-control.json"))
}

pub(crate) fn write_http_json(
    stream: &mut TcpStream,
    status: u16,
    payload: Value,
) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    let status_text = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {status_text}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\naccess-control-allow-origin: http://127.0.0.1\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
    .map_err(|error| error.to_string())
}
