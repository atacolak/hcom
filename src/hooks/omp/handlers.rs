//! Omp Coding Agent hook handlers — argv-based lifecycle plus TypeScript plugin.

use std::time::Instant;

use serde_json::Value;

use crate::bootstrap;
use crate::db::HcomDb;
use crate::instance_binding;
use crate::instance_lifecycle as lifecycle;
use crate::instances;
use crate::log::{log_error, log_info};
use crate::shared::ST_LISTENING;
use crate::shared::context::HcomContext;

use crate::hooks::common;
use crate::hooks::common::finalize_session;

fn parse_flag(argv: &[String], flag: &str) -> Option<String> {
    argv.iter()
        .position(|a| a == flag)
        .and_then(|i| argv.get(i + 1))
        .cloned()
}

fn has_flag(argv: &[String], flag: &str) -> bool {
    argv.iter().any(|a| a == flag)
}

pub(crate) fn upsert_plugin_notify_endpoint(db: &HcomDb, instance_name: &str, port: u16) {
    if let Err(e) = db.upsert_notify_endpoint(instance_name, "plugin", port) {
        log_error(
            "native",
            "omp.register_notify_fail",
            &format!(
                "Failed to register plugin notify port for {}: {}",
                instance_name, e
            ),
        );
        return;
    }

    crate::notify::wake(db, instance_name, crate::notify::WakeKind::DELIVERY_LOOPS);
}

fn initialize_last_event_id(db: &HcomDb, instance_name: &str) {
    if let Ok(Some(existing)) = db.get_instance_full(instance_name)
        && existing.last_event_id == 0
    {
        let launch_event_id: Option<i64> = std::env::var("HCOM_LAUNCH_EVENT_ID")
            .ok()
            .and_then(|s| s.parse().ok());
        let current_max = db.get_last_event_id();
        let new_id = match launch_event_id {
            Some(lei) if lei <= current_max => lei,
            _ => current_max,
        };
        let mut updates = serde_json::Map::new();
        updates.insert("last_event_id".into(), serde_json::json!(new_id));
        instances::update_instance_position(db, instance_name, &updates);
    }
}

fn instance_name_from_env(ctx: &HcomContext) -> Option<String> {
    ctx.raw_env
        .get("HCOM_INSTANCE_NAME")
        .filter(|s| !s.is_empty())
        .cloned()
}

fn bootstrap_for(ctx: &HcomContext, db: &HcomDb, instance_name: &str) -> String {
    let tag = db
        .get_instance_full(instance_name)
        .ok()
        .flatten()
        .and_then(|d| d.tag.clone())
        .unwrap_or_default();
    let hcom_config = crate::config::HcomConfig::load(None).unwrap_or_default();
    let relay_enabled = crate::relay::is_relay_enabled(&hcom_config);
    let effective_tag = if tag.is_empty() {
        &hcom_config.tag
    } else {
        &tag
    };
    bootstrap::get_bootstrap(
        db,
        &ctx.hcom_dir,
        instance_name,
        "omp",
        ctx.is_background,
        ctx.is_launched,
        &ctx.notes,
        effective_tag,
        relay_enabled,
        ctx.background_name.as_deref(),
    )
}

pub(crate) fn handle_start(ctx: &HcomContext, db: &HcomDb, argv: &[String]) -> (i32, String) {
    // Plugin RPC returns JSON errors on exit 0 so the extension can handle
    // setup failures without Pi treating the hook itself as failed.
    let session_id = match parse_flag(argv, "--session-id") {
        Some(sid) => sid,
        None => return (0, r#"{"error":"Missing --session-id"}"#.to_string()),
    };
    let transcript_path = parse_flag(argv, "--transcript-path");
    let cwd = parse_flag(argv, "--cwd");
    let notify_port: Option<u16> = parse_flag(argv, "--notify-port").and_then(|s| s.parse().ok());

    let process_id = match &ctx.process_id {
        Some(pid) => pid.clone(),
        None => return (0, r#"{"error":"HCOM_PROCESS_ID not set"}"#.to_string()),
    };

    let instance_name =
        match instance_binding::bind_session_to_process(db, &session_id, Some(&process_id)) {
            Some(name) => name,
            None => match instance_name_from_env(ctx).and_then(|name| {
                instance_binding::recover_process_binding_for_instance(
                    db,
                    &name,
                    &session_id,
                    &process_id,
                )
            }) {
                Some(name) => name,
                None => {
                    return (
                        0,
                        r#"{"error":"No instance bound to this process"}"#.to_string(),
                    );
                }
            },
        };

    initialize_last_event_id(db, &instance_name);
    lifecycle::set_status(
        db,
        &instance_name,
        ST_LISTENING,
        "start",
        Default::default(),
    );
    instance_binding::capture_and_store_launch_context(db, &instance_name);

    let mut updates = serde_json::Map::new();
    updates.insert("tool".into(), serde_json::json!("omp"));
    updates.insert("session_id".into(), serde_json::json!(&session_id));
    if let Some(path) = transcript_path.as_ref().filter(|p| !p.is_empty()) {
        updates.insert("transcript_path".into(), serde_json::json!(path));
    }
    let cwd_value = cwd
        .as_deref()
        .filter(|p| !p.is_empty())
        .or_else(|| ctx.cwd.to_str());
    if let Some(cwd) = cwd_value {
        updates.insert("directory".into(), serde_json::json!(cwd));
    }
    instances::update_instance_position(db, &instance_name, &updates);
    if let Some(port) = notify_port {
        upsert_plugin_notify_endpoint(db, &instance_name, port);
    }
    log_info(
        "hooks",
        "omp-start.bind",
        &format!("instance={} session_id={}", instance_name, session_id),
    );
    crate::relay::worker::ensure_worker(true);

    let response = serde_json::json!({
        "name": instance_name,
        "session_id": session_id,
        "bootstrap": bootstrap_for(ctx, db, &instance_name),
    });
    (0, response.to_string())
}

pub(crate) fn handle_status(db: &HcomDb, argv: &[String]) -> (i32, String) {
    let name = match parse_flag(argv, "--name") {
        Some(n) => n,
        None => return (0, r#"{"error":"Missing --name or --status"}"#.to_string()),
    };
    let status = match parse_flag(argv, "--status") {
        Some(s) => s,
        None => return (0, r#"{"error":"Missing --name or --status"}"#.to_string()),
    };
    let context = parse_flag(argv, "--context").unwrap_or_default();
    let detail = parse_flag(argv, "--detail").unwrap_or_default();
    let was_listening = db
        .get_instance_full(&name)
        .ok()
        .flatten()
        .is_some_and(|inst| inst.status == ST_LISTENING);

    lifecycle::set_status(
        db,
        &name,
        &status,
        &context,
        lifecycle::StatusUpdate {
            detail: &detail,
            ..Default::default()
        },
    );
    if status == ST_LISTENING && !was_listening {
        crate::notify::wake(db, &name, &[]);
    }
    (0, r#"{"ok":true}"#.to_string())
}

fn handle_read(db: &HcomDb, argv: &[String]) -> (i32, String) {
    let name = match parse_flag(argv, "--name") {
        Some(n) => n,
        None => return (0, r#"{"error":"Missing --name"}"#.to_string()),
    };
    let format_mode = has_flag(argv, "--format");
    let check_mode = has_flag(argv, "--check");
    let ack_mode = has_flag(argv, "--ack");

    let raw_messages = db.get_unread_messages(&name);
    let messages: Vec<Value> = raw_messages.iter().map(common::message_to_value).collect();

    if format_mode {
        if messages.is_empty() {
            return (0, String::new());
        }
        let deliver = common::limit_delivery_messages(&messages);
        return (
            0,
            common::format_messages_json_for_instance(db, &deliver, &name),
        );
    }
    if ack_mode {
        let ids_flag = parse_flag(argv, "--ids");
        let up_to_flag = parse_flag(argv, "--up-to");
        if ids_flag.is_some() && up_to_flag.is_some() {
            return (
                0,
                r#"{"error":"--ids and --up-to are mutually exclusive"}"#.to_string(),
            );
        }
        if let Some(ids_raw) = ids_flag {
            return ack_by_ids(db, &name, &ids_raw);
        }
        if let Some(up_to) = up_to_flag {
            let Ok(ack_id) = up_to.parse::<i64>() else {
                return (
                    0,
                    serde_json::json!({"error": format!("Invalid --up-to: {}", up_to)}).to_string(),
                );
            };
            let mut updates = serde_json::Map::new();
            updates.insert("last_event_id".into(), serde_json::json!(ack_id));
            instances::update_instance_position(db, &name, &updates);
            return (0, serde_json::json!({"acked_to": ack_id}).to_string());
        }
        if messages.is_empty() {
            return (0, r#"{"acked":0}"#.to_string());
        }
        let ack_id = messages
            .iter()
            .filter_map(|m| m.get("event_id").and_then(|v| v.as_i64()))
            .max()
            .filter(|id| *id > 0)
            .unwrap_or_else(|| db.get_last_event_id());
        if ack_id > 0 {
            let mut updates = serde_json::Map::new();
            updates.insert("last_event_id".into(), serde_json::json!(ack_id));
            instances::update_instance_position(db, &name, &updates);
        }
        return (0, serde_json::json!({"acked": messages.len()}).to_string());
    }
    if parse_flag(argv, "--ids").is_some() {
        return (0, r#"{"error":"--ids requires --ack"}"#.to_string());
    }
    if check_mode {
        return (
            0,
            if messages.is_empty() { "false" } else { "true" }.to_string(),
        );
    }
    (
        0,
        serde_json::to_string(&messages).unwrap_or_else(|_| "[]".to_string()),
    )
}

/// Explicit-ids ack: advance the cursor to max(ids), fail-closed.
///
/// Ids at/below the cursor are idempotent replays. Every id above the cursor
/// must be a message event delivered to `name`, and the list must cover the
/// full unread batch up to its max — a partial ack would silently sweep
/// unconsumed mail under high-water cursor semantics.
fn ack_by_ids(db: &HcomDb, name: &str, ids_raw: &str) -> (i32, String) {
    let mut ids: Vec<i64> = Vec::new();
    for part in ids_raw.split(',') {
        let p = part.trim();
        match p.parse::<i64>() {
            Ok(id) if id > 0 => ids.push(id),
            _ => {
                return (
                    0,
                    serde_json::json!({"error": format!("Invalid --ids entry: '{p}'")}).to_string(),
                );
            }
        }
    }
    if ids.is_empty() {
        return (
            0,
            r#"{"error":"--ids requires at least one event id"}"#.to_string(),
        );
    }

    let current = db.get_cursor(name);
    let mut fresh: Vec<i64> = Vec::new();
    let mut already_acked = 0usize;
    let mut bad: Vec<i64> = Vec::new();
    for id in ids {
        if id <= current {
            already_acked += 1;
            continue;
        }
        let delivered = db
            .conn()
            .query_row(
                "SELECT data FROM events WHERE id = ?1 AND type = 'message'",
                rusqlite::params![id],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|data| serde_json::from_str::<Value>(&data).ok())
            .is_some_and(|json| HcomDb::should_deliver_to(&json, name));
        if delivered {
            fresh.push(id);
        } else {
            bad.push(id);
        }
    }
    if !bad.is_empty() {
        return (
            0,
            serde_json::json!({"error": format!(
                "--ids not delivered to {name} (or not message events): {bad:?}"
            )})
            .to_string(),
        );
    }

    // Incomplete-batch guard: every unread delivered message with id <= max(fresh)
    // must be in the list, or the ack would sweep mail the client never named.
    if let Some(max_fresh) = fresh.iter().max().copied() {
        let fresh_set: std::collections::HashSet<i64> = fresh.iter().copied().collect();
        let missing: Vec<i64> = db
            .get_unread_messages(name)
            .iter()
            .filter_map(|m| m.event_id)
            .filter(|id| *id <= max_fresh && !fresh_set.contains(id))
            .collect();
        if !missing.is_empty() {
            return (
                0,
                serde_json::json!({"error": format!(
                    "--ids incomplete: unread delivered messages missing from ack: {missing:?}"
                )})
                .to_string(),
            );
        }
        let mut updates = serde_json::Map::new();
        updates.insert("last_event_id".into(), serde_json::json!(max_fresh));
        instances::update_instance_position(db, name, &updates);
        return (
            0,
            serde_json::json!({
                "acked": fresh.len(),
                "acked_to": max_fresh,
                "already_acked": already_acked,
            })
            .to_string(),
        );
    }

    (
        0,
        serde_json::json!({"acked": 0, "acked_to": current, "already_acked": already_acked})
            .to_string(),
    )
}

fn handle_beforetool(db: &HcomDb, argv: &[String]) -> (i32, String) {
    let name = match parse_flag(argv, "--name") {
        Some(n) => n,
        None => return (0, r#"{"decision":"allow"}"#.to_string()),
    };
    let tool_name = parse_flag(argv, "--tool").unwrap_or_default();
    let input = parse_flag(argv, "--input-json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !tool_name.is_empty() {
        common::update_tool_status(db, &name, "omp", &tool_name, &input);
    }
    (0, r#"{"decision":"allow"}"#.to_string())
}

pub(crate) fn handle_stop(db: &HcomDb, argv: &[String]) -> (i32, String) {
    let name = match parse_flag(argv, "--name") {
        Some(n) => n,
        None => return (0, r#"{"error":"Missing --name"}"#.to_string()),
    };
    let reason = parse_flag(argv, "--reason").unwrap_or_else(|| "unknown".to_string());
    if has_flag(argv, "--soft") {
        common::soft_finalize_session(db, &name, &reason, None, true);
        (0, r#"{"ok":true,"soft":true}"#.to_string())
    } else {
        finalize_session(db, &name, &reason, None);
        (0, r#"{"ok":true}"#.to_string())
    }
}

pub fn dispatch_omp_hook(hook_name: &str, argv: &[String]) -> (i32, String) {
    let start = Instant::now();
    let ctx = HcomContext::from_os();
    crate::paths::ensure_hcom_directories_at(&ctx.hcom_dir);
    let db = match HcomDb::open() {
        Ok(db) => db,
        Err(e) => {
            log_error(
                "hooks",
                "hook.error",
                &format!("hook={} op=db_open err={}", hook_name, e),
            );
            return (
                0,
                serde_json::json!({"error": format!("DB open failed: {}", e)}).to_string(),
            );
        }
    };
    if !common::hook_gate_check(&ctx, &db) {
        return (0, String::new());
    }
    let handler_argv: Vec<String> = if !argv.is_empty() && argv[0] == hook_name {
        argv[1..].to_vec()
    } else {
        argv.to_vec()
    };
    let hook_name_owned = hook_name.to_string();
    let handler_start = Instant::now();
    let (exit_code, output) = common::dispatch_with_panic_guard(
        "omp",
        &hook_name_owned,
        (
            0,
            serde_json::json!({"error": "internal panic"}).to_string(),
        ),
        || match hook_name_owned.as_str() {
            "omp-start" => handle_start(&ctx, &db, &handler_argv),
            "omp-status" => handle_status(&db, &handler_argv),
            "omp-read" => handle_read(&db, &handler_argv),
            "omp-beforetool" => handle_beforetool(&db, &handler_argv),
            "omp-stop" => handle_stop(&db, &handler_argv),
            _ => (
                0,
                serde_json::json!({"error": format!("Unknown Omp hook: {}", hook_name_owned)})
                    .to_string(),
            ),
        },
    );
    log_info(
        "hooks",
        "omp.dispatch.timing",
        &format!(
            "hook={} handler_ms={:.2} total_ms={:.2} exit_code={}",
            hook_name,
            handler_start.elapsed().as_secs_f64() * 1000.0,
            start.elapsed().as_secs_f64() * 1000.0,
            exit_code
        ),
    );
    (exit_code, output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::test_helpers::isolated_test_env;
    use crate::messages::{DeliveryLane, MessageEnvelope};
    use crate::shared::{SenderIdentity, SenderKind};
    use serial_test::serial;

    fn setup() -> (HcomDb, std::path::PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let db_path = std::env::temp_dir().join(format!(
            "test_omp_read_ack_{}_{}.db",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let db = HcomDb::open_at(&db_path).unwrap();
        let mut row = serde_json::Map::new();
        row.insert("name".into(), serde_json::json!("bob"));
        row.insert("tool".into(), serde_json::json!("omp"));
        row.insert("status".into(), serde_json::json!("active"));
        row.insert("status_context".into(), serde_json::json!(""));
        row.insert("status_detail".into(), serde_json::json!(""));
        row.insert("created_at".into(), serde_json::json!(1.0));
        db.save_instance_named("bob", &row).unwrap();
        (db, db_path)
    }

    fn cleanup(path: std::path::PathBuf) {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    fn send_to_bob(db: &HcomDb, text: &str) -> i64 {
        db.log_event(
            "message",
            "alice",
            &serde_json::json!({
                "from": "alice", "scope": "mentions", "mentions": ["bob"],
                "text": text, "delivered_to": ["bob"], "delivery": "auto",
            }),
        )
        .unwrap()
    }

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn cursor(db: &HcomDb) -> i64 {
        db.get_cursor("bob")
    }

    #[test]
    fn ack_ids_advances_cursor_to_max() {
        let (db, path) = setup();
        let a = send_to_bob(&db, "one");
        let b = send_to_bob(&db, "two");
        let (code, out) = handle_read(
            &db,
            &argv(&["--name", "bob", "--ack", "--ids", &format!("{a},{b}")]),
        );
        assert_eq!(code, 0);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["acked"], 2);
        assert_eq!(v["acked_to"], b);
        assert_eq!(cursor(&db), b);
        cleanup(path);
    }

    #[test]
    fn ack_ids_idempotent_replay() {
        let (db, path) = setup();
        let a = send_to_bob(&db, "one");
        handle_read(
            &db,
            &argv(&["--name", "bob", "--ack", "--ids", &a.to_string()]),
        );
        let (_, out) = handle_read(
            &db,
            &argv(&["--name", "bob", "--ack", "--ids", &a.to_string()]),
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["acked"], 0);
        assert_eq!(v["already_acked"], 1);
        assert_eq!(cursor(&db), a, "replay must not regress or error");
        cleanup(path);
    }

    #[test]
    fn ack_ids_rejects_undelivered_id() {
        let (db, path) = setup();
        // message addressed to someone else
        let other = db
            .log_event(
                "message",
                "alice",
                &serde_json::json!({
                    "from": "alice", "scope": "mentions", "mentions": ["nova"],
                    "text": "not for bob", "delivered_to": ["nova"],
                }),
            )
            .unwrap();
        let (_, out) = handle_read(
            &db,
            &argv(&["--name", "bob", "--ack", "--ids", &other.to_string()]),
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("error").is_some());
        assert_eq!(cursor(&db), 0, "cursor must not move on rejection");
        cleanup(path);
    }

    #[test]
    fn ack_ids_rejects_non_message_id() {
        let (db, path) = setup();
        let life = db
            .log_event("life", "bob", &serde_json::json!({"action": "started"}))
            .unwrap();
        let (_, out) = handle_read(
            &db,
            &argv(&["--name", "bob", "--ack", "--ids", &life.to_string()]),
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("error").is_some());
        assert_eq!(cursor(&db), 0);
        cleanup(path);
    }

    #[test]
    fn ack_ids_rejects_incomplete_batch() {
        let (db, path) = setup();
        let a = send_to_bob(&db, "one");
        let b = send_to_bob(&db, "two");
        let c = send_to_bob(&db, "three");
        // ack first and third, skipping the middle: would silently sweep b
        let (_, out) = handle_read(
            &db,
            &argv(&["--name", "bob", "--ack", "--ids", &format!("{a},{c}")]),
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("error").is_some());
        assert!(v["error"].as_str().unwrap().contains(&b.to_string()));
        assert_eq!(cursor(&db), 0);
        cleanup(path);
    }

    #[test]
    fn ack_ids_and_up_to_conflict() {
        let (db, path) = setup();
        let a = send_to_bob(&db, "one");
        let (_, out) = handle_read(
            &db,
            &argv(&[
                "--name", "bob", "--ack", "--ids", &a.to_string(), "--up-to", "1",
            ]),
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("error").is_some());
        assert_eq!(cursor(&db), 0);
        cleanup(path);
    }

    #[test]
    fn ids_without_ack_flag_rejected() {
        let (db, path) = setup();
        let a = send_to_bob(&db, "one");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--ids", &a.to_string()]));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("error").is_some());
        cleanup(path);
    }

    #[test]
    fn ack_up_to_unchanged_regression() {
        let (db, path) = setup();
        let _a = send_to_bob(&db, "one");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--ack", "--up-to", "5"]));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["acked_to"], 5);
        assert_eq!(cursor(&db), 5);
        cleanup(path);
    }

    #[test]
    fn bare_ack_unchanged_regression() {
        let (db, path) = setup();
        let _a = send_to_bob(&db, "one");
        let b = send_to_bob(&db, "two");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--ack"]));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["acked"], 2);
        assert_eq!(cursor(&db), b);
        cleanup(path);
    }

    // ---- lane round-trip (Tasks 1+2 through the real handle_read) ----

    fn send_lane_to_bob(db: &HcomDb, lane: DeliveryLane, text: &str) {
        let sender = SenderIdentity {
            kind: SenderKind::Instance,
            name: "alice".into(),
            instance_data: None,
            session_id: None,
        };
        let envelope = MessageEnvelope {
            delivery: lane,
            ..Default::default()
        };
        crate::commands::send::send_message(
            db,
            &sender,
            text,
            Some(&envelope),
            Some(&["bob".to_string()]),
        )
        .unwrap();
    }

    #[test]
    #[serial]
    fn omp_read_raw_reports_delivery_steer() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        send_lane_to_bob(&db, DeliveryLane::Steer, "steered");
        let (code, out) = handle_read(&db, &argv(&["--name", "bob"]));
        assert_eq!(code, 0);
        let msgs: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(msgs[0]["delivery"], "steer");
        cleanup(path);
    }

    #[test]
    #[serial]
    fn omp_read_raw_defaults_legacy_rows_to_auto() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        // legacy row: written without the delivery key
        db.log_event(
            "message",
            "alice",
            &serde_json::json!({
                "from": "alice", "scope": "mentions", "mentions": ["bob"],
                "text": "old", "delivered_to": ["bob"],
            }),
        )
        .unwrap();
        let (_, out) = handle_read(&db, &argv(&["--name", "bob"]));
        let msgs: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(msgs[0]["delivery"], "auto");
        cleanup(path);
    }

    #[test]
    #[serial]
    fn omp_read_format_path_agrees_with_raw() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        send_lane_to_bob(&db, DeliveryLane::Queue, "queued");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--format"]));
        assert!(
            out.contains("queue"),
            "format path must surface the lane: {out}"
        );
        assert!(out.contains("queued"));
        cleanup(path);
    }

    #[test]
    #[serial]
    fn omp_read_format_path_hides_auto() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        send_lane_to_bob(&db, DeliveryLane::Auto, "plain");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--format"]));
        assert!(!out.contains("auto"), "auto lane must not add noise: {out}");
        cleanup(path);
    }
}
