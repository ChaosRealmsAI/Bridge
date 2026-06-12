use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use unicode_normalization::UnicodeNormalization;

use crate::BridgeJob;

use super::sandbox::{self, NetPolicy, ResourceLimits, SandboxProfileKind, SandboxSpec};
use super::{
    BoundaryDescription, BoundaryType, BridgeConnector, ConnectorDanger, ConnectorDeclaration,
    ConnectorError, ConnectorExecutionResult, ConnectorGrant, ConnectorKindDeclaration, ExecCtx,
    GrantedBoundary,
};

pub const DEFAULT_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_BYTES_LIMIT: usize = 64 * 1024 * 1024;
const CAT_BIN: &str = "/bin/cat";
const CHUNK_BYTES: usize = 16 * 1024;
const FS_ALLOWED_ROOTS_ENV: &str = "PANDA_BRIDGE_FS_ALLOWED_ROOTS";

pub struct FsConnector;

impl FsConnector {
    pub fn new() -> Self {
        Self
    }
}

impl BridgeConnector for FsConnector {
    fn declare(&self) -> ConnectorDeclaration {
        ConnectorDeclaration {
            domain: "fs".to_string(),
            kinds: vec![ConnectorKindDeclaration {
                kind: "fs.read".to_string(),
                verb: "read".to_string(),
                danger: ConnectorDanger::High,
                boundary_type: BoundaryType::DirectoryWhitelist,
            }],
        }
    }

    fn execute(
        &mut self,
        job: &BridgeJob,
        boundary: &GrantedBoundary,
        ctx: &mut ExecCtx<'_>,
    ) -> Result<ConnectorExecutionResult, ConnectorError> {
        if ctx.cancelled() {
            return Err(ConnectorError::Cancelled);
        }
        if boundary.boundary_type != BoundaryType::DirectoryWhitelist || boundary.domain != "fs" {
            return deny("path", "boundary_type_mismatch_locally");
        }
        if job.kind != "fs.read" {
            return Err(ConnectorError::InvalidJob {
                reason: format!("unsupported fs kind: {}", job.kind),
            });
        }
        if !boundary.capabilities.iter().any(|item| item == &job.kind) {
            return deny("capability", "capability_not_authorized_locally");
        }

        let fs_boundary = FsBoundary::parse(&boundary.raw)?;
        let requested = absolute_input_path(job)?;
        let canonical = canonical_requested_path(&requested)?;
        // Fast local fallback for friendlier errors only. The kernel seatbelt
        // wrapped around /bin/cat is the security boundary at open() time.
        if !fs_boundary
            .allowed_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            return deny("path", "path_outside_allowlist_locally");
        }

        let spec = ctx
            .sandbox_spec
            .clone()
            .ok_or_else(|| ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_spec_missing_local".to_string(),
            })?;
        ctx.emit(
            "started",
            json!({
                "kind": job.kind,
                "boundaryType": "directory_whitelist",
                "path": crate::redact_local_path(&canonical.to_string_lossy())
            }),
        );
        read_with_sandboxed_cat(&canonical, fs_boundary.max_bytes, &spec, ctx)
    }

    fn describe_boundary(&self, grant: &ConnectorGrant) -> BoundaryDescription {
        let fs = grant
            .authorization_policy
            .pointer("/boundaries/fs")
            .unwrap_or(&Value::Null);
        let roots = normalized_display_roots(fs);
        let max_bytes = fs
            .get("max_bytes")
            .or_else(|| fs.get("maxBytes"))
            .and_then(Value::as_u64)
            .map(|value| clamp_max_bytes(value as usize))
            .unwrap_or(DEFAULT_MAX_BYTES);
        let follow_symlinks = fs
            .get("follow_symlinks")
            .or_else(|| fs.get("followSymlinks"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let root_bullets = roots
            .iter()
            .map(|root| format!("授权目录：{}", root.path_display))
            .collect::<Vec<_>>();
        let mut bullets = root_bullets;
        bullets.push("只读；无法写文件、执行任意程序或联网".to_string());
        bullets.push("授权目录外会被内核沙箱拒绝".to_string());
        bullets.push(format!("单次最多读取 {} bytes", max_bytes));
        BoundaryDescription {
            title: "高危本机文件读取".to_string(),
            summary: format!("{} 只能读取你显式授权目录内的文件。", grant.product_name),
            bullets,
            audit_label: format!("fs:{}", grant.product_id),
            redacted_boundary: json!({
                "type": "directory_whitelist",
                "allowed_roots": roots.into_iter().map(|root| {
                    json!({ "id": root.id, "path_display": root.path_display })
                }).collect::<Vec<_>>(),
                "max_bytes": max_bytes,
                "follow_symlinks": follow_symlinks
            }),
        }
    }

    fn sandbox_spec(
        &self,
        _job: &BridgeJob,
        boundary: &GrantedBoundary,
    ) -> Result<Option<SandboxSpec>, ConnectorError> {
        if !sandbox::backend().available() {
            return Err(ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_unavailable_local".to_string(),
            });
        }
        let fs_boundary = FsBoundary::parse(&boundary.raw)?;
        let cwd = fs_boundary.allowed_roots.first().cloned().ok_or_else(|| {
            ConnectorError::LocalPolicyDenied {
                denied: "path".to_string(),
                reason: "path_outside_allowlist_locally".to_string(),
            }
        })?;
        Ok(Some(SandboxSpec {
            profile: SandboxProfileKind::FsReadDir,
            read_roots: fs_boundary.allowed_roots,
            write_roots: Vec::new(),
            exec_allow: vec![PathBuf::from(CAT_BIN)],
            net: NetPolicy::Deny,
            limits: ResourceLimits::fs_read_default(),
            env_allow: Vec::new(),
            cwd,
        }))
    }
}

#[derive(Debug, Clone)]
struct FsBoundary {
    allowed_roots: Vec<PathBuf>,
    max_bytes: usize,
    #[allow(dead_code)]
    follow_symlinks: bool,
}

impl FsBoundary {
    fn parse(raw: &Value) -> Result<Self, ConnectorError> {
        let boundary_type = raw
            .get("type")
            .or_else(|| raw.get("boundary_type"))
            .or_else(|| raw.get("boundaryType"))
            .and_then(Value::as_str)
            .map(trim_nfc)
            .unwrap_or_else(|| "directory_whitelist".to_string());
        if boundary_type != "directory_whitelist" {
            return deny("path", "boundary_type_mismatch_locally");
        }

        let env_roots = fs_allowed_root_map();
        let display_roots = normalized_display_roots(raw);
        let mut allowed_roots = Vec::new();
        for root in &display_roots {
            let Some(local_path) = env_roots.get(&root.id) else {
                continue;
            };
            let Ok(canonical) = sandbox::canonical_existing_path(local_path) else {
                continue;
            };
            allowed_roots.push(canonical);
        }
        allowed_roots.sort_by_key(|path| path.to_string_lossy().to_string());
        allowed_roots.dedup();
        if allowed_roots.is_empty() {
            return deny("path", "path_outside_allowlist_locally");
        }
        let max_bytes = raw
            .get("max_bytes")
            .or_else(|| raw.get("maxBytes"))
            .and_then(Value::as_u64)
            .map(|value| clamp_max_bytes(value as usize))
            .unwrap_or(DEFAULT_MAX_BYTES);
        let follow_symlinks = raw
            .get("follow_symlinks")
            .or_else(|| raw.get("followSymlinks"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(Self {
            allowed_roots,
            max_bytes,
            follow_symlinks,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DisplayRoot {
    id: String,
    path_display: String,
}

fn normalized_display_roots(raw: &Value) -> Vec<DisplayRoot> {
    let mut roots = raw
        .get("allowed_roots")
        .or_else(|| raw.get("allowedRoots"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .map(trim_nfc)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("root-{}", index + 1));
            let path_display = item
                .get("path_display")
                .or_else(|| item.get("pathDisplay"))
                .and_then(Value::as_str)
                .map(trim_nfc)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "[local]/directory".to_string());
            DisplayRoot { id, path_display }
        })
        .collect::<Vec<_>>();
    roots.sort_by_key(|root| {
        serde_json::to_string(&json!({
            "id": root.id,
            "path_display": root.path_display
        }))
        .unwrap_or_default()
    });
    roots.dedup_by(|left, right| left.id == right.id && left.path_display == right.path_display);
    roots
}

fn fs_allowed_root_map() -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let Ok(raw) = std::env::var(FS_ALLOWED_ROOTS_ENV) else {
        return out;
    };
    for item in raw.split([',', ';']) {
        let Some((id, path)) = item.split_once(':') else {
            continue;
        };
        let id = trim_nfc(id);
        let path = path.trim();
        if id.is_empty() || path.is_empty() {
            continue;
        }
        out.insert(id, PathBuf::from(path));
    }
    out
}

fn absolute_input_path(job: &BridgeJob) -> Result<PathBuf, ConnectorError> {
    let Some(path) = job
        .input
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(ConnectorError::InvalidJob {
            reason: "missing absolute path".to_string(),
        });
    };
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(ConnectorError::InvalidJob {
            reason: "path must be absolute".to_string(),
        });
    }
    Ok(path)
}

fn canonical_requested_path(path: &Path) -> Result<PathBuf, ConnectorError> {
    std::fs::canonicalize(path).map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "path".to_string(),
        reason: "path_not_found_locally".to_string(),
    })
}

enum ReadMessage {
    Chunk(Vec<u8>),
    Done(Result<(), String>),
}

fn read_with_sandboxed_cat(
    path: &Path,
    max_bytes: usize,
    spec: &SandboxSpec,
    ctx: &mut ExecCtx<'_>,
) -> Result<ConnectorExecutionResult, ConnectorError> {
    let mut command = Command::new(CAT_BIN);
    command
        .arg(path)
        .current_dir(&spec.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sandbox::backend()
        .wrap_command(&mut command, spec)
        .map_err(|_| ConnectorError::LocalPolicyDenied {
            denied: "sandbox".to_string(),
            reason: "sandbox_apply_failed_local".to_string(),
        })?;

    let mut child = command
        .spawn()
        .map_err(|error| ConnectorError::RuntimeFailed {
            reason: format!("failed to start sandboxed fs.read: {error}"),
        })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "sandboxed fs.read stdout unavailable".to_string(),
        })?;
    let mut stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0_u8; CHUNK_BYTES];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    let _ = tx.send(ReadMessage::Done(Ok(())));
                    break;
                }
                Ok(n) => {
                    if tx.send(ReadMessage::Chunk(buffer[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(ReadMessage::Done(Err(error.to_string())));
                    break;
                }
            }
        }
    });
    let (err_tx, err_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(ref mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        let _ = err_tx.send(text);
    });

    let mut hasher = Sha256::new();
    let mut bytes = 0_usize;
    let redacted_path = crate::redact_local_path(&path.to_string_lossy());
    loop {
        if ctx.cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ConnectorError::Cancelled);
        }
        if Instant::now() >= ctx.deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ConnectorError::Timeout);
        }
        let wait = ctx.remaining().min(Duration::from_millis(100));
        match rx.recv_timeout(wait) {
            Ok(ReadMessage::Chunk(chunk)) => {
                if bytes.saturating_add(chunk.len()) > max_bytes {
                    let _ = child.kill();
                    let _ = child.wait();
                    return deny("path", "file_too_large_locally");
                }
                bytes += chunk.len();
                hasher.update(&chunk);
                ctx.emit(
                    "chunk",
                    json!({
                        "path": redacted_path,
                        "bytes": chunk.len(),
                        "data_base64": STANDARD.encode(&chunk)
                    }),
                );
            }
            Ok(ReadMessage::Done(result)) => {
                if let Err(reason) = result {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ConnectorError::RuntimeFailed { reason });
                }
                let status = child
                    .wait()
                    .map_err(|error| ConnectorError::RuntimeFailed {
                        reason: format!("sandboxed fs.read wait failed: {error}"),
                    })?;
                let stderr_tail = err_rx
                    .recv_timeout(Duration::from_millis(100))
                    .unwrap_or_default();
                if !status.success() {
                    if stderr_tail.contains("Operation not permitted")
                        || stderr_tail.contains("Permission denied")
                    {
                        return deny("path", "path_denied_by_sandbox_local");
                    }
                    return Err(ConnectorError::RuntimeFailed {
                        reason: redacted_cat_error(&stderr_tail),
                    });
                }
                let digest = hasher
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>();
                return Ok(ConnectorExecutionResult {
                    ok: true,
                    result: json!({
                        "ok": true,
                        "path": redacted_path,
                        "bytes": bytes,
                        "sha256": digest
                    }),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ConnectorError::RuntimeFailed {
                    reason: "sandboxed fs.read stdout closed unexpectedly".to_string(),
                });
            }
        }
    }
}

fn redacted_cat_error(stderr: &str) -> String {
    let mut text = stderr.replace('\n', " ").replace('\r', " ");
    if text.trim().is_empty() {
        text = "sandboxed fs.read failed".to_string();
    }
    if text.len() > 160 {
        text.truncate(160);
    }
    text
}

fn clamp_max_bytes(value: usize) -> usize {
    value.clamp(1, MAX_BYTES_LIMIT)
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

fn deny<T>(denied: &str, reason: &str) -> Result<T, ConnectorError> {
    Err(ConnectorError::LocalPolicyDenied {
        denied: denied.to_string(),
        reason: reason.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::{ConnectorEvent, ConnectorGrant, ExecCtx, GrantedBoundary};
    use crate::TEST_ENV_LOCK as ENV_LOCK;
    use serde_json::json;

    fn job(input: Value) -> BridgeJob {
        BridgeJob {
            id: "job_fs".to_string(),
            product_id: "panda-dev".to_string(),
            kind: "fs.read".to_string(),
            workspace_ref: None,
            input,
            policy: json!({}),
            request_key: None,
            cap_token: None,
        }
    }

    fn boundary(raw: Value, capabilities: Vec<&str>) -> GrantedBoundary {
        GrantedBoundary {
            product_id: "panda-dev".to_string(),
            product_name: "Panda Dev".to_string(),
            domain: "fs".to_string(),
            boundary_type: BoundaryType::DirectoryWhitelist,
            capabilities: capabilities.into_iter().map(ToOwned::to_owned).collect(),
            raw,
        }
    }

    fn fs_policy() -> Value {
        json!({
            "type": "directory_whitelist",
            "allowed_roots": [
                { "id": "root-a", "path_display": "[local]/A" },
                { "id": "root-b", "path_display": "[local]/B" }
            ],
            "max_bytes": 16,
            "follow_symlinks": false
        })
    }

    fn reason(error: ConnectorError) -> String {
        match error {
            ConnectorError::LocalPolicyDenied { reason, .. } => reason,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    fn restore_env(key: &str, old: Option<std::ffi::OsString>) {
        if let Some(value) = old {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn fs_declaration_is_high_tier_directory_whitelist() {
        let declaration = FsConnector::new().declare();
        assert_eq!(declaration.domain, "fs");
        assert_eq!(declaration.kinds[0].kind, "fs.read");
        assert_eq!(declaration.kinds[0].danger, ConnectorDanger::High);
        assert_eq!(
            declaration.kinds[0].boundary_type,
            BoundaryType::DirectoryWhitelist
        );
    }

    #[test]
    fn fs_describe_boundary_is_high_risk_and_redacted() {
        let grant = ConnectorGrant {
            product_id: "panda-dev".to_string(),
            product_name: "Panda Dev".to_string(),
            account_display: Some("user@example.test".to_string()),
            capabilities: vec!["fs.read".to_string()],
            authorization_policy: json!({
                "boundaries": {
                    "fs": {
                        "type": "directory_whitelist",
                        "allowed_roots": [
                            { "id": "root-a", "path_display": "[local]/Project" },
                            { "id": "root-b", "path_display": "[local]/Docs" }
                        ],
                        "max_bytes": 1024,
                        "follow_symlinks": false
                    }
                }
            }),
        };
        let description = FsConnector::new().describe_boundary(&grant);
        assert!(description.title.contains("高危"));
        assert!(description
            .bullets
            .iter()
            .any(|item| item.contains("[local]/Project")));
        assert!(description
            .bullets
            .iter()
            .any(|item| item.contains("[local]/Docs")));
        assert!(description.bullets.iter().any(|item| item.contains("内核")));
        assert_eq!(description.redacted_boundary["type"], "directory_whitelist");
        assert!(!description
            .redacted_boundary
            .to_string()
            .contains("/Users/"));
        assert!(!description.summary.contains("/Users/"));
    }

    #[test]
    fn fs_boundary_uses_env_id_mapping_and_canonicalizes_roots() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base =
            std::env::temp_dir().join(format!("panda-bridge-fs-boundary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root_a = base.join("a");
        let root_b = base.join("b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        std::env::set_var(
            FS_ALLOWED_ROOTS_ENV,
            format!(
                "root-b:{},root-a:{},missing:{}",
                root_b.display(),
                root_a.display(),
                base.join("missing").display()
            ),
        );

        let parsed = FsBoundary::parse(&fs_policy()).unwrap();
        assert_eq!(parsed.allowed_roots.len(), 2);
        assert_eq!(parsed.max_bytes, 16);
        assert!(!parsed.follow_symlinks);
        assert!(parsed
            .allowed_roots
            .contains(&std::fs::canonicalize(root_a).unwrap()));
        assert!(parsed
            .allowed_roots
            .contains(&std::fs::canonicalize(root_b).unwrap()));

        restore_env(FS_ALLOWED_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fs_execute_rejects_guard_and_local_path_failures_before_reading() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base =
            std::env::temp_dir().join(format!("panda-bridge-fs-guard-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside.txt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, "nope").unwrap();
        std::env::set_var(FS_ALLOWED_ROOTS_ENV, format!("root-a:{}", root.display()));
        let granted = boundary(fs_policy(), vec!["fs.read"]);
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(10),
            sandbox_spec: None,
        };
        let mut connector = FsConnector::new();

        let mut wrong_boundary = granted.clone();
        wrong_boundary.boundary_type = BoundaryType::NamespaceKv;
        assert_eq!(
            reason(
                connector
                    .execute(
                        &job(json!({ "path": root.join("missing.txt") })),
                        &wrong_boundary,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "boundary_type_mismatch_locally"
        );

        let mut wrong_kind = job(json!({ "path": root.join("missing.txt") }));
        wrong_kind.kind = "fs.write".to_string();
        assert!(matches!(
            connector
                .execute(&wrong_kind, &granted, &mut ctx)
                .unwrap_err(),
            ConnectorError::InvalidJob { .. }
        ));

        assert_eq!(
            reason(
                connector
                    .execute(&job(json!({ "path": outside })), &granted, &mut ctx)
                    .unwrap_err()
            ),
            "path_outside_allowlist_locally"
        );
        assert_eq!(
            reason(
                connector
                    .execute(
                        &job(json!({ "path": root.join("missing.txt") })),
                        &granted,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "path_not_found_locally"
        );

        let no_cap = boundary(fs_policy(), vec![]);
        assert_eq!(
            reason(
                connector
                    .execute(
                        &job(json!({ "path": root.join("missing.txt") })),
                        &no_cap,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "capability_not_authorized_locally"
        );

        restore_env(FS_ALLOWED_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fs_execute_stops_when_file_exceeds_max_bytes() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base =
            std::env::temp_dir().join(format!("panda-bridge-fs-large-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("large.txt");
        std::fs::write(&file, "too large").unwrap();
        std::env::set_var(FS_ALLOWED_ROOTS_ENV, format!("root-a:{}", root.display()));
        let boundary = boundary(
            json!({
                "type": "directory_whitelist",
                "allowed_roots": [{ "id": "root-a", "path_display": "[local]/root" }],
                "max_bytes": 4,
                "follow_symlinks": false
            }),
            vec!["fs.read"],
        );
        let mut connector = FsConnector::new();
        let spec = connector
            .sandbox_spec(&job(json!({ "path": file })), &boundary)
            .unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(10),
            sandbox_spec: spec,
        };

        assert_eq!(
            reason(
                connector
                    .execute(&job(json!({ "path": file })), &boundary, &mut ctx)
                    .unwrap_err()
            ),
            "file_too_large_locally"
        );
        assert!(!events.iter().any(|event| event.event_type == "chunk"));

        restore_env(FS_ALLOWED_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn fs_execute_streams_content_and_returns_hash_without_body() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base =
            std::env::temp_dir().join(format!("panda-bridge-fs-exec-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("ok.txt");
        std::fs::write(&file, "hello fs").unwrap();
        std::env::set_var(FS_ALLOWED_ROOTS_ENV, format!("root-a:{}", root.display()));
        let boundary = boundary(
            json!({
                "type": "directory_whitelist",
                "allowed_roots": [{ "id": "root-a", "path_display": "[local]/root" }],
                "max_bytes": 1024,
                "follow_symlinks": false
            }),
            vec!["fs.read"],
        );
        let mut connector = FsConnector::new();
        let spec = connector
            .sandbox_spec(&job(json!({ "path": file })), &boundary)
            .unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(10),
            sandbox_spec: spec,
        };

        let result = connector
            .execute(&job(json!({ "path": file })), &boundary, &mut ctx)
            .unwrap()
            .result;
        assert_eq!(result["ok"], true);
        assert_eq!(result["bytes"], 8);
        assert_eq!(
            result["sha256"],
            Sha256::digest(b"hello fs")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert!(!result.to_string().contains("hello fs"));
        assert!(events.iter().any(|event| event.event_type == "chunk"));

        restore_env(FS_ALLOWED_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn fs_sandbox_spec_fails_closed_when_backend_unavailable() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base = std::env::temp_dir().join(format!(
            "panda-bridge-fs-unavailable-{}",
            std::process::id()
        ));
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(FS_ALLOWED_ROOTS_ENV, format!("root-a:{}", root.display()));
        let error = FsConnector::new()
            .sandbox_spec(
                &job(json!({ "path": root.join("ok.txt") })),
                &boundary(fs_policy(), vec!["fs.read"]),
            )
            .unwrap_err();
        assert_eq!(reason(error), "sandbox_unavailable_local");
        restore_env(FS_ALLOWED_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }
}
