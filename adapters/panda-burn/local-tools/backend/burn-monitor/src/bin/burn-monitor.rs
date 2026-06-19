use anyhow::{Context, Result};
use burn_monitor::{Report, SessionMessageBlock};
use clap::{Args, Parser, Subcommand};
use notify::{RecursiveMode, Watcher};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;
use std::sync::mpsc;

#[derive(Parser)]
#[command(name = "burn-monitor")]
#[command(about = "Scan and watch local Codex and Claude Code sessions")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    List(ListArgs),
    Show(ShowArgs),
    Watch(WatchArgs),
}

#[derive(Args)]
struct ListArgs {
    #[arg(long)]
    running: bool,
    #[arg(long)]
    project: Option<String>,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ShowArgs {
    #[arg(long)]
    id: String,
    #[arg(long, value_parser = ["codex", "claude"])]
    agent: Option<String>,
    #[arg(long)]
    project: Option<PathBuf>,
    #[arg(long, default_value_t = 0)]
    cursor: usize,
    #[arg(long, default_value_t = burn_monitor::default_limit())]
    limit: usize,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct WatchArgs {
    #[arg(long)]
    json: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        process::exit(1);
    }
}

fn run() -> Result<()> {
    match Cli::parse().command {
        Command::List(args) => list(args),
        Command::Show(args) => show(args),
        Command::Watch(args) => watch(args),
    }
}

fn list(args: ListArgs) -> Result<()> {
    let report = burn_monitor::scan().filtered(args.running, args.project.as_deref());
    print_report(&report, args.json)
}

fn show(args: ShowArgs) -> Result<()> {
    let detail = if let Some(project) = args.project.as_deref() {
        burn_monitor::show_session_in_project_for_agent(
            project,
            &args.id,
            args.agent.as_deref(),
            args.cursor,
            args.limit,
        )?
    } else {
        burn_monitor::show_session_for_agent(
            &args.id,
            args.agent.as_deref(),
            args.cursor,
            args.limit,
        )?
    };
    if args.json {
        println!("{}", serde_json::to_string_pretty(&detail)?);
    } else {
        println!(
            "{} {} messages={} transcript={}",
            detail.agent,
            detail.id,
            detail.messages.len(),
            detail.transcript_path
        );
        print_transcript(&detail.messages);
    }
    Ok(())
}

fn watch(args: WatchArgs) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).context("create file watcher")?;
    let watched = watch_existing_roots(&mut watcher)?;

    if watched == 0 {
        eprintln!("no session roots exist under HOME");
    }
    print_watch_snapshot(args.json, None)?;

    for event in rx {
        match event {
            Ok(event) => print_watch_snapshot(args.json, event.paths.first().cloned())?,
            Err(error) => eprintln!("watch error: {error}"),
        }
    }
    Ok(())
}

fn watch_existing_roots(watcher: &mut notify::RecommendedWatcher) -> Result<usize> {
    let mut watched = 0;
    for root in burn_monitor::source_roots()
        .into_iter()
        .filter(|root| root.exists())
    {
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .with_context(|| format!("watch {}", root.display()))?;
        watched += 1;
    }
    Ok(watched)
}

fn print_watch_snapshot(json: bool, changed: Option<PathBuf>) -> Result<()> {
    let report = burn_monitor::scan();
    if json {
        println!("{}", serde_json::to_string(&report)?);
    } else {
        let total: usize = report.by_project.iter().map(|project| project.total).sum();
        let changed = changed
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "initial".to_owned());
        println!(
            "{} running_total={} total={} projects={} changed={}",
            report.generated_at,
            report.running_total,
            total,
            report.by_project.len(),
            changed
        );
    }
    io::stdout().flush()?;
    Ok(())
}

fn print_report(report: &Report, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
    } else {
        print_table(report);
    }
    Ok(())
}

fn print_table(report: &Report) {
    println!(
        "generated_at={} running_total={}",
        report.generated_at, report.running_total
    );
    for project in &report.by_project {
        println!(
            "\n{} ({}/{}) {}",
            project.name, project.running, project.total, project.project
        );
        println!("RUN  AGENT   LAST_ACTIVITY        ID        TITLE");
        for session in &project.sessions {
            println!(
                "{:<4} {:<7} {:<20} {:<9} {}",
                if session.running { "yes" } else { "no" },
                session.agent,
                session.last_activity,
                short_id(&session.id),
                session.title
            );
        }
    }
}

fn print_transcript(messages: &[burn_monitor::SessionMessage]) {
    for message in messages {
        let ts = if message.ts.is_empty() {
            "-"
        } else {
            &message.ts
        };
        println!("{} {} {}", ts, message.role, message.id);
        for block in &message.blocks {
            println!("  {}", block_preview(block));
        }
    }
}

fn block_preview(block: &SessionMessageBlock) -> String {
    let text = block.text.replace('\n', " ");
    if text.is_empty() {
        block.kind.clone()
    } else {
        text
    }
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}
