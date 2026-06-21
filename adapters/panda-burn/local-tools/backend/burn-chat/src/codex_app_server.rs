use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::display::compact_json;
use crate::drivers::DriverRun;
use crate::json_text::{find_string_by_paths, find_text_by_key, tail_text, text_from_value};
use crate::{
    parse_codex_app_server_events, Agent, ChatRequest, ParsedAgentOutput, DEFAULT_CODEX_TIMEOUT_MS,
};

struct CodexAppServerOutput {
    parsed: ParsedAgentOutput,
    events: Vec<Value>,
    turn_id: String,
}

struct CodexAppServerProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Result<Value, String>>,
    stdout_handle: Option<thread::JoinHandle<()>>,
    stderr_handle: Option<thread::JoinHandle<String>>,
}

impl CodexAppServerProcess {
    fn spawn(project: &Path) -> Result<Self> {
        let codex_bin = std::env::var("BURN_CODEX_BIN").unwrap_or_else(|_| "codex".to_string());
        let mut command = Command::new(&codex_bin);
        command
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .current_dir(project)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to start {codex_bin} app-server from PATH"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("codex app-server stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("codex app-server stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("codex app-server stderr unavailable"))?;

        let (tx, rx) = mpsc::channel();
        let stdout_handle = thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(err) => {
                        let _ = tx.send(Err(format!("read codex app-server stdout: {err}")));
                        break;
                    }
                };
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let parsed = serde_json::from_str::<Value>(line).map_err(|err| {
                    format!(
                        "codex app-server emitted invalid JSONL: {err}; line tail: {}",
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

    fn send_value(&mut self, value: &Value) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("codex app-server stdin is closed"))?;
        let line = serde_json::to_string(value)?;
        writeln!(stdin, "{line}").with_context(|| "write codex app-server request")?;
        stdin
            .flush()
            .with_context(|| "flush codex app-server request")?;
        Ok(())
    }

    fn recv_before(&self, deadline: Instant) -> Result<Value> {
        let now = Instant::now();
        if now >= deadline {
            bail!("timeout waiting for codex app-server");
        }
        match self
            .rx
            .recv_timeout(deadline.saturating_duration_since(now))
        {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => bail!("{message}"),
            Err(RecvTimeoutError::Timeout) => bail!("timeout waiting for codex app-server"),
            Err(RecvTimeoutError::Disconnected) => {
                bail!("codex app-server stdout closed before the turn completed")
            }
        }
    }

    fn shutdown(&mut self) -> String {
        self.stdin.take();
        terminate_codex_process_tree(&mut self.child);
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

impl Drop for CodexAppServerProcess {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn run_codex_app_server(
    request: &ChatRequest,
    project: &Path,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<CodexAppServerOutput> {
    if request.agent != Agent::Codex {
        bail!("codex app-server connector is only used for Codex");
    }
    validate_codex_app_server_request(request, project)?;
    let timeout_ms = std::env::var("BURN_CODEX_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CODEX_TIMEOUT_MS);

    let mut process = CodexAppServerProcess::spawn(project)?;
    let result = run_codex_app_server_protocol(
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
                Err(err.context(format!("codex app-server stderr tail: {stderr_tail}")))
            }
        }
    }
}

fn validate_codex_app_server_request(request: &ChatRequest, project: &Path) -> Result<()> {
    let cwd = project.to_string_lossy().to_string();
    let _ = codex_thread_request_parts(request, &cwd)?;
    let _ = codex_turn_request_params(request, &cwd, "__burn_validation_thread__")?;
    Ok(())
}

pub(crate) fn run_codex_driver(
    request: &ChatRequest,
    project: &Path,
    progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<DriverRun> {
    let output = run_codex_app_server(request, project, progress)?;
    Ok(DriverRun {
        parsed: output.parsed,
        display_events: Some(output.events),
        provider_turn_id: Some(output.turn_id),
    })
}

fn run_codex_app_server_protocol(
    request: &ChatRequest,
    project: &Path,
    process: &mut CodexAppServerProcess,
    timeout: Duration,
    mut progress: Option<&mut dyn FnMut(&Value)>,
) -> Result<CodexAppServerOutput> {
    let mut events = Vec::new();
    let deadline = Instant::now() + timeout;
    let cwd = project.to_string_lossy().to_string();

    initialize_codex_app_server(process, &mut events, deadline, &mut progress)?;

    let (thread_method, thread_params) = codex_thread_request_parts(request, &cwd)?;
    process.send_value(&json!({
        "id": 2,
        "method": thread_method,
        "params": thread_params
    }))?;
    let thread_result = response_result(&wait_for_response(
        process,
        2,
        &mut events,
        deadline,
        &mut progress,
    )?)?;
    let thread_id = find_codex_thread_id(&thread_result)
        .or_else(|| request.resume.clone())
        .ok_or_else(|| anyhow!("codex app-server thread response did not include thread.id"))?;
    let transcript_path = find_codex_transcript_path(&thread_result);

    let turn_params = codex_turn_request_params(request, &cwd, &thread_id)?;
    process.send_value(&json!({
        "id": 3,
        "method": "turn/start",
        "params": Value::Object(turn_params)
    }))?;
    let turn_result = response_result(&wait_for_response(
        process,
        3,
        &mut events,
        deadline,
        &mut progress,
    )?)?;
    let turn_id = find_string_by_paths(&turn_result, &[&["turn", "id"], &["id"]])
        .ok_or_else(|| anyhow!("codex app-server turn response did not include turn.id"))?;
    record_codex_event(
        &mut events,
        json!({
            "method": "turn/started",
            "params": {
                "threadId": thread_id.clone(),
                "turn": { "id": turn_id.clone() },
                "_synthetic": { "source": "codex-app-server", "reason": "expose-turn-id" }
            }
        }),
        &mut progress,
    );

    wait_for_turn_completed(
        process,
        &mut events,
        deadline,
        &thread_id,
        &turn_id,
        &mut progress,
    )?;
    let parsed = parse_codex_app_server_events(&events, Some(thread_id), transcript_path)?;
    Ok(CodexAppServerOutput {
        parsed,
        events,
        turn_id,
    })
}

pub(crate) fn list_codex_app_server_threads(project: &Path, limit: usize) -> Result<Value> {
    let cwd = project.to_string_lossy().to_string();
    codex_app_server_request(
        project,
        "thread/list",
        json!({
            "cwd": cwd,
            "limit": limit.clamp(1, 200),
            "sortKey": "updated_at",
            "sortDirection": "desc"
        }),
    )
}

pub(crate) fn read_codex_app_server_thread(project: &Path, thread_id: &str) -> Result<Value> {
    codex_app_server_request(
        project,
        "thread/read",
        json!({
            "threadId": thread_id,
            "includeTurns": true
        }),
    )
}

pub(crate) fn interrupt_codex_app_server_turn(
    project: &Path,
    thread_id: &str,
    turn_id: &str,
) -> Result<Value> {
    codex_app_server_request(
        project,
        "turn/interrupt",
        json!({
            "threadId": thread_id,
            "turnId": turn_id
        }),
    )
}

pub(crate) fn codex_app_server_request(
    project: &Path,
    method: &str,
    params: Value,
) -> Result<Value> {
    let timeout_ms = std::env::var("BURN_CODEX_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CODEX_TIMEOUT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut process = CodexAppServerProcess::spawn(project)?;
    let result = (|| {
        let mut events = Vec::new();
        let mut progress = None;
        initialize_codex_app_server(&mut process, &mut events, deadline, &mut progress)?;
        process.send_value(&json!({ "id": 2, "method": method, "params": params }))?;
        response_result(&wait_for_response(
            &mut process,
            2,
            &mut events,
            deadline,
            &mut progress,
        )?)
    })();
    let stderr = process.shutdown();
    match result {
        Ok(value) => Ok(value),
        Err(err) => {
            let stderr_tail = tail_text(&stderr, 4000);
            if stderr_tail.is_empty() {
                Err(err)
            } else {
                Err(err.context(format!("codex app-server stderr tail: {stderr_tail}")))
            }
        }
    }
}

fn initialize_codex_app_server(
    process: &mut CodexAppServerProcess,
    events: &mut Vec<Value>,
    deadline: Instant,
    progress: &mut Option<&mut dyn FnMut(&Value)>,
) -> Result<()> {
    process.send_value(&json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "burn-chat",
                "title": "Burn Chat",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false,
                "optOutNotificationMethods": [
                    "thread/status/changed",
                    "thread/tokenUsage/updated",
                    "account/rateLimits/updated"
                ]
            }
        }
    }))?;
    response_result(&wait_for_response(process, 1, events, deadline, progress)?)?;
    process.send_value(&json!({ "method": "initialized" }))?;
    Ok(())
}

fn wait_for_response(
    process: &mut CodexAppServerProcess,
    request_id: u64,
    events: &mut Vec<Value>,
    deadline: Instant,
    progress: &mut Option<&mut dyn FnMut(&Value)>,
) -> Result<Value> {
    loop {
        let value = process.recv_before(deadline)?;
        if is_response_for(&value, request_id) {
            return Ok(value);
        }
        if respond_to_server_request_if_needed(process, &value, events, progress)? {
            continue;
        }
        if let Some(message) = codex_fatal_notification_message(&value) {
            record_codex_event(events, value, progress);
            bail!("{message}");
        }
        record_codex_event(events, value, progress);
    }
}

fn wait_for_turn_completed(
    process: &mut CodexAppServerProcess,
    events: &mut Vec<Value>,
    deadline: Instant,
    thread_id: &str,
    turn_id: &str,
    progress: &mut Option<&mut dyn FnMut(&Value)>,
) -> Result<()> {
    loop {
        let value = match process.recv_before(deadline) {
            Ok(value) => value,
            Err(err) => {
                let _ = process.send_value(&json!({
                    "id": 9001,
                    "method": "turn/interrupt",
                    "params": { "threadId": thread_id, "turnId": turn_id }
                }));
                return Err(err.context("codex app-server turn did not complete before timeout"));
            }
        };
        if respond_to_server_request_if_needed(process, &value, events, progress)? {
            continue;
        }
        let method = value.get("method").and_then(Value::as_str);
        if let Some(message) = codex_fatal_notification_message(&value) {
            record_codex_event(events, value, progress);
            bail!("{message}");
        }
        let is_completed = method == Some("turn/completed")
            && value
                .pointer("/params/turn/id")
                .and_then(Value::as_str)
                .map(|id| id == turn_id)
                .unwrap_or(true);
        record_codex_event(events, value, progress);
        if is_completed {
            return Ok(());
        }
    }
}

fn respond_to_server_request_if_needed(
    process: &mut CodexAppServerProcess,
    value: &Value,
    events: &mut Vec<Value>,
    progress: &mut Option<&mut dyn FnMut(&Value)>,
) -> Result<bool> {
    let is_server_request = value.get("id").is_some()
        && value.get("method").is_some()
        && value.get("result").is_none()
        && value.get("error").is_none();
    if !is_server_request {
        return Ok(false);
    }

    record_codex_event(events, value.clone(), progress);
    let response = codex_server_request_error_response(value);
    process.send_value(&response)?;
    Ok(true)
}

fn record_codex_event(
    events: &mut Vec<Value>,
    value: Value,
    progress: &mut Option<&mut dyn FnMut(&Value)>,
) {
    if let Some(progress) = progress.as_deref_mut() {
        progress(&value);
    }
    events.push(value);
}

pub(crate) fn codex_thread_request_parts(
    request: &ChatRequest,
    cwd: &str,
) -> Result<(&'static str, Value)> {
    let mut thread_params = Map::new();
    thread_params.insert("cwd".to_string(), Value::String(cwd.to_string()));
    merge_codex_options(&mut thread_params, request.sdk_options.as_ref(), "thread")?;
    thread_params
        .entry("approvalPolicy".to_string())
        .or_insert_with(|| Value::String("never".to_string()));
    if let Some(model) = request.model.as_deref() {
        thread_params.insert("model".to_string(), Value::String(model.to_string()));
    }
    let thread_method = if let Some(session_id) = request.resume.as_deref() {
        thread_params.insert(
            "threadId".to_string(),
            Value::String(session_id.to_string()),
        );
        "thread/resume"
    } else {
        "thread/start"
    };
    Ok((thread_method, Value::Object(thread_params)))
}

fn codex_turn_request_params(
    request: &ChatRequest,
    cwd: &str,
    thread_id: &str,
) -> Result<Map<String, Value>> {
    let mut turn_params = Map::new();
    turn_params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    turn_params.insert("cwd".to_string(), Value::String(cwd.to_string()));
    turn_params.insert(
        "input".to_string(),
        json!([{ "type": "text", "text": request.prompt.clone(), "text_elements": [] }]),
    );
    merge_codex_options(&mut turn_params, request.sdk_options.as_ref(), "turn")?;
    turn_params
        .entry("approvalPolicy".to_string())
        .or_insert_with(|| Value::String("never".to_string()));
    if let Some(model) = request.model.as_deref() {
        turn_params.insert("model".to_string(), Value::String(model.to_string()));
    }
    Ok(turn_params)
}

fn merge_codex_options(
    params: &mut Map<String, Value>,
    raw: Option<&Value>,
    scope: &str,
) -> Result<()> {
    let Some(Value::Object(options)) = raw else {
        return Ok(());
    };
    for (key, value) in options {
        if key == "thread" || key == "turn" {
            continue;
        }
        insert_codex_option(params, key, value.clone())?;
    }
    if let Some(value) = options.get(scope) {
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("codex options.{scope} must be a JSON object"))?;
        for (key, value) in object {
            insert_codex_option(params, key, value.clone())?;
        }
    }
    Ok(())
}

fn insert_codex_option(params: &mut Map<String, Value>, key: &str, value: Value) -> Result<()> {
    if matches!(key, "cwd" | "threadId" | "input") {
        bail!("codex options.{key} is controlled by Burn session routing");
    }
    params.insert(key.to_string(), value);
    Ok(())
}

pub(crate) fn codex_server_request_error_response(value: &Value) -> Value {
    json!({
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "error": {
            "code": -32000,
            "message": "Burn blocking chat cannot answer interactive Codex app-server requests"
        }
    })
}

pub(crate) fn codex_fatal_notification_message(value: &Value) -> Option<String> {
    if value.get("method").and_then(Value::as_str) != Some("error") {
        return None;
    }
    Some(
        find_text_by_key(value, &["message", "error", "text"])
            .unwrap_or_else(|| compact_json(value)),
    )
}

#[cfg(unix)]
fn terminate_codex_process_tree(child: &mut Child) {
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
fn terminate_codex_process_tree(child: &mut Child) {
    let _ = child.kill();
}

fn is_response_for(value: &Value, request_id: u64) -> bool {
    value
        .get("id")
        .and_then(|id| id.as_u64().or_else(|| id.as_str()?.parse::<u64>().ok()))
        == Some(request_id)
        && (value.get("result").is_some() || value.get("error").is_some())
}

fn response_result(response: &Value) -> Result<Value> {
    if let Some(error) = response.get("error") {
        bail!(
            "{}",
            text_from_value(error).unwrap_or_else(|| compact_json(error))
        );
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| anyhow!("codex app-server response missing result"))
}

fn find_codex_thread_id(value: &Value) -> Option<String> {
    find_string_by_paths(
        value,
        &[
            &["thread", "id"],
            &["thread", "sessionId"],
            &["threadId"],
            &["turn", "threadId"],
            &["id"],
        ],
    )
}

fn find_codex_transcript_path(value: &Value) -> Option<String> {
    find_string_by_paths(
        value,
        &[
            &["thread", "path"],
            &["thread", "rolloutPath"],
            &["path"],
            &["rolloutPath"],
        ],
    )
}

pub(crate) fn find_codex_thread_id_in_events(events: &[Value]) -> Option<String> {
    events.iter().find_map(|value| {
        find_string_by_paths(
            value,
            &[
                &["params", "threadId"],
                &["params", "thread", "id"],
                &["params", "turn", "threadId"],
                &["result", "thread", "id"],
                &["threadId"],
            ],
        )
    })
}

pub(crate) fn find_codex_transcript_path_in_events(events: &[Value]) -> Option<String> {
    events.iter().find_map(|value| {
        find_string_by_paths(
            value,
            &[
                &["params", "thread", "path"],
                &["params", "thread", "rolloutPath"],
                &["result", "thread", "path"],
                &["path"],
            ],
        )
    })
}
