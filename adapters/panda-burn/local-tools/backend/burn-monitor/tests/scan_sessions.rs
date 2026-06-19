mod support;

use burn_monitor::{scan_with_home_at, show_session_with_home, show_session_with_home_project};
use chrono::Utc;
use std::fs;
use std::time::{Duration, SystemTime};
use support::{
    TempHome, assert_project_rollup, path_string, set_modified, write_claude_fixture,
    write_codex_fixture, write_file,
};

#[test]
fn scans_codex_and_claude_sessions_by_project() {
    let temp = TempHome::new();
    let project_path = temp.project("burn-project-a");
    let project = path_string(&project_path);
    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);

    let codex_path = write_codex_fixture(
        &temp.path,
        "codex-live",
        &project,
        "Implement the monitor library",
    );
    let claude_path = write_claude_fixture(
        &temp.path,
        "wrong-storage-name",
        "claude-old",
        &project,
        "I found the inactive session",
    );

    set_modified(&codex_path, now);
    set_modified(&claude_path, now - Duration::from_secs(3_600));

    let report = scan_with_home_at(&temp.path, now_utc, 90);
    let project_report = assert_project_rollup(&report, &project);
    assert_eq!(project_report.name, "burn-project-a");

    let codex = project_report
        .sessions
        .iter()
        .find(|session| session.id == "codex-live")
        .expect("codex session");
    assert_eq!(codex.agent, "codex");
    assert!(codex.running);
    assert_eq!(codex.title, "Implement the monitor library");

    let claude = project_report
        .sessions
        .iter()
        .find(|session| session.id == "claude-old")
        .expect("claude session");
    assert_eq!(claude.agent, "claude");
    assert!(!claude.running);
    assert_eq!(claude.title, "I found the inactive session");
}

#[test]
fn shows_session_messages_and_skips_bad_lines() {
    let temp = TempHome::new();
    let project_path = temp.project("show-session-project");
    let project = path_string(&project_path);
    let path = temp
        .path
        .join(".claude/projects/show")
        .join("claude-show.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"type":"user","cwd":"{project}","sessionId":"claude-show","timestamp":"2026-06-13T02:00:00Z","message":{{"role":"user","content":[{{"type":"text","text":"Show this session"}}]}}}}
not-json
{{"type":"assistant","cwd":"{project}","sessionId":"claude-show","timestamp":"2026-06-13T02:01:00Z","message":{{"role":"assistant","content":[{{"type":"text","text":"Shown."}}]}}}}"#
        ),
    );

    let detail = show_session_with_home(&temp.path, "claude-show", 0, 80).expect("show session");

    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.valid, 2);
    assert_eq!(detail.skipped, 1);
    assert_eq!(detail.messages[0].role, "user");
    assert_eq!(detail.messages[1].blocks[0].text, "Shown.");
}

#[test]
fn show_session_prefers_exact_id_over_prefix() {
    let temp = TempHome::new();
    let project_path = temp.project("exact-prefix-project");
    let project = path_string(&project_path);
    let exact = write_codex_fixture(&temp.path, "abc", &project, "Exact session");
    let prefix = write_codex_fixture(&temp.path, "abcdef", &project, "Longer prefix session");
    let now = SystemTime::now();
    set_modified(&exact, now - Duration::from_secs(10));
    set_modified(&prefix, now);

    let detail = show_session_with_home(&temp.path, "abc", 0, 80).expect("exact session");

    assert_eq!(detail.id, "abc");
    assert_eq!(detail.messages[0].blocks[0].text, "Exact session");
}

#[test]
fn show_session_project_filter_rejects_other_project_session() {
    let temp = TempHome::new();
    let allowed_project = temp.project("allowed-project");
    let other_project = temp.project("other-project");
    let allowed = path_string(&allowed_project);
    let other = path_string(&other_project);
    write_codex_fixture(&temp.path, "allowed-session", &allowed, "Allowed");
    write_codex_fixture(&temp.path, "other-session", &other, "Other");

    let detail =
        show_session_with_home_project(&temp.path, &allowed_project, "allowed-session", 0, 80)
            .expect("allowed project session");
    assert_eq!(detail.id, "allowed-session");

    let denied =
        show_session_with_home_project(&temp.path, &allowed_project, "other-session", 0, 80);
    assert!(denied.is_err());
}

#[test]
fn skips_codex_environment_context_when_selecting_title() {
    let temp = TempHome::new();
    let project_path = temp.project("schema-registry-browser");
    let project = path_string(&project_path);
    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);
    let path = temp
        .path
        .join(".codex/sessions/2026/06/13")
        .join("rollout-env-title.jsonl");
    write_file(
        &path,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"env-title","cwd":"{project}","timestamp":"2026-06-13T01:00:00Z"}}}}
{{"type":"response_item","payload":{{"item":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"<environment_context> <cwd>{project}</cwd> </environment_context>"}}]}}}}}}
{{"type":"response_item","payload":{{"item":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"Open the schema registry browser"}}]}}}}}}
{{"type":"event_msg","payload":{{"type":"agent_message","message":"Done"}}}}"#
        ),
    );
    set_modified(&path, now);

    let report = scan_with_home_at(&temp.path, now_utc, 90);

    assert_eq!(report.by_project.len(), 1);
    assert_eq!(report.by_project[0].sessions.len(), 1);
    assert_eq!(
        report.by_project[0].sessions[0].title,
        "Open the schema registry browser"
    );
}

#[test]
fn uses_jsonl_cwd_instead_of_storage_directory_name() {
    let temp = TempHome::new();
    let project_path = temp.project("real-project");
    let project = path_string(&project_path);
    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);

    let claude_path = write_claude_fixture(
        &temp.path,
        "Users-Zhuanz",
        "claude-real-cwd",
        &project,
        "Storage path is not the project",
    );
    set_modified(&claude_path, now);

    let report = scan_with_home_at(&temp.path, now_utc, 90);

    assert_eq!(report.by_project.len(), 1);
    assert_eq!(report.by_project[0].project, project);
    assert_eq!(report.by_project[0].name, "real-project");
}

#[test]
fn scan_reports_incremental_cache_and_deleted_file_full_rescan() {
    let temp = TempHome::new();
    let project_path = temp.project("cache-project");
    let project = path_string(&project_path);
    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);

    let codex_path = write_codex_fixture(&temp.path, "cache-codex", &project, "Cache me");
    let claude_path = write_claude_fixture(
        &temp.path,
        "cache-storage",
        "cache-claude",
        &project,
        "Cache this too",
    );
    set_modified(&codex_path, now);
    set_modified(&claude_path, now - Duration::from_secs(10));

    let first = scan_with_home_at(&temp.path, now_utc, 90);
    assert_eq!(first.totals.scanned, 2);
    assert_eq!(first.totals.valid, 2);
    assert_eq!(first.diagnostics.mode, "full_rescan");
    assert!(first.diagnostics.cache.full_rescan);
    assert_eq!(first.diagnostics.cache.full_rescan_reason, "cache_missing");
    assert_eq!(first.diagnostics.cache.hit, 0);
    assert_eq!(first.diagnostics.cache.miss, 2);
    assert_eq!(first.diagnostics.cache.entries_written, 2);
    assert_eq!(first.diagnostics.limits.running_window_secs, 90);
    assert_eq!(first.diagnostics.limits.transcript_default_limit, 200);

    let second = scan_with_home_at(&temp.path, now_utc, 90);
    assert_eq!(second.totals.scanned, 2);
    assert_eq!(second.totals.valid, 2);
    assert_eq!(second.diagnostics.mode, "incremental");
    assert!(!second.diagnostics.cache.full_rescan);
    assert_eq!(second.diagnostics.cache.hit, 2);
    assert_eq!(second.diagnostics.cache.miss, 0);
    assert_eq!(second.diagnostics.cache.entries_read, 2);
    assert_eq!(second.diagnostics.cache.entries_written, 2);

    write_file(
        &codex_path,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"cache-codex","cwd":"{project}","timestamp":"2026-06-13T01:00:00Z"}}}}
{{"type":"response_item","payload":{{"item":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"Cache me after change"}}]}}}}}}
{{"type":"event_msg","payload":{{"type":"agent_message","message":"Changed cache entry"}}}}"#
        ),
    );
    set_modified(&codex_path, now + Duration::from_secs(20));

    let changed = scan_with_home_at(&temp.path, now_utc, 90);
    assert_eq!(changed.diagnostics.mode, "incremental");
    assert_eq!(changed.diagnostics.cache.hit, 1);
    assert_eq!(changed.diagnostics.cache.miss, 1);
    assert_eq!(changed.diagnostics.cache.stale, 1);
    assert_eq!(changed.by_project.len(), 1);
    let project_report = &changed.by_project[0];
    assert_eq!(project_report.project, project);
    assert_eq!(project_report.total, 2);
    let codex = project_report
        .sessions
        .iter()
        .find(|session| session.id == "cache-codex")
        .expect("changed codex session");
    assert_eq!(codex.title, "Cache me after change");

    fs::remove_file(&claude_path).unwrap();
    let deleted = scan_with_home_at(&temp.path, now_utc, 90);
    assert_eq!(deleted.diagnostics.mode, "full_rescan");
    assert!(deleted.diagnostics.cache.full_rescan);
    assert_eq!(
        deleted.diagnostics.cache.full_rescan_reason,
        "source_files_deleted"
    );
    assert_eq!(deleted.diagnostics.cache.hit, 0);
    assert_eq!(deleted.diagnostics.cache.miss, 1);
    assert_eq!(deleted.diagnostics.cache.entries_read, 2);
    assert_eq!(deleted.diagnostics.cache.entries_written, 1);
    assert_eq!(deleted.totals.scanned, 1);
    assert_eq!(deleted.totals.valid, 1);
}
