const VERSION: &str = "bridge-desktop-lite-v0.1";
const BRIDGE_PROTOCOL_VERSION: &str = "bridge-protocol-v0.2";
const KEYCHAIN_SERVICE: &str = "ai.chaosrealms.bridge";
const KEYCHAIN_USER: &str = "device";
const DEFAULT_API: &str = "https://api.bridge.chaos-realms.cc";
const DEFAULT_WEB: &str = "https://bridge.chaos-realms.cc";
const DESKTOP_WINDOW_WIDTH: f64 = 840.0;
const DESKTOP_WINDOW_HEIGHT: f64 = 560.0;
#[cfg(windows)]
const WINDOWS_SINGLE_INSTANCE_ADDR: &str = "127.0.0.1:52321";
#[cfg(windows)]
const WINDOWS_SINGLE_INSTANCE_STATE_FILE: &str = "windows-single-instance.json";

#[derive(Clone)]
struct AppState {
    worker_running: Arc<AtomicBool>,
    realtime_connected: Arc<AtomicBool>,
    realtime_connection_keys: Arc<Mutex<HashSet<String>>>,
    realtime_connected_keys: Arc<Mutex<HashSet<String>>>,
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
    #[serde(default = "default_connection_enabled")]
    connection_enabled: bool,
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
    #[serde(default = "default_connection_enabled")]
    connection_enabled: bool,
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
    local_device: LocalDeviceInfo,
    account_id: Option<String>,
    account_display: Option<String>,
    product_id: Option<String>,
    product_name: Option<String>,
    cloud_origin: Option<String>,
    authorized_products: Vec<ProductGrant>,
    products: Vec<DesktopProductStatus>,
    settings: DesktopSettings,
    selected_profile: SelectedProfileLiveStatus,
    worker_running: bool,
    realtime_connected: bool,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedProfileLiveStatus {
    profile_id: String,
    label: String,
    api_base: String,
    server: SelectedServerLiveStatus,
    device: SelectedDeviceLiveStatus,
    account: SelectedAccountLiveStatus,
    local_engine: SelectedLocalEngineLiveStatus,
    transport: SelectedTransportLiveStatus,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedServerLiveStatus {
    reachable: Option<bool>,
    compatible: Option<bool>,
    last_probe_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe_latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics_latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_phase: Option<String>,
    error: Option<String>,
    source: String,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedDeviceLiveStatus {
    paired: bool,
    present: Option<bool>,
    last_seen_at: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedAccountLiveStatus {
    authorized: bool,
    authorization_state: String,
    connection_enabled: bool,
    account_id: Option<String>,
    account_display: Option<String>,
    product_ids: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedLocalEngineLiveStatus {
    running: bool,
    adapter_health: String,
    adapter_configured: bool,
    adapter_running: bool,
    adapter_products: Vec<SelectedAdapterLiveStatus>,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedAdapterLiveStatus {
    product_id: String,
    state: String,
    configured: bool,
    running: bool,
    endpoint_source: String,
}

#[derive(Debug, Serialize, Clone)]
struct SelectedTransportLiveStatus {
    realtime_state: String,
    polling_state: String,
    realtime_connected: bool,
    polling_active: bool,
    degraded_reason: Option<String>,
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
    connection_enabled: bool,
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

fn default_connection_enabled() -> bool {
    true
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
    #[serde(default, rename = "products")]
    _products: Vec<ProductInfo>,
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
struct ManagedAdapterManifest {
    product_id: String,
    #[serde(default)]
    product_name: Option<String>,
    runtime: ManagedAdapterRuntime,
}

#[derive(Debug, Deserialize, Default)]
struct ManagedAdapterRuntime {
    #[serde(default, rename = "type")]
    runtime_type: String,
    entry: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
}

struct ManagedAdapterProcess {
    product_id: String,
    endpoint: String,
    manifest_path: PathBuf,
    product_name: Option<String>,
    child: Child,
    started_at: Instant,
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
        realtime_connected_keys: Arc::new(Mutex::new(HashSet::new())),
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
