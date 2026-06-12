use keyring::Entry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::{HashMap, HashSet},
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
use unicode_normalization::UnicodeNormalization;
#[cfg(windows)]
use window_vibrancy::{apply_acrylic, apply_mica};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
use wry::WebViewBuilder;

mod captoken;
mod connector;

// Single process-wide lock serializing every test that mutates process-global
// env vars. Tests in different modules (main.rs, connector::fs, ...) share ONE
// lock so they never run concurrently and clobber each other's env (e.g.
// PANDA_BRIDGE_FS_ALLOWED_ROOTS / PANDA_BRIDGE_CAPTOKEN_*).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use connector::{
    codex::CodexConnector,
    data::{DataConnector, MemKv, ProductSqliteKv, DEFAULT_MAX_KEY_BYTES, DEFAULT_MAX_VALUE_BYTES},
    fs::FsConnector,
    registry::ConnectorRegistry,
    sandbox::{self, NetPolicy, ResourceLimits, SandboxProfileKind, SandboxSpec},
    shell::ShellConnector,
    ConnectorDanger, ConnectorError, ConnectorEvent, ExecCtx, GrantedBoundary,
};

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
    device_online: Option<bool>,
    #[serde(default)]
    device_last_seen_at: Option<String>,
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
    #[serde(default = "default_authorization_state")]
    authorization: AuthorizationState,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    policy: Value,
    #[serde(default = "default_authorization_epoch")]
    epoch: u64,
    #[serde(default)]
    accounts: Vec<ProductGrantAccount>,
    #[serde(default, skip_serializing_if = "LocalRootBindings::is_empty")]
    local_roots: LocalRootBindings,
    authorized_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct LocalRootBindings {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    fs_roots: HashMap<String, LocalRootBinding>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    shell_cwd: HashMap<String, LocalRootBinding>,
}

impl LocalRootBindings {
    fn is_empty(&self) -> bool {
        self.fs_roots.is_empty() && self.shell_cwd.is_empty()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct LocalRootBinding {
    real_path: String,
    path_display: String,
    bound_at: String,
    bound_device_id: String,
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
    #[serde(default = "default_authorization_state")]
    authorized: AuthorizationState,
    #[serde(default)]
    connected: Option<bool>,
    #[serde(default)]
    connection: Option<String>,
    #[serde(default)]
    authorized_at: String,
    #[serde(default)]
    devices: Vec<ProductGrantDevice>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProductGrantDevice {
    id: String,
    name: String,
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    last_seen_at: Option<String>,
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
    products: Vec<DesktopProductStatus>,
    settings: DesktopSettings,
    worker_running: bool,
    realtime_connected: bool,
    codex_available: bool,
}

#[derive(Debug, Serialize, Clone)]
struct DesktopProductStatus {
    id: String,
    name: String,
    origin: String,
    web_url: String,
    accounts: Vec<DesktopAccountStatus>,
    connected: bool,
    connection: String,
}

#[derive(Debug, Serialize, Clone)]
struct DesktopAccountStatus {
    id: Option<String>,
    email: String,
    product_id: Option<String>,
    device_id: String,
    authorized: AuthorizationState,
    connected: bool,
    connection: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DesktopSettings {
    #[serde(default = "default_launch_at_login")]
    launch_at_login: bool,
    #[serde(default = "default_appearance")]
    appearance: String,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default = "default_api_base")]
    api_base: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AuthorizationState {
    Active,
    Paused,
}

impl AuthorizationState {
    fn is_active(self) -> bool {
        self == AuthorizationState::Active
    }
}

fn default_authorization_state() -> AuthorizationState {
    AuthorizationState::Active
}

fn default_authorization_epoch() -> u64 {
    1
}

fn default_launch_at_login() -> bool {
    true
}

fn default_appearance() -> String {
    "auto".to_string()
}

fn default_language() -> String {
    "auto".to_string()
}

fn default_api_base() -> String {
    DEFAULT_API.to_string()
}

#[derive(Debug, Serialize)]
struct IntentPreview {
    product_id: String,
    product_name: String,
    cloud_origin: String,
    capabilities: Vec<String>,
    local_policy: Value,
    local_root_state: Value,
    device_name: String,
    user_id: Option<String>,
    user_display_name: String,
    expires_at: String,
    confirmation_mode: String,
    scope_widening: bool,
    scope_diff: Value,
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
    #[serde(default)]
    policy: Value,
    #[serde(default)]
    source_origin: Option<String>,
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
    #[serde(default)]
    devices: Option<Vec<CloudDevice>>,
}

#[derive(Debug, Deserialize)]
struct AuthorizationInfo {
    #[serde(default)]
    policy: Value,
    #[serde(default)]
    source_origin: Option<String>,
    #[serde(default = "default_authorization_epoch")]
    epoch: u64,
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

#[derive(Debug, Deserialize, Clone)]
struct CloudDevice {
    id: String,
    #[serde(default, alias = "device_name")]
    name: Option<String>,
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    last_seen_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HeartbeatResponse {
    #[serde(default)]
    devices: Option<Vec<CloudDevice>>,
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
    authorization: Option<RealtimeAuthorization>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RealtimeAuthorization {
    product_id: String,
    #[serde(default)]
    status: Option<AuthorizationState>,
    #[serde(default = "default_authorization_epoch")]
    epoch: u64,
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
    #[serde(default)]
    request_key: Option<String>,
    #[serde(default)]
    cap_token: Option<String>,
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
    spec_fingerprint: String,
    product_id: String,
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
    if connector::fs::is_fs_write_helper_invocation() {
        std::process::exit(connector::fs::run_fs_write_helper());
    }
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
        .with_title("Panda Bridge")
        .with_inner_size(LogicalSize::new(760.0, 500.0))
        .with_min_inner_size(LogicalSize::new(760.0, 500.0))
        .with_resizable(false);
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
                if running_from_app_bundle() {
                    let settings = load_settings_with_api(DEFAULT_API);
                    if let Err(error) = apply_launch_at_login(settings.launch_at_login) {
                        eprintln!("[launch-at-login] {error}");
                    }
                }
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
            let url = open_web_url(params);
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
        "toggle_authorization" | "click_toggle_authorization" => {
            let product_id = product_param(params)?;
            let account = required_param(params, "account")?;
            toggle_authorization_for_state(state, proxy.clone(), &product_id, &account)?
        }
        "remove_authorization" | "revoke_authorization" | "click_revoke_authorization" => {
            let product_id = product_param(params)?;
            let account_id =
                string_param(params, "account_id").or_else(|| string_param(params, "account"));
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

fn product_display_origin(product: &Value) -> &str {
    product
        .get("policy")
        .and_then(|policy| policy.get("source_origin"))
        .and_then(Value::as_str)
        .or_else(|| product.get("origin").and_then(Value::as_str))
        .unwrap_or("unknown")
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
    if message.command == "pick_local_root" {
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
        return;
    }
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
        "pick_local_root" => pick_local_root(params),
        "settings" => {
            let api_base = load_credentials()
                .map(|credentials| credentials.api_base)
                .unwrap_or_else(|_| DEFAULT_API.to_string());
            serde_json::to_value(load_settings_with_api(&api_base))
                .map_err(|error| error.to_string())
        }
        "update_settings" => {
            serde_json::to_value(update_settings(params)?).map_err(|error| error.to_string())
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

fn status(state: &AppState) -> DesktopStatus {
    let credentials = load_credentials().ok();
    let products = desktop_products(credentials.as_ref(), state);
    let settings = load_settings_with_api(
        credentials
            .as_ref()
            .map(|item| item.api_base.as_str())
            .unwrap_or(DEFAULT_API),
    );
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
        products,
        settings,
        worker_running: state.worker_running.load(Ordering::SeqCst),
        realtime_connected: state.realtime_connected.load(Ordering::SeqCst),
        codex_available: command_exists(&codex_bin()),
    }
}

#[derive(Clone, Copy)]
struct KnownProduct {
    id: &'static str,
    name: &'static str,
    origin: &'static str,
    web_url: &'static str,
}

fn known_products() -> [KnownProduct; 2] {
    [
        KnownProduct {
            id: "pandart",
            name: "Pandart",
            origin: "pandart.cc",
            web_url: "https://pandart.cc",
        },
        KnownProduct {
            id: "otherline",
            name: "Otherline",
            origin: "otherline.cc",
            web_url: "https://otherline.cc",
        },
    ]
}

fn desktop_products(
    credentials: Option<&Credentials>,
    state: &AppState,
) -> Vec<DesktopProductStatus> {
    let worker_running = state.worker_running.load(Ordering::SeqCst);
    let realtime_connected = state.realtime_connected.load(Ordering::SeqCst);
    let connections = credentials.map(credentials_connections).unwrap_or_default();
    known_products()
        .into_iter()
        .map(|product| {
            let mut accounts: Vec<DesktopAccountStatus> = Vec::new();
            for connection in &connections {
                for grant in connection_products(connection)
                    .into_iter()
                    .filter(|grant| product_matches_known(grant, product))
                {
                    upsert_desktop_account_status(
                        &mut accounts,
                        connection,
                        &grant,
                        worker_running,
                        realtime_connected,
                    );
                }
            }
            accounts.sort_by(|left, right| left.email.cmp(&right.email));
            let connected = accounts.iter().any(|account| account.connected);
            let reconnecting = accounts.iter().any(|account| {
                account.authorized.is_active() && account.connection == "reconnecting"
            });
            DesktopProductStatus {
                id: product.id.to_string(),
                name: product.name.to_string(),
                origin: product.origin.to_string(),
                web_url: product.web_url.to_string(),
                accounts,
                connected,
                connection: if connected {
                    "connected".to_string()
                } else if reconnecting {
                    "reconnecting".to_string()
                } else {
                    "offline".to_string()
                },
            }
        })
        .collect()
}

fn upsert_desktop_account_status(
    accounts: &mut Vec<DesktopAccountStatus>,
    connection: &Credentials,
    grant: &ProductGrant,
    worker_running: bool,
    realtime_connected: bool,
) {
    let email = connection
        .account_display
        .clone()
        .or_else(|| connection.account_id.clone())
        .unwrap_or_else(|| "Panda Account".to_string());
    let connected = grant.authorization.is_active() && worker_running && realtime_connected;
    let connection_state = if connected {
        "connected"
    } else if grant.authorization.is_active() {
        "reconnecting"
    } else {
        "disabled"
    };
    let key = connection
        .account_id
        .as_deref()
        .unwrap_or(email.as_str())
        .to_string();
    if let Some(existing) = accounts.iter_mut().find(|item| {
        item.id.as_deref() == Some(key.as_str())
            || item.email == email
            || connection
                .account_display
                .as_deref()
                .map(|display| item.email == display)
                .unwrap_or(false)
    }) {
        if grant.authorization.is_active() {
            existing.authorized = AuthorizationState::Active;
        }
        if connected {
            existing.connected = true;
            existing.connection = "connected".to_string();
        } else if !existing.connected && existing.authorized.is_active() {
            existing.connection = "reconnecting".to_string();
        }
        if existing.product_id.is_none() {
            existing.product_id = Some(grant.id.clone());
        }
        return;
    }
    accounts.push(DesktopAccountStatus {
        id: connection.account_id.clone().or(Some(key)),
        email,
        product_id: Some(grant.id.clone()),
        device_id: connection.device_id.clone(),
        authorized: grant.authorization,
        connected,
        connection: connection_state.to_string(),
    });
}

fn product_matches_known(product: &ProductGrant, known: KnownProduct) -> bool {
    known_product_id_for_grant(product) == known.id
}

fn known_product_id_for_grant(product: &ProductGrant) -> &'static str {
    let haystack = format!(
        "{} {} {}",
        product.id,
        product.name,
        product.origin.clone().unwrap_or_default()
    )
    .to_ascii_lowercase();
    if haystack.contains("pandart") || haystack.contains("pandaart") {
        "pandart"
    } else {
        "otherline"
    }
}

fn product_matches_target(product: &ProductGrant, target: &str) -> bool {
    let normalized_target = normalize_product_key(target);
    if normalized_target.is_empty() {
        return false;
    }
    normalize_product_key(&product.id) == normalized_target
        || normalize_product_key(&product.name) == normalized_target
        || known_product_id_for_grant(product) == normalized_target
}

fn normalize_product_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn connection_matches_account(connection: &Credentials, account: Option<&str>) -> bool {
    let Some(account) = account.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    connection.account_id.as_deref() == Some(account)
        || connection.account_display.as_deref() == Some(account)
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
        .source_origin
        .clone()
        .or_else(|| {
            payload
                .connect_intent
                .product
                .as_ref()
                .and_then(|product| product.origin.clone())
        })
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
    let capabilities =
        authorization_policy_capabilities(&local_policy).unwrap_or(product_capabilities);
    let local_credentials = load_credentials().ok();
    let existing_grant = payload
        .connect_intent
        .user
        .as_ref()
        .and_then(|user| user.id.as_deref())
        .and_then(|user_id| {
            local_credentials.as_ref().and_then(|credentials| {
                existing_grant_for_intent_from_credentials(
                    credentials,
                    &api_base,
                    user_id,
                    &product_id,
                )
            })
        });
    let scope_diff = existing_grant
        .as_ref()
        .map(|grant| scope_diff(&grant.policy, &local_policy))
        .unwrap_or_else(|| scope_diff(&Value::Null, &local_policy));
    let scope_widening = existing_grant
        .as_ref()
        .map(|grant| is_scope_widening(&grant.policy, &local_policy))
        .unwrap_or(true);
    let confirmation_mode =
        confirmation_mode_for_existing_grant(existing_grant.as_ref(), scope_widening);
    let current_device_id = local_credentials
        .as_ref()
        .map(|credentials| credentials.device_id.as_str())
        .unwrap_or("");
    let local_root_state =
        local_root_state_for_preview(&local_policy, existing_grant.as_ref(), current_device_id);
    Ok(IntentPreview {
        product_id,
        product_name,
        cloud_origin,
        capabilities,
        local_policy,
        local_root_state,
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
        confirmation_mode,
        scope_widening,
        scope_diff,
    })
}

fn existing_grant_for_intent_from_credentials(
    credentials: &Credentials,
    api_base: &str,
    account_id: &str,
    product_id: &str,
) -> Option<ProductGrant> {
    let mut fallback = None;
    for connection in credentials_connections(credentials) {
        if connection.api_base != api_base || connection.account_id.as_deref() != Some(account_id) {
            continue;
        }
        let Some(grant) = connection_products(&connection)
            .into_iter()
            .find(|grant| grant.id == product_id)
        else {
            continue;
        };
        if !credentials.device_id.trim().is_empty() && connection.device_id == credentials.device_id
        {
            return Some(grant);
        }
        if fallback.is_none() {
            fallback = Some(grant);
        }
    }
    fallback
}

fn is_scope_widening(existing: &Value, requested: &Value) -> bool {
    scope_diff(existing, requested)
        .get("widening")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn confirmation_mode_for_existing_grant(
    existing_grant: Option<&ProductGrant>,
    scope_widening: bool,
) -> String {
    if existing_grant.is_some() && !scope_widening {
        "light".to_string()
    } else {
        "full".to_string()
    }
}

fn local_root_state_for_preview(
    policy: &Value,
    existing_grant: Option<&ProductGrant>,
    current_device_id: &str,
) -> Value {
    let mut fs_state = Map::new();
    for root in declared_fs_roots(policy, "allowed_roots", "allowedRoots") {
        fs_state.insert(
            root.id.clone(),
            local_root_binding_state(
                existing_grant.and_then(|grant| grant.local_roots.fs_roots.get(&root.id)),
                &root.path_display,
                current_device_id,
                Some("read"),
            ),
        );
    }
    for root in declared_fs_roots(policy, "write_roots", "writeRoots") {
        fs_state.insert(
            root.id.clone(),
            local_root_binding_state(
                existing_grant.and_then(|grant| grant.local_roots.fs_roots.get(&root.id)),
                &root.path_display,
                current_device_id,
                Some("write"),
            ),
        );
    }

    let mut shell_state = Map::new();
    if let Some(root) = declared_shell_cwd_root_for_preview(policy) {
        shell_state.insert(
            root.id.clone(),
            local_root_binding_state(
                existing_grant.and_then(|grant| grant.local_roots.shell_cwd.get(&root.id)),
                &root.path_display,
                current_device_id,
                None,
            ),
        );
    }

    json!({
        "fs": fs_state,
        "shell": shell_state
    })
}

fn local_root_binding_state(
    binding: Option<&LocalRootBinding>,
    path_display: &str,
    current_device_id: &str,
    kind: Option<&str>,
) -> Value {
    let bound = binding
        .map(|binding| {
            !current_device_id.trim().is_empty()
                && binding.bound_device_id == current_device_id
                && binding.path_display == path_display
        })
        .unwrap_or(false);
    let mut state = Map::new();
    state.insert("bound".to_string(), json!(bound));
    state.insert(
        "redacted_path".to_string(),
        if bound {
            binding
                .map(|binding| json!(redact_local_path(&binding.real_path)))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );
    if let Some(kind) = kind {
        state.insert("kind".to_string(), json!(kind));
    }
    Value::Object(state)
}

fn declared_shell_cwd_root_for_preview(policy: &Value) -> Option<DeclaredLocalRoot> {
    let shell = policy.pointer("/boundaries/shell")?;
    let root_id = shell
        .get("cwd_root_id")
        .or_else(|| shell.get("cwdRootId"))
        .and_then(Value::as_str)
        .map(trim_nfc_keep_slash_local)
        .filter(|value| !value.is_empty())?;
    declared_shell_cwd_root(policy, &root_id, None)
}

fn scope_diff(existing: &Value, requested: &Value) -> Value {
    let existing_capabilities = policy_string_set(existing, "capabilities");
    let requested_capabilities = policy_string_set(requested, "capabilities");
    let added_capabilities = sorted_difference(&requested_capabilities, &existing_capabilities);

    let existing_workspace_all = policy_allows_all_workspace(existing);
    let requested_workspace_all = policy_allows_all_workspace(requested);
    let existing_workspace_ids = policy_workspace_ids(existing);
    let requested_workspace_ids = policy_workspace_ids(requested);
    let added_workspace_ids = sorted_difference(&requested_workspace_ids, &existing_workspace_ids);
    let workspace_widening = (requested_workspace_all && !existing_workspace_all)
        || (!requested_workspace_all && !existing_workspace_all && !added_workspace_ids.is_empty());

    let existing_sandbox =
        policy_string(existing, "sandbox_floor").unwrap_or_else(|| "workspace-write".to_string());
    let requested_sandbox =
        policy_string(requested, "sandbox_floor").unwrap_or_else(|| "workspace-write".to_string());
    let sandbox_widening = sandbox_rank(&requested_sandbox) > sandbox_rank(&existing_sandbox);

    let existing_approval = policy_string(existing, "approval_policy_floor")
        .unwrap_or_else(|| "on-request".to_string());
    let requested_approval = policy_string(requested, "approval_policy_floor")
        .unwrap_or_else(|| "on-request".to_string());
    let existing_allow_never = existing
        .get("allow_approval_never")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || existing_approval == "never";
    let requested_allow_never = requested
        .get("allow_approval_never")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || requested_approval == "never";
    let approval_widening = approval_rank(&requested_approval) > approval_rank(&existing_approval)
        || (requested_allow_never && !existing_allow_never);

    let existing_dev = existing
        .get("allow_developer_instructions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requested_dev = requested
        .get("allow_developer_instructions")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let developer_instructions_widening = requested_dev && !existing_dev;

    let widening = !added_capabilities.is_empty()
        || workspace_widening
        || sandbox_widening
        || approval_widening
        || developer_instructions_widening;

    json!({
        "widening": widening,
        "capabilities": { "added": added_capabilities },
        "workspace": {
            "added": added_workspace_ids,
            "from_all": existing_workspace_all,
            "to_all": requested_workspace_all,
            "widening": workspace_widening
        },
        "sandbox": {
            "from": existing_sandbox,
            "to": requested_sandbox,
            "widening": sandbox_widening
        },
        "approval": {
            "from": existing_approval,
            "to": requested_approval,
            "from_allow_never": existing_allow_never,
            "to_allow_never": requested_allow_never,
            "widening": approval_widening
        },
        "developer_instructions": {
            "from": existing_dev,
            "to": requested_dev,
            "widening": developer_instructions_widening
        }
    })
}

fn policy_string_set(policy: &Value, key: &str) -> HashSet<String> {
    policy
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn policy_workspace_ids(policy: &Value) -> HashSet<String> {
    policy
        .get("workspace_roots")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|item| !item.is_empty() && *item != "all" && *item != "*")
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn policy_allows_all_workspace(policy: &Value) -> bool {
    policy
        .get("workspace_roots")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(root_allows_all_workspaces))
        .unwrap_or(false)
}

fn sorted_difference(left: &HashSet<String>, right: &HashSet<String>) -> Vec<String> {
    let mut out = left.difference(right).cloned().collect::<Vec<_>>();
    out.sort();
    out
}

fn sandbox_rank(value: &str) -> i32 {
    match value {
        "read-only" => 0,
        "workspace-write" => 1,
        "danger-full-access" => 2,
        _ => 3,
    }
}

fn approval_rank(value: &str) -> i32 {
    match value {
        "untrusted" => 0,
        "on-request" => 1,
        "on-failure" => 2,
        "never" => 3,
        _ => 4,
    }
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
        .authorization
        .as_ref()
        .and_then(|authorization| authorization.source_origin.clone())
        .or_else(|| {
            payload.authorization.as_ref().and_then(|authorization| {
                authorization
                    .policy
                    .get("source_origin")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
        })
        .or_else(|| {
            payload
                .product
                .as_ref()
                .and_then(|product| product.origin.clone())
        });
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
    let authorization_epoch = payload
        .authorization
        .as_ref()
        .map(|authorization| authorization.epoch)
        .unwrap_or(1);
    let grant_capabilities =
        authorization_policy_capabilities(&authorization_policy).unwrap_or(product_capabilities);
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
        grant_capabilities,
        authorization_policy,
        authorization_epoch,
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
        device_online: cloud_device_online(&payload.devices, &payload.device.id),
        device_last_seen_at: cloud_device_last_seen_at(&payload.devices, &payload.device.id),
        connections: Vec::new(),
        claimed_at: now_string(),
    };
    let mut connections = existing_connections;
    upsert_connection(&mut connections, connection.clone());
    apply_cloud_devices_to_connections(
        &mut connections,
        &api_base,
        account_id.as_deref(),
        payload.devices.as_deref(),
    );
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
        authorized_products: public_product_grants(&authorized_products),
    })
}

fn toggle_authorization(product_id: &str, account: &str) -> Result<Value, String> {
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

fn apply_authorization_epoch_bump(
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

fn toggle_authorization_for_state(
    state: &AppState,
    proxy: EventLoopProxy<UserEvent>,
    product_id: &str,
    account: &str,
) -> Result<Value, String> {
    let payload = toggle_authorization(product_id, account)?;
    if authorized_connections(&load_credentials()?).is_empty() {
        state.worker_running.store(false, Ordering::SeqCst);
        state.realtime_connected.store(false, Ordering::SeqCst);
    } else {
        let _ = start_worker(state, proxy);
    }
    Ok(payload)
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

fn revoke_authorization_for_state(
    state: &AppState,
    product_id: &str,
    account_id: Option<&str>,
    device_id: Option<&str>,
) -> Result<Value, String> {
    let payload = revoke_authorization(product_id, account_id, device_id)?;
    if load_credentials()
        .map(|credentials| authorized_connections(&credentials).is_empty())
        .unwrap_or(true)
    {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalRootDomain {
    FsRead,
    FsWrite,
    ShellCwd,
}

impl LocalRootDomain {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "fs_read" => Some(Self::FsRead),
            "fs_write" => Some(Self::FsWrite),
            "shell_cwd" => Some(Self::ShellCwd),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeclaredLocalRoot {
    id: String,
    path_display: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalRootSafety {
    Allowed,
    WarnBroad,
    DeniedSensitive,
}

fn pick_local_root(params: &Value) -> Result<Value, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Select local folder")
        .pick_folder();
    let Some(path) = picked else {
        return Ok(json!({ "cancelled": true }));
    };
    bind_local_root_path(params, &path)
}

fn bind_local_root_path(params: &Value, selected_path: &Path) -> Result<Value, String> {
    let product_id = product_param(params)?;
    let account = required_param(params, "account")?;
    let domain = LocalRootDomain::parse(&required_param(params, "domain")?)
        .ok_or_else(|| "unknown_root_domain".to_string())?;
    let root_id = normalize_local_root_id(domain, &required_param(params, "root_id")?);
    let requested_path_display = string_param(params, "path_display").unwrap_or_default();
    let canonical = sandbox::canonical_existing_path(selected_path)
        .map_err(|_| "path_not_found_locally".to_string())?;
    if !canonical.is_dir() {
        return Err("path_not_directory".to_string());
    }
    match classify_local_root_path(&canonical) {
        LocalRootSafety::DeniedSensitive => return Err("root_denied_sensitive".to_string()),
        LocalRootSafety::WarnBroad if !bool_param(params, "confirm") => {
            return Err("root_warn_broad".to_string())
        }
        LocalRootSafety::Allowed | LocalRootSafety::WarnBroad => {}
    }

    let binding = upsert_local_root_binding(
        &product_id,
        &account,
        domain,
        &root_id,
        &requested_path_display,
        &canonical,
    )?;
    Ok(json!({
        "root_id": root_id,
        "path_display": binding.path_display,
        "redacted_real_path": redact_local_path(&binding.real_path)
    }))
}

fn bind_local_root_headless(
    map: &std::collections::BTreeMap<String, String>,
) -> Result<Value, String> {
    let product_id = map
        .get("product-id")
        .cloned()
        .ok_or_else(|| "missing --product-id".to_string())?;
    let root_id_raw = map
        .get("root-id")
        .cloned()
        .ok_or_else(|| "missing --root-id".to_string())?;
    let domain_raw = map
        .get("domain")
        .cloned()
        .ok_or_else(|| "missing --domain".to_string())?;
    let path = map
        .get("path")
        .cloned()
        .ok_or_else(|| "missing --path".to_string())?;
    let domain =
        LocalRootDomain::parse(&domain_raw).ok_or_else(|| "unknown_root_domain".to_string())?;
    let root_id = normalize_local_root_id(domain, &root_id_raw);
    let credentials = load_credentials()?;
    let mut candidates = credentials_connections(&credentials)
        .into_iter()
        .flat_map(|connection| {
            let preferred = connection.device_id == credentials.device_id;
            let product_id = product_id.clone();
            let root_id = root_id.clone();
            connection_products(&connection)
                .into_iter()
                .filter(move |grant| {
                    grant.authorization.is_active() && product_matches_target(grant, &product_id)
                })
                .filter_map(move |grant| {
                    let declared =
                        declared_local_root_for_policy(&grant.policy, domain, &root_id, None)?;
                    let account = connection
                        .account_id
                        .clone()
                        .or_else(|| connection.account_display.clone())?;
                    Some((preferred, account, declared.path_display))
                })
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.dedup();
    let selected = candidates
        .iter()
        .find(|(preferred, _, _)| *preferred)
        .or_else(|| {
            if candidates.len() == 1 {
                candidates.first()
            } else {
                None
            }
        })
        .ok_or_else(|| {
            if candidates.is_empty() {
                "authorization_not_found".to_string()
            } else {
                "ambiguous_authorization_target".to_string()
            }
        })?;
    let mut params = json!({
        "product_id": product_id,
        "account": selected.1.clone(),
        "domain": domain_raw,
        "root_id": root_id_raw,
        "path_display": selected.2.clone()
    });
    if map
        .get("confirm")
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
    {
        params["confirm"] = json!(true);
    }
    bind_local_root_path(&params, Path::new(&path))
}

fn upsert_local_root_binding(
    product_id: &str,
    account: &str,
    domain: LocalRootDomain,
    root_id: &str,
    requested_path_display: &str,
    canonical: &Path,
) -> Result<LocalRootBinding, String> {
    let credentials = load_credentials()?;
    let mut connections = credentials_connections(&credentials);
    let connection_index =
        local_root_connection_index(&connections, product_id, account, &credentials.device_id)?;
    if connections[connection_index].authorized_products.is_empty() {
        connections[connection_index].authorized_products =
            connection_products(&connections[connection_index]);
    }
    let device_id = connections[connection_index].device_id.clone();
    let grant = connections[connection_index]
        .authorized_products
        .iter_mut()
        .find(|grant| product_matches_target(grant, product_id))
        .ok_or_else(|| "authorization_not_found".to_string())?;
    let declared = declared_local_root_for_policy(
        &grant.policy,
        domain,
        root_id,
        Some(requested_path_display),
    )
    .ok_or_else(|| "unknown_root_id".to_string())?;
    let binding = LocalRootBinding {
        real_path: canonical.to_string_lossy().to_string(),
        path_display: declared.path_display,
        bound_at: now_string(),
        bound_device_id: device_id,
    };
    match domain {
        LocalRootDomain::FsRead | LocalRootDomain::FsWrite => {
            grant
                .local_roots
                .fs_roots
                .insert(declared.id, binding.clone());
        }
        LocalRootDomain::ShellCwd => {
            grant
                .local_roots
                .shell_cwd
                .insert(declared.id, binding.clone());
        }
    }
    let preferred = connections[connection_index].clone();
    let next = credentials_from_connections(connections, Some(&preferred), Some(&credentials));
    save_credentials(&next)?;
    write_connector_state(&next)?;
    Ok(binding)
}

fn local_root_connection_index(
    connections: &[Credentials],
    product_id: &str,
    account: &str,
    preferred_device_id: &str,
) -> Result<usize, String> {
    let matches = connections
        .iter()
        .enumerate()
        .filter(|(_, connection)| {
            connection_matches_account(connection, Some(account))
                && connection_products(connection)
                    .iter()
                    .any(|grant| product_matches_target(grant, product_id))
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.is_empty() {
        return Err("authorization_not_found".to_string());
    }
    if let Some(index) = matches.iter().copied().find(|index| {
        !preferred_device_id.trim().is_empty()
            && connections[*index].device_id == preferred_device_id
    }) {
        return Ok(index);
    }
    if matches.len() == 1 {
        return Ok(matches[0]);
    }
    Err("ambiguous_authorization_target".to_string())
}

fn declared_local_root_for_policy(
    policy: &Value,
    domain: LocalRootDomain,
    root_id: &str,
    fallback_path_display: Option<&str>,
) -> Option<DeclaredLocalRoot> {
    match domain {
        LocalRootDomain::FsRead => declared_fs_roots(policy, "allowed_roots", "allowedRoots")
            .into_iter()
            .find(|root| root.id == root_id),
        LocalRootDomain::FsWrite => declared_fs_roots(policy, "write_roots", "writeRoots")
            .into_iter()
            .find(|root| root.id == root_id),
        LocalRootDomain::ShellCwd => {
            declared_shell_cwd_root(policy, root_id, fallback_path_display)
        }
    }
}

fn declared_fs_roots(policy: &Value, snake_key: &str, camel_key: &str) -> Vec<DeclaredLocalRoot> {
    let fs = policy.pointer("/boundaries/fs").unwrap_or(&Value::Null);
    declared_fs_roots_from_raw(fs, snake_key, camel_key)
}

fn declared_fs_roots_from_raw(
    raw: &Value,
    snake_key: &str,
    camel_key: &str,
) -> Vec<DeclaredLocalRoot> {
    raw.get(snake_key)
        .or_else(|| raw.get(camel_key))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .map(trim_nfc_no_trailing_slash)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("root-{}", index + 1));
            let path_display = item
                .get("path_display")
                .or_else(|| item.get("pathDisplay"))
                .and_then(Value::as_str)
                .map(trim_nfc_no_trailing_slash)
                .filter(|value| !value.is_empty())?;
            Some(DeclaredLocalRoot { id, path_display })
        })
        .collect()
}

fn declared_shell_cwd_root(
    policy: &Value,
    root_id: &str,
    fallback_path_display: Option<&str>,
) -> Option<DeclaredLocalRoot> {
    let shell = policy.pointer("/boundaries/shell").unwrap_or(&Value::Null);
    declared_shell_cwd_root_from_raw(shell, root_id, fallback_path_display)
}

fn declared_shell_cwd_root_from_raw(
    shell: &Value,
    root_id: &str,
    fallback_path_display: Option<&str>,
) -> Option<DeclaredLocalRoot> {
    let id = shell
        .get("cwd_root_id")
        .or_else(|| shell.get("cwdRootId"))
        .and_then(Value::as_str)
        .map(trim_nfc_keep_slash_local)
        .filter(|value| !value.is_empty())?;
    if id != root_id {
        return None;
    }
    let path_display = shell
        .get("cwd_root")
        .or_else(|| shell.get("cwdRoot"))
        .and_then(|value| {
            if value
                .get("id")
                .and_then(Value::as_str)
                .map(trim_nfc_keep_slash_local)
                .as_deref()
                .unwrap_or(root_id)
                != root_id
            {
                return None;
            }
            value
                .get("path_display")
                .or_else(|| value.get("pathDisplay"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            shell
                .get("path_display")
                .or_else(|| shell.get("pathDisplay"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            shell
                .get("cwd_path_display")
                .or_else(|| shell.get("cwdPathDisplay"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            shell
                .get("cwd_root_path_display")
                .or_else(|| shell.get("cwdRootPathDisplay"))
                .and_then(Value::as_str)
        })
        .or(fallback_path_display)
        .map(trim_nfc_keep_slash_local)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| root_id.to_string());
    Some(DeclaredLocalRoot { id, path_display })
}

fn normalize_local_root_id(domain: LocalRootDomain, value: &str) -> String {
    match domain {
        LocalRootDomain::ShellCwd => trim_nfc_keep_slash_local(value),
        LocalRootDomain::FsRead | LocalRootDomain::FsWrite => trim_nfc_no_trailing_slash(value),
    }
}

fn bool_param(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn trim_nfc_no_trailing_slash(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .trim()
        .nfc()
        .collect::<String>()
        .trim_end_matches('/')
        .to_string()
}

fn trim_nfc_keep_slash_local(value: impl AsRef<str>) -> String {
    value.as_ref().trim().nfc().collect::<String>()
}

fn classify_local_root_path(path: &Path) -> LocalRootSafety {
    if local_root_is_denied_sensitive(path) {
        return LocalRootSafety::DeniedSensitive;
    }
    if local_root_is_broad(path) {
        return LocalRootSafety::WarnBroad;
    }
    LocalRootSafety::Allowed
}

pub(crate) fn local_root_is_denied_sensitive(path: &Path) -> bool {
    let canonical = canonical_for_safety(path);
    if canonical.parent().is_none() {
        return true;
    }
    if let Ok(home) = home_dir().map(|path| canonical_for_safety(&path)) {
        if canonical == home {
            return true;
        }
        let home_sensitive = [
            home.join(".ssh"),
            home.join(".aws"),
            home.join(".gnupg"),
            home.join("Library").join("Keychains"),
        ];
        if home_sensitive
            .iter()
            .any(|prefix| path_is_or_under(&canonical, &canonical_for_safety(prefix)))
        {
            return true;
        }
    }
    [
        PathBuf::from("/System"),
        PathBuf::from("/private/etc"),
        PathBuf::from("/Library"),
        PathBuf::from("/etc"),
    ]
    .iter()
    .any(|prefix| path_is_or_under(&canonical, &canonical_for_safety(prefix)))
}

fn local_root_is_broad(path: &Path) -> bool {
    let canonical = canonical_for_safety(path);
    let Ok(home) = home_dir().map(|path| canonical_for_safety(&path)) else {
        return false;
    };
    let mut broad = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
        home.join("Movies"),
        home.join("Music"),
        home.join("Pictures"),
    ];
    if let Some(parent) = home.parent() {
        broad.push(parent.to_path_buf());
    }
    broad
        .iter()
        .any(|prefix| canonical == canonical_for_safety(prefix))
}

fn canonical_for_safety(path: &Path) -> PathBuf {
    sandbox::canonical_existing_path(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_is_or_under(path: &Path, prefix: &Path) -> bool {
    path == prefix || path.starts_with(prefix)
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

fn credentials_products(credentials: &Credentials) -> Vec<ProductGrant> {
    public_product_grants(&aggregate_authorized_products(&credentials_connections(
        credentials,
    )))
}

fn public_product_grants(products: &[ProductGrant]) -> Vec<ProductGrant> {
    products
        .iter()
        .cloned()
        .map(|mut product| {
            product.local_roots = LocalRootBindings::default();
            product
        })
        .collect()
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
            authorization: AuthorizationState::Active,
            capabilities: Vec::new(),
            policy: Value::Null,
            epoch: 1,
            accounts: Vec::new(),
            local_roots: LocalRootBindings::default(),
            authorized_at: credentials.claimed_at.clone(),
        }],
        _ => Vec::new(),
    }
}

fn active_connection_products(credentials: &Credentials) -> Vec<ProductGrant> {
    connection_products(credentials)
        .into_iter()
        .filter(|product| product.authorization.is_active())
        .collect()
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
        .filter(|item| !active_connection_products(item).is_empty())
        .collect()
}

fn aggregate_authorized_products(connections: &[Credentials]) -> Vec<ProductGrant> {
    let mut products: Vec<ProductGrant> = Vec::new();
    for connection in connections {
        for product in connection_products(connection) {
            let device = ProductGrantDevice {
                id: connection.device_id.clone(),
                name: connection.device_name.clone(),
                online: connection.device_online,
                last_seen_at: connection.device_last_seen_at.clone(),
                authorized_at: product.authorized_at.clone(),
            };
            let account = ProductGrantAccount {
                id: connection.account_id.clone(),
                email: connection.account_display.clone(),
                display_name: connection.account_display.clone(),
                device_id: Some(connection.device_id.clone()),
                origin: product
                    .origin
                    .clone()
                    .or_else(|| connection.cloud_origin.clone()),
                authorized: product.authorization,
                connected: connection.device_online,
                connection: Some(
                    if product.authorization.is_active() && connection.device_online == Some(true) {
                        "connected".to_string()
                    } else if product.authorization.is_active() {
                        "reconnecting".to_string()
                    } else {
                        "disabled".to_string()
                    },
                ),
                authorized_at: product.authorized_at.clone(),
                devices: vec![device],
            };
            if let Some(existing) = products.iter_mut().find(|item| item.id == product.id) {
                existing.name = product.name.clone();
                existing.origin = product.origin.clone().or_else(|| existing.origin.clone());
                existing.capabilities = product.capabilities.clone();
                existing.authorized_at = product.authorized_at.clone();
                existing.local_roots = LocalRootBindings::default();
                if let Some(existing_account) = existing
                    .accounts
                    .iter_mut()
                    .find(|item| item.id.as_deref() == connection.account_id.as_deref())
                {
                    if !existing_account
                        .devices
                        .iter()
                        .any(|item| item.id == connection.device_id)
                    {
                        existing_account.devices.push(account.devices[0].clone());
                    }
                    if existing_account.device_id.is_none() {
                        existing_account.device_id = Some(connection.device_id.clone());
                    }
                    if existing_account.email.is_none() {
                        existing_account.email = connection.account_display.clone();
                    }
                    if existing_account.display_name.is_none() {
                        existing_account.display_name = connection.account_display.clone();
                    }
                    if product.authorization.is_active() {
                        existing_account.authorized = AuthorizationState::Active;
                    }
                    if account.connected == Some(true) {
                        existing_account.connected = Some(true);
                        existing_account.connection = Some("connected".to_string());
                    } else if existing_account.connected != Some(true)
                        && existing_account.authorized.is_active()
                    {
                        existing_account.connection = Some("reconnecting".to_string());
                    }
                } else {
                    existing.accounts.push(account);
                }
            } else {
                let mut next = product_without_accounts(product);
                next.local_roots = LocalRootBindings::default();
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
        device_online: primary.device_online,
        device_last_seen_at: primary.device_last_seen_at.clone(),
        connections: sanitized,
        claimed_at: primary.claimed_at.clone(),
    }
}

fn authorized_connections_from_slice(connections: &[Credentials]) -> Vec<Credentials> {
    connections
        .iter()
        .filter(|item| !active_connection_products(item).is_empty())
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
        device_online: None,
        device_last_seen_at: None,
        connections: Vec::new(),
        claimed_at: now_string(),
    }
}

fn connection_key(credentials: &Credentials) -> String {
    if !credentials.device_id.trim().is_empty() {
        return format!("device:{}:{}", credentials.api_base, credentials.device_id);
    }
    if let Some(account_id) = credentials.account_id.as_deref() {
        return format!("account:{}:{}", credentials.api_base, account_id);
    }
    format!(
        "install:{}:{}",
        credentials.api_base,
        credentials.install_id.clone().unwrap_or_default()
    )
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
    epoch: u64,
) -> Vec<ProductGrant> {
    let mut products = existing.map(connection_products).unwrap_or_default();
    if let Some(id) = product_id {
        let name = product_name.unwrap_or_else(|| id.clone());
        let mut grant = ProductGrant {
            id: id.clone(),
            name,
            origin: cloud_origin,
            authorization: AuthorizationState::Active,
            capabilities,
            policy,
            epoch: epoch.max(1),
            accounts: Vec::new(),
            local_roots: LocalRootBindings::default(),
            authorized_at: now_string(),
        };
        if let Some(index) = products.iter().position(|item| item.id == id) {
            grant.local_roots = products[index].local_roots.clone();
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

fn cloud_device_online(devices: &Option<Vec<CloudDevice>>, device_id: &str) -> Option<bool> {
    devices
        .as_ref()
        .and_then(|items| items.iter().find(|item| item.id == device_id))
        .and_then(|item| item.online)
}

fn cloud_device_last_seen_at(
    devices: &Option<Vec<CloudDevice>>,
    device_id: &str,
) -> Option<String> {
    devices
        .as_ref()
        .and_then(|items| items.iter().find(|item| item.id == device_id))
        .and_then(|item| item.last_seen_at.clone())
}

fn apply_cloud_devices_to_connections(
    connections: &mut Vec<Credentials>,
    api_base: &str,
    account_id: Option<&str>,
    devices: Option<&[CloudDevice]>,
) -> bool {
    let Some(devices) = devices else {
        return false;
    };
    let Some(account_id) = account_id else {
        return false;
    };
    let device_ids: HashSet<&str> = devices.iter().map(|item| item.id.as_str()).collect();
    let device_map: HashMap<&str, &CloudDevice> = devices
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let before_len = connections.len();
    connections.retain(|connection| {
        connection.api_base != api_base
            || connection.account_id.as_deref() != Some(account_id)
            || device_ids.contains(connection.device_id.as_str())
    });
    let mut changed = connections.len() != before_len;
    for connection in connections.iter_mut().filter(|connection| {
        connection.api_base == api_base && connection.account_id.as_deref() == Some(account_id)
    }) {
        if let Some(device) = device_map.get(connection.device_id.as_str()) {
            if let Some(name) = device.name.as_ref().filter(|name| !name.trim().is_empty()) {
                if connection.device_name != *name {
                    connection.device_name = name.clone();
                    changed = true;
                }
            }
            if connection.device_online != device.online {
                connection.device_online = device.online;
                changed = true;
            }
            if connection.device_last_seen_at != device.last_seen_at {
                connection.device_last_seen_at = device.last_seen_at.clone();
                changed = true;
            }
        }
    }
    changed
}

fn heartbeat(credentials: &Credentials) -> Result<HeartbeatResponse, String> {
    let install_id = credentials_install_id(Some(credentials));
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state(),
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

fn prepare_connections_for_worker(
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> Result<Vec<Credentials>, String> {
    let credentials = ensure_credentials_install_id(load_credentials()?)?;
    let mut connections = credentials_connections(&credentials);
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

fn heartbeat_interval_ms() -> u64 {
    env::var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000)
}

#[derive(Debug, Clone)]
struct ReconnectBackoff {
    attempt: u32,
    base_ms: u64,
    max_ms: u64,
}

impl ReconnectBackoff {
    fn new() -> Self {
        Self {
            attempt: 0,
            base_ms: realtime_reconnect_base_ms(),
            max_ms: realtime_reconnect_max_ms(),
        }
    }

    fn next_delay_ms(&mut self) -> u64 {
        let delay = reconnect_delay_ms(self.attempt, self.base_ms, self.max_ms);
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    fn reset(&mut self) {
        self.attempt = 0;
    }
}

fn reconnect_delay_ms(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let shift = attempt.min(16);
    base_ms
        .max(1)
        .saturating_mul(1_u64 << shift)
        .min(max_ms.max(base_ms.max(1)))
}

fn realtime_reconnect_base_ms() -> u64 {
    env::var("PANDA_BRIDGE_REALTIME_RECONNECT_BASE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000)
}

fn realtime_reconnect_max_ms() -> u64 {
    env::var("PANDA_BRIDGE_REALTIME_RECONNECT_MAX_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000)
}

fn sleep_while_running(running: &Arc<AtomicBool>, duration: Duration) {
    let started = Instant::now();
    while running.load(Ordering::SeqCst) && started.elapsed() < duration {
        let remaining = duration.saturating_sub(started.elapsed());
        thread::sleep(remaining.min(Duration::from_millis(250)));
    }
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
        "product_ids": active_connection_products(credentials)
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
    let codex_connector = warm_codex_connector(credentials, state, proxy);
    let mut registry = execution_registry(codex_connector)?;
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
                if envelope.message_type == "job.assign" {
                    if let Some(job) = envelope.job {
                        if !processed.contains(&job.id) {
                            let current_connection = refreshed_connection(credentials);
                            if !connection_authorizes_product_active(
                                &current_connection,
                                &job.product_id,
                            ) {
                                push_event(
                                    state,
                                    "realtime_job_skipped",
                                    json!({
                                        "job_id": job.id,
                                        "product_id": job.product_id,
                                        "reason": "authorization_paused_locally"
                                    }),
                                );
                                continue;
                            }
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
                            if accept_job(&current_connection, &job, "websocket")? {
                                processed.insert(job.id.clone());
                                execute_and_ack_with_registry(
                                    &current_connection,
                                    &job,
                                    &mut registry,
                                )?;
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

fn warm_codex_connector(
    credentials: &Credentials,
    state: &AppState,
    proxy: &EventLoopProxy<UserEvent>,
) -> CodexConnector {
    if fake_codex_enabled() || !command_exists(&codex_bin()) {
        return CodexConnector::new();
    }
    let Some(grant) = active_connection_products(credentials)
        .into_iter()
        .find(|grant| {
            let capabilities = effective_grant_capabilities(grant);
            capabilities
                .iter()
                .any(|item| item == "codex.chat" || item == "codex.run" || item == "codex.rpc")
        })
    else {
        return CodexConnector::new();
    };
    let capabilities = effective_grant_capabilities(&grant);
    let warm_job = BridgeJob {
        id: "codex_warm".to_string(),
        product_id: grant.id.clone(),
        kind: capabilities
            .iter()
            .find(|item| item.starts_with("codex."))
            .cloned()
            .unwrap_or_else(|| "codex.chat".to_string()),
        workspace_ref: Some("default".to_string()),
        input: json!({ "prompt": "" }),
        policy: json!({}),
        request_key: None,
        cap_token: None,
    };
    let boundary = GrantedBoundary {
        product_id: grant.id.clone(),
        product_name: grant.name.clone(),
        domain: "codex".to_string(),
        boundary_type: connector::BoundaryType::WorkspaceSandbox,
        capabilities,
        raw: grant.policy.clone(),
    };
    let spec = match build_codex_sandbox_spec(&warm_job, &boundary) {
        Ok(spec) => spec,
        Err(error) => {
            push_event(
                state,
                "codex_warm_failed",
                json!({ "error": connector_error_message(&error) }),
            );
            return CodexConnector::new();
        }
    };
    let spec_fingerprint = sandbox::spec_fingerprint(&spec, &boundary.product_id);
    if sandbox::disabled_for_debug() {
        let policy = codex_job_policy_from_scope(&warm_job, &boundary.raw).ok();
        post_event_best_effort(
            credentials,
            &warm_job.id,
            "sandbox_disabled_debug",
            json!({
                "reason": "PANDA_BRIDGE_SANDBOX_MODE=disabled",
                "debug_only": true,
                "product_id": warm_job.product_id.clone(),
                "kind": warm_job.kind.clone(),
                "workspace_ref": warm_job.workspace_ref.clone().unwrap_or_else(|| "default".to_string()),
                "sandbox": policy.as_ref().map(|item| item.sandbox.as_str()).unwrap_or("unknown"),
                "cwd": policy.as_ref().map(|item| redact_local_path(&item.cwd)).unwrap_or_else(|| "[unknown]".to_string())
            }),
        );
    }
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
    match CodexWarmSession::start(spec, boundary.product_id.clone(), spec_fingerprint) {
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
            CodexConnector::with_session(Some(session))
        }
        Err(error) => {
            push_event(
                state,
                "codex_warm_failed",
                json!({ "error": connector_error_message(&error) }),
            );
            CodexConnector::new()
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
    let mut synced_connections = credentials_connections(credentials);
    for connection in connections.iter() {
        match heartbeat(connection)
            .and_then(|heartbeat| poll_once(connection).map(|count| (heartbeat, count)))
        {
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
        if !connection_authorizes_product_active(credentials, &job.product_id) {
            continue;
        }
        execute_and_ack(credentials, &job)?;
    }
    Ok(count)
}

fn connection_authorizes_product_active(credentials: &Credentials, product_id: &str) -> bool {
    active_connection_products(credentials)
        .iter()
        .any(|product| product.id == product_id)
}

fn refreshed_connection(credentials: &Credentials) -> Credentials {
    load_credentials()
        .ok()
        .and_then(|stored| {
            credentials_connections(&stored)
                .into_iter()
                .find(|item| realtime_connection_key(item) == realtime_connection_key(credentials))
        })
        .unwrap_or_else(|| credentials.clone())
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
    let mut registry = execution_registry(CodexConnector::new())?;
    execute_and_ack_with_registry(credentials, job, &mut registry)
}

fn execute_and_ack_with_registry(
    credentials: &Credentials,
    job: &BridgeJob,
    registry: &mut ConnectorRegistry,
) -> Result<(), String> {
    let result = execute_via_registry(registry, credentials, job).unwrap_or_else(|error| {
        let mut result = json!({ "ok": false, "error": error });
        if job.kind.starts_with("codex.") {
            if let Value::Object(ref mut map) = result {
                map.insert("cloud_openai_credentials".to_string(), Value::Bool(false));
            }
        }
        result
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

fn execution_registry(codex: CodexConnector) -> Result<ConnectorRegistry, String> {
    let mut registry = ConnectorRegistry::new();
    registry.register(Box::new(codex))?;
    registry.register(Box::new(DataConnector::new(ProductSqliteKv::new())))?;
    registry.register(Box::new(FsConnector::new()))?;
    registry.register(Box::new(ShellConnector::new()))?;
    Ok(registry)
}

fn declaration_registry() -> ConnectorRegistry {
    let mut registry = ConnectorRegistry::new();
    registry
        .register(Box::new(CodexConnector::new()))
        .expect("codex connector declaration should be valid");
    registry
        .register(Box::new(DataConnector::new(MemKv::new())))
        .expect("data connector declaration should be valid");
    registry
        .register(Box::new(FsConnector::new()))
        .expect("fs connector declaration should be valid");
    registry
        .register(Box::new(ShellConnector::new()))
        .expect("shell connector declaration should be valid");
    registry
}

fn post_cap_token_decision_event(
    credentials: &Credentials,
    job: &BridgeJob,
    decision: &captoken::CapTokenDecision,
) {
    let event_type = if decision.is_allow() {
        "cap_token.verify_ok"
    } else {
        "cap_token.denied"
    };
    post_event_best_effort(
        credentials,
        &job.id,
        event_type,
        json!({
            "jti": decision.jti.clone(),
            "eph": decision.eph,
            "uses": decision.uses,
            "denied": if decision.is_allow() { Value::Null } else { Value::String("cap_token".to_string()) },
            "reason": decision.reason.clone(),
            "mode": captoken::mode(),
        }),
    );
}

fn execute_via_registry(
    registry: &mut ConnectorRegistry,
    credentials: &Credentials,
    job: &BridgeJob,
) -> Result<Value, String> {
    let cap_decision = captoken::verify_for_job(credentials, job);
    post_cap_token_decision_event(credentials, job, &cap_decision);
    if !cap_decision.is_allow() && captoken::mode() == "enforce" {
        post_event_best_effort(
            credentials,
            &job.id,
            "policy_denied",
            local_policy_denial_event_from_parts(job, "cap_token", cap_decision.reason_str()),
        );
        return Ok(local_policy_denial_result_from_parts(
            job,
            "cap_token",
            cap_decision.reason_str(),
        ));
    }
    let grant = match resolve_active_grant(credentials, job) {
        Ok(grant) => grant,
        Err(error) => {
            let result = local_policy_denial_result(job, &error);
            post_event_best_effort(
                credentials,
                &job.id,
                "policy_denied",
                local_policy_denial_event(job, &error),
            );
            return Ok(result);
        }
    };
    let boundary = match build_granted_boundary(registry, &grant, job, &credentials.device_id) {
        Ok(boundary) => boundary,
        Err(error) => {
            let result = local_policy_denial_result(job, &error);
            post_event_best_effort(
                credentials,
                &job.id,
                "policy_denied",
                local_policy_denial_event(job, &error),
            );
            return Ok(result);
        }
    };
    let Some(connector) = registry.connector_for_kind(&job.kind) else {
        let error = format!(
            "capability_not_authorized_locally: {}:{}",
            job.product_id, job.kind
        );
        let result = local_policy_denial_result(job, &error);
        post_event_best_effort(
            credentials,
            &job.id,
            "policy_denied",
            local_policy_denial_event(job, &error),
        );
        return Ok(result);
    };
    let sandbox_spec = match connector.sandbox_spec(job, &boundary) {
        Ok(spec) => spec,
        Err(ConnectorError::LocalPolicyDenied { denied, reason }) => {
            post_event_best_effort(
                credentials,
                &job.id,
                "policy_denied",
                local_policy_denial_event_from_parts(job, &denied, &reason),
            );
            return Ok(local_policy_denial_result_from_parts(job, &denied, &reason));
        }
        Err(ConnectorError::InvalidJob { reason }) => {
            return Ok(json!({ "ok": false, "error": reason }))
        }
        Err(ConnectorError::RuntimeFailed { reason }) => {
            return Ok(json!({ "ok": false, "error": reason }))
        }
        Err(ConnectorError::Cancelled) => return Ok(json!({ "ok": false, "error": "cancelled" })),
        Err(ConnectorError::Timeout) => return Ok(json!({ "ok": false, "error": "timeout" })),
    };
    if sandbox_spec.is_some() && !sandbox::backend().available() {
        post_event_best_effort(
            credentials,
            &job.id,
            "policy_denied",
            local_policy_denial_event_from_parts(job, "sandbox", "sandbox_unavailable_local"),
        );
        return Ok(local_policy_denial_result_from_parts(
            job,
            "sandbox",
            "sandbox_unavailable_local",
        ));
    }
    let deadline = compute_deadline(&boundary.domain, job);
    let is_cancelled = || false;
    let mut emit = |event: ConnectorEvent| {
        post_event_best_effort(credentials, &job.id, &event.event_type, event.payload)
    };
    let mut ctx = ExecCtx {
        emit: &mut emit,
        is_cancelled: &is_cancelled,
        deadline,
        sandbox_spec,
    };
    match connector.execute(job, &boundary, &mut ctx) {
        Ok(result) => Ok(result.result),
        Err(ConnectorError::LocalPolicyDenied { denied, reason }) => {
            post_event_best_effort(
                credentials,
                &job.id,
                "policy_denied",
                local_policy_denial_event_from_parts(job, &denied, &reason),
            );
            Ok(local_policy_denial_result_from_parts(job, &denied, &reason))
        }
        Err(ConnectorError::InvalidJob { reason }) => Ok(json!({ "ok": false, "error": reason })),
        Err(ConnectorError::RuntimeFailed { reason }) => {
            if job.kind.starts_with("codex.") {
                Ok(
                    json!({ "ok": false, "error": reason, "cloud_openai_credentials": false, "codex_warm": false }),
                )
            } else {
                Ok(json!({ "ok": false, "error": reason }))
            }
        }
        Err(ConnectorError::Cancelled) => Ok(json!({ "ok": false, "error": "cancelled" })),
        Err(ConnectorError::Timeout) => Ok(json!({ "ok": false, "error": "timeout" })),
    }
}

fn resolve_active_grant(
    credentials: &Credentials,
    job: &BridgeJob,
) -> Result<ProductGrant, String> {
    let grant = connection_products(credentials)
        .into_iter()
        .find(|item| item.id == job.product_id)
        .ok_or_else(|| format!("product_not_authorized_locally: {}", job.product_id))?;
    if !grant.authorization.is_active() {
        return Err(format!("authorization_paused_locally: {}", job.product_id));
    }
    let capabilities = effective_grant_capabilities(&grant);
    if !capabilities.is_empty() && !capabilities.iter().any(|item| item == &job.kind) {
        return Err(format!(
            "capability_not_authorized_locally: {}:{}",
            job.product_id, job.kind
        ));
    }
    validate_high_tier_scope_locally(&grant.policy, job)?;
    Ok(grant)
}

fn validate_high_tier_scope_locally(policy: &Value, job: &BridgeJob) -> Result<(), String> {
    let Some((domain, danger, _boundary_type)) = capability_metadata(&job.kind) else {
        return Ok(());
    };
    if !matches!(danger.as_str(), "high" | "critical") {
        return Ok(());
    }
    if policy.get("version").and_then(Value::as_str) != Some("AUTH-SCOPE-v2") {
        return Err("tier_not_granted_locally".to_string());
    }
    let tier = policy
        .pointer(&format!("/danger_tiers/{danger}"))
        .cloned()
        .unwrap_or(Value::Null);
    let tier_domains = tier
        .get("domains")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let boundary = policy
        .pointer(&format!("/domain_boundaries/{domain}"))
        .cloned()
        .unwrap_or(Value::Null);
    let granted = tier.get("granted").and_then(Value::as_bool) == Some(true)
        && tier_domains.iter().any(|item| *item == domain)
        && boundary.get("granted").and_then(Value::as_bool) == Some(true)
        && boundary
            .get("danger")
            .and_then(Value::as_str)
            .map(|value| value == danger)
            .unwrap_or(true);
    if granted {
        Ok(())
    } else {
        Err("tier_not_granted_locally".to_string())
    }
}

fn effective_grant_capabilities(grant: &ProductGrant) -> Vec<String> {
    if !grant.capabilities.is_empty() {
        return grant.capabilities.clone();
    }
    authorization_policy_capabilities(&grant.policy).unwrap_or_default()
}

fn build_granted_boundary(
    registry: &ConnectorRegistry,
    grant: &ProductGrant,
    job: &BridgeJob,
    current_device_id: &str,
) -> Result<GrantedBoundary, String> {
    let declaration = registry.kind_declaration(&job.kind).ok_or_else(|| {
        format!(
            "capability_not_authorized_locally: {}:{}",
            job.product_id, job.kind
        )
    })?;
    let domain = registry
        .domain_for_kind(&job.kind)
        .unwrap_or("")
        .to_string();
    let capabilities = effective_grant_capabilities(grant);
    let raw = match domain.as_str() {
        "data" => data_boundary_policy_slice(&grant.policy, &job.product_id),
        "fs" => inject_local_fs_paths(
            fs_boundary_policy_slice(&grant.policy),
            grant,
            current_device_id,
        ),
        "shell" => inject_local_shell_cwd(
            shell_boundary_policy_slice(&grant.policy),
            grant,
            current_device_id,
        ),
        _ => grant.policy.clone(),
    };
    Ok(GrantedBoundary {
        product_id: grant.id.clone(),
        product_name: grant.name.clone(),
        domain,
        boundary_type: declaration.boundary_type,
        capabilities,
        raw,
    })
}

fn inject_local_fs_paths(mut raw: Value, grant: &ProductGrant, current_device_id: &str) -> Value {
    let declared = declared_fs_roots_from_raw(&raw, "allowed_roots", "allowedRoots")
        .into_iter()
        .chain(declared_fs_roots_from_raw(
            &raw,
            "write_roots",
            "writeRoots",
        ))
        .map(|root| (root.id, root.path_display))
        .collect::<HashMap<_, _>>();
    if declared.is_empty() || grant.local_roots.fs_roots.is_empty() {
        return raw;
    }
    let mut local_paths = Map::new();
    for (root_id, binding) in &grant.local_roots.fs_roots {
        if binding.bound_device_id != current_device_id {
            continue;
        }
        let Some(path_display) = declared.get(root_id) else {
            continue;
        };
        if path_display != &binding.path_display {
            continue;
        }
        let path = PathBuf::from(&binding.real_path);
        let Ok(canonical) = sandbox::canonical_existing_path(&path) else {
            continue;
        };
        if !canonical.is_dir() || local_root_is_denied_sensitive(&canonical) {
            continue;
        }
        local_paths.insert(
            root_id.clone(),
            Value::String(canonical.to_string_lossy().to_string()),
        );
    }
    if !local_paths.is_empty() {
        if let Some(map) = raw.as_object_mut() {
            map.insert("_local_paths".to_string(), Value::Object(local_paths));
        }
    }
    raw
}

fn inject_local_shell_cwd(mut raw: Value, grant: &ProductGrant, current_device_id: &str) -> Value {
    let cwd_root_id = raw
        .get("cwd_root_id")
        .or_else(|| raw.get("cwdRootId"))
        .and_then(Value::as_str)
        .map(trim_nfc_keep_slash_local)
        .filter(|value| !value.is_empty());
    let Some(cwd_root_id) = cwd_root_id else {
        return raw;
    };
    let Some(binding) = grant.local_roots.shell_cwd.get(&cwd_root_id) else {
        return raw;
    };
    if binding.bound_device_id != current_device_id {
        return raw;
    }
    let Some(declared) =
        declared_shell_cwd_root_from_raw(&raw, &cwd_root_id, Some(&binding.path_display))
    else {
        return raw;
    };
    if declared.path_display != binding.path_display {
        return raw;
    }
    let path = PathBuf::from(&binding.real_path);
    let Ok(canonical) = sandbox::canonical_existing_path(&path) else {
        return raw;
    };
    if !canonical.is_dir() || local_root_is_denied_sensitive(&canonical) {
        return raw;
    }
    if let Some(map) = raw.as_object_mut() {
        map.insert(
            "_local_cwd".to_string(),
            Value::String(canonical.to_string_lossy().to_string()),
        );
    }
    raw
}

/// Strip any caller-supplied machine-only injection keys (underscore-prefixed,
/// e.g. `_local_paths` / `_local_cwd`) from a boundary slice cloned out of the
/// persisted policy. A caller could smuggle these through their requested
/// boundaries; only the desktop's own `inject_local_*` may add them, from
/// user-bound real paths. Without this strip, a zero-binding grant carrying a
/// caller-supplied `_local_paths` would pass an attacker-chosen real path
/// straight to the connector as the seatbelt boundary (P0).
fn strip_local_injection_keys(slice: &mut Value) {
    if let Some(map) = slice.as_object_mut() {
        map.retain(|key, _| !key.starts_with('_'));
    }
}

fn fs_boundary_policy_slice(policy: &Value) -> Value {
    let mut slice = policy
        .pointer("/boundaries/fs")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "type": "directory_whitelist",
                "allowed_roots": [],
                "write_roots": [],
                "writable": false,
                "max_bytes": connector::fs::DEFAULT_MAX_BYTES,
                "follow_symlinks": false
            })
        });
    strip_local_injection_keys(&mut slice);
    slice
}

fn shell_boundary_policy_slice(policy: &Value) -> Value {
    let mut slice = policy
        .pointer("/boundaries/shell")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "type": "command_sandbox",
                "cwd_root_id": "",
                "net": "deny",
                "allow_exec_subtree": false,
                "cmd_allowlist": [],
                "max_output_bytes": connector::shell::DEFAULT_MAX_OUTPUT_BYTES,
                "deadline_ms": connector::shell::DEFAULT_DEADLINE_MS,
                "limits": connector::shell::default_limits_json()
            })
        });
    strip_local_injection_keys(&mut slice);
    slice
}

fn data_boundary_policy_slice(policy: &Value, product_id: &str) -> Value {
    policy
        .pointer("/boundaries/data")
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "type": "namespace_kv",
                "owner_product_id": product_id,
                "namespace": format!("product:{product_id}"),
                "max_key_bytes": DEFAULT_MAX_KEY_BYTES,
                "max_value_bytes": DEFAULT_MAX_VALUE_BYTES,
                "allow_query": true,
                "allow_delete": true
            })
        })
}

fn compute_deadline(domain: &str, job: &BridgeJob) -> Instant {
    let default_ms = if domain == "data" { 10_000 } else { 240_000 };
    let requested = job
        .policy
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(default_ms);
    Instant::now() + Duration::from_millis(requested.min(default_ms))
}

#[cfg(test)]
fn local_job_policy_for_credentials(
    credentials: &Credentials,
    job: &BridgeJob,
) -> Result<LocalJobPolicy, String> {
    let grant = connection_products(credentials)
        .into_iter()
        .find(|item| item.id == job.product_id)
        .ok_or_else(|| format!("product_not_authorized_locally: {}", job.product_id))?;
    if !grant.authorization.is_active() {
        return Err(format!("authorization_paused_locally: {}", job.product_id));
    }
    if !grant.capabilities.is_empty() && !grant.capabilities.iter().any(|item| item == &job.kind) {
        return Err(format!(
            "capability_not_authorized_locally: {}:{}",
            job.product_id, job.kind
        ));
    }
    match grant.policy.get("version").and_then(Value::as_str) {
        Some("AUTH-SCOPE-v1") | Some("AUTH-SCOPE-v2") => {}
        _ => {
            return Err("authorization_scope_missing_locally".to_string());
        }
    }
    validate_authorization_scope(&grant.policy, job)?;
    effective_job_policy(job, Some(&grant.policy))
}

fn codex_job_policy_from_scope(job: &BridgeJob, scope: &Value) -> Result<LocalJobPolicy, String> {
    match scope.get("version").and_then(Value::as_str) {
        Some("AUTH-SCOPE-v1") | Some("AUTH-SCOPE-v2") => {}
        _ => {
            return Err("authorization_scope_missing_locally".to_string());
        }
    }
    validate_authorization_scope(scope, job)?;
    effective_job_policy(job, Some(scope))
}

fn build_codex_sandbox_spec(
    job: &BridgeJob,
    boundary: &GrantedBoundary,
) -> Result<SandboxSpec, ConnectorError> {
    let policy = crate::codex_job_policy_from_scope(job, &boundary.raw).map_err(|error| {
        let (denied, reason) = crate::local_policy_denial(&error);
        ConnectorError::LocalPolicyDenied {
            denied: denied.to_string(),
            reason: reason.to_string(),
        }
    })?;
    let cwd =
        canonical_path(Path::new(&policy.cwd)).map_err(|_| ConnectorError::LocalPolicyDenied {
            denied: "cwd".to_string(),
            reason: "cwd_not_allowed_locally".to_string(),
        })?;
    let runtime_bin = codex_runtime_bin().map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "sandbox".to_string(),
        reason: "sandbox_apply_failed_local".to_string(),
    })?;
    let codex_home = codex_home_dir();
    let tmp_dir = codex_tmp_dir(&cwd, &policy.sandbox);
    fs::create_dir_all(&tmp_dir).map_err(|error| ConnectorError::RuntimeFailed {
        reason: format!("failed to create codex tmp dir: {error}"),
    })?;
    #[cfg(unix)]
    fs::set_permissions(&tmp_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
        ConnectorError::RuntimeFailed {
            reason: format!("failed to protect codex tmp dir: {error}"),
        }
    })?;
    let mut read_roots = vec![cwd.clone(), codex_home.clone()];
    if policy.sandbox == "read-only" {
        read_roots.push(tmp_dir.clone());
    }
    if let Some(package_root) = codex_package_root(&runtime_bin) {
        read_roots.push(package_root);
    }
    if let Some(runtime_cache) = codex_runtime_cache_root() {
        read_roots.push(runtime_cache);
    }
    read_roots.sort();
    read_roots.dedup();
    let env_allow = codex_clean_env(&cwd, &runtime_bin, &codex_home, &tmp_dir);
    let net = if policy.sandbox == "read-only" {
        NetPolicy::Deny
    } else {
        NetPolicy::AllowOutbound
    };
    let mut write_roots = if policy.sandbox == "read-only" {
        vec![codex_home.clone(), tmp_dir]
    } else {
        vec![cwd.clone(), codex_home]
    };
    write_roots.sort();
    write_roots.dedup();
    Ok(SandboxSpec {
        profile: SandboxProfileKind::CodexWorkspace,
        read_roots,
        write_roots,
        exec_allow: vec![runtime_bin],
        allow_exec_subtree: false,
        net,
        limits: ResourceLimits::codex_default(),
        env_allow,
        cwd,
    })
}

#[cfg(test)]
fn validate_local_job_authorization(
    credentials: &Credentials,
    job: &BridgeJob,
) -> Result<(), String> {
    let _ = local_job_policy_for_credentials(credentials, job)?;
    Ok(())
}

fn validate_authorization_scope(scope: &Value, job: &BridgeJob) -> Result<(), String> {
    match scope.get("capabilities").and_then(Value::as_array) {
        Some(capabilities)
            if capabilities
                .iter()
                .filter_map(Value::as_str)
                .any(|item| item == job.kind) => {}
        _ => {
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
    if roots.iter().any(root_allows_all_workspaces) {
        return true;
    }
    roots.iter().any(|item| {
        item.get("id")
            .and_then(Value::as_str)
            .map(|id| id == workspace_ref)
            .unwrap_or(false)
    })
}

fn authorization_scope_allows_sandbox(floor: &str, requested: &str) -> bool {
    match floor {
        "danger-full-access" => {
            requested == "danger-full-access"
                || requested == "workspace-write"
                || requested == "read-only"
        }
        "read-only" => requested == "read-only",
        "workspace-write" => requested == "workspace-write" || requested == "read-only",
        _ => false,
    }
}

fn authorization_scope_allows_approval(floor: &str, requested: &str, allow_never: bool) -> bool {
    if floor == "never" {
        return requested == "never"
            || requested == "on-failure"
            || requested == "on-request"
            || requested == "untrusted";
    }
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
    local_policy_denial_result_from_parts(job, denied, reason)
}

fn local_policy_denial_result_from_parts(job: &BridgeJob, denied: &str, reason: &str) -> Value {
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
    local_policy_denial_event_from_parts(job, denied, reason)
}

fn local_policy_denial_event_from_parts(job: &BridgeJob, denied: &str, reason: &str) -> Value {
    json!({
        "denied": denied,
        "reason": reason,
        "product_id": job.product_id.clone(),
        "kind": job.kind.clone(),
        "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string())
    })
}

fn connector_error_message(error: &ConnectorError) -> String {
    match error {
        ConnectorError::LocalPolicyDenied { denied, reason } => {
            format!("local_policy_denied:{denied}:{reason}")
        }
        ConnectorError::InvalidJob { reason } | ConnectorError::RuntimeFailed { reason } => {
            reason.clone()
        }
        ConnectorError::Cancelled => "cancelled".to_string(),
        ConnectorError::Timeout => "timeout".to_string(),
    }
}

fn local_policy_denial(error: &str) -> (&'static str, &'static str) {
    if error.starts_with("product_not_authorized_locally") {
        ("product", "product_not_authorized_locally")
    } else if error.starts_with("authorization_paused_locally") {
        ("authorization", "authorization_paused_locally")
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
    } else if error.starts_with("sandbox_unavailable_local") {
        ("sandbox", "sandbox_unavailable_local")
    } else if error.starts_with("sandbox_apply_failed_local") {
        ("sandbox", "sandbox_apply_failed_local")
    } else if error.starts_with("sandbox_spec_missing_local") {
        ("sandbox", "sandbox_spec_missing_local")
    } else if error.starts_with("tier_not_granted_locally") {
        ("tier", "tier_not_granted_locally")
    } else if error.starts_with("namespace_owner_mismatch_locally") {
        ("namespace", "namespace_owner_mismatch_locally")
    } else if error.starts_with("namespace_not_owned_locally") {
        ("namespace", "namespace_not_owned_locally")
    } else if error.starts_with("key_invalid_locally") {
        ("key", "key_invalid_locally")
    } else if error.starts_with("value_too_large_locally") {
        ("value", "value_too_large_locally")
    } else if error.starts_with("query_invalid_locally") {
        ("key", "query_invalid_locally")
    } else if error.starts_with("boundary_type_mismatch_locally") {
        ("namespace", "boundary_type_mismatch_locally")
    } else if error.starts_with("path_not_found_locally") {
        ("path", "path_not_found_locally")
    } else if error.starts_with("path_outside_allowlist_locally") {
        ("path", "path_outside_allowlist_locally")
    } else if error.starts_with("root_denied_sensitive") {
        ("path", "root_denied_sensitive")
    } else if error.starts_with("path_denied_by_sandbox_local") {
        ("path", "path_denied_by_sandbox_local")
    } else if error.starts_with("file_too_large_locally") {
        ("path", "file_too_large_locally")
    } else if error.starts_with("cwd_root_not_granted_locally") {
        ("cwd_root", "cwd_root_not_granted_locally")
    } else if error.starts_with("command_not_found_locally") {
        ("command", "command_not_found_locally")
    } else if error.starts_with("command_not_allowed_locally") {
        ("command", "command_not_allowed_locally")
    } else if error.starts_with("output_too_large_locally") {
        ("output", "output_too_large_locally")
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
    fn start(
        spec: SandboxSpec,
        product_id: String,
        spec_fingerprint: String,
    ) -> Result<Self, ConnectorError> {
        let cwd = spec.cwd.to_string_lossy().to_string();
        let (child, stdin, rx, err_rx) = spawn_codex_app_server(&spec)?;
        let mut session = Self {
            child,
            stdin,
            rx,
            err_rx,
            next_id: 0,
            cwd,
            spec_fingerprint,
            product_id,
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
        send_notify(&mut session.stdin, "initialized", json!({})).map_err(|reason| {
            ConnectorError::RuntimeFailed {
                reason: reason.to_string(),
            }
        })?;
        let account =
            session.send_request_raw("account/read", json!({ "refreshToken": false }), timeout)?;
        if account.get("account").is_none() {
            return Err(ConnectorError::RuntimeFailed {
                reason: "local Codex is not signed in; run codex login on this machine".to_string(),
            });
        }
        let _ = session.send_request_raw("account/rateLimits/read", json!({}), timeout);
        Ok(session)
    }

    fn send_request_raw(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ConnectorError> {
        self.next_id += 1;
        let id = self.next_id;
        writeln!(
            self.stdin,
            "{}",
            json!({ "method": method, "id": id, "params": params })
        )
        .map_err(|error| ConnectorError::RuntimeFailed {
            reason: error.to_string(),
        })?;
        self.stdin
            .flush()
            .map_err(|error| ConnectorError::RuntimeFailed {
                reason: error.to_string(),
            })?;
        let started = Instant::now();
        while started.elapsed() < timeout {
            let message = match self.rx.recv_timeout(Duration::from_millis(500)) {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ConnectorError::RuntimeFailed {
                        reason: format!("codex app-server closed while waiting for {method}"),
                    });
                }
            };
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(ConnectorError::RuntimeFailed {
                        reason: format!("codex {method} error: {error}"),
                    });
                }
                return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
            }
        }
        Err(ConnectorError::RuntimeFailed {
            reason: format!("codex app-server timeout waiting for {method}"),
        })
    }
}

impl Drop for CodexWarmSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn spawn_codex_app_server(
    spec: &SandboxSpec,
) -> Result<
    (
        Child,
        ChildStdin,
        mpsc::Receiver<Value>,
        mpsc::Receiver<String>,
    ),
    ConnectorError,
> {
    let bin = spec
        .exec_allow
        .first()
        .ok_or_else(|| ConnectorError::LocalPolicyDenied {
            denied: "sandbox".to_string(),
            reason: "sandbox_spec_missing_local".to_string(),
        })?
        .to_string_lossy()
        .to_string();
    let mut command = Command::new(&bin);
    command
        .args(["app-server", "--stdio"])
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env_allow.iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if sandbox::disabled_for_debug() {
        eprintln!(
            "WARN PANDA_BRIDGE_SANDBOX_MODE=disabled: starting codex without macOS seatbelt; debug only"
        );
    } else {
        let backend = sandbox::backend();
        if !backend.available() {
            return Err(ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_unavailable_local".to_string(),
            });
        }
        backend.wrap_command(&mut command, spec).map_err(|_| {
            ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_apply_failed_local".to_string(),
            }
        })?;
    }
    let mut child = command
        .spawn()
        .map_err(|error| ConnectorError::RuntimeFailed {
            reason: format!("failed to start codex app-server at {bin}: {error}"),
        })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "codex stdin unavailable".to_string(),
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "codex stdout unavailable".to_string(),
        })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "codex stderr unavailable".to_string(),
        })?;
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

fn send_notify(stdin: &mut impl Write, method: &str, params: Value) -> Result<(), String> {
    writeln!(stdin, "{}", json!({ "method": method, "params": params }))
        .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
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
    #[cfg(test)]
    if credentials.api_base.contains("local.test") {
        return;
    }
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
    let registry = declaration_registry();
    let connectors = registry
        .declarations()
        .iter()
        .map(|declaration| {
            json!({
                "domain": declaration.domain.clone(),
                "kinds": declaration.kinds.iter().map(|kind| {
                    json!({
                        "kind": kind.kind.clone(),
                        "verb": kind.verb.clone(),
                        "danger": kind.danger.as_str(),
                        "boundary_type": kind.boundary_type.as_str()
                    })
                }).collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    json!({
        "runtime": registry.all_kinds(),
        "connectors": connectors,
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

fn low_tier_capabilities() -> Vec<String> {
    declaration_registry()
        .declarations()
        .iter()
        .flat_map(|declaration| declaration.kinds.iter())
        .filter(|kind| kind.danger == ConnectorDanger::Low)
        .map(|kind| kind.kind.clone())
        .collect()
}

fn capability_metadata(kind: &str) -> Option<(String, String, String)> {
    for declaration in declaration_registry().declarations() {
        for item in &declaration.kinds {
            if item.kind == kind {
                return Some((
                    declaration.domain.clone(),
                    item.danger.as_str().to_string(),
                    item.boundary_type.as_str().to_string(),
                ));
            }
        }
    }
    if kind == "saas.custom.run" {
        Some((
            "saas".to_string(),
            "high".to_string(),
            "opaque_runtime".to_string(),
        ))
    } else {
        None
    }
}

fn scope_domain_boundaries_from_capabilities(capabilities: &[String]) -> Value {
    let mut domain_boundaries = serde_json::Map::new();
    for capability in capabilities {
        if let Some((domain, danger, boundary_type)) = capability_metadata(capability) {
            domain_boundaries.insert(
                domain,
                json!({
                    "granted": true,
                    "danger": danger,
                    "boundary_type": boundary_type
                }),
            );
        }
    }
    Value::Object(domain_boundaries)
}

fn scope_danger_metadata_from_capabilities(capabilities: &[String]) -> (Value, Value) {
    let mut low = HashSet::new();
    let mut medium = HashSet::new();
    let mut high = HashSet::new();
    let mut critical = HashSet::new();
    for capability in capabilities {
        if let Some((domain, danger, _)) = capability_metadata(capability) {
            match danger.as_str() {
                "low" => {
                    low.insert(domain);
                }
                "medium" => {
                    medium.insert(domain);
                }
                "high" => {
                    high.insert(domain);
                }
                "critical" => {
                    critical.insert(domain);
                }
                _ => {}
            }
        }
    }
    let danger_tiers = json!({
        "low": tier_metadata_value(&low),
        "medium": tier_metadata_value(&medium),
        "high": tier_metadata_value(&high),
        "critical": tier_metadata_value(&critical)
    });
    (
        danger_tiers,
        scope_domain_boundaries_from_capabilities(capabilities),
    )
}

fn tier_metadata_value(domains: &HashSet<String>) -> Value {
    let mut sorted = domains.iter().cloned().collect::<Vec<_>>();
    sorted.sort();
    json!({
        "granted": !sorted.is_empty(),
        "domains": sorted
    })
}

#[cfg(test)]
fn project_v1_scope_to_v2(scope: &Value) -> Value {
    let mut projected = scope.clone();
    if let Some(map) = projected.as_object_mut() {
        map.insert("version".to_string(), json!("AUTH-SCOPE-v2"));
        let capabilities = map
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let (danger_tiers, domain_boundaries) =
            scope_danger_metadata_from_capabilities(&capabilities);
        map.insert("danger_tiers".to_string(), danger_tiers);
        map.insert("domain_boundaries".to_string(), domain_boundaries);
    }
    projected
}

fn local_policy_preview() -> Value {
    let capabilities = low_tier_capabilities();
    let (danger_tiers, domain_boundaries) = scope_danger_metadata_from_capabilities(&capabilities);
    json!({
        "version": "AUTH-SCOPE-v2",
        "preset": "workspace-default",
        "request_source": "desktop_fallback_low_tier",
        "capabilities": capabilities,
        "workspace_roots": [{
            "id": "default",
            "path_display": "[local]/default"
        }],
        "sandbox_floor": "workspace-write",
        "approval_policy_floor": "on-request",
        "allow_approval_never": false,
        "allow_developer_instructions": false,
        "display": {
            "workspace": "[local]/default",
            "sandbox": "workspace-write",
            "approval": "on-request",
            "developer_instructions": "denied"
        },
        "danger_tiers": danger_tiers,
        "domain_boundaries": domain_boundaries
    })
}

fn local_authorization_policy(preview: Option<&IntentPreview>) -> Value {
    preview
        .map(|item| item.local_policy.clone())
        .unwrap_or_else(local_policy_preview)
}

fn intent_authorization_policy(
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
            .or_insert_with(|| json!("AUTH-SCOPE-v2"));
        map.entry("preset".to_string())
            .or_insert_with(|| json!("workspace-default"));
        map.entry("request_source".to_string())
            .or_insert_with(|| json!("desktop_fallback_low_tier"));
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
        if !map.contains_key("workspace_roots") {
            map.insert(
                "workspace_roots".to_string(),
                json!([{ "id": "default", "path_display": "[local]/default" }]),
            );
        }
        map.entry("sandbox_floor".to_string())
            .or_insert_with(|| json!("workspace-write"));
        map.entry("approval_policy_floor".to_string())
            .or_insert_with(|| json!("on-request"));
        map.entry("allow_approval_never".to_string())
            .or_insert_with(|| json!(false));
        map.entry("allow_developer_instructions".to_string())
            .or_insert_with(|| json!(false));
        map.entry("display".to_string()).or_insert_with(|| {
            json!({
                "workspace": "[local]/default",
                "sandbox": "workspace-write",
                "approval": "on-request",
                "developer_instructions": "denied"
            })
        });
        if map.get("version").and_then(Value::as_str) == Some("AUTH-SCOPE-v2") {
            let capabilities = map
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let (danger_tiers, domain_boundaries) =
                scope_danger_metadata_from_capabilities(&capabilities);
            map.entry("danger_tiers".to_string())
                .or_insert(danger_tiers);
            map.entry("domain_boundaries".to_string())
                .or_insert(domain_boundaries);
            ensure_data_boundary_for_policy(map, product_id, &capabilities);
        }
    }
    policy
}

fn ensure_data_boundary_for_policy(
    map: &mut serde_json::Map<String, Value>,
    product_id: &str,
    capabilities: &[String],
) {
    if !capabilities
        .iter()
        .any(|capability| capability.starts_with("data."))
    {
        return;
    }
    let mut boundaries = map
        .remove("boundaries")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    boundaries.entry("data".to_string()).or_insert_with(|| {
        json!({
            "type": "namespace_kv",
            "owner_product_id": product_id,
            "namespace": format!("product:{product_id}"),
            "max_key_bytes": DEFAULT_MAX_KEY_BYTES,
            "max_value_bytes": DEFAULT_MAX_VALUE_BYTES,
            "allow_query": true,
            "allow_delete": true
        })
    });
    map.insert("boundaries".to_string(), Value::Object(boundaries));
}

fn authorization_policy_capabilities(policy: &Value) -> Option<Vec<String>> {
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

fn settings_path() -> Result<PathBuf, String> {
    Ok(state_dir()?.join("desktop-settings.json"))
}

fn load_settings_with_api(api_base: &str) -> DesktopSettings {
    let mut settings = fs::read_to_string(settings_path().unwrap_or_else(|_| PathBuf::new()))
        .ok()
        .and_then(|text| serde_json::from_str::<DesktopSettings>(&text).ok())
        .unwrap_or_else(default_settings);
    settings.api_base = api_base.to_string();
    settings
}

fn default_settings() -> DesktopSettings {
    DesktopSettings {
        launch_at_login: default_launch_at_login(),
        appearance: default_appearance(),
        language: default_language(),
        api_base: default_api_base(),
    }
}

fn save_settings(settings: &DesktopSettings) -> Result<(), String> {
    let mut persisted = settings.clone();
    persisted.api_base = DEFAULT_API.to_string();
    write_file(
        &settings_path()?,
        &serde_json::to_string_pretty(&persisted).map_err(|error| error.to_string())?,
    )
}

fn update_settings(params: &Value) -> Result<DesktopSettings, String> {
    let api_base = load_credentials()
        .map(|credentials| credentials.api_base)
        .unwrap_or_else(|_| DEFAULT_API.to_string());
    let mut settings = load_settings_with_api(&api_base);
    if let Some(value) = params.get("launch_at_login").and_then(Value::as_bool) {
        settings.launch_at_login = value;
    }
    if let Some(value) = params.get("appearance").and_then(Value::as_str) {
        settings.appearance = match value {
            "auto" | "light" | "dark" => value.to_string(),
            other => return Err(format!("invalid appearance: {other}")),
        };
    }
    if let Some(value) = params.get("language").and_then(Value::as_str) {
        settings.language = match value {
            "auto" | "zh-CN" | "zh-TW" | "en" | "ja" => value.to_string(),
            other => return Err(format!("invalid language: {other}")),
        };
    }
    save_settings(&settings)?;
    if params
        .get("launch_at_login")
        .and_then(Value::as_bool)
        .is_some()
    {
        if let Err(error) = apply_launch_at_login(settings.launch_at_login) {
            eprintln!("[launch-at-login] {error}");
        }
    }
    Ok(settings)
}

fn launch_agent_plist(executable: &str) -> String {
    let escaped = executable
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
    <key>Label</key>\n\
    <string>cc.otherline.panda-bridge</string>\n\
    <key>ProgramArguments</key>\n\
    <array>\n\
        <string>{escaped}</string>\n\
    </array>\n\
    <key>RunAtLoad</key>\n\
    <true/>\n\
    <key>ProcessType</key>\n\
    <string>Interactive</string>\n\
</dict>\n\
</plist>"
    )
}

/// 开机自启（契约 §1 连接全自动）：macOS 写入/移除用户级 LaunchAgent，其余平台仅持久化开关。
fn apply_launch_at_login(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = home_dir()?.join("Library/LaunchAgents/cc.otherline.panda-bridge.plist");
        if !enabled {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        let exe = env::current_exe().map_err(|error| error.to_string())?;
        return write_external_state_file(&path, &launch_agent_plist(&exe.to_string_lossy()));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Ok(())
    }
}

fn running_from_app_bundle() -> bool {
    env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS"))
        .unwrap_or(false)
}

fn save_credentials(credentials: &Credentials) -> Result<(), String> {
    let text = serde_json::to_string_pretty(credentials).map_err(|error| error.to_string())?;
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        write_external_state_file(Path::new(&path), &text)?;
        return Ok(());
    }
    if keychain_enabled() {
        let _ = keychain_entry()
            .and_then(|entry| entry.set_password(&text).map_err(|error| error.to_string()));
    }
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
    let fallback_path = fallback_credentials_path()?;
    if keychain_enabled() {
        if let Ok(text) = keychain_entry()
            .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        {
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    if let Ok(text) = fs::read_to_string(&fallback_path) {
        if !text.trim().is_empty() {
            if keychain_enabled() {
                let _ = keychain_entry()
                    .and_then(|entry| entry.set_password(&text).map_err(|error| error.to_string()));
            }
            return Ok(text);
        }
    }
    Err(format!(
        "desktop state unavailable: {}",
        fallback_path.display()
    ))
}

fn delete_credentials() -> Result<(), String> {
    if let Ok(path) = env::var("PANDA_BRIDGE_DESKTOP_STATE") {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let _ = fs::remove_file(fallback_credentials_path()?);
    if keychain_enabled() {
        thread::spawn(move || {
            let _ = keychain_entry()
                .and_then(|entry| entry.delete_credential().map_err(|error| error.to_string()));
        });
    }
    Ok(())
}

fn keychain_enabled() -> bool {
    !env_flag("PANDA_BRIDGE_SKIP_KEYCHAIN")
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
    write_file_with_parent_permissions(path, text, true)
}

fn write_external_state_file(path: &Path, text: &str) -> Result<(), String> {
    write_file_with_parent_permissions(path, text, false)
}

fn write_file_with_parent_permissions(
    path: &Path,
    text: &str,
    private_parent: bool,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if private_parent {
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
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

fn effective_job_policy(job: &BridgeJob, scope: Option<&Value>) -> Result<LocalJobPolicy, String> {
    let requested_cwd = policy_string(&job.policy, "cwd")
        .or_else(|| policy_string(&job.policy, "workspace_path"))
        .or_else(|| workspace_ref_cwd(job.workspace_ref.as_deref()))
        .ok_or_else(|| {
            format!(
                "workspace_not_allowed_locally: {}",
                job.workspace_ref.as_deref().unwrap_or("default")
            )
        })?;
    let cwd = allowed_cwd(&requested_cwd, scope)?;
    let sandbox = allowed_sandbox(
        policy_string(&job.policy, "sandbox")
            .unwrap_or_else(|| "workspace-write".to_string())
            .as_str(),
        scope,
    )?;
    let approval_policy = allowed_approval_policy(
        policy_string(&job.policy, "approvalPolicy")
            .unwrap_or_else(|| "on-request".to_string())
            .as_str(),
        scope,
    )?;
    let developer_instructions = policy_string(&job.policy, "developerInstructions");
    if developer_instructions.is_some() && !scope_allows_developer_instructions(scope) {
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

fn allowed_cwd(requested: &str, scope: Option<&Value>) -> Result<String, String> {
    let cwd = canonical_path(Path::new(requested))
        .map_err(|error| format!("cwd_not_allowed_locally: {requested}: {error}"))?;
    if scope_allows_all_workspaces(scope) {
        return Ok(cwd.to_string_lossy().to_string());
    }
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

fn allowed_sandbox(value: &str, scope: Option<&Value>) -> Result<String, String> {
    if authorization_scope_allows_sandbox(scope_sandbox_floor(scope).as_str(), value) {
        return Ok(value.to_string());
    }
    match value {
        "workspace-write" | "read-only" => Ok(value.to_string()),
        "danger-full-access" => Err("sandbox_not_allowed_locally: danger-full-access".to_string()),
        other => Err(format!("sandbox_not_allowed_locally: {other}")),
    }
}

fn allowed_approval_policy(value: &str, scope: Option<&Value>) -> Result<String, String> {
    if authorization_scope_allows_approval(
        scope_approval_floor(scope).as_str(),
        value,
        scope_allows_approval_never(scope),
    ) {
        return Ok(value.to_string());
    }
    match value {
        "on-request" | "on-failure" | "untrusted" => Ok(value.to_string()),
        "never" if env_flag("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER") => Ok(value.to_string()),
        "never" => Err("approval_policy_not_allowed_locally: never".to_string()),
        other => Err(format!("approval_policy_not_allowed_locally: {other}")),
    }
}

fn root_allows_all_workspaces(root: &Value) -> bool {
    root.get("allow_all")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || root
            .get("allowAll")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || root.get("id").and_then(Value::as_str) == Some("all")
        || root.get("id").and_then(Value::as_str) == Some("*")
}

fn scope_allows_all_workspaces(scope: Option<&Value>) -> bool {
    scope
        .and_then(|value| value.get("workspace_roots"))
        .and_then(Value::as_array)
        .map(|roots| roots.iter().any(root_allows_all_workspaces))
        .unwrap_or(false)
}

fn scope_sandbox_floor(scope: Option<&Value>) -> String {
    scope
        .and_then(|value| policy_string(value, "sandbox_floor"))
        .unwrap_or_else(|| "workspace-write".to_string())
}

fn scope_approval_floor(scope: Option<&Value>) -> String {
    scope
        .and_then(|value| policy_string(value, "approval_policy_floor"))
        .unwrap_or_else(|| "on-request".to_string())
}

fn scope_allows_approval_never(scope: Option<&Value>) -> bool {
    scope
        .and_then(|value| value.get("allow_approval_never"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || scope_approval_floor(scope) == "never"
}

fn scope_allows_developer_instructions(scope: Option<&Value>) -> bool {
    scope
        .and_then(|value| value.get("allow_developer_instructions"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

fn codex_runtime_bin() -> Result<PathBuf, String> {
    if let Ok(explicit) = env::var("PANDA_BRIDGE_CODEX_RUNTIME_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = canonical_path(Path::new(trimmed))?;
            if executable_exists(&path) {
                return Ok(path);
            }
            return Err(format!("codex runtime is not executable: {trimmed}"));
        }
    }
    let bin = codex_bin();
    let canonical = canonical_path(Path::new(&bin)).or_else(|_| {
        resolve_codex_bin()
            .ok_or_else(|| "codex command not found".to_string())
            .and_then(|path| canonical_path(Path::new(&path)))
    })?;
    if let Some(native) = native_codex_from_js_shim(&canonical) {
        return Ok(native);
    }
    if executable_exists(&canonical) {
        return Ok(canonical);
    }
    Err(format!("codex runtime is not executable: {bin}"))
}

fn native_codex_from_js_shim(canonical_bin: &Path) -> Option<PathBuf> {
    if canonical_bin.extension().and_then(|value| value.to_str()) != Some("js") {
        return None;
    }
    let package_root = canonical_bin.parent()?.parent()?;
    let target = codex_target_triple()?;
    let packages = [
        package_root
            .join("node_modules")
            .join(codex_platform_package())
            .join("vendor")
            .join(target)
            .join("bin")
            .join(if cfg!(windows) { "codex.exe" } else { "codex" }),
        package_root
            .join("vendor")
            .join(target)
            .join("bin")
            .join(if cfg!(windows) { "codex.exe" } else { "codex" }),
    ];
    packages
        .into_iter()
        .find(|path| executable_exists(path))
        .and_then(|path| canonical_path(&path).ok())
}

fn codex_target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-musl"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        _ => None,
    }
}

fn codex_platform_package() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "@openai/codex-darwin-arm64",
        ("macos", "x86_64") => "@openai/codex-darwin-x64",
        ("linux", "x86_64") => "@openai/codex-linux-x64",
        ("linux", "aarch64") => "@openai/codex-linux-arm64",
        ("windows", "x86_64") => "@openai/codex-win32-x64",
        ("windows", "aarch64") => "@openai/codex-win32-arm64",
        _ => "@openai/codex-unknown",
    }
}

fn codex_home_dir() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| {
            home_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".codex")
        })
}

fn codex_tmp_dir(cwd: &Path, sandbox: &str) -> PathBuf {
    if sandbox != "read-only" {
        return cwd.join(".panda-bridge").join("codex-tmp");
    }
    let mut token_hasher = Sha256::new();
    token_hasher.update(cwd.to_string_lossy().as_bytes());
    let token = token_hasher.finalize()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    env::temp_dir()
        .join("panda-bridge")
        .join("codex-readonly-tmp")
        .join(token)
}

fn codex_package_root(runtime_bin: &Path) -> Option<PathBuf> {
    if let Ok(explicit) = env::var("CODEX_MANAGED_PACKAGE_ROOT") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return canonical_path(&path).ok();
        }
    }
    for ancestor in runtime_bin.ancestors() {
        if ancestor.file_name().and_then(|value| value.to_str()) == Some("codex")
            && ancestor
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
                == Some("@openai")
        {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

fn codex_runtime_cache_root() -> Option<PathBuf> {
    let path = home_dir()
        .ok()?
        .join(".cache")
        .join("codex-runtimes")
        .join("codex-primary-runtime");
    path.exists().then_some(path)
}

fn codex_clean_env(
    cwd: &Path,
    runtime_bin: &Path,
    codex_home: &Path,
    tmp_dir: &Path,
) -> Vec<(String, String)> {
    let mut envs = Vec::new();
    if let Ok(home) = home_dir() {
        envs.push(("HOME".to_string(), home.to_string_lossy().to_string()));
    }
    envs.push((
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().to_string(),
    ));
    envs.push(("TMPDIR".to_string(), tmp_dir.to_string_lossy().to_string()));
    if let Some(cert_file) = codex_system_cert_file() {
        envs.push((
            "SSL_CERT_FILE".to_string(),
            cert_file.to_string_lossy().to_string(),
        ));
    }
    if let Some(parent) = runtime_bin.parent() {
        let mut paths = vec![parent.to_string_lossy().to_string()];
        if let Some(package_root) = codex_package_root(runtime_bin) {
            let vendor_path = package_root
                .join("node_modules")
                .join(codex_platform_package())
                .join("vendor")
                .join(codex_target_triple().unwrap_or(""))
                .join("codex-path");
            if vendor_path.exists() {
                paths.push(vendor_path.to_string_lossy().to_string());
            }
            envs.push((
                "CODEX_MANAGED_PACKAGE_ROOT".to_string(),
                package_root.to_string_lossy().to_string(),
            ));
            envs.push(("CODEX_MANAGED_BY_NPM".to_string(), "1".to_string()));
        }
        paths.push("/usr/bin".to_string());
        paths.push("/bin".to_string());
        envs.push(("PATH".to_string(), paths.join(":")));
    }
    for key in ["LANG", "LC_ALL", "LC_CTYPE"] {
        if let Ok(value) = env::var(key) {
            envs.push((key.to_string(), value));
        }
    }
    envs.push(("PWD".to_string(), cwd.to_string_lossy().to_string()));
    envs
}

fn codex_system_cert_file() -> Option<PathBuf> {
    ["/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
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

fn fake_codex_enabled() -> bool {
    env::var("PANDA_BRIDGE_FAKE_CODEX")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn open_web_url(params: &Value) -> String {
    if let Some(url) = string_param(params, "url").filter(|value| !value.trim().is_empty()) {
        return url;
    }
    if let Some(product_id) =
        string_param(params, "product_id").or_else(|| string_param(params, "product"))
    {
        let normalized = normalize_product_key(&product_id);
        if let Some(product) = known_products().into_iter().find(|product| {
            normalize_product_key(product.id) == normalized
                || normalize_product_key(product.name) == normalized
        }) {
            return product.web_url.to_string();
        }
    }
    DEFAULT_WEB.to_string()
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

fn product_param(params: &Value) -> Result<String, String> {
    string_param(params, "product_id")
        .or_else(|| string_param(params, "product"))
        .ok_or_else(|| "missing product_id".to_string())
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
        "headless-bind-local-root" => {
            let map = arg_map(args.collect());
            bind_local_root_headless(&map)
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

    use crate::TEST_ENV_LOCK as ENV_LOCK;

    fn test_job(policy: Value) -> BridgeJob {
        BridgeJob {
            id: "job_1".to_string(),
            product_id: "panda-chat".to_string(),
            kind: "codex.chat".to_string(),
            workspace_ref: Some("default".to_string()),
            input: json!({ "prompt": "hello" }),
            policy,
            request_key: Some("rk_1".to_string()),
            cap_token: None,
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
                authorization: AuthorizationState::Active,
                capabilities: capabilities.into_iter().map(ToOwned::to_owned).collect(),
                policy: test_auth_scope(),
                epoch: 1,
                accounts: Vec::new(),
                local_roots: LocalRootBindings::default(),
                authorized_at: now_string(),
            }],
            device_token_expires_at: None,
            device_token_rotated_at_unix: None,
            install_identity_bound: None,
            device_online: None,
            device_last_seen_at: None,
            connections: Vec::new(),
            claimed_at: now_string(),
        }
    }

    fn cap_token_vector_token() -> String {
        let vectors: Value =
            serde_json::from_str(include_str!("../../../spec/captoken/vectors.json")).unwrap();
        vectors["signature_cases"][0]["token"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn cap_token_vector_policy() -> Value {
        let vectors: Value =
            serde_json::from_str(include_str!("../../../spec/captoken/vectors.json")).unwrap();
        vectors["base_context"]["authorization_policy"].clone()
    }

    fn cap_token_vector_job() -> BridgeJob {
        BridgeJob {
            id: "job_vec_1".to_string(),
            product_id: "panda-chat".to_string(),
            kind: "codex.chat".to_string(),
            workspace_ref: Some("default".to_string()),
            input: json!({ "prompt": "hello" }),
            policy: json!({ "sandbox": "workspace-write", "approvalPolicy": "on-request" }),
            request_key: Some("rk_vec_1".to_string()),
            cap_token: Some(cap_token_vector_token()),
        }
    }

    fn cap_token_vector_credentials(epoch: u64) -> Credentials {
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.device_id = "dev_vec_1".to_string();
        credentials.account_id = Some("user_vec_1".to_string());
        credentials.authorized_products[0].policy = cap_token_vector_policy();
        credentials.authorized_products[0].epoch = epoch;
        credentials
    }

    fn set_cap_token_vector_now() {
        env::set_var("PANDA_BRIDGE_CAPTOKEN_NOW_SECONDS", "1718200100");
    }

    fn reset_policy_env() {
        env::remove_var("PANDA_BRIDGE_ALLOWED_WORKSPACE_ROOTS");
        env::remove_var("PANDA_BRIDGE_ALLOW_APPROVAL_NEVER");
        env::remove_var("PANDA_BRIDGE_ALLOW_DEVELOPER_INSTRUCTIONS");
        env::remove_var("PANDA_BRIDGE_SANDBOX_MODE");
    }

    fn reset_credentials_env() {
        env::remove_var("PANDA_BRIDGE_DESKTOP_STATE");
        env::remove_var("PANDA_BRIDGE_USE_KEYCHAIN");
        env::remove_var("PANDA_BRIDGE_SKIP_KEYCHAIN");
        env::remove_var("PANDA_BRIDGE_SKIP_REMOTE_REVOKE");
    }

    fn restore_env_var(key: &str, value: Option<std::ffi::OsString>) {
        if let Some(value) = value {
            env::set_var(key, value);
        } else {
            env::remove_var(key);
        }
    }

    #[test]
    fn credentials_default_to_private_fallback_file_without_keychain() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = env::temp_dir().join(format!(
            "panda-bridge-credentials-test-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        env::set_var("HOME", &home);
        env::remove_var("USERPROFILE");

        let credentials = test_credentials(vec!["codex.chat"]);
        save_credentials(&credentials).unwrap();
        let path = fallback_credentials_path().unwrap();
        assert!(
            path.exists(),
            "credentials should be written to the private fallback file"
        );
        #[cfg(unix)]
        {
            let dir_mode = fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                dir_mode, 0o700,
                "fallback state directory should be private"
            );
            assert_eq!(file_mode, 0o600, "fallback state file should be private");
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"device_token\""));
        let loaded = load_credentials().unwrap();
        assert_eq!(loaded.device_id, credentials.device_id);
        assert_eq!(loaded.device_token, credentials.device_token);

        delete_credentials().unwrap();
        assert!(
            !path.exists(),
            "delete should remove the fallback state file"
        );

        if let Some(value) = old_home {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }
        if let Some(value) = old_userprofile {
            env::set_var("USERPROFILE", value);
        } else {
            env::remove_var("USERPROFILE");
        }
        reset_credentials_env();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn keychain_is_enabled_by_default_and_skip_disables_it() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        assert!(keychain_enabled(), "keychain should be on by default");
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        assert!(!keychain_enabled(), "skip env should disable keychain");
        reset_credentials_env();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_desktop_state_does_not_chmod_external_parent() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let dir = env::temp_dir().join(format!(
            "panda-bridge-external-state-test-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let state = dir.join("desktop-state.json");
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state);

        save_credentials(&test_credentials(vec!["codex.chat"])).unwrap();

        let parent_mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            parent_mode, 0o755,
            "external parent permissions must be left alone"
        );
        assert_eq!(
            file_mode, 0o600,
            "external state file should still be private"
        );

        reset_credentials_env();
        let _ = fs::remove_dir_all(&dir);
    }

    fn test_auth_scope() -> Value {
        json!({
            "version": "AUTH-SCOPE-v1",
            "preset": "full-access",
            "request_source": "test_full_access_scope",
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

    fn test_full_access_scope() -> Value {
        json!({
            "version": "AUTH-SCOPE-v1",
            "product_id": "panda-chat",
            "source_origin": "http://local.test",
            "capabilities": ["codex.chat", "codex.run", "codex.rpc", "saas.custom.run"],
            "workspace_roots": [{ "id": "all", "path_display": "All local files", "allow_all": true }],
            "sandbox_floor": "danger-full-access",
            "approval_policy_floor": "never",
            "allow_approval_never": true,
            "allow_developer_instructions": true
        })
    }

    fn test_auth_scope_v2() -> Value {
        project_v1_scope_to_v2(&test_auth_scope())
    }

    fn high_risk_root_scope() -> Value {
        json!({
            "version": "AUTH-SCOPE-v2",
            "preset": "high-risk-test",
            "request_source": "test",
            "product_id": "panda-chat",
            "source_origin": "http://local.test",
            "capabilities": ["fs.read", "fs.write", "shell.run"],
            "danger_tiers": {
                "low": { "granted": false, "domains": [] },
                "medium": { "granted": false, "domains": [] },
                "high": { "granted": true, "domains": ["fs"] },
                "critical": { "granted": true, "domains": ["shell"] }
            },
            "domain_boundaries": {
                "fs": { "granted": true, "danger": "high", "boundary_type": "directory_whitelist" },
                "shell": { "granted": true, "danger": "critical", "boundary_type": "command_sandbox" }
            },
            "boundaries": {
                "fs": {
                    "type": "directory_whitelist",
                    "allowed_roots": [{ "id": "root-a", "path_display": "[local]/Read" }],
                    "write_roots": [{ "id": "root-w", "path_display": "[local]/Write" }],
                    "writable": true,
                    "max_bytes": 8388608,
                    "follow_symlinks": false
                },
                "shell": {
                    "type": "command_sandbox",
                    "cwd_root_id": "root-shell",
                    "cwd_root": { "id": "root-shell", "path_display": "[local]/Shell" },
                    "net": "deny",
                    "allow_exec_subtree": false,
                    "cmd_allowlist": [],
                    "max_output_bytes": 1024,
                    "deadline_ms": 1000,
                    "limits": connector::shell::default_limits_json()
                }
            }
        })
    }

    fn test_high_risk_credentials() -> Credentials {
        let mut credentials = test_credentials(vec!["fs.read", "fs.write", "shell.run"]);
        credentials.authorized_products[0].capabilities = vec![
            "fs.read".to_string(),
            "fs.write".to_string(),
            "shell.run".to_string(),
        ];
        credentials.authorized_products[0].policy = high_risk_root_scope();
        credentials
    }

    fn fs_read_job_for(path: &Path) -> BridgeJob {
        BridgeJob {
            kind: "fs.read".to_string(),
            input: json!({ "path": path.to_string_lossy().to_string() }),
            workspace_ref: None,
            ..test_job(json!({}))
        }
    }

    fn local_root_params(domain: &str, root_id: &str, path_display: &str) -> Value {
        json!({
            "product_id": "panda-chat",
            "account": "user_1",
            "domain": domain,
            "root_id": root_id,
            "path_display": path_display
        })
    }

    fn with_state_file(name: &str) -> PathBuf {
        let state_path = env::temp_dir().join(format!("{name}-{}.json", next_event_seq()));
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state_path);
        state_path
    }

    fn connect_intent_payload(policy: Value) -> Value {
        json!({
            "connect_intent": {
                "product_id": "panda-chat",
                "product": {
                    "id": "panda-chat",
                    "name": "Panda Chat",
                    "origin": "http://local.test",
                    "capabilities": ["fs.read", "fs.write", "shell.run"]
                },
                "policy": policy,
                "source_origin": "http://local.test",
                "device_name": "Panda Bridge Desktop",
                "expires_at": "2099-01-01T00:00:00Z",
                "user": {
                    "id": "user_1",
                    "email": "user@example.test"
                }
            }
        })
    }

    fn start_one_shot_json_server(payload: Value) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                let bytes = reader.read_line(&mut line).unwrap_or(0);
                if bytes == 0 || line == "\r\n" || line == "\n" {
                    break;
                }
            }
            write_http_json(&mut stream, 200, payload).unwrap();
        });
        (format!("http://{addr}"), handle)
    }

    fn run_preview_intent_for_policy(policy: Value) -> IntentPreview {
        let (api, server) = start_one_shot_json_server(connect_intent_payload(policy));
        finish_preview_intent(&api, server)
    }

    fn finish_preview_intent(api: &str, server: std::thread::JoinHandle<()>) -> IntentPreview {
        let preview = preview_intent(api, "intent-preview-test").unwrap();
        server.join().unwrap();
        preview
    }

    fn point_credentials_at_api(credentials: &mut Credentials, api: &str) {
        credentials.api_base = api.to_string();
        credentials.cloud_origin = Some(api.to_string());
        for grant in &mut credentials.authorized_products {
            grant.origin = Some(api.to_string());
        }
    }

    fn test_credentials_for_device(
        device_id: &str,
        account_id: &str,
        display: &str,
    ) -> Credentials {
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.device_id = device_id.to_string();
        credentials.device_name = format!("Device {device_id}");
        credentials.account_id = Some(account_id.to_string());
        credentials.account_display = Some(display.to_string());
        credentials
    }

    #[test]
    fn preview_intent_local_root_state_marks_valid_fs_binding_without_leaking_real_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = with_state_file("panda-bridge-preview-root-state-fs");
        let base = env::temp_dir().join(format!(
            "panda-bridge-preview-root-state-fs-{}",
            next_event_seq()
        ));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let canonical = fs::canonicalize(&root)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let (api, server) =
            start_one_shot_json_server(connect_intent_payload(high_risk_root_scope()));
        let mut credentials = test_high_risk_credentials();
        point_credentials_at_api(&mut credentials, &api);
        credentials.authorized_products[0]
            .local_roots
            .fs_roots
            .insert(
                "root-a".to_string(),
                LocalRootBinding {
                    real_path: canonical.clone(),
                    path_display: "[local]/Read".to_string(),
                    bound_at: now_string(),
                    bound_device_id: credentials.device_id.clone(),
                },
            );
        save_credentials(&credentials).unwrap();

        let preview = finish_preview_intent(&api, server);
        let response = serde_json::to_value(&preview).unwrap();
        let state = &response["local_root_state"];
        assert_eq!(state["fs"]["root-a"]["bound"], true);
        assert_eq!(state["fs"]["root-a"]["kind"], "read");
        assert_eq!(state["fs"]["root-a"]["redacted_path"], "[local]/project");
        assert_eq!(state["fs"]["root-w"]["bound"], false);
        assert_eq!(state["fs"]["root-w"]["kind"], "write");
        let state_text = serde_json::to_string(state).unwrap();
        assert!(!state_text.contains(&canonical));
        assert!(!state_text.contains(root.to_string_lossy().as_ref()));
        assert!(!state_text.contains("/Users/"));
        assert!(state_text.contains("[local]/project"));

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn preview_intent_local_root_state_rejects_device_mismatch_and_path_display_drift() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = with_state_file("panda-bridge-preview-root-state-mismatch");
        let base = env::temp_dir().join(format!(
            "panda-bridge-preview-root-state-mismatch-{}",
            next_event_seq()
        ));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let canonical = fs::canonicalize(&root)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let (api, server) =
            start_one_shot_json_server(connect_intent_payload(high_risk_root_scope()));
        let mut credentials = test_high_risk_credentials();
        point_credentials_at_api(&mut credentials, &api);
        credentials.authorized_products[0]
            .local_roots
            .fs_roots
            .insert(
                "root-a".to_string(),
                LocalRootBinding {
                    real_path: canonical.clone(),
                    path_display: "[local]/Read".to_string(),
                    bound_at: now_string(),
                    bound_device_id: "other-device".to_string(),
                },
            );
        save_credentials(&credentials).unwrap();

        let preview = finish_preview_intent(&api, server);
        let response = serde_json::to_value(&preview).unwrap();
        assert_eq!(response["local_root_state"]["fs"]["root-a"]["bound"], false);
        assert_eq!(
            response["local_root_state"]["fs"]["root-a"]["redacted_path"],
            Value::Null
        );

        credentials.authorized_products[0]
            .local_roots
            .fs_roots
            .get_mut("root-a")
            .unwrap()
            .bound_device_id = credentials.device_id.clone();
        credentials.authorized_products[0]
            .local_roots
            .fs_roots
            .get_mut("root-a")
            .unwrap()
            .path_display = "[local]/Old".to_string();
        let (api, server) =
            start_one_shot_json_server(connect_intent_payload(high_risk_root_scope()));
        point_credentials_at_api(&mut credentials, &api);
        save_credentials(&credentials).unwrap();

        let preview = finish_preview_intent(&api, server);
        let response = serde_json::to_value(&preview).unwrap();
        assert_eq!(response["local_root_state"]["fs"]["root-a"]["bound"], false);
        assert_eq!(
            response["local_root_state"]["fs"]["root-a"]["redacted_path"],
            Value::Null
        );
        assert!(!serde_json::to_string(&response["local_root_state"])
            .unwrap()
            .contains(&canonical));

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn preview_intent_local_root_state_marks_declared_roots_unbound_without_existing_grant() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = with_state_file("panda-bridge-preview-root-state-first-auth");

        let preview = run_preview_intent_for_policy(high_risk_root_scope());
        let response = serde_json::to_value(&preview).unwrap();
        let state = &response["local_root_state"];
        assert_eq!(state["fs"]["root-a"]["bound"], false);
        assert_eq!(state["fs"]["root-a"]["kind"], "read");
        assert_eq!(state["fs"]["root-a"]["redacted_path"], Value::Null);
        assert_eq!(state["fs"]["root-w"]["bound"], false);
        assert_eq!(state["fs"]["root-w"]["kind"], "write");
        assert_eq!(state["fs"]["root-w"]["redacted_path"], Value::Null);
        assert_eq!(state["shell"]["root-shell"]["bound"], false);
        assert_eq!(state["shell"]["root-shell"]["redacted_path"], Value::Null);

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn preview_intent_local_root_state_marks_valid_shell_cwd_binding_without_kind() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = with_state_file("panda-bridge-preview-root-state-shell");
        let base = env::temp_dir().join(format!(
            "panda-bridge-preview-root-state-shell-{}",
            next_event_seq()
        ));
        let root = base.join("shell");
        fs::create_dir_all(&root).unwrap();
        let canonical = fs::canonicalize(&root)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let (api, server) =
            start_one_shot_json_server(connect_intent_payload(high_risk_root_scope()));
        let mut credentials = test_high_risk_credentials();
        point_credentials_at_api(&mut credentials, &api);
        credentials.authorized_products[0]
            .local_roots
            .shell_cwd
            .insert(
                "root-shell".to_string(),
                LocalRootBinding {
                    real_path: canonical.clone(),
                    path_display: "[local]/Shell".to_string(),
                    bound_at: now_string(),
                    bound_device_id: credentials.device_id.clone(),
                },
            );
        save_credentials(&credentials).unwrap();

        let preview = finish_preview_intent(&api, server);
        let response = serde_json::to_value(&preview).unwrap();
        let shell = &response["local_root_state"]["shell"]["root-shell"];
        assert_eq!(shell["bound"], true);
        assert_eq!(shell["redacted_path"], "[local]/shell");
        assert!(shell.get("kind").is_none());
        let state_text = serde_json::to_string(&response["local_root_state"]).unwrap();
        assert!(!state_text.contains(&canonical));
        assert!(!state_text.contains("/Users/"));
        assert!(state_text.contains("[local]/shell"));

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn cloud_devices_cleanup_removes_stale_connections_for_account() {
        let mut connections = vec![
            test_credentials_for_device("dev_keep", "user_1", "user@example.test"),
            test_credentials_for_device("dev_stale", "user_1", "user@example.test"),
            test_credentials_for_device("dev_other", "user_2", "other@example.test"),
        ];
        let changed = apply_cloud_devices_to_connections(
            &mut connections,
            "http://local.test",
            Some("user_1"),
            Some(&[CloudDevice {
                id: "dev_keep".to_string(),
                name: Some("Current Mac".to_string()),
                online: Some(true),
                last_seen_at: Some("2026-06-11T00:00:00Z".to_string()),
            }]),
        );
        assert!(changed);
        assert_eq!(connections.len(), 2);
        assert!(connections.iter().any(|item| item.device_id == "dev_keep"));
        assert!(!connections.iter().any(|item| item.device_id == "dev_stale"));
        let kept = connections
            .iter()
            .find(|item| item.device_id == "dev_keep")
            .unwrap();
        assert_eq!(kept.device_name, "Current Mac");
        assert_eq!(kept.device_online, Some(true));
        assert_eq!(
            kept.device_last_seen_at.as_deref(),
            Some("2026-06-11T00:00:00Z")
        );
        assert!(connections.iter().any(|item| item.device_id == "dev_other"));
    }

    #[test]
    fn cloud_devices_cleanup_skips_when_response_has_no_devices() {
        let mut connections = vec![
            test_credentials_for_device("dev_keep", "user_1", "user@example.test"),
            test_credentials_for_device("dev_stale", "user_1", "user@example.test"),
        ];
        let changed = apply_cloud_devices_to_connections(
            &mut connections,
            "http://local.test",
            Some("user_1"),
            None,
        );
        assert!(!changed);
        assert_eq!(connections.len(), 2);
    }

    #[test]
    fn aggregate_products_dedupes_accounts_and_keeps_device_rows() {
        let mut one = test_credentials_for_device("dev_1", "user_1", "user@example.test");
        one.device_online = Some(true);
        one.device_last_seen_at = Some("2026-06-11T00:00:00Z".to_string());
        let mut two = test_credentials_for_device("dev_2", "user_1", "user@example.test");
        two.device_online = Some(false);
        let products = aggregate_authorized_products(&[one, two]);
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].accounts.len(), 1);
        assert_eq!(products[0].accounts[0].devices.len(), 2);
        assert!(products[0].accounts[0]
            .devices
            .iter()
            .any(|item| item.id == "dev_1" && item.online == Some(true)));
        assert!(products[0].accounts[0]
            .devices
            .iter()
            .any(|item| item.id == "dev_2" && item.online == Some(false)));
    }

    #[test]
    fn authorization_toggle_pauses_and_restores_account_product() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = env::temp_dir().join(format!(
            "panda-bridge-toggle-test-{}.json",
            next_event_seq()
        ));
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state_path);
        let credentials = test_credentials(vec!["codex.chat"]);
        save_credentials(&credentials).unwrap();

        let paused = toggle_authorization("otherline", "user@example.test").unwrap();
        assert_eq!(paused["authorized"], "paused");
        let loaded = load_credentials().unwrap();
        assert_eq!(
            loaded.connections[0].authorized_products[0].authorization,
            AuthorizationState::Paused
        );
        assert!(authorized_connections(&loaded).is_empty());

        let restored = toggle_authorization("otherline", "user@example.test").unwrap();
        assert_eq!(restored["authorized"], "active");
        let loaded = load_credentials().unwrap();
        assert_eq!(
            loaded.connections[0].authorized_products[0].authorization,
            AuthorizationState::Active
        );
        assert_eq!(authorized_connections(&loaded).len(), 1);

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn remove_authorization_deletes_local_account_product() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = env::temp_dir().join(format!(
            "panda-bridge-remove-test-{}.json",
            next_event_seq()
        ));
        env::set_var("PANDA_BRIDGE_DESKTOP_STATE", &state_path);
        env::set_var("PANDA_BRIDGE_SKIP_REMOTE_REVOKE", "1");
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.api_base = "http://127.0.0.1:9".to_string();
        save_credentials(&credentials).unwrap();

        let removed = revoke_authorization("otherline", Some("user@example.test"), None).unwrap();
        assert_eq!(removed["ok"], true);
        let loaded = load_credentials().unwrap();
        assert!(credentials_products(&loaded).is_empty());

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn pick_local_root_binding_persists_and_injects_fs_path() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::remove_var(connector::fs::FS_ALLOWED_ROOTS_ENV);
        let state_path = with_state_file("panda-bridge-root-bind-test");
        let base = env::temp_dir().join(format!("panda-bridge-root-bind-{}", next_event_seq()));
        let root = base.join("project");
        let file = root.join("hello.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&file, "hello").unwrap();
        save_credentials(&test_high_risk_credentials()).unwrap();

        let response = bind_local_root_path(
            &local_root_params("fs_read", "root-a", "[local]/Read"),
            &root,
        )
        .unwrap();
        assert_eq!(response["root_id"], "root-a");
        assert_eq!(response["path_display"], "[local]/Read");
        assert_eq!(response["redacted_real_path"], "[local]/project");
        assert!(!response
            .to_string()
            .contains(root.to_string_lossy().as_ref()));

        let loaded = load_credentials().unwrap();
        let connection = &loaded.connections[0];
        let grant = &connection.authorized_products[0];
        let binding = grant.local_roots.fs_roots.get("root-a").unwrap();
        assert_eq!(
            binding.real_path,
            fs::canonicalize(&root)
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        let registry = declaration_registry();
        let boundary = build_granted_boundary(
            &registry,
            grant,
            &fs_read_job_for(&file),
            &connection.device_id,
        )
        .unwrap();
        assert_eq!(
            boundary.raw["_local_paths"]["root-a"],
            fs::canonicalize(&root)
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert!(!serde_json::to_string(&credentials_products(&loaded))
            .unwrap()
            .contains("real_path"));

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn headless_bind_local_root_infers_account_and_path_display() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::remove_var(connector::fs::FS_ALLOWED_ROOTS_ENV);
        let state_path = with_state_file("panda-bridge-headless-root-bind-test");
        let base = env::temp_dir().join(format!(
            "panda-bridge-headless-root-bind-{}",
            next_event_seq()
        ));
        let root = base.join("project");
        let file = root.join("seed.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&file, "seed").unwrap();
        let mut credentials = test_high_risk_credentials();
        credentials.product_id = Some("panda-notes".to_string());
        credentials.product_name = Some("Panda Notes".to_string());
        credentials.authorized_products[0].id = "panda-notes".to_string();
        credentials.authorized_products[0].name = "Panda Notes".to_string();
        credentials.authorized_products[0].policy["product_id"] = json!("panda-notes");
        save_credentials(&credentials).unwrap();

        let mut map = std::collections::BTreeMap::new();
        map.insert("product-id".to_string(), "panda-notes".to_string());
        map.insert("root-id".to_string(), "root-a".to_string());
        map.insert("domain".to_string(), "fs_read".to_string());
        map.insert("path".to_string(), root.to_string_lossy().to_string());
        let response = bind_local_root_headless(&map).unwrap();
        assert_eq!(response["root_id"], "root-a");
        assert_eq!(response["path_display"], "[local]/Read");
        assert!(!response
            .to_string()
            .contains(root.to_string_lossy().as_ref()));

        let loaded = load_credentials().unwrap();
        let connection = &loaded.connections[0];
        let grant = connection
            .authorized_products
            .iter()
            .find(|grant| grant.id == "panda-notes")
            .unwrap();
        let registry = declaration_registry();
        let mut job = fs_read_job_for(&file);
        job.product_id = "panda-notes".to_string();
        let boundary =
            build_granted_boundary(&registry, grant, &job, &connection.device_id).unwrap();
        assert_eq!(
            boundary.raw["_local_paths"]["root-a"],
            fs::canonicalize(&root)
                .unwrap()
                .to_string_lossy()
                .to_string()
        );

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn pick_local_root_binding_persists_and_injects_shell_cwd() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::remove_var(connector::shell::SHELL_CWD_ROOTS_ENV);
        let state_path = with_state_file("panda-bridge-shell-root-bind-test");
        let root =
            env::temp_dir().join(format!("panda-bridge-shell-root-bind-{}", next_event_seq()));
        fs::create_dir_all(&root).unwrap();
        save_credentials(&test_high_risk_credentials()).unwrap();

        let response = bind_local_root_path(
            &local_root_params("shell_cwd", "root-shell", "[local]/Shell"),
            &root,
        )
        .unwrap();
        assert_eq!(response["root_id"], "root-shell");
        assert_eq!(response["path_display"], "[local]/Shell");
        assert!(response["redacted_real_path"]
            .as_str()
            .unwrap()
            .starts_with("[local]/panda-bridge-shell-root-bind-"));

        let loaded = load_credentials().unwrap();
        let connection = &loaded.connections[0];
        let grant = &connection.authorized_products[0];
        let registry = declaration_registry();
        let job = BridgeJob {
            kind: "shell.run".to_string(),
            input: json!({ "argv": ["/bin/echo", "ok"] }),
            workspace_ref: None,
            ..test_job(json!({}))
        };
        let boundary =
            build_granted_boundary(&registry, grant, &job, &connection.device_id).unwrap();
        assert_eq!(
            boundary.raw["_local_cwd"],
            fs::canonicalize(&root)
                .unwrap()
                .to_string_lossy()
                .to_string()
        );

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pick_local_root_rejects_sensitive_unknown_and_broad_without_confirm() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let state_path = with_state_file("panda-bridge-root-deny-test");
        let base = env::temp_dir().join(format!("panda-bridge-root-deny-{}", next_event_seq()));
        let normal = base.join("normal");
        let home = base.join("home");
        let documents = home.join("Documents");
        fs::create_dir_all(&normal).unwrap();
        fs::create_dir_all(&documents).unwrap();
        env::set_var("HOME", &home);
        save_credentials(&test_high_risk_credentials()).unwrap();

        assert_eq!(
            bind_local_root_path(
                &local_root_params("fs_read", "root-a", "[local]/Read"),
                Path::new("/")
            )
            .unwrap_err(),
            "root_denied_sensitive"
        );
        assert_eq!(
            bind_local_root_path(
                &local_root_params("fs_read", "missing-root", "[local]/Read"),
                &normal,
            )
            .unwrap_err(),
            "unknown_root_id"
        );
        assert_eq!(
            bind_local_root_path(
                &local_root_params("fs_read", "root-a", "[local]/Read"),
                &documents
            )
            .unwrap_err(),
            "root_warn_broad"
        );
        let mut confirmed = local_root_params("fs_read", "root-a", "[local]/Read");
        confirmed["confirm"] = json!(true);
        assert!(bind_local_root_path(&confirmed, &documents).is_ok());

        let loaded = load_credentials().unwrap();
        assert!(loaded.connections[0].authorized_products[0]
            .local_roots
            .fs_roots
            .contains_key("root-a"));

        if let Some(value) = old_home {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }
        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn local_root_injection_requires_device_and_current_path_display() {
        let base =
            env::temp_dir().join(format!("panda-bridge-root-injection-{}", next_event_seq()));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        let credentials = test_high_risk_credentials();
        let mut grant = credentials.authorized_products[0].clone();
        grant.local_roots.fs_roots.insert(
            "root-a".to_string(),
            LocalRootBinding {
                real_path: fs::canonicalize(&root)
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
                path_display: "[local]/Read".to_string(),
                bound_at: now_string(),
                bound_device_id: "other-device".to_string(),
            },
        );
        let registry = declaration_registry();
        let job = fs_read_job_for(&root.join("file.txt"));
        let no_device_match =
            build_granted_boundary(&registry, &grant, &job, &credentials.device_id).unwrap();
        assert!(no_device_match.raw.get("_local_paths").is_none());

        grant
            .local_roots
            .fs_roots
            .get_mut("root-a")
            .unwrap()
            .bound_device_id = credentials.device_id.clone();
        grant
            .local_roots
            .fs_roots
            .get_mut("root-a")
            .unwrap()
            .path_display = "[local]/Old".to_string();
        let drifted =
            build_granted_boundary(&registry, &grant, &job, &credentials.device_id).unwrap();
        assert!(drifted.raw.get("_local_paths").is_none());

        grant
            .local_roots
            .fs_roots
            .get_mut("root-a")
            .unwrap()
            .path_display = "[local]/Read".to_string();
        let injected =
            build_granted_boundary(&registry, &grant, &job, &credentials.device_id).unwrap();
        assert!(injected.raw.get("_local_paths").is_some());

        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn build_granted_boundary_strips_caller_smuggled_local_paths() {
        // P0: a caller must not be able to smuggle `_local_paths` through their
        // requested boundaries (which persist into grant.policy) to control the
        // real path. With zero bindings the choke point strips it; the
        // attacker path never reaches the connector boundary.
        let credentials = test_high_risk_credentials();
        let mut grant = credentials.authorized_products[0].clone();
        grant.local_roots.fs_roots.clear();
        grant.local_roots.shell_cwd.clear();
        grant
            .policy
            .pointer_mut("/boundaries/fs")
            .and_then(Value::as_object_mut)
            .expect("fixture has boundaries.fs")
            .insert(
                "_local_paths".to_string(),
                json!({ "root-a": "/etc/victim-secret" }),
            );
        let registry = declaration_registry();
        let job = fs_read_job_for(Path::new("/etc/victim-secret/file.txt"));
        let boundary =
            build_granted_boundary(&registry, &grant, &job, &credentials.device_id).unwrap();
        assert!(
            boundary.raw.get("_local_paths").is_none(),
            "caller-smuggled _local_paths must be stripped before the connector"
        );
        assert!(
            !serde_json::to_string(&boundary.raw)
                .unwrap()
                .contains("/etc/victim-secret"),
            "attacker real path must never reach the connector boundary"
        );
    }

    #[test]
    fn remove_authorization_clears_local_root_bindings_with_grant() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let state_path = with_state_file("panda-bridge-root-revoke-test");
        env::set_var("PANDA_BRIDGE_SKIP_REMOTE_REVOKE", "1");
        let base = env::temp_dir().join(format!("panda-bridge-root-revoke-{}", next_event_seq()));
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        let mut credentials = test_high_risk_credentials();
        credentials.api_base = "http://127.0.0.1:9".to_string();
        credentials.authorized_products[0]
            .local_roots
            .fs_roots
            .insert(
                "root-a".to_string(),
                LocalRootBinding {
                    real_path: fs::canonicalize(&root)
                        .unwrap()
                        .to_string_lossy()
                        .to_string(),
                    path_display: "[local]/Read".to_string(),
                    bound_at: now_string(),
                    bound_device_id: credentials.device_id.clone(),
                },
            );
        save_credentials(&credentials).unwrap();

        let removed = revoke_authorization("otherline", Some("user@example.test"), None).unwrap();
        assert_eq!(removed["ok"], true);
        let loaded = load_credentials().unwrap();
        assert!(credentials_products(&loaded).is_empty());
        let text = fs::read_to_string(&state_path).unwrap();
        assert!(!text.contains("local_roots"));
        assert!(!text.contains(root.to_string_lossy().as_ref()));

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn update_settings_persists_switches_and_manages_launch_agent() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        let old_home = env::var_os("HOME");
        let home = env::temp_dir().join(format!("panda-bridge-settings-test-{}", next_event_seq()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        env::set_var("HOME", &home);

        let updated = update_settings(&json!({
            "launch_at_login": true,
            "appearance": "dark",
            "language": "ja"
        }))
        .unwrap();
        assert!(updated.launch_at_login);
        assert_eq!(updated.appearance, "dark");
        assert_eq!(updated.language, "ja");
        let reloaded = load_settings_with_api(DEFAULT_API);
        assert!(reloaded.launch_at_login);
        assert_eq!(reloaded.appearance, "dark");
        assert_eq!(reloaded.language, "ja");
        assert_eq!(reloaded.api_base, DEFAULT_API);
        #[cfg(target_os = "macos")]
        {
            let plist = home.join("Library/LaunchAgents/cc.otherline.panda-bridge.plist");
            assert!(
                plist.exists(),
                "enabling launch_at_login should write the LaunchAgent"
            );
            let text = fs::read_to_string(&plist).unwrap();
            assert!(text.contains("cc.otherline.panda-bridge"));
            assert!(text.contains("<key>RunAtLoad</key>"));
        }

        let updated = update_settings(&json!({ "launch_at_login": false })).unwrap();
        assert!(!updated.launch_at_login);
        #[cfg(target_os = "macos")]
        {
            let plist = home.join("Library/LaunchAgents/cc.otherline.panda-bridge.plist");
            assert!(
                !plist.exists(),
                "disabling launch_at_login should remove the LaunchAgent"
            );
        }

        assert!(update_settings(&json!({ "appearance": "neon" })).is_err());
        assert!(update_settings(&json!({ "language": "fr" })).is_err());
        assert!(launch_agent_plist("/Apps/A&B.app/Contents/MacOS/pb").contains("A&amp;B.app"));

        if let Some(value) = old_home {
            env::set_var("HOME", value);
        } else {
            env::remove_var("HOME");
        }
        reset_credentials_env();
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn reconnect_backoff_uses_exponential_delays_and_reset() {
        let mut backoff = ReconnectBackoff {
            attempt: 0,
            base_ms: 1_000,
            max_ms: 8_000,
        };
        assert_eq!(backoff.next_delay_ms(), 1_000);
        assert_eq!(backoff.next_delay_ms(), 2_000);
        assert_eq!(backoff.next_delay_ms(), 4_000);
        assert_eq!(backoff.next_delay_ms(), 8_000);
        assert_eq!(backoff.next_delay_ms(), 8_000);
        backoff.reset();
        assert_eq!(backoff.next_delay_ms(), 1_000);
    }

    #[test]
    fn status_serializes_account_level_dual_switches() {
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.authorized_products[0].authorization = AuthorizationState::Paused;
        let state = new_app_state();
        state.worker_running.store(true, Ordering::SeqCst);
        state.realtime_connected.store(true, Ordering::SeqCst);

        let products = desktop_products(Some(&credentials), &state);
        let otherline = products
            .iter()
            .find(|product| product.id == "otherline")
            .unwrap();
        assert_eq!(otherline.accounts.len(), 1);
        assert_eq!(otherline.accounts[0].authorized, AuthorizationState::Paused);
        assert!(!otherline.accounts[0].connected);
        assert_eq!(otherline.accounts[0].connection, "disabled");

        let serialized = serde_json::to_value(otherline).unwrap();
        assert_eq!(serialized["accounts"][0]["authorized"], "paused");
        assert_eq!(serialized["accounts"][0]["connected"], false);

        credentials.authorized_products[0].authorization = AuthorizationState::Active;
        let products = desktop_products(Some(&credentials), &state);
        let account = &products
            .iter()
            .find(|product| product.id == "otherline")
            .unwrap()
            .accounts[0];
        assert_eq!(account.authorized, AuthorizationState::Active);
        assert!(account.connected);
        assert_eq!(account.connection, "connected");
    }

    #[test]
    fn scope_widening_detects_material_expansion() {
        let base = test_auth_scope();
        assert!(!is_scope_widening(&base, &base));
        let mut caps = base.clone();
        caps["capabilities"] = json!(["codex.chat", "codex.run", "codex.rpc"]);
        assert!(is_scope_widening(&base, &caps));
        let mut workspace = base.clone();
        workspace["workspace_roots"] = json!([{ "id": "all", "allow_all": true }]);
        assert!(is_scope_widening(&base, &workspace));
        let mut sandbox = base.clone();
        sandbox["sandbox_floor"] = json!("danger-full-access");
        assert!(is_scope_widening(&base, &sandbox));
        let mut approval = base.clone();
        approval["approval_policy_floor"] = json!("never");
        approval["allow_approval_never"] = json!(true);
        assert!(is_scope_widening(&base, &approval));
        let mut dev = base.clone();
        dev["allow_developer_instructions"] = json!(true);
        assert!(is_scope_widening(&base, &dev));
    }

    #[test]
    fn scope_diff_reports_light_confirmation_when_not_widening() {
        let base = test_auth_scope();
        let diff = scope_diff(&base, &base);
        assert_eq!(diff["widening"], false);
        assert!(diff["capabilities"]["added"].as_array().unwrap().is_empty());
    }

    #[test]
    fn confirmation_mode_is_light_only_for_existing_non_widening_grant() {
        let grant = test_credentials(vec!["codex.chat"])
            .authorized_products
            .remove(0);
        assert_eq!(
            confirmation_mode_for_existing_grant(Some(&grant), false),
            "light"
        );
        assert_eq!(
            confirmation_mode_for_existing_grant(Some(&grant), true),
            "full"
        );
        assert_eq!(confirmation_mode_for_existing_grant(None, false), "full");
    }

    #[test]
    fn heartbeat_interval_defaults_to_thirty_seconds_and_allows_env_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS");
        assert_eq!(heartbeat_interval_ms(), 30_000);
        env::set_var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS", "1234");
        assert_eq!(heartbeat_interval_ms(), 1234);
        env::remove_var("PANDA_BRIDGE_HEARTBEAT_INTERVAL_MS");
    }

    #[test]
    fn local_policy_preview_defaults_to_low_tier_v2() {
        let preview = local_policy_preview();
        assert_eq!(preview["version"], "AUTH-SCOPE-v2");
        assert_eq!(preview["preset"], "workspace-default");
        assert_eq!(preview["request_source"], "desktop_fallback_low_tier");
        assert_eq!(
            preview["capabilities"],
            json!(["codex.chat", "codex.run", "codex.rpc"])
        );
        assert_eq!(
            preview["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("saas.custom.run")),
            false
        );
        assert_eq!(
            preview["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("fs.read")),
            false
        );
        assert_eq!(
            preview["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("fs.write")),
            false
        );
        assert_eq!(
            preview["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item.as_str() == Some("shell.run")),
            false
        );
        assert_eq!(
            preview["workspace_roots"],
            json!([{ "id": "default", "path_display": "[local]/default" }])
        );
        assert_eq!(preview["sandbox_floor"], "workspace-write");
        assert_eq!(preview["approval_policy_floor"], "on-request");
        assert_eq!(preview["allow_approval_never"], false);
        assert_eq!(preview["allow_developer_instructions"], false);
        assert_eq!(preview["danger_tiers"]["low"]["granted"], true);
        assert_eq!(preview["danger_tiers"]["medium"]["granted"], false);
        assert_eq!(preview["danger_tiers"]["high"]["granted"], false);
        assert_eq!(preview["danger_tiers"]["critical"]["granted"], false);
        assert_eq!(
            preview["domain_boundaries"]["codex"],
            json!({
                "granted": true,
                "danger": "low",
                "boundary_type": "workspace_sandbox"
            })
        );
        assert_eq!(
            capabilities()["runtime"],
            json!([
                "codex.chat",
                "codex.rpc",
                "codex.run",
                "data.delete",
                "data.get",
                "data.put",
                "data.query",
                "fs.read",
                "fs.write",
                "shell.run"
            ])
        );
    }

    #[test]
    fn codex_fixture_runs_through_registry_without_result_regression() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        env::set_var("PANDA_BRIDGE_FAKE_CODEX", "1");
        let mut registry = declaration_registry();
        let result = execute_via_registry(
            &mut registry,
            &test_credentials(vec!["codex.chat"]),
            &test_job(json!({})),
        )
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["reply"], "Panda Bridge fixture reply: hello");
        assert_eq!(result["fixture"], true);
        assert_eq!(result["cloud_openai_credentials"], false);
        env::remove_var("PANDA_BRIDGE_FAKE_CODEX");
    }

    #[test]
    fn codex_clean_env_points_to_system_ca_bundle_when_available() {
        let cert_file = codex_system_cert_file();
        let envs = codex_clean_env(
            Path::new("/tmp/workspace"),
            Path::new("/usr/bin/codex"),
            Path::new("/tmp/codex-home"),
            Path::new("/tmp/codex-tmp"),
        );
        let ssl_cert_file = envs
            .iter()
            .find(|(key, _)| key == "SSL_CERT_FILE")
            .map(|(_, value)| PathBuf::from(value));
        assert_eq!(ssl_cert_file, cert_file);
    }

    #[test]
    fn codex_read_only_sandbox_spec_keeps_workspace_out_of_write_roots() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let old_codex_home = env::var_os("CODEX_HOME");
        let old_runtime_bin = env::var_os("PANDA_BRIDGE_CODEX_RUNTIME_BIN");
        let old_codex_cwd = env::var_os("PANDA_BRIDGE_CODEX_CWD");
        let base = env::temp_dir().join(format!(
            "panda-bridge-readonly-spec-test-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        let workspace_raw = base.join("workspace");
        let codex_home = base.join("codex-home");
        fs::create_dir_all(&workspace_raw).unwrap();
        fs::create_dir_all(&codex_home).unwrap();
        let workspace = fs::canonicalize(&workspace_raw).unwrap();
        env::set_var("PANDA_BRIDGE_CODEX_CWD", &workspace);
        env::set_var("CODEX_HOME", &codex_home);
        env::set_var(
            "PANDA_BRIDGE_CODEX_RUNTIME_BIN",
            env::current_exe().unwrap(),
        );

        let boundary = GrantedBoundary {
            product_id: "panda-chat".to_string(),
            product_name: "Panda Chat".to_string(),
            domain: "codex".to_string(),
            boundary_type: connector::BoundaryType::WorkspaceSandbox,
            capabilities: vec!["codex.chat".to_string()],
            raw: test_auth_scope(),
        };
        let read_only =
            build_codex_sandbox_spec(&test_job(json!({ "sandbox": "read-only" })), &boundary)
                .unwrap();
        let tmp_dir = read_only
            .env_allow
            .iter()
            .find(|(key, _)| key == "TMPDIR")
            .map(|(_, value)| PathBuf::from(value))
            .unwrap();

        assert_eq!(read_only.net, NetPolicy::Deny);
        assert!(read_only.read_roots.contains(&workspace));
        assert!(read_only.read_roots.contains(&tmp_dir));
        assert!(!tmp_dir.starts_with(&workspace));
        assert!(!read_only.write_roots.contains(&workspace));
        assert!(
            !read_only
                .write_roots
                .iter()
                .any(|root| workspace.starts_with(root)),
            "read-only write roots must not cover the workspace: {:?}",
            read_only.write_roots
        );
        assert!(read_only.write_roots.contains(&codex_home));
        assert!(read_only.write_roots.contains(&tmp_dir));

        let workspace_write = build_codex_sandbox_spec(
            &test_job(json!({ "sandbox": "workspace-write" })),
            &boundary,
        )
        .unwrap();
        assert_eq!(workspace_write.net, NetPolicy::AllowOutbound);
        assert!(workspace_write.write_roots.contains(&workspace));

        restore_env_var("CODEX_HOME", old_codex_home);
        restore_env_var("PANDA_BRIDGE_CODEX_RUNTIME_BIN", old_runtime_bin);
        restore_env_var("PANDA_BRIDGE_CODEX_CWD", old_codex_cwd);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn data_registry_path_rejects_cross_product_namespace_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let mut credentials = test_credentials(vec!["data.put"]);
        credentials.authorized_products[0].policy = json!({
            "version": "AUTH-SCOPE-v2",
            "product_id": "panda-chat",
            "capabilities": ["data.put"],
            "boundaries": {
                "data": {
                    "type": "namespace_kv",
                    "owner_product_id": "panda-chat",
                    "namespace": "product:panda-chat",
                    "max_key_bytes": 512,
                    "max_value_bytes": 262144,
                    "allow_query": true,
                    "allow_delete": true
                }
            }
        });
        let job = BridgeJob {
            kind: "data.put".to_string(),
            input: json!({ "ns": "product:otherline", "key": "x", "value": 1 }),
            ..test_job(json!({}))
        };
        let mut registry = declaration_registry();
        let result = execute_via_registry(&mut registry, &credentials, &job).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"], "local_policy_denied");
        assert_eq!(result["denied"], "namespace");
        assert_eq!(result["reason"], "namespace_not_owned_locally");
    }

    #[test]
    fn intent_authorization_policy_defaults_to_low_tier_v2() {
        let intent = ConnectIntent {
            product_id: "panda-chat".to_string(),
            product: None,
            policy: json!({}),
            source_origin: Some("http://local.test".to_string()),
            device_name: Some("Device".to_string()),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
            user: None,
        };
        let product_capabilities = vec![
            "codex.chat".to_string(),
            "codex.run".to_string(),
            "codex.rpc".to_string(),
            "saas.custom.run".to_string(),
        ];
        let policy = intent_authorization_policy(
            &intent,
            "panda-chat",
            "http://local.test",
            &product_capabilities,
        );
        assert_eq!(policy["version"], "AUTH-SCOPE-v2");
        assert_eq!(policy["preset"], "workspace-default");
        assert_eq!(policy["request_source"], "desktop_fallback_low_tier");
        assert_eq!(
            policy["capabilities"],
            json!(["codex.chat", "codex.run", "codex.rpc"])
        );
        assert_eq!(
            policy["workspace_roots"],
            json!([{ "id": "default", "path_display": "[local]/default" }])
        );
        assert_eq!(policy["sandbox_floor"], "workspace-write");
        assert_eq!(policy["approval_policy_floor"], "on-request");
        assert_eq!(policy["allow_approval_never"], false);
        assert_eq!(policy["allow_developer_instructions"], false);
        assert_eq!(policy["danger_tiers"]["critical"]["granted"], false);
    }

    #[test]
    fn default_policy_is_allowed_for_authorized_capability() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({}));
        let scope = test_auth_scope();
        let policy =
            effective_job_policy(&job, Some(&scope)).expect("default policy should be allowed");
        assert_eq!(policy.sandbox, "workspace-write");
        assert_eq!(policy.approval_policy, "on-request");
        validate_local_job_authorization(&test_credentials(vec!["codex.chat"]), &job).unwrap();
    }

    #[test]
    fn v2_auth_scope_is_accepted_locally_without_weakening_floors() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({}));
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.authorized_products[0].policy = test_auth_scope_v2();
        let policy =
            effective_job_policy(&job, Some(&credentials.authorized_products[0].policy)).unwrap();
        assert_eq!(policy.sandbox, "workspace-write");
        assert_eq!(policy.approval_policy, "on-request");
        validate_local_job_authorization(&credentials, &job).unwrap();

        assert_eq!(
            effective_job_policy(
                &test_job(json!({ "sandbox": "danger-full-access" })),
                Some(&credentials.authorized_products[0].policy)
            )
            .unwrap_err(),
            "sandbox_not_allowed_locally: danger-full-access"
        );
        assert_eq!(
            effective_job_policy(
                &test_job(json!({ "approvalPolicy": "never" })),
                Some(&credentials.authorized_products[0].policy)
            )
            .unwrap_err(),
            "approval_policy_not_allowed_locally: never"
        );
    }

    #[test]
    fn v1_auth_scope_still_uses_legacy_flat_path_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({}));
        let credentials = test_credentials(vec!["codex.chat"]);
        assert_eq!(
            credentials.authorized_products[0].policy["version"],
            "AUTH-SCOPE-v1"
        );
        validate_local_job_authorization(&credentials, &job).unwrap();
    }

    #[test]
    fn v2_scope_does_not_grant_custom_runtime_by_default_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let mut credentials = test_credentials(vec!["codex.chat", "saas.custom.run"]);
        credentials.authorized_products[0].policy = test_auth_scope_v2();
        let job = BridgeJob {
            kind: "saas.custom.run".to_string(),
            ..test_job(json!({}))
        };
        let error = validate_local_job_authorization(&credentials, &job).unwrap_err();
        assert_eq!(
            error,
            "capability_not_authorized_locally: panda-chat:saas.custom.run"
        );
    }

    #[test]
    fn fs_read_requires_v2_high_tier_grant_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = BridgeJob {
            kind: "fs.read".to_string(),
            input: json!({ "path": "/tmp/panda-bridge-fs-read-test.txt" }),
            workspace_ref: None,
            ..test_job(json!({}))
        };
        let write_job = BridgeJob {
            kind: "fs.write".to_string(),
            input: json!({
                "path": "/tmp/panda-bridge-fs-write-test.txt",
                "text": "hello",
                "mode": "create_new"
            }),
            workspace_ref: None,
            ..test_job(json!({}))
        };

        let mut v1_credentials = test_credentials(vec!["fs.read"]);
        v1_credentials.authorized_products[0].policy["capabilities"] = json!(["fs.read"]);
        let mut registry = declaration_registry();
        let v1_result = execute_via_registry(&mut registry, &v1_credentials, &job).unwrap();
        assert_eq!(v1_result["ok"], false);
        assert_eq!(v1_result["denied"], "tier");
        assert_eq!(v1_result["reason"], "tier_not_granted_locally");

        let mut v1_write_credentials = test_credentials(vec!["fs.write"]);
        v1_write_credentials.authorized_products[0].policy["capabilities"] = json!(["fs.write"]);
        let mut registry = declaration_registry();
        let v1_write_result =
            execute_via_registry(&mut registry, &v1_write_credentials, &write_job).unwrap();
        assert_eq!(v1_write_result["ok"], false);
        assert_eq!(v1_write_result["denied"], "tier");
        assert_eq!(v1_write_result["reason"], "tier_not_granted_locally");

        let mut v2_missing_tier = test_credentials(vec!["fs.read"]);
        v2_missing_tier.authorized_products[0].policy = json!({
            "version": "AUTH-SCOPE-v2",
            "product_id": "panda-dev",
            "capabilities": ["fs.read"],
            "danger_tiers": {
                "low": { "granted": false, "domains": [] },
                "medium": { "granted": false, "domains": [] },
                "high": { "granted": false, "domains": [] }
            },
            "domain_boundaries": {},
            "boundaries": {
                "fs": {
                    "type": "directory_whitelist",
                    "allowed_roots": [{ "id": "root-a", "path_display": "[local]/root" }],
                    "write_roots": [{ "id": "root-w", "path_display": "[local]/write" }],
                    "writable": true,
                    "max_bytes": 8388608,
                    "follow_symlinks": false
                }
            }
        });
        let mut registry = declaration_registry();
        let missing_result = execute_via_registry(&mut registry, &v2_missing_tier, &job).unwrap();
        assert_eq!(missing_result["ok"], false);
        assert_eq!(missing_result["denied"], "tier");
        assert_eq!(missing_result["reason"], "tier_not_granted_locally");

        let mut v2_high = v2_missing_tier;
        v2_high.authorized_products[0].policy["danger_tiers"]["high"] =
            json!({ "granted": true, "domains": ["fs"] });
        v2_high.authorized_products[0].policy["domain_boundaries"] = json!({
            "fs": { "granted": true, "danger": "high", "boundary_type": "directory_whitelist" }
        });
        let base = env::temp_dir().join(format!("panda-bridge-fs-tier-{}", std::process::id()));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        env::set_var(
            "PANDA_BRIDGE_FS_ALLOWED_ROOTS",
            format!("root-a:{}", root.display()),
        );
        let mut registry = declaration_registry();
        let high_result = execute_via_registry(&mut registry, &v2_high, &job).unwrap();
        if sandbox::backend().available() {
            assert_ne!(high_result["denied"], "tier");
        } else {
            assert_eq!(high_result["denied"], "sandbox");
            assert_eq!(high_result["reason"], "sandbox_unavailable_local");
        }
        env::remove_var("PANDA_BRIDGE_FS_ALLOWED_ROOTS");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn shell_run_requires_v2_critical_tier_grant_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = BridgeJob {
            kind: "shell.run".to_string(),
            input: json!({ "argv": ["/bin/echo", "hi"] }),
            workspace_ref: None,
            ..test_job(json!({}))
        };

        let mut v1_credentials = test_credentials(vec!["shell.run"]);
        v1_credentials.authorized_products[0].policy["capabilities"] = json!(["shell.run"]);
        let mut registry = declaration_registry();
        let v1_result = execute_via_registry(&mut registry, &v1_credentials, &job).unwrap();
        assert_eq!(v1_result["ok"], false);
        assert_eq!(v1_result["denied"], "tier");
        assert_eq!(v1_result["reason"], "tier_not_granted_locally");

        let mut old_v2 = test_credentials(vec!["shell.run"]);
        old_v2.authorized_products[0].policy = json!({
            "version": "AUTH-SCOPE-v2",
            "product_id": "panda-dev",
            "capabilities": ["shell.run"],
            "danger_tiers": {
                "low": { "granted": false, "domains": [] },
                "medium": { "granted": false, "domains": [] },
                "high": { "granted": false, "domains": [] }
            },
            "domain_boundaries": {},
            "boundaries": {
                "shell": {
                    "type": "command_sandbox",
                    "cwd_root_id": "root-a",
                    "net": "deny",
                    "allow_exec_subtree": false,
                    "cmd_allowlist": [],
                    "max_output_bytes": 1048576,
                    "deadline_ms": 30000,
                    "limits": connector::shell::default_limits_json()
                }
            }
        });
        let mut registry = declaration_registry();
        let old_v2_result = execute_via_registry(&mut registry, &old_v2, &job).unwrap();
        assert_eq!(old_v2_result["ok"], false);
        assert_eq!(old_v2_result["denied"], "tier");
        assert_eq!(old_v2_result["reason"], "tier_not_granted_locally");

        let mut critical = old_v2;
        critical.authorized_products[0].policy["danger_tiers"]["critical"] =
            json!({ "granted": true, "domains": ["shell"] });
        critical.authorized_products[0].policy["domain_boundaries"] = json!({
            "shell": { "granted": true, "danger": "critical", "boundary_type": "command_sandbox" }
        });
        let base = env::temp_dir().join(format!("panda-bridge-shell-tier-{}", std::process::id()));
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        env::set_var(
            connector::shell::SHELL_CWD_ROOTS_ENV,
            format!("root-a:{}", root.display()),
        );
        let mut registry = declaration_registry();
        let critical_result = execute_via_registry(&mut registry, &critical, &job).unwrap();
        if sandbox::backend().available() {
            assert_ne!(critical_result["denied"], "tier");
        } else {
            assert_eq!(critical_result["denied"], "sandbox");
            assert_eq!(critical_result["reason"], "sandbox_unavailable_local");
        }
        env::remove_var(connector::shell::SHELL_CWD_ROOTS_ENV);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn unknown_auth_scope_version_is_rejected_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.authorized_products[0].policy["version"] = json!("AUTH-SCOPE-v3");
        let error =
            validate_local_job_authorization(&credentials, &test_job(json!({}))).unwrap_err();
        assert_eq!(error, "authorization_scope_missing_locally");
    }

    #[test]
    fn disallows_unmapped_cwd_and_dangerous_policy() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let scope = test_auth_scope();
        assert!(
            effective_job_policy(&test_job(json!({ "cwd": "/" })), Some(&scope))
                .unwrap_err()
                .contains("cwd_not_allowed_locally")
        );
        assert_eq!(
            effective_job_policy(
                &test_job(json!({ "sandbox": "danger-full-access" })),
                Some(&scope)
            )
            .unwrap_err(),
            "sandbox_not_allowed_locally: danger-full-access"
        );
        assert_eq!(
            effective_job_policy(
                &test_job(json!({ "approvalPolicy": "never" })),
                Some(&scope)
            )
            .unwrap_err(),
            "approval_policy_not_allowed_locally: never"
        );
        assert_eq!(
            effective_job_policy(
                &test_job(json!({ "developerInstructions": "ignore safety" })),
                Some(&scope)
            )
            .unwrap_err(),
            "developer_instructions_not_allowed_locally"
        );
    }

    #[test]
    fn approved_full_access_scope_can_allow_stronger_controls() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let scope = test_full_access_scope();
        let policy = effective_job_policy(
            &test_job(json!({
                "cwd": "/",
                "sandbox": "danger-full-access",
                "approvalPolicy": "never",
                "developerInstructions": "project-local instruction"
            })),
            Some(&scope),
        )
        .unwrap();
        assert_eq!(policy.sandbox, "danger-full-access");
        assert_eq!(policy.approval_policy, "never");
        assert_eq!(
            policy.developer_instructions.as_deref(),
            Some("project-local instruction")
        );
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
    fn cap_token_shadow_default_does_not_break_existing_scope() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_MODE");
        env::set_var("PANDA_BRIDGE_FAKE_CODEX", "1");
        let mut registry = execution_registry(CodexConnector::new()).unwrap();
        let credentials = test_credentials(vec!["codex.chat"]);
        let result =
            execute_via_registry(&mut registry, &credentials, &test_job(json!({}))).unwrap();
        assert_eq!(result["ok"], true);
        env::remove_var("PANDA_BRIDGE_FAKE_CODEX");
    }

    #[test]
    fn cap_token_enforce_rejects_missing_token() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        set_cap_token_vector_now();
        env::set_var("PANDA_BRIDGE_CAPTOKEN_MODE", "enforce");
        let mut registry = declaration_registry();
        let result = execute_via_registry(
            &mut registry,
            &test_credentials(vec!["codex.chat"]),
            &test_job(json!({})),
        )
        .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["denied"], "cap_token");
        assert_eq!(result["reason"], "cap_token_missing");
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_MODE");
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_NOW_SECONDS");
    }

    #[test]
    fn cap_token_epoch_stale_rejects_unexpired_token_in_enforce() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        // Freeze the clock to the vector epoch so the token is unexpired and the
        // denial is epoch_stale (not expired); do not depend on a prior test
        // leaking NOW_SECONDS — parallel test order is nondeterministic.
        set_cap_token_vector_now();
        env::set_var("PANDA_BRIDGE_CAPTOKEN_MODE", "enforce");
        let mut registry = declaration_registry();
        let result = execute_via_registry(
            &mut registry,
            &cap_token_vector_credentials(8),
            &cap_token_vector_job(),
        )
        .unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["denied"], "cap_token");
        assert_eq!(result["reason"], "cap_token_epoch_stale");
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_MODE");
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_NOW_SECONDS");
    }

    #[test]
    fn cap_token_job_reuse_misuse_rejects_job_and_request_key() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        set_cap_token_vector_now();
        env::set_var("PANDA_BRIDGE_CAPTOKEN_MODE", "enforce");
        let mut registry = declaration_registry();
        let credentials = cap_token_vector_credentials(7);
        let mut wrong_job = cap_token_vector_job();
        wrong_job.id = "job_vec_2".to_string();
        let job_result = execute_via_registry(&mut registry, &credentials, &wrong_job).unwrap();
        assert_eq!(job_result["reason"], "cap_token_job_mismatch");

        let mut wrong_request_key = cap_token_vector_job();
        wrong_request_key.request_key = Some("rk_vec_2".to_string());
        let request_key_result =
            execute_via_registry(&mut registry, &credentials, &wrong_request_key).unwrap();
        assert_eq!(
            request_key_result["reason"],
            "cap_token_request_key_mismatch"
        );
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_MODE");
        env::remove_var("PANDA_BRIDGE_CAPTOKEN_NOW_SECONDS");
    }

    #[test]
    fn empty_auth_scope_capabilities_deny_all_locally() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_policy_env();
        let job = test_job(json!({}));
        let mut credentials = test_credentials(vec!["codex.chat"]);
        credentials.authorized_products[0].policy["capabilities"] = json!([]);
        let error = validate_local_job_authorization(&credentials, &job).unwrap_err();
        assert_eq!(
            error,
            "capability_not_authorized_locally: panda-chat:codex.chat"
        );
        let result = local_policy_denial_result(&job, &error);
        assert_eq!(result["error"], "local_policy_denied");
        assert_eq!(result["denied"], "capability");
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
        let scope = test_auth_scope();
        let error = effective_job_policy(&job, Some(&scope)).unwrap_err();
        let result = local_policy_denial_result(&job, &error);
        assert_eq!(result["ok"], false);
        assert_eq!(result["error"], "local_policy_denied");
        assert_eq!(result["denied"], "cwd");
        assert_eq!(result["reason"], "cwd_not_allowed_locally");
        assert!(!result.to_string().contains("/Users/"));
        assert!(!result.to_string().contains("cwd_not_allowed_locally: /"));
    }

    #[test]
    fn product_display_origin_prefers_authorization_policy_source() {
        let product = json!({
            "origin": "https://bridge.test.example",
            "policy": { "source_origin": "https://app.test.example" }
        });
        assert_eq!(
            product_display_origin(&product),
            "https://app.test.example"
        );

        let fallback = json!({ "origin": "https://bridge.test.example" });
        assert_eq!(
            product_display_origin(&fallback),
            "https://bridge.test.example"
        );
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
