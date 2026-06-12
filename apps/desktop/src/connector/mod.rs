use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

use crate::BridgeJob;

pub mod codex;
pub mod data;
pub mod registry;
pub mod sandbox;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorDanger {
    Low,
    Medium,
    High,
}

impl ConnectorDanger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryType {
    WorkspaceSandbox,
    NamespaceKv,
    DirectoryWhitelist,
    CommandSandbox,
    OpaqueRuntime,
}

impl BoundaryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceSandbox => "workspace_sandbox",
            Self::NamespaceKv => "namespace_kv",
            Self::DirectoryWhitelist => "directory_whitelist",
            Self::CommandSandbox => "command_sandbox",
            Self::OpaqueRuntime => "opaque_runtime",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorKindDeclaration {
    pub kind: String,
    pub verb: String,
    pub danger: ConnectorDanger,
    pub boundary_type: BoundaryType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorDeclaration {
    pub domain: String,
    pub kinds: Vec<ConnectorKindDeclaration>,
}

#[derive(Debug, Clone)]
pub struct GrantedBoundary {
    pub product_id: String,
    pub product_name: String,
    pub domain: String,
    pub boundary_type: BoundaryType,
    pub capabilities: Vec<String>,
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct ConnectorGrant {
    pub product_id: String,
    pub product_name: String,
    pub account_display: Option<String>,
    pub capabilities: Vec<String>,
    pub authorization_policy: Value,
}

pub struct ExecCtx<'a> {
    pub emit: &'a mut dyn FnMut(ConnectorEvent),
    pub is_cancelled: &'a dyn Fn() -> bool,
    pub deadline: Instant,
    pub sandbox_spec: Option<sandbox::SandboxSpec>,
}

impl ExecCtx<'_> {
    pub fn emit(&mut self, event_type: &str, payload: Value) {
        (self.emit)(ConnectorEvent {
            event_type: event_type.to_string(),
            payload,
        });
    }

    pub fn cancelled(&self) -> bool {
        (self.is_cancelled)()
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectorEvent {
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectorExecutionResult {
    pub ok: bool,
    pub result: Value,
}

#[derive(Debug, Clone)]
pub enum ConnectorError {
    LocalPolicyDenied { denied: String, reason: String },
    InvalidJob { reason: String },
    RuntimeFailed { reason: String },
    Cancelled,
    Timeout,
}

#[derive(Debug, Clone, Serialize)]
pub struct BoundaryDescription {
    pub title: String,
    pub summary: String,
    pub bullets: Vec<String>,
    pub audit_label: String,
    pub redacted_boundary: Value,
}

pub trait BridgeConnector: Send {
    fn declare(&self) -> ConnectorDeclaration;

    fn execute(
        &mut self,
        job: &BridgeJob,
        boundary: &GrantedBoundary,
        ctx: &mut ExecCtx<'_>,
    ) -> Result<ConnectorExecutionResult, ConnectorError>;

    fn describe_boundary(&self, grant: &ConnectorGrant) -> BoundaryDescription;

    fn sandbox_spec(
        &self,
        _job: &BridgeJob,
        _boundary: &GrantedBoundary,
    ) -> Result<Option<sandbox::SandboxSpec>, ConnectorError> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::thread;

    #[test]
    fn exec_ctx_proxies_emit_cancel_and_deadline() {
        let mut events = Vec::new();
        let flag = Arc::new(AtomicBool::new(false));
        let flag_reader = flag.clone();
        let mut emit = |event: ConnectorEvent| events.push(event);
        let deadline = Instant::now() + Duration::from_millis(100);
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &move || flag_reader.load(Ordering::SeqCst),
            deadline,
            sandbox_spec: None,
        };

        assert!(!ctx.cancelled());
        ctx.emit("status", json!({ "ok": true }));
        flag.store(true, Ordering::SeqCst);
        assert!(ctx.cancelled());
        assert!(ctx.remaining() <= Duration::from_millis(100));
        thread::sleep(Duration::from_millis(2));
        assert!(ctx.remaining() < Duration::from_millis(100));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "status");
    }
}
