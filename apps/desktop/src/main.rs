use keyring::Entry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
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
    env::var("PANDA_BRIDGE_VERIFY")
        .map(|value| value == "1")
        .unwrap_or(false)
        || env::args().any(|arg| arg == "--verify-control")
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
        ("GET", "/v1/screenshot") => desktop_screenshot().unwrap_or_else(
            |error| json!({ "ok": false, "error": error, "snapshot": verify_snapshot(&state) }),
        ),
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
        "start_worker" => start_worker(state, proxy)?,
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
        "claim_intent" => {
            let api = string_param(params, "api").unwrap_or_else(|| DEFAULT_API.to_string());
            let intent = required_param(params, "intent")?;
            let device_name = string_param(params, "device_name").unwrap_or_else(device_name);
            let claim = claim_intent(&api, &intent, &device_name)?;
            let _ = start_worker(state, proxy);
            serde_json::to_value(claim).map_err(|error| error.to_string())?
        }
        "refresh_status" => {
            serde_json::to_value(status(state)).map_err(|error| error.to_string())?
        }
        other => return Err(format!("unknown verify action: {other}")),
    };
    push_event(state, "verify_action", json!({ "action": action }));
    Ok(result)
}

fn verify_snapshot(state: &AppState) -> Value {
    json!({
        "ok": true,
        "status": status(state),
        "events": state_events(state)
    })
}

fn desktop_screenshot() -> Result<Value, String> {
    let dir = state_dir()?.join("verify-screenshots");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(format!("desktop-{}.png", next_event_seq()));
    if cfg!(target_os = "macos") {
        let _ = Command::new("osascript")
            .args(["-e", "tell application \"Panda Bridge\" to activate"])
            .status();
        thread::sleep(Duration::from_millis(700));
        let status = Command::new("screencapture")
            .args(["-x", path.to_string_lossy().as_ref()])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(json!({ "ok": true, "path": path.to_string_lossy() }));
        }
        return Err(format!("screencapture failed: {status}"));
    }
    Err("desktop screenshot is only implemented on macOS".to_string())
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
    Ok(IntentPreview {
        product_id,
        product_name,
        cloud_origin,
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
    let install_id = credentials_install_id(existing.as_ref());
    let body = json!({
        "device_name": if device_name.trim().is_empty() { "Panda Bridge Desktop" } else { device_name.trim() },
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state(),
        "install_id": install_id.clone()
    });
    let url = format!(
        "{}/v1/connect-intents/{}/claim",
        api_base,
        urlencoding::encode(intent)
    );
    let bearer = existing
        .as_ref()
        .map(|credentials| credentials.device_token.as_str());
    let payload: ClaimResponse = post_json_with_install(&url, &body, bearer, Some(&install_id))?;
    let account_display = payload.account.as_ref().map(display_account).or_else(|| {
        existing
            .as_ref()
            .and_then(|item| item.account_display.clone())
    });
    let account_id = payload
        .account
        .as_ref()
        .and_then(|account| account.id.clone())
        .or_else(|| existing.as_ref().and_then(|item| item.account_id.clone()));
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
    let authorized_products = merge_authorized_products(
        existing.as_ref(),
        product_id.clone(),
        product_name.clone(),
        cloud_origin.clone(),
        product_capabilities,
    );
    let credentials = Credentials {
        api_base,
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
        claimed_at: now_string(),
    };
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

fn start_worker(state: &AppState, proxy: EventLoopProxy<UserEvent>) -> Result<Value, String> {
    prepare_credentials_for_worker(state, &proxy)?;
    if state.worker_running.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "ok": true, "message": "worker already running" }));
    }
    let running = state.worker_running.clone();
    let realtime_running = state.worker_running.clone();
    let realtime_connected = state.realtime_connected.clone();
    let fallback_connected = state.realtime_connected.clone();
    let realtime_state = state.clone();
    let fallback_state = state.clone();
    let realtime_proxy = proxy.clone();
    let fallback_proxy = proxy.clone();
    thread::spawn(move || {
        while running.load(Ordering::SeqCst) {
            let event_payload = match load_credentials().and_then(|credentials| {
                heartbeat(&credentials).and_then(|_| {
                    if fallback_connected.load(Ordering::SeqCst) {
                        Ok(0)
                    } else {
                        poll_once(&credentials)
                    }
                })
            }) {
                Ok(count) => {
                    json!({ "message": format!("worker tick ok, jobs={count}"), "job_count": count })
                }
                Err(error) => {
                    json!({ "message": format!("worker tick failed: {error}"), "error": error })
                }
            };
            let message = event_payload
                .get("message")
                .and_then(Value::as_str)
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
    thread::spawn(move || {
        while realtime_running.load(Ordering::SeqCst) {
            let result = load_credentials().and_then(|credentials| {
                run_realtime_worker(
                    &credentials,
                    &realtime_running,
                    &realtime_connected,
                    &realtime_state,
                    &realtime_proxy,
                )
            });
            realtime_connected.store(false, Ordering::SeqCst);
            if let Err(error) = result {
                push_event(
                    &realtime_state,
                    "realtime_disconnected",
                    json!({ "error": error }),
                );
                let _ = realtime_proxy.send_event(UserEvent::UiEvent(json!({
                    "type": "event",
                    "event": "log",
                    "message": "realtime disconnected; polling fallback active"
                })));
            }
            thread::sleep(Duration::from_millis(2000));
        }
    });
    push_event(
        state,
        "worker_started",
        json!({ "message": "worker started" }),
    );
    Ok(json!({ "ok": true, "message": "worker started" }))
}

fn credentials_products(credentials: &Credentials) -> Vec<ProductGrant> {
    if !credentials.authorized_products.is_empty() {
        return credentials.authorized_products.clone();
    }
    match (&credentials.product_id, &credentials.product_name) {
        (Some(id), Some(name)) => vec![ProductGrant {
            id: id.clone(),
            name: name.clone(),
            origin: credentials.cloud_origin.clone(),
            capabilities: Vec::new(),
            authorized_at: credentials.claimed_at.clone(),
        }],
        _ => Vec::new(),
    }
}

fn merge_authorized_products(
    existing: Option<&Credentials>,
    product_id: Option<String>,
    product_name: Option<String>,
    cloud_origin: Option<String>,
    capabilities: Vec<String>,
) -> Vec<ProductGrant> {
    let mut products = existing.map(credentials_products).unwrap_or_default();
    if let Some(id) = product_id {
        let name = product_name.unwrap_or_else(|| id.clone());
        let grant = ProductGrant {
            id: id.clone(),
            name,
            origin: cloud_origin,
            capabilities,
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
    if credentials
        .install_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(credentials);
    }
    credentials.install_id = Some(credentials_install_id(None));
    save_credentials(&credentials)?;
    write_connector_state(&credentials)?;
    Ok(credentials)
}

fn credentials_install_id(existing: Option<&Credentials>) -> String {
    if let Some(value) = existing
        .and_then(|credentials| credentials.install_id.clone())
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

fn prepare_credentials_for_worker(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<Credentials, String> {
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    if !device_token_rotation_due(&credentials) {
        return Ok(credentials);
    }
    match rotate_device_token(&credentials) {
        Ok(next) => {
            push_event(
                state,
                "device_token_rotated",
                json!({
                    "device_id": next.device_id,
                    "token_expires_at": next.device_token_expires_at,
                    "install_identity_bound": next.install_identity_bound
                }),
            );
            let _ = proxy.send_event(UserEvent::UiEvent(json!({
                "type": "event",
                "event": "refresh"
            })));
            Ok(next)
        }
        Err(error) => {
            push_event(
                state,
                "device_token_rotation_failed",
                json!({
                    "device_id": credentials.device_id,
                    "error": error
                }),
            );
            Ok(credentials)
        }
    }
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
    save_credentials(&next)?;
    write_connector_state(&next)?;
    Ok(next)
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
        json!({ "device_id": credentials.device_id, "transport": "websocket" }),
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
                                json!({ "job_id": job.id, "kind": job.kind }),
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
        return Ok(json!({ "ok": false, "error": error, "cloud_openai_credentials": false }));
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
        return Ok(json!({ "ok": false, "error": error, "cloud_openai_credentials": false }));
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
    let cwd = job_cwd(job);
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
    credentials_products(credentials)
        .into_iter()
        .find(|item| item.id == job.product_id)
        .ok_or_else(|| format!("product_not_authorized_locally: {}", job.product_id))?;
    Ok(())
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
        let mut final_text = String::new();
        let thread_result = send_request(
            &mut self.stdin,
            &self.rx,
            &mut self.next_id,
            "thread/start",
            thread_start_params(self.cwd.clone(), job),
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
                "approvalPolicy": codex_approval_policy(job)
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
    let cwd = job_cwd(job);
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
            thread_start_params(cwd, job),
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
                "approvalPolicy": codex_approval_policy(job)
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
    let mut request = http_client().post(url).json(body);
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

fn save_credentials(credentials: &Credentials) -> Result<(), String> {
    let text = serde_json::to_string_pretty(credentials).map_err(|error| error.to_string())?;
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        write_file(Path::new(&path), &text)?;
        return Ok(());
    }
    match keychain_entry()?.set_password(&text) {
        Ok(()) => {
            write_file(&fallback_credentials_path()?, &text)?;
            Ok(())
        }
        Err(_error) => {
            write_file(&fallback_credentials_path()?, &text)?;
            Ok(())
        }
    }
}

fn load_credentials() -> Result<Credentials, String> {
    let text = load_credentials_text()?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn load_credentials_text() -> Result<String, String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    match keychain_entry().and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
    {
        Ok(text) => Ok(text),
        Err(keychain_error) => {
            fs::read_to_string(fallback_credentials_path()?).map_err(|file_error| {
                format!("keychain: {keychain_error}; fallback state: {file_error}")
            })
        }
    }
}

fn delete_credentials() -> Result<(), String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let _ = fs::remove_file(fallback_credentials_path()?);
    match keychain_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
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
    }
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
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

fn job_cwd(job: &BridgeJob) -> String {
    if let Some(path) = job
        .workspace_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
    {
        return path.to_string();
    }
    policy_string(&job.policy, "cwd")
        .or_else(|| policy_string(&job.policy, "workspace_path"))
        .unwrap_or_else(|| workspace_path("default"))
}

fn codex_sandbox(job: &BridgeJob) -> String {
    policy_string(&job.policy, "sandbox").unwrap_or_else(|| "workspace-write".to_string())
}

fn codex_approval_policy(job: &BridgeJob) -> String {
    policy_string(&job.policy, "approvalPolicy").unwrap_or_else(|| "on-request".to_string())
}

fn thread_start_params(cwd: String, job: &BridgeJob) -> Value {
    let mut params = json!({
        "cwd": cwd,
        "sandbox": codex_sandbox(job),
        "approvalPolicy": codex_approval_policy(job),
        "ephemeral": job.input.get("ephemeral").and_then(Value::as_bool).unwrap_or(true)
    });
    if let Some(instructions) = policy_string(&job.policy, "developerInstructions") {
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
        "api.bridge.otherline.cc" | "bridge.otherline.cc" | "127.0.0.1" | "localhost" | "::1"
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
    // Enough for audit/debug; Cloud remains source of truth for server time.
    format!("{:?}", std::time::SystemTime::now())
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
        "headless-status" => serde_json::to_value(status(&AppState {
            worker_running: Arc::new(AtomicBool::new(false)),
            realtime_connected: Arc::new(AtomicBool::new(false)),
            events: Arc::new(Mutex::new(Vec::new())),
        }))
        .map_err(|error| error.to_string()),
        "headless-connect" => {
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
        "headless-poll" => load_credentials()
            .and_then(|credentials| heartbeat(&credentials).and_then(|_| poll_once(&credentials)))
            .map(|count| json!({ "ok": true, "count": count })),
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
