use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;

use crate::{connection_products, BridgeJob, Credentials, ProductGrant};

const CAP_TOKEN_VERSION: &str = "PBCAP-v1";
const CAP_TOKEN_ISSUER: &str = "panda-bridge-cloud";
const CAP_TOKEN_TYP: &str = "pbcap+jws";
const DEFAULT_KID: &str = "pb-cap-test-2026q2";
const DEFAULT_PUBLIC_KEY_RAW_B64: &str = "/bJW7BI4LVkDp9mz6DeP24Ro1QKW8OIztinttSzznYU=";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapTokenDecision {
    pub verdict: &'static str,
    pub reason: Option<String>,
    pub jti: Option<String>,
    pub eph: Option<u64>,
    pub uses: Option<u64>,
}

impl CapTokenDecision {
    fn allow(jti: Option<String>, eph: Option<u64>, uses: Option<u64>) -> Self {
        Self {
            verdict: "allow",
            reason: None,
            jti,
            eph,
            uses,
        }
    }

    fn deny(reason: &str, jti: Option<String>, eph: Option<u64>) -> Self {
        Self {
            verdict: "deny",
            reason: Some(reason.to_string()),
            jti,
            eph,
            uses: None,
        }
    }

    pub(crate) fn is_allow(&self) -> bool {
        self.verdict == "allow"
    }

    pub(crate) fn reason_str(&self) -> &str {
        self.reason.as_deref().unwrap_or("cap_token_denied")
    }
}

#[derive(Debug, Clone)]
struct CapTokenContext {
    now: u64,
    device_id: String,
    user_id: Option<String>,
    epoch: u64,
    authorization_policy: Value,
    job: BridgeJob,
    jti_uses: u64,
}

pub(crate) fn mode() -> &'static str {
    match env::var("PANDA_BRIDGE_CAPTOKEN_MODE")
        .unwrap_or_else(|_| "shadow".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "enforce" => "enforce",
        _ => "shadow",
    }
}

pub(crate) fn verify_for_job(credentials: &Credentials, job: &BridgeJob) -> CapTokenDecision {
    let Some(token) = job
        .cap_token
        .as_deref()
        .map(str::trim)
        .filter(|item| !item.is_empty())
    else {
        return CapTokenDecision::deny("cap_token_missing", None, None);
    };
    let grant = connection_products(credentials)
        .into_iter()
        .find(|item| item.id == job.product_id);
    let context = context_from_grant(credentials, job, grant.as_ref(), 0);
    let parsed = match parse_compact_jws(token) {
        Ok(parsed) => parsed,
        Err(reason) => return CapTokenDecision::deny(reason, None, None),
    };
    let jti = string_field(&parsed.claims, "jti");
    let eph = u64_field(&parsed.claims, "eph");
    if let Err(reason) = verify_signature(&parsed) {
        return CapTokenDecision::deny(reason, jti, eph);
    }
    let used = jti.as_deref().map(jti_uses).unwrap_or_default();
    let context = CapTokenContext {
        jti_uses: used,
        ..context
    };
    let decision = verify_claims(&parsed.claims, &context);
    if decision.is_allow() {
        let Some(jti) = decision.jti.clone() else {
            return CapTokenDecision::deny("cap_token_malformed", None, decision.eph);
        };
        let max = u64_field(&parsed.claims, "max").unwrap_or(1);
        let Some(uses) = try_consume_jti(&jti, max) else {
            return CapTokenDecision::deny("cap_token_replay", Some(jti), decision.eph);
        };
        return CapTokenDecision::allow(Some(jti), decision.eph, Some(uses));
    }
    decision
}

fn context_from_grant(
    credentials: &Credentials,
    job: &BridgeJob,
    grant: Option<&ProductGrant>,
    jti_uses: u64,
) -> CapTokenContext {
    CapTokenContext {
        now: now_seconds(),
        device_id: credentials.device_id.clone(),
        user_id: credentials.account_id.clone(),
        epoch: grant.map(|item| item.epoch.max(1)).unwrap_or(1),
        authorization_policy: grant.map(|item| item.policy.clone()).unwrap_or(Value::Null),
        job: job.clone(),
        jti_uses,
    }
}

fn verify_claims(claims: &Value, context: &CapTokenContext) -> CapTokenDecision {
    let jti = string_field(claims, "jti");
    let eph = u64_field(claims, "eph");
    if string_field(claims, "v").as_deref() != Some(CAP_TOKEN_VERSION)
        || string_field(claims, "iss").as_deref() != Some(CAP_TOKEN_ISSUER)
    {
        return CapTokenDecision::deny("cap_token_malformed", jti, eph);
    }
    let Some(nbf) = u64_field(claims, "nbf") else {
        return CapTokenDecision::deny("cap_token_malformed", jti, eph);
    };
    let Some(exp) = u64_field(claims, "exp") else {
        return CapTokenDecision::deny("cap_token_malformed", jti, eph);
    };
    if exp <= nbf {
        return CapTokenDecision::deny("cap_token_malformed", jti, eph);
    }
    if context.now < nbf {
        return CapTokenDecision::deny("cap_token_not_yet_valid", jti, eph);
    }
    if context.now >= exp {
        return CapTokenDecision::deny("cap_token_expired", jti, eph);
    }
    if string_field(claims, "aud").as_deref() != Some(context.device_id.as_str()) {
        return CapTokenDecision::deny("cap_token_audience_mismatch", jti, eph);
    }
    if string_field(claims, "prd").as_deref() != Some(context.job.product_id.as_str()) {
        return CapTokenDecision::deny("cap_token_product_mismatch", jti, eph);
    }
    if let Some(user_id) = context.user_id.as_deref() {
        if string_field(claims, "sub").as_deref() != Some(user_id) {
            return CapTokenDecision::deny("cap_token_subject_mismatch", jti, eph);
        }
    }
    if string_field(claims, "job").as_deref() != Some(context.job.id.as_str()) {
        return CapTokenDecision::deny("cap_token_job_mismatch", jti, eph);
    }
    if string_field(claims, "rkh").as_deref()
        != Some(request_key_hash(&context.job.request_key).as_str())
    {
        return CapTokenDecision::deny("cap_token_request_key_mismatch", jti, eph);
    }
    let cap = string_array_field(claims, "cap");
    if !cap.iter().any(|item| item == &context.job.kind) {
        return CapTokenDecision::deny("cap_token_capability_missing", jti, eph);
    }
    let authorized = authorization_policy_capabilities(&context.authorization_policy);
    if !authorized.is_empty() && cap.iter().any(|item| !authorized.contains(item)) {
        return CapTokenDecision::deny("cap_token_scope_mismatch", jti, eph);
    }
    if eph != Some(context.epoch) {
        return CapTokenDecision::deny("cap_token_epoch_stale", jti, eph);
    }
    let Some(max) = u64_field(claims, "max").filter(|value| *value >= 1) else {
        return CapTokenDecision::deny("cap_token_malformed", jti, eph);
    };
    if context.jti_uses >= max {
        return CapTokenDecision::deny("cap_token_replay", jti, eph);
    }
    let expected_bnd = compute_boundary_fingerprint(&context.authorization_policy, &context.job);
    if string_field(claims, "bnd").as_deref() != Some(expected_bnd.as_str()) {
        return CapTokenDecision::deny("cap_token_bnd_mismatch", jti, eph);
    }
    CapTokenDecision::allow(jti, eph, Some(context.jti_uses + 1))
}

fn parse_compact_jws(token: &str) -> Result<ParsedJws, &'static str> {
    let parts = token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("cap_token_malformed");
    }
    let header_bytes = base64url_decode(parts[0]).map_err(|_| "cap_token_malformed")?;
    let claims_bytes = base64url_decode(parts[1]).map_err(|_| "cap_token_malformed")?;
    let signature = base64url_decode(parts[2]).map_err(|_| "cap_token_malformed")?;
    let header: Value = serde_json::from_slice(&header_bytes).map_err(|_| "cap_token_malformed")?;
    let claims: Value = serde_json::from_slice(&claims_bytes).map_err(|_| "cap_token_malformed")?;
    Ok(ParsedJws {
        protected: parts[0].to_string(),
        payload: parts[1].to_string(),
        signature,
        header,
        claims,
    })
}

struct ParsedJws {
    protected: String,
    payload: String,
    signature: Vec<u8>,
    header: Value,
    claims: Value,
}

fn verify_signature(parsed: &ParsedJws) -> Result<(), &'static str> {
    if string_field(&parsed.header, "alg").as_deref() != Some("EdDSA")
        || string_field(&parsed.header, "typ").as_deref() != Some(CAP_TOKEN_TYP)
    {
        return Err("cap_token_malformed");
    }
    let kid = string_field(&parsed.header, "kid").ok_or("cap_token_kid_unknown")?;
    let public_key = public_keys().remove(&kid).ok_or("cap_token_kid_unknown")?;
    let key_bytes = STANDARD
        .decode(public_key)
        .map_err(|_| "cap_token_kid_unknown")?;
    let key_array: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "cap_token_kid_unknown")?;
    let verifying_key =
        VerifyingKey::from_bytes(&key_array).map_err(|_| "cap_token_kid_unknown")?;
    let signature =
        Signature::from_slice(&parsed.signature).map_err(|_| "cap_token_signature_invalid")?;
    let signing_input = format!("{}.{}", parsed.protected, parsed.payload);
    verifying_key
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| "cap_token_signature_invalid")
}

fn public_keys() -> HashMap<String, String> {
    let mut keys = HashMap::from([(
        DEFAULT_KID.to_string(),
        DEFAULT_PUBLIC_KEY_RAW_B64.to_string(),
    )]);
    if let Ok(raw) = env::var("PANDA_BRIDGE_CAPTOKEN_PUBLIC_KEYS") {
        if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) {
            for (kid, key) in map {
                if let Some(key) = key.as_str() {
                    keys.insert(kid, key.to_string());
                }
            }
        } else {
            for item in raw.split(',') {
                let mut parts = item.splitn(2, ':');
                if let (Some(kid), Some(key)) = (parts.next(), parts.next()) {
                    if !kid.trim().is_empty() && !key.trim().is_empty() {
                        keys.insert(kid.trim().to_string(), key.trim().to_string());
                    }
                }
            }
        }
    }
    keys
}

fn compute_boundary_fingerprint(policy: &Value, job: &BridgeJob) -> String {
    let normalized = normalize_boundary(policy, job);
    format!("sha256:{}", sha256_hex(&canonical_json(&normalized)))
}

fn normalize_boundary(policy: &Value, job: &BridgeJob) -> Value {
    match capability_domain(&job.kind).as_str() {
        "data" => normalize_data_boundary(policy, job),
        "fs" => normalize_fs_boundary(policy),
        "shell" => normalize_shell_boundary(policy),
        "codex" => normalize_codex_boundary(policy),
        domain => json!({
            "type": "opaque_runtime",
            "domain": trim_nfc(domain),
            "capabilities": normalize_string_list(policy.get("capabilities")),
        }),
    }
}

fn normalize_shell_boundary(policy: &Value) -> Value {
    let shell = policy.pointer("/boundaries/shell").unwrap_or(&Value::Null);
    let mut cmd_allowlist = shell
        .get("cmd_allowlist")
        .or_else(|| shell.get("cmdAllowlist"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(trim_nfc_keep_slash))
        .filter(|item| !item.is_empty())
        .map(Value::String)
        .collect::<Vec<_>>();
    // Sort by raw code points (Rust str Ord = UTF-8 byte order = code-point order)
    // to match the JS codePointCompare on the raw string. canonical_json sorts the
    // escaped+quoted form, which diverges from JS on JSON-escapable chars (\t, ", \).
    cmd_allowlist.sort_by(|left, right| {
        left.as_str().unwrap_or_default().cmp(right.as_str().unwrap_or_default())
    });
    cmd_allowlist.dedup_by(|left, right| left.as_str() == right.as_str());
    let limits = shell.get("limits").unwrap_or(&Value::Null);
    json!({
        "type": "command_sandbox",
        "cwd_root_id": trim_nfc_keep_slash(policy_string(shell, "cwd_root_id").or_else(|| policy_string(shell, "cwdRootId")).unwrap_or_default()),
        "net": normalize_shell_net(shell),
        "allow_exec_subtree": shell.get("allow_exec_subtree").or_else(|| shell.get("allowExecSubtree")).and_then(Value::as_bool).unwrap_or(false),
        "cmd_allowlist": cmd_allowlist,
        "max_output_bytes": bounded_usize_field(shell, "max_output_bytes", "maxOutputBytes", 1_048_576, 1, 16_777_216),
        "deadline_ms": bounded_usize_field(shell, "deadline_ms", "deadlineMs", 30_000, 1, 600_000),
        "limits": {
            "cpu_seconds": bounded_usize_field(limits, "cpu_seconds", "cpuSeconds", 30, 1, 300),
            "address_space": bounded_usize_field(limits, "address_space", "addressSpace", 1_073_741_824, 67_108_864, 8_589_934_592usize),
            "open_files": bounded_usize_field(limits, "open_files", "openFiles", 128, 3, 1024),
            "processes": bounded_usize_field(limits, "processes", "processes", 16, 1, 128),
            "file_size": bounded_usize_field(limits, "file_size", "fileSize", 67_108_864, 1, 1_073_741_824)
        }
    })
}

fn normalize_shell_net(shell: &Value) -> String {
    match shell
        .get("net")
        .and_then(Value::as_str)
        .map(trim_nfc)
        .unwrap_or_else(|| "deny".to_string())
        .as_str()
    {
        "allow_outbound" | "allow-outbound" | "outbound" => "allow_outbound".to_string(),
        _ => "deny".to_string(),
    }
}

fn normalize_codex_boundary(policy: &Value) -> Value {
    let mut roots = policy
        .get("workspace_roots")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, root)| {
            let id = root
                .get("id")
                .and_then(Value::as_str)
                .map(trim_nfc)
                .filter(|item| !item.is_empty())
                .unwrap_or_else(|| format!("workspace-{}", index + 1));
            let allow_all = root
                .get("allow_all")
                .or_else(|| root.get("allowAll"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || matches!(root.get("id").and_then(Value::as_str), Some("all" | "*"));
            json!({ "id": id, "allow_all": allow_all })
        })
        .collect::<Vec<_>>();
    roots.sort_by_key(canonical_json);
    roots.dedup_by(|left, right| canonical_json(left) == canonical_json(right));
    json!({
        "capabilities": normalize_string_list(policy.get("capabilities")),
        "workspace_roots": roots,
        "sandbox_floor": trim_nfc(policy_string(policy, "sandbox_floor").or_else(|| policy_string(policy, "sandboxFloor")).unwrap_or_else(|| "workspace-write".to_string())),
        "approval_policy_floor": trim_nfc(policy_string(policy, "approval_policy_floor").or_else(|| policy_string(policy, "approvalPolicyFloor")).unwrap_or_else(|| "on-request".to_string())),
        "allow_developer_instructions": policy.get("allow_developer_instructions").or_else(|| policy.get("allowDeveloperInstructions")).and_then(Value::as_bool).unwrap_or(false),
    })
}

fn normalize_data_boundary(policy: &Value, job: &BridgeJob) -> Value {
    let data = policy.pointer("/boundaries/data").unwrap_or(&Value::Null);
    json!({
        "type": trim_nfc(policy_string(data, "type").or_else(|| policy_string(data, "boundary_type")).or_else(|| policy_string(data, "boundaryType")).unwrap_or_else(|| "namespace_kv".to_string())),
        "owner_product_id": trim_nfc(policy_string(data, "owner_product_id").or_else(|| policy_string(data, "ownerProductId")).unwrap_or_else(|| job.product_id.clone())),
        "namespace": trim_nfc(policy_string(data, "namespace").unwrap_or_else(|| format!("product:{}", job.product_id))),
    })
}

fn normalize_fs_boundary(policy: &Value) -> Value {
    let fs = policy.pointer("/boundaries/fs").unwrap_or(&Value::Null);
    let mut roots = normalize_fs_display_roots(fs, "allowed_roots", "allowedRoots");
    roots.sort_by_key(canonical_json);
    roots.dedup_by(|left, right| canonical_json(left) == canonical_json(right));
    let mut write_roots = normalize_fs_display_roots(fs, "write_roots", "writeRoots");
    write_roots.sort_by_key(canonical_json);
    write_roots.dedup_by(|left, right| canonical_json(left) == canonical_json(right));
    json!({
        "type": "directory_whitelist",
        "allowed_roots": roots,
        "write_roots": write_roots,
        "writable": fs.get("writable").and_then(Value::as_bool).unwrap_or(false),
        "max_bytes": bounded_usize_field(fs, "max_bytes", "maxBytes", 8_388_608, 1, 67_108_864),
        "follow_symlinks": fs.get("follow_symlinks").or_else(|| fs.get("followSymlinks")).and_then(Value::as_bool).unwrap_or(false),
    })
}

fn normalize_fs_display_roots(fs: &Value, snake_key: &str, camel_key: &str) -> Vec<Value> {
    fs.get(snake_key)
        .or_else(|| fs.get(camel_key))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, root)| {
            let id = root
                .get("id")
                .and_then(Value::as_str)
                .map(trim_nfc_keep_slash)
                .filter(|item| !item.is_empty())
                .unwrap_or_else(|| format!("root-{}", index + 1));
            let path_display = root
                .get("path_display")
                .or_else(|| root.get("pathDisplay"))
                .and_then(Value::as_str)
                .map(trim_nfc_keep_slash)
                .unwrap_or_default();
            json!({ "id": id, "path_display": path_display })
        })
        .collect::<Vec<_>>()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let entries = map.iter().collect::<BTreeMap<_, _>>();
            let body = entries
                .into_iter()
                .map(|(key, nested)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(nested)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

fn request_key_hash(request_key: &Option<String>) -> String {
    format!(
        "sha256:{}",
        sha256_hex(request_key.as_deref().unwrap_or(""))
    )
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn normalize_string_list(input: Option<&Value>) -> Value {
    let mut values = input
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(trim_nfc))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    Value::Array(values.into_iter().map(Value::String).collect())
}

fn authorization_policy_capabilities(policy: &Value) -> Vec<String> {
    normalize_string_list(policy.get("capabilities"))
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(ToOwned::to_owned))
        .collect()
}

fn capability_domain(kind: &str) -> String {
    kind.split('.').next().unwrap_or("unknown").to_string()
}

fn policy_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|item| {
        item.as_u64()
            .or_else(|| item.as_i64().and_then(|value| u64::try_from(value).ok()))
    })
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(|text| text.trim().to_string()))
        .filter(|item| !item.is_empty())
        .collect()
}

fn trim_nfc(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .trim()
        .nfc()
        .collect::<String>()
        .trim_end_matches('/')
        .to_string()
}

fn trim_nfc_keep_slash(value: impl AsRef<str>) -> String {
    value.as_ref().trim().nfc().collect::<String>()
}

fn bounded_usize_field(
    value: &Value,
    snake_key: &str,
    camel_key: &str,
    fallback: usize,
    min: usize,
    max: usize,
) -> usize {
    value
        .get(snake_key)
        .or_else(|| value.get(camel_key))
        .and_then(Value::as_f64)
        .map(|number| {
            let truncated = number.trunc();
            if truncated < min as f64 {
                min
            } else if truncated > max as f64 {
                max
            } else {
                truncated as usize
            }
        })
        .unwrap_or(fallback)
}

fn base64url_decode(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(value)
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn now_seconds() -> u64 {
    // Test-only clock override: honoured solely in debug builds so a release
    // binary cannot have exp/nbf frozen by an attacker-controlled env var.
    if cfg!(debug_assertions) {
        if let Some(value) = env::var("PANDA_BRIDGE_CAPTOKEN_NOW_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
        {
            return value;
        }
    }
    unix_seconds()
}

fn jti_store() -> &'static Mutex<HashMap<String, u64>> {
    static STORE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn jti_uses(jti: &str) -> u64 {
    jti_store()
        .lock()
        .map(|store| *store.get(jti).unwrap_or(&0))
        .unwrap_or(0)
}

fn try_consume_jti(jti: &str, max: u64) -> Option<u64> {
    let Ok(mut store) = jti_store().lock() else {
        return None;
    };
    let uses = store.entry(jti.to_string()).or_insert(0);
    if *uses >= max {
        return None;
    }
    *uses += 1;
    Some(*uses)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../spec/captoken/vectors.json")).unwrap()
    }

    fn merge(base: &Value, patch: Option<&Value>) -> Value {
        let Some(Value::Object(patch_map)) = patch else {
            return base.clone();
        };
        let mut result = base.clone();
        let Value::Object(result_map) = &mut result else {
            return base.clone();
        };
        for (key, value) in patch_map {
            if matches!(value, Value::Object(_))
                && matches!(result_map.get(key), Some(Value::Object(_)))
            {
                let nested = merge(result_map.get(key).unwrap(), Some(value));
                result_map.insert(key.clone(), nested);
            } else {
                result_map.insert(key.clone(), value.clone());
            }
        }
        result
    }

    fn job_from_value(value: &Value) -> BridgeJob {
        BridgeJob {
            id: string_field(value, "id").unwrap(),
            product_id: string_field(value, "product_id").unwrap(),
            kind: string_field(value, "kind").unwrap(),
            workspace_ref: value
                .get("workspace_ref")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            input: value.get("input").cloned().unwrap_or_else(|| json!({})),
            policy: value.get("policy").cloned().unwrap_or_else(|| json!({})),
            request_key: value
                .get("request_key")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            cap_token: value
                .get("cap_token")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        }
    }

    fn context_from_value(value: &Value) -> CapTokenContext {
        CapTokenContext {
            now: u64_field(value, "now").unwrap(),
            device_id: string_field(value, "device_id").unwrap(),
            user_id: string_field(value, "user_id"),
            epoch: u64_field(value, "epoch").unwrap(),
            authorization_policy: value.get("authorization_policy").cloned().unwrap(),
            job: job_from_value(value.get("job").unwrap()),
            jti_uses: u64_field(value, "jti_uses").unwrap_or(0),
        }
    }

    #[test]
    fn shared_claim_vectors_match() {
        let vectors = vectors();
        let base_claims = vectors.get("base_claims").unwrap();
        let base_context = vectors.get("base_context").unwrap();
        let cases = vectors
            .get("claim_cases")
            .and_then(Value::as_array)
            .unwrap();
        for case in cases {
            let claims = merge(base_claims, case.get("claims_patch"));
            let context_value = merge(base_context, case.get("context_patch"));
            let actual = verify_claims(&claims, &context_from_value(&context_value));
            assert_eq!(
                actual.verdict,
                case.pointer("/expect/verdict")
                    .and_then(Value::as_str)
                    .unwrap(),
                "{}",
                case["name"]
            );
            let expected_reason = case.pointer("/expect/reason").and_then(Value::as_str);
            assert_eq!(
                actual.reason.as_deref(),
                expected_reason,
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn shared_boundary_vectors_match() {
        let vectors = vectors();
        let cases = vectors
            .get("boundary_cases")
            .and_then(Value::as_array)
            .unwrap();
        for case in cases {
            let job = job_from_value(case.get("job").unwrap());
            let bnd = compute_boundary_fingerprint(case.get("policy").unwrap(), &job);
            assert_eq!(
                bnd,
                case.pointer("/expect/bnd").and_then(Value::as_str).unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn shared_envelope_vectors_match() {
        let vectors = vectors();
        let base_claims = vectors.get("base_claims").unwrap();
        let context = context_from_value(vectors.get("base_context").unwrap());
        let cases = vectors
            .get("envelope_cases")
            .and_then(Value::as_array)
            .unwrap();
        for case in cases {
            let parsed = ParsedJws {
                protected: String::new(),
                payload: String::new(),
                signature: Vec::new(),
                header: case.get("header").unwrap().clone(),
                claims: base_claims.clone(),
            };
            let decision = match verify_signature(&parsed) {
                Ok(()) => verify_claims(&parsed.claims, &context),
                Err(reason) => CapTokenDecision::deny(reason, None, None),
            };
            assert_eq!(
                decision.verdict,
                case.pointer("/expect/verdict")
                    .and_then(Value::as_str)
                    .unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                decision.reason.as_deref(),
                case.pointer("/expect/reason").and_then(Value::as_str),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn verifies_js_signed_vector_token() {
        let vectors = vectors();
        let context = context_from_value(vectors.get("base_context").unwrap());
        let cases = vectors
            .get("signature_cases")
            .and_then(Value::as_array)
            .unwrap();
        for case in cases {
            let parsed =
                parse_compact_jws(case.get("token").and_then(Value::as_str).unwrap()).unwrap();
            verify_signature(&parsed).unwrap();
            let actual = verify_claims(&parsed.claims, &context);
            assert_eq!(
                actual.verdict,
                case.pointer("/expect/verdict")
                    .and_then(Value::as_str)
                    .unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                actual.reason.as_deref(),
                case.pointer("/expect/reason").and_then(Value::as_str),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn try_consume_jti_denies_second_max_one_use() {
        let jti = "jti_atomic_consume_unit_test";
        assert_eq!(try_consume_jti(jti, 1), Some(1));
        assert_eq!(try_consume_jti(jti, 1), None);
    }
}
