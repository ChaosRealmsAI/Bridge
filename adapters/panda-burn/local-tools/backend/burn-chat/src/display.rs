mod blocks;
mod claude;
mod codex;
mod git;
mod utils;

use blocks::{add_file_changes, ensure_final_reply};
use claude::add_claude_event_block;
use codex::add_codex_event_block;
pub(crate) use git::git_status_snapshot;
pub(crate) use utils::compact_json;
use utils::{collect_paths, is_user_prompt_event, summarize};

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;

use crate::{tail_text, Agent, ParsedAgentOutput};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChatDisplay {
    pub version: String,
    pub blocks: Vec<DisplayBlock>,
    pub omitted: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DisplayBlock {
    pub id: String,
    pub source: Agent,
    pub kind: String,
    pub priority: String,
    pub marker_label: String,
    pub title: String,
    pub summary: String,
    pub default_collapsed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_json: Option<String>,
}

pub(crate) struct DisplayBuilder {
    pub(crate) source: Agent,
    pub(crate) blocks: Vec<DisplayBlock>,
    pub(crate) omitted: usize,
    pub(crate) skipped: usize,
    pub(crate) paths: BTreeSet<String>,
    pub(crate) next_id: usize,
}

pub fn parse_agent_display_from_jsonl(agent: Agent, contents: &str, reply: &str) -> ChatDisplay {
    let mut builder = display_builder_from_jsonl(agent, contents, reply);
    ensure_final_reply(&mut builder, reply);
    builder.finish()
}

pub fn display_blocks_from_event(agent: Agent, value: &Value) -> Vec<DisplayBlock> {
    let mut builder = DisplayBuilder::new(agent);
    match agent {
        Agent::Claude => add_claude_event_block(&mut builder, value),
        Agent::Codex => add_codex_event_block(&mut builder, value),
    }
    if builder.blocks.is_empty() {
        let raw = compact_json(value);
        builder.push(
            "raw_json",
            "low",
            "JSON",
            "Runtime JSON",
            summarize(&raw),
            true,
            None,
            None,
            Vec::new(),
            Some(raw),
        );
    }
    builder.blocks
}

pub(crate) fn build_chat_display(
    agent: Agent,
    parsed: &ParsedAgentOutput,
    source_events: Option<&[Value]>,
    _project: &Path,
    git_before: Option<&HashMap<String, String>>,
    git_after: Option<&HashMap<String, String>>,
) -> ChatDisplay {
    let transcript_builder = || {
        parsed
            .transcript_path
            .as_deref()
            .and_then(|path| fs::read_to_string(path).ok())
            .map(|contents| display_builder_from_jsonl(agent, &contents, &parsed.reply))
    };
    let events_builder =
        || source_events.map(|values| display_builder_from_values(agent, values, &parsed.reply));
    let mut builder = match agent {
        Agent::Codex => events_builder().or_else(transcript_builder),
        Agent::Claude => transcript_builder().or_else(events_builder),
    }
    .unwrap_or_else(|| DisplayBuilder::new(agent));

    add_file_changes(&mut builder, git_before, git_after);
    ensure_final_reply(&mut builder, &parsed.reply);
    builder.finish()
}

fn display_builder_from_values(agent: Agent, values: &[Value], reply: &str) -> DisplayBuilder {
    let start = values
        .iter()
        .rposition(|value| is_user_prompt_event(agent, value))
        .map(|idx| idx + 1)
        .unwrap_or_else(|| values.len().saturating_sub(120));

    let mut builder = DisplayBuilder::new(agent);
    for value in values.iter().skip(start) {
        match agent {
            Agent::Claude => add_claude_event_block(&mut builder, value),
            Agent::Codex => add_codex_event_block(&mut builder, value),
        }
    }
    ensure_final_reply(&mut builder, reply);
    builder
}

fn display_builder_from_jsonl(agent: Agent, contents: &str, reply: &str) -> DisplayBuilder {
    let mut values = Vec::new();
    let mut skipped = 0;
    for line in contents.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => values.push(value),
            Err(_) => skipped += 1,
        }
    }

    let start = values
        .iter()
        .rposition(|value| is_user_prompt_event(agent, value))
        .map(|idx| idx + 1)
        .unwrap_or_else(|| values.len().saturating_sub(120));

    let mut builder = DisplayBuilder::new(agent);
    builder.skipped = skipped;
    for value in values.iter().skip(start) {
        match agent {
            Agent::Claude => add_claude_event_block(&mut builder, value),
            Agent::Codex => add_codex_event_block(&mut builder, value),
        }
    }
    if builder.blocks.is_empty() && !reply.trim().is_empty() {
        builder.push(
            "final_text",
            "high",
            "最终",
            "最终回复",
            summarize(reply),
            false,
            Some(reply.to_string()),
            None,
            Vec::new(),
            None,
        );
    }
    builder
}

impl DisplayBuilder {
    fn new(source: Agent) -> Self {
        Self {
            source,
            blocks: Vec::new(),
            omitted: 0,
            skipped: 0,
            paths: BTreeSet::new(),
            next_id: 1,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push(
        &mut self,
        kind: &str,
        priority: &str,
        marker_label: &str,
        title: &str,
        summary: String,
        default_collapsed: bool,
        text: Option<String>,
        detail: Option<String>,
        items: Vec<String>,
        raw_json: Option<String>,
    ) {
        let block = self.make_block(
            kind,
            priority,
            marker_label,
            title,
            summary,
            default_collapsed,
            text,
            detail,
            items,
            raw_json,
        );
        self.blocks.push(block);
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_at_start(
        &mut self,
        kind: &str,
        priority: &str,
        marker_label: &str,
        title: &str,
        summary: &str,
        default_collapsed: bool,
        text: Option<String>,
        detail: Option<String>,
        items: Vec<String>,
        raw_json: Option<String>,
    ) {
        let block = self.make_block(
            kind,
            priority,
            marker_label,
            title,
            summary.to_string(),
            default_collapsed,
            text,
            detail,
            items,
            raw_json,
        );
        self.blocks.insert(0, block);
    }

    #[allow(clippy::too_many_arguments)]
    fn make_block(
        &mut self,
        kind: &str,
        priority: &str,
        marker_label: &str,
        title: &str,
        summary: String,
        default_collapsed: bool,
        text: Option<String>,
        detail: Option<String>,
        items: Vec<String>,
        raw_json: Option<String>,
    ) -> DisplayBlock {
        let id = format!("{}-{}", self.source.as_str(), self.next_id);
        self.next_id += 1;
        DisplayBlock {
            id,
            source: self.source,
            kind: kind.to_string(),
            priority: priority.to_string(),
            marker_label: marker_label.to_string(),
            title: title.to_string(),
            summary,
            default_collapsed,
            text: text.map(|value| tail_text(&value, 8_000)),
            detail: detail.map(|value| tail_text(&value, 4_000)),
            items,
            raw_json,
        }
    }

    pub(crate) fn collect_paths(&mut self, value: &Value) {
        collect_paths(value, None, &mut self.paths);
    }

    fn finish(self) -> ChatDisplay {
        ChatDisplay {
            version: "display.v1".to_string(),
            blocks: self.blocks,
            omitted: self.omitted,
            skipped: self.skipped,
        }
    }
}
