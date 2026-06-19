use burn_monitor::show_session_with_home_for_agent;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_TEMP_ID: AtomicUsize = AtomicUsize::new(0);

#[test]
fn parses_codex_transcript_messages() {
    let temp = TempHome::new();
    let project = temp.project("codex-project");
    let path = temp
        .path
        .join(".codex/sessions/2026/06/13/rollout-codex-normal.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"timestamp":"2026-06-13T01:00:00Z","type":"session_meta","payload":{{"id":"codex-normal","cwd":"{}","timestamp":"2026-06-13T01:00:00Z"}}}}
{{"timestamp":"2026-06-13T01:00:01Z","type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"List sessions"}}]}}}}
{{"timestamp":"2026-06-13T01:00:02Z","type":"response_item","payload":{{"item":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"Found two sessions"}}]}}}}}}
{{"timestamp":"2026-06-13T01:00:03Z","type":"response_item","payload":{{"item":{{"type":"function_call","name":"exec_command","arguments":{{"cmd":"pwd"}}}}}}}}
{{"timestamp":"2026-06-13T01:00:04Z","type":"response_item","payload":{{"item":{{"type":"function_call_output","output":"ok"}}}}}}"#,
            project.display()
        ),
    );

    let shown =
        show_session_with_home_for_agent(&temp.path, "codex-normal", Some("codex"), 0, 20).unwrap();

    assert_eq!(shown.agent, "codex");
    assert_eq!(shown.scanned, 5);
    assert_eq!(shown.valid, 4);
    assert_eq!(shown.skipped, 0);
    assert_eq!(shown.messages[0].role, "user");
    assert_eq!(shown.messages[0].blocks[0].kind, "text");
    assert_eq!(shown.messages[1].role, "assistant");
    assert_eq!(shown.messages[1].blocks[0].kind, "markdown");
    assert_eq!(shown.messages[2].blocks[0].kind, "tool_call");
    assert_eq!(shown.messages[3].role, "tool");
    assert_eq!(shown.messages[3].blocks[0].kind, "tool_result");
}

#[test]
fn skips_bad_json_lines_without_failing_the_transcript() {
    let temp = TempHome::new();
    let project = temp.project("claude-project");
    let path = temp
        .path
        .join(".claude/projects/-tmp-claude/claude-bad-line.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"type":"user","cwd":"{}","sessionId":"claude-bad-line","timestamp":"2026-06-13T02:00:00Z","message":{{"role":"user","content":[{{"type":"text","text":"Open the transcript"}}]}}}}
not json at all
{{"type":"assistant","cwd":"{}","sessionId":"claude-bad-line","timestamp":"2026-06-13T02:00:01Z","message":{{"role":"assistant","content":[{{"type":"text","text":"Transcript opened"}}]}}}}"#,
            project.display(),
            project.display()
        ),
    );

    let shown =
        show_session_with_home_for_agent(&temp.path, "claude-bad-line", Some("claude"), 0, 20)
            .unwrap();

    assert_eq!(shown.agent, "claude");
    assert_eq!(shown.scanned, 3);
    assert_eq!(shown.valid, 2);
    assert_eq!(shown.skipped, 1);
    assert_eq!(shown.messages.len(), 2);
    assert_eq!(shown.messages[1].blocks[0].text, "Transcript opened");
}

#[test]
fn empty_codex_session_returns_no_messages() {
    let temp = TempHome::new();
    let project = temp.project("empty-project");
    let path = temp
        .path
        .join(".codex/sessions/2026/06/13/rollout-codex-empty.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"timestamp":"2026-06-13T03:00:00Z","type":"session_meta","payload":{{"id":"codex-empty","cwd":"{}","timestamp":"2026-06-13T03:00:00Z"}}}}"#,
            project.display()
        ),
    );

    let shown =
        show_session_with_home_for_agent(&temp.path, "codex-empty", Some("codex"), 0, 20).unwrap();

    assert_eq!(shown.scanned, 1);
    assert_eq!(shown.valid, 0);
    assert_eq!(shown.skipped, 0);
    assert!(shown.messages.is_empty());
    assert_eq!(shown.next_cursor, None);
}

#[test]
fn paginates_by_jsonl_line_cursor() {
    let temp = TempHome::new();
    let project = temp.project("page-project");
    let path = temp
        .path
        .join(".codex/sessions/2026/06/13/rollout-codex-page.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"codex-page","cwd":"{}","timestamp":"2026-06-13T04:00:00Z"}}}}
{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"one"}}]}}}}
{{"type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"two"}}]}}}}"#,
            project.display()
        ),
    );

    let first =
        show_session_with_home_for_agent(&temp.path, "codex-page", Some("codex"), 0, 1).unwrap();
    let next = first.next_cursor.expect("next cursor");
    let second =
        show_session_with_home_for_agent(&temp.path, "codex-page", Some("codex"), next, 10)
            .unwrap();

    assert_eq!(first.messages.len(), 1);
    assert_eq!(first.messages[0].blocks[0].text, "one");
    assert_eq!(second.messages.len(), 1);
    assert_eq!(second.messages[0].blocks[0].text, "two");
}

#[test]
fn loads_latest_page_and_exposes_prev_cursor() {
    let temp = TempHome::new();
    let project = temp.project("latest-project");
    let path = temp
        .path
        .join(".codex/sessions/2026/06/13/rollout-codex-latest.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"codex-latest","cwd":"{}","timestamp":"2026-06-13T05:00:00Z"}}}}
{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"one"}}]}}}}
{{"type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"two"}}]}}}}
{{"type":"response_item","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"three"}}]}}}}
{{"type":"response_item","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"four"}}]}}}}"#,
            project.display()
        ),
    );

    let latest = burn_monitor::show_session_with_home_for_agent_page(
        &temp.path,
        "codex-latest",
        Some("codex"),
        0,
        2,
        true,
    )
    .unwrap();
    assert_eq!(latest.order, "latest");
    assert_eq!(latest.total_messages, 4);
    assert_eq!(latest.messages.len(), 2);
    assert_eq!(latest.messages[0].blocks[0].text, "three");
    assert_eq!(latest.messages[1].blocks[0].text, "four");
    assert_eq!(latest.prev_cursor, Some(1));
    assert!(!latest.end_of_history);

    let older = burn_monitor::show_session_with_home_for_agent(
        &temp.path,
        "codex-latest",
        Some("codex"),
        latest.prev_cursor.unwrap(),
        2,
    )
    .unwrap();
    assert_eq!(older.messages.len(), 2);
    assert_eq!(older.messages[0].blocks[0].text, "one");
    assert_eq!(older.messages[1].blocks[0].text, "two");
}

struct TempHome {
    path: PathBuf,
}

impl TempHome {
    fn new() -> Self {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("burn-monitor-transcript-test-{id}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn project(&self, name: &str) -> PathBuf {
        let path = self.path.join("projects").join(name);
        fs::create_dir_all(&path).unwrap();
        write_file(&path.join("Cargo.toml"), "[package]\nname = \"fixture\"\n");
        path
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}
