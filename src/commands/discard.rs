//! `hcom discard` — remove a never-committed provisional identity mint so its
//! four-letter name becomes reusable.
//!
//! A provisional mint (`instance_names::reserve_generated_name`) writes only a
//! placeholder `instances` row: no events, no bindings. `hcom stop`/`kill`
//! deliberately keep such a name taken (resumable / referentially stable), so
//! a failed mint would otherwise leak the name. Discard reuses the placeholder
//! teardown (`stop_placeholder_instance`): the stopped event it writes carries
//! `placeholder:true`, which `instance_names::collect_taken_names` ignores —
//! that is the mechanical step that frees the name. A conservative predicate
//! refuses the discard once the mint semantically committed: a wrong refusal is
//! recoverable, destroying a real actor's history is not.

use crate::db::{HcomDb, InstanceRow};
use crate::hooks::common::{StopOutcome, stop_placeholder_instance};
use crate::identity;
use crate::shared::{CommandContext, SenderKind, is_inside_ai_tool};

/// Parsed arguments for `hcom discard`.
#[derive(clap::Parser, Debug)]
#[command(
    name = "discard",
    about = "Discard a never-committed provisional identity (frees its name)"
)]
pub struct DiscardArgs {
    /// Instance name to discard
    pub name: String,
    /// Machine-readable JSON output
    #[arg(long)]
    pub json: bool,
}

fn count(db: &HcomDb, sql: &str, name: &str) -> i64 {
    db.conn()
        .query_row(sql, rusqlite::params![name], |r| r.get(0))
        .unwrap_or(0)
}

/// Mechanical "semantically committed" test. Every clause counts rows in a
/// table that records participation; any hit refuses the discard.
///
/// Conservative by design: a wrong refusal is recoverable (the stale
/// placeholder sweeper frees the name, or the operator uses stop/kill), while a
/// wrong delete destroys an actor's history.
fn committed_reasons(db: &HcomDb, row: &InstanceRow) -> Vec<String> {
    let mut reasons = Vec::new();
    let name = row.name.as_str();

    // A provisional mint has no session; a bind sets session_id and rewrites
    // status. Anything else means the identity was adopted.
    if !crate::instances::is_launching_placeholder(row) {
        reasons.push(format!(
            "session bound / activated (status={}:{})",
            row.status, row.status_context
        ));
    }

    if let Some(pid) = row.pid
        && crate::sys::process::is_alive(pid as u32)
    {
        reasons.push(format!("live process pid={pid}"));
    }

    // Any event authored by the name is participation (the `life` `started`
    // event is hcom's join signal).
    let events = count(db, "SELECT COUNT(*) FROM events WHERE instance = ?", name);
    if events > 0 {
        reasons.push(format!("{events} event(s) authored"));
    }

    // "Addressed to the name" = a mentions-scoped message naming it in the
    // mentions array. Broadcasts are deliberately excluded: they are not
    // addressed to the name, and counting them would refuse every discard in a
    // DB that has seen any traffic.
    let mentions = count(
        db,
        "SELECT COUNT(*) FROM events
         WHERE type = 'message'
           AND json_extract(data, '$.scope') = 'mentions'
           AND EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.mentions'))
                       WHERE value = ?)",
        name,
    );
    if mentions > 0 {
        reasons.push(format!("addressed by {mentions} message(s)"));
    }

    // Teardown cascades to children; discarding a parent must not stop them.
    let children = count(
        db,
        "SELECT COUNT(*) FROM instances WHERE parent_name = ?",
        name,
    );
    if children > 0 {
        reasons.push(format!("{children} child instance(s)"));
    }

    // Attach evidence even when the row still looks placeholder-shaped.
    let bindings: i64 = db
        .conn()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM session_bindings WHERE instance_name = ?1)
                  + (SELECT COUNT(*) FROM process_bindings WHERE instance_name = ?1)",
            rusqlite::params![name],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if bindings > 0 {
        reasons.push(format!("{bindings} session/process binding(s)"));
    }

    reasons
}

/// Resolve the initiator name for the audit event. `stop` uses the same
/// best-effort resolution: `discard` takes an explicit target, so the caller
/// identity is only a label on the `life` event.
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

fn print_json(v: serde_json::Value) {
    println!("{}", serde_json::to_string(&v).unwrap());
}

/// Main entry point for `hcom discard`.
///
/// Returns exit code (0 = discarded or preview printed, 1 = refusal / error).
pub fn cmd_discard(db: &HcomDb, args: &DiscardArgs, ctx: Option<&CommandContext>) -> i32 {
    let name = args.name.as_str();

    let row = match db.get_instance_full(name) {
        Ok(Some(row)) => row,
        Ok(None) => {
            // No live row: distinguish a retired name (its name stays taken)
            // from a name with no history at all.
            let retired = count(
                db,
                "SELECT COUNT(*) FROM events
                 WHERE type = 'life' AND instance = ?
                   AND json_extract(data, '$.action') = 'stopped'
                   AND COALESCE(json_extract(data, '$.placeholder'), 0) != 1",
                name,
            ) > 0;
            if retired {
                if args.json {
                    print_json(serde_json::json!({"error": "already_retired", "name": name}));
                } else {
                    eprintln!(
                        "Error: '{name}' was already stopped/killed; its name stays retired"
                    );
                }
            } else if args.json {
                print_json(serde_json::json!({"error": "not_found", "name": name}));
            } else {
                eprintln!("Error: '{name}' not found");
            }
            return 1;
        }
        Err(e) => {
            eprintln!("Error: {e}");
            return 1;
        }
    };

    let reasons = committed_reasons(db, &row);
    if !reasons.is_empty() {
        if args.json {
            print_json(serde_json::json!({
                "error": "discard_refused",
                "name": name,
                "reasons": reasons,
                "hint": format!("hcom stop {name} | hcom kill {name}"),
            }));
        } else {
            eprintln!("Error: cannot discard '{name}': identity has committed work");
            for r in &reasons {
                eprintln!("  - {r}");
            }
            eprintln!(
                "Use 'hcom stop {name}' (keeps it resumable) or 'hcom kill {name}' (retires the name)."
            );
        }
        return 1;
    }

    // Confirmation gate: inside AI tools require --go, mirroring `stop`.
    if is_inside_ai_tool() && !ctx.map(|c| c.go).unwrap_or(false) {
        println!("Would discard '{name}' (provisional, never committed; name becomes reusable).");
        println!("Re-run with --go to confirm.");
        return 0;
    }

    let initiator = resolve_initiator(db, ctx);
    match stop_placeholder_instance(db, name, &initiator, "discard") {
        StopOutcome::Stopped => {
            // `finalize_instance_stop` deliberately preserves delivery-only
            // thread memberships for stop/resume; discard is identity
            // replacement, so they must not survive to the next incarnation
            // and misroute thread delivery.
            let _ = db.cleanup_thread_memberships_for_name_reuse(name);
            if args.json {
                print_json(serde_json::json!({"discarded": name, "name_reusable": true}));
            } else {
                println!("Discarded '{name}' (name is reusable)");
            }
            0
        }
        // Lost the CAS race: the row changed (e.g. a session bound) or vanished
        // between the predicate and the delete. Report a refusal, not success.
        StopOutcome::AlreadyStopped => {
            if args.json {
                print_json(serde_json::json!({
                    "error": "discard_refused",
                    "name": name,
                    "reasons": ["identity changed concurrently"],
                    "hint": format!("hcom stop {name} | hcom kill {name}"),
                }));
            } else {
                eprintln!(
                    "Error: cannot discard '{name}': identity changed concurrently; re-check with 'hcom list'"
                );
            }
            1
        }
        StopOutcome::RetryableError(e) => {
            eprintln!("Error: could not discard '{name}': {e}");
            1
        }
    }
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

    /// Mirror reserve_generated_name's placeholder row (instance_names.rs:343).
    fn insert_placeholder(db: &HcomDb, name: &str) {
        db.conn()
            .execute(
                "INSERT INTO instances (name, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES (?1, 'pending', 'new', 0, 1, 0, 0)",
                [name],
            )
            .unwrap();
    }

    fn placeholder_row(db: &HcomDb, name: &str) -> crate::db::InstanceRow {
        db.get_instance_full(name).unwrap().unwrap()
    }

    #[test]
    fn refuses_when_session_bound() {
        // Bug caught: predicate too weak — discarding an attached actor.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.conn()
            .execute("UPDATE instances SET session_id='s1', status='listening', status_context='start' WHERE name='luna'", [])
            .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.iter().any(|r| r.contains("session bound")), "{reasons:?}");
        assert!(db.get_instance_full("luna").unwrap().is_some());
    }

    #[test]
    fn refuses_when_events_exist() {
        // Bug caught: authored-event clause missing — history destroyed.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.log_event("status", "luna", &serde_json::json!({"status":"active"}))
            .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.iter().any(|r| r.contains("event(s) authored")), "{reasons:?}");
    }

    #[test]
    fn refuses_when_mentioned() {
        // Bug caught: addressed-message clause missing — discard steals a name
        // another actor explicitly addressed.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.log_event(
            "message",
            "mira",
            &serde_json::json!({
                "from": "mira", "scope": "mentions", "mentions": ["luna"], "text": "hi"
            }),
        )
        .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.iter().any(|r| r.contains("addressed by")), "{reasons:?}");
    }

    #[test]
    fn allows_despite_broadcast() {
        // Bug caught: over-broad clause counting broadcasts as "addressed to" —
        // every discard in a busy DB would refuse.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.log_event(
            "message",
            "mira",
            &serde_json::json!({
                "from": "mira", "scope": "broadcast", "text": "all hands"
            }),
        )
        .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.is_empty(), "{reasons:?}");
    }

    #[test]
    fn refuses_with_children() {
        // Bug caught: teardown cascades to children — discarding a parent must
        // not silently stop child actors.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.conn()
            .execute(
                "INSERT INTO instances (name, parent_name, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES ('luna_task_1', 'luna', 'inactive', 'subagent:dormant', 0, 1, 0, 0)",
                [],
            )
            .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.iter().any(|r| r.contains("child")), "{reasons:?}");
    }

    #[test]
    fn refuses_with_process_binding() {
        // Bug caught: attach evidence in bindings ignored.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.conn()
            .execute(
                "INSERT INTO process_bindings (process_id, instance_name, session_id, updated_at)
                 VALUES ('p1', 'luna', NULL, 1)",
                params![],
            )
            .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.iter().any(|r| r.contains("binding")), "{reasons:?}");
    }

    #[test]
    fn refuses_live_pid() {
        // Bug caught: discarding out from under a running process.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        let me = std::process::id() as i64; // guaranteed alive
        db.conn()
            .execute(
                "UPDATE instances SET pid=?1 WHERE name='luna'",
                params![me],
            )
            .unwrap();
        let reasons = committed_reasons(&db, &placeholder_row(&db, "luna"));
        assert!(reasons.iter().any(|r| r.contains("live process")), "{reasons:?}");
    }

    fn go_ctx() -> crate::shared::CommandContext {
        crate::shared::CommandContext {
            go: true,
            ..Default::default()
        }
    }

    fn event_count(db: &HcomDb) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn reusable_after_discard() {
        // Bug caught: discard writes a non-placeholder stopped event (or leaves
        // the row), so the allocator keeps the name taken forever.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        let args = DiscardArgs {
            name: "luna".into(),
            json: false,
        };
        assert_eq!(cmd_discard(&db, &args, Some(&go_ctx())), 0);

        assert!(db.get_instance_full("luna").unwrap().is_none());
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(!taken.contains("luna"), "name still taken after discard");

        // The audit event exists and is placeholder-shaped.
        let (action, placeholder, reason): (String, i64, String) = db
            .conn()
            .query_row(
                "SELECT json_extract(data,'$.action'),
                        COALESCE(json_extract(data,'$.placeholder'),0),
                        json_extract(data,'$.reason')
                 FROM events WHERE type='life' AND instance='luna'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (action.as_str(), placeholder, reason.as_str()),
            ("stopped", 1, "discard")
        );
    }

    #[test]
    fn leaves_no_dangling_bindings() {
        // Bug caught: notify-endpoint / delivery-only thread-membership rows
        // survive and resurrect or misroute the name's next incarnation — or
        // the cleanup is over-broad and wipes an unrelated name's rows.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        for (who, port) in [("luna", 4001), ("mira", 4002)] {
            db.conn()
                .execute(
                    "INSERT INTO notify_endpoints (instance, kind, port, updated_at)
                     VALUES (?1, 'pty', ?2, 1)",
                    params![who, port],
                )
                .unwrap();
            let membership = serde_json::json!({
                "caller": who, "delivery_only": 1, "auto_thread_member": 1
            })
            .to_string();
            db.conn()
                .execute(
                    "INSERT INTO kv (key, value) VALUES (?1, ?2)",
                    params![format!("events_sub:{who}"), membership],
                )
                .unwrap();
        }

        let args = DiscardArgs {
            name: "luna".into(),
            json: false,
        };
        assert_eq!(cmd_discard(&db, &args, Some(&go_ctx())), 0);

        let luna_rows: i64 = db
            .conn()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM notify_endpoints WHERE instance='luna')
                      + (SELECT COUNT(*) FROM kv WHERE key LIKE 'events_sub:%'
                           AND json_extract(value,'$.caller')='luna')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(luna_rows, 0, "luna left dangling endpoint/membership rows");

        let mira_rows: i64 = db
            .conn()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM notify_endpoints WHERE instance='mira')
                      + (SELECT COUNT(*) FROM kv WHERE key LIKE 'events_sub:%'
                           AND json_extract(value,'$.caller')='mira')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mira_rows, 2, "cleanup reached beyond the discarded name");
    }

    #[test]
    fn preserves_event_history() {
        // Bug caught: cleanup deletes events rows, breaking other actors'
        // historical threads/transcripts.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.log_event(
            "message",
            "mira",
            &serde_json::json!({
                "from": "mira", "scope": "broadcast", "text": "history"
            }),
        )
        .unwrap();
        let before = event_count(&db);

        let args = DiscardArgs {
            name: "luna".into(),
            json: false,
        };
        assert_eq!(cmd_discard(&db, &args, Some(&go_ctx())), 0);

        assert_eq!(
            event_count(&db),
            before + 1,
            "only the placeholder stopped event may be added"
        );
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT COUNT(*) FROM events WHERE type='message' AND instance='mira'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1,
            "another actor's message was deleted"
        );
    }

    #[test]
    fn second_discard_is_refused() {
        // Bug caught: discarding an already-discarded name succeeds again and
        // duplicates the stopped event (or resurrects the row).
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        let args = DiscardArgs {
            name: "luna".into(),
            json: false,
        };
        assert_eq!(cmd_discard(&db, &args, Some(&go_ctx())), 0);
        let events_after_first = event_count(&db);

        assert_eq!(cmd_discard(&db, &args, Some(&go_ctx())), 1);
        assert_eq!(
            event_count(&db),
            events_after_first,
            "second discard appended another event"
        );
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(!taken.contains("luna"), "name re-taken by a failed second discard");
    }

    #[test]
    fn refuses_committed_name_through_command() {
        // Bug caught: cmd_discard skips the predicate and tears down a name
        // that authored work — history destroyed without an actionable error.
        let (_d, db) = make_test_db();
        insert_placeholder(&db, "luna");
        db.log_event("status", "luna", &serde_json::json!({"status": "active"}))
            .unwrap();

        let args = DiscardArgs {
            name: "luna".into(),
            json: false,
        };
        assert_eq!(cmd_discard(&db, &args, Some(&go_ctx())), 1);
        assert!(
            db.get_instance_full("luna").unwrap().is_some(),
            "refused discard deleted the row"
        );
        let (_alive, taken) = crate::instance_names::collect_taken_names(&db).unwrap();
        assert!(taken.contains("luna"), "refused discard freed the name");
    }
}
