use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::{
    collections::HashMap,
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
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
pub const FS_WRITE_HELPER_ARG: &str = "--fs-write-helper";
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
            kinds: vec![
                ConnectorKindDeclaration {
                    kind: "fs.read".to_string(),
                    verb: "read".to_string(),
                    danger: ConnectorDanger::High,
                    boundary_type: BoundaryType::DirectoryWhitelist,
                },
                ConnectorKindDeclaration {
                    kind: "fs.write".to_string(),
                    verb: "write".to_string(),
                    danger: ConnectorDanger::High,
                    boundary_type: BoundaryType::DirectoryWhitelist,
                },
            ],
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
        if job.kind != "fs.read" && job.kind != "fs.write" {
            return Err(ConnectorError::InvalidJob {
                reason: format!("unsupported fs kind: {}", job.kind),
            });
        }
        if !boundary.capabilities.iter().any(|item| item == &job.kind) {
            return deny("capability", "capability_not_authorized_locally");
        }

        let fs_boundary = FsBoundary::parse(&boundary.raw)?;
        let requested = absolute_input_path(job)?;
        if job.kind == "fs.write" {
            return execute_write(job, &fs_boundary, &requested, ctx);
        }

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
        let write_roots = normalized_write_display_roots(fs);
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
        let writable = fs.get("writable").and_then(Value::as_bool).unwrap_or(false)
            || grant.capabilities.iter().any(|item| item == "fs.write");
        let root_bullets = roots
            .iter()
            .map(|root| format!("授权目录：{}", root.path_display))
            .collect::<Vec<_>>();
        let mut bullets = root_bullets;
        for root in &write_roots {
            bullets.push(format!("可写目录：{}", root.path_display));
        }
        if writable {
            bullets
                .push("可写；写入由内核沙箱限制在授权目录内，不能执行任意程序或联网".to_string());
        } else {
            bullets.push("只读；无法写文件、执行任意程序或联网".to_string());
        }
        bullets.push("授权目录外会被内核沙箱拒绝".to_string());
        bullets.push(format!("单次最多读写 {} bytes", max_bytes));
        BoundaryDescription {
            title: if writable {
                "高危本机文件读写".to_string()
            } else {
                "高危本机文件读取".to_string()
            },
            summary: if writable {
                format!("{} 只能读写你显式授权目录内的文件。", grant.product_name)
            } else {
                format!("{} 只能读取你显式授权目录内的文件。", grant.product_name)
            },
            bullets,
            audit_label: format!("fs:{}", grant.product_id),
            redacted_boundary: json!({
                "type": "directory_whitelist",
                "allowed_roots": roots.into_iter().map(|root| {
                    json!({ "id": root.id, "path_display": root.path_display })
                }).collect::<Vec<_>>(),
                "write_roots": write_roots.into_iter().map(|root| {
                    json!({ "id": root.id, "path_display": root.path_display })
                }).collect::<Vec<_>>(),
                "writable": writable,
                "max_bytes": max_bytes,
                "follow_symlinks": follow_symlinks
            }),
        }
    }

    fn sandbox_spec(
        &self,
        job: &BridgeJob,
        boundary: &GrantedBoundary,
    ) -> Result<Option<SandboxSpec>, ConnectorError> {
        if !sandbox::backend().available() {
            return Err(ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_unavailable_local".to_string(),
            });
        }
        let fs_boundary = FsBoundary::parse(&boundary.raw)?;
        if job.kind == "fs.write" {
            let helper = helper_exe_path()?;
            let cwd = fs_boundary.write_roots.first().cloned().ok_or_else(|| {
                ConnectorError::LocalPolicyDenied {
                    denied: "path".to_string(),
                    reason: "path_outside_allowlist_locally".to_string(),
                }
            })?;
            return Ok(Some(SandboxSpec {
                profile: SandboxProfileKind::FsWriteDir,
                read_roots: Vec::new(),
                write_roots: fs_boundary.write_roots,
                exec_allow: vec![helper],
                net: NetPolicy::Deny,
                limits: ResourceLimits::fs_write_default(),
                env_allow: Vec::new(),
                cwd,
            }));
        }
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
    write_roots: Vec<PathBuf>,
    #[allow(dead_code)]
    writable: bool,
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
        let write_display_roots = normalized_write_display_roots(raw);
        let allowed_roots = canonical_roots_from_display(&display_roots, &env_roots);
        let write_roots = canonical_roots_from_display(&write_display_roots, &env_roots);
        let writable = raw
            .get("writable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
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
            write_roots,
            writable,
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
    normalized_display_roots_for_keys(raw, "allowed_roots", "allowedRoots")
}

fn normalized_write_display_roots(raw: &Value) -> Vec<DisplayRoot> {
    normalized_display_roots_for_keys(raw, "write_roots", "writeRoots")
}

fn normalized_display_roots_for_keys(
    raw: &Value,
    snake_key: &str,
    camel_key: &str,
) -> Vec<DisplayRoot> {
    let mut roots = raw
        .get(snake_key)
        .or_else(|| raw.get(camel_key))
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

fn canonical_roots_from_display(
    display_roots: &[DisplayRoot],
    env_roots: &HashMap<String, PathBuf>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for root in display_roots {
        let Some(local_path) = env_roots.get(&root.id) else {
            continue;
        };
        let Ok(canonical) = sandbox::canonical_existing_path(local_path) else {
            continue;
        };
        roots.push(canonical);
    }
    roots.sort_by_key(|path| path.to_string_lossy().to_string());
    roots.dedup();
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

fn canonical_target_parent_path(path: &Path) -> Result<PathBuf, ConnectorError> {
    let Some(parent) = path.parent().filter(|item| !item.as_os_str().is_empty()) else {
        return Err(ConnectorError::InvalidJob {
            reason: "target parent is missing".to_string(),
        });
    };
    std::fs::canonicalize(parent).map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "path".to_string(),
        reason: "path_not_found_locally".to_string(),
    })
}

fn target_file_name(path: &Path) -> Result<&OsStr, ConnectorError> {
    path.file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ConnectorError::InvalidJob {
            reason: "target file name is missing".to_string(),
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteMode {
    CreateNew,
    Overwrite,
    Append,
}

impl WriteMode {
    fn parse(value: Option<&str>) -> Result<Self, ConnectorError> {
        match value
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .unwrap_or("create_new")
        {
            "create_new" | "create-new" | "createNew" | "create" => Ok(Self::CreateNew),
            "overwrite" | "replace" => Ok(Self::Overwrite),
            "append" => Ok(Self::Append),
            other => Err(ConnectorError::InvalidJob {
                reason: format!("unsupported fs.write mode: {other}"),
            }),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::CreateNew => "create_new",
            Self::Overwrite => "overwrite",
            Self::Append => "append",
        }
    }
}

fn write_mode(job: &BridgeJob) -> Result<WriteMode, ConnectorError> {
    WriteMode::parse(job.input.get("mode").and_then(Value::as_str))
}

fn write_payload(job: &BridgeJob) -> Result<Vec<u8>, ConnectorError> {
    for key in ["data_base64", "content_base64", "bytes_base64"] {
        if let Some(value) = job.input.get(key).and_then(Value::as_str) {
            return STANDARD
                .decode(value.trim())
                .map_err(|_| ConnectorError::InvalidJob {
                    reason: format!("{key} is not valid base64"),
                });
        }
    }
    for key in ["text", "content"] {
        if let Some(value) = job.input.get(key).and_then(Value::as_str) {
            return Ok(value.as_bytes().to_vec());
        }
    }
    Err(ConnectorError::InvalidJob {
        reason: "missing fs.write payload".to_string(),
    })
}

fn execute_write(
    job: &BridgeJob,
    fs_boundary: &FsBoundary,
    requested: &Path,
    ctx: &mut ExecCtx<'_>,
) -> Result<ConnectorExecutionResult, ConnectorError> {
    let mode = write_mode(job)?;
    let payload = write_payload(job)?;
    if payload.len() > fs_boundary.max_bytes {
        return deny("path", "file_too_large_locally");
    }
    let parent = canonical_target_parent_path(requested)?;
    let file_name = target_file_name(requested)?;
    let target = parent.join(file_name);
    // Fast local fallback for friendly errors only. The helper is executed
    // inside the seatbelt profile where file-write* on write_roots is the real
    // boundary and O_NOFOLLOW/open-time checks handle same-name replacement.
    if !fs_boundary
        .write_roots
        .iter()
        .any(|root| parent.starts_with(root))
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
    let redacted_path = crate::redact_local_path(&target.to_string_lossy());
    ctx.emit(
        "started",
        json!({
            "kind": job.kind,
            "boundaryType": "directory_whitelist",
            "path": redacted_path,
            "mode": mode.as_str()
        }),
    );
    write_with_sandboxed_helper(&target, mode, fs_boundary.max_bytes, &payload, &spec, ctx)
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

fn write_with_sandboxed_helper(
    target: &Path,
    mode: WriteMode,
    max_bytes: usize,
    payload: &[u8],
    spec: &SandboxSpec,
    ctx: &mut ExecCtx<'_>,
) -> Result<ConnectorExecutionResult, ConnectorError> {
    let helper = helper_exe_path()?;
    let mut command = Command::new(&helper);
    command
        .arg(FS_WRITE_HELPER_ARG)
        .arg("--target")
        .arg(target)
        .arg("--mode")
        .arg(mode.as_str())
        .arg("--max-bytes")
        .arg(max_bytes.to_string())
        .current_dir(&spec.cwd)
        .env_clear()
        .stdin(Stdio::piped())
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
            reason: format!("failed to start sandboxed fs.write: {error}"),
        })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "sandboxed fs.write stdin unavailable".to_string(),
        })?;
    let payload = payload.to_vec();
    let (stdin_tx, stdin_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = stdin
            .write_all(&payload)
            .and_then(|_| stdin.flush())
            .map_err(|error| error.to_string());
        drop(stdin);
        let _ = stdin_tx.send(result);
    });

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
        match child
            .try_wait()
            .map_err(|error| ConnectorError::RuntimeFailed {
                reason: format!("sandboxed fs.write poll failed: {error}"),
            })? {
            Some(status) => {
                let _ = stdin_rx.recv_timeout(Duration::from_millis(100));
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                if !status.success() {
                    let reason = helper_denial_reason(&stderr);
                    if let Some(reason) = reason {
                        return deny("path", reason);
                    }
                    return Err(ConnectorError::RuntimeFailed {
                        reason: redacted_helper_error(&stderr),
                    });
                }
                let summary: Value = serde_json::from_str(stdout.trim()).map_err(|error| {
                    ConnectorError::RuntimeFailed {
                        reason: format!("sandboxed fs.write returned invalid JSON: {error}"),
                    }
                })?;
                let redacted_path = crate::redact_local_path(&target.to_string_lossy());
                return Ok(ConnectorExecutionResult {
                    ok: true,
                    result: json!({
                        "ok": true,
                        "path": redacted_path,
                        "bytes_written": summary.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                        "sha256": summary.get("sha256").and_then(Value::as_str).unwrap_or(""),
                        "mode": mode.as_str()
                    }),
                });
            }
            None => {
                thread::sleep(ctx.remaining().min(Duration::from_millis(25)));
            }
        }
    }
}

pub(crate) fn helper_exe_path() -> Result<PathBuf, ConnectorError> {
    #[cfg(test)]
    if let Some(path) = test_helper_exe_path() {
        return Ok(path);
    }
    let current = std::env::current_exe().map_err(|error| ConnectorError::RuntimeFailed {
        reason: format!("failed to resolve fs.write helper path: {error}"),
    })?;
    sandbox::canonical_existing_path(current).map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "sandbox".to_string(),
        reason: "sandbox_apply_failed_local".to_string(),
    })
}

#[cfg(test)]
fn test_helper_exe_path() -> Option<PathBuf> {
    static PATH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let helper = manifest_dir.join("target/debug/panda-bridge-desktop");
        let _ = Command::new("cargo")
            .args([
                "build",
                "--quiet",
                "--manifest-path",
                manifest_dir
                    .join("Cargo.toml")
                    .to_str()
                    .unwrap_or("Cargo.toml"),
            ])
            .status();
        sandbox::canonical_existing_path(&helper).ok()
    })
    .clone()
}

fn helper_denial_reason(stderr: &str) -> Option<&'static str> {
    for reason in [
        "file_too_large_locally",
        "path_denied_by_helper_local",
        "path_denied_by_sandbox_local",
        "hardlink_denied_by_helper_local",
        "target_exists_locally",
    ] {
        if stderr.contains(reason) {
            return Some(reason);
        }
    }
    if stderr.contains("Operation not permitted") || stderr.contains("Permission denied") {
        return Some("path_denied_by_sandbox_local");
    }
    None
}

fn redacted_helper_error(stderr: &str) -> String {
    let mut text = stderr.replace('\n', " ").replace('\r', " ");
    if text.trim().is_empty() {
        text = "sandboxed fs.write failed".to_string();
    }
    if text.len() > 160 {
        text.truncate(160);
    }
    text
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

pub fn is_fs_write_helper_invocation() -> bool {
    std::env::args().nth(1).as_deref() == Some(FS_WRITE_HELPER_ARG)
}

pub fn run_fs_write_helper() -> i32 {
    match run_fs_write_helper_inner() {
        Ok(summary) => {
            println!(
                "{}",
                json!({
                    "bytes": summary.bytes,
                    "sha256": summary.sha256
                })
            );
            0
        }
        Err(error) => {
            eprintln!("{}", error.reason);
            error.code
        }
    }
}

fn run_fs_write_helper_inner() -> Result<HelperWriteSummary, HelperExit> {
    if std::env::vars_os().any(|(key, _)| !helper_allowed_auto_env(&key)) {
        return Err(HelperExit::new(64, "helper_env_not_clear"));
    }
    let args = std::env::args_os().collect::<Vec<_>>();
    let parsed = parse_helper_args(&args)?;
    let mut payload = Vec::new();
    let mut stdin = std::io::stdin().lock();
    let mut buffer = [0_u8; CHUNK_BYTES];
    loop {
        let n = stdin
            .read(&mut buffer)
            .map_err(|_| HelperExit::new(70, "helper_stdin_failed"))?;
        if n == 0 {
            break;
        }
        if payload.len().saturating_add(n) > parsed.max_bytes {
            return Err(HelperExit::new(65, "file_too_large_locally"));
        }
        payload.extend_from_slice(&buffer[..n]);
    }
    helper_atomic_write(&parsed.target, parsed.mode, parsed.max_bytes, &payload)
        .map_err(|error| HelperExit::new(73, error.reason))
}

fn helper_allowed_auto_env(key: &OsStr) -> bool {
    matches!(
        key.to_str(),
        Some("__CF_USER_TEXT_ENCODING" | "LC_CTYPE" | "MallocNanoZone")
    )
}

struct HelperArgs {
    target: PathBuf,
    mode: WriteMode,
    max_bytes: usize,
}

fn parse_helper_args(args: &[OsString]) -> Result<HelperArgs, HelperExit> {
    if args.len() != 8
        || args.get(1).and_then(|item| item.to_str()) != Some(FS_WRITE_HELPER_ARG)
        || args.get(2).and_then(|item| item.to_str()) != Some("--target")
        || args.get(4).and_then(|item| item.to_str()) != Some("--mode")
        || args.get(6).and_then(|item| item.to_str()) != Some("--max-bytes")
    {
        return Err(HelperExit::new(64, "helper_bad_args"));
    }
    let target = PathBuf::from(args[3].clone());
    if !target.is_absolute() {
        return Err(HelperExit::new(64, "helper_bad_args"));
    }
    let mode =
        WriteMode::parse(args[5].to_str()).map_err(|_| HelperExit::new(64, "helper_bad_args"))?;
    let max_bytes = args[7]
        .to_str()
        .and_then(|item| item.parse::<usize>().ok())
        .filter(|value| (1..=MAX_BYTES_LIMIT).contains(value))
        .ok_or_else(|| HelperExit::new(64, "helper_bad_args"))?;
    Ok(HelperArgs {
        target,
        mode,
        max_bytes,
    })
}

struct HelperExit {
    code: i32,
    reason: &'static str,
}

impl HelperExit {
    fn new(code: i32, reason: &'static str) -> Self {
        Self { code, reason }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HelperWriteSummary {
    bytes: usize,
    sha256: String,
}

#[derive(Debug, Clone)]
struct HelperWriteError {
    reason: &'static str,
}

impl HelperWriteError {
    fn new(reason: &'static str) -> Self {
        Self { reason }
    }
}

fn helper_atomic_write(
    target: &Path,
    mode: WriteMode,
    max_bytes: usize,
    payload: &[u8],
) -> Result<HelperWriteSummary, HelperWriteError> {
    if payload.len() > max_bytes {
        return Err(HelperWriteError::new("file_too_large_locally"));
    }
    let parent = target
        .parent()
        .filter(|item| !item.as_os_str().is_empty())
        .ok_or_else(|| HelperWriteError::new("path_denied_by_helper_local"))?;
    let file_name = target
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| HelperWriteError::new("path_denied_by_helper_local"))?;
    let summary = HelperWriteSummary {
        bytes: payload.len(),
        sha256: sha256_bytes(payload),
    };
    match mode {
        WriteMode::Append => {
            let file = open_append_no_follow(target)?;
            ensure_single_link(&file)?;
            write_and_sync(file, payload)?;
        }
        WriteMode::CreateNew | WriteMode::Overwrite => {
            if mode == WriteMode::Overwrite {
                preflight_overwrite_target(target)?;
            }
            let (tmp_path, tmp) = create_temp_no_follow(parent, file_name)?;
            if let Err(error) = write_tmp_and_rename(tmp, &tmp_path, target, mode, payload) {
                let _ = fs::remove_file(&tmp_path);
                return Err(error);
            }
        }
    }
    Ok(summary)
}

fn sha256_bytes(payload: &[u8]) -> String {
    Sha256::digest(payload)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

#[cfg(unix)]
fn open_append_no_follow(target: &Path) -> Result<File, HelperWriteError> {
    OpenOptions::new()
        .append(true)
        .create(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(target)
        .map_err(helper_open_error)
}

#[cfg(not(unix))]
fn open_append_no_follow(target: &Path) -> Result<File, HelperWriteError> {
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(target)
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))
}

#[cfg(unix)]
fn preflight_overwrite_target(target: &Path) -> Result<(), HelperWriteError> {
    match OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(target)
    {
        Ok(file) => ensure_single_link(&file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(helper_open_error(error)),
    }
}

#[cfg(not(unix))]
fn preflight_overwrite_target(target: &Path) -> Result<(), HelperWriteError> {
    if target.exists() {
        Ok(())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn create_temp_no_follow(
    parent: &Path,
    file_name: &OsStr,
) -> Result<(PathBuf, File), HelperWriteError> {
    for attempt in 0..64_u32 {
        let tmp_path = parent.join(temp_file_name(file_name, attempt));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(0o600)
            .open(&tmp_path)
        {
            Ok(file) => return Ok((tmp_path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(helper_open_error(error)),
        }
    }
    Err(HelperWriteError::new("path_denied_by_helper_local"))
}

#[cfg(not(unix))]
fn create_temp_no_follow(
    parent: &Path,
    file_name: &OsStr,
) -> Result<(PathBuf, File), HelperWriteError> {
    for attempt in 0..64_u32 {
        let tmp_path = parent.join(temp_file_name(file_name, attempt));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(file) => return Ok((tmp_path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(HelperWriteError::new("path_denied_by_helper_local")),
        }
    }
    Err(HelperWriteError::new("path_denied_by_helper_local"))
}

fn temp_file_name(file_name: &OsStr, attempt: u32) -> OsString {
    let mut out = OsString::from(".");
    out.push(file_name);
    out.push(format!(
        ".panda-tmp-{}-{}-{attempt:x}",
        std::process::id(),
        unix_nanos()
    ));
    out
}

fn unix_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn write_tmp_and_rename(
    mut tmp: File,
    tmp_path: &Path,
    target: &Path,
    mode: WriteMode,
    payload: &[u8],
) -> Result<(), HelperWriteError> {
    tmp.write_all(payload)
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    tmp.sync_all()
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    ensure_single_link(&tmp)?;
    drop(tmp);
    match mode {
        WriteMode::CreateNew => rename_excl(tmp_path, target),
        WriteMode::Overwrite => fs::rename(tmp_path, target)
            .map_err(|_| HelperWriteError::new("path_denied_by_helper_local")),
        WriteMode::Append => unreachable!("append does not use tmp rename"),
    }
}

#[cfg(unix)]
fn write_and_sync(mut file: File, payload: &[u8]) -> Result<(), HelperWriteError> {
    file.write_all(payload)
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    file.sync_all()
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))
}

#[cfg(not(unix))]
fn write_and_sync(mut file: File, payload: &[u8]) -> Result<(), HelperWriteError> {
    file.write_all(payload)
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    file.sync_all()
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))
}

#[cfg(unix)]
fn ensure_single_link(file: &File) -> Result<(), HelperWriteError> {
    let metadata = file
        .metadata()
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    if metadata.nlink() == 1 {
        Ok(())
    } else {
        Err(HelperWriteError::new("hardlink_denied_by_helper_local"))
    }
}

#[cfg(not(unix))]
fn ensure_single_link(_file: &File) -> Result<(), HelperWriteError> {
    Ok(())
}

#[cfg(unix)]
fn helper_open_error(error: std::io::Error) -> HelperWriteError {
    match error.raw_os_error() {
        Some(code) if code == libc::ELOOP || code == libc::EPERM || code == libc::EACCES => {
            HelperWriteError::new("path_denied_by_helper_local")
        }
        Some(code) if code == libc::EEXIST => HelperWriteError::new("target_exists_locally"),
        _ if error.kind() == std::io::ErrorKind::AlreadyExists => {
            HelperWriteError::new("target_exists_locally")
        }
        _ => HelperWriteError::new("path_denied_by_helper_local"),
    }
}

#[cfg(target_os = "macos")]
fn rename_excl(tmp_path: &Path, target: &Path) -> Result<(), HelperWriteError> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    const RENAME_EXCL: libc::c_uint = 0x00000004;
    let from = CString::new(tmp_path.as_os_str().as_bytes())
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    let to = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| HelperWriteError::new("path_denied_by_helper_local"))?;
    let rc = unsafe {
        renameatx_np(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            RENAME_EXCL,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists
            || error.raw_os_error() == Some(libc::EEXIST)
        {
            Err(HelperWriteError::new("target_exists_locally"))
        } else {
            Err(HelperWriteError::new("path_denied_by_helper_local"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_excl(tmp_path: &Path, target: &Path) -> Result<(), HelperWriteError> {
    match fs::hard_link(tmp_path, target) {
        Ok(()) => fs::remove_file(tmp_path)
            .map_err(|_| HelperWriteError::new("path_denied_by_helper_local")),
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                || error.raw_os_error() == Some(libc::EEXIST) =>
        {
            Err(HelperWriteError::new("target_exists_locally"))
        }
        Err(_) => Err(HelperWriteError::new("path_denied_by_helper_local")),
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn renameatx_np(
        fromfd: libc::c_int,
        from: *const libc::c_char,
        tofd: libc::c_int,
        to: *const libc::c_char,
        flags: libc::c_uint,
    ) -> libc::c_int;
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

    fn write_job(input: Value) -> BridgeJob {
        BridgeJob {
            kind: "fs.write".to_string(),
            input,
            ..job(json!({ "path": "/tmp/unused" }))
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
            "write_roots": [
                { "id": "root-w", "path_display": "[local]/W" }
            ],
            "writable": true,
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
        assert_eq!(declaration.kinds[1].kind, "fs.write");
        assert_eq!(declaration.kinds[1].verb, "write");
        assert_eq!(declaration.kinds[1].danger, ConnectorDanger::High);
        assert_eq!(
            declaration.kinds[1].boundary_type,
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
                        "write_roots": [
                            { "id": "root-w", "path_display": "[local]/Out" }
                        ],
                        "writable": true,
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
        assert!(description
            .bullets
            .iter()
            .any(|item| item.contains("[local]/Out")));
        assert!(description.bullets.iter().any(|item| item.contains("内核")));
        assert_eq!(description.redacted_boundary["type"], "directory_whitelist");
        assert_eq!(description.redacted_boundary["writable"], true);
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
        let root_w = base.join("w");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        std::fs::create_dir_all(&root_w).unwrap();
        std::env::set_var(
            FS_ALLOWED_ROOTS_ENV,
            format!(
                "root-b:{},root-a:{},root-w:{},missing:{}",
                root_b.display(),
                root_a.display(),
                root_w.display(),
                base.join("missing").display()
            ),
        );

        let parsed = FsBoundary::parse(&fs_policy()).unwrap();
        assert_eq!(parsed.allowed_roots.len(), 2);
        assert_eq!(parsed.write_roots.len(), 1);
        assert!(parsed.writable);
        assert_eq!(parsed.max_bytes, 16);
        assert!(!parsed.follow_symlinks);
        assert!(parsed
            .allowed_roots
            .contains(&std::fs::canonicalize(root_a).unwrap()));
        assert!(parsed
            .allowed_roots
            .contains(&std::fs::canonicalize(root_b).unwrap()));
        assert!(parsed
            .write_roots
            .contains(&std::fs::canonicalize(root_w).unwrap()));

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
        wrong_kind.kind = "fs.delete".to_string();
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

    #[test]
    fn fs_write_rejects_guard_and_local_path_failures_before_helper() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base = std::env::temp_dir().join(format!(
            "panda-bridge-fs-write-guard-{}",
            std::process::id()
        ));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::env::set_var(FS_ALLOWED_ROOTS_ENV, format!("root-w:{}", root.display()));
        let granted = boundary(
            json!({
                "type": "directory_whitelist",
                "allowed_roots": [],
                "write_roots": [{ "id": "root-w", "path_display": "[local]/root" }],
                "writable": true,
                "max_bytes": 4,
                "follow_symlinks": false
            }),
            vec!["fs.write"],
        );
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
                        &write_job(json!({ "path": root.join("ok.txt"), "text": "x" })),
                        &wrong_boundary,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "boundary_type_mismatch_locally"
        );

        let no_cap = boundary(granted.raw.clone(), vec![]);
        assert_eq!(
            reason(
                connector
                    .execute(
                        &write_job(json!({ "path": root.join("ok.txt"), "text": "x" })),
                        &no_cap,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "capability_not_authorized_locally"
        );

        assert_eq!(
            reason(
                connector
                    .execute(
                        &write_job(json!({ "path": outside.join("x.txt"), "text": "x" })),
                        &granted,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "path_outside_allowlist_locally"
        );
        assert_eq!(
            reason(
                connector
                    .execute(
                        &write_job(json!({ "path": root.join("big.txt"), "text": "too big" })),
                        &granted,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "file_too_large_locally"
        );
        assert!(matches!(
            connector
                .execute(
                    &write_job(json!({ "path": root.join("ok.txt") })),
                    &granted,
                    &mut ctx
                )
                .unwrap_err(),
            ConnectorError::InvalidJob { .. }
        ));

        restore_env(FS_ALLOWED_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fs_write_helper_atomic_modes_and_link_rejections() {
        let base = std::env::temp_dir().join(format!(
            "panda-bridge-fs-helper-{}-{}",
            std::process::id(),
            unix_nanos()
        ));
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let created = root.join("created.txt");
        let summary = helper_atomic_write(&created, WriteMode::CreateNew, 1024, b"hello").unwrap();
        assert_eq!(summary.bytes, 5);
        assert_eq!(std::fs::read_to_string(&created).unwrap(), "hello");
        assert_eq!(
            helper_atomic_write(&created, WriteMode::CreateNew, 1024, b"new")
                .unwrap_err()
                .reason,
            "target_exists_locally"
        );
        assert_eq!(std::fs::read_to_string(&created).unwrap(), "hello");

        let overwritten = root.join("overwrite.txt");
        std::fs::write(&overwritten, "old").unwrap();
        helper_atomic_write(&overwritten, WriteMode::Overwrite, 1024, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&overwritten).unwrap(), "new");

        helper_atomic_write(&overwritten, WriteMode::Append, 1024, b"+tail").unwrap();
        assert_eq!(std::fs::read_to_string(&overwritten).unwrap(), "new+tail");

        #[cfg(unix)]
        {
            let symlink_target = root.join("real.txt");
            std::fs::write(&symlink_target, "real").unwrap();
            let symlink = root.join("link.txt");
            std::os::unix::fs::symlink(&symlink_target, &symlink).unwrap();
            assert_eq!(
                helper_atomic_write(&symlink, WriteMode::Overwrite, 1024, b"bad")
                    .unwrap_err()
                    .reason,
                "path_denied_by_helper_local"
            );
            assert_eq!(std::fs::read_to_string(&symlink_target).unwrap(), "real");

            let outside_file = outside.join("outside.txt");
            let hardlink = root.join("hardlink.txt");
            std::fs::write(&outside_file, "outside").unwrap();
            std::fs::hard_link(&outside_file, &hardlink).unwrap();
            assert_eq!(
                helper_atomic_write(&hardlink, WriteMode::Overwrite, 1024, b"bad")
                    .unwrap_err()
                    .reason,
                "hardlink_denied_by_helper_local"
            );
            assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
        }

        assert_eq!(
            helper_atomic_write(&root.join("large.txt"), WriteMode::CreateNew, 2, b"big")
                .unwrap_err()
                .reason,
            "file_too_large_locally"
        );
        assert!(!root.join("large.txt").exists());

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

    #[cfg(target_os = "macos")]
    #[test]
    fn fs_write_execute_writes_and_returns_hash_without_body() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(FS_ALLOWED_ROOTS_ENV);
        let base =
            std::env::temp_dir().join(format!("panda-bridge-fs-write-exec-{}", std::process::id()));
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(FS_ALLOWED_ROOTS_ENV, format!("root-w:{}", root.display()));
        let boundary = boundary(
            json!({
                "type": "directory_whitelist",
                "allowed_roots": [],
                "write_roots": [{ "id": "root-w", "path_display": "[local]/root" }],
                "writable": true,
                "max_bytes": 1024,
                "follow_symlinks": false
            }),
            vec!["fs.write"],
        );
        let mut connector = FsConnector::new();
        let file = root.join("ok.txt");
        let spec = connector
            .sandbox_spec(
                &write_job(
                    json!({ "path": file.clone(), "text": "hello fs", "mode": "create_new" }),
                ),
                &boundary,
            )
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
            .execute(
                &write_job(
                    json!({ "path": file.clone(), "text": "hello fs", "mode": "create_new" }),
                ),
                &boundary,
                &mut ctx,
            )
            .unwrap()
            .result;
        assert_eq!(result["ok"], true);
        assert_eq!(result["bytes_written"], 8);
        assert_eq!(result["mode"], "create_new");
        assert_eq!(
            result["sha256"],
            Sha256::digest(b"hello fs")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello fs");
        assert!(!result.to_string().contains("hello fs"));
        assert!(!events
            .iter()
            .any(|event| event.payload.to_string().contains("hello fs")));

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
