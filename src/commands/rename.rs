//! `hcom rename <old> <new>` — rewrite a live instance identity to a new name.
//!
//! Spec: docs/superpowers/specs/2026-09-19-hcom-rename.md. Rename is identity
//! *continuation*: the `instances.name` PK and every live name-keyed binding
//! follow; historical `events.instance` and mail JSON keep the old token; the
//! old name is recorded in `instance_aliases` (stays taken; resolves to the
//! current row). Refused while the process is alive — HCOM_INSTANCE_NAME is
//! process env, so a live rewrite split-brains the plugin.

use rusqlite::params;

use crate::db::{aliases::record_alias_tx, HcomDb};
use crate::identity;
use crate::shared::{CommandContext, SenderKind};

/// Parsed arguments for `hcom rename`.
#[derive(clap::Parser, Debug)]
#[command(
    name = "rename",
    about = "Rename an instance (rewrites live bindings; former name stays reserved)"
)]
pub struct RenameArgs {
    /// Current instance name
    pub old: String,
    /// New instance name (chosen-name grammar; must be free)
    pub new: String,
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

fn fail(json: bool, code: &str, old: &str, new: &str, detail: &str) -> i32 {
    if json {
        println!(
            "{}",
            serde_json::json!({"error": code, "old": old, "new": new, "detail": detail})
        );
    } else {
        eprintln!("Error: cannot rename '{old}' to '{new}': {detail}");
    }
    1
}

/// Main entry point for `hcom rename`. Exit 0 = renamed, 1 = refusal/error.
pub fn cmd_rename(db: &HcomDb, args: &RenameArgs, ctx: Option<&CommandContext>) -> i32 {
    let old = args.old.as_str();
    let new = args.new.as_str();

    // 1. `old` must have a row. (`hcom stop` deletes the row, so a stopped
    //    identity lands here too — rename needs the live row to rewrite.)
    let row = match db.get_instance_full(old) {
        Ok(Some(row)) => row,
        Ok(None) => {
            return fail(
                args.json,
                "not_found",
                old,
                new,
                "instance not found (already stopped?)",
            )
        }
        Err(e) => return fail(args.json, "rename_failed", old, new, &e.to_string()),
    };

    // 2. Live process: HCOM_INSTANCE_NAME is process env; a live rewrite
    //    split-brains the plugin. Stop/recycle the process first.
    if let Some(pid) = row.pid
        && crate::sys::process::is_alive(pid as u32)
    {
        return fail(
            args.json,
            "live_process",
            old,
            new,
            &format!("process pid={pid} is alive; stop/recycle it first"),
        );
    }

    // 3. Frozen chosen-name grammar (hcom-4n3.1 via identity).
    if !identity::is_valid_base_name(new) {
        return fail(
            args.json,
            "invalid_name",
            old,
            new,
            &identity::base_name_error(new),
        );
    }

    // 4. Taken set: live rows + stopped-historical + reserved former names.
    //    (`new == old` is caught here: old's live row is in the set.)
    let taken = match crate::instance_names::collect_taken_names(db) {
        Ok((_alive, taken)) => taken,
        Err(e) => return fail(args.json, "rename_failed", old, new, &e.to_string()),
    };
    if taken.contains(new) {
        return fail(
            args.json,
            "name_taken",
            old,
            new,
            "name is taken or reserved",
        );
    }

    // 5. One transaction: PK rewrite + every live name-keyed surface + alias
    //    + audit event. defer_foreign_keys defers the session_bindings FK
    //    (no ON UPDATE CASCADE) to commit. 0 rows on the PK UPDATE = lost a
    //    concurrency race; rolling back restores everything.
    let initiator = resolve_initiator(db, ctx);
    let event_data = serde_json::json!({
        "action": "renamed",
        "from": old,
        "to": new,
        "by": initiator,
    });
    let mut event_id = None;
    let result: anyhow::Result<()> = db.with_immediate_transaction(|tx| {
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        let moved = tx.execute(
            "UPDATE instances SET name = ?2 WHERE name = ?1",
            params![old, new],
        )?;
        if moved == 0 {
            anyhow::bail!("instance '{old}' changed concurrently");
        }
        tx.execute(
            "UPDATE instances SET parent_name = ?2 WHERE parent_name = ?1",
            params![old, new],
        )?;
        tx.execute(
            "UPDATE process_bindings SET instance_name = ?2 WHERE instance_name = ?1",
            params![old, new],
        )?;
        tx.execute(
            "UPDATE session_bindings SET instance_name = ?2 WHERE instance_name = ?1",
            params![old, new],
        )?;
        tx.execute(
            "UPDATE claude_actor_capabilities SET instance_name = ?2 WHERE instance_name = ?1",
            params![old, new],
        )?;
        tx.execute(
            "UPDATE notify_endpoints SET instance = ?2 WHERE instance = ?1",
            params![old, new],
        )?;
        // Live routing state follows the identity (stop/resume preserves
        // delivery-only memberships; discard.rs:204-208 explains why leftover
        // memberships misroute). sql/params/filters text stays untouched.
        tx.execute(
            "UPDATE kv SET value = json_set(value, '$.caller', ?2)
             WHERE key LIKE 'events\\_sub:%' ESCAPE '\\'
               AND json_extract(value, '$.caller') = ?1",
            params![old, new],
        )?;
        record_alias_tx(tx, old, new)?;
        let data = serde_json::to_string(&event_data)?;
        tx.execute(
            "INSERT INTO events (timestamp, type, instance, data) VALUES (?, 'life', ?, ?)",
            params![crate::db::chrono_now_iso(), new, data],
        )?;
        event_id = Some(tx.last_insert_rowid());
        Ok(())
    });
    if let Err(e) = result {
        return fail(args.json, "rename_failed", old, new, &e.to_string());
    }

    // 6. Subscription notifications fire only after the rename is durable
    //    (mirrors finalize_instance_stop, src/db/instances.rs:459-463).
    if let Some(event_id) = event_id {
        crate::db::subscriptions::process_logged_event(db, event_id, "life", new, &event_data);
    }

    if args.json {
        println!(
            "{}",
            serde_json::json!({"renamed": {"from": old, "to": new}})
        );
    } else {
        println!("Renamed '{old}' -> '{new}' (former name stays reserved)");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn make_test_db() -> (tempfile::TempDir, HcomDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = HcomDb::open_raw(&dir.path().join("test.db")).unwrap();
        db.init_db().unwrap();
        (dir, db)
    }

    /// A committed (non-placeholder) instance row with one of every
    /// name-keyed live binding, a child row, and one historical message.
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
        db.conn()
            .execute(
                "INSERT INTO instances (name, parent_name, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES (?1, ?2, 'inactive', 'stop', 0, 1, 0, 0)",
                params![format!("{name}_child"), name],
            )
            .unwrap();
        db.log_event(
            "message",
            name,
            &serde_json::json!({"from": name, "scope": "mentions", "mentions": ["vera"], "text": "hi"}),
        )
        .unwrap();
    }

    fn args(old: &str, new: &str) -> RenameArgs {
        RenameArgs {
            old: old.to_string(),
            new: new.to_string(),
            json: false,
        }
    }

    fn count(db: &HcomDb, sql: &str) -> i64 {
        db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn renames_row_and_all_live_bindings() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");

        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);

        assert!(db.get_instance_full("luna").unwrap().is_none());
        assert!(db.get_instance_full("luna_lead").unwrap().is_some());
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM session_bindings WHERE instance_name='luna_lead'"),
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM process_bindings WHERE instance_name='luna_lead'"),
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM notify_endpoints WHERE instance='luna_lead'"),
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM claude_actor_capabilities WHERE instance_name='luna_lead'"),
            1
        );
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM instances WHERE parent_name='luna_lead'"),
            1
        );
        // Nothing live is left under the old name.
        assert_eq!(
            count(
                &db,
                "SELECT (SELECT COUNT(*) FROM session_bindings WHERE instance_name='luna')
                      + (SELECT COUNT(*) FROM process_bindings WHERE instance_name='luna')
                      + (SELECT COUNT(*) FROM notify_endpoints WHERE instance='luna')
                      + (SELECT COUNT(*) FROM claude_actor_capabilities WHERE instance_name='luna')
                      + (SELECT COUNT(*) FROM instances WHERE parent_name='luna')"
            ),
            0
        );
    }

    #[test]
    fn historical_event_keeps_old_token() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        let before: String = db
            .conn()
            .query_row(
                "SELECT data FROM events WHERE type='message' AND instance='luna'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);

        let (inst, after): (String, String) = db
            .conn()
            .query_row("SELECT instance, data FROM events WHERE type='message'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(inst, "luna");
        assert_eq!(after, before);
    }

    #[test]
    fn writes_renamed_life_event() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);

        let (inst, action, from, to): (String, String, String, String) = db
            .conn()
            .query_row(
                "SELECT instance,
                        json_extract(data,'$.action'),
                        json_extract(data,'$.from'),
                        json_extract(data,'$.to')
                 FROM events WHERE type='life'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(inst, "luna_lead");
        assert_eq!(action, "renamed");
        assert_eq!(from, "luna");
        assert_eq!(to, "luna_lead");
    }

    #[test]
    fn fails_when_old_missing() {
        let (_d, db) = make_test_db();
        assert_eq!(cmd_rename(&db, &args("ghost", "luna_lead"), None), 1);
        assert!(db.alias_current("ghost").unwrap().is_none());
    }

    #[test]
    fn fails_when_old_has_live_pid() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        db.conn()
            .execute(
                "UPDATE instances SET pid = ?1 WHERE name = 'luna'",
                params![std::process::id() as i64],
            )
            .unwrap();

        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 1);

        // Untouched: row, bindings, and no alias recorded.
        assert!(db.get_instance_full("luna").unwrap().is_some());
        assert!(db.get_instance_full("luna_lead").unwrap().is_none());
        assert!(db.alias_current("luna").unwrap().is_none());
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM session_bindings WHERE instance_name='luna'"),
            1
        );
    }

    #[test]
    fn fails_when_new_taken_by_live_row() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        insert_committed(&db, "vera");
        assert_eq!(cmd_rename(&db, &args("luna", "vera"), None), 1);
        assert!(db.get_instance_full("luna").unwrap().is_some());
    }

    #[test]
    fn fails_when_new_is_former_name() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        insert_committed(&db, "vera");
        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);
        // 'luna' is now a reserved former name.
        assert_eq!(cmd_rename(&db, &args("vera", "luna"), None), 1);
        assert!(db.get_instance_full("vera").unwrap().is_some());
    }

    #[test]
    fn fails_when_new_fails_grammar() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        assert_eq!(cmd_rename(&db, &args("luna", "Bad Name"), None), 1);
        assert_eq!(cmd_rename(&db, &args("luna", "all"), None), 1);
        assert!(db.get_instance_full("luna").unwrap().is_some());
    }

    #[test]
    fn rename_twice_collapses_chain() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);
        assert_eq!(cmd_rename(&db, &args("luna_lead", "luna_lead2"), None), 0);

        assert_eq!(db.alias_current("luna").unwrap().as_deref(), Some("luna_lead2"));
        assert_eq!(
            db.alias_current("luna_lead").unwrap().as_deref(),
            Some("luna_lead2")
        );
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(taken.contains("luna"));
        assert!(taken.contains("luna_lead"));
    }

    #[test]
    fn send_and_identity_resolve_former_name() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);

        assert_eq!(
            crate::identity::resolve_display_name(&db, "luna").as_deref(),
            Some("luna_lead")
        );
        let rows = vec![crate::messages::InstanceInfo {
            name: "luna_lead".to_string(),
            tag: None,
        }];
        let aliases = db.alias_map().unwrap();
        let (matched, unmatched) =
            crate::messages::resolve_targets(&["luna".to_string()], &rows, &aliases).unwrap();
        assert_eq!(matched, vec!["luna_lead".to_string()]);
        assert!(unmatched.is_empty());
    }

    #[test]
    fn rewrites_thread_membership_caller() {
        let (_d, db) = make_test_db();
        insert_committed(&db, "luna");
        db.conn()
            .execute(
                "INSERT INTO kv (key, value) VALUES (
                    'events_sub:thread-1',
                    json('{\"caller\":\"luna\",\"delivery_only\":true,\"thread_name\":\"t\"}')
                 )",
                [],
            )
            .unwrap();

        assert_eq!(cmd_rename(&db, &args("luna", "luna_lead"), None), 0);

        let caller: String = db
            .conn()
            .query_row(
                "SELECT json_extract(value,'$.caller') FROM kv WHERE key='events_sub:thread-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(caller, "luna_lead");
    }
}
