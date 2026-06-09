use keyring::Entry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tao::{
    dpi::LogicalSize,
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
use tungstenite::{client::IntoClientRequest, connect, http::HeaderValue, Message};
#[cfg(windows)]
use window_vibrancy::{apply_acrylic, apply_mica};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
use wry::WebViewBuilder;

const VERSION: &str = "panda-bridge-desktop-lite-v0.1";
const KEYCHAIN_SERVICE: &str = "cc.otherline.panda-bridge";
const KEYCHAIN_USER: &str = "device";
const DEFAULT_API: &str = "https://api.bridge.otherline.cc";
const DEFAULT_WEB: &str = "https://bridge.otherline.cc";
#[cfg(windows)]
const WINDOWS_SINGLE_INSTANCE_ADDR: &str = "127.0.0.1:52321";
#[cfg(windows)]
const WINDOWS_SINGLE_INSTANCE_STATE_FILE: &str = "windows-single-instance.json";

#[derive(Clone)]
struct AppState {
    worker_running: Arc<AtomicBool>,
    realtime_connected: Arc<AtomicBool>,
    realtime_connection_keys: Arc<Mutex<HashSet<String>>>,
    events: Arc<Mutex<Vec<Value>>>,
}

#[derive(Debug, Clone)]
enum UserEvent {
    Ipc(String),
    Respond {
        id: String,
        ok: bool,
        payload: Value,
    },
    UiEvent(Value),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Credentials {
    api_base: String,
    device_id: String,
    device_name: String,
    device_token: String,
    #[serde(default)]
    install_id: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    account_display: Option<String>,
    #[serde(default)]
    product_id: Option<String>,
    #[serde(default)]
    product_name: Option<String>,
    #[serde(default)]
    cloud_origin: Option<String>,
    #[serde(default)]
    authorized_products: Vec<ProductGrant>,
    #[serde(default)]
    device_token_expires_at: Option<String>,
    #[serde(default)]
    device_token_rotated_at_unix: Option<u64>,
    #[serde(default)]
    install_identity_bound: Option<bool>,
    #[serde(default)]
    connections: Vec<Credentials>,
    claimed_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProductGrant {
    id: String,
    name: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    policy: Value,
    #[serde(default)]
    accounts: Vec<ProductGrantAccount>,
    authorized_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProductGrantAccount {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    authorized_at: String,
}

#[derive(Debug, Serialize)]
struct DesktopStatus {
    api_base: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    account_id: Option<String>,
    account_display: Option<String>,
    product_id: Option<String>,
    product_name: Option<String>,
    cloud_origin: Option<String>,
    authorized_products: Vec<ProductGrant>,
    worker_running: bool,
    realtime_connected: bool,
    codex_available: bool,
}

#[derive(Debug, Serialize)]
struct IntentPreview {
    product_id: String,
    product_name: String,
    cloud_origin: String,
    capabilities: Vec<String>,
    local_policy: Value,
    device_name: String,
    user_id: Option<String>,
    user_display_name: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
struct ClaimResult {
    device_id: String,
    device_name: String,
    account_id: Option<String>,
    account_display: Option<String>,
    product_id: Option<String>,
    product_name: Option<String>,
    cloud_origin: Option<String>,
    authorized_products: Vec<ProductGrant>,
}

#[derive(Debug, Deserialize)]
struct IntentResponse {
    connect_intent: ConnectIntent,
}

#[derive(Debug, Deserialize)]
struct ConnectIntent {
    product_id: String,
    product: Option<ProductInfo>,
    device_name: Option<String>,
    expires_at: String,
    user: Option<ConnectUser>,
}

#[derive(Debug, Deserialize)]
struct ConnectUser {
    id: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    device: Device,
    device_token: String,
    token_expires_at: Option<String>,
    install_identity_bound: Option<bool>,
    account: Option<ConnectUser>,
    product: Option<ProductInfo>,
    #[serde(default)]
    authorization: Option<AuthorizationInfo>,
}

#[derive(Debug, Deserialize)]
struct AuthorizationInfo {
    #[serde(default)]
    policy: Value,
}

#[derive(Debug, Deserialize)]
struct RotateTokenResponse {
    device_token: String,
    token_expires_at: Option<String>,
    old_token_expires_at: Option<String>,
    install_identity_bound: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct Device {
    id: String,
    device_name: String,
}

#[derive(Debug, Deserialize)]
struct ProductInfo {
    id: String,
    name: String,
    origin: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct JobsResponse {
    items: Vec<BridgeJob>,
}

#[derive(Debug, Deserialize)]
struct AcceptJobResponse {
    job: BridgeJob,
    accepted: bool,
}

#[derive(Debug, Deserialize)]
struct RealtimeEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    job: Option<BridgeJob>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct BridgeJob {
    id: String,
    product_id: String,
    kind: String,
    workspace_ref: Option<String>,
    input: Value,
    #[serde(default)]
    policy: Value,
}

#[derive(Debug, Clone)]
struct LocalJobPolicy {
    cwd: String,
    sandbox: String,
    approval_policy: String,
    developer_instructions: Option<String>,
}

struct CodexWarmSession {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Value>,
    err_rx: mpsc::Receiver<String>,
    next_id: u64,
    cwd: String,
}

#[derive(Debug, Deserialize)]
struct IpcMessage {
    id: String,
    command: String,
    #[serde(default)]
    params: Value,
}

#[cfg(windows)]
struct WindowsSingleInstance {
    listener: TcpListener,
    token: Arc<String>,
}

#[cfg(windows)]
#[derive(Debug, Serialize, Deserialize)]
struct WindowsSingleInstanceState {
    addr: String,
    token: String,
    pid: u32,
    created_at: String,
}

fn new_app_state() -> AppState {
    AppState {
        worker_running: Arc::new(AtomicBool::new(false)),
        realtime_connected: Arc::new(AtomicBool::new(false)),
        realtime_connection_keys: Arc::new(Mutex::new(HashSet::new())),
        events: Arc::new(Mutex::new(Vec::new())),
    }
}

fn push_event(state: &AppState, event_type: &str, payload: Value) {
    let event = json!({
        "seq": next_event_seq(),
        "type": event_type,
        "payload": payload,
        "created_at": now_string()
    });
    if let Ok(mut events) = state.events.lock() {
        events.push(event);
        let len = events.len();
        if len > 500 {
            events.drain(0..(len - 500));
        }
    }
}

fn state_events(state: &AppState) -> Vec<Value> {
    state
        .events
        .lock()
        .map(|events| events.clone())
        .unwrap_or_default()
}

fn next_event_seq() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_micros())
        .unwrap_or(0)
}

fn main() {
    if let Some(code) = run_headless_if_requested() {
        std::process::exit(code);
    }
    if let Err(error) = run_window() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run_window() -> Result<(), String> {
    let state = new_app_state();
    let initial_links = initial_deep_links();
    #[cfg(windows)]
    let windows_single_instance = match prepare_windows_single_instance(&initial_links)? {
        Some(instance) => instance,
        None => return Ok(()),
    };
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let ipc_proxy = proxy.clone();
    #[cfg(windows)]
    {
        windows_single_instance.start(proxy.clone());
        if let Err(error) = register_windows_url_scheme() {
            eprintln!("[windows] failed to register panda-bridge URL scheme: {error}");
        }
    }
    if verify_control_enabled() {
        start_verify_control(state.clone(), proxy.clone())?;
    }
    #[allow(unused_mut)]
    let mut window_builder = WindowBuilder::new()
        .with_title("Panda Connector")
        .with_inner_size(LogicalSize::new(760.0, 540.0))
        .with_min_inner_size(LogicalSize::new(680.0, 480.0))
        .with_resizable(true);
    #[cfg(target_os = "macos")]
    {
        window_builder = window_builder.with_transparent(true);
    }
    #[cfg(windows)]
    {
        window_builder = window_builder.with_transparent(true);
    }
    let window = window_builder
        .build(&event_loop)
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    if let Err(error) = apply_vibrancy(
        &window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    ) {
        eprintln!("[vibrancy] failed to apply: {error}");
    }
    #[cfg(windows)]
    let windows_backdrop_enabled = apply_windows_backdrop(&window);
    let html = include_str!("../ui/index.html");
    #[allow(unused_mut)]
    let mut webview_builder =
        WebViewBuilder::new()
            .with_html(html)
            .with_ipc_handler(move |request| {
                let _ = ipc_proxy.send_event(UserEvent::Ipc(request.body().clone()));
            });
    #[cfg(target_os = "macos")]
    {
        webview_builder = webview_builder.with_transparent(true);
    }
    #[cfg(windows)]
    {
        if windows_backdrop_enabled {
            webview_builder = webview_builder.with_transparent(true);
        } else {
            webview_builder = webview_builder.with_background_color((245, 247, 250, 255));
        }
    }
    let webview = webview_builder
        .build(&window)
        .map_err(|error| error.to_string())?;

    let mut sent_initial_links = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) if !sent_initial_links => {
                sent_initial_links = true;
                if load_credentials().is_ok() {
                    let _ = start_worker(&state, proxy.clone());
                }
                for link in &initial_links {
                    let _ = proxy.send_event(UserEvent::UiEvent(json!({
                        "type": "event",
                        "event": "deep_link",
                        "url": link
                    })));
                }
            }
            Event::Opened { urls } => {
                for url in urls {
                    let _ = proxy.send_event(UserEvent::UiEvent(json!({
                        "type": "event",
                        "event": "deep_link",
                        "url": url.to_string()
                    })));
                }
            }
            Event::UserEvent(UserEvent::Ipc(raw)) => {
                handle_ipc(raw, state.clone(), proxy.clone());
            }
            Event::UserEvent(UserEvent::Respond { id, ok, payload }) => {
                let message = if ok {
                    json!({ "type": "response", "id": id, "ok": true, "result": payload })
                } else {
                    json!({ "type": "response", "id": id, "ok": false, "error": payload.as_str().unwrap_or("desktop command failed") })
                };
                let _ = webview.evaluate_script(&format!("window.PandaBridge.receive({});", message));
            }
            Event::UserEvent(UserEvent::UiEvent(message)) => {
                let _ = webview.evaluate_script(&format!("window.PandaBridge.receive({});", message));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                state.worker_running.store(false, Ordering::SeqCst);
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

#[cfg(windows)]
fn prepare_windows_single_instance(
    initial_links: &[String],
) -> Result<Option<WindowsSingleInstance>, String> {
    match TcpListener::bind(WINDOWS_SINGLE_INSTANCE_ADDR) {
        Ok(listener) => {
            let token = Arc::new(format!("pbw_{}_{}", std::process::id(), next_event_seq()));
            write_windows_single_instance_state(token.as_str())?;
            Ok(Some(WindowsSingleInstance { listener, token }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            forward_windows_deep_links(initial_links)?;
            Ok(None)
        }
        Err(error) => Err(format!(
            "failed to bind Windows single-instance listener on {WINDOWS_SINGLE_INSTANCE_ADDR}: {error}"
        )),
    }
}

#[cfg(windows)]
impl WindowsSingleInstance {
    fn start(self, proxy: EventLoopProxy<UserEvent>) {
        let token = self.token.clone();
        thread::spawn(move || {
            for incoming in self.listener.incoming() {
                match incoming {
                    Ok(stream) => {
                        let next_proxy = proxy.clone();
                        let next_token = token.clone();
                        thread::spawn(move || {
                            if let Err(error) =
                                handle_windows_instance_stream(stream, next_proxy, next_token)
                            {
                                eprintln!("[windows-single-instance] {error}");
                            }
                        });
                    }
                    Err(error) => eprintln!("[windows-single-instance] accept failed: {error}"),
                }
            }
        });
    }
}

#[cfg(windows)]
fn handle_windows_instance_stream(
    stream: TcpStream,
    proxy: EventLoopProxy<UserEvent>,
    token: Arc<String>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut raw = String::new();
    reader
        .read_line(&mut raw)
        .map_err(|error| error.to_string())?;
    let payload: Value = serde_json::from_str(raw.trim()).map_err(|error| error.to_string())?;
    if payload.get("token").and_then(Value::as_str) != Some(token.as_str()) {
        return Err("invalid forwarding token".to_string());
    }
    let links = payload
        .get("links")
        .and_then(Value::as_array)
        .ok_or("forwarded payload missing links")?;
    for link in links.iter().filter_map(Value::as_str) {
        let _ = proxy.send_event(UserEvent::UiEvent(json!({
            "type": "event",
            "event": "deep_link",
            "url": link
        })));
    }
    Ok(())
}

#[cfg(windows)]
fn forward_windows_deep_links(initial_links: &[String]) -> Result<(), String> {
    let state_text = fs::read_to_string(windows_single_instance_state_path()?)
        .map_err(|error| format!("single-instance state unavailable: {error}"))?;
    let state: WindowsSingleInstanceState = serde_json::from_str(&state_text)
        .map_err(|error| format!("invalid single-instance state: {error}"))?;
    let mut stream = TcpStream::connect(&state.addr).map_err(|error| {
        format!(
            "failed to connect to primary instance at {}: {error}",
            state.addr
        )
    })?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let payload = json!({
        "token": state.token,
        "links": initial_links
    });
    writeln!(stream, "{payload}").map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

#[cfg(windows)]
fn write_windows_single_instance_state(token: &str) -> Result<(), String> {
    let state = WindowsSingleInstanceState {
        addr: WINDOWS_SINGLE_INSTANCE_ADDR.to_string(),
        token: token.to_string(),
        pid: std::process::id(),
        created_at: now_string(),
    };
    write_file(
        &windows_single_instance_state_path()?,
        &serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?,
    )
}

#[cfg(windows)]
fn windows_single_instance_state_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join(WINDOWS_SINGLE_INSTANCE_STATE_FILE))
}

#[cfg(windows)]
fn register_windows_url_scheme() -> Result<(), String> {
    let exe = env::current_exe().map_err(|error| error.to_string())?;
    let command = format!("\"{}\" \"%1\"", exe.to_string_lossy());
    let scheme = windows_registry::CURRENT_USER
        .create(r"Software\Classes\panda-bridge")
        .map_err(|error| error.to_string())?;
    scheme
        .set_string("", "URL:Panda Bridge Protocol")
        .map_err(|error| error.to_string())?;
    scheme
        .set_string("URL Protocol", "")
        .map_err(|error| error.to_string())?;
    let command_key = windows_registry::CURRENT_USER
        .create(r"Software\Classes\panda-bridge\shell\open\command")
        .map_err(|error| error.to_string())?;
    command_key
        .set_string("", command)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn apply_windows_backdrop(window: &tao::window::Window) -> bool {
    match apply_mica(window, Some(false)) {
        Ok(()) => true,
        Err(mica_error) => match apply_acrylic(window, Some((245, 247, 250, 180))) {
            Ok(()) => true,
            Err(acrylic_error) => {
                eprintln!(
                    "[vibrancy] Windows native backdrop unavailable; mica: {mica_error}; acrylic: {acrylic_error}"
                );
                false
            }
        },
    }
}

fn verify_control_enabled() -> bool {
    env_flag("PANDA_BRIDGE_VERIFY")
}

fn start_verify_control(state: AppState, proxy: EventLoopProxy<UserEvent>) -> Result<(), String> {
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

fn handle_verify_stream(
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
    let payload = match (method, path_only) {
        ("GET", "/v1/status") => {
            serde_json::to_value(status(&state)).map_err(|error| error.to_string())?
        }
        ("GET", "/v1/events") => json!({ "items": state_events(&state) }),
        ("GET", "/v1/snapshot") => verify_snapshot(&state),
        ("GET", "/v1/screenshot") => desktop_screenshot(&state)?,
        ("POST", "/v1/actions") => {
            let body_value: Value =
                serde_json::from_str(body).map_err(|error| error.to_string())?;
            run_verify_action(&state, proxy, &body_value)?
        }
        _ => json!({ "error": "not_found", "method": method, "path": path_only }),
    };
    let status_code = if payload.get("error").is_some() {
        404
    } else {
        200
    };
    write_http_json(&mut stream, status_code, payload)
}

fn run_verify_action(
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
    params: &Value,
) -> Result<Value, String> {
    let action = required_param(params, "action")?;
    let result = match action.as_str() {
        "start_worker" => start_worker(state, proxy.clone())?,
        "stop_worker" => {
            state.worker_running.store(false, Ordering::SeqCst);
            json!({ "ok": true, "message": "worker stopped" })
        }
        "disconnect" => {
            state.worker_running.store(false, Ordering::SeqCst);
            delete_credentials()?;
            json!({ "ok": true, "message": "disconnected" })
        }
        "open_web" => {
            let url = string_param(params, "url").unwrap_or_else(|| DEFAULT_WEB.to_string());
            open_url(&url)?;
            json!({ "ok": true, "message": "opened web" })
        }
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
        "claim_intent" | "click_allow_intent" => {
            let api = string_param(params, "api").unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = required_param(params, "intent")?;
            let device_name = string_param(params, "device_name").unwrap_or_else(device_name);
            let claim = claim_intent(&api, &intent, &device_name)?;
            let _ = start_worker(state, proxy.clone());
            serde_json::to_value(claim).map_err(|error| error.to_string())?
        }
        "revoke_authorization" | "click_revoke_authorization" => {
            let product_id = required_param(params, "product_id")?;
            let account_id = string_param(params, "account_id");
            let device_id = string_param(params, "device_id");
            revoke_authorization_for_state(
                state,
                &product_id,
                account_id.as_deref(),
                device_id.as_deref(),
            )?
        }
        "refresh_status" | "click_refresh_status" => {
            serde_json::to_value(status(state)).map_err(|error| error.to_string())?
        }
        other => return Err(format!("unknown verify action: {other}")),
    };
    push_event(state, "verify_action", json!({ "action": action }));
    let _ = proxy.send_event(UserEvent::UiEvent(
        json!({ "type": "event", "event": "refresh" }),
    ));
    Ok(result)
}

fn verify_snapshot(state: &AppState) -> Value {
    json!({
        "ok": true,
        "status": status(state),
        "events": state_events(state)
    })
}

fn desktop_screenshot(state: &AppState) -> Result<Value, String> {
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

const BUILTIN_SCREENSHOT_WIDTH: usize = 1200;
const BUILTIN_SCREENSHOT_HEIGHT: usize = 760;

fn write_builtin_screenshot(path: &Path, snapshot: &Value) -> Result<(), String> {
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
    let codex = status
        .get("codex_available")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let rows = vec![
        format!("CAPTURED: {}", now_string()),
        "METHOD: BUILTIN_APP_PNG".to_string(),
        format!("DEVICE: {}", device_name),
        format!("DEVICE ID: {}", device_id),
        format!(
            "WORKER: {}  REALTIME: {}  CODEX: {}",
            worker, realtime, codex
        ),
        format!("AUTHORIZED PRODUCTS: {}", product_count),
    ];
    let mut y = 154;
    for row in rows {
        canvas.draw_text(42, y, &truncate_ascii(&row, 88), [38, 50, 70], 2);
        y += 30;
    }

    canvas.fill_rect(34, 344, 1132, 2, [203, 213, 225]);
    canvas.draw_text(42, 374, "LOCAL AUTHORIZATION RECORDS", [24, 32, 48], 3);
    y = 426;
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
                let origin = product
                    .get("origin")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let capabilities = product
                    .get("capabilities")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "none".to_string());
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
                    &truncate_ascii(&format!("CAPABILITIES {}", capabilities), 84),
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

fn write_png(path: &Path, width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
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

struct Canvas {
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

fn truncate_ascii(value: &str, max: usize) -> String {
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

fn glyph_rows(ch: char) -> [&'static str; 7] {
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

fn activate_desktop_app() -> Result<(), String> {
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

fn verify_control_state_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_VERIFY_CONTROL_STATE") {
        return Ok(PathBuf::from(path));
    }
    Ok(state_dir()?.join("verify-control.json"))
}

fn write_http_json(stream: &mut TcpStream, status: u16, payload: Value) -> Result<(), String> {
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

fn handle_ipc(raw: String, state: AppState, proxy: EventLoopProxy<UserEvent>) {
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

fn run_command(
    command: &str,
    params: &Value,
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<Value, String> {
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
        "revoke_authorization" => {
            let product_id = required_param(params, "product_id")?;
            let account_id = string_param(params, "account_id");
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
            let url = string_param(params, "url").unwrap_or_else(|| DEFAULT_WEB.to_string());
            open_url(&url)?;
            Ok(json!({ "ok": true, "message": "opened web" }))
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

fn status(state: &AppState) -> DesktopStatus {
    let credentials = load_credentials().ok();
    DesktopStatus {
        api_base: credentials.as_ref().map(|item| item.api_base.clone()),
        device_id: credentials.as_ref().map(|item| item.device_id.clone()),
        device_name: credentials.as_ref().map(|item| item.device_name.clone()),
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
            .map(credentials_products)
            .unwrap_or_default(),
        worker_running: state.worker_running.load(Ordering::SeqCst),
        realtime_connected: state.realtime_connected.load(Ordering::SeqCst),
        codex_available: command_exists(&codex_bin()),
    }
}

fn preview_intent(api: &str, intent: &str) -> Result<IntentPreview, String> {
    let api_base = clean_api(api)?;
    let url = format!(
        "{}/v1/connect-intents/{}",
        api_base,
        urlencoding::encode(intent)
    );
    let payload: IntentResponse = get_json(&url, None)?;
    let product_id = payload.connect_intent.product_id.clone();
    let product_name = payload
        .connect_intent
        .product
        .as_ref()
        .map(|product| product.name.clone())
        .unwrap_or_else(|| product_id.clone());
    let cloud_origin = payload
        .connect_intent
        .product
        .as_ref()
        .and_then(|product| product.origin.clone())
        .unwrap_or_else(|| api_base.clone());
    let capabilities = payload
        .connect_intent
        .product
        .as_ref()
        .map(|product| product.capabilities.clone())
        .unwrap_or_default();
    Ok(IntentPreview {
        product_id,
        product_name,
        cloud_origin,
        capabilities,
        local_policy: local_policy_preview(),
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
    })
}

fn claim_intent(api: &str, intent: &str, device_name: &str) -> Result<ClaimResult, String> {
    let api_base = clean_api(api)?;
    let existing = load_credentials().ok();
    let intent_preview = preview_intent(&api_base, intent).ok();
    let install_id = credentials_install_id(existing.as_ref());
    let existing_connections = existing
        .as_ref()
        .map(credentials_connections)
        .unwrap_or_default();
    let bearer_connection = intent_preview
        .as_ref()
        .and_then(|preview| preview.user_id.as_deref())
        .and_then(|user_id| {
            existing_connections.iter().find(|connection| {
                connection.api_base == api_base
                    && connection.account_id.as_deref() == Some(user_id)
                    && !connection.device_token.trim().is_empty()
            })
        });
    let authorization_policy = local_authorization_policy(intent_preview.as_ref());
    let body = json!({
        "device_name": if device_name.trim().is_empty() { "Panda Bridge Desktop" } else { device_name.trim() },
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state(),
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
    let account_display = payload
        .account
        .as_ref()
        .map(display_account)
        .or_else(|| bearer_connection.and_then(|item| item.account_display.clone()));
    let account_id = payload
        .account
        .as_ref()
        .and_then(|account| account.id.clone())
        .or_else(|| bearer_connection.and_then(|item| item.account_id.clone()))
        .or_else(|| intent_preview.and_then(|preview| preview.user_id));
    let product_id = payload.product.as_ref().map(|product| product.id.clone());
    let product_name = payload.product.as_ref().map(|product| product.name.clone());
    let cloud_origin = payload
        .product
        .as_ref()
        .and_then(|product| product.origin.clone());
    let product_capabilities = payload
        .product
        .as_ref()
        .map(|product| product.capabilities.clone())
        .unwrap_or_default();
    let authorization_policy = payload
        .authorization
        .as_ref()
        .map(|authorization| authorization.policy.clone())
        .unwrap_or(Value::Null);
    let existing_connection = existing_connections.iter().find(|connection| {
        connection.device_id == payload.device.id
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
        product_capabilities,
        authorization_policy,
    );
    let connection = Credentials {
        api_base: api_base.clone(),
        device_id: payload.device.id.clone(),
        device_name: payload.device.device_name.clone(),
        device_token: payload.device_token,
        install_id: Some(install_id),
        account_id: account_id.clone(),
        account_display: account_display.clone(),
        product_id: product_id.clone(),
        product_name: product_name.clone(),
        cloud_origin: cloud_origin.clone(),
        authorized_products: authorized_products.clone(),
        device_token_expires_at: payload.token_expires_at,
        device_token_rotated_at_unix: Some(unix_seconds()),
        install_identity_bound: payload.install_identity_bound,
        connections: Vec::new(),
        claimed_at: now_string(),
    };
    let mut connections = existing_connections;
    upsert_connection(&mut connections, connection.clone());
    let credentials =
        credentials_from_connections(connections, Some(&connection), existing.as_ref());
    save_credentials(&credentials)?;
    write_connector_state(&credentials)?;
    Ok(ClaimResult {
        device_id: payload.device.id,
        device_name: payload.device.device_name,
        account_id,
        account_display,
        product_id,
        product_name,
        cloud_origin,
        authorized_products,
    })
}

fn revoke_authorization(
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
    let matching: Vec<usize> = connections
        .iter()
        .enumerate()
        .filter(|(_, connection)| {
            connection_products(connection)
                .iter()
                .any(|item| item.id == product_id)
                && account_id
                    .map(|id| connection.account_id.as_deref() == Some(id))
                    .unwrap_or(true)
                && device_id
                    .map(|id| connection.device_id == id)
                    .unwrap_or(true)
        })
        .map(|(index, _)| index)
        .collect();
    if matching.is_empty() {
        return Err("authorization_not_found".to_string());
    }
    if account_id.is_none() && device_id.is_none() && matching.len() > 1 {
        return Err("ambiguous_authorization_target".to_string());
    }

    let mut remote_results = Vec::new();
    for index in matching {
        let connection = connections[index].clone();
        let url = format!(
            "{}/v1/connectors/products/{}/authorization",
            connection.api_base,
            urlencoding::encode(product_id)
        );
        let remote_revoke: Result<Value, String> = delete_json_with_install(
            &url,
            Some(&connection.device_token),
            connection.install_id.as_deref(),
        );
        connections[index].authorized_products = connection_products(&connection)
            .into_iter()
            .filter(|item| item.id != product_id)
            .collect();
        if connections[index].product_id.as_deref() == Some(product_id) {
            connections[index].product_id = None;
            connections[index].product_name = None;
            connections[index].cloud_origin = None;
        }
        let (remote_revoke_ok, payload, remote_revoke_error) = match remote_revoke {
            Ok(payload) => (true, payload, Value::Null),
            Err(error) => (false, Value::Null, Value::String(redact_error_text(&error))),
        };
        remote_results.push(json!({
            "remote_revoke_ok": remote_revoke_ok,
            "account_id": connection.account_id,
            "account_display": connection.account_display,
            "device_id": connection.device_id,
            "authorization": payload.get("authorization").cloned().unwrap_or(Value::Null),
            "cancelled_jobs": payload.get("cancelled_jobs").cloned().unwrap_or(Value::Null),
            "remote_revoke_error": remote_revoke_error
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

fn revoke_authorization_for_state(
    state: &AppState,
    product_id: &str,
    account_id: Option<&str>,
    device_id: Option<&str>,
) -> Result<Value, String> {
    let payload = revoke_authorization(product_id, account_id, device_id)?;
    let empty_products = payload
        .get("authorized_products")
        .and_then(Value::as_array)
        .map(|items| items.is_empty())
        .unwrap_or(false);
    if empty_products {
        state.worker_running.store(false, Ordering::SeqCst);
        state.realtime_connected.store(false, Ordering::SeqCst);
    }
    Ok(payload)
}

fn redact_error_text(error: &str) -> String {
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

fn redact_local_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|item| item.to_str())
        .map(|item| format!("[local]/{item}"))
        .unwrap_or_else(|| "[local]".to_string())
}

fn start_worker(state: &AppState, proxy: EventLoopProxy<UserEvent>) -> Result<Value, String> {
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
            thread::sleep(Duration::from_millis(1800));
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

fn credentials_products(credentials: &Credentials) -> Vec<ProductGrant> {
    aggregate_authorized_products(&credentials_connections(credentials))
}

fn connection_products(credentials: &Credentials) -> Vec<ProductGrant> {
    if !credentials.authorized_products.is_empty() {
        return credentials
            .authorized_products
            .iter()
            .cloned()
            .map(product_without_accounts)
            .collect();
    }
    match (&credentials.product_id, &credentials.product_name) {
        (Some(id), Some(name)) => vec![ProductGrant {
            id: id.clone(),
            name: name.clone(),
            origin: credentials.cloud_origin.clone(),
            capabilities: Vec::new(),
            policy: Value::Null,
            accounts: Vec::new(),
            authorized_at: credentials.claimed_at.clone(),
        }],
        _ => Vec::new(),
    }
}

fn product_without_accounts(mut product: ProductGrant) -> ProductGrant {
    product.accounts.clear();
    product
}

fn connection_without_nested(mut credentials: Credentials) -> Credentials {
    credentials.connections.clear();
    credentials.authorized_products = connection_products(&credentials);
    credentials
}

fn credentials_connections(credentials: &Credentials) -> Vec<Credentials> {
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

fn authorized_connections(credentials: &Credentials) -> Vec<Credentials> {
    credentials_connections(credentials)
        .into_iter()
        .filter(|item| !connection_products(item).is_empty())
        .collect()
}

fn aggregate_authorized_products(connections: &[Credentials]) -> Vec<ProductGrant> {
    let mut products: Vec<ProductGrant> = Vec::new();
    for connection in connections {
        for product in connection_products(connection) {
            let account = ProductGrantAccount {
                id: connection.account_id.clone(),
                email: connection.account_display.clone(),
                display_name: connection.account_display.clone(),
                device_id: Some(connection.device_id.clone()),
                origin: product
                    .origin
                    .clone()
                    .or_else(|| connection.cloud_origin.clone()),
                authorized_at: product.authorized_at.clone(),
            };
            if let Some(existing) = products.iter_mut().find(|item| item.id == product.id) {
                existing.name = product.name.clone();
                existing.origin = product.origin.clone().or_else(|| existing.origin.clone());
                existing.capabilities = product.capabilities.clone();
                existing.authorized_at = product.authorized_at.clone();
                let duplicate = existing.accounts.iter().any(|item| {
                    item.device_id.as_deref() == Some(connection.device_id.as_str())
                        && item.id.as_deref() == connection.account_id.as_deref()
                });
                if !duplicate {
                    existing.accounts.push(account);
                }
            } else {
                let mut next = product_without_accounts(product);
                next.accounts.push(account);
                products.push(next);
            }
        }
    }
    products
}

fn credentials_from_connections(
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
        connections: sanitized,
        claimed_at: primary.claimed_at.clone(),
    }
}

fn authorized_connections_from_slice(connections: &[Credentials]) -> Vec<Credentials> {
    connections
        .iter()
        .filter(|item| !connection_products(item).is_empty())
        .cloned()
        .collect()
}

fn empty_credentials() -> Credentials {
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
        connections: Vec::new(),
        claimed_at: now_string(),
    }
}

fn connection_key(credentials: &Credentials) -> String {
    if let Some(account_id) = credentials.account_id.as_deref() {
        return format!("account:{}:{}", credentials.api_base, account_id);
    }
    format!("device:{}:{}", credentials.api_base, credentials.device_id)
}

fn upsert_connection(connections: &mut Vec<Credentials>, next: Credentials) {
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

fn merge_authorized_products(
    existing: Option<&Credentials>,
    product_id: Option<String>,
    product_name: Option<String>,
    cloud_origin: Option<String>,
    capabilities: Vec<String>,
    policy: Value,
) -> Vec<ProductGrant> {
    let mut products = existing.map(connection_products).unwrap_or_default();
    if let Some(id) = product_id {
        let name = product_name.unwrap_or_else(|| id.clone());
        let grant = ProductGrant {
            id: id.clone(),
            name,
            origin: cloud_origin,
            capabilities,
            policy,
            accounts: Vec::new(),
            authorized_at: now_string(),
        };
        if let Some(index) = products.iter().position(|item| item.id == id) {
            products[index] = grant;
        } else {
            products.push(grant);
        }
    }
    products
}

fn ensure_credentials_install_id(mut credentials: Credentials) -> Result<Credentials, String> {
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

fn credentials_install_id(existing: Option<&Credentials>) -> String {
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

fn random_install_id() -> String {
    let mut bytes = [0_u8; 32];
    if fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_ok()
    {
        return format!("pbi_{}", hex_bytes(&bytes));
    }
    format!("pbi_{}_{}", unix_seconds(), std::process::id())
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn heartbeat(credentials: &Credentials) -> Result<(), String> {
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state(),
        "install_id": credentials.install_id.clone().unwrap_or_default()
    });
    let url = format!("{}/v1/connectors/heartbeat", credentials.api_base);
    let _: Value = post_json_with_install(
        &url,
        &body,
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(())
}

fn prepare_connections_for_worker(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<Vec<Credentials>, String> {
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    let mut connections = credentials_connections(&credentials);
    if connections
        .iter()
        .all(|item| connection_products(item).is_empty())
    {
        state.worker_running.store(false, Ordering::SeqCst);
        state.realtime_connected.store(false, Ordering::SeqCst);
        return Err("no_authorized_products".to_string());
    }
    let mut changed = false;
    for connection in connections.iter_mut() {
        if connection_products(connection).is_empty() || !device_token_rotation_due(connection) {
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
        let next = credentials_from_connections(connections.clone(), None, Some(&credentials));
        save_credentials(&next)?;
        write_connector_state(&next)?;
        return Ok(authorized_connections(&next));
    }
    Ok(authorized_connections(&credentials))
}

fn rotate_device_token(credentials: &Credentials) -> Result<Credentials, String> {
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state(),
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

fn device_token_rotation_due(credentials: &Credentials) -> bool {
    let interval = token_rotation_interval_seconds();
    if interval == 0 {
        return true;
    }
    let rotated_at = credentials.device_token_rotated_at_unix.unwrap_or(0);
    unix_seconds().saturating_sub(rotated_at) >= interval
}

fn token_rotation_interval_seconds() -> u64 {
    env::var("PANDA_BRIDGE_TOKEN_ROTATION_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(60 * 60 * 24)
}

fn spawn_missing_realtime_workers(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<usize, String> {
    let connections = authorized_connections(&load_credentials()?);
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
            while running.load(Ordering::SeqCst) {
                let result = run_realtime_worker(
                    &connection,
                    &running,
                    &realtime_connected,
                    &thread_state,
                    &thread_proxy,
                );
                if let Err(error) = result {
                    push_event(
                        &thread_state,
                        "realtime_disconnected",
                        json!({
                            "error": redact_error_text(&error),
                            "connection": realtime_connection_payload(&connection)
                        }),
                    );
                    let _ = thread_proxy.send_event(UserEvent::UiEvent(json!({
                        "type": "event",
                        "event": "log",
                        "message": "realtime disconnected; polling fallback active"
                    })));
                }
                if running.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(2000));
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

fn realtime_connection_key(credentials: &Credentials) -> String {
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

fn realtime_connection_payload(credentials: &Credentials) -> Value {
    json!({
        "api_base": credentials.api_base,
        "device_id": credentials.device_id,
        "account_id": credentials.account_id,
        "account_display": credentials.account_display,
        "product_ids": connection_products(credentials)
            .into_iter()
            .map(|product| product.id)
            .collect::<Vec<_>>()
    })
}

fn run_realtime_worker(
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
            "product_ids": connection_products(credentials)
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
    let mut codex_session = warm_codex_session(credentials, state, proxy);
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
                if envelope.message_type == "job.assign" {
                    if let Some(job) = envelope.job {
                        if !processed.contains(&job.id) {
                            push_event(
                                state,
                                "realtime_job",
                                json!({
                                    "job_id": job.id,
                                    "kind": job.kind,
                                    "product_id": job.product_id,
                                    "device_id": credentials.device_id,
                                    "account_id": credentials.account_id,
                                    "transport": "websocket"
                                }),
                            );
                            let _ = proxy.send_event(UserEvent::UiEvent(
                                json!({ "type": "event", "event": "refresh" }),
                            ));
                            if accept_job(credentials, &job, "websocket")? {
                                processed.insert(job.id.clone());
                                execute_and_ack_warm(credentials, &job, &mut codex_session)?;
                            }
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

fn warm_codex_session(
    credentials: &Credentials,
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Option<CodexWarmSession> {
    if fake_codex_enabled() || !command_exists(&codex_bin()) {
        return None;
    }
    let cwd = workspace_path("default");
    push_event(
        state,
        "codex_warming",
        json!({ "workspace_ref": "default" }),
    );
    let _ = proxy.send_event(UserEvent::UiEvent(json!({
        "type": "event",
        "event": "log",
        "message": "warming local Codex app-server"
    })));
    match CodexWarmSession::start(cwd) {
        Ok(session) => {
            push_event(
                state,
                "codex_warmed",
                json!({
                    "workspace_ref": "default",
                    "account_id": credentials.account_id.clone()
                }),
            );
            let _ = proxy.send_event(UserEvent::UiEvent(json!({
                "type": "event",
                "event": "log",
                "message": "local Codex app-server is warm"
            })));
            Some(session)
        }
        Err(error) => {
            push_event(state, "codex_warm_failed", json!({ "error": error }));
            None
        }
    }
}

fn realtime_url(credentials: &Credentials) -> Result<String, String> {
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

fn poll_all_connections(credentials: &Credentials) -> Result<Value, String> {
    let connections = authorized_connections(credentials);
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
    for connection in connections.iter() {
        match heartbeat(connection).and_then(|_| poll_once(connection)) {
            Ok(count) => {
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
        return Err(format!("all connection polls failed: {}", errors.len()));
    }
    Ok(json!({
        "ok": true,
        "count": total,
        "connections": results,
        "errors": errors,
        "message": format!("worker tick ok, jobs={total}")
    }))
}

fn poll_once(credentials: &Credentials) -> Result<usize, String> {
    let url = format!("{}/v1/connectors/jobs", credentials.api_base);
    let payload: JobsResponse = get_json_with_install(
        &url,
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    let count = payload.items.len();
    for job in payload.items {
        execute_and_ack(credentials, &job)?;
    }
    Ok(count)
}

fn accept_job(credentials: &Credentials, job: &BridgeJob, transport: &str) -> Result<bool, String> {
    let url = format!(
        "{}/v1/connectors/jobs/{}/accept",
        credentials.api_base,
        urlencoding::encode(&job.id)
    );
    let response: AcceptJobResponse = post_json_with_install(
        &url,
        &json!({ "transport": transport }),
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(response.accepted && response.job.id == job.id)
}

fn execute_and_ack(credentials: &Credentials, job: &BridgeJob) -> Result<(), String> {
    let result = execute_job(credentials, job).unwrap_or_else(
        |error| json!({ "ok": false, "error": error, "cloud_openai_credentials": false }),
    );
    let status = if result.get("ok").and_then(Value::as_bool) == Some(false) {
        "failed"
    } else {
        "succeeded"
    };
    let ack_url = format!(
        "{}/v1/connectors/jobs/{}/ack",
        credentials.api_base,
        urlencoding::encode(&job.id)
    );
    let _: Value = post_json_with_install(
        &ack_url,
        &json!({ "status": status, "result": result }),
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(())
}

fn execute_and_ack_warm(
    credentials: &Credentials,
    job: &BridgeJob,
    session: &mut Option<CodexWarmSession>,
) -> Result<(), String> {
    let result = execute_job_warm(credentials, job, session).unwrap_or_else(|error| {
        json!({ "ok": false, "error": error, "cloud_openai_credentials": false, "codex_warm": false })
    });
    let status = if result.get("ok").and_then(Value::as_bool) == Some(false) {
        "failed"
    } else {
        "succeeded"
    };
    let ack_url = format!(
        "{}/v1/connectors/jobs/{}/ack",
        credentials.api_base,
        urlencoding::encode(&job.id)
    );
    let _: Value = post_json_with_install(
        &ack_url,
        &json!({ "status": status, "result": result }),
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(())
}

fn execute_job(credentials: &Credentials, job: &BridgeJob) -> Result<Value, String> {
    if let Err(error) = validate_local_job_authorization(credentials, job) {
        let result = local_policy_denial_result(job, &error);
        post_event_best_effort(
            credentials,
            &job.id,
            "policy_denied",
            local_policy_denial_event(job, &error),
        );
        return Ok(result);
    }
    if let Ok(policy) = effective_job_policy(job) {
        post_event_best_effort(
            credentials,
            &job.id,
            "effective_policy",
            effective_policy_event(job, &policy),
        );
    }
    post_event_best_effort(
        credentials,
        &job.id,
        "started",
        json!({ "kind": job.kind, "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string()) }),
    );
    if fake_codex_enabled() {
        let prompt = job
            .input
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let reply = format!(
            "Panda Bridge fixture reply: {}",
            if prompt.is_empty() { "ok" } else { prompt }
        );
        post_event_best_effort(
            credentials,
            &job.id,
            "text_delta",
            json!({ "delta": reply }),
        );
        return Ok(
            json!({ "ok": true, "reply": reply, "fixture": true, "cloud_openai_credentials": false }),
        );
    }
    run_codex_app_server(credentials, job)
}

fn execute_job_warm(
    credentials: &Credentials,
    job: &BridgeJob,
    session: &mut Option<CodexWarmSession>,
) -> Result<Value, String> {
    if let Err(error) = validate_local_job_authorization(credentials, job) {
        let mut result = local_policy_denial_result(job, &error);
        if let Value::Object(ref mut map) = result {
            map.insert("codex_warm".to_string(), Value::Bool(false));
        }
        post_event_best_effort(
            credentials,
            &job.id,
            "policy_denied",
            local_policy_denial_event(job, &error),
        );
        return Ok(result);
    }
    if let Ok(policy) = effective_job_policy(job) {
        post_event_best_effort(
            credentials,
            &job.id,
            "effective_policy",
            effective_policy_event(job, &policy),
        );
    }
    post_event_best_effort(
        credentials,
        &job.id,
        "started",
        json!({
            "kind": job.kind,
            "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string()),
            "codex_warm": session.is_some()
        }),
    );
    if fake_codex_enabled() {
        let prompt = job
            .input
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let reply = format!(
            "Panda Bridge fixture reply: {}",
            if prompt.is_empty() { "ok" } else { prompt }
        );
        post_event_best_effort(
            credentials,
            &job.id,
            "text_delta",
            json!({ "delta": reply }),
        );
        return Ok(
            json!({ "ok": true, "reply": reply, "fixture": true, "cloud_openai_credentials": false }),
        );
    }
    let policy = effective_job_policy(job)?;
    let cwd = policy.cwd.clone();
    let should_restart = session.as_ref().map(|item| item.cwd != cwd).unwrap_or(true);
    if should_restart {
        *session = Some(CodexWarmSession::start(cwd.clone())?);
    }
    match session
        .as_mut()
        .ok_or("codex warm session unavailable")?
        .run_job(credentials, job)
    {
        Ok(mut result) => {
            if let Value::Object(ref mut map) = result {
                map.insert("codex_warm".to_string(), Value::Bool(true));
            }
            Ok(result)
        }
        Err(error) => {
            *session = None;
            Err(error)
        }
    }
}

fn validate_local_job_authorization(
    credentials: &Credentials,
    job: &BridgeJob,
) -> Result<(), String> {
    let grant = credentials_products(credentials)
        .into_iter()
        .find(|item| item.id == job.product_id)
        .ok_or_else(|| format!("product_not_authorized_locally: {}", job.product_id))?;
    if !grant.capabilities.is_empty() && !grant.capabilities.iter().any(|item| item == &job.kind) {
        return Err(format!(
            "capability_not_authorized_locally: {}:{}",
            job.product_id, job.kind
        ));
    }
    if grant.policy.get("version").and_then(Value::as_str) != Some("AUTH-SCOPE-v1") {
        return Err("authorization_scope_missing_locally".to_string());
    }
    validate_authorization_scope(&grant.policy, job)?;
    let _ = effective_job_policy(job)?;
    Ok(())
}

fn validate_authorization_scope(scope: &Value, job: &BridgeJob) -> Result<(), String> {
    if let Some(capabilities) = scope.get("capabilities").and_then(Value::as_array) {
        if !capabilities.is_empty()
            && !capabilities
                .iter()
                .filter_map(Value::as_str)
                .any(|item| item == job.kind)
        {
            return Err(format!(
                "capability_not_authorized_locally: {}:{}",
                job.product_id, job.kind
            ));
        }
    }

    let workspace_ref = job.workspace_ref.as_deref().unwrap_or("default");
    if !authorization_scope_allows_workspace(scope, workspace_ref) {
        return Err(format!("workspace_not_allowed_locally: {workspace_ref}"));
    }

    let requested_sandbox =
        policy_string(&job.policy, "sandbox").unwrap_or_else(|| "workspace-write".to_string());
    let sandbox_floor =
        policy_string(scope, "sandbox_floor").unwrap_or_else(|| "workspace-write".to_string());
    if !authorization_scope_allows_sandbox(&sandbox_floor, &requested_sandbox) {
        return Err(format!("sandbox_not_allowed_locally: {requested_sandbox}"));
    }

    let requested_approval =
        policy_string(&job.policy, "approvalPolicy").unwrap_or_else(|| "on-request".to_string());
    let approval_floor =
        policy_string(scope, "approval_policy_floor").unwrap_or_else(|| "on-request".to_string());
    let allow_never = scope
        .get("allow_approval_never")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !authorization_scope_allows_approval(&approval_floor, &requested_approval, allow_never) {
        return Err(format!(
            "approval_policy_not_allowed_locally: {requested_approval}"
        ));
    }

    let has_developer_instructions = policy_string(&job.policy, "developerInstructions").is_some();
    let allow_developer_instructions = scope
        .get("allow_developer_instructions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if has_developer_instructions && !allow_developer_instructions {
        return Err("developer_instructions_not_allowed_locally".to_string());
    }

    Ok(())
}

fn authorization_scope_allows_workspace(scope: &Value, workspace_ref: &str) -> bool {
    let roots = match scope.get("workspace_roots").and_then(Value::as_array) {
        Some(items) => items,
        None => return workspace_ref == "default",
    };
    roots.iter().any(|item| {
        item.get("id")
            .and_then(Value::as_str)
            .map(|id| id == workspace_ref)
            .unwrap_or(false)
    })
}

fn authorization_scope_allows_sandbox(floor: &str, requested: &str) -> bool {
    match floor {
        "read-only" => requested == "read-only",
        "workspace-write" => requested == "workspace-write" || requested == "read-only",
        _ => false,
    }
}

fn authorization_scope_allows_approval(floor: &str, requested: &str, allow_never: bool) -> bool {
    if requested == "never" {
        return allow_never;
    }
    let rank = |value: &str| match value {
        "untrusted" => Some(0),
        "on-request" => Some(1),
        "on-failure" => Some(2),
        _ => None,
    };
    match (rank(floor), rank(requested)) {
        (Some(floor_rank), Some(requested_rank)) => requested_rank <= floor_rank,
        _ => false,
    }
}

fn local_policy_denial_result(job: &BridgeJob, error: &str) -> Value {
    let (denied, reason) = local_policy_denial(error);
    json!({
        "ok": false,
        "error": "local_policy_denied",
        "denied": denied,
        "reason": reason,
        "product_id": job.product_id.clone(),
        "kind": job.kind.clone(),
        "cloud_openai_credentials": false
    })
}

fn local_policy_denial_event(job: &BridgeJob, error: &str) -> Value {
    let (denied, reason) = local_policy_denial(error);
    json!({
        "denied": denied,
        "reason": reason,
        "product_id": job.product_id.clone(),
        "kind": job.kind.clone(),
        "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string())
    })
}

fn local_policy_denial(error: &str) -> (&'static str, &'static str) {
    if error.starts_with("product_not_authorized_locally") {
        ("product", "product_not_authorized_locally")
    } else if error.starts_with("capability_not_authorized_locally") {
        ("capability", "capability_not_authorized_locally")
    } else if error.starts_with("authorization_scope_missing_locally") {
        ("authorization", "authorization_scope_missing_locally")
    } else if error.starts_with("workspace_not_allowed_locally") {
        ("workspace_ref", "workspace_not_allowed_locally")
    } else if error.starts_with("cwd_not_allowed_locally") {
        ("cwd", "cwd_not_allowed_locally")
    } else if error.starts_with("sandbox_not_allowed_locally") {
        ("sandbox", "sandbox_not_allowed_locally")
    } else if error.starts_with("approval_policy_not_allowed_locally") {
        ("approvalPolicy", "approval_policy_not_allowed_locally")
    } else if error.starts_with("developer_instructions_not_allowed_locally") {
        (
            "developerInstructions",
            "developer_instructions_not_allowed_locally",
        )
    } else {
        ("unknown", "local_policy_denied")
    }
}

fn effective_policy_event(job: &BridgeJob, policy: &LocalJobPolicy) -> Value {
    json!({
        "requested_policy": job.policy.clone(),
        "effective_policy": {
            "cwd": redact_local_path(&policy.cwd),
            "sandbox": policy.sandbox,
            "approvalPolicy": policy.approval_policy,
            "developerInstructions": policy.developer_instructions.as_ref().map(|_| "[present]")
        },
        "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string()),
        "product_id": job.product_id.clone(),
        "kind": job.kind.clone()
    })
}

impl CodexWarmSession {
    fn start(cwd: String) -> Result<Self, String> {
        let (child, stdin, rx, err_rx) = spawn_codex_app_server(&cwd)?;
        let mut session = Self {
            child,
            stdin,
            rx,
            err_rx,
            next_id: 0,
            cwd,
        };
        let timeout = Duration::from_millis(90_000);
        session.send_request_raw(
            "initialize",
            json!({
                "clientInfo": { "name": "panda_bridge_desktop_lite", "title": "Panda Bridge Desktop", "version": VERSION },
                "capabilities": {}
            }),
            timeout,
        )?;
        send_notify(&mut session.stdin, "initialized", json!({}))?;
        let account =
            session.send_request_raw("account/read", json!({ "refreshToken": false }), timeout)?;
        if account.get("account").is_none() {
            return Err(
                "local Codex is not signed in; run codex login on this machine".to_string(),
            );
        }
        let _ = session.send_request_raw("account/rateLimits/read", json!({}), timeout);
        Ok(session)
    }

    fn run_job(&mut self, credentials: &Credentials, job: &BridgeJob) -> Result<Value, String> {
        let prompt = job
            .input
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if prompt.is_empty() {
            return Ok(
                json!({ "ok": false, "error": "missing prompt", "cloud_openai_credentials": false }),
            );
        }
        let timeout = Duration::from_millis(
            job.policy
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(240_000),
        );
        let policy = effective_job_policy(job)?;
        let mut final_text = String::new();
        let thread_result = send_request(
            &mut self.stdin,
            &self.rx,
            &mut self.next_id,
            "thread/start",
            thread_start_params(&policy, job),
            timeout,
            credentials,
            job,
            &mut final_text,
        )?;
        let thread_id = thread_result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or("codex app-server did not return a thread id")?
            .to_string();
        let _ = send_request(
            &mut self.stdin,
            &self.rx,
            &mut self.next_id,
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
                "approvalPolicy": policy.approval_policy
            }),
            timeout,
            credentials,
            job,
            &mut final_text,
        )?;
        wait_for_turn(&self.rx, timeout, credentials, job, &mut final_text)?;
        let reply = final_text.trim().to_string();
        if reply.is_empty() {
            let stderr_tail = self.err_rx.try_recv().unwrap_or_default();
            return Ok(
                json!({ "ok": false, "error": format!("codex completed without assistant text; {stderr_tail}"), "cloud_openai_credentials": false }),
            );
        }
        Ok(json!({
            "ok": true,
            "reply": reply,
            "codex_thread_id": thread_id,
            "cloud_openai_credentials": false
        }))
    }

    fn send_request_raw(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        writeln!(
            self.stdin,
            "{}",
            json!({ "method": method, "id": id, "params": params })
        )
        .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;
        let started = Instant::now();
        while started.elapsed() < timeout {
            let message = match self.rx.recv_timeout(Duration::from_millis(500)) {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "codex app-server closed while waiting for {method}"
                    ));
                }
            };
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(format!("codex {method} error: {error}"));
                }
                return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
            }
        }
        Err(format!("codex app-server timeout waiting for {method}"))
    }
}

impl Drop for CodexWarmSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn spawn_codex_app_server(
    cwd: &str,
) -> Result<
    (
        Child,
        ChildStdin,
        mpsc::Receiver<Value>,
        mpsc::Receiver<String>,
    ),
    String,
> {
    let bin = codex_bin();
    let mut command = Command::new(&bin);
    command
        .args(["app-server", "--stdio"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    add_resolved_command_dir_to_path(&mut command, &bin);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start codex app-server at {bin}: {error}"))?;
    let stdin = child.stdin.take().ok_or("codex stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("codex stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("codex stderr unavailable")?;
    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let _ = tx.send(value);
            }
        }
    });
    let (err_tx, err_rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut last = String::new();
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            last.push_str(&line);
            last.push('\n');
            if last.len() > 1200 {
                let keep_from = last.len().saturating_sub(1200);
                last = last[keep_from..].to_string();
            }
        }
        let _ = err_tx.send(last);
    });
    Ok((child, stdin, rx, err_rx))
}

fn run_codex_app_server(credentials: &Credentials, job: &BridgeJob) -> Result<Value, String> {
    let prompt = job
        .input
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if prompt.is_empty() {
        return Ok(
            json!({ "ok": false, "error": "missing prompt", "cloud_openai_credentials": false }),
        );
    }
    let policy = effective_job_policy(job)?;
    let cwd = policy.cwd.clone();
    let timeout = Duration::from_millis(
        job.policy
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(240_000),
    );
    let (mut child, mut stdin, rx, err_rx) = spawn_codex_app_server(&cwd)?;

    let result = (|| -> Result<Value, String> {
        let mut next_id = 0_u64;
        let mut final_text = String::new();
        send_request(
            &mut stdin,
            &rx,
            &mut next_id,
            "initialize",
            json!({
                "clientInfo": { "name": "panda_bridge_desktop_lite", "title": "Panda Bridge Desktop", "version": VERSION },
                "capabilities": {}
            }),
            timeout,
            credentials,
            job,
            &mut final_text,
        )?;
        send_notify(&mut stdin, "initialized", json!({}))?;
        let account = send_request(
            &mut stdin,
            &rx,
            &mut next_id,
            "account/read",
            json!({ "refreshToken": false }),
            timeout,
            credentials,
            job,
            &mut final_text,
        )?;
        if account.get("account").is_none() {
            return Ok(
                json!({ "ok": false, "error": "local Codex is not signed in; run codex login on this machine", "cloud_openai_credentials": false }),
            );
        }
        let _rate_limits = send_request(
            &mut stdin,
            &rx,
            &mut next_id,
            "account/rateLimits/read",
            json!({}),
            timeout,
            credentials,
            job,
            &mut final_text,
        )
        .ok();
        let thread_result = send_request(
            &mut stdin,
            &rx,
            &mut next_id,
            "thread/start",
            thread_start_params(&policy, job),
            timeout,
            credentials,
            job,
            &mut final_text,
        )?;
        let thread_id = thread_result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or("codex app-server did not return a thread id")?
            .to_string();
        let _ = send_request(
            &mut stdin,
            &rx,
            &mut next_id,
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
                "approvalPolicy": policy.approval_policy
            }),
            timeout,
            credentials,
            job,
            &mut final_text,
        )?;
        wait_for_turn(&rx, timeout, credentials, job, &mut final_text)?;
        let reply = final_text.trim().to_string();
        if reply.is_empty() {
            let stderr_tail = err_rx.try_recv().unwrap_or_default();
            return Ok(
                json!({ "ok": false, "error": format!("codex completed without assistant text; {stderr_tail}"), "cloud_openai_credentials": false }),
            );
        }
        Ok(json!({
            "ok": true,
            "reply": reply,
            "codex_thread_id": thread_id,
            "cloud_openai_credentials": false
        }))
    })();
    let _ = child.kill();
    result
}

fn send_request(
    stdin: &mut impl Write,
    rx: &mpsc::Receiver<Value>,
    next_id: &mut u64,
    method: &str,
    params: Value,
    timeout: Duration,
    credentials: &Credentials,
    job: &BridgeJob,
    final_text: &mut String,
) -> Result<Value, String> {
    *next_id += 1;
    let id = *next_id;
    writeln!(
        stdin,
        "{}",
        json!({ "method": method, "id": id, "params": params })
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    let started = Instant::now();
    while started.elapsed() < timeout {
        let message = match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "codex app-server closed while waiting for {method}"
                ))
            }
        };
        handle_codex_event(credentials, job, &message, final_text)?;
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            if let Some(error) = message.get("error") {
                return Err(format!("codex {method} error: {error}"));
            }
            return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
        }
    }
    Err(format!("codex app-server timeout waiting for {method}"))
}

fn send_notify(stdin: &mut impl Write, method: &str, params: Value) -> Result<(), String> {
    writeln!(stdin, "{}", json!({ "method": method, "params": params }))
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn wait_for_turn(
    rx: &mpsc::Receiver<Value>,
    timeout: Duration,
    credentials: &Credentials,
    job: &BridgeJob,
    final_text: &mut String,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let message = match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("codex app-server closed before turn completed".to_string())
            }
        };
        handle_codex_event(credentials, job, &message, final_text)?;
        if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
            return Ok(());
        }
    }
    Err("codex app-server turn timed out".to_string())
}

fn handle_codex_event(
    credentials: &Credentials,
    job: &BridgeJob,
    message: &Value,
    final_text: &mut String,
) -> Result<(), String> {
    if let Some(delta) = assistant_text_from_message(message) {
        if !delta.is_empty() {
            final_text.push_str(&delta);
            post_event_best_effort(
                credentials,
                &job.id,
                "text_delta",
                json!({ "delta": delta }),
            );
        }
    } else if let Some(method) = message.get("method").and_then(Value::as_str) {
        post_event_best_effort(
            credentials,
            &job.id,
            "app_server_event",
            json!({ "method": method }),
        );
    }
    Ok(())
}

fn assistant_text_from_message(message: &Value) -> Option<String> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").unwrap_or(&Value::Null);
    if method.contains("delta") {
        let delta = params
            .get("delta")
            .or_else(|| params.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        return if delta.is_empty() { None } else { Some(delta) };
    }
    if method.contains("agentMessage") || method.contains("assistant") || method == "turn/completed"
    {
        let text = collect_assistant_text(params).trim().to_string();
        return if text.is_empty() { None } else { Some(text) };
    }
    None
}

fn collect_assistant_text(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .map(collect_assistant_text)
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(map) => {
            let marker = ["role", "type", "kind"]
                .iter()
                .filter_map(|key| map.get(*key).and_then(Value::as_str))
                .any(|value| {
                    let lower = value.to_ascii_lowercase();
                    lower.contains("assistant")
                        || lower.contains("agentmessage")
                        || lower.contains("agent_message")
                });
            if marker {
                collect_text_fields(value)
            } else {
                map.values()
                    .map(collect_assistant_text)
                    .collect::<Vec<_>>()
                    .join("")
            }
        }
        _ => String::new(),
    }
}

fn collect_text_fields(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(collect_text_fields)
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(map) => {
            let mut out = String::new();
            for (key, child) in map {
                if matches!(
                    key.as_str(),
                    "id" | "role" | "type" | "kind" | "status" | "created_at"
                ) {
                    continue;
                }
                out.push_str(&collect_text_fields(child));
            }
            out
        }
        _ => String::new(),
    }
}

fn post_event(
    credentials: &Credentials,
    job_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<(), String> {
    let url = format!(
        "{}/v1/connectors/jobs/{}/events",
        credentials.api_base,
        urlencoding::encode(job_id)
    );
    let _: Value = post_json_with_install(
        &url,
        &json!({ "type": event_type, "payload": payload }),
        Some(&credentials.device_token),
        credentials.install_id.as_deref(),
    )?;
    Ok(())
}

fn post_event_best_effort(
    credentials: &Credentials,
    job_id: &str,
    event_type: &str,
    payload: Value,
) {
    let _ = post_event(credentials, job_id, event_type, payload);
}

fn get_json<T: for<'de> Deserialize<'de>>(url: &str, bearer: Option<&str>) -> Result<T, String> {
    get_json_with_install(url, bearer, None)
}

fn get_json_with_install<T: for<'de> Deserialize<'de>>(
    url: &str,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    let mut request = http_client().get(url);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(id) = install_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-panda-bridge-install-id", id);
    }
    parse_response(request.send().map_err(|error| error.to_string())?)
}

fn post_json_with_install<T: for<'de> Deserialize<'de>>(
    url: &str,
    body: &Value,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    let mut request = http_client()
        .post(url)
        .header("x-panda-bridge-local-client", "desktop")
        .json(body);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(id) = install_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-panda-bridge-install-id", id);
    }
    parse_response(request.send().map_err(|error| error.to_string())?)
}

fn delete_json_with_install<T: for<'de> Deserialize<'de>>(
    url: &str,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    let mut request = http_client().delete(url);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(id) = install_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-panda-bridge-install-id", id);
    }
    parse_response(request.send().map_err(|error| error.to_string())?)
}

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .pool_idle_timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn parse_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
) -> Result<T, String> {
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("invalid JSON response: {error}; body={text}"))
}

fn capabilities() -> Value {
    json!({
        "runtime": ["codex.chat", "codex.run"],
        "reserved_runtime": ["codex.rpc"],
        "app_server": true,
        "desktop": "tao-wry",
        "platform": env::consts::OS
    })
}

fn local_state() -> Value {
    json!({
        "platform": env::consts::OS,
        "commands": { "codex": command_exists(&codex_bin()) },
        "workspaces": { "default": workspace_path("default") }
    })
}

fn local_policy_preview() -> Value {
    json!({
        "default_workspace": workspace_path("default"),
        "extra_workspace_roots_env": "PANDA_BRIDGE_ALLOWED_WORKSPACE_ROOTS",
        "sandbox_allowed": ["workspace-write", "read-only"],
        "sandbox_denied": ["danger-full-access"],
        "approval_default": "on-request",
        "approval_never": if env_flag("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER") { "allowed_by_local_env" } else { "denied_by_default" },
        "developer_instructions": if env_flag("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS") { "allowed_by_local_env" } else { "denied_by_default" }
    })
}

fn local_authorization_policy(preview: Option<&IntentPreview>) -> Value {
    json!({
        "version": "AUTH-SCOPE-v1",
        "product_id": preview.map(|item| item.product_id.clone()),
        "source_origin": preview.map(|item| item.cloud_origin.clone()),
        "capabilities": preview.map(|item| item.capabilities.clone()).unwrap_or_default(),
        "workspace_roots": [{
            "id": "default",
            "path_display": redact_local_path(&workspace_path("default"))
        }],
        "sandbox_floor": "workspace-write",
        "approval_policy_floor": "on-request",
        "allow_approval_never": env_flag("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER"),
        "allow_developer_instructions": env_flag("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS"),
        "display": {
            "workspace": redact_local_path(&workspace_path("default")),
            "sandbox": "workspace-write or stricter",
            "approval": "on-request or stricter",
            "developer_instructions": if env_flag("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS") { "allowed by local env" } else { "denied by default" }
        }
    })
}

fn save_credentials(credentials: &Credentials) -> Result<(), String> {
    let text = serde_json::to_string_pretty(credentials).map_err(|error| error.to_string())?;
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        write_file(Path::new(&path), &text)?;
        return Ok(());
    }
    let _ = keychain_entry()
        .and_then(|entry| entry.set_password(&text).map_err(|error| error.to_string()));
    write_file(&fallback_credentials_path()?, &text)?;
    Ok(())
}

fn load_credentials() -> Result<Credentials, String> {
    let text = load_credentials_text()?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn load_credentials_text() -> Result<String, String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    if !env_flag("PANDA_BRIDGE_SKIP_KEYCHAIN") {
        if let Ok(text) = keychain_entry()
            .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    let fallback_path = fallback_credentials_path()?;
    if let Ok(text) = fs::read_to_string(&fallback_path) {
        return Ok(text);
    }
    Err(format!(
        "fallback state unavailable: {}",
        fallback_path.display()
    ))
}

fn delete_credentials() -> Result<(), String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let _ = fs::remove_file(fallback_credentials_path()?);
    thread::spawn(move || {
        let _ = keychain_entry()
            .and_then(|entry| entry.delete_credential().map_err(|error| error.to_string()));
    });
    Ok(())
}

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|error| error.to_string())
}

fn write_connector_state(credentials: &Credentials) -> Result<(), String> {
    if env::var("PANDA_BRIDGE_DESKTOP_STATE").is_ok() {
        return Ok(());
    }
    let path = fallback_credentials_path()?;
    write_file(
        &path,
        &serde_json::to_string_pretty(credentials).map_err(|error| error.to_string())?,
    )
}

fn fallback_credentials_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("desktop-connector.json"))
}

fn write_file(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn state_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".panda-bridge"))
}

fn home_dir() -> Result<PathBuf, String> {
    if let Ok(home) = env::var("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        return Ok(PathBuf::from(profile));
    }
    Err("cannot determine home directory".to_string())
}

fn workspace_path(workspace_ref: &str) -> String {
    let key = format!(
        "PANDA_BRIDGE_WORKSPACE_{}",
        workspace_ref
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    if let Ok(path) = env::var(key) {
        return path;
    }
    if let Ok(path) = env::var("PANDA_BRIDGE_CODEX_CWD") {
        return path;
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

fn effective_job_policy(job: &BridgeJob) -> Result<LocalJobPolicy, String> {
    let requested_cwd = policy_string(&job.policy, "cwd")
        .or_else(|| policy_string(&job.policy, "workspace_path"))
        .or_else(|| workspace_ref_cwd(job.workspace_ref.as_deref()))
        .ok_or_else(|| {
            format!(
                "workspace_not_allowed_locally: {}",
                job.workspace_ref.as_deref().unwrap_or("default")
            )
        })?;
    let cwd = allowed_cwd(&requested_cwd)?;
    let sandbox = allowed_sandbox(
        policy_string(&job.policy, "sandbox")
            .unwrap_or_else(|| "workspace-write".to_string())
            .as_str(),
    )?;
    let approval_policy = allowed_approval_policy(
        policy_string(&job.policy, "approvalPolicy")
            .unwrap_or_else(|| "on-request".to_string())
            .as_str(),
    )?;
    let developer_instructions = policy_string(&job.policy, "developerInstructions");
    if developer_instructions.is_some() && !env_flag("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS") {
        return Err("developer_instructions_not_allowed_locally".to_string());
    }
    Ok(LocalJobPolicy {
        cwd,
        sandbox,
        approval_policy,
        developer_instructions,
    })
}

fn workspace_ref_cwd(workspace_ref: Option<&str>) -> Option<String> {
    let value = workspace_ref.unwrap_or("default").trim();
    if value.is_empty() || value == "default" {
        return Some(workspace_path("default"));
    }
    let key = format!(
        "PANDA_BRIDGE_WORKSPACE_{}",
        value
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    env::var(key).ok()
}

fn allowed_cwd(requested: &str) -> Result<String, String> {
    let cwd = canonical_path(Path::new(requested))
        .map_err(|error| format!("cwd_not_allowed_locally: {requested}: {error}"))?;
    let roots = allowed_workspace_roots();
    if roots.iter().any(|root| cwd.starts_with(root)) {
        return Ok(cwd.to_string_lossy().to_string());
    }
    Err(format!(
        "cwd_not_allowed_locally: {}",
        cwd.to_string_lossy()
    ))
}

fn allowed_workspace_roots() -> Vec<PathBuf> {
    let mut roots = vec![workspace_path("default")];
    if let Ok(extra) = env::var("PANDA_BRIDGE_ALLOWED_WORKSPACE_ROOTS") {
        roots.extend(
            extra
                .split([',', ';'])
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned),
        );
    }
    roots
        .into_iter()
        .filter_map(|path| canonical_path(Path::new(&path)).ok())
        .collect()
}

fn canonical_path(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| error.to_string())
}

fn allowed_sandbox(value: &str) -> Result<String, String> {
    match value {
        "workspace-write" | "read-only" => Ok(value.to_string()),
        "danger-full-access" => Err("sandbox_not_allowed_locally: danger-full-access".to_string()),
        other => Err(format!("sandbox_not_allowed_locally: {other}")),
    }
}

fn allowed_approval_policy(value: &str) -> Result<String, String> {
    match value {
        "on-request" | "on-failure" | "untrusted" => Ok(value.to_string()),
        "never" if env_flag("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER") => Ok(value.to_string()),
        "never" => Err("approval_policy_not_allowed_locally: never".to_string()),
        other => Err(format!("approval_policy_not_allowed_locally: {other}")),
    }
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn thread_start_params(policy: &LocalJobPolicy, job: &BridgeJob) -> Value {
    let mut params = json!({
        "cwd": policy.cwd.clone(),
        "sandbox": policy.sandbox.clone(),
        "approvalPolicy": policy.approval_policy.clone(),
        "ephemeral": job.input.get("ephemeral").and_then(Value::as_bool).unwrap_or(true)
    });
    if let Some(instructions) = policy.developer_instructions.clone() {
        if let Some(map) = params.as_object_mut() {
            map.insert(
                "developerInstructions".to_string(),
                Value::String(instructions),
            );
        }
    }
    params
}

fn policy_string(policy: &Value, key: &str) -> Option<String> {
    policy
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn command_exists(command: &str) -> bool {
    if command.contains('/') || command.contains('\\') {
        return executable_exists(Path::new(command));
    }
    let paths = env::var("PATH").unwrap_or_default();
    #[cfg(windows)]
    {
        paths
            .split(';')
            .any(|path| windows_command_candidate_exists(Path::new(path), command))
    }
    #[cfg(not(windows))]
    {
        paths
            .split(':')
            .any(|path| executable_exists(&Path::new(path).join(command)))
    }
}

fn executable_exists(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(windows)]
fn windows_command_candidate_exists(dir: &Path, command: &str) -> bool {
    if executable_exists(&dir.join(command)) {
        return true;
    }
    if Path::new(command).extension().is_some() {
        return false;
    }
    env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .any(|ext| executable_exists(&dir.join(format!("{command}{ext}"))))
}

fn codex_bin() -> String {
    if let Ok(explicit) = env::var("PANDA_BRIDGE_CODEX_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    resolve_codex_bin().unwrap_or_else(|| "codex".to_string())
}

fn resolve_codex_bin() -> Option<String> {
    resolve_command_on_path("codex").or_else(|| {
        common_codex_paths()
            .into_iter()
            .find(|path| executable_exists(path))
            .map(|path| path.to_string_lossy().to_string())
    })
}

fn resolve_command_on_path(command: &str) -> Option<String> {
    if command.contains('/') || command.contains('\\') {
        let path = Path::new(command);
        return executable_exists(path).then(|| path.to_string_lossy().to_string());
    }
    #[cfg(windows)]
    {
        env::var("PATH")
            .unwrap_or_default()
            .split(';')
            .find_map(|path| windows_command_candidate_path(Path::new(path), command))
    }
    #[cfg(not(windows))]
    {
        env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .map(|path| Path::new(path).join(command))
            .find(|path| executable_exists(path))
            .map(|path| path.to_string_lossy().to_string())
    }
}

#[cfg(windows)]
fn windows_command_candidate_path(dir: &Path, command: &str) -> Option<String> {
    let direct = dir.join(command);
    if executable_exists(&direct) {
        return Some(direct.to_string_lossy().to_string());
    }
    if Path::new(command).extension().is_some() {
        return None;
    }
    env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(|ext| dir.join(format!("{command}{ext}")))
        .find(|path| executable_exists(path))
        .map(|path| path.to_string_lossy().to_string())
}

fn common_codex_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    if let Ok(home) = home_dir() {
        paths.push(home.join(".local/bin/codex"));
        paths.push(home.join(".cargo/bin/codex"));
        paths.push(home.join(".npm-global/bin/codex"));
    }
    paths
}

fn add_resolved_command_dir_to_path(command: &mut Command, bin: &str) {
    let path = Path::new(bin);
    let Some(parent) = path.parent() else {
        return;
    };
    if parent.as_os_str().is_empty() {
        return;
    }
    let Some(parent_text) = parent.to_str() else {
        return;
    };
    let separator = if cfg!(windows) { ';' } else { ':' };
    let current = env::var("PATH").unwrap_or_default();
    if current.split(separator).any(|item| item == parent_text) {
        return;
    }
    let next_path = if current.is_empty() {
        parent_text.to_string()
    } else {
        format!("{parent_text}{separator}{current}")
    };
    command.env("PATH", next_path);
}

fn fake_codex_enabled() -> bool {
    env::var("PANDA_BRIDGE_FAKE_CODEX")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn open_url(url: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).status()
    } else {
        Command::new("xdg-open").arg(url).status()
    }
    .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open url failed: {status}"))
    }
}

fn clean_api(api: &str) -> Result<String, String> {
    let trimmed = api.trim().trim_end_matches('/');
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("invalid Bridge API URL: {error}"))?;
    let host = parsed.host_str().unwrap_or("");
    let allowed = matches!(
        host,
        "api.bridge.otherline.cc"
            | "bridge.otherline.cc"
            | "api.bridge.test.example"
            | "bridge.test.example"
            | "127.0.0.1"
            | "localhost"
            | "::1"
    );
    if !allowed {
        return Err(format!("Bridge API host is not allowed: {host}"));
    }
    if parsed.scheme() != "https" && host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Err("Bridge API must use https".to_string());
    }
    Ok(trimmed.to_string())
}

fn display_account(user: &ConnectUser) -> String {
    user.email
        .clone()
        .or_else(|| user.display_name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Panda Account".to_string())
}

fn device_name() -> String {
    format!("Panda Bridge {}", env::consts::OS)
}

fn now_string() -> String {
    // Stable and parseable without adding a time formatting dependency.
    format!("unix:{}", unix_seconds())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn required_param(params: &Value, key: &str) -> Result<String, String> {
    string_param(params, key).ok_or_else(|| format!("missing {key}"))
}

fn string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn initial_deep_links() -> Vec<String> {
    let mut links = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg.starts_with("panda-bridge://") {
            links.push(arg);
        } else if arg == "--connect-url" {
            if let Some(url) = args.next() {
                links.push(url);
            }
        } else if arg == "--intent" {
            if let Some(intent) = args.next() {
                let api =
                    env::var("PANDA_BRIDGE_API_BASE").unwrap_or_else(|_| DEFAULT_API.to_string());
                links.push(format!(
                    "panda-bridge://connect?intent={}&api={}",
                    urlencoding::encode(&intent),
                    urlencoding::encode(&api)
                ));
            }
        }
    }
    links
}

fn run_headless_if_requested() -> Option<i32> {
    let mut args = env::args().skip(1);
    let command = args.next()?;
    if !command.starts_with("headless-") {
        return None;
    }
    let result = match command.as_str() {
        "headless-status" => {
            serde_json::to_value(status(&new_app_state())).map_err(|error| error.to_string())
        }
        "headless-connect" => {
            if !env_flag("PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT") {
                return Some(print_error(
                    "headless-connect requires PANDA_BRIDGE_ALLOW_HEADLESS_CONNECT=1",
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

fn print_error(error: &str) -> i32 {
    eprintln!("{error}");
    1
}

fn arg_map(args: Vec<String>) -> std::collections::BTreeMap<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn test_job(policy: Value) -> BridgeJob {
        BridgeJob {
            id: "job_1".to_string(),
            product_id: "panda-chat".to_string(),
            kind: "codex.chat".to_string(),
            workspace_ref: Some("default".to_string()),
            input: json!({ "prompt": "hello" }),
            policy,
        }
    }

    fn test_credentials(capabilities: Vec<&str>) -> Credentials {
        Credentials {
            api_base: "http://local.test".to_string(),
            device_id: "dev_1".to_string(),
            device_name: "Device".to_string(),
            device_token: "pbd_test".to_string(),
            install_id: None,
            account_id: Some("user_1".to_string()),
            account_display: Some("user@example.test".to_string()),
            product_id: Some("panda-chat".to_string()),
            product_name: Some("Panda Chat".to_string()),
            cloud_origin: Some("http://local.test".to_string()),
            authorized_products: vec![ProductGrant {
                id: "panda-chat".to_string(),
                name: "Panda Chat".to_string(),
                origin: Some("http://local.test".to_string()),
                capabilities: capabilities.into_iter().map(ToOwned::to_owned).collect(),
                policy: test_auth_scope(),
                accounts: Vec::new(),
                authorized_at: now_string(),
            }],
            device_token_expires_at: None,
            device_token_rotated_at_unix: None,
            install_identity_bound: None,
            connections: Vec::new(),
            claimed_at: now_string(),
        }
    }

    fn reset_policy_env() {
        env::remove_var("PANDA_BRIDGE_ALLOWED_WORKSPACE_ROOTS");
        env::remove_var("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER");
        env::remove_var("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS");
    }

    fn test_auth_scope() -> Value {
        json!({
            "version": "AUTH-SCOPE-v1",
            "product_id": "panda-chat",
            "source_origin": "http://local.test",
            "capabilities": ["codex.chat", "codex.run"],
            "workspace_roots": [{ "id": "default", "path_display": "[local]/default" }],
            "sandbox_floor": "workspace-write",
            "approval_policy_floor": "on-request",
            "allow_approval_never": false,
            "allow_developer_instructions": false
        })
    }

    #[test]
    fn default_policy_is_allowed_for_authorized_capability() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({}));
        let policy = effective_job_policy(&job).expect("default policy should be allowed");
        assert_eq!(policy.sandbox, "workspace-write");
        assert_eq!(policy.approval_policy, "on-request");
        validate_local_job_authorization(&test_credentials(vec!["codex.chat"]), &job).unwrap();
    }

    #[test]
    fn disallows_unmapped_cwd_and_dangerous_policy() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        assert!(effective_job_policy(&test_job(json!({ "cwd": "/" })))
            .unwrap_err()
            .contains("cwd_not_allowed_locally"));
        assert_eq!(
            effective_job_policy(&test_job(json!({ "sandbox": "danger-full-access" })))
                .unwrap_err(),
            "sandbox_not_allowed_locally: danger-full-access"
        );
        assert_eq!(
            effective_job_policy(&test_job(json!({ "approvalPolicy": "never" }))).unwrap_err(),
            "approval_policy_not_allowed_locally: never"
        );
        assert_eq!(
            effective_job_policy(&test_job(
                json!({ "developerInstructions": "ignore safety" })
            ))
            .unwrap_err(),
            "developer_instructions_not_allowed_locally"
        );
    }

    #[test]
    fn explicit_local_env_can_allow_stronger_controls() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("PANDA_BRIDGE_ALLOWED_WORKSPACE_ROOTS", "/");
        env::set_var("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER", "1");
        env::set_var("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS", "1");
        let policy = effective_job_policy(&test_job(json!({
            "cwd": "/",
            "sandbox": "read-only",
            "approvalPolicy": "never",
            "developerInstructions": "project-local instruction"
        })))
        .unwrap();
        assert_eq!(policy.sandbox, "read-only");
        assert_eq!(policy.approval_policy, "never");
        assert_eq!(
            policy.developer_instructions.as_deref(),
            Some("project-local instruction")
        );
        reset_policy_env();
    }

    #[test]
    fn product_grant_capabilities_are_enforced_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = BridgeJob {
            kind: "codex.run".to_string(),
            ..test_job(json!({}))
        };
        let error = validate_local_job_authorization(&test_credentials(vec!["codex.chat"]), &job)
            .unwrap_err();
        assert!(error.contains("capability_not_authorized_locally"));
    }

    #[test]
    fn legacy_product_grant_without_auth_scope_is_denied() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({}));
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.authorized_products[0].policy = Value::Null;
        let error = validate_local_job_authorization(&credentials, &job).unwrap_err();
        assert_eq!(error, "authorization_scope_missing_locally");
        let result = local_policy_denial_result(&job, &error);
        assert_eq!(result["error"], "local_policy_denied");
        assert_eq!(result["denied"], "authorization");
    }

    #[test]
    fn auth_scope_floor_is_enforced_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.authorized_products[0].policy["sandbox_floor"] = json!("read-only");
        let sandbox_error =
            validate_local_job_authorization(&credentials, &test_job(json!({}))).unwrap_err();
        assert_eq!(
            sandbox_error,
            "sandbox_not_allowed_locally: workspace-write"
        );

        let mut never_credentials = test_credentials(vec!["codex.chat"]);
        env::set_var("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER", "1");
        let never_error = validate_local_job_authorization(
            &never_credentials,
            &test_job(json!({ "approvalPolicy": "never" })),
        )
        .unwrap_err();
        assert_eq!(never_error, "approval_policy_not_allowed_locally: never");
        never_credentials.authorized_products[0].policy["allow_approval_never"] = json!(true);
        validate_local_job_authorization(
            &never_credentials,
            &test_job(json!({ "approvalPolicy": "never" })),
        )
        .unwrap();
        reset_policy_env();
    }

    #[test]
    fn local_policy_denial_result_is_stable_and_redacted() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({ "cwd": "/" }));
        let error = effective_job_policy(&job).unwrap_err();
        let result = local_policy_denial_result(&job, &error);
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"], "local_policy_denied");
        assert_eq!(result["denied"], "cwd");
        assert_eq!(result["reason"], "cwd_not_allowed_locally");
        assert!(!result.to_string().contains("/Users/"));
        assert!(!result.to_string().contains("cwd_not_allowed_locally: /"));
    }

    #[test]
    fn builtin_screenshot_renderer_writes_png_file() {
        let path = env::temp_dir().join(format!(
            "panda-bridge-builtin-screenshot-{}.png",
            next_event_seq()
        ));
        let snapshot = json!({
            "ok": true,
            "status": {
                "device_id": "dev_1",
                "device_name": "Verifier Desktop",
                "worker_running": false,
                "realtime_connected": false,
                "codex_available": true,
                "authorized_products": [{
                    "id": "panda-chat",
                    "name": "Panda Chat",
                    "origin": "http://chat.local.test",
                    "capabilities": ["codex.chat", "codex.run"],
                    "accounts": [{ "id": "user_1", "device_id": "dev_1", "authorized_at": "unix:1" }]
                }]
            },
            "events": []
        });
        write_builtin_screenshot(&path, &snapshot).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(bytes.len() > 1024);
        let _ = fs::remove_file(path);
    }
}
