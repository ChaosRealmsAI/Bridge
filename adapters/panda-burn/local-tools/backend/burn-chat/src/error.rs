use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ChatError {
    pub ok: bool,
    pub error: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause_code: Option<String>,
}

pub fn error_response(error: impl std::fmt::Display) -> ChatError {
    let display_message = error.to_string();
    let chain_message = format!("{error:#}");
    let classify_text = if chain_message == display_message {
        display_message.clone()
    } else {
        format!("{display_message}\n{chain_message}")
    };
    let code = classify_chat_error(&classify_text).to_string();
    let message = chain_message;
    ChatError {
        ok: false,
        error: code.clone(),
        code,
        message,
        cause_code: None,
    }
}

pub(crate) fn classify_chat_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("unsupported agent")
        || (lower.contains("invalid value") && lower.contains("--agent"))
    {
        return "invalid_chat_agent";
    }
    if (lower.contains("unsupported agent source"))
        || (lower.contains("invalid value") && lower.contains("--source"))
    {
        return "invalid_agent_source";
    }
    if lower.contains("project does not exist")
        || lower.contains("project is not a directory")
        || lower.contains("cannot canonicalize project")
    {
        return "project_unavailable";
    }
    if lower.contains("only supported for claude source turns")
        || lower.contains("unsupported sdkoptions key")
        || lower.contains("is controlled by burn and cannot be supplied")
        || lower.contains("is controlled by burn session routing")
        || lower.contains("turn_id is required")
        || lower.contains("session_id is required")
        || lower.contains("codex options.")
    {
        return "invalid_source_options";
    }
    if lower.contains("resume_cold_unavailable") {
        return "resume_cold_unavailable";
    }
    if lower.contains("resume_not_found")
        || lower.contains("cannot resume")
        || lower.contains("no such session")
        || lower.contains("no rollout found")
        || lower.contains("rollout not found")
        || lower.contains("session not found")
    {
        return "resume_not_found";
    }
    if lower.contains("empty reply")
        || lower.contains("without a final agent message")
        || lower.contains("no final assistant reply")
        || lower.contains("completed but no final")
    {
        return "empty_reply";
    }
    if lower.contains("not logged in")
        || lower.contains("login")
        || lower.contains("authentication")
        || lower.contains("unauthorized")
        || lower.contains("selected model")
        || lower.contains("may not exist or you may not have access")
    {
        return "agent_not_logged_in";
    }
    if lower.contains("failed to start codex")
        || lower.contains("failed to start claude")
        || lower.contains("claude agent sdk runner")
        || lower.contains("err_module_not_found")
        || lower.contains("cannot find package")
        || lower.contains("tmux start failed")
        || lower.contains("claude code did not become input-ready")
        || lower.contains("agent unavailable")
    {
        return "agent_unavailable";
    }
    if lower.contains("chat_session_busy") {
        return "chat_session_busy";
    }
    if lower.contains("timeout") {
        return "chat_timeout";
    }
    "burn_chat_failed"
}
