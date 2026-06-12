use std::collections::HashMap;

use super::{BridgeConnector, ConnectorDeclaration, ConnectorKindDeclaration};

pub struct ConnectorRegistry {
    by_domain: HashMap<String, Box<dyn BridgeConnector>>,
    kind_to_domain: HashMap<String, String>,
    declarations: Vec<ConnectorDeclaration>,
}

impl ConnectorRegistry {
    pub fn new() -> Self {
        Self {
            by_domain: HashMap::new(),
            kind_to_domain: HashMap::new(),
            declarations: Vec::new(),
        }
    }

    pub fn register(&mut self, connector: Box<dyn BridgeConnector>) -> Result<(), String> {
        let declaration = connector.declare();
        let domain = declaration.domain.trim();
        if domain.is_empty() {
            return Err("connector domain empty".to_string());
        }
        if self.by_domain.contains_key(domain) {
            return Err(format!("duplicate connector domain: {domain}"));
        }
        for kind in &declaration.kinds {
            if kind.kind != format!("{}.{}", declaration.domain, kind.verb) {
                return Err(format!("malformed kind: {}", kind.kind));
            }
            if self.kind_to_domain.contains_key(&kind.kind) {
                return Err(format!("duplicate kind: {}", kind.kind));
            }
            self.kind_to_domain
                .insert(kind.kind.clone(), declaration.domain.clone());
        }
        self.declarations.push(declaration.clone());
        self.by_domain.insert(declaration.domain.clone(), connector);
        Ok(())
    }

    pub fn connector_for_kind(&mut self, kind: &str) -> Option<&mut dyn BridgeConnector> {
        let domain = self.kind_to_domain.get(kind)?.clone();
        match self.by_domain.get_mut(&domain) {
            Some(connector) => Some(connector.as_mut()),
            None => None,
        }
    }

    pub fn kind_declaration(&self, kind: &str) -> Option<&ConnectorKindDeclaration> {
        self.declarations
            .iter()
            .flat_map(|declaration| declaration.kinds.iter())
            .find(|item| item.kind == kind)
    }

    pub fn domain_for_kind(&self, kind: &str) -> Option<&str> {
        self.kind_to_domain.get(kind).map(String::as_str)
    }

    pub fn declarations(&self) -> &[ConnectorDeclaration] {
        &self.declarations
    }

    pub fn all_kinds(&self) -> Vec<String> {
        let mut kinds = self.kind_to_domain.keys().cloned().collect::<Vec<_>>();
        kinds.sort();
        kinds
    }

    pub fn boundary_for_domain(&self, domain: &str) -> Option<&dyn BridgeConnector> {
        self.by_domain
            .get(domain)
            .map(|connector| connector.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::{
        BoundaryDescription, BoundaryType, ConnectorDanger, ConnectorError,
        ConnectorExecutionResult, ConnectorGrant, ExecCtx, GrantedBoundary,
    };
    use crate::BridgeJob;
    use serde_json::{json, Value};

    struct TestConnector {
        domain: &'static str,
        kinds: Vec<(&'static str, &'static str, ConnectorDanger, BoundaryType)>,
    }

    impl BridgeConnector for TestConnector {
        fn declare(&self) -> ConnectorDeclaration {
            ConnectorDeclaration {
                domain: self.domain.to_string(),
                kinds: self
                    .kinds
                    .iter()
                    .map(
                        |(kind, verb, danger, boundary_type)| ConnectorKindDeclaration {
                            kind: (*kind).to_string(),
                            verb: (*verb).to_string(),
                            danger: *danger,
                            boundary_type: *boundary_type,
                        },
                    )
                    .collect(),
            }
        }

        fn execute(
            &mut self,
            _job: &BridgeJob,
            _boundary: &GrantedBoundary,
            _ctx: &mut ExecCtx<'_>,
        ) -> Result<ConnectorExecutionResult, ConnectorError> {
            Ok(ConnectorExecutionResult {
                ok: true,
                result: json!({ "ok": true }),
            })
        }

        fn describe_boundary(&self, _grant: &ConnectorGrant) -> BoundaryDescription {
            BoundaryDescription {
                title: self.domain.to_string(),
                summary: String::new(),
                bullets: Vec::new(),
                audit_label: self.domain.to_string(),
                redacted_boundary: Value::Null,
            }
        }
    }

    #[test]
    fn register_rejects_invalid_or_duplicate_connectors() {
        let mut registry = ConnectorRegistry::new();
        assert!(registry
            .register(Box::new(TestConnector {
                domain: "",
                kinds: vec![],
            }))
            .unwrap_err()
            .contains("domain empty"));

        registry
            .register(Box::new(TestConnector {
                domain: "codex",
                kinds: vec![(
                    "codex.chat",
                    "chat",
                    ConnectorDanger::Low,
                    BoundaryType::WorkspaceSandbox,
                )],
            }))
            .unwrap();
        assert!(registry
            .register(Box::new(TestConnector {
                domain: "codex",
                kinds: vec![(
                    "codex.run",
                    "run",
                    ConnectorDanger::Low,
                    BoundaryType::WorkspaceSandbox,
                )],
            }))
            .unwrap_err()
            .contains("duplicate connector domain"));

        let mut registry = ConnectorRegistry::new();
        assert!(registry
            .register(Box::new(TestConnector {
                domain: "data",
                kinds: vec![(
                    "data.write",
                    "put",
                    ConnectorDanger::Medium,
                    BoundaryType::NamespaceKv,
                )],
            }))
            .unwrap_err()
            .contains("malformed kind"));

        let mut registry = ConnectorRegistry::new();
        assert!(registry
            .register(Box::new(TestConnector {
                domain: "a",
                kinds: vec![
                    (
                        "a.run",
                        "run",
                        ConnectorDanger::Low,
                        BoundaryType::OpaqueRuntime
                    ),
                    (
                        "a.run",
                        "run",
                        ConnectorDanger::Low,
                        BoundaryType::OpaqueRuntime
                    ),
                ],
            }))
            .unwrap_err()
            .contains("duplicate kind"));
    }

    #[test]
    fn routes_and_aggregates_declarations() {
        let mut registry = ConnectorRegistry::new();
        registry
            .register(Box::new(TestConnector {
                domain: "codex",
                kinds: vec![
                    (
                        "codex.chat",
                        "chat",
                        ConnectorDanger::Low,
                        BoundaryType::WorkspaceSandbox,
                    ),
                    (
                        "codex.run",
                        "run",
                        ConnectorDanger::Low,
                        BoundaryType::WorkspaceSandbox,
                    ),
                    (
                        "codex.rpc",
                        "rpc",
                        ConnectorDanger::Low,
                        BoundaryType::WorkspaceSandbox,
                    ),
                ],
            }))
            .unwrap();
        registry
            .register(Box::new(TestConnector {
                domain: "data",
                kinds: vec![
                    (
                        "data.put",
                        "put",
                        ConnectorDanger::Medium,
                        BoundaryType::NamespaceKv,
                    ),
                    (
                        "data.get",
                        "get",
                        ConnectorDanger::Medium,
                        BoundaryType::NamespaceKv,
                    ),
                    (
                        "data.query",
                        "query",
                        ConnectorDanger::Medium,
                        BoundaryType::NamespaceKv,
                    ),
                    (
                        "data.delete",
                        "delete",
                        ConnectorDanger::Medium,
                        BoundaryType::NamespaceKv,
                    ),
                ],
            }))
            .unwrap();

        assert!(registry.connector_for_kind("codex.chat").is_some());
        assert!(registry.connector_for_kind("data.get").is_some());
        assert!(registry.connector_for_kind("missing.kind").is_none());
        assert_eq!(registry.declarations().len(), 2);
        assert_eq!(registry.all_kinds().len(), 7);
        assert_eq!(
            registry.kind_declaration("data.put").unwrap().boundary_type,
            BoundaryType::NamespaceKv
        );
    }
}
