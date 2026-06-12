use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, collections::HashMap, fs, path::PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::BridgeJob;

use super::{
    BoundaryDescription, BoundaryType, BridgeConnector, ConnectorDanger, ConnectorDeclaration,
    ConnectorError, ConnectorExecutionResult, ConnectorGrant, ConnectorKindDeclaration, ExecCtx,
    GrantedBoundary,
};

pub const DEFAULT_MAX_KEY_BYTES: usize = 512;
pub const DEFAULT_MAX_VALUE_BYTES: usize = 262_144;
pub const DEFAULT_QUERY_LIMIT: usize = 100;
pub const MAX_QUERY_LIMIT: usize = 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct KvEntry {
    pub key: String,
    pub value: Value,
    pub updated_at: String,
}

#[derive(Debug)]
pub enum KvError {
    Io(String),
    Serialize(String),
    Corrupt(String),
}

impl KvError {
    fn message(&self) -> String {
        match self {
            Self::Io(message) | Self::Serialize(message) | Self::Corrupt(message) => {
                message.clone()
            }
        }
    }
}

pub trait LocalKvStore: Send {
    /// Contract: value_json is serde_json compact serialization.
    /// The connector computes quota bytes from this exact string and the store
    /// persists it unchanged so validation bytes and stored bytes cannot drift.
    fn put(&mut self, namespace: &str, key: &str, value_json: &str) -> Result<(), KvError>;
    fn get(&self, namespace: &str, key: &str) -> Result<Option<KvEntry>, KvError>;
    fn query(&self, namespace: &str, prefix: &str, limit: usize) -> Result<Vec<KvEntry>, KvError>;
    fn delete(&mut self, namespace: &str, key: &str) -> Result<bool, KvError>;
}

pub struct SqliteKv {
    conn: Connection,
}

impl SqliteKv {
    pub fn open_default() -> Result<Self, String> {
        Self::open(default_kv_path()?)
    }

    pub fn open_product(product_id: &str) -> Result<Self, String> {
        Self::open(product_kv_path(product_id)?)
    }

    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        let conn = Connection::open(&path).map_err(|error| error.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS kv (
              namespace   TEXT NOT NULL,
              key         TEXT NOT NULL,
              value_json  TEXT NOT NULL,
              value_bytes INTEGER NOT NULL,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              PRIMARY KEY (namespace, key)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS kv_ns_key ON kv(namespace, key);
            ",
        )
        .map_err(|error| error.to_string())?;
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if integrity != "ok" {
            return Err(format!("sqlite integrity check failed: {integrity}"));
        }
        #[cfg(unix)]
        {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        Ok(Self { conn })
    }
}

impl LocalKvStore for SqliteKv {
    fn put(&mut self, namespace: &str, key: &str, value_json: &str) -> Result<(), KvError> {
        let now = crate::now_string();
        self.conn
            .execute(
                "
                INSERT INTO kv(namespace, key, value_json, value_bytes, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                ON CONFLICT(namespace, key) DO UPDATE SET
                  value_json=excluded.value_json,
                  value_bytes=excluded.value_bytes,
                  updated_at=excluded.updated_at
                ",
                params![namespace, key, value_json, value_json.len() as i64, now],
            )
            .map_err(|error| KvError::Io(error.to_string()))?;
        Ok(())
    }

    fn get(&self, namespace: &str, key: &str) -> Result<Option<KvEntry>, KvError> {
        self.conn
            .query_row(
                "SELECT key, value_json, updated_at FROM kv WHERE namespace=?1 AND key=?2",
                params![namespace, key],
                sqlite_entry,
            )
            .optional()
            .map_err(|error| KvError::Io(error.to_string()))?
            .transpose()
    }

    fn query(&self, namespace: &str, prefix: &str, limit: usize) -> Result<Vec<KvEntry>, KvError> {
        let mut stmt = self
            .conn
            .prepare(
                "
                SELECT key, value_json, updated_at
                FROM kv
                WHERE namespace=?1 AND key LIKE (?2 || '%') ESCAPE '\\'
                ORDER BY key ASC
                LIMIT ?3
                ",
            )
            .map_err(|error| KvError::Io(error.to_string()))?;
        let rows = stmt
            .query_map(
                params![namespace, escape_like(prefix), limit as i64],
                sqlite_entry,
            )
            .map_err(|error| KvError::Io(error.to_string()))?;
        let mut entries = Vec::new();
        for row in rows {
            let entry = row.map_err(|error| KvError::Io(error.to_string()))??;
            entries.push(entry);
        }
        Ok(entries)
    }

    fn delete(&mut self, namespace: &str, key: &str) -> Result<bool, KvError> {
        let affected = self
            .conn
            .execute(
                "DELETE FROM kv WHERE namespace=?1 AND key=?2",
                params![namespace, key],
            )
            .map_err(|error| KvError::Io(error.to_string()))?;
        Ok(affected > 0)
    }
}

fn sqlite_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<KvEntry, KvError>> {
    let key: String = row.get(0)?;
    let value_json: String = row.get(1)?;
    let updated_at: String = row.get(2)?;
    let value = serde_json::from_str(&value_json)
        .map_err(|error| KvError::Corrupt(format!("invalid value_json for {key}: {error}")));
    Ok(value.map(|value| KvEntry {
        key,
        value,
        updated_at,
    }))
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn default_kv_path() -> Result<PathBuf, String> {
    Ok(crate::state_dir()?.join("data").join("kv.sqlite3"))
}

pub fn product_kv_path(product_id: &str) -> Result<PathBuf, String> {
    Ok(crate::state_dir()?
        .join("data")
        .join("products")
        .join(format!("{}.sqlite3", product_file_stem(product_id)?)))
}

fn product_file_stem(product_id: &str) -> Result<String, String> {
    let trimmed = product_id.trim();
    if trimmed.is_empty() {
        return Err("product_id empty".to_string());
    }
    let mut readable = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if readable.len() > 48 {
        readable.truncate(48);
    }
    let digest = Sha256::digest(trimmed.as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{readable}-{suffix}"))
}

pub struct ProductSqliteKv {
    stores: HashMap<String, SqliteKv>,
}

impl ProductSqliteKv {
    pub fn new() -> Self {
        Self {
            stores: HashMap::new(),
        }
    }

    fn store_mut(&mut self, namespace: &str) -> Result<&mut SqliteKv, KvError> {
        let product_id = product_id_from_namespace(namespace)?;
        if !self.stores.contains_key(&product_id) {
            let store = SqliteKv::open_product(&product_id).map_err(KvError::Io)?;
            self.stores.insert(product_id.clone(), store);
        }
        self.stores
            .get_mut(&product_id)
            .ok_or_else(|| KvError::Io("product sqlite store unavailable".to_string()))
    }

    fn store(&self, namespace: &str) -> Result<Option<&SqliteKv>, KvError> {
        let product_id = product_id_from_namespace(namespace)?;
        Ok(self.stores.get(&product_id))
    }

    fn open_existing_store(&self, namespace: &str) -> Result<Option<SqliteKv>, KvError> {
        let product_id = product_id_from_namespace(namespace)?;
        let path = product_kv_path(&product_id).map_err(KvError::Io)?;
        if !path.exists() {
            return Ok(None);
        }
        SqliteKv::open(path).map(Some).map_err(KvError::Io)
    }
}

impl Default for ProductSqliteKv {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalKvStore for ProductSqliteKv {
    fn put(&mut self, namespace: &str, key: &str, value_json: &str) -> Result<(), KvError> {
        self.store_mut(namespace)?.put(namespace, key, value_json)
    }

    fn get(&self, namespace: &str, key: &str) -> Result<Option<KvEntry>, KvError> {
        match self.store(namespace)? {
            Some(store) => store.get(namespace, key),
            None => match self.open_existing_store(namespace)? {
                Some(store) => store.get(namespace, key),
                None => Ok(None),
            },
        }
    }

    fn query(&self, namespace: &str, prefix: &str, limit: usize) -> Result<Vec<KvEntry>, KvError> {
        match self.store(namespace)? {
            Some(store) => store.query(namespace, prefix, limit),
            None => match self.open_existing_store(namespace)? {
                Some(store) => store.query(namespace, prefix, limit),
                None => Ok(Vec::new()),
            },
        }
    }

    fn delete(&mut self, namespace: &str, key: &str) -> Result<bool, KvError> {
        self.store_mut(namespace)?.delete(namespace, key)
    }
}

fn product_id_from_namespace(namespace: &str) -> Result<String, KvError> {
    namespace
        .strip_prefix("product:")
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| KvError::Io("invalid product namespace".to_string()))
}

#[derive(Default)]
pub struct MemKv {
    map: BTreeMap<(String, String), (Value, String)>,
}

impl MemKv {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub fn contains_namespace_key(&self, namespace: &str, key: &str) -> bool {
        self.map
            .contains_key(&(namespace.to_string(), key.to_string()))
    }
}

impl LocalKvStore for MemKv {
    fn put(&mut self, namespace: &str, key: &str, value_json: &str) -> Result<(), KvError> {
        let value = serde_json::from_str(value_json)
            .map_err(|error| KvError::Serialize(error.to_string()))?;
        self.map.insert(
            (namespace.to_string(), key.to_string()),
            (value, crate::now_string()),
        );
        Ok(())
    }

    fn get(&self, namespace: &str, key: &str) -> Result<Option<KvEntry>, KvError> {
        Ok(self
            .map
            .get(&(namespace.to_string(), key.to_string()))
            .map(|(value, updated_at)| KvEntry {
                key: key.to_string(),
                value: value.clone(),
                updated_at: updated_at.clone(),
            }))
    }

    fn query(&self, namespace: &str, prefix: &str, limit: usize) -> Result<Vec<KvEntry>, KvError> {
        Ok(self
            .map
            .iter()
            .filter(|((ns, key), _)| ns == namespace && key.starts_with(prefix))
            .take(limit)
            .map(|((_, key), (value, updated_at))| KvEntry {
                key: key.clone(),
                value: value.clone(),
                updated_at: updated_at.clone(),
            })
            .collect())
    }

    fn delete(&mut self, namespace: &str, key: &str) -> Result<bool, KvError> {
        Ok(self
            .map
            .remove(&(namespace.to_string(), key.to_string()))
            .is_some())
    }
}

pub struct DataConnector<KV: LocalKvStore> {
    kv: KV,
}

impl<KV: LocalKvStore> DataConnector<KV> {
    pub fn new(kv: KV) -> Self {
        Self { kv }
    }

    pub fn into_inner(self) -> KV {
        self.kv
    }
}

impl<KV: LocalKvStore> BridgeConnector for DataConnector<KV> {
    fn declare(&self) -> ConnectorDeclaration {
        ConnectorDeclaration {
            domain: "data".to_string(),
            kinds: vec![kind("put"), kind("get"), kind("query"), kind("delete")],
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
        if boundary.boundary_type != BoundaryType::NamespaceKv {
            return deny("namespace", "boundary_type_mismatch_locally");
        }
        if boundary.domain != "data" {
            return deny("namespace", "boundary_type_mismatch_locally");
        }
        if !matches!(
            job.kind.as_str(),
            "data.put" | "data.get" | "data.query" | "data.delete"
        ) {
            return Err(ConnectorError::InvalidJob {
                reason: format!("unsupported data kind: {}", job.kind),
            });
        }
        if !boundary.capabilities.iter().any(|item| item == &job.kind) {
            return deny("capability", "capability_not_authorized_locally");
        }

        let data_boundary = DataBoundary::parse(&boundary.raw, &boundary.product_id);
        if job.product_id != data_boundary.owner_product_id {
            return deny("namespace", "namespace_owner_mismatch_locally");
        }
        let effective_ns = format!("product:{}", job.product_id);
        if let Some(requested_ns) = job.input.get("ns").and_then(Value::as_str) {
            if requested_ns != effective_ns {
                return deny("namespace", "namespace_not_owned_locally");
            }
        }

        ctx.emit(
            "started",
            json!({ "kind": job.kind, "boundaryType": "namespace_kv" }),
        );
        let verb = job.kind.strip_prefix("data.").unwrap_or(job.kind.as_str());
        ctx.emit(
            "status",
            json!({ "operation": verb, "namespace": effective_ns }),
        );

        let result = match verb {
            "put" => {
                let key = validated_key(
                    job.input.get("key").and_then(Value::as_str),
                    data_boundary.max_key_bytes,
                )?;
                let value = job.input.get("value").cloned().unwrap_or(Value::Null);
                let value_json =
                    serde_json::to_string(&value).map_err(|error| ConnectorError::InvalidJob {
                        reason: error.to_string(),
                    })?;
                if value_json.len() > data_boundary.max_value_bytes {
                    return deny("value", "value_too_large_locally");
                }
                self.kv
                    .put(&effective_ns, &key, &value_json)
                    .map_err(|error| ConnectorError::RuntimeFailed {
                        reason: error.message(),
                    })?;
                json!({ "ok": true, "namespace": effective_ns, "key": key, "written": true })
            }
            "get" => {
                let key = validated_key(
                    job.input.get("key").and_then(Value::as_str),
                    data_boundary.max_key_bytes,
                )?;
                match self.kv.get(&effective_ns, &key).map_err(|error| {
                    ConnectorError::RuntimeFailed {
                        reason: error.message(),
                    }
                })? {
                    Some(entry) => {
                        json!({ "ok": true, "namespace": effective_ns, "key": key, "found": true, "value": entry.value })
                    }
                    None => {
                        json!({ "ok": true, "namespace": effective_ns, "key": key, "found": false })
                    }
                }
            }
            "query" => {
                if !data_boundary.allow_query {
                    return deny("key", "query_invalid_locally");
                }
                let prefix = validated_prefix(
                    job.input
                        .get("prefix")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    data_boundary.max_key_bytes,
                )?;
                let limit = job
                    .input
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(DEFAULT_QUERY_LIMIT)
                    .clamp(1, MAX_QUERY_LIMIT);
                let items = self
                    .kv
                    .query(&effective_ns, &prefix, limit)
                    .map_err(|error| ConnectorError::RuntimeFailed {
                        reason: error.message(),
                    })?
                    .into_iter()
                    .map(|entry| {
                        json!({
                            "key": entry.key,
                            "value": entry.value,
                            "updated_at": entry.updated_at
                        })
                    })
                    .collect::<Vec<_>>();
                json!({ "ok": true, "namespace": effective_ns, "prefix": prefix, "items": items })
            }
            "delete" => {
                if !data_boundary.allow_delete {
                    return deny("key", "key_invalid_locally");
                }
                let key = validated_key(
                    job.input.get("key").and_then(Value::as_str),
                    data_boundary.max_key_bytes,
                )?;
                let deleted = self.kv.delete(&effective_ns, &key).map_err(|error| {
                    ConnectorError::RuntimeFailed {
                        reason: error.message(),
                    }
                })?;
                json!({ "ok": true, "namespace": effective_ns, "key": key, "deleted": deleted })
            }
            _ => unreachable!(),
        };
        Ok(ConnectorExecutionResult {
            ok: result.get("ok").and_then(Value::as_bool).unwrap_or(false),
            result,
        })
    }

    fn describe_boundary(&self, grant: &ConnectorGrant) -> BoundaryDescription {
        let max_value_bytes = grant
            .authorization_policy
            .pointer("/boundaries/data/max_value_bytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_MAX_VALUE_BYTES as u64);
        BoundaryDescription {
            title: "本机数据区".to_string(),
            summary: format!(
                "{} 只能读写它自己在本机的数据区，无法访问其它产品的数据。",
                grant.product_name
            ),
            bullets: vec![
                format!(
                    "命名空间隔离：每个产品独占 product:{} 前缀",
                    grant.product_id
                ),
                "无法访问你的文件、终端或其它应用".to_string(),
                format!("单值上限 {} KB", max_value_bytes / 1024),
            ],
            audit_label: format!("data:product:{}", grant.product_id),
            redacted_boundary: json!({
                "type": "namespace_kv",
                "namespace": format!("product:{}", grant.product_id)
            }),
        }
    }
}

fn kind(verb: &str) -> ConnectorKindDeclaration {
    ConnectorKindDeclaration {
        kind: format!("data.{verb}"),
        verb: verb.to_string(),
        danger: ConnectorDanger::Medium,
        boundary_type: BoundaryType::NamespaceKv,
    }
}

struct DataBoundary {
    owner_product_id: String,
    max_key_bytes: usize,
    max_value_bytes: usize,
    allow_query: bool,
    allow_delete: bool,
}

impl DataBoundary {
    fn parse(raw: &Value, fallback_product_id: &str) -> Self {
        Self {
            owner_product_id: raw
                .get("owner_product_id")
                .or_else(|| raw.get("ownerProductId"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(fallback_product_id)
                .to_string(),
            max_key_bytes: raw
                .get("max_key_bytes")
                .or_else(|| raw.get("maxKeyBytes"))
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(DEFAULT_MAX_KEY_BYTES),
            max_value_bytes: raw
                .get("max_value_bytes")
                .or_else(|| raw.get("maxValueBytes"))
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(DEFAULT_MAX_VALUE_BYTES),
            allow_query: raw
                .get("allow_query")
                .or_else(|| raw.get("allowQuery"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
            allow_delete: raw
                .get("allow_delete")
                .or_else(|| raw.get("allowDelete"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    }
}

fn validated_key(value: Option<&str>, max_bytes: usize) -> Result<String, ConnectorError> {
    let Some(key) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return deny("key", "key_invalid_locally");
    };
    if invalid_key_text(key, max_bytes) {
        return deny("key", "key_invalid_locally");
    }
    Ok(key.to_string())
}

fn validated_prefix(prefix: &str, max_bytes: usize) -> Result<String, ConnectorError> {
    if prefix.len() > max_bytes || prefix.chars().any(char::is_control) || prefix.contains("..") {
        return deny("key", "query_invalid_locally");
    }
    if prefix.starts_with('/') {
        return deny("key", "query_invalid_locally");
    }
    Ok(prefix.to_string())
}

fn invalid_key_text(key: &str, max_bytes: usize) -> bool {
    key.len() > max_bytes
        || key.starts_with('/')
        || key.contains("..")
        || key.chars().any(char::is_control)
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
    use crate::connector::{ConnectorEvent, ExecCtx, GrantedBoundary};
    use std::time::{Duration, Instant};

    fn job(product_id: &str, kind: &str, input: Value) -> BridgeJob {
        BridgeJob {
            id: "job_data".to_string(),
            product_id: product_id.to_string(),
            kind: kind.to_string(),
            workspace_ref: None,
            input,
            policy: json!({}),
            request_key: None,
            cap_token: None,
        }
    }

    fn boundary(owner: &str, capabilities: Vec<&str>) -> GrantedBoundary {
        GrantedBoundary {
            product_id: owner.to_string(),
            product_name: owner.to_string(),
            domain: "data".to_string(),
            boundary_type: BoundaryType::NamespaceKv,
            capabilities: capabilities.into_iter().map(ToOwned::to_owned).collect(),
            raw: json!({
                "type": "namespace_kv",
                "owner_product_id": owner,
                "namespace": format!("product:{owner}"),
                "max_key_bytes": 16,
                "max_value_bytes": 64,
                "allow_query": true,
                "allow_delete": true
            }),
        }
    }

    fn execute_with_ctx(
        connector: &mut DataConnector<MemKv>,
        job: &BridgeJob,
        boundary: &GrantedBoundary,
        events: &mut Vec<ConnectorEvent>,
    ) -> Result<ConnectorExecutionResult, ConnectorError> {
        let mut emit = |event| events.push(event);
        let is_cancelled = || false;
        let mut ctx = ExecCtx {
            emit: &mut emit,
            is_cancelled: &is_cancelled,
            deadline: Instant::now() + Duration::from_secs(10),
            sandbox_spec: None,
        };
        connector.execute(job, boundary, &mut ctx)
    }

    fn reason(error: ConnectorError) -> String {
        match error {
            ConnectorError::LocalPolicyDenied { reason, .. } => reason,
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn data_put_get_query_delete_round_trip() {
        let mut connector = DataConnector::new(MemKv::new());
        let mut events = Vec::new();
        let boundary = boundary(
            "A",
            vec!["data.put", "data.get", "data.query", "data.delete"],
        );
        let put = execute_with_ctx(
            &mut connector,
            &job(
                "A",
                "data.put",
                json!({ "key": "settings/theme", "value": { "theme": "dark" } }),
            ),
            &boundary,
            &mut events,
        )
        .unwrap()
        .result;
        assert_eq!(put["ok"], true);
        assert_eq!(put["namespace"], "product:A");

        let get = execute_with_ctx(
            &mut connector,
            &job("A", "data.get", json!({ "key": "settings/theme" })),
            &boundary,
            &mut events,
        )
        .unwrap()
        .result;
        assert_eq!(get["found"], true);
        assert_eq!(get["value"], json!({ "theme": "dark" }));

        let query = execute_with_ctx(
            &mut connector,
            &job(
                "A",
                "data.query",
                json!({ "prefix": "settings/", "limit": 2000 }),
            ),
            &boundary,
            &mut events,
        )
        .unwrap()
        .result;
        assert_eq!(query["items"].as_array().unwrap().len(), 1);

        let deleted = execute_with_ctx(
            &mut connector,
            &job("A", "data.delete", json!({ "key": "settings/theme" })),
            &boundary,
            &mut events,
        )
        .unwrap()
        .result;
        assert_eq!(deleted["deleted"], true);

        let missing = execute_with_ctx(
            &mut connector,
            &job("A", "data.get", json!({ "key": "settings/theme" })),
            &boundary,
            &mut events,
        )
        .unwrap()
        .result;
        assert_eq!(missing["found"], false);
        assert!(!put.to_string().contains("kv.sqlite3"));
        assert!(events.iter().any(|event| event.event_type == "started"));
    }

    #[test]
    fn data_rejects_invalid_keys_values_and_namespace() {
        let mut connector = DataConnector::new(MemKv::new());
        let mut events = Vec::new();
        let boundary = boundary("A", vec!["data.put", "data.query"]);

        assert_eq!(
            reason(
                execute_with_ctx(
                    &mut connector,
                    &job("A", "data.put", json!({ "key": "", "value": 1 })),
                    &boundary,
                    &mut events
                )
                .unwrap_err()
            ),
            "key_invalid_locally"
        );
        assert_eq!(
            reason(
                execute_with_ctx(
                    &mut connector,
                    &job("A", "data.put", json!({ "key": "/x", "value": 1 })),
                    &boundary,
                    &mut events
                )
                .unwrap_err()
            ),
            "key_invalid_locally"
        );
        assert_eq!(
            reason(
                execute_with_ctx(
                    &mut connector,
                    &job("A", "data.put", json!({ "key": "a..b", "value": 1 })),
                    &boundary,
                    &mut events
                )
                .unwrap_err()
            ),
            "key_invalid_locally"
        );
        assert_eq!(
            reason(
                execute_with_ctx(
                    &mut connector,
                    &job(
                        "A",
                        "data.put",
                        json!({ "key": "ok", "value": "x".repeat(100) })
                    ),
                    &boundary,
                    &mut events,
                )
                .unwrap_err()
            ),
            "value_too_large_locally"
        );
        assert_eq!(
            reason(
                execute_with_ctx(
                    &mut connector,
                    &job(
                        "A",
                        "data.put",
                        json!({ "ns": "product:B", "key": "ok", "value": 1 })
                    ),
                    &boundary,
                    &mut events,
                )
                .unwrap_err()
            ),
            "namespace_not_owned_locally"
        );
        assert_eq!(
            reason(
                execute_with_ctx(
                    &mut connector,
                    &job("A", "data.query", json!({ "prefix": "../" })),
                    &boundary,
                    &mut events,
                )
                .unwrap_err()
            ),
            "query_invalid_locally"
        );
    }

    #[test]
    fn cross_product_namespace_isolation_negative_cases() {
        let mut connector = DataConnector::new(MemKv::new());
        let mut events = Vec::new();
        let boundary_a = boundary("A", vec!["data.put", "data.get"]);
        let boundary_b = boundary("B", vec!["data.put", "data.get"]);

        let spoof_ns = execute_with_ctx(
            &mut connector,
            &job(
                "A",
                "data.put",
                json!({ "ns": "product:B", "key": "x", "value": 1 }),
            ),
            &boundary_a,
            &mut events,
        )
        .unwrap_err();
        assert_eq!(reason(spoof_ns), "namespace_not_owned_locally");
        assert!(!connector.kv.contains_namespace_key("product:B", "x"));

        let owner_mismatch = execute_with_ctx(
            &mut connector,
            &job("B", "data.put", json!({ "key": "x", "value": 1 })),
            &boundary_a,
            &mut events,
        )
        .unwrap_err();
        assert_eq!(reason(owner_mismatch), "namespace_owner_mismatch_locally");

        execute_with_ctx(
            &mut connector,
            &job("A", "data.put", json!({ "key": "x", "value": 1 })),
            &boundary_a,
            &mut events,
        )
        .unwrap();
        assert!(connector.kv.contains_namespace_key("product:A", "x"));
        assert!(!connector.kv.contains_namespace_key("product:B", "x"));

        let cross_read = execute_with_ctx(
            &mut connector,
            &job("B", "data.get", json!({ "key": "x" })),
            &boundary_b,
            &mut events,
        )
        .unwrap()
        .result;
        assert_eq!(cross_read["found"], false);

        let cloud_l1_bypass = execute_with_ctx(
            &mut connector,
            &job("B", "data.get", json!({ "key": "x" })),
            &boundary_a,
            &mut events,
        )
        .unwrap_err();
        assert_eq!(reason(cloud_l1_bypass), "namespace_owner_mismatch_locally");
    }

    #[test]
    fn sqlite_store_round_trips_json_without_path_leak() {
        let dir =
            std::env::temp_dir().join(format!("panda-bridge-kv-test-{}", crate::next_event_seq()));
        let path = dir.join("kv.sqlite3");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let _ = fs::remove_file(&path);
        let mut store = SqliteKv::open(path.clone()).unwrap();
        store
            .put("product:A", "json", r#"{"n":1,"ok":true}"#)
            .unwrap();
        let entry = store.get("product:A", "json").unwrap().unwrap();
        assert_eq!(entry.value, json!({ "n": 1, "ok": true }));
        assert!(store.query("product:A", "j", 10).unwrap().len() == 1);
        assert!(store.delete("product:A", "json").unwrap());
        assert!(store.get("product:A", "json").unwrap().is_none());
        drop(store);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn product_sqlite_paths_are_physically_isolated() {
        let path_a = product_kv_path("product-A").unwrap();
        let path_b = product_kv_path("product-B").unwrap();
        assert_ne!(path_a, path_b);
        assert!(path_a.to_string_lossy().contains("product-A"));
        assert!(path_b.to_string_lossy().contains("product-B"));
    }

    #[test]
    fn product_sqlite_store_does_not_cross_read_other_product() {
        let old_home = std::env::var_os("HOME");
        let home = std::env::temp_dir().join(format!(
            "panda-bridge-product-kv-test-{}",
            crate::next_event_seq()
        ));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);

        let mut store = ProductSqliteKv::new();
        store.put("product:A", "x", "1").unwrap();
        let from_a = store.get("product:A", "x").unwrap().unwrap();
        assert_eq!(from_a.value, json!(1));
        assert!(store.get("product:B", "x").unwrap().is_none());

        let path_a = product_kv_path("A").unwrap();
        let path_b = product_kv_path("B").unwrap();
        assert_ne!(path_a, path_b);
        assert!(path_a.exists());
        assert!(!path_b.exists());
        let cold_store = ProductSqliteKv::new();
        let cold_read = cold_store.get("product:A", "x").unwrap().unwrap();
        assert_eq!(cold_read.value, json!(1));
        let cold_query = cold_store.query("product:A", "x", 10).unwrap();
        assert_eq!(cold_query.len(), 1);

        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(home);
    }
}
