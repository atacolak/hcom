# hcom rename Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-09-19-hcom-rename.md`
**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix <xx>` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.

**Goal:** Add `hcom rename <old> <new>`: rewrite the live `instances.name` PK and every name-keyed live binding in one transaction, record a former→current alias that stays taken and resolves to the current row, and leave all historical tokens untouched.
**Architecture:** One new native command mirroring `discard`, one new table `instance_aliases` (schema 19) with write-time chain collapse, and an alias hop threaded through the three existing resolution seams (`identity::resolve_display_name`/`resolve_from_name`, send's `resolve_targets`, `instance_names::collect_taken_names`). The rename is a single `with_immediate_transaction` with `PRAGMA defer_foreign_keys = ON`; the `life/renamed` audit event is inserted in the same transaction.
**Tech stack:** Rust + clap + rusqlite (existing repo stack; no new dependencies).

**External dependency (sibling hcom-4n3.1):** the shared chosen-name validator, expected as `crate::instance_names::validate_chosen_name(name: &str) -> Result<(), String>` (frozen grammar `^[a-z][a-z0-9_]{0,23}$`, reserved `all` + `instance_names::banned_names`). Task 5 calls it. Builders: before Task 5, run `grep -n "pub fn validate_chosen_name" src/instance_names.rs`. If absent, STOP and report blocked on hcom-4n3.1 to the lead — do **not** implement the grammar (it is a non-goal here). If .1 exported it under a different name, use that name and note it in the Task 5 bead.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/db/aliases.rs` | Create | Owns `instance_aliases`: `alias_current`, `alias_map`, `former_names`, `record_alias_tx` |
| `src/db/mod.rs` | Modify `:40` (SCHEMA_VERSION→19), `:42-70` (MIGRATIONS +19), `:266-426` (init_db CREATE TABLE), `:24-32` (`pub(crate) mod aliases;`), `:929-937` area (3 `HcomDb` wrappers), tests | Schema 19 + delegation |
| `src/instance_names.rs` | Modify `:249-267` | `collect_taken_names` includes former names |
| `src/instances.rs` | Modify tests (`:265` area) | taken-names test |
| `src/identity.rs` | Modify `:125-142`, `:202-267`, tests | alias hop in both resolvers |
| `src/messages.rs` | Modify `:343-361` (`resolve_targets`), `:372` (`compute_scope`), tests `:1142-1210` | alias-map param + alias re-match on miss |
| `src/commands/send.rs` | Modify `:285-298` (`resolve_delivery`) | load alias map, pass to `compute_scope` |
| `src/commands/rename.rs` | Create | `RenameArgs`, `cmd_rename`, transaction, acceptance tests |
| `src/commands/mod.rs` | Modify `:8-16` | `pub mod rename;` (Lifecycle) |
| `src/router.rs` | Modify `:23-43` (COMMANDS), `:602-622` (guard), after `:832-837` (dispatch arm) | route `rename` |
| `src/cli_context.rs` | Modify `:23-26` | `STATUS_SKIP_COMMANDS` += `"rename"` |
| `src/launcher.rs` | Modify `:1548-1580`, tests `:3702` area | former-name bail in `resolve_explicit_name_conflict` |
| `src/commands/help.rs` | Modify after `:430` (RENAME_HELP), `:954` (COMMAND_NAMES), `:1027` (table), `:1152` (dispatch), `:1431` (test list) | help surface |
| `README.md` | Modify after `:37` | one bullet for `rename` |

Task order and dependencies: T1 → T2, T3, T4, T6 (all read the alias table); T3 + T4 → T5 (rename's tests use the new resolver signatures); T5 → T7 (help documents a shipped command). T2/T3/T4/T6 are mutually independent.

---

### Task 1: Schema 19 + `instance_aliases` accessors

**Owner:** builder
**Files:**
- Create: `src/db/aliases.rs`
- Modify: `src/db/mod.rs:40`, `src/db/mod.rs:42-70`, `src/db/mod.rs:266-426`, `src/db/mod.rs:24-32`, `src/db/mod.rs` tests module
- Test: `src/db/aliases.rs` (inline `#[cfg(test)]`), `src/db/mod.rs` (migration test)

**Verification (anti-gameable):** `just test aliases` passes 1 new test that round-trips an alias and proves chain collapse against a real on-disk DB; `just test migration_v19` passes, proving a v18-stamped DB gains the table via `ensure_schema` (not via fresh init).

- [x] **Step 1: Write the failing tests**

Create `src/db/aliases.rs` containing only the test module first (the file will not compile until Step 3 — that compile error is the failing signal):

```rust
#[cfg(test)]
mod tests {
    use crate::db::HcomDb;
    use super::record_alias_tx;

    fn make_test_db() -> (tempfile::TempDir, HcomDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = HcomDb::open_raw(&dir.path().join("test.db")).unwrap();
        db.init_db().unwrap();
        (dir, db)
    }

    #[test]
    fn alias_roundtrip_and_chain_collapse() {
        let (_d, db) = make_test_db();
        assert!(db.alias_current("luna").unwrap().is_none());

        db.with_immediate_transaction(|tx| record_alias_tx(tx, "luna", "luna_lead"))
            .unwrap();
        assert_eq!(db.alias_current("luna").unwrap().as_deref(), Some("luna_lead"));

        // Second rename: the oldest former maps to the latest current.
        db.with_immediate_transaction(|tx| record_alias_tx(tx, "luna_lead", "luna_lead2"))
            .unwrap();
        assert_eq!(db.alias_current("luna").unwrap().as_deref(), Some("luna_lead2"));
        assert_eq!(db.alias_current("luna_lead").unwrap().as_deref(), Some("luna_lead2"));

        let former = db.former_names().unwrap();
        assert!(former.contains(&"luna".to_string()));
        assert!(former.contains(&"luna_lead".to_string()));
        let map = db.alias_map().unwrap();
        assert_eq!(map.get("luna").map(String::as_str), Some("luna_lead2"));
    }
}
```

Add to `src/db/mod.rs`'s test module:

```rust
    #[test]
    fn test_migration_v19_adds_instance_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        {
            let db = HcomDb::open_raw(&db_path).unwrap();
            db.init_db().unwrap();
            // Simulate a v18 DB: drop the new table, stamp the old version.
            db.conn()
                .execute_batch("DROP TABLE instance_aliases; PRAGMA user_version = 18;")
                .unwrap();
        }
        let mut db = HcomDb::open_raw(&db_path).unwrap();
        db.ensure_schema().unwrap();
        let version: i32 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        // Table exists and is queryable (would error if the migration missed it).
        db.conn()
            .query_row("SELECT former, current FROM instance_aliases LIMIT 1", [], |_| {
                Ok(())
            })
            .unwrap();
    }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `just test aliases`
Expected: FAIL to compile — `unresolved import` / `no function or associated item named` `alias_current` (E0432/E0599). Also run `just test migration_v19` → FAIL: `DROP TABLE instance_aliases` errors with "no such table" (or, if init_db already landed partially, `user_version` mismatch).

- [x] **Step 3: Implement schema 19 + accessors**

In `src/db/mod.rs`:
1. `:40` → `const SCHEMA_VERSION: i32 = 19;`
2. Append to `MIGRATIONS` (after the `(18, …)` entry ending at `:69`):

```rust
    (
        19,
        "CREATE TABLE IF NOT EXISTS instance_aliases (
             former TEXT PRIMARY KEY,
             current TEXT NOT NULL
         );",
    ),
```

3. In `init_db`'s `execute_batch` (after the kv table at `:360`):

```sql
            -- Former-name aliases recorded by `hcom rename`
            CREATE TABLE IF NOT EXISTS instance_aliases (
                former TEXT PRIMARY KEY,
                current TEXT NOT NULL
            );
```

4. With the module declarations (`:24-32`): `pub(crate) mod aliases;`
5. With the `HcomDb` delegation wrappers (`:929-937` area; add `use std::collections::HashMap;` at the top if not already imported):

```rust
    /// Current name for a former (renamed-away) name.
    pub fn alias_current(&self, former: &str) -> Result<Option<String>> {
        aliases::alias_current(self, former)
    }

    /// Full former → current alias map (send target resolution).
    pub fn alias_map(&self) -> Result<HashMap<String, String>> {
        aliases::alias_map(self)
    }

    /// All reserved former names (collected into the taken set).
    pub fn former_names(&self) -> Result<Vec<String>> {
        aliases::former_names(self)
    }
```

Prepend the implementation to `src/db/aliases.rs` (above the test module):

```rust
//! Former-name alias storage for `hcom rename` (table `instance_aliases`).
//!
//! A rename rewrites the live `instances.name` PK and records the old name
//! here. Former names stay taken forever (historical stability; not discard)
//! and resolve to the current row via the alias hop in identity/send
//! resolution. Chains collapse at write time: `record_alias_tx` retargets
//! every alias pointing at the old current name, so resolution is one hop.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Transaction, params};

use super::HcomDb;

/// Current name for a former name, if the former name was renamed away.
pub fn alias_current(db: &HcomDb, former: &str) -> Result<Option<String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT current FROM instance_aliases WHERE former = ?")?;
    let mut rows = stmt.query_map(params![former], |r| r.get(0))?;
    Ok(rows.next().transpose()?)
}

/// Full former → current map.
pub fn alias_map(db: &HcomDb) -> Result<HashMap<String, String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT former, current FROM instance_aliases")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// All former names (reserved).
pub fn former_names(db: &HcomDb) -> Result<Vec<String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT former FROM instance_aliases")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Record `old -> new` inside the rename transaction. Retargets existing
/// aliases whose current is `old` (chain collapse), then inserts the new
/// former row. Plain INSERT: the taken-invariant makes a duplicate former
/// impossible — a PK violation rolls the rename back and surfaces the break.
pub(crate) fn record_alias_tx(tx: &Transaction, old: &str, new: &str) -> Result<()> {
    tx.execute(
        "UPDATE instance_aliases SET current = ?2 WHERE current = ?1",
        params![old, new],
    )?;
    tx.execute(
        "INSERT INTO instance_aliases (former, current) VALUES (?1, ?2)",
        params![old, new],
    )?;
    Ok(())
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `just test aliases`
Expected: `test result: ok. 1 passed` (`db::aliases::tests::alias_roundtrip_and_chain_collapse`)
Run: `just test migration_v19`
Expected: `test result: ok. 1 passed` (`db::tests::test_migration_v19_adds_instance_aliases`)

- [ ] **Step 5: Commit**

```bash
git add src/db/aliases.rs src/db/mod.rs
git commit -m "feat(db): schema 19 instance_aliases table + former-name accessors"
```

---

### Task 2: `collect_taken_names` includes former names

**Owner:** builder
**Files:**
- Modify: `src/instance_names.rs:249-267`
- Test: `src/instances.rs` (tests module, alongside `:265`)

**Verification (anti-gameable):** `just test taken_names` passes 3 tests — the two pre-existing (`test_collect_taken_names_includes_stopped_snapshots`, `test_collect_taken_names_ignores_placeholder_stops`, proving no regression) plus the new former-name test.

- [x] **Step 1: Write the failing test**

Add to `src/instances.rs` tests (uses the existing `setup_test_db`/`cleanup` fixtures, mirroring `:265-289`):

```rust
    #[test]
    fn test_collect_taken_names_includes_former_aliases() {
        // Bug caught: rename reserves the old name; without this clause the
        // mint re-issues a former name and the alias then points at two
        // actors.
        let (db, path) = setup_test_db();
        db.conn()
            .execute(
                "INSERT INTO instance_aliases (former, current) VALUES ('luna', 'luna_lead')",
                [],
            )
            .unwrap();

        let (_alive, taken) = collect_taken_names(&db).unwrap();
        assert!(taken.contains("luna"));

        cleanup(path);
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `just test taken_names`
Expected: FAIL — `test_collect_taken_names_includes_former_aliases` panics: `assertion failed: taken.contains("luna")`

- [x] **Step 3: Extend `collect_taken_names`**

In `src/instance_names.rs:249-267`, immediately before `Ok((alive_names, taken_names))`:

```rust
    // Former names reserved by `hcom rename` stay taken (historical stability).
    taken_names.extend(crate::db::aliases::former_names(db)?);
```

- [x] **Step 4: Run test to verify it passes**

Run: `just test taken_names`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add src/instance_names.rs src/instances.rs
git commit -m "feat(names): former rename aliases stay in the taken set"
```

---

### Task 3: Identity resolution alias hop

**Owner:** builder
**Files:**
- Modify: `src/identity.rs:125-142` (`resolve_display_name`), `src/identity.rs:202-267` (`resolve_from_name`)
- Test: `src/identity.rs` (tests module)

**Verification (anti-gameable):** `just test resolve_display_name` and `just test resolve_from_name` pass, including two new tests that build a real DB, insert a live row plus an alias row, and assert the former name resolves to the current row while exact-name and miss behavior are unchanged.

- [x] **Step 1: Write the failing tests**

Add to `src/identity.rs` tests:

```rust
    fn make_test_db() -> (tempfile::TempDir, crate::db::HcomDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::HcomDb::open_raw(&dir.path().join("test.db")).unwrap();
        db.init_db().unwrap();
        (dir, db)
    }

    fn insert_live(db: &crate::db::HcomDb, name: &str) {
        db.conn()
            .execute(
                "INSERT INTO instances (name, status, status_context, status_time, created_at, last_seen, last_event_id)
                 VALUES (?1, 'listening', 'start', 0, 1, 0, 0)",
                [name],
            )
            .unwrap();
    }

    #[test]
    fn resolve_display_name_follows_rename_alias() {
        let (_d, db) = make_test_db();
        insert_live(&db, "luna_lead");
        db.conn()
            .execute(
                "INSERT INTO instance_aliases (former, current) VALUES ('luna', 'luna_lead')",
                [],
            )
            .unwrap();

        // Former name resolves to the current row.
        assert_eq!(resolve_display_name(&db, "luna").as_deref(), Some("luna_lead"));
        // Exact name still wins.
        assert_eq!(
            resolve_display_name(&db, "luna_lead").as_deref(),
            Some("luna_lead")
        );
        // Unknown name still misses.
        assert_eq!(resolve_display_name(&db, "nobody"), None);
    }

    #[test]
    fn resolve_from_name_follows_rename_alias() {
        let (_d, db) = make_test_db();
        insert_live(&db, "luna_lead");
        db.conn()
            .execute(
                "INSERT INTO instance_aliases (former, current) VALUES ('luna', 'luna_lead')",
                [],
            )
            .unwrap();

        let id = resolve_from_name(&db, "luna").unwrap();
        assert_eq!(id.name, "luna_lead");
        assert!(matches!(id.kind, SenderKind::Instance));
        // Unknown name still errors.
        assert!(resolve_from_name(&db, "nobody").is_err());
    }
```

(`SenderKind` is already imported at `src/identity.rs:7`.)

- [x] **Step 2: Run tests to verify they fail**

Run: `just test resolve_display_name`
Expected: FAIL — `resolve_display_name_follows_rename_alias` panics: `assertion failed: … (left: None, right: Some("luna_lead"))`
Run: `just test resolve_from_name`
Expected: FAIL — `resolve_from_name_follows_rename_alias` panics on `.unwrap()` of the `Err(NotFound)`

- [x] **Step 3: Add the alias hop**

In `resolve_display_name` (`src/identity.rs:125-142`), between the exact-name block and the `match_indices('-')` loop:

```rust
    // Former-name alias: a renamed actor's old name resolves to its current
    // row. Former names stay taken, so this can never shadow a live name.
    if let Ok(Some(current)) = db.alias_current(input_name)
        && let Ok(Some(_)) = db.get_instance_full(&current)
    {
        return Some(current);
    }
```

In `resolve_from_name` (`src/identity.rs:202-267`), after the exact-name lookup block (`:214-231`) and before the agent-id lookup (`:233`), mirroring step 1's `session_id` extraction (`:223-229`):

```rust
    // 1b. Former-name alias (renamed actor's old name)
    if let Ok(Some(current)) = db.alias_current(&resolved_name)
        && let Ok(Some(data)) = db.get_instance(&current)
    {
        crate::log::log_info(
            "identity",
            "resolve_from_name",
            &format!("name={}, method=alias, resolved={}", resolved_name, current),
        );
        return Ok(SenderIdentity {
            kind: SenderKind::Instance,
            name: current,
            session_id: data
                .get("session_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            instance_data: Some(data),
        });
    }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `just test resolve_display_name`
Expected: `test result: ok.` — all tests in that filter pass (existing + new)
Run: `just test resolve_from_name`
Expected: `test result: ok.` — all pass

- [ ] **Step 5: Commit**

```bash
git add src/identity.rs
git commit -m "feat(identity): former-name alias hop in display/from-name resolution"
```

---

### Task 4: Send target resolution follows aliases

**Owner:** builder
**Files:**
- Modify: `src/messages.rs:343-361` (`resolve_targets`), `src/messages.rs:372` (`compute_scope` signature + its two internal `resolve_targets` calls at `:386` and `:423`), `src/messages.rs` tests `:1142-1210`
- Modify: `src/commands/send.rs:285-298` (`resolve_delivery`)
- Test: `src/messages.rs` (tests module)

**Verification (anti-gameable):** `just test resolve_targets` and `just test compute_scope` pass — the pre-existing tests (updated for the new signature, proving no behavior change with an empty map) plus two new tests proving a former name resolves to the current instance and still reports unmatched when the alias target is absent.

- [x] **Step 1: Write the failing tests**

Add to `src/messages.rs` tests:

```rust
    #[test]
    fn resolve_targets_follows_rename_alias() {
        let instances = vec![InstanceInfo {
            name: "luna_lead".to_string(),
            tag: None,
        }];
        let aliases = HashMap::from([("luna".to_string(), "luna_lead".to_string())]);

        let (matched, unmatched) =
            resolve_targets(&["luna".to_string()], &instances, &aliases).unwrap();
        assert_eq!(matched, vec!["luna_lead".to_string()]);
        assert!(unmatched.is_empty());

        // Current name still matches exactly.
        let (matched, _) =
            resolve_targets(&["luna_lead".to_string()], &instances, &aliases).unwrap();
        assert_eq!(matched, vec!["luna_lead".to_string()]);

        // Alias whose current row is gone stays unmatched.
        let (_, unmatched) =
            resolve_targets(&["luna".to_string()], &[], &aliases).unwrap();
        assert_eq!(unmatched, vec!["luna".to_string()]);
    }

    #[test]
    fn compute_scope_mentions_follow_rename_alias() {
        let instances = vec![InstanceInfo {
            name: "luna_lead".to_string(),
            tag: None,
        }];
        let aliases = HashMap::from([("luna".to_string(), "luna_lead".to_string())]);
        let result = compute_scope("hey @luna fix this", &instances, None, &aliases).unwrap();
        assert_eq!(result.mentions, vec!["luna_lead".to_string()]);
    }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `just test resolve_targets`
Expected: FAIL to compile — `this function takes 2 arguments but 3 arguments were supplied` (E0061) at the new test, because `resolve_targets` has no `aliases` parameter yet.

- [x] **Step 3: Thread the alias map**

In `src/messages.rs` (add `use std::collections::HashMap;` if not already imported):

1. `resolve_targets` (`:343-361`) — new parameter and alias re-match on miss:

```rust
pub(crate) fn resolve_targets(
    targets: &[String],
    enabled_instances: &[InstanceInfo],
    aliases: &HashMap<String, String>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let target_instances = target_instances_with_sender(enabled_instances);
    let mut matched = Vec::new();
    let mut unmatched = Vec::new();

    for target in targets {
        let mut target_matches = match_target(target, &target_instances)?;
        // Former-name alias: exact match first; on miss, a renamed actor's
        // old name re-matches against its current name.
        if target_matches.is_empty()
            && let Some(current) = aliases.get(target)
        {
            target_matches = match_target(current, &target_instances)?;
        }
        if target_matches.is_empty() {
            unmatched.push(target.clone());
        } else {
            matched.extend(target_matches);
        }
    }

    Ok((dedup_preserving_order(&matched), unmatched))
}
```

2. `compute_scope` (`:372`) — add `aliases: &HashMap<String, String>` as the fourth parameter and pass it to both internal `resolve_targets` calls (`:386`, `:423`).
3. Update the pre-existing tests (`:1142-1210`): every `compute_scope(...)` call gets `&HashMap::new()` as the new last argument.
4. `src/commands/send.rs` `resolve_delivery` (`:285-298`) — load and pass the map:

```rust
    let rows = deliverable_instances(db)?;
    let aliases = db.alias_map().unwrap_or_default();

    // Compute scope and routing. Thread-only sends keep their original message
    // semantics; membership only affects the delivery target set.
    let scope_result = compute_scope(message, &rows, explicit_targets, &aliases)?;
```

- [x] **Step 4: Run tests to verify they pass**

Run: `just test resolve_targets`
Expected: `test result: ok.` — all pass
Run: `just test compute_scope`
Expected: `test result: ok.` — all pass

- [ ] **Step 5: Commit**

```bash
git add src/messages.rs src/commands/send.rs
git commit -m "feat(send): @mentions of former names resolve to the current instance"
```

---

### Task 5: `hcom rename` command + wiring

**Owner:** builder
**Files:**
- Create: `src/commands/rename.rs`
- Modify: `src/commands/mod.rs:8-16`, `src/router.rs:23-43`, `src/router.rs:602-622`, `src/router.rs` (dispatch, after `:837`), `src/cli_context.rs:23-26`
- Test: `src/commands/rename.rs` (inline `#[cfg(test)]`)

**Prerequisite check (do first):** `grep -n "pub fn validate_chosen_name" src/instance_names.rs` — if no match, STOP and report blocked on hcom-4n3.1 to the lead. Do not implement the grammar.

**Verification (anti-gameable):** `just test commands::rename` passes the full acceptance suite below against real on-disk DBs — including the bead acceptance: bindings follow, historical event keeps the old token, both names resolve, live-pid exits 1, taken target exits 1. `just test cli_commands_detected` passes (router recognizes `rename`). Compilation of the crate (implied by any test run) proves the router dispatch arm and `mod` wiring.

- [x] **Step 1: Write the failing tests**

Create `src/commands/rename.rs` with only this test module (compile error until Step 3 is the failing signal):

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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `just test commands::rename`
Expected: FAIL to compile — `unresolved import` / cannot find `cmd_rename`, `RenameArgs` in `super` (E0432/E0425), since the implementation above the test module does not exist yet.

- [x] **Step 3: Implement the command and wiring**

Prepend to `src/commands/rename.rs` (above the test module):

```rust
//! `hcom rename <old> <new>` — rewrite a live instance identity to a new name.
//!
//! Spec: docs/superpowers/specs/2026-09-19-hcom-rename.md. Rename is identity
//! *continuation*: the `instances.name` PK and every live name-keyed binding
//! follow; historical `events.instance` and mail JSON keep the old token; the
//! old name is recorded in `instance_aliases` (stays taken; resolves to the
//! current row). Refused while the process is alive — HCOM_INSTANCE_NAME is
//! process env, so a live rewrite split-brains the plugin.

use rusqlite::params;

use crate::db::{HcomDb, aliases::record_alias_tx};
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
        Ok(None) => return fail(args.json, "not_found", old, new, "instance not found (already stopped?)"),
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

    // 3. Frozen chosen-name grammar (hcom-4n3.1).
    if let Err(msg) = crate::instance_names::validate_chosen_name(new) {
        return fail(args.json, "invalid_name", old, new, &msg);
    }

    // 4. Taken set: live rows + stopped-historical + reserved former names.
    //    (`new == old` is caught here: old's live row is in the set.)
    let taken = match crate::instance_names::collect_taken_names(db) {
        Ok((_alive, taken)) => taken,
        Err(e) => return fail(args.json, "rename_failed", old, new, &e.to_string()),
    };
    if taken.contains(new) {
        return fail(args.json, "name_taken", old, new, "name is taken or reserved");
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
```

Wiring:

1. `src/commands/mod.rs` — in the Lifecycle group (`:8-16`), add `pub mod rename;` (alphabetical: between `launch` and `resume`).
2. `src/router.rs:23-43` (`COMMANDS`) — add `"rename",` after `"discard",` (`:38`).
3. `src/router.rs:602-622` (`Action::Command` guard) — add `| "rename"` after `| "discard"` (`:608`).
4. `src/router.rs` dispatch — after the `"discard"` arm (`:832-837`):

```rust
        "rename" => clap_dispatch!(
            crate::commands::rename::RenameArgs,
            cmd,
            &cmd_argv,
            |args| crate::commands::rename::cmd_rename(&db, &args, Some(&ctx))
        ),
```

5. `src/cli_context.rs:23-26` (`STATUS_SKIP_COMMANDS`) — append `"rename"` (lifecycle command, handled internally, same class as stop/kill/discard).

Note: `crate::db::chrono_now_iso` is `pub(super)` at `src/db/mod.rs:973` (visible crate-wide via the parent module). If the compiler disagrees, change it to `pub(crate)` and note it in the bead.

- [x] **Step 4: Run tests to verify they pass**

Run: `just test commands::rename`
Expected: `test result: ok. 10 passed` (all tests in the new module)
Run: `just test cli_commands_detected`
Expected: `test result: ok. 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/commands/rename.rs src/commands/mod.rs src/router.rs src/cli_context.rs
git commit -m "feat(rename): hcom rename <old> <new> — live PK rewrite + former-name alias"
```

---

### Task 6: Explicit mint rejects former names

**Owner:** builder
**Files:**
- Modify: `src/launcher.rs:1548-1580` (`resolve_explicit_name_conflict`)
- Test: `src/launcher.rs` (tests module, alongside `:3702`)

**Verification (anti-gameable):** `just test explicit_name_conflict` passes — the four pre-existing tests (free/inactive/pending/active behavior unchanged) plus the new test proving a former name is rejected even with no live row.

- [x] **Step 1: Write the failing test**

Add to `src/launcher.rs` tests (uses the existing `launcher_test_db` fixture, mirroring `:3702-3705`):

```rust
    #[test]
    fn resolve_explicit_name_conflict_rejects_former_name() {
        // Bug caught: without this guard, `--instance <former>` mints onto a
        // name rename reserved, and the alias then points at two actors.
        let db = launcher_test_db();
        db.conn()
            .execute(
                "INSERT INTO instance_aliases (former, current) VALUES ('luna', 'luna_lead')",
                [],
            )
            .unwrap();
        assert!(resolve_explicit_name_conflict(&db, "luna").is_err());
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `just test explicit_name_conflict`
Expected: FAIL — `resolve_explicit_name_conflict_rejects_former_name` panics: `assertion failed: resolve_explicit_name_conflict(&db, "luna").is_err()`

- [x] **Step 3: Add the guard**

At the top of `resolve_explicit_name_conflict` (`src/launcher.rs:1548`), before the live-row lookup:

```rust
    // A former name reserved by `hcom rename` stays taken forever
    // (historical stability; not discard).
    if db.alias_current(name).ok().flatten().is_some() {
        bail!("Instance name '{name}' is reserved (renamed away); use a different name");
    }
```

- [x] **Step 4: Run test to verify it passes**

Run: `just test explicit_name_conflict`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Commit**

```bash
git add src/launcher.rs
git commit -m "fix(launch): --instance rejects reserved former names"
```

---

### Task 7: Help table + README

**Owner:** builder
**Files:**
- Modify: `src/commands/help.rs` (after `:430`, `:954`, `:1027`, `:1152`, `:1431`)
- Modify: `README.md` (after `:37`)

**Verification (anti-gameable):** `just test help` passes — including `all_commands_have_help` and `command_names_covers_released_tools` with `rename` added to the lists (a missing `RENAME_HELP` or dispatch arm fails `all_commands_have_help`; a missing `COMMAND_NAMES` entry fails the drift guard). `just test cli_commands_detected` stays green.

- [x] **Step 1: Add `RENAME_HELP` and wire it**

In `src/commands/help.rs`:

1. After `DISCARD_HELP` (`:418-430`):

```rust
const RENAME_HELP: &[HelpEntry] = &[
    ("rename <old> <new>", "Rename an instance (rewrites live bindings)"),
    ("  --json", "Machine-readable output"),
    ("", ""),
    ("", "Refused while the process is alive; stop/recycle it first."),
    ("", "Former name stays reserved and resolves to the new name."),
];
```

2. `COMMAND_NAMES` (`:939-975`): add `"rename",` after `"discard",` (`:954`).
3. Top-level help table (`:1019-1036`): after the `discard` line (`:1027`):

```rust
  rename       Rename an instance (former name stays reserved)\n\
```

4. Per-command dispatch (`:1152`): add `"rename" => Some(RENAME_HELP),` after the `"discard"` arm.
5. `all_commands_have_help` test list (`:1426-1431`): add `"rename",` after `"discard",`.

- [x] **Step 2: Run tests**

Run: `just test help`
Expected: `test result: ok.` — all help tests pass, including `all_commands_have_help` and `command_names_covers_released_tools`. (If `all_commands_have_help` fails naming `rename`, a wiring point in Step 1 was missed — fix it; do not weaken the test.)

- [x] **Step 3: README one line**

After the `discard` bullet (`README.md:35-37`):

```markdown
- **`hcom rename <old> <new>`.** Renames an instance whose process is stopped, rewriting live
  bindings (session/process bindings, notify endpoints, capabilities, children). The former name
  stays reserved and resolves to the new name; historical events and mail keep the old token.
```

- [ ] **Step 4: Commit**

```bash
git add src/commands/help.rs README.md
git commit -m "docs(rename): help table + README line for hcom rename"
```

---

## Self-review notes (planner)

- Spec coverage: every spec component maps to exactly one task (schema/accessors T1, taken-names T2, identity T3, send T4, command+wiring T5, launcher guard T6, docs T7). Bead acceptance criteria are covered by T5 tests `renames_row_and_all_live_bindings`, `historical_event_keeps_old_token`, `send_and_identity_resolve_former_name`, `fails_when_old_has_live_pid`, `fails_when_new_taken_by_live_row`.
- The grammar validator is an external contract (hcom-4n3.1), checked at T5 start; the grammar test names (`Bad Name`, `all`) exercise it without implementing it here.
- No task runs the project-wide suite; each uses a targeted `just test <filter>` (`just test *args` → `cargo test --locked <args>`, `Justfile:74-76`).
