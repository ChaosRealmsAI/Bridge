use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::agent_session::{
    AgentSessionListSuccess, AgentSessionMessage, AgentSessionMessageBlock,
    AgentSessionShowSuccess, AgentSessionSummary, AGENT_SESSION_INTERFACE_VERSION,
};
use crate::agent_session_parse::{
    codex_thread_messages, codex_thread_summary, generic_message_from_value,
    generic_session_summary, page_session_messages_with_mode, provider_metadata_with_history,
    session_value_belongs_to_project, trim_preview,
};
use crate::claude_agent_sdk::{list_claude_agent_sdk_sessions, read_claude_agent_sdk_session};
use crate::codex_app_server::{list_codex_app_server_threads, read_codex_app_server_thread};
use crate::Agent;

pub(crate) fn list_codex_sessions_with_fallback(
    project: &Path,
    limit: usize,
) -> Result<AgentSessionListSuccess> {
    match list_codex_app_server_threads(project, limit) {
        Ok(result) => {
            let provider =
                provider_metadata_with_history(Agent::Codex, "codex_app_server_thread_list");
            let sessions = result
                .get("data")
                .and_then(Value::as_array)
                .map(|threads| {
                    threads
                        .iter()
                        .filter(|thread| session_value_belongs_to_project(thread, project))
                        .take(limit)
                        .map(|thread| codex_thread_summary(thread, project, provider.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !sessions.is_empty() {
                return Ok(AgentSessionListSuccess {
                    ok: true,
                    interface_version: AGENT_SESSION_INTERFACE_VERSION,
                    source: Agent::Codex,
                    project: project.to_string_lossy().to_string(),
                    sessions,
                    provider,
                });
            }
            let fallback_provider =
                provider_metadata_with_history(Agent::Codex, "burn_monitor_transcript_fallback");
            let sessions =
                monitor_sessions(Agent::Codex, project, limit, fallback_provider.clone())?;
            Ok(AgentSessionListSuccess {
                ok: true,
                interface_version: AGENT_SESSION_INTERFACE_VERSION,
                source: Agent::Codex,
                project: project.to_string_lossy().to_string(),
                sessions,
                provider: fallback_provider,
            })
        }
        Err(_) => {
            let provider =
                provider_metadata_with_history(Agent::Codex, "burn_monitor_transcript_fallback");
            let sessions = monitor_sessions(Agent::Codex, project, limit, provider.clone())?;
            Ok(AgentSessionListSuccess {
                ok: true,
                interface_version: AGENT_SESSION_INTERFACE_VERSION,
                source: Agent::Codex,
                project: project.to_string_lossy().to_string(),
                sessions,
                provider,
            })
        }
    }
}

pub(crate) fn show_codex_session_with_fallback(
    project: &Path,
    session_id: &str,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<AgentSessionShowSuccess> {
    match read_codex_app_server_thread(project, session_id) {
        Ok(result) => {
            let Some(success) =
                show_from_codex_app_server_result(project, cursor, limit, latest, result)?
            else {
                return show_from_monitor(Agent::Codex, project, session_id, cursor, limit, latest);
            };
            if success.messages.is_empty() {
                return show_from_monitor(Agent::Codex, project, session_id, cursor, limit, latest)
                    .or(Ok(success));
            }
            Ok(success)
        }
        Err(app_error) => {
            show_from_monitor(Agent::Codex, project, session_id, cursor, limit, latest).map_err(
                |fallback_error| {
                    app_error.context(format!("monitor fallback failed: {fallback_error:#}"))
                },
            )
        }
    }
}

pub(crate) fn list_claude_sessions_with_fallback(
    project: &Path,
    limit: usize,
) -> Result<AgentSessionListSuccess> {
    match list_claude_agent_sdk_sessions(project, limit) {
        Ok(result) => list_from_sdk_result(project, limit, result),
        Err(sdk_error) => {
            let provider =
                provider_metadata_with_history(Agent::Claude, "burn_monitor_transcript_fallback");
            let sessions = monitor_sessions(Agent::Claude, project, limit, provider.clone())?;
            if sessions.is_empty()
                && !sdk_error
                    .to_string()
                    .contains("session list is unavailable")
            {
                return Err(sdk_error);
            }
            Ok(AgentSessionListSuccess {
                ok: true,
                interface_version: AGENT_SESSION_INTERFACE_VERSION,
                source: Agent::Claude,
                project: project.to_string_lossy().to_string(),
                sessions,
                provider,
            })
        }
    }
}

pub(crate) fn show_claude_session_with_fallback(
    project: &Path,
    session_id: &str,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<AgentSessionShowSuccess> {
    // Prefer the Claude Agent SDK reader when it returns real history. Old Claude
    // sessions, however, come back from the SDK's getSessionMessages with no
    // messages (and only a minimal `{ id }` session that fails the project
    // belongs-check). In both of those cases — SDK error, belongs-check failure,
    // or an empty message set — fall back to the monitor transcript JSONL
    // (~/.claude/projects/<encoded>/<session>.jsonl) so session.show still
    // returns the true history instead of bailing with resume_not_found.
    match read_claude_agent_sdk_session(project, session_id, cursor, limit, latest) {
        Ok(result) => match show_from_sdk_result(project, cursor, limit, latest, result)? {
            Some(success) => Ok(success),
            None => show_from_monitor(Agent::Claude, project, session_id, cursor, limit, latest),
        },
        Err(_) => show_from_monitor(Agent::Claude, project, session_id, cursor, limit, latest),
    }
}

fn list_from_sdk_result(
    project: &Path,
    limit: usize,
    result: Value,
) -> Result<AgentSessionListSuccess> {
    let provider = provider_metadata_with_history(Agent::Claude, "claude_agent_sdk_sessions_list");
    let sessions = result
        .get("sessions")
        .or_else(|| result.get("data"))
        .and_then(Value::as_array)
        .map(|sessions| {
            sessions
                .iter()
                .filter(|session| session_value_belongs_to_project(session, project))
                .take(limit)
                .map(|session| {
                    generic_session_summary(Agent::Claude, project, session, provider.clone())
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(AgentSessionListSuccess {
        ok: true,
        interface_version: AGENT_SESSION_INTERFACE_VERSION,
        source: Agent::Claude,
        project: project.to_string_lossy().to_string(),
        sessions,
        provider,
    })
}

fn show_from_codex_app_server_result(
    project: &Path,
    cursor: usize,
    limit: usize,
    latest: bool,
    result: Value,
) -> Result<Option<AgentSessionShowSuccess>> {
    let provider = provider_metadata_with_history(Agent::Codex, "codex_app_server_thread_read");
    let thread = result.get("thread").unwrap_or(&result);
    if !session_value_belongs_to_project(thread, project) {
        return Ok(None);
    }
    let messages = codex_thread_messages(thread);
    let page = page_session_messages_with_mode(messages, cursor, limit, latest);
    Ok(Some(AgentSessionShowSuccess {
        ok: true,
        interface_version: AGENT_SESSION_INTERFACE_VERSION,
        source: Agent::Codex,
        project: project.to_string_lossy().to_string(),
        summary: codex_thread_summary(thread, project, provider.clone()),
        cursor: page.cursor,
        next_cursor: page.next_cursor,
        prev_cursor: page.prev_cursor,
        end_of_history: page.end_of_history,
        total_messages: page.total_messages,
        order: page.order,
        scanned: page.scanned,
        valid: page.valid,
        skipped: 0,
        messages: page.messages,
        provider,
    }))
}

/// Build a `session.show` success from the Claude Agent SDK reader result.
///
/// Returns `Ok(None)` (instead of erroring) when the SDK result is not a usable
/// answer for this project — either the session metadata fails the project
/// belongs-check (old sessions come back as a bare `{ id }`) or the SDK produced
/// no messages. The caller treats `None` as "fall back to the monitor
/// transcript". A real `Err` (parse/IO) still propagates as a fallback signal
/// via the caller's match arm.
fn show_from_sdk_result(
    project: &Path,
    cursor: usize,
    limit: usize,
    latest: bool,
    result: Value,
) -> Result<Option<AgentSessionShowSuccess>> {
    let provider =
        provider_metadata_with_history(Agent::Claude, "claude_agent_sdk_session_messages");
    let session = result.get("session").unwrap_or(&result);
    if !session_value_belongs_to_project(session, project) {
        // SDK gave us a session that does not clearly belong to this project
        // (typically the bare `{ id }` object the SDK returns for old sessions). Defer to
        // the monitor transcript rather than bailing with resume_not_found.
        return Ok(None);
    }
    let summary = generic_session_summary(Agent::Claude, project, session, provider.clone());
    let messages = result
        .get("messages")
        .or_else(|| result.get("data"))
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .enumerate()
                .filter_map(|(idx, value)| generic_message_from_value(idx, value))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if messages.is_empty() {
        // SDK getSessionMessages returned no history for this (old) session.
        // Fall back to the monitor transcript reader.
        return Ok(None);
    }
    let provider_next_cursor = result
        .get("next_cursor")
        .or_else(|| result.get("nextCursor"))
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    let page = if let Some(provider_next_cursor) = provider_next_cursor.filter(|_| !latest) {
        let count = messages.len();
        crate::agent_session_parse::SessionMessagePage {
            messages,
            cursor,
            next_cursor: Some(provider_next_cursor),
            prev_cursor: (cursor > 0).then_some(cursor.saturating_sub(limit.clamp(1, 200))),
            scanned: count,
            valid: count,
            total_messages: count,
            end_of_history: cursor == 0,
            order: "cursor",
        }
    } else {
        page_session_messages_with_mode(messages, cursor, limit, latest)
    };
    Ok(Some(AgentSessionShowSuccess {
        ok: true,
        interface_version: AGENT_SESSION_INTERFACE_VERSION,
        source: Agent::Claude,
        project: project.to_string_lossy().to_string(),
        summary,
        cursor: page.cursor,
        next_cursor: page.next_cursor,
        prev_cursor: page.prev_cursor,
        end_of_history: page.end_of_history,
        total_messages: page.total_messages,
        order: page.order,
        scanned: page.scanned,
        valid: page.valid,
        skipped: 0,
        messages: page.messages,
        provider,
    }))
}

fn show_from_monitor(
    source: Agent,
    project: &Path,
    session_id: &str,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<AgentSessionShowSuccess> {
    let provider = provider_metadata_with_history(source, "burn_monitor_transcript_fallback");
    let detail = burn_monitor::show_session_in_project_for_agent_page(
        project,
        session_id,
        Some(source.as_str()),
        cursor,
        limit,
        latest,
    )?;
    let summary = AgentSessionSummary {
        id: detail.id.clone(),
        source,
        project: detail.project.clone(),
        title: detail
            .messages
            .first()
            .and_then(|message| message.blocks.first())
            .map(|block| trim_preview(&block.text, 80))
            .unwrap_or_else(|| detail.id.clone()),
        started_at: String::new(),
        last_activity: String::new(),
        running: false,
        status: "history".to_string(),
        transcript_path: Some(detail.transcript_path.clone()),
        last_message_preview: detail
            .messages
            .last()
            .and_then(|message| message.blocks.first())
            .map(|block| trim_preview(&block.text, 120))
            .unwrap_or_default(),
        provider: provider.clone(),
    };
    Ok(AgentSessionShowSuccess {
        ok: true,
        interface_version: AGENT_SESSION_INTERFACE_VERSION,
        source,
        project: project.to_string_lossy().to_string(),
        summary,
        cursor: detail.cursor,
        next_cursor: detail.next_cursor,
        prev_cursor: detail.prev_cursor,
        end_of_history: detail.end_of_history,
        total_messages: detail.total_messages,
        order: detail.order,
        scanned: detail.scanned,
        valid: detail.valid,
        skipped: detail.skipped,
        messages: detail.messages.into_iter().map(monitor_message).collect(),
        provider,
    })
}

fn monitor_sessions(
    source: Agent,
    project: &Path,
    limit: usize,
    provider: Value,
) -> Result<Vec<AgentSessionSummary>> {
    let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let project_text = project.to_string_lossy().to_string();
    let source_name = source.as_str();
    let sessions = burn_monitor::scan_with_scope(burn_monitor::ScanScope::Configured)
        .by_project
        .into_iter()
        .flat_map(|project| project.sessions.into_iter())
        .filter(|session| session.agent == source_name)
        .filter(|session| {
            session.project == project_text
                || PathBuf::from(&session.project).starts_with(&project)
                || PathBuf::from(&session.transcript_path).starts_with(&project)
        })
        .take(limit)
        .map(|session| AgentSessionSummary {
            id: session.id,
            source,
            project: session.project,
            title: session.title,
            started_at: session.started_at,
            last_activity: session.last_activity,
            running: session.running,
            status: if session.running {
                "running"
            } else {
                "history"
            }
            .to_string(),
            transcript_path: Some(session.transcript_path),
            last_message_preview: session.last_message_preview,
            provider: provider.clone(),
        })
        .collect();
    Ok(sessions)
}

fn monitor_message(message: burn_monitor::SessionMessage) -> AgentSessionMessage {
    AgentSessionMessage {
        id: message.id,
        role: message.role,
        ts: message.ts,
        blocks: message
            .blocks
            .into_iter()
            .map(|block| AgentSessionMessageBlock {
                kind: block.kind,
                text: block.text,
            })
            .collect(),
    }
}
