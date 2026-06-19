use crate::model::{Counts, Report, ScanCacheDiagnostics, ScanDiagnostics, ScanLimits, Session};
use crate::parser;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const DEFAULT_RUNNING_WINDOW_SECS: i64 = 90;
const CACHE_SCHEMA: &str = "burn-monitor.session-index-cache.v1";
const CACHE_PARSER_VERSION: u32 = 1;

pub fn scan_home(home: &Path, now: DateTime<Utc>, window_secs: i64) -> Report {
    let roots = default_provider_roots_from_home(home);
    scan_home_with_roots(home, &roots, now, window_secs)
}

pub fn scan_configured_home(home: &Path, now: DateTime<Utc>, window_secs: i64) -> Report {
    let roots = configured_provider_roots_from_home(home);
    scan_home_with_roots(home, &roots, now, window_secs)
}

fn scan_home_with_roots(
    home: &Path,
    roots: &ProviderRoots,
    now: DateTime<Utc>,
    window_secs: i64,
) -> Report {
    let started = Instant::now();
    let scan_files = candidate_session_files(roots);
    let source_roots = roots.clone().source_roots();
    let mut diagnostics = scan_diagnostics(&source_roots, window_secs);
    let mut cache_plan = ScanCachePlan::load(home, &source_roots, &scan_files, &mut diagnostics);
    let resolver = ProjectResolver::new(home);
    let mut sessions = Vec::new();
    let mut counts = Counts::default();

    for file in &scan_files {
        counts.scanned += 1;
        let session = scan_file(file, &resolver, now, window_secs, &mut cache_plan);
        if let Some(session) = session {
            counts.valid += 1;
            sessions.push(session);
        } else {
            counts.skipped += 1;
        }
    }

    cache_plan.finish(&mut diagnostics);
    diagnostics.elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    Report::from_sessions_with_counts(sessions, parser::format_time(now), counts)
        .with_scan_diagnostics(diagnostics)
}

pub fn running_window_secs() -> i64 {
    std::env::var("BURN_RUNNING_WINDOW_SECS")
        .ok()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_RUNNING_WINDOW_SECS)
}

pub fn source_roots_from_home(home: &Path) -> Vec<PathBuf> {
    default_provider_roots_from_home(home).source_roots()
}

pub(crate) fn configured_source_roots_from_home(home: &Path) -> Vec<PathBuf> {
    configured_provider_roots_from_home(home).source_roots()
}

pub(crate) fn default_codex_history_roots_from_home(home: &Path) -> Vec<PathBuf> {
    let roots = default_provider_roots_from_home(home);
    roots
        .codex_sessions
        .into_iter()
        .chain(roots.codexctl)
        .collect()
}

pub(crate) fn configured_codex_history_roots_from_home(home: &Path) -> Vec<PathBuf> {
    let roots = configured_provider_roots_from_home(home);
    roots
        .codex_sessions
        .into_iter()
        .chain(roots.codexctl)
        .collect()
}

pub(crate) fn default_claude_project_roots_from_home(home: &Path) -> Vec<PathBuf> {
    default_provider_roots_from_home(home).claude_projects
}

pub(crate) fn configured_claude_project_roots_from_home(home: &Path) -> Vec<PathBuf> {
    configured_provider_roots_from_home(home).claude_projects
}

fn scan_diagnostics(source_roots: &[PathBuf], window_secs: i64) -> ScanDiagnostics {
    ScanDiagnostics {
        mode: "full_rescan".to_owned(),
        elapsed_ms: 0,
        source_roots: source_roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect(),
        cache: ScanCacheDiagnostics::default(),
        limits: ScanLimits {
            running_window_secs: window_secs,
            head_bytes: parser::head_bytes_limit(),
            head_lines: parser::head_lines_limit(),
            tail_bytes: parser::tail_bytes_limit(),
            transcript_default_limit: crate::transcript::default_limit(),
            transcript_max_limit: crate::transcript::max_limit(),
            max_scan_files: None,
        },
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderRoots {
    codex_sessions: Vec<PathBuf>,
    codexctl: Vec<PathBuf>,
    claude_projects: Vec<PathBuf>,
}

impl ProviderRoots {
    fn source_roots(self) -> Vec<PathBuf> {
        self.codex_sessions
            .into_iter()
            .chain(self.codexctl)
            .chain(self.claude_projects)
            .collect()
    }
}

pub(crate) fn default_provider_roots_from_home(home: &Path) -> ProviderRoots {
    ProviderRoots {
        codex_sessions: vec![home.join(".codex").join("sessions")],
        codexctl: vec![home.join(".codexctl")],
        claude_projects: vec![home.join(".claude").join("projects")],
    }
}

pub(crate) fn configured_provider_roots_from_home(home: &Path) -> ProviderRoots {
    ProviderRoots {
        codex_sessions: configured_codex_session_roots(home),
        codexctl: configured_codexctl_roots(home),
        claude_projects: configured_claude_project_roots(home),
    }
}

fn configured_codex_session_roots(home: &Path) -> Vec<PathBuf> {
    if let Some(explicit) = configured_env_path("CODEX_HOME") {
        return dedupe_paths(vec![explicit.join("sessions")]);
    }
    if configured_profile_id()
        .as_deref()
        .is_some_and(|id| id.starts_with("codex:"))
    {
        return vec![home.join(".codex").join("sessions")];
    }
    provider_dirs(home, ".codex", home.join(".codex"))
        .into_iter()
        .map(|dir| dir.join("sessions"))
        .collect()
}

fn configured_codexctl_roots(home: &Path) -> Vec<PathBuf> {
    if configured_env_path("CODEX_HOME").is_some()
        || configured_profile_id()
            .as_deref()
            .is_some_and(|id| id.starts_with("codex:"))
    {
        return Vec::new();
    }
    vec![home.join(".codexctl")]
}

fn configured_claude_project_roots(home: &Path) -> Vec<PathBuf> {
    if let Some(explicit) = configured_env_path("CLAUDE_CONFIG_DIR") {
        return dedupe_paths(vec![explicit.join("projects")]);
    }
    if configured_profile_id().as_deref() == Some("claude:default") {
        return vec![home.join(".claude").join("projects")];
    }
    provider_dirs(home, ".claude", home.join(".claude"))
        .into_iter()
        .map(|dir| dir.join("projects"))
        .collect()
}

fn provider_dirs(home: &Path, prefix: &str, default_dir: PathBuf) -> Vec<PathBuf> {
    let mut dirs = vec![default_dir];
    if let Ok(entries) = fs::read_dir(home) {
        let mut entries = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort();
        dirs.extend(entries);
    }
    dedupe_paths(dirs)
}

fn configured_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn configured_profile_id() -> Option<String> {
    std::env::var("BURN_AGENT_PROFILE_ID")
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    paths
        .into_iter()
        .filter(|path| {
            let key = fs::canonicalize(path)
                .unwrap_or_else(|_| path.clone())
                .to_string_lossy()
                .into_owned();
            seen.insert(key)
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
enum ScanKind {
    Codex,
    Claude,
}

#[derive(Clone, Debug)]
struct ScanFile {
    path: PathBuf,
    kind: ScanKind,
}

fn candidate_session_files(roots: &ProviderRoots) -> Vec<ScanFile> {
    let mut files = Vec::new();
    for root in &roots.codex_sessions {
        files.extend(
            jsonl_files(root, is_rollout_file)
                .into_iter()
                .map(|path| ScanFile {
                    path,
                    kind: ScanKind::Codex,
                }),
        );
    }
    for root in &roots.codexctl {
        files.extend(
            jsonl_files(root, |path| {
                is_rollout_file(path) && has_component(path, "sessions")
            })
            .into_iter()
            .map(|path| ScanFile {
                path,
                kind: ScanKind::Codex,
            }),
        );
    }
    for root in &roots.claude_projects {
        files.extend(
            jsonl_files(root, is_jsonl_file)
                .into_iter()
                .map(|path| ScanFile {
                    path,
                    kind: ScanKind::Claude,
                }),
        );
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

fn scan_file(
    file: &ScanFile,
    resolver: &ProjectResolver,
    now: DateTime<Utc>,
    window_secs: i64,
    cache_plan: &mut ScanCachePlan,
) -> Option<Session> {
    let key = cache_key(&file.path);
    let fingerprint = FileFingerprint::from_path(&file.path);
    if let Some(session) = cache_plan.cached_session(&key, &fingerprint, now, window_secs) {
        return session;
    }

    let session = match file.kind {
        ScanKind::Codex => parse_codex_session(&file.path, resolver, now, window_secs),
        ScanKind::Claude => parse_claude_session(&file.path, resolver, now, window_secs),
    };
    cache_plan.store(key, fingerprint, session.clone());
    session
}

fn jsonl_files(root: &Path, keep: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| keep(path))
        .collect()
}

#[derive(Debug)]
struct ScanCachePlan {
    path: Option<PathBuf>,
    previous: Option<SessionIndexCache>,
    next: Option<SessionIndexCache>,
}

impl ScanCachePlan {
    fn load(
        home: &Path,
        roots: &[PathBuf],
        files: &[ScanFile],
        diagnostics: &mut ScanDiagnostics,
    ) -> Self {
        let Some(path) = session_index_cache_path(home) else {
            diagnostics.mode = "uncached".to_owned();
            diagnostics.cache.enabled = false;
            return Self {
                path: None,
                previous: None,
                next: None,
            };
        };

        diagnostics.cache.enabled = true;
        diagnostics.cache.path = path.to_string_lossy().into_owned();

        let root_signature = root_signature(roots);
        let file_keys = files.iter().map(|file| cache_key(&file.path)).collect();
        let previous = read_cache(&path, &root_signature, &file_keys, diagnostics);

        let next = SessionIndexCache {
            schema: CACHE_SCHEMA.to_owned(),
            parser_version: CACHE_PARSER_VERSION,
            root_signature,
            files: HashMap::new(),
        };
        Self {
            path: Some(path),
            previous,
            next: Some(next),
        }
    }

    fn cached_session(
        &mut self,
        key: &str,
        fingerprint: &Option<FileFingerprint>,
        now: DateTime<Utc>,
        window_secs: i64,
    ) -> Option<Option<Session>> {
        if self.path.is_none() {
            return None;
        }
        let Some(fingerprint) = fingerprint else {
            self.count_miss();
            return None;
        };
        let Some(previous) = &self.previous else {
            self.count_miss();
            return None;
        };
        let Some(entry) = previous.files.get(key) else {
            self.count_miss();
            return None;
        };
        if entry.fingerprint != *fingerprint {
            self.count_stale();
            return None;
        }
        let entry = entry.clone();
        self.count_hit();
        self.insert_next(key.to_owned(), entry.clone());
        Some(
            entry
                .session
                .map(|session| refresh_cached_session(session, fingerprint, now, window_secs)),
        )
    }

    fn store(
        &mut self,
        key: String,
        fingerprint: Option<FileFingerprint>,
        session: Option<Session>,
    ) {
        if let Some(fingerprint) = fingerprint {
            self.insert_next(
                key,
                CachedSession {
                    fingerprint,
                    session,
                },
            );
        }
    }

    fn finish(&mut self, diagnostics: &mut ScanDiagnostics) {
        CACHE_STATS.with(|stats| {
            let stats = stats.borrow();
            diagnostics.cache.hit = stats.hit;
            diagnostics.cache.miss = stats.miss;
            diagnostics.cache.stale = stats.stale;
        });
        let Some(cache) = self.next.take() else {
            return;
        };
        diagnostics.cache.entries_written = cache.files.len();
        diagnostics.mode = if diagnostics.cache.enabled && !diagnostics.cache.full_rescan {
            "incremental".to_owned()
        } else if diagnostics.cache.enabled {
            "full_rescan".to_owned()
        } else {
            "uncached".to_owned()
        };

        let Some(path) = &self.path else {
            return;
        };
        if let Err(error) = write_cache(path, &cache) {
            diagnostics.cache.write_error = error;
        }
    }

    fn insert_next(&mut self, key: String, entry: CachedSession) {
        if let Some(next) = &mut self.next {
            next.files.insert(key, entry);
        }
    }

    fn count_hit(&self) {
        CACHE_STATS.with(|stats| stats.borrow_mut().hit += 1);
    }

    fn count_miss(&self) {
        CACHE_STATS.with(|stats| stats.borrow_mut().miss += 1);
    }

    fn count_stale(&self) {
        CACHE_STATS.with(|stats| {
            let mut stats = stats.borrow_mut();
            stats.miss += 1;
            stats.stale += 1;
        });
    }
}

thread_local! {
    static CACHE_STATS: RefCell<CacheScanStats> = RefCell::new(CacheScanStats::default());
}

#[derive(Default)]
struct CacheScanStats {
    hit: usize,
    miss: usize,
    stale: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SessionIndexCache {
    schema: String,
    parser_version: u32,
    root_signature: Vec<String>,
    files: HashMap<String, CachedSession>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CachedSession {
    fingerprint: FileFingerprint,
    session: Option<Session>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct FileFingerprint {
    len: u64,
    modified_ns: u64,
}

impl FileFingerprint {
    fn from_path(path: &Path) -> Option<Self> {
        let metadata = fs::metadata(path).ok()?;
        let modified = metadata.modified().ok()?;
        Some(Self {
            len: metadata.len(),
            modified_ns: system_time_ns(modified),
        })
    }
}

impl Drop for ScanCachePlan {
    fn drop(&mut self) {
        CACHE_STATS.with(|stats| *stats.borrow_mut() = CacheScanStats::default());
    }
}

fn read_cache(
    path: &Path,
    root_signature: &[String],
    file_keys: &HashSet<String>,
    diagnostics: &mut ScanDiagnostics,
) -> Option<SessionIndexCache> {
    CACHE_STATS.with(|stats| *stats.borrow_mut() = CacheScanStats::default());
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            mark_full_rescan(diagnostics, "cache_missing");
            return None;
        }
        Err(error) => {
            diagnostics.cache.read_error = error.to_string();
            mark_full_rescan(diagnostics, "cache_unreadable");
            return None;
        }
    };
    let cache = match serde_json::from_str::<SessionIndexCache>(&text) {
        Ok(cache) => cache,
        Err(error) => {
            diagnostics.cache.read_error = error.to_string();
            mark_full_rescan(diagnostics, "cache_invalid_json");
            return None;
        }
    };
    diagnostics.cache.entries_read = cache.files.len();
    if cache.schema != CACHE_SCHEMA {
        mark_full_rescan(diagnostics, "cache_schema_changed");
        return None;
    }
    if cache.parser_version != CACHE_PARSER_VERSION {
        mark_full_rescan(diagnostics, "parser_version_changed");
        return None;
    }
    if cache.root_signature != root_signature {
        mark_full_rescan(diagnostics, "source_roots_changed");
        return None;
    }
    if cache.files.keys().any(|key| !file_keys.contains(key)) {
        mark_full_rescan(diagnostics, "source_files_deleted");
        return None;
    }
    diagnostics.mode = "incremental".to_owned();
    Some(cache)
}

fn write_cache(path: &Path, cache: &SessionIndexCache) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("cache path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(cache).map_err(|error| error.to_string())?;
    fs::write(&tmp, text).map_err(|error| error.to_string())?;
    fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn mark_full_rescan(diagnostics: &mut ScanDiagnostics, reason: &str) {
    diagnostics.mode = "full_rescan".to_owned();
    diagnostics.cache.full_rescan = true;
    diagnostics.cache.full_rescan_reason = reason.to_owned();
}

fn session_index_cache_path(home: &Path) -> Option<PathBuf> {
    if std::env::var("BURN_SESSION_INDEX_CACHE")
        .ok()
        .as_deref()
        .is_some_and(is_cache_disabled_value)
        || std::env::var("BURN_SESSION_INDEX_CACHE_DISABLED")
            .ok()
            .as_deref()
            .is_some_and(is_cache_disabled_value)
    {
        return None;
    }
    std::env::var_os("BURN_SESSION_INDEX_CACHE")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            Some(
                home.join(".burn")
                    .join("monitor")
                    .join("session-index-cache.json"),
            )
        })
}

fn is_cache_disabled_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "no" | "disabled"
    )
}

fn root_signature(roots: &[PathBuf]) -> Vec<String> {
    let mut roots = roots
        .iter()
        .map(|root| {
            fs::canonicalize(root)
                .unwrap_or_else(|_| root.clone())
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    roots
}

fn cache_key(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn refresh_cached_session(
    mut session: Session,
    fingerprint: &FileFingerprint,
    now: DateTime<Utc>,
    window_secs: i64,
) -> Session {
    let last_activity = DateTime::<Utc>::from(
        UNIX_EPOCH + std::time::Duration::from_nanos(fingerprint.modified_ns),
    );
    let updated_at = parser::format_time(last_activity);
    session.last_activity = updated_at.clone();
    session.updated_at = updated_at;
    session.running = now.signed_duration_since(last_activity).num_seconds() < window_secs;
    session
}

fn system_time_ns(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn parse_codex_session(
    path: &Path,
    resolver: &ProjectResolver,
    now: DateTime<Utc>,
    window_secs: i64,
) -> Option<Session> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let head = parser::read_head_lines(path).ok()?;
    let first = parser::parse_json(head.first()?)?;
    if parser::string_at(&first, &["type"]) != Some("session_meta") {
        return None;
    }

    let id = codex_meta_str(&first, "id")
        .map(str::to_owned)
        .unwrap_or_else(|| file_id(path, "rollout-"));
    let project = resolver.project_for_cwd(codex_meta_str(&first, "cwd")?)?;
    let started = parser::parse_time(codex_meta_str(&first, "timestamp"))
        .unwrap_or_else(|| parser::system_time(modified));
    let tail = parser::read_tail_lines(path).unwrap_or_default();
    let title = parser::first_text_by_role(&head, "user");
    let preview = non_empty(parser::last_meaningful_text(&tail), &title);
    Some(make_session(
        path,
        "codex",
        id,
        project,
        title,
        started,
        modified,
        now,
        window_secs,
        preview,
    ))
}

fn parse_claude_session(
    path: &Path,
    resolver: &ProjectResolver,
    now: DateTime<Utc>,
    window_secs: i64,
) -> Option<Session> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let head = parser::read_head_lines(path).unwrap_or_default();
    let tail = parser::read_tail_lines(path).unwrap_or_default();
    let facts = claude_facts(head.iter().chain(tail.iter()));
    let project = resolver.project_for_cwd(&facts.cwd?)?;
    let id = facts.session_id.unwrap_or_else(|| file_id(path, ""));
    let started = facts
        .started_at
        .or_else(|| parser::file_created_or_modified(path).map(parser::system_time))
        .unwrap_or_else(|| parser::system_time(modified));
    let title = non_empty(
        parser::last_text_by_role(&tail, "assistant"),
        &parser::last_text_by_role(&head, "assistant"),
    );
    let preview = non_empty(parser::last_meaningful_text(&tail), &title);
    Some(make_session(
        path,
        "claude",
        id,
        project,
        title,
        started,
        modified,
        now,
        window_secs,
        preview,
    ))
}

#[allow(clippy::too_many_arguments)]
fn make_session(
    path: &Path,
    agent: &str,
    id: String,
    project: String,
    title: String,
    started: DateTime<Utc>,
    modified: SystemTime,
    now: DateTime<Utc>,
    window_secs: i64,
    preview: String,
) -> Session {
    let last_activity = parser::system_time(modified);
    let updated_at = parser::format_time(last_activity);
    Session {
        id,
        agent: agent.to_owned(),
        project,
        title,
        started_at: parser::format_time(started),
        last_activity: updated_at.clone(),
        updated_at,
        running: now.signed_duration_since(last_activity).num_seconds() < window_secs,
        transcript_path: path.to_string_lossy().into_owned(),
        last_message_preview: preview,
    }
}

fn codex_meta_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get("payload")
        .and_then(|payload| payload.get(key))
        .or_else(|| value.get(key))
        .and_then(Value::as_str)
}

#[derive(Default)]
struct ClaudeFacts {
    cwd: Option<String>,
    session_id: Option<String>,
    started_at: Option<DateTime<Utc>>,
}

fn claude_facts<'a>(lines: impl Iterator<Item = &'a String>) -> ClaudeFacts {
    let mut facts = ClaudeFacts::default();
    for value in lines.filter_map(|line| parser::parse_json(line)) {
        if facts.cwd.is_none() {
            facts.cwd = parser::string_at(&value, &["cwd"]).map(str::to_owned);
        }
        if facts.session_id.is_none() {
            facts.session_id = parser::string_at(&value, &["sessionId"])
                .or_else(|| parser::string_at(&value, &["session_id"]))
                .map(str::to_owned);
        }
        if let Some(time) = parser::parse_time(parser::string_at(&value, &["timestamp"])) {
            facts.started_at = Some(facts.started_at.map(|old| old.min(time)).unwrap_or(time));
        }
    }
    facts
}

fn non_empty(primary: String, fallback: &str) -> String {
    if primary.is_empty() {
        fallback.to_owned()
    } else {
        primary
    }
}

fn file_id(path: &Path, strip_prefix: &str) -> String {
    path.file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .strip_prefix(strip_prefix)
        .unwrap_or_else(|| path.file_stem().and_then(OsStr::to_str).unwrap_or_default())
        .to_owned()
}

fn is_rollout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

fn is_jsonl_file(path: &Path) -> bool {
    path.extension() == Some(OsStr::new("jsonl"))
}

fn has_component(path: &Path, needle: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str() == OsStr::new(needle))
}

struct ProjectResolver {
    home: PathBuf,
    // Memoize cwd -> project root. A single scan resolves thousands of sessions
    // and most share a cwd; each resolution otherwise canonicalizes and walks
    // parents probing ~22 marker files per directory level. Caching by raw cwd
    // collapses that storm of redundant fs::canonicalize + .exists() calls. The
    // scan is single-threaded, so RefCell interior mutability is sufficient.
    cache: RefCell<HashMap<String, Option<String>>>,
}

impl ProjectResolver {
    fn new(home: &Path) -> Self {
        Self {
            home: fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()),
            cache: RefCell::new(HashMap::new()),
        }
    }

    fn project_for_cwd(&self, raw: &str) -> Option<String> {
        if let Some(cached) = self.cache.borrow().get(raw) {
            return cached.clone();
        }
        let resolved = self.resolve_project_for_cwd(raw);
        self.cache
            .borrow_mut()
            .insert(raw.to_owned(), resolved.clone());
        resolved
    }

    fn resolve_project_for_cwd(&self, raw: &str) -> Option<String> {
        let cwd = self.existing_dir(raw)?;
        if self.is_obvious_non_project(&cwd) {
            return None;
        }
        let project = self.project_root_or_cwd(&cwd);
        (!self.is_obvious_non_project(&project)).then(|| project.to_string_lossy().into_owned())
    }

    fn existing_dir(&self, raw: &str) -> Option<PathBuf> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let path = if trimmed == "~" {
            self.home.clone()
        } else if let Some(rest) = trimmed.strip_prefix("~/") {
            self.home.join(rest)
        } else {
            PathBuf::from(trimmed)
        };
        if !path.is_absolute() {
            return None;
        }
        let path = fs::canonicalize(path).ok()?;
        path.is_dir().then_some(path)
    }

    fn project_root_or_cwd(&self, cwd: &Path) -> PathBuf {
        let mut current = cwd;
        loop {
            if current == self.home || current.parent().is_none() {
                return cwd.to_path_buf();
            }
            if has_project_marker(current) {
                return current.to_path_buf();
            }
            let Some(parent) = current.parent() else {
                return cwd.to_path_buf();
            };
            current = parent;
        }
    }

    fn is_obvious_non_project(&self, path: &Path) -> bool {
        if path == self.home || path.parent().is_none() {
            return true;
        }
        let parts = normal_components(path);
        has_adjacent_components(&parts, "agents", "workspaces")
            || has_adjacent_components(&parts, ".claude", "worktrees")
            || has_component_between(&parts, ".odw", "worktrees")
            || has_component_between(&parts, "node_modules", "")
            || has_component_between(&parts, ".git", "")
    }
}

fn has_project_marker(path: &Path) -> bool {
    const MARKERS: &[&str] = &[
        ".git",
        ".hg",
        ".svn",
        "Cargo.toml",
        "package.json",
        "pnpm-workspace.yaml",
        "yarn.lock",
        "bun.lockb",
        "deno.json",
        "deno.jsonc",
        "go.mod",
        "pyproject.toml",
        "requirements.txt",
        "setup.py",
        "poetry.lock",
        "Gemfile",
        "composer.json",
        "mix.exs",
        "pom.xml",
        "build.gradle",
        "settings.gradle",
        "Makefile",
        "CMakeLists.txt",
    ];
    MARKERS.iter().any(|marker| path.join(marker).exists())
}

fn normal_components(path: &Path) -> Vec<&str> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect()
}

fn has_adjacent_components(parts: &[&str], first: &str, second: &str) -> bool {
    parts.windows(2).any(|window| window == [first, second])
}

fn has_component_between(parts: &[&str], first: &str, second: &str) -> bool {
    if second.is_empty() {
        return parts.contains(&first);
    }
    parts
        .iter()
        .position(|part| *part == first)
        .is_some_and(|start| parts[start + 1..].contains(&second))
}
