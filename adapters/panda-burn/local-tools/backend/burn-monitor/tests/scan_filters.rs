mod support;

use burn_monitor::scan_with_home_at;
use chrono::Utc;
use std::fs;
use std::time::{Duration, SystemTime};
use support::{
    TempHome, path_string, project_names, session_ids, set_modified, write_claude_fixture,
    write_codex_fixture, write_marker,
};

#[test]
fn normalizes_cwd_and_rolls_nested_directories_up_to_project_root() {
    let temp = TempHome::new();
    let project_path = temp.project("normalized-project");
    let nested = project_path.join("src").join("bin");
    fs::create_dir_all(&nested).unwrap();
    let project = path_string(&project_path);
    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);

    let codex_path = write_codex_fixture(
        &temp.path,
        "codex-dot",
        &format!("{}/.", project_path.display()),
        "Use normalized cwd",
    );
    let claude_path = write_claude_fixture(
        &temp.path,
        "different-munged-dir",
        "claude-nested",
        &nested.to_string_lossy(),
        "Nested cwd belongs to the project",
    );

    set_modified(&codex_path, now);
    set_modified(&claude_path, now - Duration::from_secs(10));

    let report = scan_with_home_at(&temp.path, now_utc, 90);

    assert_eq!(report.by_project.len(), 1);
    assert_eq!(report.by_project[0].project, project);
    assert_eq!(report.by_project[0].total, 2);
}

#[test]
fn filters_invalid_and_transient_cwds() {
    let temp = TempHome::new();
    let project_path = temp.project("valid-project");
    let project = path_string(&project_path);
    let transient = temp
        .path
        .join("Library/Application Support/Otherline/agents/workspaces/ana-lomidze");
    fs::create_dir_all(&transient).unwrap();
    write_marker(&transient);

    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);

    let valid = write_codex_fixture(&temp.path, "valid", &project, "Keep valid cwd");
    let root = write_codex_fixture(&temp.path, "root", "/", "Skip root cwd");
    let home = write_codex_fixture(
        &temp.path,
        "home",
        &temp.path.to_string_lossy(),
        "Skip home cwd",
    );
    let missing = write_codex_fixture(
        &temp.path,
        "missing",
        &path_string(&temp.path.join("missing-project")),
        "Skip missing cwd",
    );
    let transient_session = write_codex_fixture(
        &temp.path,
        "transient",
        &transient.to_string_lossy(),
        "Skip transient agent workspace",
    );

    for path in [valid, root, home, missing, transient_session] {
        set_modified(&path, now);
    }

    let report = scan_with_home_at(&temp.path, now_utc, 90);

    assert_eq!(report.by_project.len(), 1);
    assert_eq!(report.by_project[0].project, project);
    assert_eq!(report.by_project[0].total, 1);
}

#[test]
fn sorts_projects_and_sessions_by_last_activity_descending() {
    let temp = TempHome::new();
    let recent_project = path_string(&temp.project("recent-project"));
    let older_project = path_string(&temp.project("older-project"));
    let now = SystemTime::now();
    let now_utc = chrono::DateTime::<Utc>::from(now);

    let recent_new = write_codex_fixture(&temp.path, "recent-new", &recent_project, "Newest");
    let recent_old = write_claude_fixture(
        &temp.path,
        "recent-storage",
        "recent-old",
        &recent_project,
        "Older in recent project",
    );
    let older = write_codex_fixture(&temp.path, "older", &older_project, "Old project");

    set_modified(&recent_new, now);
    set_modified(&recent_old, now - Duration::from_secs(10));
    set_modified(&older, now - Duration::from_secs(20));

    let report = scan_with_home_at(&temp.path, now_utc, 90);

    assert_eq!(
        project_names(&report),
        vec!["recent-project", "older-project"]
    );
    assert_eq!(
        session_ids(&report.by_project[0]),
        vec!["recent-new", "recent-old"]
    );
}
