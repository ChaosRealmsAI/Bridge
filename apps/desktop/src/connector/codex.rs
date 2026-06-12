use serde_json::{json, Value};
use std::{
    io::Write,
    sync::mpsc,
    time::{Duration, Instant},
};

use crate::{BridgeJob, CodexWarmSession, VERSION};

use super::sandbox::{self, SandboxSpec};
use super::{
    BoundaryDescription, BoundaryType, BridgeConnector, ConnectorDanger, ConnectorDeclaration,
    ConnectorError, ConnectorExecutionResult, ConnectorGrant, ConnectorKindDeclaration, ExecCtx,
    GrantedBoundary,
};

pub struct CodexConnector {
    session: Option<CodexWarmSession>,
}

impl CodexConnector {
    pub fn new() -> Self {
        Self { session: None }
    }

    pub fn with_session(session: Option<CodexWarmSession>) -> Self {
        Self { session }
    }
}

impl BridgeConnector for CodexConnector {
    fn declare(&self) -> ConnectorDeclaration {
        ConnectorDeclaration {
            domain: "codex".to_string(),
            kinds: ["chat", "run", "rpc"]
                .into_iter()
                .map(|verb| ConnectorKindDeclaration {
                    kind: format!("codex.{verb}"),
                    verb: verb.to_string(),
                    danger: ConnectorDanger::Low,
                    boundary_type: BoundaryType::WorkspaceSandbox,
                })
                .collect(),
        }
    }

    fn execute(
        &mut self,
        job: &BridgeJob,
        boundary: &GrantedBoundary,
        ctx: &mut ExecCtx<'_>,
    ) -> Result<ConnectorExecutionResult, ConnectorError> {
        if boundary.boundary_type != BoundaryType::WorkspaceSandbox || boundary.domain != "codex" {
            return Err(ConnectorError::LocalPolicyDenied {
                denied: "workspace_ref".to_string(),
                reason: "authorization_scope_missing_locally".to_string(),
            });
        }
        if !boundary.capabilities.iter().any(|item| item == &job.kind) {
            return Err(ConnectorError::LocalPolicyDenied {
                denied: "capability".to_string(),
                reason: "capability_not_authorized_locally".to_string(),
            });
        }
        let policy = match crate::codex_job_policy_from_scope(job, &boundary.raw) {
            Ok(policy) => policy,
            Err(error) => {
                let (denied, reason) = crate::local_policy_denial(&error);
                return Err(ConnectorError::LocalPolicyDenied {
                    denied: denied.to_string(),
                    reason: reason.to_string(),
                });
            }
        };
        ctx.emit(
            "effective_policy",
            crate::effective_policy_event(job, &policy),
        );
        ctx.emit(
            "started",
            json!({
                "kind": job.kind,
                "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string()),
                "codex_warm": self.session.is_some()
            }),
        );
        if crate::fake_codex_enabled() {
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
            ctx.emit("text_delta", json!({ "delta": reply }));
            return Ok(ConnectorExecutionResult {
                ok: true,
                result: json!({ "ok": true, "reply": reply, "fixture": true, "cloud_openai_credentials": false }),
            });
        }
        emit_sandbox_disabled_debug(job, &policy, ctx);

        let result = if self.session.is_some() {
            self.run_warm(job, &policy, ctx)
        } else {
            run_cold(job, &policy, ctx)
        }?;
        Ok(ConnectorExecutionResult {
            ok: result.get("ok").and_then(Value::as_bool).unwrap_or(false),
            result,
        })
    }

    fn describe_boundary(&self, grant: &ConnectorGrant) -> BoundaryDescription {
        BoundaryDescription {
            title: "Codex 工作区".to_string(),
            summary: format!(
                "{} 只能在授权的 Codex 工作区和策略下运行。",
                grant.product_name
            ),
            bullets: vec![
                "工作区由 workspace_ref 映射到本机白名单目录".to_string(),
                "sandbox、approval 和 developerInstructions 受授权下限约束".to_string(),
            ],
            audit_label: format!("codex:{}", grant.product_id),
            redacted_boundary: json!({ "type": "workspace_sandbox" }),
        }
    }

    fn sandbox_spec(
        &self,
        job: &BridgeJob,
        boundary: &GrantedBoundary,
    ) -> Result<Option<SandboxSpec>, ConnectorError> {
        if crate::fake_codex_enabled() {
            return Ok(None);
        }
        if !sandbox::backend().available() {
            return Err(ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_unavailable_local".to_string(),
            });
        }
        crate::build_codex_sandbox_spec(job, boundary).map(Some)
    }
}

impl CodexConnector {
    fn run_warm(
        &mut self,
        job: &BridgeJob,
        policy: &crate::LocalJobPolicy,
        ctx: &mut ExecCtx<'_>,
    ) -> Result<Value, ConnectorError> {
        let spec = ctx
            .sandbox_spec
            .clone()
            .ok_or_else(|| ConnectorError::LocalPolicyDenied {
                denied: "sandbox".to_string(),
                reason: "sandbox_spec_missing_local".to_string(),
            })?;
        let cwd = spec.cwd.to_string_lossy().to_string();
        let want_fingerprint = sandbox::spec_fingerprint(&spec, &job.product_id);
        let should_restart = self
            .session
            .as_ref()
            .map(|session| {
                warm_session_should_restart(
                    &session.cwd,
                    &session.spec_fingerprint,
                    &session.product_id,
                    &cwd,
                    &want_fingerprint,
                    &job.product_id,
                )
            })
            .unwrap_or(true);
        if should_restart {
            self.session = Some(CodexWarmSession::start(
                spec,
                job.product_id.clone(),
                want_fingerprint,
            )?);
        }
        let run_result = match self.session.as_mut() {
            Some(session) => run_warm_session_job(session, job, policy, ctx),
            None => Err("codex warm session unavailable".to_string()),
        };
        match run_result {
            Ok(mut result) => {
                if let Value::Object(ref mut map) = result {
                    map.insert("codex_warm".to_string(), Value::Bool(true));
                }
                Ok(result)
            }
            Err(error) => {
                self.session = None;
                Err(ConnectorError::RuntimeFailed { reason: error })
            }
        }
    }
}

fn warm_session_should_restart(
    session_cwd: &str,
    session_fingerprint: &str,
    session_product_id: &str,
    cwd: &str,
    spec_fingerprint: &str,
    product_id: &str,
) -> bool {
    session_cwd != cwd
        || session_fingerprint != spec_fingerprint
        || session_product_id != product_id
}

fn emit_sandbox_disabled_debug(
    job: &BridgeJob,
    policy: &crate::LocalJobPolicy,
    ctx: &mut ExecCtx<'_>,
) {
    if !sandbox::disabled_for_debug() {
        return;
    }
    ctx.emit(
        "sandbox_disabled_debug",
        json!({
            "reason": "PANDA_BRIDGE_SANDBOX_MODE=disabled",
            "debug_only": true,
            "product_id": job.product_id.clone(),
            "kind": job.kind.clone(),
            "workspace_ref": job.workspace_ref.clone().unwrap_or_else(|| "default".to_string()),
            "sandbox": policy.sandbox,
            "cwd": crate::redact_local_path(&policy.cwd)
        }),
    );
}

fn run_warm_session_job(
    session: &mut CodexWarmSession,
    job: &BridgeJob,
    policy: &crate::LocalJobPolicy,
    ctx: &mut ExecCtx<'_>,
) -> Result<Value, String> {
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
    let mut final_text = String::new();
    let thread_result = send_request_ctx(
        &mut session.stdin,
        &session.rx,
        &mut session.next_id,
        "thread/start",
        crate::thread_start_params(policy, job),
        ctx,
        &mut final_text,
    )?;
    let thread_id = thread_result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .ok_or("codex app-server did not return a thread id")?
        .to_string();
    let _ = send_request_ctx(
        &mut session.stdin,
        &session.rx,
        &mut session.next_id,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
            "approvalPolicy": policy.approval_policy
        }),
        ctx,
        &mut final_text,
    )?;
    wait_for_turn_ctx(&session.rx, ctx, &mut final_text)?;
    let reply = final_text.trim().to_string();
    if reply.is_empty() {
        let stderr_tail = session.err_rx.try_recv().unwrap_or_default();
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

fn run_cold(
    job: &BridgeJob,
    policy: &crate::LocalJobPolicy,
    ctx: &mut ExecCtx<'_>,
) -> Result<Value, ConnectorError> {
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
    let spec = ctx
        .sandbox_spec
        .clone()
        .ok_or_else(|| ConnectorError::LocalPolicyDenied {
            denied: "sandbox".to_string(),
            reason: "sandbox_spec_missing_local".to_string(),
        })?;
    let (mut child, mut stdin, rx, err_rx) = crate::spawn_codex_app_server(&spec)?;
    let result = (|| -> Result<Value, String> {
        let mut next_id = 0_u64;
        let mut final_text = String::new();
        send_request_ctx(
            &mut stdin,
            &rx,
            &mut next_id,
            "initialize",
            json!({
                "clientInfo": { "name": "panda_bridge_desktop_lite", "title": "Panda Bridge Desktop", "version": VERSION },
                "capabilities": {}
            }),
            ctx,
            &mut final_text,
        )?;
        crate::send_notify(&mut stdin, "initialized", json!({}))?;
        let account = send_request_ctx(
            &mut stdin,
            &rx,
            &mut next_id,
            "account/read",
            json!({ "refreshToken": false }),
            ctx,
            &mut final_text,
        )?;
        if account.get("account").is_none() {
            return Ok(
                json!({ "ok": false, "error": "local Codex is not signed in; run codex login on this machine", "cloud_openai_credentials": false }),
            );
        }
        let _ = send_request_ctx(
            &mut stdin,
            &rx,
            &mut next_id,
            "account/rateLimits/read",
            json!({}),
            ctx,
            &mut final_text,
        );
        let thread_result = send_request_ctx(
            &mut stdin,
            &rx,
            &mut next_id,
            "thread/start",
            crate::thread_start_params(policy, job),
            ctx,
            &mut final_text,
        )?;
        let thread_id = thread_result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
            .ok_or("codex app-server did not return a thread id")?
            .to_string();
        let _ = send_request_ctx(
            &mut stdin,
            &rx,
            &mut next_id,
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt, "text_elements": [] }],
                "approvalPolicy": policy.approval_policy
            }),
            ctx,
            &mut final_text,
        )?;
        wait_for_turn_ctx(&rx, ctx, &mut final_text)?;
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
    result.map_err(|reason| {
        let stderr_tail = err_rx
            .recv_timeout(Duration::from_millis(500))
            .unwrap_or_default();
        let reason = if stderr_tail.trim().is_empty() {
            reason
        } else {
            format!("{reason}; {stderr_tail}")
        };
        ConnectorError::RuntimeFailed { reason }
    })
}

fn send_request_ctx(
    stdin: &mut impl Write,
    rx: &mpsc::Receiver<Value>,
    next_id: &mut u64,
    method: &str,
    params: Value,
    ctx: &mut ExecCtx<'_>,
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
    loop {
        if ctx.cancelled() {
            return Err("cancelled".to_string());
        }
        if Instant::now() >= ctx.deadline {
            return Err(format!("codex app-server timeout waiting for {method}"));
        }
        let wait = ctx.remaining().min(Duration::from_millis(500));
        let message = match rx.recv_timeout(wait) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "codex app-server closed while waiting for {method}"
                ));
            }
        };
        handle_codex_event_ctx(ctx, &message, final_text);
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            if let Some(error) = message.get("error") {
                return Err(format!("codex {method} error: {error}"));
            }
            return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
        }
    }
}

fn wait_for_turn_ctx(
    rx: &mpsc::Receiver<Value>,
    ctx: &mut ExecCtx<'_>,
    final_text: &mut String,
) -> Result<(), String> {
    loop {
        if ctx.cancelled() {
            return Err("cancelled".to_string());
        }
        if Instant::now() >= ctx.deadline {
            return Err("codex app-server turn timed out".to_string());
        }
        let wait = ctx.remaining().min(Duration::from_millis(500));
        let message = match rx.recv_timeout(wait) {
            Ok(message) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("codex app-server closed before turn completed".to_string())
            }
        };
        handle_codex_event_ctx(ctx, &message, final_text);
        if message.get("method").and_then(Value::as_str) == Some("turn/completed") {
            return Ok(());
        }
    }
}

fn handle_codex_event_ctx(ctx: &mut ExecCtx<'_>, message: &Value, final_text: &mut String) {
    if let Some(delta) = crate::assistant_text_from_message(message) {
        if !delta.is_empty() {
            final_text.push_str(&delta);
            ctx.emit("text_delta", json!({ "delta": delta }));
        }
    } else if let Some(method) = message.get("method").and_then(Value::as_str) {
        ctx.emit("app_server_event", json!({ "method": method }));
    }
}

#[cfg(test)]
mod tests {
    use super::warm_session_should_restart;

    #[test]
    fn warm_session_restarts_on_boundary_or_product_change() {
        assert!(!warm_session_should_restart(
            "/tmp/ws",
            "fp-a",
            "product-a",
            "/tmp/ws",
            "fp-a",
            "product-a"
        ));
        assert!(warm_session_should_restart(
            "/tmp/ws",
            "fp-a",
            "product-a",
            "/tmp/other",
            "fp-a",
            "product-a"
        ));
        assert!(warm_session_should_restart(
            "/tmp/ws",
            "fp-a",
            "product-a",
            "/tmp/ws",
            "fp-b",
            "product-a"
        ));
        assert!(warm_session_should_restart(
            "/tmp/ws",
            "fp-a",
            "product-a",
            "/tmp/ws",
            "fp-a",
            "product-b"
        ));
    }
}
