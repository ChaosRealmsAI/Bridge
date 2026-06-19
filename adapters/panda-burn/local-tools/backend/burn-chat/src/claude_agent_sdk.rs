use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::drivers::DriverRun;
use crate::json_text::{find_text_by_key, tail_text};
use crate::{
    compact_json, find_session_id, find_transcript_path, get_path, now_millis, text_from_value,
    Agent, ChatMode, ChatRequest, ParsedAgentOutput, DEFAULT_CLAUDE_TIMEOUT_MS,
};

struct ClaudeAgentSdkOutput {
    parsed: ParsedAgentOutput,
    events: Vec<Value>,
}

struct ClaudeAgentSdkProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Result<Value, String>>,
    stdout_handle: Option<thread::JoinHandle<()>>,
    stderr_handle: Option<thread::JoinHandle<String>>,
}

impl ClaudeAgentSdkProcess {
    fn spawn(project: &Path) -> Result<Self> {
        let node_bin =
            std::env::var("BURN_CLAUDE_AGENT_SDK_NODE").unwrap_or_else(|_| "node".to_string());
        let runner = claude_agent_sdk_runner_path()?;
        let mut command = Command::new(&node_bin);
        command
            .arg(&runner)
            .current_dir(project)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().with_context(|| {
            format!(
                "failed to start Claude Agent SDK runner {} with {node_bin}",
                runner.display()
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Claude Agent SDK runner stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Claude Agent SDK runner stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Claude Agent SDK runner stderr unavailable"))?;

        let (tx, rx) = mpsc::channel();
        let stdout_handle = thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(err) => {
                        let _ = tx.send(Err(format!("read Claude Agent SDK stdout: {err}")));
                        break;
                    }
                };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let parsed = serde_json::from_str::<Value>(line).map_err(|err| {
                    format!(
                        "Claude Agent SDK runner emitted invalid JSONL: {err}; line tail: {}",
                        tail_text(line, 1200)
                    )
                });
                if tx.send(parsed).is_err() {
                    break;
                }
            }
        });
        let stderr_handle = thread::spawn(move || {
            let mut stderr_text = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut stderr_text);
            stderr_text
        });

        Ok(Self {
            child,
            stdin: Some(stdin),
            rx,
            stdout_handle: Some(stdout_handle),
            stderr_handle: Some(stderr_handle),
        })
    }

    fn send_request(&mut self, value: &Value) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("Claude Agent SDK runner stdin is closed"))?;
        let line = serde_json::to_string(value)?;
        writeln!(stdin, "{line}").with_context(|| "write Claude Agent SDK request")?;
        stdin
            .flush()
            .with_context(|| "flush Claude Agent SDK request")?;
        self.stdin.take();
        Ok(())
    }

    fn recv_before(&self, deadline: Instant) -> Result<Value> {
        let now = Instant::now();
        if now >= deadline {
            bail!("timeout waiting for Claude Agent SDK");
        }
        match self
            .rx
            .recv_timeout(deadline.saturating_duration_since(now))
        {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => bail!("{message}"),
            Err(RecvTimeoutError::Timeout) => bail!("timeout waiting for Claude Agent SDK"),
            Err(RecvTimeoutError::Disconnected) => {
                bail!("Claude Agent SDK runner stdout closed before completion")
            }
        }
    }

    fn shutdown(&mut self) -> String {
        self.stdin.take();
        terminate_claude_agent_sdk_process_tree(&mut self.child);
        let _ = self.child.wait();
        if let Some(handle) = self.stdout_handle.take() {
            let _ = handle.join();
        }
        self.stderr_handle
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or_default()
    }
}

impl Drop for ClaudeAgentSdkProcess {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub(crate) fn run_claude_driver(
    request: &ChatRequest,
    project: &Path,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<DriverRun> {
    let output = run_claude_agent_sdk(request, project, progress)?;
    Ok(DriverRun {
        parsed: output.parsed,
        display_events: Some(output.events),
        provider_turn_id: None,
    })
}

fn run_claude_agent_sdk(
    request: &ChatRequest,
    project: &Path,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<ClaudeAgentSdkOutput> {
    if request.agent != Agent::Claude {
        bail!("Claude Agent SDK connector is only used for Claude");
    }
    let timeout_ms = std::env::var("BURN_CLAUDE_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CLAUDE_TIMEOUT_MS);

    let mut process = ClaudeAgentSdkProcess::spawn(project)?;
    let result = run_claude_agent_sdk_protocol(
        request,
        project,
        &mut process,
        Duration::from_millis(timeout_ms),
        progress,
    );
    let stderr = process.shutdown();
    match result {
        Ok(output) => Ok(output),
        Err(err) => {
            let stderr_tail = tail_text(&stderr, 4000);
            if stderr_tail.is_empty() {
                Err(err)
            } else {
                Err(err.context(format!("Claude Agent SDK stderr tail: {stderr_tail}")))
            }
        }
    }
}

pub(crate) fn list_claude_agent_sdk_sessions(project: &Path, limit: usize) -> Result<Value> {
    run_claude_agent_sdk_operation(
        project,
        json!({
            "op": "sessions.list",
            "cwd": project.to_string_lossy().to_string(),
            "limit": limit.clamp(1, 200)
        }),
    )
}

pub(crate) fn read_claude_agent_sdk_session(
    project: &Path,
    session_id: &str,
    cursor: usize,
    limit: usize,
    latest: bool,
) -> Result<Value> {
    run_claude_agent_sdk_operation(
        project,
        json!({
            "op": "session.messages",
            "cwd": project.to_string_lossy().to_string(),
            "session_id": session_id,
            "cursor": cursor,
            "limit": limit.clamp(1, 200),
            "latest": latest,
            "order": if latest { "latest" } else { "cursor" }
        }),
    )
}

fn run_claude_agent_sdk_operation(project: &Path, request: Value) -> Result<Value> {
    let timeout_ms = std::env::var("BURN_CLAUDE_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CLAUDE_TIMEOUT_MS);

    let mut process = ClaudeAgentSdkProcess::spawn(project)?;
    let result = (|| {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        process.send_request(&request)?;
        loop {
            let value = process.recv_before(deadline)?;
            match value.get("type").and_then(Value::as_str).unwrap_or("") {
                "burn_result" => break Ok(value),
                "burn_error" => bail!(
                    "{}",
                    find_text_by_key(&value, &["message", "error"])
                        .unwrap_or_else(|| value.to_string())
                ),
                _ => {}
            }
        }
    })();
    let stderr = process.shutdown();
    match result {
        Ok(value) => Ok(value),
        Err(err) => {
            let stderr_tail = tail_text(&stderr, 4000);
            if stderr_tail.is_empty() {
                Err(err)
            } else {
                Err(err.context(format!("Claude Agent SDK stderr tail: {stderr_tail}")))
            }
        }
    }
}

fn run_claude_agent_sdk_protocol(
    request: &ChatRequest,
    project: &Path,
    process: &mut ClaudeAgentSdkProcess,
    timeout: Duration,
    mut progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<ClaudeAgentSdkOutput> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    process.send_request(&claude_agent_sdk_runner_request(request, project))?;

    let runner_result = loop {
        let value = process.recv_before(deadline)?;
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "sdk_message" => {
                if let Some(message) = value.get("message") {
                    record_claude_event(&mut events, message.clone(), &mut progress);
                }
            }
            "burn_result" => {
                break value;
            }
            "burn_error" => bail!(
                "{}",
                find_text_by_key(&value, &["message", "error"])
                    .unwrap_or_else(|| value.to_string())
            ),
            _ => record_claude_event(&mut events, value, &mut progress),
        }
    };

    let mut parsed = if events.is_empty() {
        parse_runner_result(&runner_result)?
    } else {
        parse_claude_agent_sdk_events(&events, None)?
    };
    let event_log = write_claude_agent_sdk_event_log(project, &parsed, &events)?;
    if parsed.transcript_path.is_none() {
        parsed.transcript_path = Some(event_log.to_string_lossy().to_string());
    }
    Ok(ClaudeAgentSdkOutput { parsed, events })
}

fn record_claude_event(
    events: &mut Vec<Value>,
    value: Value,
    progress: &mut Option<&mut dyn FnMut(&Value)>,
) {
    if let Some(progress) = progress.as_deref_mut() {
        progress(&value);
    }
    events.push(value);
}

pub(crate) fn claude_agent_sdk_runner_request(request: &ChatRequest, project: &Path) -> Value {
    let mut options = match request.sdk_options.clone() {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if let Some(model) = request.model.as_deref() {
        options.insert("model".to_string(), Value::String(model.to_string()));
    }
    if request.mode == ChatMode::Plan && !options.contains_key("permissionMode") {
        options.insert(
            "permissionMode".to_string(),
            Value::String("plan".to_string()),
        );
    }

    json!({
        "prompt": request.prompt.clone(),
        "cwd": project.to_string_lossy().to_string(),
        "resume": request.resume.clone(),
        "mode": match request.mode {
            ChatMode::Chat => "chat",
            ChatMode::Plan => "plan",
        },
        "sdkOptions": Value::Object(options),
    })
}

fn parse_runner_result(value: &Value) -> Result<ParsedAgentOutput> {
    let reply = value
        .get("reply")
        .and_then(crate::text_from_value)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| anyhow!("Claude Agent SDK completed but no final assistant reply"))?;
    Ok(ParsedAgentOutput {
        reply,
        session_id: crate::find_session_id(value),
        transcript_path: crate::find_transcript_path(value),
    })
}

fn parse_claude_agent_sdk_events(
    events: &[Value],
    fallback_transcript_path: Option<String>,
) -> Result<ParsedAgentOutput> {
    let mut result_reply = None;
    let mut latest_assistant_text = None;
    let mut session_id = None;
    let mut transcript_path = fallback_transcript_path;
    let mut failure = None;

    for value in events {
        if session_id.is_none() {
            session_id = find_session_id(value);
        }
        if transcript_path.is_none() {
            transcript_path = find_transcript_path(value);
        }

        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "assistant" => {
                if let Some(text) = claude_sdk_assistant_text(value) {
                    latest_assistant_text = Some(text);
                }
            }
            "result" => {
                let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
                if subtype != "success" {
                    failure = Some(
                        find_text_by_key(value, &["error", "message", "reason"])
                            .unwrap_or_else(|| compact_json(value)),
                    );
                    continue;
                }
                if let Some(text) = value.get("result").and_then(text_from_value) {
                    if !text.trim().is_empty() {
                        result_reply = Some(text);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(message) = failure {
        bail!("{message}");
    }

    let reply = result_reply
        .or(latest_assistant_text)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| anyhow!("Claude Agent SDK completed but no final assistant reply"))?;

    Ok(ParsedAgentOutput {
        reply,
        session_id,
        transcript_path,
    })
}

fn claude_sdk_assistant_text(value: &Value) -> Option<String> {
    if get_path(value, &["message", "role"]).and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let content = get_path(value, &["message", "content"])?;
    match content {
        Value::Array(blocks) => {
            let parts: Vec<String> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(text_from_value))
                .filter(|text| !text.trim().is_empty())
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => text_from_value(content).filter(|text| !text.trim().is_empty()),
    }
}

fn write_claude_agent_sdk_event_log(
    project: &Path,
    parsed: &ParsedAgentOutput,
    events: &[Value],
) -> Result<PathBuf> {
    let seed = parsed
        .session_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or("unknown-session");
    let path = project
        .join(".burn/chat/claude-agent-sdk/events")
        .join(format!("{}.jsonl", sanitize_path_component(seed)));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create Claude Agent SDK event dir {}", parent.display()))?;
    }
    let mut file = fs::File::create(&path)
        .with_context(|| format!("open Claude Agent SDK event log {}", path.display()))?;
    for event in events {
        writeln!(file, "{event}")
            .with_context(|| format!("write Claude Agent SDK event log {}", path.display()))?;
    }
    Ok(path)
}

fn claude_agent_sdk_runner_path() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("BURN_CLAUDE_AGENT_SDK_RUNNER") {
        return Ok(PathBuf::from(path));
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest_dir.join("claude-agent-sdk-runner.mjs"))
}

fn sanitize_path_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.trim_matches('_').is_empty() {
        format!("session-{}", now_millis())
    } else {
        sanitized
    }
}

#[cfg(unix)]
fn terminate_claude_agent_sdk_process_tree(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let pgid = format!("-{}", child.id());
    let _ = Command::new("kill")
        .args(["-TERM", "--", &pgid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    thread::sleep(Duration::from_millis(200));
    if child.try_wait().ok().flatten().is_none() {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &pgid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_claude_agent_sdk_process_tree(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_claude_agent_sdk_result_and_display_events() {
        let events = vec![
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "sdk-session-1",
                "claude_code_version": "1.2.3"
            }),
            json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "check"},
                        {"type": "text", "text": "assistant fallback"}
                    ]
                }
            }),
            json!({
                "type": "result",
                "subtype": "success",
                "session_id": "sdk-session-1",
                "result": "final answer"
            }),
        ];

        let parsed = parse_claude_agent_sdk_events(&events, Some("/tmp/events.jsonl".to_string()))
            .expect("sdk result should parse");

        assert_eq!(parsed.reply, "final answer");
        assert_eq!(parsed.session_id.as_deref(), Some("sdk-session-1"));
        assert_eq!(parsed.transcript_path.as_deref(), Some("/tmp/events.jsonl"));
    }
}
