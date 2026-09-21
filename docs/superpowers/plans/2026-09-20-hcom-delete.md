# hcom delete Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-09-20-hcom-delete.md`
**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix <xx>` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.

**Goal:** Add `hcom delete <name>`: remove a committed identity's live row and bindings, write a `life` `action=deleted` event, and free the name for re-mint — while historical events/mail keep the old token and former-name aliases stay taken but go dead.
**Architecture:** One new native command mirroring `discard`, reusing the existing `finalize_instance_stop` primitive (`src/db/instances.rs:402-465`) with an `action=deleted` event; one read-query change making `collect_taken_names` (`src/instance_names.rs:249-271`) latest-terminal-event-wins; router/help/`STATUS_SKIP_COMMANDS` wiring. No schema change, no new DB helpers, no changes to identity/send/alias resolution.
**Tech stack:** Rust + clap + rusqlite (existing repo stack; no new dependencies).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/instance_names.rs` | Modify `:254-263` (stopped clause of `collect_taken_names`); add tests at EOF | latest-terminal-event-wins taken semantics |
| `src/commands/delete.rs` | Create | `DeleteArgs`, `cmd_delete`, refusals, `--go` gate, finalize + post-commit teardown, acceptance tests |
| `src/commands/mod.rs` | Modify `:9-10` | `pub mod delete;` (alphabetical: between `daemon` and `discard`) |
| `src/router.rs` | Modify `:39` (COMMANDS), `:610` (guard list), after `:840-844` (dispatch arm) | route `delete` |
| `src/cli_context.rs` | Modify `:23-25` | `STATUS_SKIP_COMMANDS` += `"delete"` |
| `src/commands/help.rs` | Modify after `:438` (DELETE_HELP), after `:964` (COMMAND_NAMES), after `:1038` (top-level table), after `:1164` (dispatch), after `:1444` (test list) | help surface |

Task order and dependencies: T1 → T2 (delete's name-freeing tests rely on the new taken semantics); T2 → T3 (help documents a shipped command; the router arm references `crate::commands::delete`).

Test runner (Justfile:75-76): `just test <filter>` = `cargo test --locked <filter>` under the CI TMPDIR. Use exactly these filters; do not run the full suite.

---

### Task 1: `collect_taken_names` — latest terminal event wins

**Owner:** builder
**Files:**
- Modify: `src/instance_names.rs:254-263`
- Test: `src/instance_names.rs` (new `#[cfg(test)] mod delete_taken_tests` appended at end of file, after `:899`)

**Verification (anti-gameable):** `just test delete_taken_tests` passes 5 tests against a real on-disk DB, including `deleted_releases_stopped_name` (fails before the change) and `stopped_keeps_name_taken` (regression guard that today's stop behavior is unchanged).

- [ ] **Step 1: Write the failing tests**

Append to `src/instance_names.rs`:

```rust
#[cfg(test)]
mod delete_taken_tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_db() -> (TempDir, HcomDb) {
        let tmp = TempDir::new().unwrap();
        let db = HcomDb::open_raw(&tmp.path().join("test.db")).unwrap();
        db.init_db().unwrap();
        (tmp, db)
    }

    fn life_event(db: &HcomDb, name: &str, action: &str, placeholder: bool) {
        let data = if placeholder {
            serde_json::json!({"action": action, "placeholder": true})
        } else {
            serde_json::json!({"action": action})
        };
        db.log_event("life", name, &data).unwrap();
    }

    fn taken(db: &HcomDb) -> std::collections::HashSet<String> {
        collect_taken_names(db).unwrap().1
    }

    #[test]
    fn stopped_keeps_name_taken() {
        // Regression guard: plain stop still retires the name.
        let (_t, db) = setup_db();
        life_event(&db, "luna", "stopped", false);
        assert!(taken(&db).contains("luna"));
    }

    #[test]
    fn deleted_releases_stopped_name() {
        // Bug caught: stopped clause ignores the newer deleted event, so a
        // reclaimed-then-deleted name stays taken forever.
        let (_t, db) = setup_db();
        life_event(&db, "luna", "stopped", false);
        life_event(&db, "luna", "deleted", false);
        assert!(!taken(&db).contains("luna"), "deleted name still taken");
    }

    #[test]
    fn stopped_after_deleted_retakes() {
        // Re-mint then stop: the newer stopped event wins over the stale
        // deleted one.
        let (_t, db) = setup_db();
        life_event(&db, "luna", "deleted", false);
        life_event(&db, "luna", "stopped", false);
        assert!(taken(&db).contains("luna"));
    }

    #[test]
    fn deleted_only_is_free() {
        let (_t, db) = setup_db();
        life_event(&db, "luna", "deleted", false);
        assert!(!taken(&db).contains("luna"));
    }

    #[test]
    fn placeholder_stopped_still_ignored() {
        // Discard's free path survives the rewrite.
        let (_t, db) = setup_db();
        life_event(&db, "luna", "stopped", true);
        assert!(!taken(&db).contains("luna"));
    }
}
```

- [ ] **Step 2: Run tests to verify the failing signal**

Run: `just test delete_taken_tests`
Expected: `deleted_releases_stopped_name` FAILS with `deleted name still taken`; the other four PASS. If any other test fails, stop — the fixture is wrong, not the code.

- [ ] **Step 3: Rewrite the stopped clause**

Replace the `stopped` query at `src/instance_names.rs:254-263`:

```rust
    let stopped: Vec<String> = {
        let mut stmt = db.conn().prepare(
            "SELECT DISTINCT instance FROM events e
             WHERE e.type = 'life'
               AND json_extract(e.data, '$.action') = 'stopped'
               AND COALESCE(json_extract(e.data, '$.placeholder'), 0) != 1
               AND NOT EXISTS (
                   SELECT 1 FROM events newer
                   WHERE newer.type = 'life'
                     AND newer.instance = e.instance
                     AND json_extract(newer.data, '$.action') IN ('stopped', 'deleted')
                     AND COALESCE(json_extract(newer.data, '$.placeholder'), 0) != 1
                     AND newer.id > e.id
               )",
        )?;
        stmt.query_map([], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect()
    };
```

Add a comment above it: `// Latest terminal event wins: a newer non-placeholder stopped/deleted supersedes. deleted releases the name (hcom delete); stopped retains it.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `just test delete_taken_tests`
Expected: PASS, 5 passed.

Run: `just test instance_names`
Expected: PASS — all pre-existing instance_names tests (reservation, allocation) still green.

- [ ] **Step 5: Commit**

```bash
git add src/instance_names.rs
git commit -m "instance_names: latest terminal life event wins for taken names (hcom-4n3.5)"
```

---

### Task 2: `src/commands/delete.rs` — the delete command

**Owner:** builder
**Files:**
- Create: `src/commands/delete.rs`
- Modify: `src/commands/mod.rs:9-10` (add `pub mod delete;` between `daemon` and `discard` — needed for the tests to compile)
- Test: `src/commands/delete.rs` (inline `#[cfg(test)] mod tests`)

**Verification (anti-gameable):** `just test commands::delete` passes 8 new tests that exercise `cmd_delete` end-to-end against a real on-disk DB: row/binding deletion, name freeing, historical-event preservation, live-pid refusal with `std::process::id()`, children refusal, retired/not-found split, placeholder acceptance, `--go` gate, and rename-alias death.

- [ ] **Step 1: Write the failing tests**

Create `src/commands/delete.rs` containing only the test module (the file will not compile until Step 3 — that compile error is the failing signal). Add `pub mod delete;` to `src/commands/mod.rs:9-10` now so the failure is about the missing functions, not the module:

```rust
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
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test commands::delete`
Expected: FAIL to compile — `cannot find function cmd_delete in this scope` / `cannot find type DeleteArgs` (E0425/E0412). Also `crate::instance_names::tests_env::InsideAiToolGuard` unresolved (added in Step 4).

- [ ] **Step 3: Implement `cmd_delete`**

Prepend above the test module in `src/commands/delete.rs`:

```rust
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
```

- [ ] **Step 4: Add the inside-AI-tool test guard**

The `go_gate_previews_without_go` test needs a deterministic "inside AI tool" environment. `is_inside_ai_tool` (`src/shared/platform.rs`) returns true when `HCOM_LAUNCHED=1`, so append to `src/instance_names.rs` (the `EnvVarGuard` pattern at `:818-848` is `mod reservation_tests`-private; add a small shared one):

```rust
#[cfg(test)]
pub(crate) mod tests_env {
    /// Sets HCOM_LAUNCHED=1 so is_inside_ai_tool() is true; restores on drop.
    /// Tests using this guard must be #[serial].
    pub(crate) struct InsideAiToolGuard {
        previous: Option<String>,
    }

    impl InsideAiToolGuard {
        pub(crate) fn set() -> Self {
            let previous = std::env::var("HCOM_LAUNCHED").ok();
            // SAFETY: tests using this guard are marked #[serial].
            unsafe { std::env::set_var("HCOM_LAUNCHED", "1") };
            Self { previous }
        }
    }

    impl Drop for InsideAiToolGuard {
        fn drop(&mut self) {
            // SAFETY: tests using this guard are marked #[serial].
            unsafe {
                match &self.previous {
                    Some(v) => std::env::set_var("HCOM_LAUNCHED", v),
                    None => std::env::remove_var("HCOM_LAUNCHED"),
                }
            }
        }
    }
}
```

Mark the gate test `#[serial]` (add `use serial_test::serial;` to the delete.rs test module):

```rust
    #[test]
    #[serial]
    fn go_gate_previews_without_go() {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `just test commands::delete`
Expected: PASS, 8 passed.

Run: `just test delete_taken_tests`
Expected: PASS, 5 passed (Task 1 semantics intact through the command path).

- [ ] **Step 6: Commit**

```bash
git add src/commands/delete.rs src/commands/mod.rs src/instance_names.rs
git commit -m "commands: hcom delete — remove a committed identity and free the name (hcom-4n3.5)"
```

---

### Task 3: Router, cli_context, and help wiring

**Owner:** builder
**Files:**
- Modify: `src/router.rs:39` (COMMANDS), `src/router.rs:610` (guard list), `src/router.rs` after `:840-844` (dispatch arm)
- Modify: `src/cli_context.rs:23-25`
- Modify: `src/commands/help.rs` after `:438`, after `:964`, after `:1038`, after `:1164`, after `:1444`
- Test: `src/commands/help.rs` (`all_commands_have_help`), `src/commands/delete.rs` (clap parse test)

**Verification (anti-gameable):** `just test all_commands_have_help` fails until `get_command_help("delete")` returns content, then passes; `just test commands::delete` passes a new clap parse test proving `delete <name> --json` parses through the same `clap_dispatch!` shape the router uses. The router match arm is compile-checked by every `just test` run (non-exhaustive command match would fail to build the dispatch).

- [ ] **Step 1: Write the failing test**

In `src/commands/help.rs`, add `"delete"` to the `all_commands_have_help` list after `"rename"` (`:1444`):

```rust
            "discard",
            "rename",
            "delete",
            "start",
```

Add to the `src/commands/delete.rs` test module:

```rust
    #[test]
    fn parses_name_and_json_flag() {
        use clap::Parser;
        let a = DeleteArgs::try_parse_from(["delete", "luna", "--json"]).unwrap();
        assert_eq!(a.name, "luna");
        assert!(a.json);
        assert!(DeleteArgs::try_parse_from(["delete"]).is_err());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test all_commands_have_help`
Expected: FAIL — `get_command_help("delete")` returns None (assertion naming `delete`).

Run: `just test commands::delete`
Expected: PASS (parse test passes immediately — it guards against regressions in the args shape; the help test is this task's failing signal).

- [ ] **Step 3: Wire help**

In `src/commands/help.rs`:

1. After `RENAME_HELP` (`:432-438`):

```rust
const DELETE_HELP: &[HelpEntry] = &[
    ("delete <name>", "Delete a committed identity and free its name"),
    ("  --json", "Machine-readable output"),
    ("  --go", "Confirm when run inside an AI tool"),
    ("", ""),
    ("", "Refused while the process is alive; stop it first."),
    ("", "History keeps the name; former-name aliases go dead."),
];
```

2. `COMMAND_NAMES` (`:948-976`): add `"delete",` after `"rename",` (`:964`).
3. Top-level table: after the rename line (`:1038`) add

```rust
  delete       Delete a committed identity (frees the name)\n\
```

4. Per-command dispatch (`:1163-1164`): add `"delete" => Some(DELETE_HELP),` after the rename arm.

- [ ] **Step 4: Wire router and cli_context**

1. `src/router.rs:39` — add `"delete",` to `COMMANDS` after `"rename",`.
2. `src/router.rs:610` — add `"delete"` to the `Action::Command` guard list after `"rename"`.
3. `src/router.rs` — add the dispatch arm immediately after the rename arm (`:840-844`):

```rust
        "delete" => clap_dispatch!(
            crate::commands::delete::DeleteArgs,
            cmd,
            &cmd_argv,
            |args| crate::commands::delete::cmd_delete(&db, &args, Some(&ctx))
        ),
```

4. `src/cli_context.rs:23-25` — add `"delete"` to `STATUS_SKIP_COMMANDS` (lifecycle command handled internally, same class as stop/kill/discard/rename):

```rust
const STATUS_SKIP_COMMANDS: &[&str] = &[
    "listen", "start", "stop", "kill", "reset", "status", "discard", "rename", "delete",
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `just test all_commands_have_help`
Expected: PASS.

Run: `just test help`
Expected: PASS — every help test (including `command_names_covers_released_tools` and the version test) green.

Run: `just test commands::delete`
Expected: PASS, 9 passed.

- [ ] **Step 6: Commit**

```bash
git add src/router.rs src/cli_context.rs src/commands/help.rs src/commands/delete.rs
git commit -m "router/help: wire hcom delete (hcom-4n3.5)"
```
