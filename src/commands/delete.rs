//! `hcom delete` — actually remove a committed identity and free its name.
//!
//! Spec: docs/superpowers/specs/2026-09-20-hcom-delete.md. Delete is identity
//! *removal*: the live `instances` row and every name-keyed live binding go;
//! a `life` `action=deleted` event is written, which
//! `instance_names::collect_taken_names` treats as releasing (unlike
//! `stopped`). Historical `events.instance` and mail JSON keep the old token;
//! former-name aliases of a deleted current stay taken and resolve dead.
//! Refused while the process is alive (same split-brain hazard as rename) or
//! while live child rows exist. Distinct from discard (never-committed
//! provisional mints only) and stop/kill (name stays retired).

use rusqlite::params;

use crate::db::HcomDb;
use crate::identity;
use crate::shared::{CommandContext, SenderKind, is_inside_ai_tool};

/// Parsed arguments for `hcom delete`.
#[derive(clap::Parser, Debug)]
#[command(
    name = "delete",
    about = "Delete a committed identity (removes live state, frees the name)"
)]
pub struct DeleteArgs {
    /// Instance name to delete
    pub name: String,
    /// Machine-readable JSON output
    #[arg(long)]
    pub json: bool,
}

/// Resolve the initiator name for the audit event (mirrors discard).
fn resolve_initiator(db: &HcomDb, ctx: Option<&CommandContext>) -> String {
    if let Some(c) = ctx
        && let Some(id) = &c.identity
        && matches!(id.kind, SenderKind::Instance)
    {
        return id.name.clone();
    }
    match identity::resolve_identity(db, None, None, None, None, None, None) {
        Ok(id) => id.name,
        Err(_) => "cli".to_string(),
    }
}

fn fail(json: bool, code: &str, name: &str, detail: &str) -> i32 {
    if json {
        println!(
            "{}",
            serde_json::json!({"error": code, "name": name, "detail": detail})
        );
    } else {
        eprintln!("Error: cannot delete '{name}': {detail}");
    }
    1
}

/// Main entry point for `hcom delete`. Exit 0 = deleted or preview printed,
/// 1 = refusal/error.
pub fn cmd_delete(db: &HcomDb, args: &DeleteArgs, ctx: Option<&CommandContext>) -> i32 {
    let name = args.name.as_str();

    // 1. `name` must have a live row. (`hcom stop`/`kill` delete the row, so
    //    an already-stopped identity lands here too — distinguish it from a
    //    name with no history at all, mirroring discard.)
    let row = match db.get_instance_full(name) {
        Ok(Some(row)) => row,
        Ok(None) => {
            let retired: bool = db
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM events
                     WHERE type = 'life' AND instance = ?
                       AND json_extract(data, '$.action') = 'stopped'
                       AND COALESCE(json_extract(data, '$.placeholder'), 0) != 1",
                    params![name],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                > 0;
            if retired {
                return fail(args.json, "already_retired", name,
                    "already stopped/killed; its name stays retired");
            }
            return fail(args.json, "not_found", name, "instance not found");
        }
        Err(e) => return fail(args.json, "delete_failed", name, &e.to_string()),
    };

    // 2. Live process: HCOM_INSTANCE_NAME is process env; deleting under a
    //    live plugin split-brains it. Stop the process first (same refusal
    //    as rename).
    if let Some(pid) = row.pid
        && crate::sys::process::is_alive(pid as u32)
    {
        return fail(
            args.json,
            "live_process",
            name,
            &format!("process pid={pid} is alive; stop it first"),
        );
    }

    // 3. Live child rows: delete removes exactly this identity (the bead's
    //    enumerated surfaces). Cascading into children would destroy unnamed
    //    actors; leaving them would strand a dangling parent_name. Refuse.
    let children: Vec<String> = (|| -> anyhow::Result<Vec<String>> {
        let mut stmt = db
            .conn()
            .prepare("SELECT name FROM instances WHERE parent_name = ?")?;
        Ok(stmt
            .query_map(params![name], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?)
    })()
    .unwrap_or_default();
    if !children.is_empty() {
        return fail(
            args.json,
            "delete_refused",
            name,
            &format!(
                "has live child instance(s): {}; stop them first",
                children.join(", ")
            ),
        );
    }

    // 4. Confirmation gate: inside AI tools require --go, mirroring discard.
    if is_inside_ai_tool() && !ctx.map(|c| c.go).unwrap_or(false) {
        println!(
            "Would delete '{name}' (committed identity; history stays; name becomes reusable)."
        );
        println!("Re-run with --go to confirm.");
        return 0;
    }

    // 5. Wake ports before delete so remaining listeners see the row gone
    //    (mirrors stop_instance_inner).
    let wake_ports = crate::notify::snapshot_wake_ports(db, name);

    // 6. Terminal life event + delete of live state, one transaction. The
    //    snapshot mirrors stop_instance_inner's shape for archaeology.
    let initiator = resolve_initiator(db, ctx);
    let event_data = serde_json::json!({
        "action": "deleted",
        "by": initiator,
        "reason": "delete",
        "snapshot": {
            "name": name,
            "transcript_path": row.transcript_path,
            "session_id": row.session_id,
            "tool": row.tool,
            "directory": row.directory,
            "parent_name": row.parent_name,
            "parent_session_id": row.parent_session_id,
            "tag": row.tag,
            "wait_timeout": row.wait_timeout,
            "subagent_timeout": row.subagent_timeout,
            "hints": row.hints,
            "pid": row.pid,
            "created_at": row.created_at,
            "last_seen": row.last_seen,
            "background": row.background,
            "agent_id": row.agent_id,
            "name_announced": row.name_announced,
            "launch_args": row.launch_args,
            "origin_device_id": row.origin_device_id,
            "background_log_file": row.background_log_file,
            "last_event_id": row.last_event_id,
        },
    });
    match db.finalize_instance_stop(
        name,
        row.created_at,
        row.session_id.as_deref(),
        row.agent_id.as_deref(),
        &event_data,
    ) {
        Ok(true) => {}
        Ok(false) => {
            return fail(
                args.json,
                "delete_refused",
                name,
                "identity changed concurrently; re-check with 'hcom list'",
            );
        }
        Err(e) => return fail(args.json, "delete_failed", name, &e.to_string()),
    }

    // 7. Post-commit teardown (mirrors the tail of stop_instance_inner and
    //    discard): capabilities are scoped to the deleted actor; delivery-only
    //    thread memberships must not survive to the name's next incarnation.
    let _ = db.revoke_claude_actor_capabilities_for_instance(name);
    if let Some(ref session_id) = row.session_id {
        let _ = db.revoke_claude_actor_capabilities_for_session(session_id);
        let _ = db.kv_delete_prefix(&format!("subagent_stop_inflight:{session_id}:"));
    }
    let _ = db.cleanup_thread_memberships_for_name_reuse(name);
    crate::notify::wake_ports(&wake_ports, crate::notify::WAKE_TARGETED_MS);
    crate::relay::spawn_background_push();

    if args.json {
        println!(
            "{}",
            serde_json::json!({"deleted": name, "name_reusable": true})
        );
    } else {
        println!("Deleted '{name}' (name is reusable)");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serial_test::serial;

    fn make_test_db() -> (tempfile::TempDir, HcomDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = HcomDb::open_raw(&dir.path().join("test.db")).unwrap();
        db.init_db().unwrap();
        (dir, db)
    }

    fn go_ctx() -> crate::shared::CommandContext {
        crate::shared::CommandContext {
            go: true,
            ..Default::default()
        }
    }

    fn args(name: &str) -> DeleteArgs {
        DeleteArgs {
            name: name.to_string(),
            json: false,
        }
    }

    /// A committed (non-placeholder) instance row with one of every
    /// name-keyed live binding and one historical message (mirrors
    /// rename.rs's insert_committed).
    fn insert_committed(db: &HcomDb, name: &str) {
        db.conn()
            .execute(
                "INSERT INTO instances (name, session_id, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES (?1, ?2, 'inactive', 'stop', 0, 1, 0, 0)",
                params![name, format!("sess-{name}")],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO session_bindings (session_id, instance_name, created_at) VALUES (?1, ?2, 1)",
                params![format!("sess-{name}"), name],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO process_bindings (process_id, session_id, instance_name, updated_at) VALUES (?1, ?2, ?3, 1)",
                params![format!("proc-{name}"), format!("sess-{name}"), name],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO notify_endpoints (instance, kind, port, updated_at) VALUES (?1, 'pty', 7700, 1)",
                params![name],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO claude_actor_capabilities (token, session_id, tool_use_id, agent_id, instance_name, created_at, expires_at, last_seen)
                 VALUES (?1, ?2, 'tu-1', '', ?3, 1, 9999999999, 1)",
                params![format!("tok-{name}"), format!("sess-{name}"), name],
            )
            .unwrap();
        db.log_event(
            "message",
            name,
            &serde_json::json!({"from": name, "scope": "mentions", "mentions": ["vera"], "text": "hi"}),
        )
        .unwrap();
    }

    fn count(db: &HcomDb, sql: &str) -> i64 {
        db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn deletes_row_bindings_and_frees_name() {
        // Bug caught: delete leaves a binding table behind (next incarnation
        // resurrects it) or rewrites historical events (archaeology broken).
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        let historical: String = db
            .conn()
            .query_row(
                "SELECT data FROM events WHERE type='message' AND instance='luna'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(cmd_delete(&db, &args("luna"), Some(&go_ctx())), 0);

        assert!(db.get_instance_full("luna").unwrap().is_none());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM session_bindings WHERE instance_name='luna'"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM process_bindings WHERE instance_name='luna'"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM notify_endpoints WHERE instance='luna'"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM claude_actor_capabilities WHERE instance_name='luna'"), 0);

        // Historical event untouched (byte-identical data, old token).
        let after: String = db
            .conn()
            .query_row(
                "SELECT data FROM events WHERE type='message' AND instance='luna'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(historical, after);

        // The audit event: life/deleted, attributed to the deleted name.
        let (action, by, reason, has_snapshot): (String, String, String, i64) = db
            .conn()
            .query_row(
                "SELECT json_extract(data,'$.action'), json_extract(data,'$.by'),
                        json_extract(data,'$.reason'), json_extract(data,'$.snapshot') IS NOT NULL
                 FROM events WHERE type='life' AND instance='luna'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(action, "deleted");
        assert_eq!(reason, "delete");
        assert!(!by.is_empty());
        assert_eq!(has_snapshot, 1);

        // Name freed.
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(!taken.contains("luna"), "name still taken after delete");
    }

    #[test]
    fn refuses_live_pid() {
        // Bug caught: missing pid check — live plugin split-brains.
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        db.conn()
            .execute(
                "UPDATE instances SET pid = ?1 WHERE name = 'luna'",
                params![std::process::id() as i64],
            )
            .unwrap();
        assert_eq!(cmd_delete(&db, &args("luna"), Some(&go_ctx())), 1);
        assert!(db.get_instance_full("luna").unwrap().is_some());
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM events WHERE type='life' AND instance='luna'"),
            0
        );
    }

    #[test]
    fn not_found_and_already_retired_are_distinct() {
        let (_d, db) = make_test_db();
        // Never existed.
        let a = DeleteArgs { name: "nemo".into(), json: true };
        assert_eq!(cmd_delete(&db, &a, Some(&go_ctx())), 1);
        // Stopped history, no live row: retired, name stays taken.
        db.log_event("life", "mira", &serde_json::json!({"action": "stopped", "by": "cli", "reason": "stop"}))
            .unwrap();
        let a = DeleteArgs { name: "mira".into(), json: true };
        assert_eq!(cmd_delete(&db, &a, Some(&go_ctx())), 1);
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(taken.contains("mira"), "retired name must stay taken");
    }

    #[test]
    fn refuses_when_children_exist() {
        // Bug caught: delete cascades into unnamed child actors or strands
        // them with a dangling parent_name.
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        db.conn()
            .execute(
                "INSERT INTO instances (name, parent_name, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES ('luna_child', 'luna', 'inactive', 'stop', 0, 1, 0, 0)",
                [],
            )
            .unwrap();
        assert_eq!(cmd_delete(&db, &args("luna"), Some(&go_ctx())), 1);
        assert!(db.get_instance_full("luna").unwrap().is_some());
        assert!(db.get_instance_full("luna_child").unwrap().is_some());
    }

    #[test]
    fn placeholder_row_deletes_and_frees() {
        // Delete does not refuse never-committed rows (only live pid and
        // missing name refuse); discard stays the documented path for them.
        let (_d, db) = make_test_db();
        db.conn()
            .execute(
                "INSERT INTO instances (name, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES ('luna', 'pending', 'new', 0, 1, 0, 0)",
                [],
            )
            .unwrap();
        assert_eq!(cmd_delete(&db, &args("luna"), Some(&go_ctx())), 0);
        assert!(db.get_instance_full("luna").unwrap().is_none());
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(!taken.contains("luna"));
    }

    #[test]
    fn rename_former_alias_goes_dead() {
        // Delete of a rename current frees only that PK: the former name
        // stays taken and resolves to nothing (no ghost).
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna_lead");
        db.with_immediate_transaction(|tx| {
            crate::db::aliases::record_alias_tx(tx, "luna", "luna_lead")
        })
        .unwrap();

        assert_eq!(cmd_delete(&db, &args("luna_lead"), Some(&go_ctx())), 0);

        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(!taken.contains("luna_lead"), "deleted current still taken");
        assert!(taken.contains("luna"), "former name must stay taken");
        assert_eq!(
            db.alias_current("luna").unwrap().as_deref(),
            Some("luna_lead"),
            "alias row stays (historical stability)"
        );
        assert_eq!(crate::identity::resolve_display_name(&db, "luna"), None);
        // Send path: former target is unmatched, not delivered to a ghost.
        let aliases = db.alias_map().unwrap();
        let (_matched, unmatched) = crate::messages::resolve_targets(
            &["luna".to_string()],
            &[],
            &aliases,
        )
        .unwrap();
        assert_eq!(unmatched, vec!["luna".to_string()]);
    }

    #[test]
    fn stopped_then_deleted_frees_reclaimed_name() {
        // The collect_taken_names change's raison d'être through the command:
        // a name with prior stopped history is freed by delete.
        let (_d, db) = make_test_db();
        db.log_event("life", "luna", &serde_json::json!({"action": "stopped", "by": "cli", "reason": "stop"}))
            .unwrap();
        insert_committed(&db, "luna"); // reclaimed row, same name
        assert_eq!(cmd_delete(&db, &args("luna"), Some(&go_ctx())), 0);
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(!taken.contains("luna"), "deleted name with stopped history still taken");
    }

    #[test]
    #[serial]
    fn go_gate_previews_without_go() {
        // Inside an AI tool without --go: preview, exit 0, row intact.
        let _env = crate::instance_names::tests_env::InsideAiToolGuard::set();
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        let no_go = crate::shared::CommandContext {
            go: false,
            ..Default::default()
        };
        assert_eq!(cmd_delete(&db, &args("luna"), Some(&no_go)), 0);
        assert!(db.get_instance_full("luna").unwrap().is_some());
    }

    #[test]
    fn parses_name_and_json_flag() {
        use clap::Parser;
        let a = DeleteArgs::try_parse_from(["delete", "luna", "--json"]).unwrap();
        assert_eq!(a.name, "luna");
        assert!(a.json);
        assert!(DeleteArgs::try_parse_from(["delete"]).is_err());
    }
}
