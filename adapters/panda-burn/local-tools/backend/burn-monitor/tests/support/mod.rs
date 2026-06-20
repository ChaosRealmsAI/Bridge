#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::SystemTime;

static NEXT_TEMP_ID: AtomicUsize = AtomicUsize::new(0);

pub fn write_codex_fixture(home: &Path, id: &str, project: &str, user_text: &str) -> PathBuf {
    let path = home
        .join(".codex/sessions/2026/06/13")
        .join(format!("rollout-{id}.jsonl"));
    write_file(
        &path,
        &format!(
            r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"{project}","timestamp":"2026-06-13T01:00:00Z"}}}}
{{"type":"response_item","payload":{{"item":{{"type":"message","role":"user","content":[{{"type":"input_text","text":"{user_text}"}}]}}}}}}
{{"type":"event_msg","payload":{{"type":"agent_message","message":"The monitor is ready"}}}}"#
        ),
    );
    path
}

pub fn write_claude_fixture(
    home: &Path,
    storage_dir: &str,
    id: &str,
    project: &str,
    assistant_text: &str,
) -> PathBuf {
    let path = home
        .join(".claude/projects")
        .join(storage_dir)
        .join(format!("{id}.jsonl"));
    write_file(
        &path,
        &format!(
            r#"{{"type":"user","cwd":"{project}","sessionId":"{id}","timestamp":"2026-06-13T02:00:00Z","message":{{"role":"user","content":[{{"type":"text","text":"Inspect local sessions"}}]}}}}
{{"type":"assistant","cwd":"{project}","sessionId":"{id}","timestamp":"2026-06-13T02:01:00Z","message":{{"role":"assistant","content":[{{"type":"text","text":"{assistant_text}"}}]}}}}"#
        ),
    );
    path
}

pub fn assert_project_rollup<'a>(
    report: &'a burn_monitor::Report,
    project: &str,
) -> &'a burn_monitor::ProjectReport {
    assert_eq!(report.running_total, 1);
    assert_eq!(report.by_project.len(), 1);
    let project_report = &report.by_project[0];
    assert_eq!(project_report.project, project);
    assert_eq!(project_report.total, 2);
    assert_eq!(project_report.running, 1);
    project_report
}

pub fn project_names(report: &burn_monitor::Report) -> Vec<&str> {
    report
        .by_project
        .iter()
        .map(|project| project.name.as_str())
        .collect()
}

pub fn session_ids(project: &burn_monitor::ProjectReport) -> Vec<&str> {
    project
        .sessions
        .iter()
        .map(|session| session.id.as_str())
        .collect()
}

pub struct TempHome {
    pub path: PathBuf,
}

impl TempHome {
    pub fn new() -> Self {
        let unique = format!(
            "burn-monitor-test-{}-{}-{}",
            std::process::id(),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn project(&self, name: &str) -> PathBuf {
        let path = self.path.join("projects").join(name);
        fs::create_dir_all(&path).unwrap();
        write_marker(&path);
        fs::canonicalize(path).unwrap()
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn write_marker(path: &Path) {
    fs::write(path.join("Cargo.toml"), "[package]\nname = \"fixture\"\n").unwrap();
}

pub fn write_file(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

pub fn path_string(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

pub fn set_modified(path: &Path, time: SystemTime) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_times(std::fs::FileTimes::new().set_modified(time))
        .unwrap();
}
