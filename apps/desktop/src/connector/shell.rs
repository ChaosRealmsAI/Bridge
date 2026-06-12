use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
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

pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_OUTPUT_BYTES_LIMIT: usize = 16 * 1024 * 1024;
pub const DEFAULT_DEADLINE_MS: u64 = 30_000;
pub const MAX_DEADLINE_MS: u64 = 600_000;
pub const SHELL_CWD_ROOTS_ENV: &str = "PANDA_BRIDGE_SHELL_CWD_ROOTS";
const CHUNK_BYTES: usize = 16 * 1024;

// shell.run security model, do not delete:
// The security of shell.run does not rely on a command allowlist. A command
// allowlist, when enabled, is only a reduction and audit aid. The real boundary
// is the macOS seatbelt profile: once the process starts, what paths it may
// read/write, whether it may use the network, and whether it may exec/fork are
// decided by the kernel deny-by-default profile. Even if the allowlist is
// bypassed, or an unexpected program is executed, the kernel still confines the
// process tree to the authorized working-directory sandbox. Allowlist failure is
// not boundary failure.

pub struct ShellConnector;

impl ShellConnector {
    pub fn new() -> Self {
        Self
    }
}

impl BridgeConnector for ShellConnector {
    fn declare(&self) -> ConnectorDeclaration {
        ConnectorDeclaration {
            domain: "shell".to_string(),
            kinds: vec![ConnectorKindDeclaration {
                kind: "shell.run".to_string(),
                verb: "run".to_string(),
                danger: ConnectorDanger::Critical,
                boundary_type: BoundaryType::CommandSandbox,
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
        if boundary.boundary_type != BoundaryType::CommandSandbox || boundary.domain != "shell" {
            return deny("command", "boundary_type_mismatch_locally");
        }
        if job.kind != "shell.run" {
            return Err(ConnectorError::InvalidJob {
                reason: format!("unsupported shell kind: {}", job.kind),
            });
        }
        if !boundary.capabilities.iter().any(|item| item == &job.kind) {
            return deny("capability", "capability_not_authorized_locally");
        }

        let shell_boundary = ShellBoundary::parse(&boundary.raw)?;
        let argv = input_argv(job)?;
        let argv0 = canonical_argv0(&argv)?;
        // Fast local rejection for friendlier errors and smaller blast radius
        // only. This allowlist is not a security boundary; the seatbelt profile
        // remains the boundary if this check is missing or bypassed.
        if let Some(allowlist) = &shell_boundary.cmd_allowlist {
            if !allowlist.iter().any(|item| item == &argv0) {
                return deny("command", "command_not_allowed_locally");
            }
        }

        let spec = ctx
            .sandbox_spec
            .clone()
            .ok_or_else(|| ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_spec_missing_local".to_string(),
            })?;
        let deadline = Instant::now()
            + Duration::from_millis(shell_boundary.deadline_ms)
                .min(ctx.deadline.saturating_duration_since(Instant::now()));
        ctx.emit(
            "started",
            json!({
                "kind": job.kind,
                "boundaryType": "command_sandbox",
                "cwd_root_id": shell_boundary.cwd_root_id,
                "cwd": crate::redact_local_path(&shell_boundary.cwd_root.to_string_lossy()),
                "net": shell_boundary.net.as_str(),
                "allow_exec_subtree": shell_boundary.allow_exec_subtree
            }),
        );
        run_sandboxed_command(&argv0, &argv[1..], &shell_boundary, &spec, deadline, ctx)
    }

    fn describe_boundary(&self, grant: &ConnectorGrant) -> BoundaryDescription {
        let shell = grant
            .authorization_policy
            .pointer("/boundaries/shell")
            .unwrap_or(&Value::Null);
        let cwd_root_id = shell
            .get("cwd_root_id")
            .or_else(|| shell.get("cwdRootId"))
            .and_then(Value::as_str)
            .map(trim_nfc_keep_slash)
            .unwrap_or_default();
        let net = normalize_net_value(shell).as_str().to_string();
        let allow_exec_subtree = shell
            .get("allow_exec_subtree")
            .or_else(|| shell.get("allowExecSubtree"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let max_output_bytes = bounded_usize_field(
            shell,
            "max_output_bytes",
            "maxOutputBytes",
            DEFAULT_MAX_OUTPUT_BYTES,
            1,
            MAX_OUTPUT_BYTES_LIMIT,
        );
        BoundaryDescription {
            title: "Critical shell.run command sandbox".to_string(),
            summary: format!(
                "{} may run one command inside a kernel-confined working directory.",
                grant.product_name
            ),
            bullets: vec![
                format!("cwd root id: {}", display_or_missing(&cwd_root_id)),
                format!("network: {net}"),
                format!("subprocess exec/fork: {}", allow_exec_subtree),
                "其它位置和未授权网络会被内核拒绝；命令白名单只做减面和审计，不是边界".to_string(),
                format!("stdout/stderr content is transient chunks only; result keeps byte counts, max {} bytes", max_output_bytes),
            ],
            audit_label: format!("shell:{}", grant.product_id),
            redacted_boundary: json!({
                "type": "command_sandbox",
                "cwd_root_id": cwd_root_id,
                "net": net,
                "allow_exec_subtree": allow_exec_subtree,
                "cmd_allowlist_count": shell.get("cmd_allowlist").or_else(|| shell.get("cmdAllowlist")).and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
                "max_output_bytes": max_output_bytes
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
        let shell_boundary = ShellBoundary::parse(&boundary.raw)?;
        let argv = input_argv(job)?;
        let argv0 = canonical_argv0(&argv)?;
        let mut exec_allow = vec![argv0];
        if let Some(allowlist) = &shell_boundary.cmd_allowlist {
            for path in allowlist {
                if !exec_allow.iter().any(|item| item == path) {
                    exec_allow.push(path.clone());
                }
            }
        }
        Ok(Some(SandboxSpec {
            profile: SandboxProfileKind::ShellCommand,
            read_roots: vec![shell_boundary.cwd_root.clone()],
            write_roots: vec![shell_boundary.cwd_root.clone()],
            exec_allow,
            allow_exec_subtree: shell_boundary.allow_exec_subtree,
            net: shell_boundary.net,
            limits: shell_boundary.limits,
            env_allow: Vec::new(),
            cwd: shell_boundary.cwd_root,
        }))
    }
}

#[derive(Debug, Clone)]
struct ShellBoundary {
    cwd_root_id: String,
    cwd_root: PathBuf,
    net: NetPolicy,
    allow_exec_subtree: bool,
    cmd_allowlist: Option<Vec<PathBuf>>,
    limits: ResourceLimits,
    deadline_ms: u64,
    max_output_bytes: usize,
}

impl ShellBoundary {
    fn parse(raw: &Value) -> Result<Self, ConnectorError> {
        let boundary_type = raw
            .get("type")
            .or_else(|| raw.get("boundary_type"))
            .or_else(|| raw.get("boundaryType"))
            .and_then(Value::as_str)
            .map(trim_nfc)
            .unwrap_or_else(|| "command_sandbox".to_string());
        if boundary_type != "command_sandbox" {
            return deny("command", "boundary_type_mismatch_locally");
        }
        let cwd_root_id = raw
            .get("cwd_root_id")
            .or_else(|| raw.get("cwdRootId"))
            .and_then(Value::as_str)
            .map(trim_nfc_keep_slash)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConnectorError::LocalPolicyDenied {
                denied: "cwd_root".to_string(),
                reason: "cwd_root_not_granted_locally".to_string(),
            })?;
        let cwd_root = shell_cwd_root_map()
            .get(&cwd_root_id)
            .cloned()
            .ok_or_else(|| ConnectorError::LocalPolicyDenied {
                denied: "cwd_root".to_string(),
                reason: "cwd_root_not_granted_locally".to_string(),
            })?;
        let cwd_root = sandbox::canonical_existing_path(cwd_root).map_err(|_| {
            ConnectorError::LocalPolicyDenied {
                denied: "cwd_root".to_string(),
                reason: "cwd_root_not_granted_locally".to_string(),
            }
        })?;
        if !cwd_root.is_dir() {
            return deny("cwd_root", "cwd_root_not_granted_locally");
        }
        Ok(Self {
            cwd_root_id,
            cwd_root,
            net: normalize_net_value(raw),
            allow_exec_subtree: raw
                .get("allow_exec_subtree")
                .or_else(|| raw.get("allowExecSubtree"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            cmd_allowlist: parse_cmd_allowlist(raw),
            limits: parse_limits(raw.get("limits").unwrap_or(&Value::Null)),
            deadline_ms: bounded_u64_field(
                raw,
                "deadline_ms",
                "deadlineMs",
                DEFAULT_DEADLINE_MS,
                1,
                MAX_DEADLINE_MS,
            ),
            max_output_bytes: bounded_usize_field(
                raw,
                "max_output_bytes",
                "maxOutputBytes",
                DEFAULT_MAX_OUTPUT_BYTES,
                1,
                MAX_OUTPUT_BYTES_LIMIT,
            ),
        })
    }
}

enum StreamMessage {
    Chunk(StreamKind, Vec<u8>),
    Done(StreamKind, Result<(), String>),
}

#[derive(Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

impl StreamKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

fn run_sandboxed_command(
    argv0: &Path,
    args: &[OsString],
    shell_boundary: &ShellBoundary,
    spec: &SandboxSpec,
    deadline: Instant,
    ctx: &mut ExecCtx<'_>,
) -> Result<ConnectorExecutionResult, ConnectorError> {
    let started = Instant::now();
    let mut command = Command::new(argv0);
    command
        .args(args)
        .current_dir(&spec.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    install_process_group(&mut command);
    sandbox::backend()
        .wrap_command(&mut command, spec)
        .map_err(|_| ConnectorError::LocalPolicyDenied {
            denied: "sandbox".to_string(),
            reason: "sandbox_apply_failed_local".to_string(),
        })?;

    let mut child = command
        .spawn()
        .map_err(|error| ConnectorError::RuntimeFailed {
            reason: format!("failed to start sandboxed shell.run: {error}"),
        })?;
    let pgid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "sandboxed shell.run stdout unavailable".to_string(),
        })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ConnectorError::RuntimeFailed {
            reason: "sandboxed shell.run stderr unavailable".to_string(),
        })?;
    let (tx, rx) = mpsc::channel();
    spawn_reader(StreamKind::Stdout, stdout, tx.clone());
    spawn_reader(StreamKind::Stderr, stderr, tx);

    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut bytes_stdout = 0_usize;
    let mut bytes_stderr = 0_usize;
    loop {
        if ctx.cancelled() {
            kill_process_group(pgid, &mut child);
            return Err(ConnectorError::Cancelled);
        }
        if Instant::now() >= deadline {
            kill_process_group(pgid, &mut child);
            return Err(ConnectorError::Timeout);
        }
        match rx.recv_timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(50)),
        ) {
            Ok(StreamMessage::Chunk(stream, chunk)) => {
                let next_total = bytes_stdout
                    .saturating_add(bytes_stderr)
                    .saturating_add(chunk.len());
                if next_total > shell_boundary.max_output_bytes {
                    kill_process_group(pgid, &mut child);
                    return deny("output", "output_too_large_locally");
                }
                match stream {
                    StreamKind::Stdout => bytes_stdout += chunk.len(),
                    StreamKind::Stderr => bytes_stderr += chunk.len(),
                }
                ctx.emit(
                    "chunk",
                    json!({
                        "persist": false,
                        "stream": stream.as_str(),
                        "bytes": chunk.len(),
                        "data_base64": STANDARD.encode(&chunk)
                    }),
                );
            }
            Ok(StreamMessage::Done(stream, result)) => {
                if let Err(reason) = result {
                    kill_process_group(pgid, &mut child);
                    return Err(ConnectorError::RuntimeFailed { reason });
                }
                match stream {
                    StreamKind::Stdout => stdout_done = true,
                    StreamKind::Stderr => stderr_done = true,
                }
                if stdout_done && stderr_done {
                    let status = child
                        .wait()
                        .map_err(|error| ConnectorError::RuntimeFailed {
                            reason: format!("sandboxed shell.run wait failed: {error}"),
                        })?;
                    return Ok(shell_result(
                        status,
                        bytes_stdout,
                        bytes_stderr,
                        started.elapsed(),
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(status) =
                    child
                        .try_wait()
                        .map_err(|error| ConnectorError::RuntimeFailed {
                            reason: format!("sandboxed shell.run poll failed: {error}"),
                        })?
                {
                    return Ok(shell_result(
                        status,
                        bytes_stdout,
                        bytes_stderr,
                        started.elapsed(),
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                kill_process_group(pgid, &mut child);
                return Err(ConnectorError::RuntimeFailed {
                    reason: "sandboxed shell.run streams closed unexpectedly".to_string(),
                });
            }
        }
    }
}

fn spawn_reader(
    stream: StreamKind,
    mut reader: impl Read + Send + 'static,
    tx: mpsc::Sender<StreamMessage>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = tx.send(StreamMessage::Done(stream, Ok(())));
                    break;
                }
                Ok(n) => {
                    if tx
                        .send(StreamMessage::Chunk(stream, buffer[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(StreamMessage::Done(stream, Err(error.to_string())));
                    break;
                }
            }
        }
    });
}

fn shell_result(
    status: ExitStatus,
    bytes_stdout: usize,
    bytes_stderr: usize,
    duration: Duration,
) -> ConnectorExecutionResult {
    ConnectorExecutionResult {
        ok: status.success(),
        result: json!({
            "ok": status.success(),
            "exit_code": status.code(),
            "signal": exit_signal(status),
            "bytes_stdout": bytes_stdout,
            "bytes_stderr": bytes_stderr,
            "duration_ms": duration.as_millis() as u64
        }),
    }
}

#[cfg(unix)]
fn exit_signal(status: ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: ExitStatus) -> Option<i32> {
    None
}

#[cfg(unix)]
fn install_process_group(command: &mut Command) {
    use std::io;
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn install_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_group(pgid: u32, child: &mut std::process::Child) {
    unsafe {
        libc::kill(-(pgid as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
fn kill_process_group(_pgid: u32, child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn input_argv(job: &BridgeJob) -> Result<Vec<OsString>, ConnectorError> {
    if let Some(items) = job.input.get("argv").and_then(Value::as_array) {
        let argv = items
            .iter()
            .filter_map(Value::as_str)
            .map(|item| OsString::from(trim_nfc_keep_slash(item)))
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>();
        if !argv.is_empty() {
            return Ok(argv);
        }
    }
    if let Some(command) = job
        .input
        .get("command")
        .and_then(Value::as_str)
        .map(trim_nfc_keep_slash)
        .filter(|value| !value.is_empty())
    {
        let mut argv = vec![OsString::from(command)];
        if let Some(args) = job.input.get("args").and_then(Value::as_array) {
            argv.extend(args.iter().filter_map(Value::as_str).map(OsString::from));
        }
        return Ok(argv);
    }
    Err(ConnectorError::InvalidJob {
        reason: "missing shell.run argv".to_string(),
    })
}

fn canonical_argv0(argv: &[OsString]) -> Result<PathBuf, ConnectorError> {
    let Some(first) = argv.first() else {
        return Err(ConnectorError::InvalidJob {
            reason: "missing shell.run argv".to_string(),
        });
    };
    let path = PathBuf::from(first);
    if !path.is_absolute() {
        return Err(ConnectorError::InvalidJob {
            reason: "shell.run argv[0] must be absolute".to_string(),
        });
    }
    sandbox::canonical_existing_path(&path).map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "command".to_string(),
        reason: "command_not_found_locally".to_string(),
    })
}

fn parse_cmd_allowlist(raw: &Value) -> Option<Vec<PathBuf>> {
    let items = raw
        .get("cmd_allowlist")
        .or_else(|| raw.get("cmdAllowlist"))
        .and_then(Value::as_array)?;
    let mut paths = items
        .iter()
        .filter_map(Value::as_str)
        .map(trim_nfc_keep_slash)
        .filter(|item| !item.is_empty())
        .filter_map(|item| {
            let path = PathBuf::from(item);
            if path.is_absolute() {
                sandbox::canonical_existing_path(path).ok()
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

fn shell_cwd_root_map() -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let Ok(raw) = std::env::var(SHELL_CWD_ROOTS_ENV) else {
        return out;
    };
    for item in raw.split([',', ';']) {
        let Some((id, path)) = item.split_once(':') else {
            continue;
        };
        let id = trim_nfc_keep_slash(id);
        let path = path.trim();
        if id.is_empty() || path.is_empty() {
            continue;
        }
        out.insert(id, PathBuf::from(path));
    }
    out
}

fn normalize_net_value(raw: &Value) -> NetPolicy {
    match raw
        .get("net")
        .and_then(Value::as_str)
        .map(trim_nfc)
        .unwrap_or_else(|| "deny".to_string())
        .as_str()
    {
        "allow_outbound" | "allow-outbound" | "outbound" => NetPolicy::AllowOutbound,
        _ => NetPolicy::Deny,
    }
}

fn parse_limits(value: &Value) -> ResourceLimits {
    let defaults = ResourceLimits::shell_default();
    ResourceLimits {
        cpu_seconds: bounded_u64_field(
            value,
            "cpu_seconds",
            "cpuSeconds",
            defaults.cpu_seconds,
            1,
            300,
        ),
        address_space: bounded_u64_field(
            value,
            "address_space",
            "addressSpace",
            defaults.address_space,
            64 * 1024 * 1024,
            8 * 1024 * 1024 * 1024,
        ),
        open_files: bounded_u64_field(
            value,
            "open_files",
            "openFiles",
            defaults.open_files,
            3,
            1024,
        ),
        processes: bounded_u64_field(value, "processes", "processes", defaults.processes, 1, 128),
        file_size: bounded_u64_field(
            value,
            "file_size",
            "fileSize",
            defaults.file_size,
            1,
            1024 * 1024 * 1024,
        ),
    }
}

pub fn default_limits_json() -> Value {
    let limits = ResourceLimits::shell_default();
    json!({
        "cpu_seconds": limits.cpu_seconds,
        "address_space": limits.address_space,
        "open_files": limits.open_files,
        "processes": limits.processes,
        "file_size": limits.file_size
    })
}

fn bounded_usize_field(
    value: &Value,
    snake_key: &str,
    camel_key: &str,
    fallback: usize,
    min: usize,
    max: usize,
) -> usize {
    bounded_u64_field(
        value,
        snake_key,
        camel_key,
        fallback as u64,
        min as u64,
        max as u64,
    ) as usize
}

fn bounded_u64_field(
    value: &Value,
    snake_key: &str,
    camel_key: &str,
    fallback: u64,
    min: u64,
    max: u64,
) -> u64 {
    value
        .get(snake_key)
        .or_else(|| value.get(camel_key))
        .and_then(|item| {
            item.as_u64()
                .or_else(|| item.as_i64().and_then(|n| u64::try_from(n).ok()))
        })
        .map(|number| number.clamp(min, max))
        .unwrap_or(fallback)
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

fn display_or_missing(value: &str) -> &str {
    if value.is_empty() {
        "[missing]"
    } else {
        value
    }
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
    use crate::connector::ConnectorEvent;
    use crate::TEST_ENV_LOCK as ENV_LOCK;
    use serde_json::json;
    use std::time::Duration;

    fn job(input: Value) -> BridgeJob {
        BridgeJob {
            id: "job_shell_1".to_string(),
            product_id: "panda-dev".to_string(),
            kind: "shell.run".to_string(),
            workspace_ref: None,
            input,
            policy: json!({}),
            request_key: Some("rk_shell_1".to_string()),
            cap_token: None,
        }
    }

    fn boundary(raw: Value, capabilities: Vec<&str>) -> GrantedBoundary {
        GrantedBoundary {
            product_id: "panda-dev".to_string(),
            product_name: "Panda Dev".to_string(),
            domain: "shell".to_string(),
            boundary_type: BoundaryType::CommandSandbox,
            capabilities: capabilities.into_iter().map(ToOwned::to_owned).collect(),
            raw,
        }
    }

    fn shell_policy(root_id: &str) -> Value {
        json!({
            "type": "command_sandbox",
            "cwd_root_id": root_id,
            "net": "deny",
            "allow_exec_subtree": false,
            "deadline_ms": 1000,
            "max_output_bytes": 1024,
            "limits": default_limits_json()
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
    fn shell_declaration_is_critical_command_sandbox() {
        let declaration = ShellConnector::new().declare();
        assert_eq!(declaration.domain, "shell");
        assert_eq!(declaration.kinds[0].kind, "shell.run");
        assert_eq!(declaration.kinds[0].verb, "run");
        assert_eq!(declaration.kinds[0].danger, ConnectorDanger::Critical);
        assert_eq!(
            declaration.kinds[0].boundary_type,
            BoundaryType::CommandSandbox
        );
    }

    #[test]
    fn shell_boundary_uses_env_mapping_and_defaults_to_strict() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root = std::env::temp_dir().join(format!(
            "panda-bridge-shell-boundary-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));

        let parsed = ShellBoundary::parse(&shell_policy("root-a")).unwrap();
        assert_eq!(parsed.cwd_root, std::fs::canonicalize(&root).unwrap());
        assert_eq!(parsed.net, NetPolicy::Deny);
        assert!(!parsed.allow_exec_subtree);
        assert!(parsed.cmd_allowlist.is_none());
        assert_eq!(parsed.deadline_ms, 1000);
        assert_eq!(parsed.max_output_bytes, 1024);
        assert_eq!(parsed.limits.cpu_seconds, 30);
        assert_eq!(parsed.limits.file_size, 64 * 1024 * 1024);

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shell_execute_rejects_guards_and_allowlist_before_spawn() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root =
            std::env::temp_dir().join(format!("panda-bridge-shell-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(1),
            sandbox_spec: None,
        };
        let mut connector = ShellConnector::new();
        let granted = boundary(shell_policy("root-a"), vec!["shell.run"]);

        let mut wrong_boundary = granted.clone();
        wrong_boundary.boundary_type = BoundaryType::DirectoryWhitelist;
        assert_eq!(
            reason(
                connector
                    .execute(
                        &job(json!({ "argv": ["/bin/echo", "hi"] })),
                        &wrong_boundary,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "boundary_type_mismatch_locally"
        );

        let no_cap = boundary(shell_policy("root-a"), vec![]);
        assert_eq!(
            reason(
                connector
                    .execute(
                        &job(json!({ "argv": ["/bin/echo", "hi"] })),
                        &no_cap,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "capability_not_authorized_locally"
        );

        let mut allowlist_policy = shell_policy("root-a");
        allowlist_policy["cmd_allowlist"] = json!(["/bin/cat"]);
        let allowlist = boundary(allowlist_policy, vec!["shell.run"]);
        assert_eq!(
            reason(
                connector
                    .execute(
                        &job(json!({ "argv": ["/bin/echo", "hi"] })),
                        &allowlist,
                        &mut ctx
                    )
                    .unwrap_err()
            ),
            "command_not_allowed_locally"
        );

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn shell_sandbox_spec_fails_closed_when_backend_unavailable() {
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root = std::env::temp_dir().join(format!(
            "panda-bridge-shell-unavailable-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let error = ShellConnector::new()
            .sandbox_spec(
                &job(json!({ "argv": ["/bin/echo", "hi"] })),
                &boundary(shell_policy("root-a"), vec!["shell.run"]),
            )
            .unwrap_err();
        assert_eq!(reason(error), "sandbox_unavailable_local");
        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_streams_content_without_result_body() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root =
            std::env::temp_dir().join(format!("panda-bridge-shell-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let granted = boundary(shell_policy("root-a"), vec!["shell.run"]);
        let run = job(json!({ "argv": ["/bin/echo", "hello shell"] }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        let result = connector.execute(&run, &granted, &mut ctx).unwrap().result;
        assert_eq!(result["ok"], true);
        assert_eq!(result["exit_code"], 0);
        assert!(result["bytes_stdout"].as_u64().unwrap() >= 12);
        assert!(!result.to_string().contains("hello shell"));
        assert!(events.iter().any(|event| {
            event.event_type == "chunk"
                && event.payload["stream"] == "stdout"
                && event.payload["persist"] == false
                && event.payload["data_base64"].as_str().is_some()
        }));

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_denies_outside_write_even_without_allowlist() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let base =
            std::env::temp_dir().join(format!("panda-bridge-shell-deny-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let granted = boundary(shell_policy("root-a"), vec!["shell.run"]);
        let run = job(json!({
            "argv": ["/bin/sh", "-c", format!("echo nope > {}", outside.display())]
        }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        let result = connector.execute(&run, &granted, &mut ctx).unwrap().result;
        assert_eq!(result["ok"], false);
        assert!(!outside.exists());

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_denies_network_by_default() {
        if !sandbox::backend().available() || !Path::new("/usr/bin/curl").exists() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root =
            std::env::temp_dir().join(format!("panda-bridge-shell-net-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let granted = boundary(shell_policy("root-a"), vec!["shell.run"]);
        let run = job(
            json!({ "argv": ["/usr/bin/curl", "--max-time", "2", "--silent", "https://example.com"] }),
        );
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        let result = connector.execute(&run, &granted, &mut ctx).unwrap().result;
        assert_eq!(result["ok"], false, "curl must fail with net=deny");

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_denies_child_exec_when_subtree_disabled() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root = std::env::temp_dir().join(format!(
            "panda-bridge-shell-no-child-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let granted = boundary(shell_policy("root-a"), vec!["shell.run"]);
        let run = job(json!({ "argv": ["/bin/sh", "-c", "/bin/echo child"] }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        let result = connector.execute(&run, &granted, &mut ctx).unwrap().result;
        assert_eq!(result["ok"], false);
        assert_eq!(result["bytes_stdout"], 0);

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_child_process_inherits_profile_and_cannot_write_outside() {
        if !sandbox::backend().available() || !Path::new("/usr/bin/touch").exists() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let base = std::env::temp_dir().join(format!(
            "panda-bridge-shell-child-inherit-{}",
            std::process::id()
        ));
        let root = base.join("root");
        let outside = base.join("outside-child.txt");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let mut policy = shell_policy("root-a");
        policy["allow_exec_subtree"] = json!(true);
        policy["cmd_allowlist"] = json!(["/bin/sh", "/usr/bin/touch"]);
        let granted = boundary(policy, vec!["shell.run"]);
        let run = job(json!({
            "argv": ["/bin/sh", "-c", format!("/usr/bin/touch {}", outside.display())]
        }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        let result = connector.execute(&run, &granted, &mut ctx).unwrap().result;
        assert_eq!(result["ok"], false);
        assert!(!outside.exists());

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_wall_clock_deadline_kills_plain_sleep() {
        if !sandbox::backend().available() || !Path::new("/bin/sleep").exists() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root =
            std::env::temp_dir().join(format!("panda-bridge-shell-sleep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let mut policy = shell_policy("root-a");
        policy["deadline_ms"] = json!(200);
        let granted = boundary(policy, vec!["shell.run"]);
        let run = job(json!({ "argv": ["/bin/sleep", "999"] }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        assert!(matches!(
            connector.execute(&run, &granted, &mut ctx),
            Err(ConnectorError::Timeout)
        ));

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_killpg_stops_background_children_on_deadline() {
        if !sandbox::backend().available() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root =
            std::env::temp_dir().join(format!("panda-bridge-shell-killpg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let mut policy = shell_policy("root-a");
        policy["allow_exec_subtree"] = json!(true);
        policy["deadline_ms"] = json!(200);
        let granted = boundary(policy, vec!["shell.run"]);
        let child_pid = root.join("child.pid");
        let run = job(json!({
            "argv": ["/bin/sh", "-c", format!("sleep 999 & echo $! > {}; wait", child_pid.display())]
        }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        let outcome = connector.execute(&run, &granted, &mut ctx);
        let stderr_text = events
            .iter()
            .filter(|event| event.payload["stream"] == "stderr")
            .filter_map(|event| event.payload["data_base64"].as_str())
            .filter_map(|item| STANDARD.decode(item).ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .collect::<String>();
        assert!(
            matches!(outcome, Err(ConnectorError::Timeout)),
            "unexpected outcome: {:?}; stderr={stderr_text}",
            outcome.as_ref().map(|result| &result.result)
        );
        let pid_text = std::fs::read_to_string(&child_pid).unwrap();
        let pid = pid_text.trim().parse::<i32>().unwrap();
        thread::sleep(Duration::from_millis(150));
        let alive = unsafe { libc::kill(pid, 0) == 0 };
        assert!(
            !alive,
            "background child process should be killed with its group"
        );

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shell_execute_kills_when_output_exceeds_limit() {
        if !sandbox::backend().available() || !Path::new("/usr/bin/yes").exists() {
            return;
        }
        let _guard = ENV_LOCK.lock().unwrap();
        let old = std::env::var_os(SHELL_CWD_ROOTS_ENV);
        let root =
            std::env::temp_dir().join(format!("panda-bridge-shell-output-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var(SHELL_CWD_ROOTS_ENV, format!("root-a:{}", root.display()));
        let mut policy = shell_policy("root-a");
        policy["max_output_bytes"] = json!(128);
        let granted = boundary(policy, vec!["shell.run"]);
        let run = job(json!({ "argv": ["/usr/bin/yes"] }));
        let mut connector = ShellConnector::new();
        let spec = connector.sandbox_spec(&run, &granted).unwrap();
        let mut events = Vec::<ConnectorEvent>::new();
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(5),
            sandbox_spec: spec,
        };

        assert_eq!(
            reason(connector.execute(&run, &granted, &mut ctx).unwrap_err()),
            "output_too_large_locally"
        );

        restore_env(SHELL_CWD_ROOTS_ENV, old);
        let _ = std::fs::remove_dir_all(&root);
    }
}
