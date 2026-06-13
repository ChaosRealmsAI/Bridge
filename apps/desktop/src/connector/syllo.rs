use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::BridgeJob;

use super::sandbox::SandboxSpec;
use super::{
    BoundaryDescription, BoundaryType, BridgeConnector, ConnectorDanger, ConnectorDeclaration,
    ConnectorError, ConnectorExecutionResult, ConnectorGrant, ConnectorKindDeclaration, ExecCtx,
    GrantedBoundary,
};

// Legacy Syllo vertical adapter kept for migration tests; Bridge runtime routes via AdapterRouter.
pub struct SylloConnector;

impl SylloConnector {
    pub fn new() -> Self {
        Self
    }
}

impl BridgeConnector for SylloConnector {
    fn declare(&self) -> ConnectorDeclaration {
        ConnectorDeclaration {
            domain: "syllo".to_string(),
            kinds: vec![
                kind("sessions", ConnectorDanger::Low),
                kind("issue", ConnectorDanger::Medium),
                kind("highlight", ConnectorDanger::Medium),
                kind("doc", ConnectorDanger::Medium),
                kind("chat", ConnectorDanger::Medium),
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
        if boundary.boundary_type != BoundaryType::OpaqueRuntime || boundary.domain != "syllo" {
            return deny("syllo", "boundary_type_mismatch_locally");
        }
        if !boundary.capabilities.iter().any(|item| item == &job.kind) {
            return deny("capability", "capability_not_authorized_locally");
        }
        let action = action_for_job(job)?;
        let (args, project) = args_for_job(job, &action)?;
        ctx.emit(
            "started",
            json!({
                "kind": job.kind,
                "action": action,
                "project": project.as_ref().map(|path| crate::redact_local_path(&path.to_string_lossy()))
            }),
        );
        run_syllo(args, project.as_deref())
    }

    fn describe_boundary(&self, grant: &ConnectorGrant) -> BoundaryDescription {
        BoundaryDescription {
            title: "Syllo 本机后端".to_string(),
            summary: format!(
                "{} 经 syllo CLI 访问本机会话/项目元数据，单机授权。",
                grant.product_name
            ),
            bullets: vec![
                "sessions 可读取本机 Codex/Claude 会话索引".to_string(),
                "issue/highlight/doc 只通过 syllo CLI 写入授权 HOME 下项目的 .syllo 数据"
                    .to_string(),
                "外部 CLI 运行时不使用 Bridge 内核沙箱".to_string(),
            ],
            audit_label: format!("syllo:{}", grant.product_id),
            redacted_boundary: json!({ "type": "opaque_runtime" }),
        }
    }

    fn sandbox_spec(
        &self,
        _job: &BridgeJob,
        _boundary: &GrantedBoundary,
    ) -> Result<Option<SandboxSpec>, ConnectorError> {
        Ok(None)
    }
}

fn action_for_job(job: &BridgeJob) -> Result<String, ConnectorError> {
    if job.kind == "syllo.chat" {
        if let Some(action) = string_opt(&job.input, "action") {
            if action != "send" {
                return invalid(format!("unsupported syllo.chat action: {action}"));
            }
        }
        return Ok("send".to_string());
    }
    string_field(&job.input, "action")
}

fn kind(verb: &str, danger: ConnectorDanger) -> ConnectorKindDeclaration {
    ConnectorKindDeclaration {
        kind: format!("syllo.{verb}"),
        verb: verb.to_string(),
        danger,
        boundary_type: BoundaryType::OpaqueRuntime,
    }
}

fn args_for_job(
    job: &BridgeJob,
    action: &str,
) -> Result<(Vec<String>, Option<PathBuf>), ConnectorError> {
    match job.kind.as_str() {
        "syllo.sessions" => sessions_args(&job.input, action),
        "syllo.issue" => project_args("issue", &job.input, action, issue_action_args),
        "syllo.highlight" => project_args("highlight", &job.input, action, highlight_action_args),
        "syllo.doc" => project_args("doc", &job.input, action, doc_action_args),
        "syllo.chat" => chat_args(&job.input, action),
        _ => Err(ConnectorError::InvalidJob {
            reason: format!("unsupported syllo kind: {}", job.kind),
        }),
    }
}

fn sessions_args(
    input: &Value,
    action: &str,
) -> Result<(Vec<String>, Option<PathBuf>), ConnectorError> {
    if action != "list" {
        return invalid(format!("unsupported syllo.sessions action: {action}"));
    }
    let project = optional_project(input)?;
    let mut args = vec![
        "sessions".to_string(),
        "list".to_string(),
        "--json".to_string(),
    ];
    if input
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        args.push("--running".to_string());
    }
    if let Some(path) = &project {
        push_pair(&mut args, "--project", &path.to_string_lossy());
    }
    Ok((args, project))
}

fn project_args(
    domain: &str,
    input: &Value,
    action: &str,
    build: fn(&Value, &str, &mut Vec<String>) -> Result<(), ConnectorError>,
) -> Result<(Vec<String>, Option<PathBuf>), ConnectorError> {
    let project = required_project(input)?;
    let mut args = vec![
        domain.to_string(),
        action.to_string(),
        "--project".to_string(),
    ];
    args.push(project.to_string_lossy().to_string());
    args.push("--json".to_string());
    build(input, action, &mut args)?;
    Ok((args, Some(project)))
}

fn chat_args(
    input: &Value,
    action: &str,
) -> Result<(Vec<String>, Option<PathBuf>), ConnectorError> {
    if action != "send" {
        return invalid(format!("unsupported syllo.chat action: {action}"));
    }
    let agent = string_field(input, "agent")?;
    if agent != "codex" && agent != "claude" {
        return invalid("syllo.chat agent must be codex or claude");
    }
    let project = required_project(input)?;
    let prompt = string_field(input, "prompt")?;
    let mut args = vec![
        "chat".to_string(),
        "--agent".to_string(),
        agent,
        "--project".to_string(),
        project.to_string_lossy().to_string(),
    ];
    push_optional(
        &mut args,
        "--resume",
        string_opt(input, "resume_session_id"),
    );
    push_pair(&mut args, "--prompt", &prompt);
    push_optional(&mut args, "--model", string_opt(input, "model"));
    args.push("--json".to_string());
    Ok((args, Some(project)))
}

fn issue_action_args(
    input: &Value,
    action: &str,
    args: &mut Vec<String>,
) -> Result<(), ConnectorError> {
    match action {
        "create" => {
            push_pair(args, "--title", &string_field(input, "title")?);
            push_optional(args, "--body", string_opt(input, "body"));
            push_string_list(args, input, "label", "labels", "--label")?;
            push_optional(args, "--agent", string_opt(input, "agent"));
        }
        "list" => {}
        "show" | "close" | "reopen" => args.push(string_field(input, "id")?),
        "comment" => {
            push_pair(args, "--body", &string_field(input, "body")?);
            args.push(string_field(input, "id")?);
        }
        _ => return invalid(format!("unsupported syllo.issue action: {action}")),
    }
    Ok(())
}

fn highlight_action_args(
    input: &Value,
    action: &str,
    args: &mut Vec<String>,
) -> Result<(), ConnectorError> {
    match action {
        "add" => {
            push_pair(args, "--kind", &string_field(input, "kind")?);
            push_pair(args, "--title", &string_field(input, "title")?);
            push_optional(args, "--body", string_opt(input, "body"));
            push_highlight_options(args, input)?;
            push_optional(args, "--agent", string_opt(input, "agent"));
        }
        "list" => {}
        "resolve" => {
            push_pair(args, "--status", &string_field(input, "status")?);
            args.push(string_field(input, "id")?);
        }
        "comment" => {
            push_pair(args, "--body", &string_field(input, "body")?);
            args.push(string_field(input, "id")?);
        }
        _ => return invalid(format!("unsupported syllo.highlight action: {action}")),
    }
    Ok(())
}

fn doc_action_args(
    input: &Value,
    action: &str,
    args: &mut Vec<String>,
) -> Result<(), ConnectorError> {
    match action {
        "link" => args.push(string_field(input, "path")?),
        "unlink" | "read" => args.push(string_field(input, "id")?),
        "list" | "tree" => {}
        _ => return invalid(format!("unsupported syllo.doc action: {action}")),
    }
    Ok(())
}

fn required_project(input: &Value) -> Result<PathBuf, ConnectorError> {
    let raw = string_field(input, "project").map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "project".to_string(),
        reason: "project_required_locally".to_string(),
    })?;
    validate_project(&raw)
}

fn optional_project(input: &Value) -> Result<Option<PathBuf>, ConnectorError> {
    match string_opt(input, "project") {
        Some(project) => validate_project(&project).map(Some),
        None => Ok(None),
    }
}

fn validate_project(raw: &str) -> Result<PathBuf, ConnectorError> {
    let requested = Path::new(raw);
    if !requested.is_absolute() {
        return deny("project", "project_not_absolute_locally");
    }
    let canonical = fs::canonicalize(requested).map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "project".to_string(),
        reason: "project_not_found_locally".to_string(),
    })?;
    if !canonical.is_dir() {
        return deny("project", "project_not_directory_locally");
    }
    let home = env::var("HOME").map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "project".to_string(),
        reason: "home_unavailable_locally".to_string(),
    })?;
    let home = fs::canonicalize(home).map_err(|_| ConnectorError::LocalPolicyDenied {
        denied: "project".to_string(),
        reason: "home_unavailable_locally".to_string(),
    })?;
    if !canonical.starts_with(home) {
        return deny("project", "project_outside_home_locally");
    }
    Ok(canonical)
}

fn run_syllo(
    args: Vec<String>,
    cwd: Option<&Path>,
) -> Result<ConnectorExecutionResult, ConnectorError> {
    let mut command = Command::new("syllo");
    command.args(&args);
    if let Some(path) = cwd {
        command.current_dir(path);
    }
    let output = command
        .output()
        .map_err(|error| ConnectorError::RuntimeFailed {
            reason: format!("failed to run syllo: {error}"),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Ok(ConnectorExecutionResult {
            ok: false,
            result: json!({ "ok": false, "status": output.status.code(), "stderr": stderr, "stdout": stdout }),
        });
    }
    let data: Value =
        serde_json::from_str(&stdout).map_err(|error| ConnectorError::RuntimeFailed {
            reason: format!("syllo emitted invalid JSON: {error}"),
        })?;
    Ok(ConnectorExecutionResult {
        ok: true,
        result: json!({ "ok": true, "data": data }),
    })
}

fn push_highlight_options(args: &mut Vec<String>, input: &Value) -> Result<(), ConnectorError> {
    if let Some(option) = string_opt(input, "option") {
        push_pair(args, "--option", &option);
    }
    for item in input
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let rendered = match item {
            Value::String(value) => value.clone(),
            Value::Object(map) => {
                let key = map.get("key").and_then(Value::as_str).unwrap_or("").trim();
                let label = map
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let rec = map
                    .get("recommended")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if key.is_empty() || label.is_empty() {
                    return invalid("highlight option requires key and label");
                }
                format!("{key}={label}{}", if rec { ":rec" } else { "" })
            }
            _ => return invalid("highlight options must be strings or objects"),
        };
        push_pair(args, "--option", &rendered);
    }
    Ok(())
}

fn push_string_list(
    args: &mut Vec<String>,
    input: &Value,
    single_key: &str,
    list_key: &str,
    flag: &str,
) -> Result<(), ConnectorError> {
    if let Some(value) = string_opt(input, single_key) {
        push_pair(args, flag, &value);
    }
    for item in input
        .get(list_key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(value) = item
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return invalid(format!("{list_key} must contain strings"));
        };
        push_pair(args, flag, value);
    }
    Ok(())
}

fn string_field(input: &Value, key: &str) -> Result<String, ConnectorError> {
    string_opt(input, key).ok_or_else(|| ConnectorError::InvalidJob {
        reason: format!("missing {key}"),
    })
}

fn string_opt(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn push_pair(args: &mut Vec<String>, flag: &str, value: &str) {
    args.push(flag.to_string());
    args.push(value.to_string());
}

fn push_optional(args: &mut Vec<String>, flag: &str, value: Option<String>) {
    if let Some(value) = value {
        push_pair(args, flag, &value);
    }
}

fn invalid<T>(reason: impl Into<String>) -> Result<T, ConnectorError> {
    Err(ConnectorError::InvalidJob {
        reason: reason.into(),
    })
}

fn deny<T>(denied: &str, reason: &str) -> Result<T, ConnectorError> {
    Err(ConnectorError::LocalPolicyDenied {
        denied: denied.to_string(),
        reason: reason.to_string(),
    })
}
