//! `hcom list` command — list active instances.
//!
//!
//! Supports: human-readable, --json, --names, --format, -v,
//! single instance query (self/named), full listing with unread counts.
//!
//! Unread mail that is HELD is reported apart from unread mail that is about to
//! be picked up: `+3 (2 held)` in the human render, `held_count` in `--json`.
//! HELD means the row *waits* on something else, and that is the protocol the
//! shipped client plugins implement: an idle (`listening`) lane-aware recipient
//! polls its unread, and `decideInjection` delivers BOTH lanes there as a
//! prompt — nothing waits at idle. The wait exists against a live turn, where a
//! `queue` row rides to the turn boundary and only a `steer` interrupts it, and
//! at an actor that is not polling at all. So a row is held when its lane is
//! not `steer`, it sits past the recipient's cursor, and the recipient's
//! *computed* status is not `listening` (a turn in flight, a launch that has not
//! reached its poll loop, or an actor that is no longer running). That status is
//! snapshotted once per command, so the count and the status printed beside it
//! always come from one read. CAVEAT: the count assumes the recipient runs a
//! lane-aware plugin; without one a `queue` row is injected as soon as the
//! recipient polls, and never waits for a turn boundary. This is a surface over
//! a rule that already exists — it changes no delivery, ack or cursor
//! behaviour.

use std::collections::HashMap;

use crate::db::{HcomDb, InstanceRow};
use crate::identity;
use crate::identity::{get_full_name, resolve_display_name};
use crate::instance_lifecycle::{
    ComputedStatus, RECENTLY_STOPPED_WINDOW, cleanup_stale_instances, cleanup_stale_placeholders,
    format_age, get_instance_status,
};
use crate::instances::is_remote_instance;
use crate::shared::{
    CommandContext, SENDER, ST_LISTENING, shorten_path, shorten_path_max, status_icon,
};

/// Parsed arguments for `hcom list`.
#[derive(clap::Parser, Debug)]
#[command(name = "list", about = "List active agents")]
pub struct ListArgs {
    /// Agent name or "self"
    pub name: Option<String>,
    /// Field to extract (used with name)
    pub field: Option<String>,
    /// Show recently stopped agents
    #[arg(long)]
    pub stopped: bool,
    /// JSON output
    #[arg(long)]
    pub json: bool,
    /// Verbose output
    #[arg(short = 'v', long)]
    pub verbose: bool,
    /// Names-only output
    #[arg(long)]
    pub names: bool,
    /// Shell export format
    #[arg(long)]
    pub sh: bool,
    /// Custom format template with {field} placeholders
    #[arg(long)]
    pub format: Option<String>,
    /// Show all (with --stopped)
    #[arg(long)]
    pub all: bool,
    /// Limit results (with --stopped)
    #[arg(long)]
    pub last: Option<usize>,
}

/// Get unread message count for a single instance.
fn get_unread_count(db: &HcomDb, name: &str, last_event_id: i64) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE id > ? AND type = 'message'
             AND EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.delivered_to')) WHERE value = ?)",
            rusqlite::params![last_event_id, name],
            |row| row.get(0),
        )
        .unwrap_or(0)
}

/// Get unread counts for all instances in batch.
fn get_unread_counts_batch(db: &HcomDb, instances: &[InstanceRow]) -> HashMap<String, i64> {
    let mut counts = HashMap::new();
    for inst in instances {
        if is_remote_instance(inst) {
            continue;
        }
        let count = get_unread_count(db, &inst.name, inst.last_event_id);
        if count > 0 {
            counts.insert(inst.name.clone(), count);
        }
    }
    counts
}

/// Count unread messages that are HELD at `name`: rows on a lane other than
/// `steer` that sit past the recipient's cursor while the recipient is not
/// polling for them.
///
/// `steer` is the lane that never waits — it interrupts a live turn, and is
/// otherwise delivered like any other lane. Every other lane waits: a `queue`
/// row rides a live turn to its boundary, and at an actor that is not running
/// nothing picks it up at all. So the recipient half is inverted relative to
/// the intuitive reading of "idle": an idle (`listening`) lane-aware recipient
/// polls, and `decideInjection` delivers both lanes there.
///
/// The lane half is the delivery path's own normalization, written in SQL: a
/// row is on the steer lane only when `$.delivery` is exactly `steer`, and
/// every other value — omitted, `auto` (retired as a sending lane but still
/// present in mailboxes), unknown, or a non-string — is the fail-closed
/// `queue` (see `crate::db::events`, and `laneOf` in both plugins). `IS NOT`
/// rather than `!=` so a NULL `json_extract` (absent lane) is queue, not
/// NULL-and-therefore-dropped.
///
/// The caller applies the recipient half (`held_count_for` /
/// `get_held_counts_batch`); this is the row half.
fn get_held_count(db: &HcomDb, name: &str, last_event_id: i64) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE id > ? AND type = 'message'
             AND json_extract(data, '$.delivery') IS NOT 'steer'
             AND EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.delivered_to')) WHERE value = ?)",
            rusqlite::params![last_event_id, name],
            |row| row.get(0),
        )
        .unwrap_or(0)
}

/// The status snapshot for one run of `hcom list`, keyed by instance name.
///
/// `get_instance_status` is impure — it reads the clock and the wake-grace
/// state, and it finalizes a launch-failure detail — and it is the recipient
/// half of the held rule. Every consumer in one command must therefore read the
/// same value: the held projection and the rows that print/emit a status all
/// take this snapshot, so a count contradicting the status beside it is
/// impossible by construction rather than merely unlikely. Callers index it
/// with a name from the same `instances` slice.
fn instance_statuses(db: &HcomDb, instances: &[InstanceRow]) -> HashMap<String, ComputedStatus> {
    instances
        .iter()
        .map(|inst| (inst.name.clone(), get_instance_status(inst, db)))
        .collect()
}

/// Held count for one instance, given the status that instance already renders.
///
/// Both halves of the rule are HCOM-owned data: the row's lane and id vs the
/// recipient's cursor (`instances.last_event_id`) and its status. HELD is the
/// row that *waits*, so the recipient half is "not idle": an idle (`listening`)
/// lane-aware recipient polls its unread and injects it, a live turn takes a
/// `queue` row at its boundary, and an actor that is not running takes it
/// whenever it next runs. The status is the *computed* one — the very string
/// the row prints and emits as `status`, from the caller's one-per-command
/// snapshot — so a held count can never contradict the status beside it. A
/// remote instance is left at 0, matching `get_unread_counts_batch`.
///
/// See the module docs for the lane-aware-plugin caveat.
fn held_count_for(db: &HcomDb, data: &InstanceRow, status: &str) -> i64 {
    if status == ST_LISTENING || is_remote_instance(data) {
        return 0;
    }
    get_held_count(db, &data.name, data.last_event_id)
}

/// Get HELD counts for all instances in batch, keyed by instance name, from the
/// caller's status snapshot.
fn get_held_counts_batch(
    db: &HcomDb,
    instances: &[InstanceRow],
    statuses: &HashMap<String, ComputedStatus>,
) -> HashMap<String, i64> {
    let mut counts = HashMap::new();
    for inst in instances {
        let count = held_count_for(db, inst, &statuses[&inst.name].status);
        if count > 0 {
            counts.insert(inst.name.clone(), count);
        }
    }
    counts
}

/// The `(unread, held)` pair for one instance, with held floored at unread.
///
/// The two counts are separate reads of the same mailbox, so they can disagree
/// by a row consumed in between. Held is a subset of unread by definition, so
/// the reported held is clamped to the reported unread: one payload can never
/// carry `unread_count: 0` beside `held_count: 1`, and the human marker cannot
/// vanish because `unread_suffix(0, n)` is empty.
fn unread_and_held(
    unread_counts: &HashMap<String, i64>,
    held_counts: &HashMap<String, i64>,
    name: &str,
) -> (i64, i64) {
    let unread = unread_counts.get(name).copied().unwrap_or(0);
    let held = held_counts.get(name).copied().unwrap_or(0).min(unread);
    (unread, held)
}

/// Human unread marker: ` +3`, or ` +3 (2 held)` when some of it is waiting on
/// the recipient. Non-zero held only — the common case renders as before.
fn unread_suffix(unread: i64, held: i64) -> String {
    if unread <= 0 {
        return String::new();
    }
    if held > 0 {
        format!(" +{unread} ({held} held)")
    } else {
        format!(" +{unread}")
    }
}

/// Main entry point for `hcom list` command.
///
/// Returns exit code (0 = success, 1 = error).
pub fn cmd_list(db: &HcomDb, args: &ListArgs, ctx: Option<&CommandContext>) -> i32 {
    // Clean up stale placeholders and instances
    cleanup_stale_placeholders(db);
    let _ = cleanup_stale_instances(db, 3600, 3600);

    let explicit_name = ctx.and_then(|c| c.explicit_name.as_deref());

    // --stopped: show recently stopped instances from life events
    if args.stopped {
        return cmd_list_stopped(db, args);
    }

    let json_output = args.json;
    let verbose_output = args.verbose;
    let names_output = args.names;
    let sh_output = args.sh;
    let format_template = args.format.clone();
    let target_name = args.name.as_deref();
    let field_name = args.field.as_deref();

    // Resolve current instance identity
    let (sender_identity, current_name) = if let Some(id) = ctx.and_then(|c| c.identity.as_ref()) {
        (Some(id.clone()), Some(id.name.clone()))
    } else if let Some(name) = explicit_name {
        match identity::resolve_identity(db, Some(name), None, None, None, None, None) {
            Ok(id) => {
                let n = id.name.clone();
                (Some(id), Some(n))
            }
            Err(e) => {
                eprintln!("Error: Cannot resolve '{name}': {e}");
                return 1;
            }
        }
    } else {
        identity::resolve_identity(db, None, None, None, None, None, None)
            .map(|id| {
                let n = id.name.clone();
                (Some(id), Some(n))
            })
            .unwrap_or((None, None))
    };

    // Single instance query: hcom list <name|self> [field] [--json]
    if let Some(target) = target_name {
        let is_self = target == "self";

        if is_self && sender_identity.is_none() {
            eprintln!("Error: Cannot use 'self' without identity. Run 'hcom start' first.");
            return 1;
        }

        let lookup_name = if is_self {
            current_name.clone().unwrap_or_default()
        } else {
            let resolved = resolve_display_name(db, target);
            resolved.unwrap_or_else(|| target.to_string())
        };

        if lookup_name.is_empty() {
            eprintln!("Error: No name to look up.");
            return 1;
        }

        match db.get_instance_full(&lookup_name) {
            Ok(Some(data)) => {
                let mut payload = serde_json::json!({
                    "name": lookup_name,
                    "session_id": data.session_id,
                    "status": data.status,
                    "directory": data.directory,
                    "transcript_path": data.transcript_path,
                    "parent_name": data.parent_name,
                    "agent_id": data.agent_id,
                    "tool": data.tool,
                });

                if is_self
                    && let Some(id) = &sender_identity
                    && let Some(sid) = &id.session_id
                {
                    payload["session_id"] = serde_json::json!(sid);
                }

                if let Some(field) = field_name {
                    println!("{}", extract_field_value(&payload, field));
                } else if sh_output {
                    print_sh_exports(&payload);
                } else if json_output {
                    println!("{}", serde_json::to_string(&payload).unwrap_or_default());
                } else {
                    print_instance_details(db, &data, &lookup_name);
                }
                return 0;
            }
            _ => {
                if is_self {
                    let payload = serde_json::json!({
                        "name": lookup_name,
                        "session_id": sender_identity.as_ref().and_then(|id| id.session_id.as_deref()).unwrap_or(""),
                    });
                    if let Some(field) = field_name {
                        println!("{}", extract_field_value(&payload, field));
                    } else if sh_output {
                        print_sh_exports(&payload);
                    } else if json_output {
                        println!("{}", serde_json::to_string(&payload).unwrap_or_default());
                    } else {
                        println!("{lookup_name}");
                    }
                    return 0;
                } else {
                    eprintln!("Error: Not found: {target}");
                    eprintln!("Use 'hcom list' to see active agents.");
                    return 1;
                }
            }
        }
    }

    // Full listing mode
    let sorted_instances = match db.iter_instances_full() {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("Error: {e}");
            return 1;
        }
    };

    let unread_counts = get_unread_counts_batch(db, &sorted_instances);

    if names_output {
        for data in &sorted_instances {
            println!("{}", get_full_name(data));
        }
        return 0;
    }

    // Held counts are computed only for the output paths that render them: the
    // names/--stopped paths stay as cheap as they were. The statuses are
    // snapshotted once here and reused by both the held projection and the rows
    // that print/emit a status, so the two cannot disagree.
    let statuses = instance_statuses(db, &sorted_instances);
    let held_counts = get_held_counts_batch(db, &sorted_instances, &statuses);

    if json_output || format_template.is_some() {
        let mut result_list: Vec<serde_json::Value> = Vec::new();

        for data in &sorted_instances {
            let full_name = get_full_name(data);
            let cs = &statuses[&data.name];
            let (status, description, age_seconds) =
                (cs.status.as_str(), cs.description.as_str(), cs.age_seconds);
            let (unread, held) = unread_and_held(&unread_counts, &held_counts, &data.name);

            // Get binding status
            let hooks_bound = db.has_session_binding(&data.name);
            let process_bound = db.has_process_binding_for_instance(&data.name);

            // Parse launch_context JSON
            let launch_context: serde_json::Value = data
                .launch_context
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::json!({}));

            let payload = serde_json::json!({
                "name": full_name,
                "status": status,
                "status_context": data.status_context,
                "status_detail": data.status_detail,
                "status_age_seconds": age_seconds,
                "description": description,
                "unread_count": unread,
                // Additive: unread rows that wait on the recipient (lane rule),
                // floored at `unread_count` so the pair is never self-refuting.
                "held_count": held,
                "headless": data.background != 0,
                "session_id": data.session_id.as_deref().unwrap_or(""),
                "directory": data.directory,
                "parent_name": data.parent_name,
                "agent_id": data.agent_id,
                "background_log_file": if data.background_log_file.is_empty() { None } else { Some(&data.background_log_file) },
                "transcript_path": if data.transcript_path.is_empty() { None } else { Some(&data.transcript_path) },
                "created_at": data.created_at,
                "tag": data.tag,
                "tool": data.tool,
                "base_name": data.name,
                "hooks_bound": hooks_bound,
                "process_bound": process_bound,
                "launch_context": launch_context,
            });
            result_list.push(payload);
        }

        if let Some(ref template) = format_template {
            // Validate template keys against first payload (error on unknown fields)
            if let Some(first) = result_list.first()
                && let Some(obj) = first.as_object()
            {
                // Find all {key} placeholders in template
                let mut i = 0;
                let bytes = template.as_bytes();
                while i < bytes.len() {
                    if bytes[i] == b'{'
                        && let Some(end) = template[i + 1..].find('}')
                    {
                        let key = &template[i + 1..i + 1 + end];
                        if !key.is_empty() && !obj.contains_key(key) {
                            eprintln!("Error: unknown field '{{{}}}' in --format template", key);
                            return 1;
                        }
                        i += end + 2;
                        continue;
                    }
                    i += 1;
                }
            }
            for payload in &result_list {
                let obj = payload.as_object().unwrap();
                let mut line = template.clone();
                for (key, val) in obj {
                    let replacement = match val {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Null => String::new(),
                        other => other.to_string(),
                    };
                    line = line.replace(&format!("{{{key}}}"), &replacement);
                }
                println!("{line}");
            }
        } else {
            println!(
                "{}",
                serde_json::to_string(&result_list).unwrap_or_default()
            );
        }
        return 0;
    }

    // Human-readable output
    let display_name = if let Some(ref name) = current_name {
        if name != SENDER {
            if let Ok(Some(data)) = db.get_instance_full(name) {
                get_full_name(&data)
            } else {
                name.clone()
            }
        } else {
            name.clone()
        }
    } else {
        String::new()
    };

    if !display_name.is_empty() {
        println!("Your name: {display_name}");
    } else {
        println!("Your name: (not participating)");
    }
    println!();

    // Check if multiple tool types exist
    let mut tool_types = std::collections::HashSet::new();
    for data in &sorted_instances {
        tool_types.insert(data.tool.clone());
    }
    let show_tool = tool_types.len() > 1;

    // Check if multiple directories
    let mut directories = std::collections::HashSet::new();
    for data in &sorted_instances {
        if !data.directory.is_empty() {
            directories.insert(data.directory.clone());
        }
    }

    // Compute name column width
    let mut max_name_len = 0;
    for data in &sorted_instances {
        let mut n = get_full_name(data).len();
        if data.background != 0 {
            n += 11; // " [headless]"
        }
        if is_remote_instance(data) {
            n += 9; // " [remote]"
        }
        let (uc, hc) = unread_and_held(&unread_counts, &held_counts, &data.name);
        n += unread_suffix(uc, hc).len();
        max_name_len = max_name_len.max(n);
    }
    let name_col_width = (max_name_len + 2).max(14);

    for data in &sorted_instances {
        let name = get_full_name(data);
        let cs = &statuses[&data.name];
        let (status, age_str, description) =
            (cs.status.as_str(), cs.age_string.as_str(), cs.description.as_str());
        let icon = status_icon(status);

        let age_display = if age_str == "now" {
            age_str.to_string()
        } else if !age_str.is_empty() {
            format!("{age_str} ago")
        } else {
            String::new()
        };

        let desc_sep = if !description.is_empty() { ": " } else { "" };

        // Tool prefix — binding state encoding:
        // UPPER = pty+hooks, lower = hooks only, UPPER* = pty only, lower* = no binding
        let tool_prefix = if show_tool {
            let hooks_bound = db.has_session_binding(&data.name);
            let process_bound = db.has_process_binding_for_instance(&data.name);
            let tool_display = if data.tool == "adhoc" {
                "ad-hoc".to_string()
            } else if process_bound && hooks_bound {
                data.tool.to_uppercase()
            } else if process_bound {
                format!("{}*", data.tool.to_uppercase())
            } else if hooks_bound {
                data.tool.to_lowercase()
            } else {
                format!("{}*", data.tool.to_lowercase())
            };
            let padded = format!("[{tool_display}]");
            format!("{padded:<10}")
        } else {
            String::new()
        };

        // Badges
        let headless_badge = if data.background != 0 {
            " [headless]"
        } else {
            ""
        };
        let remote_badge = if is_remote_instance(data) {
            " [remote]"
        } else {
            ""
        };

        // Unread, with the part that waits on the recipient marked beside it
        let (unread, held) = unread_and_held(&unread_counts, &held_counts, &data.name);
        let unread_str = unread_suffix(unread, held);

        // Listening-since suffix: show idle duration for listening agents idle >= 60s
        let listening_since = if status == ST_LISTENING && cs.age_seconds >= 60 {
            format!(" since {}", format_age(cs.age_seconds))
        } else {
            String::new()
        };

        // Subagent timeout marker: show countdown when < 10s remaining
        let timeout_marker = if status == ST_LISTENING && data.parent_session_id.is_some() {
            let timeout = if let Some(ref parent_name) = data.parent_name {
                db.get_instance_full(parent_name)
                    .ok()
                    .flatten()
                    .and_then(|p| p.subagent_timeout)
            } else {
                None
            }
            .unwrap_or_else(|| crate::config::load_config_snapshot().core.subagent_timeout);
            let remaining = timeout.saturating_sub(cs.age_seconds);
            if remaining > 0 && remaining < 10 {
                format!(" \u{23f1} {remaining}s")
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        let name_part = format!("{name}{headless_badge}{remote_badge}{unread_str}");
        let status_text =
            format!("{age_display}{desc_sep}{description}{listening_since}{timeout_marker}");

        println!(
            "{tool_prefix}{icon} {name_part:<width$}{status_text}",
            width = name_col_width
        );

        if verbose_output {
            let session_id = data.session_id.as_deref().unwrap_or("(none)");
            let directory_display = if data.directory.is_empty() {
                "(none)".to_string()
            } else {
                shorten_path_max(&data.directory, 60)
            };
            let parent = data.parent_name.as_deref().unwrap_or("(none)");
            let tool_display = if data.tool == "adhoc" {
                "ad-hoc"
            } else {
                &data.tool
            };

            let created_str = if data.created_at > 0.0 {
                let now = crate::shared::time::now_epoch_f64();
                let age_f = now - data.created_at;
                // format_age takes i64 where 0 → "now". Use f64 threshold
                // so sub-second ages display as "0s" instead of "now".
                let age_str = if age_f <= 0.0 {
                    "now".to_string()
                } else {
                    let secs = age_f as i64;
                    if secs < 60 {
                        format!("{secs}s")
                    } else {
                        format_age(secs)
                    }
                };
                format!("{age_str} ago")
            } else {
                "(unknown)".to_string()
            };

            println!("    session_id:   {session_id}");
            println!("    tool:         {tool_display}");
            println!("    created:      {created_str}");
            println!("    directory:    {directory_display}");

            if parent != "(none)" {
                println!("    parent:       {parent}");
                let agent_id = data.agent_id.as_deref().unwrap_or("(none)");
                println!("    agent_id:     {agent_id}");
            }

            // Binding status
            let hooks_bound = db.has_session_binding(&data.name);
            let process_bound = db.has_process_binding_for_instance(&data.name);
            let bind_str = match (hooks_bound, process_bound) {
                (true, true) => "hooks, pty",
                (true, false) => "hooks",
                (false, true) => "pty",
                (false, false) => "none",
            };
            println!("    bindings:     {bind_str}");

            let transcript = if data.transcript_path.is_empty() {
                "(none)".to_string()
            } else {
                shorten_path_max(&data.transcript_path, 60)
            };
            if data.background != 0 && !data.background_log_file.is_empty() {
                println!(
                    "    headless log: {}",
                    shorten_path_max(&data.background_log_file, 60)
                );
            }
            println!("    transcript:   {transcript}");

            if !data.status_detail.is_empty() {
                let detail = if data.status_detail.len() > 60 {
                    let end = (0..=60)
                        .rev()
                        .find(|&i| data.status_detail.is_char_boundary(i))
                        .unwrap_or(0);
                    format!("{}...", &data.status_detail[..end])
                } else {
                    data.status_detail.clone()
                };
                println!("    detail:       {detail}");
            }
            println!();
        }
    }

    if sorted_instances.is_empty() {
        println!("No active agents. Launch one with: hcom claude");
    }

    // Recently stopped summary
    let active_names: std::collections::HashSet<String> =
        sorted_instances.iter().map(|d| d.name.clone()).collect();
    let recently_stopped = get_recently_stopped(db, &active_names);
    if !recently_stopped.is_empty() {
        let names = if recently_stopped.len() <= 5 {
            recently_stopped.join(", ")
        } else {
            format!(
                "{} +{}",
                recently_stopped[..5].join(", "),
                recently_stopped.len() - 5
            )
        };
        println!("\nRecently stopped (10m): {names}");
        println!("  -> hcom list --stopped [name]");
    }

    // Hint about archives if no instances
    if sorted_instances.is_empty() {
        let archive_dir = crate::paths::hcom_dir().join("archive");
        if archive_dir.exists()
            && let Ok(entries) = std::fs::read_dir(&archive_dir)
        {
            let archive_count = entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .map(|s| s.starts_with("session-"))
                        .unwrap_or(false)
                })
                .count();
            if archive_count > 0 {
                let plural = if archive_count != 1 { "s" } else { "" };
                println!("({archive_count} archived session{plural} - run: hcom archive)");
            }
        }
    }

    0
}

fn print_instance_details(db: &HcomDb, data: &InstanceRow, display_name: &str) {
    let cs = get_instance_status(data, db);
    let status = cs.status;

    // Status line construction
    let status_line = if data.status_context.is_empty() {
        status.clone()
    } else {
        format!("{status} ({})", data.status_context)
    };

    println!("{display_name}:");

    // Core Identity
    let headless_str = if data.background != 0 {
        " (Headless)"
    } else {
        ""
    };
    let tool_display = if data.tool == "adhoc" {
        "ad-hoc"
    } else {
        &data.tool
    };
    println!("  Tool:        {tool_display}{headless_str}");

    if let Some(ref term) = data
        .terminal_preset_effective
        .as_ref()
        .or(data.terminal_preset_requested.as_ref())
        && !term.is_empty()
    {
        println!("  Terminal:    {term}");
    }

    let session_id = data.session_id.as_deref().unwrap_or("(none)");
    println!("  Session:     {session_id}");

    if let Some(ref tag) = data.tag
        && !tag.is_empty()
    {
        println!("  Tag:         {tag}");
    }

    // Status & Connection
    println!("  Status:      {status_line}");
    if !data.status_detail.is_empty() {
        println!("  Detail:      {}", data.status_detail);
    }

    // Uptime and Age
    let now = crate::shared::time::now_epoch_f64();
    if data.status_time > 0 {
        let state_age = now - (data.status_time as f64);
        if state_age > 0.0 {
            println!("  State Age:   {}", format_age(state_age as i64));
        }
    }
    if data.created_at > 0.0 {
        let uptime = now - data.created_at;
        if uptime > 0.0 {
            println!("  Uptime:      {}", format_age(uptime as i64));
        }
    }

    // Unread Count
    let unread = get_unread_count(db, &data.name, data.last_event_id);
    if unread > 0 {
        let s = if unread == 1 { "" } else { "s" };
        println!("  Unread:      {unread} message{s}");
    }

    // Bindings
    let hooks_bound = db.has_session_binding(&data.name);
    let process_bound = db.has_process_binding_for_instance(&data.name);
    let bind_str = match (hooks_bound, process_bound) {
        (true, true) => "hooks, pty",
        (true, false) => "hooks",
        (false, true) => "pty",
        (false, false) => "none",
    };
    println!("  Bindings:    {bind_str}");

    if let Some(pid) = data.pid {
        println!("  PID:         {pid}");
    }

    // Hierarchy
    if let Some(ref parent) = data.parent_name
        && !parent.is_empty()
    {
        println!("  Parent:      {parent}");
        if let Some(ref agent_id) = data.agent_id
            && !agent_id.is_empty()
        {
            println!("  Agent ID:    {agent_id}");
        }

        // Subagent Timeout
        let timeout = data
            .subagent_timeout
            .unwrap_or_else(|| crate::config::load_config_snapshot().core.subagent_timeout);
        let remaining = timeout.saturating_sub(cs.age_seconds);
        if status == ST_LISTENING && remaining > 0 {
            println!("  Timeout:     {}s remaining", remaining);
        }
    }

    // Paths
    println!("  Directory:   {}", shorten_path_max(&data.directory, 80));

    if !data.transcript_path.is_empty() {
        println!("  Transcript:  {}", shorten_path(&data.transcript_path));
    }

    if data.background != 0 && !data.background_log_file.is_empty() {
        println!("  Log File:    {}", shorten_path(&data.background_log_file));
    }
}

/// Extract a field value from a JSON payload, normalizing booleans to "1"/"0".
fn extract_field_value(payload: &serde_json::Value, field: &str) -> String {
    match payload.get(field) {
        Some(serde_json::Value::Bool(b)) => if *b { "1" } else { "0" }.to_string(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Null) => String::new(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// Print shell-export format for `hcom list --sh`.
fn print_sh_exports(payload: &serde_json::Value) {
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let status = payload
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let directory = payload
        .get("directory")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    println!("export HCOM_INSTANCE_NAME={}", shell_quote(name));
    println!("export HCOM_SID={}", shell_quote(session_id));
    println!("export HCOM_STATUS={}", shell_quote(status));
    println!("export HCOM_DIRECTORY={}", shell_quote(directory));
}

use crate::tools::args_common::shell_quote;

/// `hcom list --stopped [name] [--all] [--last N]` — show stopped instances from life events.
/// Without a name: shows recent stopped (default last 20, use --all for unlimited).
/// With a name: shows details for that specific stopped instance.
/// Uses human-friendly formatting rather than raw JSON for readability.
fn cmd_list_stopped(db: &HcomDb, args: &ListArgs) -> i32 {
    use rusqlite::params;

    let show_all = args.all;
    let last_n: usize = args.last.unwrap_or(20);
    let filter_name = args.name.as_deref();

    let now = crate::shared::time::now_epoch_f64();

    let limit = if show_all { 10000 } else { last_n };

    let (query, param) = if let Some(name) = filter_name {
        let name = crate::identity::resolve_display_name_or_stopped(db, name)
            .unwrap_or_else(|| name.to_string());
        // Fix: fetch up to 10000 events for named instance (was LIMIT 1)
        (
            "SELECT instance, timestamp, data FROM events
             WHERE type = 'life' AND json_extract(data, '$.action') = 'stopped'
             AND instance = ?
             ORDER BY id DESC LIMIT 10000"
                .to_string(),
            name,
        )
    } else {
        (
            format!(
                "SELECT instance, timestamp, data FROM events
                 WHERE type = 'life' AND json_extract(data, '$.action') = 'stopped'
                 ORDER BY id DESC LIMIT {limit}"
            ),
            String::new(),
        )
    };

    let Ok(mut stmt) = db.conn().prepare(&query) else {
        eprintln!("Error: failed to query stopped events");
        return 1;
    };

    struct StoppedEntry {
        instance: String,
        timestamp: String,
        data: String,
    }

    let row_mapper = |row: &rusqlite::Row| -> rusqlite::Result<StoppedEntry> {
        Ok(StoppedEntry {
            instance: row.get(0)?,
            timestamp: row.get(1)?,
            data: row.get(2)?,
        })
    };

    let entries: Vec<StoppedEntry> = if filter_name.is_some() {
        stmt.query_map(params![param], row_mapper)
    } else {
        stmt.query_map([], row_mapper)
    }
    .ok()
    .into_iter()
    .flatten()
    .filter_map(|r| r.ok())
    .collect();

    if entries.is_empty() {
        if let Some(name) = filter_name {
            println!("No stopped events found for '{name}'");
        } else {
            println!("No recently stopped agents (last 60m)");
        }
        return 0;
    }

    if filter_name.is_some() {
        // Detailed view for a single instance (show all stop events, not just 1)
        let entry = &entries[0];
        let data: serde_json::Value = serde_json::from_str(&entry.data).unwrap_or_default();
        let snapshot = &data["snapshot"];
        println!("Stopped: {}", entry.instance);
        println!("  Time:       {}", entry.timestamp);
        if let Some(by) = data["by"].as_str() {
            println!("  By:         {by}");
        }
        if let Some(reason) = data["reason"].as_str() {
            println!("  Reason:     {reason}");
        }
        if let Some(tool) = snapshot["tool"].as_str() {
            println!("  Tool:       {tool}");
        }
        if let Some(tag) = snapshot["tag"].as_str()
            && !tag.is_empty()
        {
            println!("  Tag:        {tag}");
        }
        if let Some(dir) = snapshot["directory"].as_str() {
            println!("  Directory:  {dir}");
        }
        if let Some(sid) = snapshot["session_id"].as_str()
            && !sid.is_empty()
        {
            println!("  Session:    {sid}");
        }
        if let Some(tp) = snapshot["transcript_path"].as_str()
            && !tp.is_empty()
        {
            println!("  Transcript: {tp}");
        }
        println!("\n  Resume: hcom r {}", entry.instance);

        // Show history if multiple stop events
        if entries.len() > 1 {
            println!("\n  Stop history ({} events):", entries.len());
            for (i, e) in entries.iter().enumerate() {
                let d: serde_json::Value = serde_json::from_str(&e.data).unwrap_or_default();
                let reason = d["reason"].as_str().unwrap_or("");
                let by = d["by"].as_str().unwrap_or("");
                let age = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&e.timestamp) {
                    let event_epoch = dt.timestamp() as f64;
                    format_age((now - event_epoch) as i64)
                } else {
                    e.timestamp.clone()
                };
                let by_part = if by.is_empty() {
                    String::new()
                } else {
                    format!(" by:{by}")
                };
                let marker = if i == 0 { " (latest)" } else { "" };
                println!("    {age} ago  [{reason}{by_part}]{marker}");
            }
        }
    } else {
        // Summary table
        let header = if show_all {
            format!("Stopped agents (all, showing {}):", entries.len())
        } else {
            format!("Stopped agents (last {last_n}):")
        };
        println!("{header}\n");
        for entry in &entries {
            let data: serde_json::Value = serde_json::from_str(&entry.data).unwrap_or_default();
            let snapshot = &data["snapshot"];
            let tool = snapshot["tool"].as_str().unwrap_or("?");
            let tag = snapshot["tag"].as_str().unwrap_or("");
            let reason = data["reason"].as_str().unwrap_or("");
            let by = data["by"].as_str().unwrap_or("");
            // Parse timestamp for age
            let age = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&entry.timestamp) {
                let event_epoch = dt.timestamp() as f64;
                format_age((now - event_epoch) as i64)
            } else {
                entry.timestamp.clone()
            };
            let dir = snapshot["directory"].as_str().unwrap_or("");
            let tag_part = if tag.is_empty() {
                String::new()
            } else {
                format!(" tag:{tag}")
            };
            let by_part = if by.is_empty() {
                String::new()
            } else {
                format!(" by:{by}")
            };
            let dir_part = if dir.is_empty() {
                String::new()
            } else {
                format!("  {}", shorten_path_max(dir, 40))
            };
            println!(
                "  {} ({tool}{tag_part}) {age} ago  [{reason}{by_part}]{dir_part}",
                entry.instance
            );
        }
        if !show_all {
            println!("\n  --all: show all  |  --last N: show last N");
        }
        println!("  Details: hcom list --stopped <name>");
        println!("  Resume:  hcom r <name>");
    }

    0
}

/// Get names of recently stopped instances (within 10 minutes).
fn get_recently_stopped(
    db: &HcomDb,
    exclude_active: &std::collections::HashSet<String>,
) -> Vec<String> {
    let now = crate::shared::time::now_epoch_f64();
    let cutoff = now - RECENTLY_STOPPED_WINDOW;
    let cutoff_ts = chrono::DateTime::from_timestamp(cutoff as i64, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_default();

    let Ok(mut stmt) = db.conn().prepare(
        "SELECT DISTINCT instance FROM events
         WHERE type = 'life' AND json_extract(data, '$.action') = 'stopped'
         AND timestamp > ?
         ORDER BY id DESC",
    ) else {
        return vec![];
    };

    stmt.query_map(rusqlite::params![cutoff_ts], |row| row.get::<_, String>(0))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|r| r.ok())
        .filter(|name| !exclude_active.contains(name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::{ST_ACTIVE, ST_INACTIVE};

    /// A DB in a scratch dir. Nothing here reads or writes the ambient
    /// HCOM_DIR: the held rule is a projection over rows already in this DB.
    fn open_db() -> (tempfile::TempDir, HcomDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = HcomDb::open_at(&dir.path().join("hcom.db")).unwrap();
        (dir, db)
    }

    /// Insert an instance. Listening instances get a heartbeat `now` so the
    /// computed status stays `listening` instead of flipping to `inactive`.
    fn insert_instance(db: &HcomDb, name: &str, status: &str, cursor: i64, remote: bool) {
        let now = crate::shared::time::now_epoch_i64();
        db.conn()
            .execute(
                "INSERT INTO instances
                   (name, tool, status, status_context, status_detail, created_at,
                    status_time, last_stop, tcp_mode, directory, last_event_id,
                    origin_device_id, background)
                 VALUES (?, 'adhoc', ?, '', '', ?, ?, ?, 1, '/tmp', ?, ?, 0)",
                rusqlite::params![name, status, now, now, now, cursor, remote.then_some("dev-2")],
            )
            .unwrap();
    }

    /// An instance whose *stored* status is `listening` while its heartbeat is
    /// `age` seconds old, so its *computed* status is `inactive`: the two
    /// strings disagree by construction, which is what pins the held projection
    /// to the status the row actually renders.
    fn insert_stale_listening_instance(db: &HcomDb, name: &str, age: i64, cursor: i64) {
        let now = crate::shared::time::now_epoch_i64();
        let stale = now - age;
        db.conn()
            .execute(
                "INSERT INTO instances
                   (name, tool, status, status_context, status_detail, created_at,
                    status_time, last_stop, tcp_mode, directory, last_event_id,
                    origin_device_id, background)
                 VALUES (?, 'adhoc', ?, '', '', ?, ?, ?, 1, '/tmp', ?, NULL, 0)",
                rusqlite::params![name, ST_LISTENING, now, stale, stale, cursor],
            )
            .unwrap();
    }

    /// A message row addressed to `to` on `lane`. `None` means the row carries
    /// no lane at all (legacy/absent), which is the fail-closed `queue`.
    fn log_message(db: &HcomDb, to: &str, lane: Option<&str>) -> i64 {
        let mut data = serde_json::json!({
            "from": "sender",
            "scope": "agent",
            "text": "hi",
            "delivered_to": [to],
        });
        if let Some(lane) = lane {
            data["delivery"] = serde_json::json!(lane);
        }
        db.log_event("message", "sender", &data).unwrap()
    }

    /// The hold rule, all four halves: lane, cursor, recipient state, and the
    /// absent-lane default. Each assertion fails if any half is dropped or
    /// inverted.
    ///
    /// "Held" means the row waits on something else. An idle (`listening`)
    /// lane-aware recipient polls, and `decideInjection` delivers *both* lanes
    /// as a prompt there, so nothing is held at idle; the wait exists against a
    /// live turn (`queue` rides it to the boundary) and at a recipient that is
    /// not running at all.
    #[test]
    fn held_counts_mark_queue_rows_that_wait_on_a_turn() {
        let (_dir, db) = open_db();

        // Idle + unread queue row → NOT held: the recipient's next poll picks it
        // up and starts the consuming turn.
        insert_instance(&db, "idle-queue", ST_LISTENING, 0, false);
        log_message(&db, "idle-queue", Some("queue"));

        // Idle + unread steer row → also not held: a steer is delivered too.
        insert_instance(&db, "idle-steer", ST_LISTENING, 0, false);
        log_message(&db, "idle-steer", Some("steer"));

        // A turn in flight + queue row → held: it rides the turn to the boundary.
        insert_instance(&db, "busy-queue", ST_ACTIVE, 0, false);
        log_message(&db, "busy-queue", Some("queue"));

        // A turn in flight + steer row → not held: a steer interrupts it now.
        insert_instance(&db, "busy-steer", ST_ACTIVE, 0, false);
        log_message(&db, "busy-steer", Some("steer"));

        // Not running at all + queue row → held: it waits indefinitely.
        insert_instance(&db, "dead-queue", ST_INACTIVE, 0, false);
        log_message(&db, "dead-queue", Some("queue"));

        // Turn in flight + queue row with no lane recorded (legacy row) → held,
        // because an absent lane is the fail-closed default.
        insert_instance(&db, "busy-legacy", ST_ACTIVE, 0, false);
        log_message(&db, "busy-legacy", None);

        // Turn in flight + `auto` row → held. `auto` is retired as a *sending*
        // lane, but the delivery path still folds every non-`steer` value into
        // `queue`, so rows already written on it wait exactly like queue rows.
        insert_instance(&db, "busy-auto", ST_ACTIVE, 0, false);
        log_message(&db, "busy-auto", Some("auto"));

        // Turn in flight + a lane the delivery path has never heard of → held:
        // `steer` is the one value that escapes the rule, everything else is
        // queue.
        insert_instance(&db, "busy-bogus", ST_ACTIVE, 0, false);
        log_message(&db, "busy-bogus", Some("bogus"));

        // Queue row at or below the cursor → already consumed, not held.
        insert_instance(&db, "busy-read", ST_ACTIVE, 0, false);
        let read_id = log_message(&db, "busy-read", Some("queue"));
        db.conn()
            .execute(
                "UPDATE instances SET last_event_id = ? WHERE name = 'busy-read'",
                rusqlite::params![read_id],
            )
            .unwrap();

        // Remote instance → left at 0, like `unread_count`.
        insert_instance(&db, "remote-queue", ST_ACTIVE, 0, true);
        log_message(&db, "remote-queue", Some("queue"));

        let instances = db.iter_instances_full().unwrap();
        let unread = get_unread_counts_batch(&db, &instances);
        let statuses = instance_statuses(&db, &instances);
        let held_counts = get_held_counts_batch(&db, &instances, &statuses);

        assert_eq!(
            held_counts.get("idle-queue"),
            None,
            "an idle recipient polls the row up, so it is not held; \
             held={held_counts:?}"
        );
        assert_eq!(
            unread.get("idle-queue").copied(),
            Some(1),
            "not-held is not the same as read: the row is still unread"
        );
        assert_eq!(
            held_counts.get("idle-steer"),
            None,
            "no lane waits at idle; held={held_counts:?}"
        );
        assert_eq!(
            held_counts.get("busy-queue").copied(),
            Some(1),
            "a queue row rides the live turn to its boundary; held={held_counts:?}"
        );
        assert_eq!(
            held_counts.get("busy-steer"),
            None,
            "a steer interrupts the live turn instead of waiting; held={held_counts:?}"
        );
        assert_eq!(
            unread.get("busy-steer").copied(),
            Some(1),
            "the steer row is still unread — held is a subset, not a rename"
        );
        assert_eq!(
            held_counts.get("dead-queue").copied(),
            Some(1),
            "nothing polls a recipient that is not running; held={held_counts:?}"
        );
        assert_eq!(
            held_counts.get("busy-legacy").copied(),
            Some(1),
            "an absent lane is the fail-closed queue; held={held_counts:?}"
        );
        assert_eq!(
            held_counts.get("busy-auto").copied(),
            Some(1),
            "a retired-`auto` row is queue on the delivery path, so it waits; \
             held={held_counts:?}"
        );
        assert_eq!(
            held_counts.get("busy-bogus").copied(),
            Some(1),
            "only `steer` escapes the hold rule; held={held_counts:?}"
        );
        assert_eq!(
            held_counts.get("busy-read"),
            None,
            "a row at or below the cursor is consumed, not held; held={held_counts:?}"
        );
        assert_eq!(unread.get("busy-read"), None, "cursor advanced past the row");
        assert_eq!(
            held_counts.get("remote-queue"),
            None,
            "remote recipients have no local lane projection; held={held_counts:?}"
        );
    }

    /// A held row is a strict subset of the unread rows: a steer in the same
    /// batch is unread and never waits.
    #[test]
    fn held_counts_never_exceed_unread_counts() {
        let (_dir, db) = open_db();
        insert_instance(&db, "miso", ST_ACTIVE, 0, false);
        log_message(&db, "miso", Some("queue"));
        log_message(&db, "miso", Some("steer"));
        log_message(&db, "miso", Some("queue"));

        let instances = db.iter_instances_full().unwrap();
        let unread = get_unread_counts_batch(&db, &instances);
        let statuses = instance_statuses(&db, &instances);
        let held_counts = get_held_counts_batch(&db, &instances, &statuses);

        assert_eq!(unread.get("miso").copied(), Some(3));
        assert_eq!(held_counts.get("miso").copied(), Some(2));
        assert!(held_counts["miso"] < unread["miso"]);
    }

    /// The recipient half of the rule is the *computed* status — the very string
    /// the row prints and emits as `status` — not the stored one. A `listening`
    /// row whose heartbeat went stale computes to `inactive`, and a recipient
    /// that is not idle keeps its queue mail, so held must be 1 there: reading
    /// the stored `listening` instead would publish a count beside a
    /// contradicting status.
    #[test]
    fn held_counts_follow_the_computed_status_not_the_stored_one() {
        let (_dir, db) = open_db();
        insert_stale_listening_instance(&db, "stale-listening", 600, 0);
        log_message(&db, "stale-listening", Some("queue"));

        let instances = db.iter_instances_full().unwrap();
        let statuses = instance_statuses(&db, &instances);

        assert_eq!(
            statuses["stale-listening"].status, ST_INACTIVE,
            "a 600s-old heartbeat is not listening, whatever the row stores"
        );
        assert_eq!(
            get_held_counts_batch(&db, &instances, &statuses).get("stale-listening").copied(),
            Some(1),
            "held must agree with the emitted status: an inactive recipient is not polling, \
             so its queue row waits"
        );
    }

    /// The reported pair is self-consistent: held never exceeds unread, so a
    /// payload cannot say `unread 0` beside `held 1` — the shape that would
    /// drop the human marker (`unread_suffix(0, n)` is empty) while claiming a
    /// hold.
    #[test]
    fn held_is_floored_at_unread() {
        let unread = HashMap::from([("miso".to_string(), 1i64)]);
        let held = HashMap::from([("miso".to_string(), 3i64), ("empty".to_string(), 1i64)]);

        assert_eq!(unread_and_held(&unread, &held, "miso"), (1, 1));
        assert_eq!(unread_and_held(&unread, &held, "empty"), (0, 0));
        assert_eq!(unread_and_held(&unread, &held, "absent"), (0, 0));
    }

    /// The human marker: held is shown only when it is non-zero, so the common
    /// `+N` render is untouched.
    #[test]
    fn unread_suffix_marks_held_only_when_nonzero() {
        assert_eq!(unread_suffix(3, 2), " +3 (2 held)");
        assert_eq!(unread_suffix(1, 1), " +1 (1 held)");
        assert_eq!(unread_suffix(3, 0), " +3");
        assert_eq!(unread_suffix(0, 0), "");
        assert_eq!(unread_suffix(0, 2), "");
    }
}
