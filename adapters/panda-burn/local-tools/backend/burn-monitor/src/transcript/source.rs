use super::blocks::string_path;
use super::types::{ShowError, SourceKind, TranscriptSource};
use crate::parser;
use serde_json::Value;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub(super) fn validate_agent(agent: Option<&str>) -> Result<(), ShowError> {
    match agent {
        Some("codex" | "claude") | None => Ok(()),
        Some(other) => Err(ShowError::new(
            "invalid_agent",
            format!("unsupported agent: {other}"),
        )),
    }
}

pub(super) fn find_source(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
) -> Option<TranscriptSource> {
    find_source_inner(home, session_id, agent, false)
}

pub(super) fn find_configured_source(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
) -> Option<TranscriptSource> {
    find_source_inner(home, session_id, agent, true)
}

fn find_source_inner(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    configured: bool,
) -> Option<TranscriptSource> {
    find_source_from_report_inner(home, session_id, agent, None, configured)
        .or_else(|| find_codex_source(home, session_id, agent, configured))
        .or_else(|| find_claude_source(home, session_id, agent, configured))
        .or_else(|| find_pandacode_source(home, session_id, agent))
}

pub(super) fn find_source_from_report(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    project: Option<&Path>,
) -> Option<TranscriptSource> {
    find_source_from_report_inner(home, session_id, agent, project, false)
}

pub(super) fn find_configured_source_from_report(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    project: Option<&Path>,
) -> Option<TranscriptSource> {
    find_source_from_report_inner(home, session_id, agent, project, true)
}

fn find_source_from_report_inner(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    project: Option<&Path>,
    configured: bool,
) -> Option<TranscriptSource> {
    let project = project.map(normalized_path);
    let report = if configured {
        crate::scan_configured_with_home(home)
    } else {
        crate::scan_with_home(home)
    };
    report
        .by_project
        .iter()
        .flat_map(|project| project.sessions.iter())
        .filter(|session| session.id == session_id)
        .filter(|session| agent.map(|wanted| wanted == session.agent).unwrap_or(true))
        .filter(|session| {
            project
                .as_ref()
                .map(|root| session_belongs_to_project(session, root))
                .unwrap_or(true)
        })
        .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
        .and_then(|session| {
            let kind = match session.agent.as_str() {
                "codex" => SourceKind::Codex,
                "claude" => SourceKind::Claude,
                _ => return None,
            };
            Some(TranscriptSource {
                kind,
                path: PathBuf::from(&session.transcript_path),
                project: Some(session.project.clone()),
            })
        })
}

/// Direct claude transcript lookup by `<session_id>.jsonl`, scoped to a project.
///
/// Claude stores each session at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`,
/// where `<encoded-cwd>` is the absolute cwd with path separators/dots flattened
/// to `-`. We first probe the exact encoded directory (O(1) stat); if that misses
/// (encoding edge cases), we fall back to a *shallow* pass over the project dirs
/// checking only for a `<id>.jsonl` filename. Neither path parses JSON,
/// canonicalizes, or walks recursively, so it is far cheaper than the full scan.
pub(super) fn find_claude_source_in_project(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
) -> Option<TranscriptSource> {
    find_claude_source_in_project_inner(home, project, session_id, agent, false)
}

pub(super) fn find_configured_claude_source_in_project(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
) -> Option<TranscriptSource> {
    find_claude_source_in_project_inner(home, project, session_id, agent, true)
}

fn find_claude_source_in_project_inner(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
    configured: bool,
) -> Option<TranscriptSource> {
    if !agent_allows(agent, "claude") {
        return None;
    }
    if session_id.is_empty() || session_id.contains(['/', '\\']) {
        return None;
    }
    let file_name = format!("{session_id}.jsonl");

    for projects_root in claude_project_roots(home, configured) {
        if !projects_root.is_dir() {
            continue;
        }

        // 1) Exact encoded-cwd directory.
        let project_real = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        for candidate in [project, project_real.as_path()] {
            let encoded = encode_claude_project_dir(candidate);
            if encoded.is_empty() {
                continue;
            }
            let direct = projects_root.join(&encoded).join(&file_name);
            if direct.is_file() {
                return Some(TranscriptSource {
                    kind: SourceKind::Claude,
                    path: direct,
                    project: Some(candidate.to_string_lossy().into_owned()),
                });
            }
        }

        // 2) Shallow fallback: one level of project dirs, filename match only.
        let Ok(entries) = fs::read_dir(&projects_root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let candidate = entry.path().join(&file_name);
            if candidate.is_file() {
                return Some(TranscriptSource {
                    kind: SourceKind::Claude,
                    path: candidate,
                    project: Some(project.to_string_lossy().into_owned()),
                });
            }
        }
    }
    None
}

/// Encode an absolute cwd the way Claude Code names its project directories:
/// every character that is not alphanumeric becomes `-`.
fn encode_claude_project_dir(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if raw.is_empty() {
        return String::new();
    }
    raw.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn find_codex_source(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    configured: bool,
) -> Option<TranscriptSource> {
    if !agent_allows(agent, "codex") {
        return None;
    }
    for root in codex_roots(home, configured) {
        for path in jsonl_files(&root, is_rollout_file) {
            if codex_file_matches(&path, session_id) {
                return Some(TranscriptSource {
                    kind: SourceKind::Codex,
                    path,
                    project: None,
                });
            }
        }
    }
    None
}

fn find_claude_source(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    configured: bool,
) -> Option<TranscriptSource> {
    if !agent_allows(agent, "claude") {
        return None;
    }
    for root in claude_project_roots(home, configured) {
        for path in jsonl_files(&root, is_jsonl_file) {
            if file_stem(&path) == Some(session_id) || claude_file_matches(&path, session_id) {
                return Some(TranscriptSource {
                    kind: SourceKind::Claude,
                    path,
                    project: None,
                });
            }
        }
    }
    None
}

fn find_pandacode_source(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
) -> Option<TranscriptSource> {
    if !agent_allows(agent, "codex") {
        return None;
    }
    for root in pandacode_roots(home) {
        if let Some(source) = find_pandacode_metadata_source(&root, session_id) {
            return Some(source);
        }
        if let Some(source) = find_pandacode_log_source(&root, session_id) {
            return Some(source);
        }
    }
    None
}

fn find_pandacode_metadata_source(root: &Path, session_id: &str) -> Option<TranscriptSource> {
    for path in jsonl_files(root, |path| path.extension() == Some(OsStr::new("json"))) {
        let Some(value) = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            continue;
        };
        let matches = string_path(&value, &["thread_id"]) == Some(session_id)
            || string_path(&value, &["session"]) == Some(session_id)
            || string_path(&value, &["artifacts", "thread_id"]) == Some(session_id);
        if !matches {
            continue;
        }
        if let Some(thread_path) = string_path(&value, &["thread_path"])
            .or_else(|| string_path(&value, &["artifacts", "thread_path"]))
            .map(PathBuf::from)
            .filter(|path| path.exists())
        {
            return Some(TranscriptSource {
                kind: SourceKind::Codex,
                path: thread_path,
                project: None,
            });
        }
        if let Some(log_path) = string_path(&value, &["artifacts", "log_path"])
            .map(PathBuf::from)
            .filter(|path| path.exists())
        {
            return Some(TranscriptSource {
                kind: SourceKind::PandacodeLog,
                path: log_path,
                project: None,
            });
        }
    }
    None
}

fn find_pandacode_log_source(root: &Path, session_id: &str) -> Option<TranscriptSource> {
    for path in jsonl_files(root, is_jsonl_file) {
        let Ok(lines) = parser::read_head_lines(&path) else {
            continue;
        };
        if lines.iter().any(|line| line.contains(session_id)) {
            return Some(TranscriptSource {
                kind: SourceKind::PandacodeLog,
                path,
                project: None,
            });
        }
    }
    None
}

fn codex_file_matches(path: &Path, session_id: &str) -> bool {
    file_stem(path)
        .and_then(|stem| stem.strip_prefix("rollout-"))
        .map(|stem| stem == session_id || stem.ends_with(session_id))
        .unwrap_or(false)
        || parser::read_head_lines(path)
            .ok()
            .and_then(|lines| lines.first().cloned())
            .and_then(|line| serde_json::from_str::<Value>(&line).ok())
            .and_then(|value| {
                string_path(&value, &["payload", "id"])
                    .or_else(|| string_path(&value, &["id"]))
                    .map(str::to_owned)
            })
            .map(|id| id == session_id)
            .unwrap_or(false)
}

fn claude_file_matches(path: &Path, session_id: &str) -> bool {
    parser::read_head_lines(path)
        .ok()
        .into_iter()
        .flatten()
        .chain(parser::read_tail_lines(path).ok().into_iter().flatten())
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .any(|value| {
            string_path(&value, &["sessionId"]) == Some(session_id)
                || string_path(&value, &["session_id"]) == Some(session_id)
        })
}

fn agent_allows(agent: Option<&str>, candidate: &str) -> bool {
    agent.map(|wanted| wanted == candidate).unwrap_or(true)
}

fn codex_roots(home: &Path, configured: bool) -> Vec<PathBuf> {
    let mut roots = if configured {
        crate::scanner::configured_codex_history_roots_from_home(home)
    } else {
        crate::scanner::default_codex_history_roots_from_home(home)
    };
    roots.push(home.join(".pandacode").join("codex-home"));
    roots
}

fn claude_project_roots(home: &Path, configured: bool) -> Vec<PathBuf> {
    if configured {
        crate::scanner::configured_claude_project_roots_from_home(home)
    } else {
        crate::scanner::default_claude_project_roots_from_home(home)
    }
}

fn pandacode_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![home.join(".pandacode")];
    if let Ok(cwd) = std::env::current_dir() {
        let local = cwd.join(".pandacode");
        if local.exists() {
            roots.push(local);
        }
    }
    roots
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

fn is_rollout_file(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

fn is_jsonl_file(path: &Path) -> bool {
    path.extension() == Some(OsStr::new("jsonl"))
}

fn file_stem(path: &Path) -> Option<&str> {
    path.file_stem().and_then(OsStr::to_str)
}

fn normalized_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn session_belongs_to_project(session: &crate::Session, root: &Path) -> bool {
    let project = normalized_path(Path::new(&session.project));
    let transcript = normalized_path(Path::new(&session.transcript_path));
    project == root || project.starts_with(root) || transcript.starts_with(root)
}
