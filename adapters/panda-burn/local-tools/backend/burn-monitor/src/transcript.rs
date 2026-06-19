mod blocks;
mod parse;
mod source;
mod types;

use crate::model::Counts;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use types::{DEFAULT_LIMIT, MAX_LIMIT, SourceKind, TranscriptSource};
pub use types::{MessageBlock, ShowError, TranscriptMessage, TranscriptResponse};

pub fn default_limit() -> usize {
    DEFAULT_LIMIT
}

pub fn max_limit() -> usize {
    MAX_LIMIT
}

pub fn show_session(
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<TranscriptResponse, ShowError> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| ShowError::new("home_unavailable", "HOME is not set"))?;
    show_session_with_home_page(&home, session_id, agent, cursor, limit, false)
}

pub fn show_session_in_project(
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<TranscriptResponse, ShowError> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| ShowError::new("home_unavailable", "HOME is not set"))?;
    show_session_with_home_project_page(&home, project, session_id, agent, cursor, limit, false)
}

pub fn show_session_with_home(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<TranscriptResponse, ShowError> {
    show_session_with_home_page(home, session_id, agent, cursor, limit, false)
}

pub fn show_session_with_home_page(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<TranscriptResponse, ShowError> {
    show_session_with_home_page_inner(home, session_id, agent, cursor, limit, latest, false)
}

pub(crate) fn show_session_with_configured_home_page(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<TranscriptResponse, ShowError> {
    show_session_with_home_page_inner(home, session_id, agent, cursor, limit, latest, true)
}

fn show_session_with_home_page_inner(
    home: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
    configured: bool,
) -> Result<TranscriptResponse, ShowError> {
    source::validate_agent(agent)?;
    let source = if configured {
        source::find_configured_source(home, session_id, agent)
    } else {
        source::find_source(home, session_id, agent)
    }
    .ok_or_else(|| {
        ShowError::new(
            "session_not_found",
            format!("session not found: {session_id}"),
        )
    })?;
    parse_transcript_file(&source, session_id, cursor, limit.min(MAX_LIMIT), latest)
}

pub fn show_session_with_home_project(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<TranscriptResponse, ShowError> {
    show_session_with_home_project_page(home, project, session_id, agent, cursor, limit, false)
}

pub fn show_session_with_home_project_page(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<TranscriptResponse, ShowError> {
    show_session_with_home_project_page_inner(
        home, project, session_id, agent, cursor, limit, latest, false,
    )
}

pub(crate) fn show_session_with_configured_home_project_page(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<TranscriptResponse, ShowError> {
    show_session_with_home_project_page_inner(
        home, project, session_id, agent, cursor, limit, latest, true,
    )
}

fn show_session_with_home_project_page_inner(
    home: &Path,
    project: &Path,
    session_id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
    configured: bool,
) -> Result<TranscriptResponse, ShowError> {
    source::validate_agent(agent)?;
    // Fast path: claude transcripts are named `<session_id>.jsonl` and live under
    // ~/.claude/projects/<encoded-cwd>/. A direct filesystem lookup avoids the
    // full monitor scan (find_source_from_report -> scan_with_home), which walks
    // every codex/claude session and canonicalizes each cwd — the dominant cost
    // of burn.sessions.show for claude history. Falls back to the report scan
    // when the direct lookup misses, so behavior is unchanged on a miss.
    let source = if configured {
        source::find_configured_claude_source_in_project(home, project, session_id, agent).or_else(
            || source::find_configured_source_from_report(home, session_id, agent, Some(project)),
        )
    } else {
        source::find_claude_source_in_project(home, project, session_id, agent)
            .or_else(|| source::find_source_from_report(home, session_id, agent, Some(project)))
    }
    .ok_or_else(|| {
        ShowError::new(
            "session_not_found",
            format!("session not found in project: {session_id}"),
        )
    })?;
    parse_transcript_file(&source, session_id, cursor, limit.min(MAX_LIMIT), latest)
}

fn parse_transcript_file(
    source: &TranscriptSource,
    session_id: &str,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<TranscriptResponse, ShowError> {
    let file = File::open(&source.path).map_err(|err| {
        ShowError::new(
            "session_unreadable",
            format!("cannot read {}: {err}", source.path.display()),
        )
    })?;
    let mut counts = Counts::default();
    let mut indexed = Vec::new();
    let mut next_cursor = None;
    let mut seen_messages = HashSet::new();

    for (line_no, line) in BufReader::new(file).lines().enumerate() {
        if !latest && line_no < cursor {
            continue;
        }
        if !latest && indexed.len() >= limit {
            next_cursor = Some(line_no);
            break;
        }

        let line = match line {
            Ok(line) => line,
            Err(_) => {
                counts.scanned += 1;
                counts.skipped += 1;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        counts.scanned += 1;
        let value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                counts.skipped += 1;
                continue;
            }
        };

        let parsed = match source.kind {
            SourceKind::Codex => parse::codex_line(&value, session_id, line_no),
            SourceKind::Claude => parse::claude_line(&value, session_id, line_no),
            SourceKind::PandacodeLog => parse::pandacode_log_line(&value, session_id, line_no),
        };
        if let Some(message) = parsed {
            if parse::is_bootstrap_context_message(&message) {
                continue;
            }
            let signature = parse::message_signature(&message);
            if seen_messages.insert(signature) {
                counts.valid += 1;
                indexed.push((line_no, message));
            }
        }
    }

    let total_messages = indexed.len();
    let capped_limit = limit.clamp(1, MAX_LIMIT);
    let (page_start, page_end, page_cursor, prev_cursor, end_of_history, order) = if latest {
        let start = total_messages.saturating_sub(capped_limit);
        let end = total_messages;
        let cursor = indexed.get(start).map(|(line_no, _)| *line_no).unwrap_or(0);
        let prev = if start > 0 {
            Some(indexed[start.saturating_sub(capped_limit)].0)
        } else {
            None
        };
        (start, end, cursor, prev, start == 0, "latest")
    } else {
        let end = indexed.len();
        let prev = (cursor > 0).then_some(cursor.saturating_sub(capped_limit));
        (0, end, cursor, prev, cursor == 0, "cursor")
    };
    let messages = indexed[page_start..page_end]
        .iter()
        .map(|(_, message)| message.clone())
        .collect();

    Ok(TranscriptResponse {
        ok: true,
        session_id: session_id.to_owned(),
        agent: source.kind.agent().to_owned(),
        project: source.project.clone(),
        transcript_path: source.path.to_string_lossy().into_owned(),
        cursor: page_cursor,
        messages,
        next_cursor,
        prev_cursor,
        end_of_history,
        total_messages,
        order,
        counts,
    })
}
