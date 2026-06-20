mod model;
mod parser;
mod scanner;
mod transcript;

use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use std::path::{Path, PathBuf};

pub use model::{
    Counts, ProjectReport, ProjectSummary, Report, ScanCacheDiagnostics, ScanDiagnostics,
    ScanLimits, Session, SessionDetail, SessionMessage, SessionMessageBlock, SessionSummary,
    Totals,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScanScope {
    AllHistory,
    Configured,
}

impl ScanScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AllHistory => "all_history",
            Self::Configured => "configured",
        }
    }
}

pub fn scan() -> Report {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Report::empty(current_time());
    };
    scan_with_home(&home)
}

pub fn scan_with_scope(scope: ScanScope) -> Report {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Report::empty(current_time());
    };
    scan_with_home_scope(&home, scope)
}

pub fn scan_with_home_scope(home: &Path, scope: ScanScope) -> Report {
    scan_with_home_scope_at(home, scope, Utc::now(), scanner::running_window_secs())
}

pub fn scan_with_home_scope_at(
    home: &Path,
    scope: ScanScope,
    now: DateTime<Utc>,
    window_secs: i64,
) -> Report {
    match scope {
        ScanScope::AllHistory => scan_with_home_at(home, now, window_secs),
        ScanScope::Configured => scan_configured_with_home_at(home, now, window_secs),
    }
}

pub fn scan_with_home(home: &Path) -> Report {
    scan_with_home_at(home, Utc::now(), scanner::running_window_secs())
}

pub fn scan_with_home_at(home: &Path, now: DateTime<Utc>, window_secs: i64) -> Report {
    scanner::scan_home(home, now, window_secs)
}

pub fn scan_configured_with_home(home: &Path) -> Report {
    scan_configured_with_home_at(home, Utc::now(), scanner::running_window_secs())
}

pub fn scan_configured_with_home_at(home: &Path, now: DateTime<Utc>, window_secs: i64) -> Report {
    scanner::scan_configured_home(home, now, window_secs)
}

pub fn source_roots() -> Vec<PathBuf> {
    source_roots_for_scope(ScanScope::AllHistory)
}

pub fn source_roots_for_scope(scope: ScanScope) -> Vec<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| match scope {
            ScanScope::AllHistory => scanner::source_roots_from_home(&home),
            ScanScope::Configured => scanner::configured_source_roots_from_home(&home),
        })
        .unwrap_or_default()
}

pub fn default_limit() -> usize {
    transcript::default_limit()
}

pub fn show_session(id: &str, cursor: usize, limit: usize) -> Result<SessionDetail> {
    show_session_for_agent(id, None, cursor, limit)
}

pub fn show_session_in_project(
    project: &Path,
    id: &str,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_in_project_for_agent(project, id, None, cursor, limit)
}

pub fn show_session_with_home(
    home: &Path,
    id: &str,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_with_home_for_agent(home, id, None, cursor, limit)
}

pub fn show_session_with_home_project(
    home: &Path,
    project: &Path,
    id: &str,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_with_home_project_for_agent(home, project, id, None, cursor, limit)
}

pub fn show_session_for_agent(
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_for_agent_page(id, agent, cursor, limit, false)
}

pub fn show_session_for_agent_page(
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<SessionDetail> {
    let response = transcript::show_session_with_configured_home_page(
        &std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("HOME is not set"))?,
        id,
        agent,
        cursor,
        limit,
        latest,
    )
    .map_err(|error| anyhow!(error))?;
    Ok(session_detail_from_transcript(response))
}

pub fn show_session_in_project_for_agent(
    project: &Path,
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_in_project_for_agent_page(project, id, agent, cursor, limit, false)
}

pub fn show_session_in_project_for_agent_page(
    project: &Path,
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<SessionDetail> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is not set"))?;
    let response = transcript::show_session_with_configured_home_project_page(
        &home, project, id, agent, cursor, limit, latest,
    )
    .map_err(|error| anyhow!(error))?;
    Ok(session_detail_from_transcript(response))
}

pub fn show_session_with_home_for_agent(
    home: &Path,
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_with_home_for_agent_page(home, id, agent, cursor, limit, false)
}

pub fn show_session_with_home_for_agent_page(
    home: &Path,
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<SessionDetail> {
    let response = transcript::show_session_with_home_page(home, id, agent, cursor, limit, latest)
        .map_err(|error| anyhow!(error))?;
    Ok(session_detail_from_transcript(response))
}

pub fn show_session_with_home_project_for_agent(
    home: &Path,
    project: &Path,
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Result<SessionDetail> {
    show_session_with_home_project_for_agent_page(home, project, id, agent, cursor, limit, false)
}

pub fn show_session_with_home_project_for_agent_page(
    home: &Path,
    project: &Path,
    id: &str,
    agent: Option<&str>,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<SessionDetail> {
    let response = transcript::show_session_with_home_project_page(
        home, project, id, agent, cursor, limit, latest,
    )
    .map_err(|error| anyhow!(error))?;
    Ok(session_detail_from_transcript(response))
}

fn current_time() -> String {
    parser::format_time(Utc::now())
}

fn session_detail_from_transcript(response: transcript::TranscriptResponse) -> SessionDetail {
    let counts = response.counts;
    SessionDetail {
        id: response.session_id,
        agent: response.agent,
        project: response.project.unwrap_or_default(),
        transcript_path: response.transcript_path,
        cursor: response.cursor,
        next_cursor: response.next_cursor,
        prev_cursor: response.prev_cursor,
        end_of_history: response.end_of_history,
        total_messages: response.total_messages,
        order: response.order,
        scanned: counts.scanned,
        valid: counts.valid,
        skipped: counts.skipped,
        messages: response
            .messages
            .into_iter()
            .map(session_message_from_transcript)
            .collect(),
    }
}

fn session_message_from_transcript(message: transcript::TranscriptMessage) -> SessionMessage {
    SessionMessage {
        id: message.id,
        role: message.role,
        ts: message.ts.unwrap_or_default(),
        blocks: message
            .blocks
            .into_iter()
            .map(session_block_from_transcript)
            .collect(),
    }
}

fn session_block_from_transcript(block: transcript::MessageBlock) -> SessionMessageBlock {
    let transcript::MessageBlock {
        block_type,
        text,
        html,
        name,
        input,
        output,
        ok,
    } = block;
    SessionMessageBlock {
        kind: block_type,
        text: text
            .or(html)
            .or_else(|| name.map(|name| format!("tool_call {name}")))
            .or_else(|| input.map(|value| value.to_string()))
            .or_else(|| output.map(|value| value.to_string()))
            .or_else(|| ok.map(|value| value.to_string()))
            .unwrap_or_default(),
    }
}
