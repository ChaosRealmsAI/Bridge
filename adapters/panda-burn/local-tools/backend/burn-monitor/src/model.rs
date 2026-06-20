use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub generated_at: String,
    pub scan_scope: String,
    pub running_total: usize,
    pub by_project: Vec<ProjectReport>,
    pub projects: Vec<ProjectSummary>,
    pub totals: Totals,
    pub diagnostics: ScanDiagnostics,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectReport {
    pub project: String,
    pub name: String,
    pub running: usize,
    pub total: usize,
    pub sessions: Vec<Session>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectSummary {
    pub project: String,
    pub cwd: String,
    pub running: usize,
    pub total: usize,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub agent: String,
    pub title: String,
    pub updated_at: String,
    pub running: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Session {
    pub id: String,
    pub agent: String,
    pub project: String,
    pub title: String,
    pub started_at: String,
    pub last_activity: String,
    pub updated_at: String,
    pub running: bool,
    pub transcript_path: String,
    pub last_message_preview: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionDetail {
    pub id: String,
    pub agent: String,
    pub project: String,
    pub transcript_path: String,
    pub cursor: usize,
    pub next_cursor: Option<usize>,
    pub prev_cursor: Option<usize>,
    pub end_of_history: bool,
    pub total_messages: usize,
    pub order: &'static str,
    pub scanned: usize,
    pub valid: usize,
    pub skipped: usize,
    pub messages: Vec<SessionMessage>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionMessage {
    pub id: String,
    pub role: String,
    pub ts: String,
    pub blocks: Vec<SessionMessageBlock>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionMessageBlock {
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Counts {
    pub scanned: usize,
    pub valid: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Totals {
    pub projects: usize,
    pub sessions: usize,
    pub running: usize,
    pub scanned: usize,
    pub valid: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanDiagnostics {
    pub scope: String,
    pub mode: String,
    pub elapsed_ms: u64,
    pub source_roots: Vec<String>,
    pub partial: bool,
    pub errors: Vec<String>,
    pub cache: ScanCacheDiagnostics,
    pub limits: ScanLimits,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanCacheDiagnostics {
    pub enabled: bool,
    pub path: String,
    pub hit: usize,
    pub miss: usize,
    pub stale: usize,
    pub entries_read: usize,
    pub entries_written: usize,
    pub full_rescan: bool,
    pub full_rescan_reason: String,
    pub read_error: String,
    pub write_error: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanLimits {
    pub running_window_secs: i64,
    pub head_bytes: u64,
    pub head_lines: usize,
    pub tail_bytes: u64,
    pub transcript_default_limit: usize,
    pub transcript_max_limit: usize,
    pub max_scan_files: Option<usize>,
}

impl Default for ScanDiagnostics {
    fn default() -> Self {
        Self {
            scope: "unknown".to_owned(),
            mode: "unmeasured".to_owned(),
            elapsed_ms: 0,
            source_roots: Vec::new(),
            partial: false,
            errors: Vec::new(),
            cache: ScanCacheDiagnostics::default(),
            limits: ScanLimits::default(),
        }
    }
}

impl Default for ScanCacheDiagnostics {
    fn default() -> Self {
        Self {
            enabled: false,
            path: String::new(),
            hit: 0,
            miss: 0,
            stale: 0,
            entries_read: 0,
            entries_written: 0,
            full_rescan: false,
            full_rescan_reason: String::new(),
            read_error: String::new(),
            write_error: String::new(),
        }
    }
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            running_window_secs: 0,
            head_bytes: 0,
            head_lines: 0,
            tail_bytes: 0,
            transcript_default_limit: 0,
            transcript_max_limit: 0,
            max_scan_files: None,
        }
    }
}

impl Report {
    pub fn empty(generated_at: String) -> Self {
        Self {
            generated_at,
            scan_scope: "unknown".to_owned(),
            running_total: 0,
            by_project: Vec::new(),
            projects: Vec::new(),
            totals: Totals::default(),
            diagnostics: ScanDiagnostics::default(),
        }
    }

    pub fn from_sessions(sessions: Vec<Session>, generated_at: String) -> Self {
        let count = sessions.len();
        Self::from_sessions_with_counts(
            sessions,
            generated_at,
            Counts {
                scanned: count,
                valid: count,
                skipped: 0,
            },
        )
    }

    pub fn from_sessions_with_counts(
        mut sessions: Vec<Session>,
        generated_at: String,
        counts: Counts,
    ) -> Self {
        sessions.sort_by(|a, b| {
            b.last_activity
                .cmp(&a.last_activity)
                .then_with(|| a.agent.cmp(&b.agent))
                .then_with(|| a.id.cmp(&b.id))
        });

        let running_total = sessions.iter().filter(|session| session.running).count();
        let mut grouped: BTreeMap<String, Vec<Session>> = BTreeMap::new();
        for session in sessions {
            grouped
                .entry(session.project.clone())
                .or_default()
                .push(session);
        }

        let mut by_project: Vec<_> = grouped
            .into_iter()
            .map(|(project, sessions)| project_report(project, sessions))
            .collect();
        by_project.sort_by(|a, b| {
            project_last_activity(b)
                .cmp(project_last_activity(a))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.project.cmp(&b.project))
        });
        let projects = by_project.iter().map(project_summary).collect::<Vec<_>>();
        let totals = Totals {
            projects: by_project.len(),
            sessions: by_project.iter().map(|project| project.total).sum(),
            running: running_total,
            scanned: counts.scanned,
            valid: counts.valid,
            skipped: counts.skipped,
        };

        Self {
            generated_at,
            scan_scope: "unknown".to_owned(),
            running_total,
            by_project,
            projects,
            totals,
            diagnostics: ScanDiagnostics::default(),
        }
    }

    pub fn with_scan_diagnostics(mut self, diagnostics: ScanDiagnostics) -> Self {
        self.scan_scope = diagnostics.scope.clone();
        self.diagnostics = diagnostics;
        self
    }

    pub fn filtered(&self, running_only: bool, project_substr: Option<&str>) -> Self {
        let sessions: Vec<Session> = self
            .by_project
            .iter()
            .flat_map(|project| project.sessions.iter())
            .filter(|session| !running_only || session.running)
            .filter(|session| {
                project_substr
                    .map(|needle| session.project.contains(needle))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        Self::from_sessions_with_counts(
            sessions,
            self.generated_at.clone(),
            Counts {
                scanned: self.totals.scanned,
                valid: self.totals.valid,
                skipped: self.totals.skipped,
            },
        )
        .with_scan_diagnostics(self.diagnostics.clone())
    }
}

fn project_report(project: String, sessions: Vec<Session>) -> ProjectReport {
    let running = sessions.iter().filter(|session| session.running).count();
    let total = sessions.len();
    ProjectReport {
        name: project_name(&project),
        project,
        running,
        total,
        sessions,
    }
}

fn project_summary(project: &ProjectReport) -> ProjectSummary {
    ProjectSummary {
        project: project.name.clone(),
        cwd: project.project.clone(),
        running: project.running,
        total: project.total,
        sessions: project.sessions.iter().map(session_summary).collect(),
    }
}

fn session_summary(session: &Session) -> SessionSummary {
    SessionSummary {
        id: session.id.clone(),
        agent: session.agent.clone(),
        title: session.title.clone(),
        updated_at: session.updated_at.clone(),
        running: session.running,
    }
}

fn project_last_activity(project: &ProjectReport) -> &str {
    project
        .sessions
        .first()
        .map(|session| session.last_activity.as_str())
        .unwrap_or("")
}

fn project_name(project: &str) -> String {
    Path::new(project)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            project
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(project)
                .to_owned()
        })
}
