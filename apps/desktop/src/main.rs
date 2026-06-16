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
    io::{BufWriter, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
// BufRead/BufReader are only used by the Windows single-instance IPC handler
// and by tests; keep the import scoped so the macOS release build stays clean.
#[cfg(any(test, windows))]
use std::io::{BufRead, BufReader};
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

// Single process-wide lock serializing every test that mutates process-global
// env vars. Tests in different modules (main.rs, connector::fs, ...) share ONE
// lock so they never run concurrently and clobber each other's env (e.g.
// PANDA_BRIDGE_FS_ALLOWED_ROOTS / PANDA_BRIDGE_CAPTOKEN_*).
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const VERSION: &str = "panda-bridge-desktop-lite-v0.1";
const BRIDGE_PROTOCOL_VERSION: &str = "panda-bridge-protocol-v0.2";
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
    pending_authorizations: Arc<Mutex<Vec<PendingIntentClaim>>>,
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
    #[serde(default)]
    cloud_profiles: Vec<CloudProfile>,
    #[serde(default)]
    selected_cloud_profile_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CloudProfile {
    id: String,
    name: String,
    api_base: String,
    #[serde(default)]
    web_origin: Option<String>,
    #[serde(default)]
    products: Vec<DesktopProductCatalogEntry>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DesktopProductCatalogEntry {
    id: String,
    name: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    official_origin: Option<String>,
    #[serde(default)]
    official_origins: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AuthorizationState {
    #[serde(alias = "authorized")]
    Active,
    Paused,
    Pending,
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

#[derive(Debug, Serialize, Clone)]
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
    confirmation_mode: String,
}

#[derive(Debug, Clone)]
struct PendingIntentClaim {
    api_base: String,
    intent: String,
    device_token: String,
    token_expires_at: Option<String>,
    install_id: String,
    install_identity_bound: Option<bool>,
    device: Device,
    account: Option<ConnectUser>,
    product: Option<ProductInfo>,
    authorization: Option<AuthorizationInfo>,
    devices: Option<Vec<CloudDevice>>,
    preview: IntentPreview,
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

#[derive(Debug, Deserialize, Clone)]
struct ConnectUser {
    id: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    device: Device,
    #[serde(default)]
    authorization: Option<AuthorizationInfo>,
    device_token: String,
    token_expires_at: Option<String>,
    install_identity_bound: Option<bool>,
    account: Option<ConnectUser>,
    product: Option<ProductInfo>,
    #[serde(default)]
    devices: Option<Vec<CloudDevice>>,
}

#[derive(Debug, Deserialize)]
struct ConfirmResponse {
    device: Device,
    account: Option<ConnectUser>,
    product: Option<ProductInfo>,
    #[serde(default)]
    authorization: Option<AuthorizationInfo>,
    #[serde(default)]
    devices: Option<Vec<CloudDevice>>,
    install_identity_bound: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct AuthorizationInfo {
    #[serde(default)]
    status: Option<AuthorizationState>,
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

#[derive(Debug, Deserialize, Clone)]
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

#[derive(Debug, Deserialize, Clone)]
struct ProductInfo {
    id: String,
    name: String,
    origin: Option<String>,
    #[serde(default)]
    official_origin: Option<String>,
    #[serde(default)]
    official_origins: Vec<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    protocol: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DiagnosticsResponse {
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    api_base: Option<String>,
    #[serde(default)]
    web_origin: Option<String>,
    #[serde(default)]
    products: Vec<ProductInfo>,
}

#[derive(Debug, Deserialize, Clone)]
struct RelayEnvelopesResponse {
    items: Vec<RelayEnvelope>,
}

#[derive(Debug, Deserialize)]
struct RealtimeEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    envelope: Option<RelayEnvelope>,
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
struct RelayEnvelope {
    id: String,
    product_id: String,
    device_id: String,
    channel_id: String,
    direction: String,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    request_key: Option<String>,
    ciphertext: String,
    aad: String,
    nonce: String,
    algorithm: String,
    sender_key_id: String,
    recipient_key_id: String,
    #[serde(default)]
    meta: Value,
    #[serde(default)]
    delivery_status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AdapterRelayResponse {
    #[serde(default)]
    response_envelope: Option<Value>,
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
        pending_authorizations: Arc::new(Mutex::new(Vec::new())),
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

fn state_pending_authorizations(state: &AppState) -> Vec<Value> {
    state
        .pending_authorizations
        .lock()
        .map(|items| items.iter().map(pending_claim_public_value).collect())
        .unwrap_or_default()
}

fn store_pending_authorization(state: &AppState, pending: PendingIntentClaim) -> Value {
    let public = pending_claim_public_value(&pending);
    let pending_id = public
        .get("pending_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Ok(mut items) = state.pending_authorizations.lock() {
        items.retain(|item| pending_claim_id(item) != pending_id);
        items.push(pending);
        let len = items.len();
        if len > 20 {
            items.drain(0..(len - 20));
        }
    }
    public
}

fn take_pending_authorization(
    state: &AppState,
    pending_id: Option<&str>,
    intent: Option<&str>,
) -> Result<PendingIntentClaim, String> {
    let mut items = state
        .pending_authorizations
        .lock()
        .map_err(|_| "pending_authorizations lock poisoned".to_string())?;
    let index = items
        .iter()
        .position(|item| {
            pending_id
                .map(|value| pending_claim_id(item) == value)
                .unwrap_or(false)
                || intent.map(|value| item.intent == value).unwrap_or(false)
        })
        .or_else(|| {
            if pending_id.is_none() && intent.is_none() && items.len() == 1 {
                Some(0)
            } else {
                None
            }
        })
        .ok_or_else(|| "pending_authorization_not_found".to_string())?;
    Ok(items.remove(index))
}

fn pending_claim_id(pending: &PendingIntentClaim) -> String {
    let digest = Sha256::digest(format!(
        "{}\n{}\n{}",
        pending.api_base, pending.intent, pending.device.id
    ));
    let mut out = "pending_".to_string();
    for byte in digest.iter().take(10) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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
        if should_register_windows_url_scheme_on_startup() {
            if let Err(error) = register_windows_url_scheme() {
                eprintln!("[windows] failed to register panda-bridge URL scheme: {error}");
            }
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
                if should_apply_launch_at_login_on_startup() {
                    let settings = load_settings_with_api(DEFAULT_API);
                    if let Err(error) = apply_launch_at_login(settings.launch_at_login) {
                        eprintln!("[launch-at-login] {error}");
                    }
                }
                if load_credentials().is_ok() {
                    let _ = start_worker(&state, proxy.clone());
                }
                if !initial_links.is_empty() {
                    foreground_window_for_deep_link(&window);
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
                if !urls.is_empty() {
                    foreground_window_for_deep_link(&window);
                }
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
                if message.get("event").and_then(Value::as_str) == Some("deep_link") {
                    foreground_window_for_deep_link(&window);
                }
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

fn foreground_window_for_deep_link(window: &tao::window::Window) {
    window.set_visible(true);
    window.set_minimized(false);
    window.request_user_attention(Some(tao::window::UserAttentionType::Informational));
    window.set_focus();
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
            public
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
            let _ = start_worker(state, proxy.clone());
            let payload = serde_json::to_value(result).map_err(|error| error.to_string())?;
            push_event(state, "authorization_confirmed", payload.clone());
            payload
        }
        "add_cloud_profile" => {
            serde_json::to_value(add_cloud_profile(params)?).map_err(|error| error.to_string())?
        }
        "select_cloud_profile" => serde_json::to_value(select_cloud_profile(params)?)
            .map_err(|error| error.to_string())?,
        "remove_cloud_profile" => serde_json::to_value(remove_cloud_profile(params)?)
            .map_err(|error| error.to_string())?,
        "refresh_cloud_profile" => serde_json::to_value(refresh_cloud_profile(params)?)
            .map_err(|error| error.to_string())?,
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
        "pending_authorizations": state_pending_authorizations(state),
        "events": state_events(state)
    })
}

fn pending_claim_public_value(pending: &PendingIntentClaim) -> Value {
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

fn authorization_display_product_name(policy: &Value) -> Option<String> {
    policy
        .pointer("/display/product")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sha256_short(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::new();
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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

fn product_display_origin(product: &Value) -> &str {
    product
        .get("policy")
        .and_then(|policy| policy.get("source_origin"))
        .and_then(Value::as_str)
        .or_else(|| product.get("origin").and_then(Value::as_str))
        .unwrap_or("unknown")
}

fn pending_authorization_screenshot_rows(pending: &Value) -> Vec<String> {
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
        "add_cloud_profile" => {
            serde_json::to_value(add_cloud_profile(params)?).map_err(|error| error.to_string())
        }
        "select_cloud_profile" => {
            serde_json::to_value(select_cloud_profile(params)?).map_err(|error| error.to_string())
        }
        "remove_cloud_profile" => {
            serde_json::to_value(remove_cloud_profile(params)?).map_err(|error| error.to_string())
        }
        "refresh_cloud_profile" => {
            serde_json::to_value(refresh_cloud_profile(params)?).map_err(|error| error.to_string())
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
    let settings = load_settings_with_api(
        credentials
            .as_ref()
            .map(|item| item.api_base.as_str())
            .unwrap_or(DEFAULT_API),
    );
    let products = desktop_products(credentials.as_ref(), state, &settings);
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
            id: "bridge-demo",
            name: "Bridge Demo",
            origin: "bridge.otherline.cc",
            web_url: "https://bridge.otherline.cc",
        },
        KnownProduct {
            id: "example-client",
            name: "Example Client",
            origin: "example.test",
            web_url: "https://example.test",
        },
    ]
}

fn desktop_products(
    credentials: Option<&Credentials>,
    state: &AppState,
    settings: &DesktopSettings,
) -> Vec<DesktopProductStatus> {
    let worker_running = state.worker_running.load(Ordering::SeqCst);
    let realtime_connected = state.realtime_connected.load(Ordering::SeqCst);
    let connections = credentials.map(credentials_connections).unwrap_or_default();
    let profile = selected_cloud_profile(settings)
        .cloned()
        .unwrap_or_else(official_cloud_profile);
    let uses_official_fallback = profile.products.is_empty();
    let match_profile = if uses_official_fallback {
        let mut value = profile.clone();
        value.id = "official".to_string();
        value
    } else {
        profile.clone()
    };
    let mut catalog = if uses_official_fallback {
        official_cloud_profile().products
    } else {
        profile.products.clone()
    };
    for connection in connections
        .iter()
        .filter(|connection| connection.api_base == profile.api_base)
    {
        for grant in connection_products(connection) {
            if catalog
                .iter()
                .any(|product| catalog_matches_grant(product, &grant, &match_profile))
            {
                continue;
            }
            upsert_catalog_product(
                &mut catalog,
                product_entry_from_grant(&grant, &profile.api_base),
            );
        }
    }
    catalog
        .into_iter()
        .map(|product| {
            let mut accounts: Vec<DesktopAccountStatus> = Vec::new();
            for connection in connections
                .iter()
                .filter(|connection| connection.api_base == profile.api_base)
            {
                for grant in connection_products(connection)
                    .into_iter()
                    .filter(|grant| catalog_matches_grant(&product, grant, &match_profile))
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
                id: product.id,
                name: product.name,
                origin: product
                    .origin
                    .clone()
                    .or_else(|| product.official_origin.clone())
                    .unwrap_or_else(|| profile.api_base.clone()),
                web_url: product
                    .web_url
                    .clone()
                    .or_else(|| product.origin.clone())
                    .unwrap_or_else(|| {
                        profile
                            .web_origin
                            .clone()
                            .unwrap_or_else(|| profile.api_base.clone())
                    }),
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

fn catalog_matches_grant(
    product: &DesktopProductCatalogEntry,
    grant: &ProductGrant,
    profile: &CloudProfile,
) -> bool {
    normalize_product_key(&product.id) == normalize_product_key(&grant.id)
        || normalize_product_key(&product.name) == normalize_product_key(&grant.name)
        || (profile.id == "official"
            && known_products()
                .into_iter()
                .find(|known| normalize_product_key(known.id) == normalize_product_key(&product.id))
                .map(|known| product_matches_known(grant, known))
                .unwrap_or(false))
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
    if haystack.contains("bridge") {
        "bridge-demo"
    } else {
        "example-client"
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
    let profile = fetch_cloud_profile(&api_base, None)?;
    let url = format!(
        "{}/v1/connect-intents/{}",
        api_base,
        urlencoding::encode(intent)
    );
    let payload: IntentResponse = get_json(&url, None)?;
    let product_id = payload.connect_intent.product_id.clone();
    let catalog_product = profile_product(&profile, &product_id)
        .ok_or_else(|| format!("Bridge Cloud diagnostics does not expose product: {product_id}"))?;
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

fn claim_intent(api: &str, intent: &str, device_name: &str) -> Result<ClaimResult, String> {
    let pending = claim_intent_pending(api, intent, device_name)?;
    confirm_pending_intent(pending)
}

fn claim_intent_pending(
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

fn confirm_pending_intent(pending: PendingIntentClaim) -> Result<ClaimResult, String> {
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

fn confirm_claimed_intent(
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
    let canonical =
        canonical_existing_path(selected_path).map_err(|_| "path_not_found_locally".to_string())?;
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
    let mut roots = declared_fs_roots_from_raw(fs, snake_key, camel_key);
    roots.extend(declared_product_authorization_roots(policy));
    roots
}

fn declared_product_authorization_roots(policy: &Value) -> Vec<DeclaredLocalRoot> {
    let product_authorization = policy
        .get("product_authorization")
        .or_else(|| policy.get("productAuthorization"))
        .unwrap_or(&Value::Null);
    let roots = product_authorization
        .get("roots")
        .unwrap_or(&Value::Null);
    declared_root_list_from_raw(roots)
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

fn declared_root_list_from_raw(raw: &Value) -> Vec<DeclaredLocalRoot> {
    raw.as_array()
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

/// Canonicalize an existing local path (resolves symlinks/.. on disk). Used to
/// bind a real local adapter root before handing it to the product's own
/// Product Adapter; the adapter, not Bridge core, confines it.
fn canonical_existing_path(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

fn canonical_for_safety(path: &Path) -> PathBuf {
    canonical_existing_path(path).unwrap_or_else(|_| path.to_path_buf())
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
    authorization: AuthorizationState,
) -> Vec<ProductGrant> {
    let mut products = existing.map(connection_products).unwrap_or_default();
    if let Some(id) = product_id {
        let name = product_name.unwrap_or_else(|| id.clone());
        let mut grant = ProductGrant {
            id: id.clone(),
            name,
            origin: cloud_origin,
            authorization,
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
    let product_ids = active_connection_products(credentials)
        .into_iter()
        .map(|product| product.id)
        .collect::<Vec<_>>();
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state_for_products(&product_ids),
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
    let product_ids = active_connection_products(credentials)
        .into_iter()
        .map(|product| product.id)
        .collect::<Vec<_>>();
    let body = json!({
        "app_version": VERSION,
        "capabilities": capabilities(),
        "local_state": local_state_for_products(&product_ids),
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

fn poll_once(credentials: &Credentials) -> Result<usize, String> {
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

fn sync_relay_key_bootstrap(credentials: &Credentials) -> Result<usize, String> {
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

fn adapter_relay_key_bootstrap_payload(
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

fn adapter_authorization_mirror(
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

fn connection_authorizes_product_active(credentials: &Credentials, product_id: &str) -> bool {
    active_connection_products(credentials)
        .iter()
        .any(|product| product.id == product_id)
}

fn route_and_ack_relay_envelope(
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

fn route_relay_envelope_to_adapter(envelope: &RelayEnvelope) -> Result<Option<Value>, String> {
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

fn post_connector_relay_envelope(
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

fn adapter_endpoint_for_product(product_id: &str) -> Option<String> {
    let specific = format!(
        "PANDA_BRIDGE_ADAPTER_{}_URL",
        product_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    env::var(&specific)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("PANDA_BRIDGE_ADAPTER_URL").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn adapter_url_for_product_path(product_id: &str, path: &str) -> Option<String> {
    let endpoint = adapter_endpoint_for_product(product_id)?;
    let mut parsed = url::Url::parse(&endpoint).ok()?;
    parsed.set_path(path);
    parsed.set_query(None);
    Some(parsed.to_string())
}

fn adapter_relay_key_exchange_for_product(product_id: &str) -> Option<Value> {
    let endpoint = adapter_url_for_product_path(product_id, "/v1/relay-key/public")?;
    let response = Client::new().get(&endpoint).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: Value = response.json().ok()?;
    let exchange = payload
        .get("relay_key_exchange")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    if exchange.get("status").and_then(Value::as_str).unwrap_or("") == "available" {
        Some(exchange)
    } else {
        None
    }
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
        "relay": ["relay.envelope", "relay.ack"],
        "adapter_router": { "mode": "external_http" },
        "desktop": "tao-wry",
        "platform": env::consts::OS
    })
}

// Test-only convenience wrapper; production builds the local state per product
// via local_state_for_products(&product_ids) directly.
#[cfg(test)]
fn local_state() -> Value {
    local_state_for_products(&configured_adapter_product_ids())
}

fn local_state_for_products(product_ids: &[String]) -> Value {
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
        "relay": { "envelopes": true, "ack": true },
        "adapter_router": {
            "mode": "external_http",
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

fn adapter_state_for_products(product_ids: &[String]) -> Map<String, Value> {
    let mut products = Map::new();
    for product_id in product_ids
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
    {
        if products.contains_key(product_id) {
            continue;
        }
        let configured = adapter_endpoint_for_product(product_id).is_some();
        let mut product = json!({ "configured": configured });
        if let Some(exchange) = adapter_relay_key_exchange_for_product(product_id) {
            product["relay_key_exchange"] = exchange;
        }
        products.insert(product_id.to_string(), product);
    }
    products
}

#[cfg(test)]
fn configured_adapter_product_ids() -> Vec<String> {
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

fn low_tier_capabilities() -> Vec<String> {
    vec!["relay.envelope".to_string(), "relay.ack".to_string()]
}

fn local_policy_preview() -> Value {
    let capabilities = low_tier_capabilities();
    json!({
        "version": "BRIDGE-RELAY-AUTH-v1",
        "request_source": "desktop_default_relay",
        "capabilities": capabilities
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
    normalize_settings(&mut settings, api_base);
    settings
}

fn default_settings() -> DesktopSettings {
    DesktopSettings {
        launch_at_login: default_launch_at_login(),
        appearance: default_appearance(),
        language: default_language(),
        api_base: default_api_base(),
        cloud_profiles: vec![official_cloud_profile()],
        selected_cloud_profile_id: "official".to_string(),
    }
}

fn save_settings(settings: &DesktopSettings) -> Result<(), String> {
    let mut persisted = settings.clone();
    let active_api = persisted.api_base.clone();
    normalize_settings(&mut persisted, &active_api);
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

fn add_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let api = string_param(params, "api")
        .or_else(|| string_param(params, "api_base"))
        .ok_or_else(|| "missing api".to_string())?;
    let api_base = clean_api(&api)?;
    let name = string_param(params, "name");
    let profile = fetch_cloud_profile(&api_base, name.as_deref())?;
    let mut settings = load_settings_with_api(&api_base);
    upsert_cloud_profile(&mut settings, profile, true);
    save_settings(&settings)?;
    Ok(settings)
}

fn select_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let mut settings = load_settings_with_api(DEFAULT_API);
    let target_id = if let Some(id) =
        string_param(params, "profile_id").or_else(|| string_param(params, "id"))
    {
        id
    } else if let Some(api) =
        string_param(params, "api").or_else(|| string_param(params, "api_base"))
    {
        let api_base = clean_api(&api)?;
        profile_id_for_api(&api_base)
    } else {
        return Err("missing profile_id or api".to_string());
    };
    if !settings
        .cloud_profiles
        .iter()
        .any(|profile| profile.id == target_id)
    {
        return Err(format!("unknown cloud profile: {target_id}"));
    }
    settings.selected_cloud_profile_id = target_id;
    if let Some(profile) = selected_cloud_profile(&settings) {
        settings.api_base = profile.api_base.clone();
    }
    save_settings(&settings)?;
    Ok(settings)
}

fn remove_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let target_id = string_param(params, "profile_id")
        .or_else(|| string_param(params, "id"))
        .ok_or_else(|| "missing profile_id".to_string())?;
    if target_id == "official" {
        return Err("official Bridge Cloud profile cannot be removed".to_string());
    }
    let mut settings = load_settings_with_api(DEFAULT_API);
    let before = settings.cloud_profiles.len();
    settings
        .cloud_profiles
        .retain(|profile| profile.id != target_id);
    if settings.cloud_profiles.len() == before {
        return Err(format!("unknown cloud profile: {target_id}"));
    }
    if settings.selected_cloud_profile_id == target_id {
        settings.selected_cloud_profile_id = "official".to_string();
    }
    if let Some(profile) = selected_cloud_profile(&settings) {
        settings.api_base = profile.api_base.clone();
    }
    save_settings(&settings)?;
    Ok(settings)
}

fn refresh_cloud_profile(params: &Value) -> Result<DesktopSettings, String> {
    let mut settings = load_settings_with_api(DEFAULT_API);
    let target = string_param(params, "profile_id")
        .or_else(|| string_param(params, "id"))
        .or_else(|| {
            string_param(params, "api")
                .or_else(|| string_param(params, "api_base"))
                .and_then(|api| clean_api(&api).ok())
                .map(|api| profile_id_for_api(&api))
        })
        .ok_or_else(|| "missing profile_id or api".to_string())?;
    let existing = settings
        .cloud_profiles
        .iter()
        .find(|profile| profile.id == target)
        .cloned()
        .ok_or_else(|| format!("unknown cloud profile: {target}"))?;
    let mut profile = fetch_cloud_profile(&existing.api_base, Some(&existing.name))?;
    profile.id = existing.id;
    profile.source = existing.source;
    let keep_selected = settings.selected_cloud_profile_id == target;
    upsert_cloud_profile(&mut settings, profile, keep_selected);
    save_settings(&settings)?;
    Ok(settings)
}

fn normalize_settings(settings: &mut DesktopSettings, active_api: &str) {
    if settings
        .cloud_profiles
        .iter()
        .all(|profile| profile.id != "official")
    {
        settings.cloud_profiles.insert(0, official_cloud_profile());
    }
    for profile in &mut settings.cloud_profiles {
        if profile.id == "official" {
            *profile = merge_official_profile(profile.clone());
            continue;
        }
        if profile.id.trim().is_empty() {
            profile.id = profile_id_for_api(&profile.api_base);
        }
        if profile.source.trim().is_empty() {
            profile.source = "user".to_string();
        }
        if profile.name.trim().is_empty() {
            profile.name = name_for_api(&profile.api_base);
        }
    }

    let active_clean = clean_api(active_api)
        .or_else(|_| clean_api(&settings.api_base))
        .unwrap_or_else(|_| DEFAULT_API.to_string());
    if active_clean != DEFAULT_API
        && settings
            .cloud_profiles
            .iter()
            .all(|profile| profile.api_base != active_clean)
    {
        settings
            .cloud_profiles
            .push(minimal_cloud_profile(&active_clean, None));
    }
    if settings.selected_cloud_profile_id.trim().is_empty()
        || settings
            .cloud_profiles
            .iter()
            .all(|profile| profile.id != settings.selected_cloud_profile_id)
    {
        settings.selected_cloud_profile_id = settings
            .cloud_profiles
            .iter()
            .find(|profile| profile.api_base == active_clean)
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| "official".to_string());
    }
    if let Some(profile) = selected_cloud_profile(settings) {
        settings.api_base = profile.api_base.clone();
    } else {
        settings.selected_cloud_profile_id = "official".to_string();
        settings.api_base = DEFAULT_API.to_string();
    }
}

fn selected_cloud_profile(settings: &DesktopSettings) -> Option<&CloudProfile> {
    settings
        .cloud_profiles
        .iter()
        .find(|profile| profile.id == settings.selected_cloud_profile_id)
        .or_else(|| {
            settings
                .cloud_profiles
                .iter()
                .find(|profile| profile.id == "official")
        })
}

fn official_cloud_profile() -> CloudProfile {
    CloudProfile {
        id: "official".to_string(),
        name: "Official Bridge Cloud".to_string(),
        api_base: DEFAULT_API.to_string(),
        web_origin: Some(DEFAULT_WEB.to_string()),
        products: known_products()
            .into_iter()
            .map(product_entry_from_known)
            .collect(),
        source: "official".to_string(),
        updated_at: "builtin".to_string(),
    }
}

fn merge_official_profile(existing: CloudProfile) -> CloudProfile {
    let mut official = official_cloud_profile();
    official.name = if existing.name.trim().is_empty() {
        official.name
    } else {
        existing.name
    };
    official
}

fn minimal_cloud_profile(api_base: &str, name: Option<&str>) -> CloudProfile {
    CloudProfile {
        id: profile_id_for_api(api_base),
        name: name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| name_for_api(api_base)),
        api_base: api_base.to_string(),
        web_origin: None,
        products: Vec::new(),
        source: "user".to_string(),
        updated_at: now_string(),
    }
}

fn fetch_cloud_profile(api_base: &str, name: Option<&str>) -> Result<CloudProfile, String> {
    let api_base = clean_api(api_base)?;
    let health_url = format!("{api_base}/v1/health");
    let health: HealthResponse = get_json(&health_url, None)?;
    validate_bridge_health(&health)?;
    let diagnostics_url = format!("{api_base}/v1/diagnostics");
    let diagnostics: DiagnosticsResponse = get_json(&diagnostics_url, None)?;
    validate_bridge_diagnostics(&api_base, &diagnostics)?;
    let products = diagnostics
        .products
        .iter()
        .map(|product| {
            validate_bridge_product(product)?;
            Ok(product_entry_from_info(product, &api_base))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if products.is_empty() {
        return Err("Bridge Cloud diagnostics returned no products".to_string());
    }
    Ok(CloudProfile {
        id: profile_id_for_api(&api_base),
        name: name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| name_for_api(&api_base)),
        api_base,
        web_origin: diagnostics.web_origin,
        products,
        source: "user".to_string(),
        updated_at: now_string(),
    })
}

fn validate_bridge_health(health: &HealthResponse) -> Result<(), String> {
    if health.ok != Some(true) {
        return Err("Bridge Cloud health did not return ok=true".to_string());
    }
    if health.protocol.as_deref() != Some(BRIDGE_PROTOCOL_VERSION) {
        return Err("Bridge Cloud health returned an unsupported protocol".to_string());
    }
    Ok(())
}

fn validate_bridge_diagnostics(
    api_base: &str,
    diagnostics: &DiagnosticsResponse,
) -> Result<(), String> {
    if diagnostics.ok != Some(true) {
        return Err("Bridge Cloud diagnostics did not return ok=true".to_string());
    }
    if diagnostics.protocol.as_deref() != Some(BRIDGE_PROTOCOL_VERSION) {
        return Err("Bridge Cloud diagnostics returned an unsupported protocol".to_string());
    }
    let public_api_base = diagnostics
        .api_base
        .as_deref()
        .ok_or_else(|| "Bridge Cloud diagnostics missing api_base".to_string())
        .and_then(clean_api)?;
    if public_api_base != api_base {
        return Err(
            "Bridge Cloud diagnostics api_base does not match the selected server".to_string(),
        );
    }
    let web_origin = diagnostics
        .web_origin
        .as_deref()
        .ok_or_else(|| "Bridge Cloud diagnostics missing web_origin".to_string())?;
    clean_product_origin(web_origin)
        .ok_or_else(|| "Bridge Cloud diagnostics returned an invalid web_origin".to_string())?;
    Ok(())
}

fn validate_bridge_product(product: &ProductInfo) -> Result<(), String> {
    if !valid_product_id(&product.id) {
        return Err(format!(
            "Bridge Cloud diagnostics returned invalid product id: {}",
            product.id
        ));
    }
    if product.name.trim().is_empty() {
        return Err(format!(
            "Bridge Cloud diagnostics returned unnamed product: {}",
            product.id
        ));
    }
    let origin = product
        .official_origin
        .as_deref()
        .or(product.origin.as_deref())
        .or_else(|| product.official_origins.first().map(String::as_str))
        .ok_or_else(|| {
            format!(
                "Bridge Cloud diagnostics missing product origin: {}",
                product.id
            )
        })?;
    clean_product_origin(origin).ok_or_else(|| {
        format!(
            "Bridge Cloud diagnostics returned invalid product origin: {}",
            product.id
        )
    })?;
    for candidate in &product.official_origins {
        clean_product_origin(candidate).ok_or_else(|| {
            format!(
                "Bridge Cloud diagnostics returned invalid product origin: {}",
                product.id
            )
        })?;
    }
    if let Some(web_url) = product.web_url.as_deref() {
        clean_product_web_url(web_url).ok_or_else(|| {
            format!(
                "Bridge Cloud diagnostics returned invalid product web_url: {}",
                product.id
            )
        })?;
    }
    let allowed_capabilities = allowed_product_capabilities(&product.id);
    if product.capabilities.is_empty()
        || product
            .capabilities
            .iter()
            .any(|capability| !allowed_capabilities.contains(&capability.as_str()))
    {
        return Err(format!(
            "Bridge Cloud diagnostics returned unsupported product capabilities: {}",
            product.id
        ));
    }
    Ok(())
}

fn allowed_product_capabilities(product_id: &str) -> Vec<&'static str> {
    let _ = product_id;
    vec!["relay.envelope", "relay.ack"]
}

fn valid_product_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3 || bytes.len() > 80 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn clean_product_origin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return None;
    }
    Some(format!("{}://{}", parsed.scheme(), parsed.host_str()?))
}

fn clean_product_web_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let parsed = url::Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn profile_product<'a>(
    profile: &'a CloudProfile,
    product_id: &str,
) -> Option<&'a DesktopProductCatalogEntry> {
    let normalized = normalize_product_key(product_id);
    profile.products.iter().find(|product| {
        normalize_product_key(&product.id) == normalized
            || normalize_product_key(&product.name) == normalized
    })
}

fn fetch_cloud_profile_product(
    api_base: &str,
    product_id: Option<&str>,
) -> Result<CloudProfile, String> {
    let profile = fetch_cloud_profile(api_base, None)?;
    if let Some(product_id) = product_id {
        if profile_product(&profile, product_id).is_none() {
            return Err(format!(
                "Bridge Cloud diagnostics does not expose product: {product_id}"
            ));
        }
    }
    Ok(profile)
}

fn register_cloud_profile_from_claim(
    api_base: &str,
    product_id: Option<&str>,
) -> Result<(), String> {
    let api_base = clean_api(api_base)?;
    let mut settings = load_settings_with_api(&api_base);
    let profile = fetch_cloud_profile_product(&api_base, product_id)?;
    upsert_cloud_profile(&mut settings, profile, true);
    save_settings(&settings)
}

fn upsert_cloud_profile(settings: &mut DesktopSettings, profile: CloudProfile, select: bool) {
    if let Some(existing) = settings
        .cloud_profiles
        .iter_mut()
        .find(|item| item.id == profile.id || item.api_base == profile.api_base)
    {
        *existing = profile.clone();
    } else {
        settings.cloud_profiles.push(profile.clone());
    }
    if select {
        settings.selected_cloud_profile_id = profile.id;
        settings.api_base = profile.api_base;
    }
}

fn product_entry_from_known(product: KnownProduct) -> DesktopProductCatalogEntry {
    DesktopProductCatalogEntry {
        id: product.id.to_string(),
        name: product.name.to_string(),
        origin: Some(product.origin.to_string()),
        web_url: Some(product.web_url.to_string()),
        official_origin: Some(product.web_url.to_string()),
        official_origins: vec![product.web_url.to_string()],
    }
}

fn product_entry_from_info(product: &ProductInfo, api_base: &str) -> DesktopProductCatalogEntry {
    let origin = product
        .official_origin
        .clone()
        .or_else(|| product.origin.clone())
        .or_else(|| product.official_origins.first().cloned())
        .unwrap_or_else(|| api_base.to_string());
    DesktopProductCatalogEntry {
        id: product.id.clone(),
        name: if product.name.trim().is_empty() {
            product.id.clone()
        } else {
            product.name.clone()
        },
        origin: Some(origin.clone()),
        web_url: product.web_url.clone().or(Some(origin.clone())),
        official_origin: Some(origin),
        official_origins: product.official_origins.clone(),
    }
}

fn product_entry_from_grant(grant: &ProductGrant, api_base: &str) -> DesktopProductCatalogEntry {
    let origin = grant.origin.clone().unwrap_or_else(|| api_base.to_string());
    DesktopProductCatalogEntry {
        id: grant.id.clone(),
        name: grant.name.clone(),
        origin: Some(origin.clone()),
        web_url: Some(origin.clone()),
        official_origin: Some(origin.clone()),
        official_origins: vec![origin],
    }
}

fn upsert_catalog_product(
    products: &mut Vec<DesktopProductCatalogEntry>,
    product: DesktopProductCatalogEntry,
) {
    if let Some(existing) = products.iter_mut().find(|item| {
        item.id == product.id
            || normalize_product_key(&item.name) == normalize_product_key(&product.name)
    }) {
        *existing = product;
    } else {
        products.push(product);
    }
}

fn profile_id_for_api(api_base: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(api_base.as_bytes());
    let digest = hash.finalize();
    format!(
        "profile_{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7]
    )
}

fn name_for_api(api_base: &str) -> String {
    url::Url::parse(api_base)
        .ok()
        .and_then(|url| url.host_str().map(ToOwned::to_owned))
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| "Custom Bridge Cloud".to_string())
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

/// 开机自启（契约 §1 连接全自动）：macOS 写入 LaunchAgent，Windows 写入 HKCU Run。
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
    #[cfg(windows)]
    {
        return apply_windows_launch_at_login(enabled);
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = enabled;
        Ok(())
    }
}

#[cfg(windows)]
fn apply_windows_launch_at_login(enabled: bool) -> Result<(), String> {
    let run_key = windows_registry::CURRENT_USER
        .create(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|error| error.to_string())?;
    if !enabled {
        let _ = run_key.remove_value("Panda Bridge");
        return Ok(());
    }
    let exe = env::current_exe().map_err(|error| error.to_string())?;
    run_key
        .set_string("Panda Bridge", windows_registry_command_for_exe(&exe))
        .map_err(|error| error.to_string())
}

fn windows_registry_command_for_exe(exe: &Path) -> String {
    format!("\"{}\"", exe.to_string_lossy())
}

fn should_apply_launch_at_login_on_startup() -> bool {
    if cfg!(target_os = "macos") {
        return running_from_app_bundle();
    }
    if cfg!(target_os = "windows") {
        return !cfg!(debug_assertions) && !env_flag("PANDA_BRIDGE_DISABLE_STARTUP_APPLY");
    }
    false
}

#[cfg(windows)]
fn should_register_windows_url_scheme_on_startup() -> bool {
    !cfg!(debug_assertions) || env_flag("PANDA_BRIDGE_REGISTER_URL_SCHEME")
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
    if env_flag("PANDA_BRIDGE_SKIP_KEYCHAIN") {
        return false;
    }
    // Dev/debug builds are unsigned (or ad-hoc signed), so the macOS keychain would
    // re-prompt for the login password on every launch. Default debug builds to the
    // file-backed credential store; release builds (signed + notarized for
    // distribution) use the keychain. Either default can be overridden by env.
    if cfg!(debug_assertions) {
        return env_flag("PANDA_BRIDGE_USE_KEYCHAIN");
    }
    true
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
    #[cfg(windows)]
    let _ = private_parent;
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

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn policy_string(policy: &Value, key: &str) -> Option<String> {
    policy
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn open_web_url(params: &Value) -> String {
    if let Some(url) = string_param(params, "url").filter(|value| !value.trim().is_empty()) {
        return url;
    }
    let settings = load_settings_with_api(DEFAULT_API);
    if let Some(product_id) =
        string_param(params, "product_id").or_else(|| string_param(params, "product"))
    {
        let normalized = normalize_product_key(&product_id);
        if let Some(profile) = selected_cloud_profile(&settings) {
            if let Some(product) = profile.products.iter().find(|product| {
                normalize_product_key(&product.id) == normalized
                    || normalize_product_key(&product.name) == normalized
            }) {
                return product
                    .web_url
                    .clone()
                    .or_else(|| product.origin.clone())
                    .unwrap_or_else(|| {
                        profile
                            .web_origin
                            .clone()
                            .unwrap_or_else(|| profile.api_base.clone())
                    });
            }
        }
    }
    selected_cloud_profile(&settings)
        .and_then(|profile| profile.web_origin.clone())
        .unwrap_or_else(|| DEFAULT_WEB.to_string())
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
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Bridge API URL cannot include credentials, query, or fragment".to_string());
    }
    let local_http = {
        let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
        #[cfg(test)]
        {
            loopback || host == "local.test" || host.ends_with(".local.test")
        }
        #[cfg(not(test))]
        {
            loopback
        }
    };
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local_http) {
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
            add_cloud_profile(&params)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
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
            select_cloud_profile(&Value::Object(params))
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
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
            refresh_cloud_profile(&Value::Object(params))
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        "headless-remove-cloud-profile" => {
            let map = arg_map(args.collect());
            let profile_id = match map.get("profile-id").or_else(|| map.get("id")) {
                Some(value) => value.clone(),
                None => return Some(print_error("missing --profile-id")),
            };
            remove_cloud_profile(&json!({ "profile_id": profile_id }))
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        "headless-open-web-url" => {
            let map = arg_map(args.collect());
            let mut params = Map::new();
            if let Some(value) = map.get("product-id").or_else(|| map.get("product")) {
                params.insert("product_id".to_string(), json!(value));
            }
            Ok(json!({ "url": open_web_url(&Value::Object(params)) }))
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

    fn test_credentials(capabilities: Vec<&str>) -> Credentials {
        Credentials {
            api_base: "http://local.test".to_string(),
            device_id: "dev_1".to_string(),
            device_name: "Device".to_string(),
            device_token: "pbd_test".to_string(),
            install_id: None,
            account_id: Some("user_1".to_string()),
            account_display: Some("user@example.test".to_string()),
            product_id: Some("bridge-demo".to_string()),
            product_name: Some("Bridge Demo".to_string()),
            cloud_origin: Some("http://local.test".to_string()),
            authorized_products: vec![ProductGrant {
                id: "bridge-demo".to_string(),
                name: "Bridge Demo".to_string(),
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

    #[test]
    fn adapter_bootstrap_payload_includes_product_authorization_mirror() {
        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        let mut product = credentials.authorized_products[0].clone();
        product.policy["product_authorization"] = json!({
            "owner": "bridge-demo",
            "enforcement": "acme-product-adapter",
            "control": "computer-control"
        });
        product.local_roots.fs_roots.insert(
            "default".to_string(),
            LocalRootBinding {
                real_path: "/tmp/acme-chat".to_string(),
                path_display: "[local]/default".to_string(),
                bound_at: now_string(),
                bound_device_id: credentials.device_id.clone(),
            },
        );
        let bootstrap = json!({
            "status": "ready",
            "product_id": product.id,
            "device_id": credentials.device_id,
            "authorization_id": "auth_1",
            "authorization_epoch": "7",
            "key_id": "rkx_1",
            "wrapped_key": {
                "algorithm": "ECDH-P256+A256GCM"
            }
        });

        let payload = adapter_relay_key_bootstrap_payload(&bootstrap, &product, &credentials);
        let mirror = payload
            .get("authorization_mirror")
            .expect("authorization mirror missing");

        assert_eq!(mirror["status"], json!("active"));
        assert_eq!(mirror["product_id"], json!("bridge-demo"));
        assert_eq!(
            mirror["authorization_context"],
            json!({
                "product_id": "bridge-demo",
                "device_id": "dev_1",
                "authorization_id": "auth_1",
                "authorization_epoch": "7",
                "relay_key_id": "rkx_1"
            })
        );
        assert_eq!(mirror["product_authorization"]["control"], "computer-control");
        assert!(mirror["product_authorization"].get("capabilities").is_none());
        assert!(mirror["product_authorization"].get("roots").is_none());
        let text = serde_json::to_string(&payload).unwrap();
        assert!(!text.contains("pbd_test"));
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

        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
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
    fn keychain_default_depends_on_build_and_env_overrides() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        env::remove_var("PANDA_BRIDGE_USE_KEYCHAIN");
        // Default: dev/debug builds use the file store (no per-launch keychain prompt);
        // release builds (signed + notarized) use the keychain.
        assert_eq!(
            keychain_enabled(),
            !cfg!(debug_assertions),
            "default keychain state should follow build profile"
        );
        env::set_var("PANDA_BRIDGE_USE_KEYCHAIN", "1");
        assert!(
            keychain_enabled(),
            "USE_KEYCHAIN should opt into the keychain"
        );
        env::set_var("PANDA_BRIDGE_SKIP_KEYCHAIN", "1");
        assert!(!keychain_enabled(), "SKIP_KEYCHAIN should take precedence");
        env::remove_var("PANDA_BRIDGE_USE_KEYCHAIN");
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

        save_credentials(&test_credentials(vec!["relay.envelope", "relay.ack"])).unwrap();

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
            "version": "BRIDGE-RELAY-AUTH-v1",
            "request_source": "test_relay_scope",
            "product_id": "bridge-demo",
            "source_origin": "http://local.test",
            "capabilities": ["relay.envelope", "relay.ack"],
            "product_authorization": {
                "owner": "product-adapter",
                "enforcement": "product-adapter",
                "control": "computer-control"
            }
        })
    }

    fn local_root_params(domain: &str, root_id: &str, path_display: &str) -> Value {
        json!({
            "product_id": "bridge-demo",
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

    fn with_settings_home(name: &str) -> PathBuf {
        let home = env::temp_dir().join(format!("{name}-{}", next_event_seq()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join(".panda-bridge")).unwrap();
        env::set_var("HOME", &home);
        env::remove_var("USERPROFILE");
        home
    }

    fn start_profile_server(diagnostics: Value) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let api = format!("http://{addr}");
        let handle = thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                let _ = reader.read_line(&mut request_line);
                loop {
                    let mut line = String::new();
                    let bytes = reader.read_line(&mut line).unwrap_or(0);
                    if bytes == 0 || line == "\r\n" || line == "\n" {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let payload = if path == "/v1/health" {
                    json!({
                        "ok": true,
                        "protocol": BRIDGE_PROTOCOL_VERSION,
                        "env": "test",
                        "storage": "memory"
                    })
                } else {
                    diagnostics.clone()
                };
                write_http_json(&mut stream, 200, payload).unwrap();
            }
        });
        (api, handle)
    }

    #[test]
    fn cloud_profile_migrates_old_api_base_and_keeps_official_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = with_settings_home("panda-bridge-settings-migration");
        let api = "http://local.test:8787";
        fs::write(
            home.join(".panda-bridge/desktop-settings.json"),
            serde_json::to_string_pretty(&json!({
                "launch_at_login": true,
                "appearance": "auto",
                "language": "auto",
                "api_base": api
            }))
            .unwrap(),
        )
        .unwrap();

        let settings = load_settings_with_api(api);

        assert_eq!(settings.api_base, api);
        assert_eq!(settings.selected_cloud_profile_id, profile_id_for_api(api));
        assert!(settings
            .cloud_profiles
            .iter()
            .any(|profile| profile.id == "official" && profile.api_base == DEFAULT_API));
        assert!(settings
            .cloud_profiles
            .iter()
            .any(|profile| profile.api_base == api && profile.source == "user"));

        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn add_cloud_profile_rejects_invalid_diagnostics_without_saving() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = with_settings_home("panda-bridge-invalid-profile");
        let (api, server) = start_profile_server(json!({
            "ok": true,
            "protocol": "not-bridge",
            "api_base": "http://127.0.0.1:1",
            "web_origin": "http://127.0.0.1:1",
            "products": []
        }));

        let error = add_cloud_profile(&json!({ "api": api })).unwrap_err();
        assert!(error.contains("unsupported protocol"));
        server.join().unwrap();
        let settings = load_settings_with_api(DEFAULT_API);
        assert_eq!(settings.selected_cloud_profile_id, "official");
        assert_eq!(settings.cloud_profiles.len(), 1);

        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn diagnostics_product_without_web_url_uses_origin_fallback() {
        let product = ProductInfo {
            id: "acme-demo".to_string(),
            name: "Acme Demo".to_string(),
            origin: Some("http://local.test".to_string()),
            official_origin: None,
            official_origins: Vec::new(),
            web_url: None,
            capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
        };

        validate_bridge_product(&product).unwrap();
        let entry = product_entry_from_info(&product, "http://api.test");

        assert_eq!(entry.web_url.as_deref(), Some("http://local.test"));
    }

    #[test]
    fn diagnostics_product_accepts_authorize_web_url_query() {
        let product = ProductInfo {
            id: "acme-demo".to_string(),
            name: "Acme Demo".to_string(),
            origin: Some("https://acme.example.test".to_string()),
            official_origin: None,
            official_origins: Vec::new(),
            web_url: Some(
                "https://acme.example.test/authorize?source=bridge&product=acme-demo"
                    .to_string(),
            ),
            capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
        };

        validate_bridge_product(&product).unwrap();
        let entry = product_entry_from_info(&product, "https://api.bridge.test.example");

        assert_eq!(
            entry.web_url.as_deref(),
            Some("https://acme.example.test/authorize?source=bridge&product=acme-demo"),
        );
    }

    #[test]
    fn diagnostics_product_rejects_unknown_capability() {
        let product = ProductInfo {
            id: "acme-demo".to_string(),
            name: "Acme Demo".to_string(),
            origin: Some("http://local.test".to_string()),
            official_origin: None,
            official_origins: Vec::new(),
            web_url: None,
            capabilities: vec![
                "relay.envelope".to_string(),
                "relay.ack".to_string(),
                "shell.run".to_string(),
            ],
        };

        let error = validate_bridge_product(&product).unwrap_err();
        assert!(error.contains("unsupported product capabilities"));
    }

    #[test]
    fn official_cloud_profile_cannot_be_removed() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let error = remove_cloud_profile(&json!({ "profile_id": "official" })).unwrap_err();
        assert!(error.contains("cannot be removed"));
        reset_credentials_env();
    }

    #[test]
    fn open_web_uses_selected_profile_product_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        reset_credentials_env();
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        let home = with_settings_home("panda-bridge-open-web-profile");
        let api = "http://local.test:8787";
        let mut settings = default_settings();
        let profile = CloudProfile {
            id: profile_id_for_api(api),
            name: "Local Acme".to_string(),
            api_base: api.to_string(),
            web_origin: Some(api.to_string()),
            products: vec![DesktopProductCatalogEntry {
                id: "acme-demo".to_string(),
                name: "Acme Demo".to_string(),
                origin: Some(api.to_string()),
                web_url: Some(format!("{api}/acme")),
                official_origin: Some(api.to_string()),
                official_origins: vec![api.to_string()],
            }],
            source: "user".to_string(),
            updated_at: now_string(),
        };
        upsert_cloud_profile(&mut settings, profile, true);
        save_settings(&settings).unwrap();

        let url = open_web_url(&json!({ "product_id": "acme-demo" }));

        assert_eq!(url, format!("{api}/acme"));
        restore_env_var("HOME", old_home);
        restore_env_var("USERPROFILE", old_userprofile);
        reset_credentials_env();
        let _ = fs::remove_dir_all(home);
    }

    fn connect_intent_payload(policy: Value) -> Value {
        json!({
            "connect_intent": {
                "product_id": "bridge-demo",
                "product": {
                    "id": "bridge-demo",
                    "name": "Bridge Demo",
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

    fn test_pending_intent_claim() -> PendingIntentClaim {
        let policy = json!({
            "version": "BRIDGE-RELAY-AUTH-v1",
            "product_id": "acme-chat",
            "source_origin": "https://acme.example",
            "capabilities": ["relay.envelope", "relay.ack"],
            "product_authorization": {
                "owner": "acme-product-adapter",
                "enforcement": "acme-product-adapter",
                "control": "computer-control"
            }
        });
        PendingIntentClaim {
            api_base: "http://local.test".to_string(),
            intent: "intent_secret_token".to_string(),
            device_token: "pbd_secret_device_token".to_string(),
            token_expires_at: Some("2099-01-01T00:00:00Z".to_string()),
            install_id: "install_1".to_string(),
            install_identity_bound: Some(true),
            device: Device {
                id: "dev_1".to_string(),
                device_name: "Device".to_string(),
            },
            account: Some(ConnectUser {
                id: Some("user_1".to_string()),
                display_name: None,
                email: Some("user@example.test".to_string()),
            }),
            product: Some(ProductInfo {
                id: "acme-chat".to_string(),
                name: "Acme Chat".to_string(),
                origin: Some("https://acme.example".to_string()),
                official_origin: None,
                official_origins: Vec::new(),
                web_url: Some("https://acme.example/authorize".to_string()),
                capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
            }),
            authorization: Some(AuthorizationInfo {
                status: Some(AuthorizationState::Pending),
                policy: policy.clone(),
                source_origin: Some("https://acme.example".to_string()),
                epoch: 1,
            }),
            devices: None,
            preview: IntentPreview {
                product_id: "acme-chat".to_string(),
                product_name: "Acme Chat".to_string(),
                cloud_origin: "https://acme.example".to_string(),
                capabilities: vec!["relay.envelope".to_string(), "relay.ack".to_string()],
                local_policy: policy,
                device_name: "Panda Bridge Desktop".to_string(),
                user_id: Some("user_1".to_string()),
                user_display_name: "user@example.test".to_string(),
                expires_at: "2099-01-01T00:00:00Z".to_string(),
                confirmation_mode: "confirm".to_string(),
            },
        }
    }

    #[test]
    fn pending_claim_public_value_exposes_preview_without_device_token() {
        let pending = test_pending_intent_claim();
        let public = pending_claim_public_value(&pending);
        assert_eq!(public["status"], "pending");
        assert_eq!(
            public["policy_capabilities"],
            json!(["relay.envelope", "relay.ack"])
        );
        assert_eq!(
            public["product_authorization"]["owner"],
            "acme-product-adapter"
        );
        assert_eq!(
            public["product_authorization"]["control"],
            "computer-control"
        );
        assert!(public["product_authorization"].get("capabilities").is_none());
        assert!(public["product_authorization"].get("roots").is_none());
        assert_eq!(
            public["authorization"]["source_origin"],
            "https://acme.example"
        );
        let text = serde_json::to_string(&public).unwrap();
        assert!(!text.contains("pbd_secret_device_token"));
        assert!(!text.contains("intent_secret_token"));
        assert!(text.contains("product_authorization"));
    }

    #[test]
    fn pending_claim_public_value_prefers_policy_display_product() {
        let mut pending = test_pending_intent_claim();
        if let Some(authorization) = pending.authorization.as_mut() {
            authorization.policy["display"] = json!({ "product": "Coco" });
        }
        pending.preview.local_policy["display"] = json!({ "product": "Coco" });

        let public = pending_claim_public_value(&pending);

        assert_eq!(public["product"]["name"], "Coco");
        let rows = pending_authorization_screenshot_rows(&public);
        assert!(rows.iter().any(|row| row == "PRODUCT: Coco (acme-chat)"));
    }

    fn start_one_shot_json_server(payload: Value) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let api = format!("http://{addr}");
        let api_for_thread = api.clone();
        let handle = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                let _ = reader.read_line(&mut request_line);
                loop {
                    let mut line = String::new();
                    let bytes = reader.read_line(&mut line).unwrap_or(0);
                    if bytes == 0 || line == "\r\n" || line == "\n" {
                        break;
                    }
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let response = if path == "/v1/health" {
                    json!({
                        "ok": true,
                        "protocol": BRIDGE_PROTOCOL_VERSION,
                        "env": "test",
                        "storage": "memory"
                    })
                } else if path == "/v1/diagnostics" {
                    json!({
                        "ok": true,
                        "protocol": BRIDGE_PROTOCOL_VERSION,
                        "api_base": api_for_thread.clone(),
                        "web_origin": api_for_thread.clone(),
                        "products": [{
                            "id": "bridge-demo",
                            "name": "Bridge Demo",
                            "origin": api_for_thread.clone(),
                            "official_origin": api_for_thread.clone(),
                            "official_origins": [api_for_thread.clone()],
                            "web_url": api_for_thread.clone(),
                            "capabilities": ["relay.envelope", "relay.ack"]
                        }]
                    })
                } else {
                    payload.clone()
                };
                write_http_json(&mut stream, 200, response).unwrap();
            }
        });
        (api, handle)
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
        let mut credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        credentials.device_id = device_id.to_string();
        credentials.device_name = format!("Device {device_id}");
        credentials.account_id = Some(account_id.to_string());
        credentials.account_display = Some(display.to_string());
        credentials
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
        let credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        save_credentials(&credentials).unwrap();

        let paused = toggle_authorization("bridge-demo", "user@example.test").unwrap();
        assert_eq!(paused["authorized"], "paused");
        let loaded = load_credentials().unwrap();
        assert_eq!(
            loaded.connections[0].authorized_products[0].authorization,
            AuthorizationState::Paused
        );
        assert!(authorized_connections(&loaded).is_empty());

        let restored = toggle_authorization("bridge-demo", "user@example.test").unwrap();
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
        let mut credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        credentials.api_base = "http://127.0.0.1:9".to_string();
        save_credentials(&credentials).unwrap();

        let removed = revoke_authorization("bridge-demo", Some("user@example.test"), None).unwrap();
        assert_eq!(removed["ok"], true);
        let loaded = load_credentials().unwrap();
        assert!(credentials_products(&loaded).is_empty());

        reset_credentials_env();
        let _ = fs::remove_file(state_path);
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
        assert_eq!(
            windows_registry_command_for_exe(Path::new(
                r"C:\Users\Ada Lovelace\AppData\Local\Panda Bridge\PandaBridge.exe"
            )),
            r#""C:\Users\Ada Lovelace\AppData\Local\Panda Bridge\PandaBridge.exe""#
        );

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
        let mut credentials = test_credentials(vec!["relay.envelope", "relay.ack"]);
        credentials.authorized_products[0].authorization = AuthorizationState::Paused;
        let state = new_app_state();
        state.worker_running.store(true, Ordering::SeqCst);
        state.realtime_connected.store(true, Ordering::SeqCst);

        let mut settings = default_settings();
        normalize_settings(&mut settings, &credentials.api_base);
        settings.selected_cloud_profile_id = profile_id_for_api(&credentials.api_base);
        let products = desktop_products(Some(&credentials), &state, &settings);
        let bridge_demo = products
            .iter()
            .find(|product| product.id == "bridge-demo")
            .unwrap();
        assert_eq!(bridge_demo.accounts.len(), 1);
        assert_eq!(bridge_demo.accounts[0].authorized, AuthorizationState::Paused);
        assert!(!bridge_demo.accounts[0].connected);
        assert_eq!(bridge_demo.accounts[0].connection, "disabled");

        let serialized = serde_json::to_value(bridge_demo).unwrap();
        assert_eq!(serialized["accounts"][0]["authorized"], "paused");
        assert_eq!(serialized["accounts"][0]["connected"], false);

        credentials.authorized_products[0].authorization = AuthorizationState::Active;
        let products = desktop_products(Some(&credentials), &state, &settings);
        let account = &products
            .iter()
            .find(|product| product.id == "bridge-demo")
            .unwrap()
            .accounts[0];
        assert_eq!(account.authorized, AuthorizationState::Active);
        assert!(account.connected);
        assert_eq!(account.connection, "connected");
    }

    #[test]
    fn pending_preview_public_value_hides_local_scope_state() {
        let public = pending_claim_public_value(&test_pending_intent_claim());
        assert_eq!(public["local_root_state"], Value::Null);
        assert_eq!(public["scope_widening"], Value::Null);
        assert_eq!(public["scope_diff"], Value::Null);
        assert_eq!(public["confirmation_mode"], "confirm");
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
    fn local_policy_preview_defaults_to_relay_only() {
        let preview = local_policy_preview();
        assert_eq!(preview["version"], "BRIDGE-RELAY-AUTH-v1");
        assert_eq!(preview["request_source"], "desktop_default_relay");
        assert_eq!(preview["capabilities"], json!(["relay.envelope", "relay.ack"]));
        assert_eq!(preview["workspace_roots"], Value::Null);
        assert_eq!(preview["sandbox_floor"], Value::Null);
        assert_eq!(preview["approval_policy_floor"], Value::Null);
        assert_eq!(preview["allow_developer_instructions"], Value::Null);
        assert_eq!(capabilities()["runtime"], Value::Null);
        assert_eq!(
            capabilities()["relay"],
            json!(["relay.envelope", "relay.ack"])
        );
        assert_eq!(local_state()["commands"], Value::Null);
        assert_eq!(local_state()["workspaces"], Value::Null);
    }

    #[test]
    fn intent_authorization_policy_defaults_to_relay_only() {
        let intent = ConnectIntent {
            product_id: "bridge-demo".to_string(),
            product: None,
            policy: json!({}),
            source_origin: Some("http://local.test".to_string()),
            device_name: Some("Device".to_string()),
            expires_at: "2099-01-01T00:00:00Z".to_string(),
            user: None,
        };
        let product_capabilities = vec![
            "relay.envelope".to_string(),
            "relay.ack".to_string(),
        ];
        let policy = intent_authorization_policy(
            &intent,
            "bridge-demo",
            "http://local.test",
            &product_capabilities,
        );
        assert_eq!(policy["version"], "BRIDGE-RELAY-AUTH-v1");
        assert_eq!(policy["request_source"], "desktop_default_relay");
        assert_eq!(policy["capabilities"], json!(["relay.envelope", "relay.ack"]));
        assert_eq!(policy["workspace_roots"], Value::Null);
        assert_eq!(policy["sandbox_floor"], Value::Null);
        assert_eq!(policy["approval_policy_floor"], Value::Null);
        assert_eq!(policy["allow_developer_instructions"], Value::Null);
    }

    #[test]
    fn merge_authorized_products_preserves_pending_until_confirm() {
        let products = merge_authorized_products(
            None,
            Some("bridge-demo".to_string()),
            Some("Bridge Demo".to_string()),
            Some("http://local.test".to_string()),
            vec!["relay.envelope".to_string()],
            json!({ "capabilities": ["relay.envelope"] }),
            1,
            AuthorizationState::Pending,
        );
        assert_eq!(products.len(), 1);
        assert_eq!(products[0].authorization, AuthorizationState::Pending);
        assert!(!products[0].authorization.is_active());
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
                "relay_available": true,
                "authorized_products": [{
                    "id": "bridge-demo",
                    "name": "Bridge Demo",
                    "origin": "http://chat.local.test",
                    "capabilities": ["relay.envelope", "relay.ack"],
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
