# `hcom send --as-system` Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-09-14-as-system-send.md`
**Design Brief:** `/home/sf/worlds/personal/designs/hcom/as-system-send.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix <xx>` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.

**Goal:** Add a public `hcom send --as-system <source-id>` primitive that sends addressed-only mail as `sender_kind=system` without broadcasting to the village.
**Architecture:** One new clap flag on `SendArgs` mapped onto the existing `SenderKind::System` plumbing (event `sender_kind: "system"`, `sys_<name>` routing instance). New logic is confined to `cmd_send` (validation, mutual exclusion, identity branch, pre-send broadcast trap), a recut of `SenderIdentity::broadcasts()` to External-only, a pure argv-scan helper in the router for the identity-gate bypass, and one help-table row.
**Tech stack:** Rust, clap (derive), rusqlite, `cargo test --bin hcom` (binary-only crate).

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/shared/identity.rs` | `SenderIdentity` / `SenderKind` semantics | Recut `broadcasts()` to External-only; fix comments; update test |
| `src/commands/send.rs` | `hcom send` CLI | New `--as-system` flag, validation, mutual exclusion, subagent guard widening, System identity branch, broadcast trap; new tests |
| `src/router.rs` | CLI dispatch + identity gate | Extract `send_has_external_sender_flag()` pure helper recognizing `--as-system`; new test |
| `src/commands/help.rs` | Curated help tables | `SEND_HELP` gains `--as-system <source-id>` row; new test |

No other files change. `send_message`, `compute_scope`, `resolve_delivery`,
`check_identity_gate`, `src/identity.rs`, `src/db/events.rs` are untouched
(internal launch/notify system messages already write `scope: "mentions"`
directly and never call `broadcasts()`).

---

- [x] ### Task 1: Recut `broadcasts()` — System is not "always broadcast"

**Owner:** builder
**Files:**
- Modify: `src/shared/identity.rs:17-31` (enum doc + `broadcasts()`)
- Test: `src/shared/identity.rs:76-100` (`test_sender_identity_broadcasts`)

**Verification (anti-gameable):** `cargo test --bin hcom shared::identity` passes with the updated assertion `assert!(!system.broadcasts())` — the test asserts the new semantics, so a no-op implementation cannot pass.

- [ ] **Step 1: Update the test to the new contract (failing)**

In `src/shared/identity.rs`, `test_sender_identity_broadcasts`, change the
final assertion for the `system` identity:

```rust
        let system = SenderIdentity {
            kind: SenderKind::System,
            name: "hcom".into(),
            instance_data: None,
            session_id: None,
        };
        assert!(!system.broadcasts());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin hcom shared::identity`
Expected: FAIL — `test_sender_identity_broadcasts` panics on
`assert!(!system.broadcasts())` (current impl returns `true` for System).

- [ ] **Step 3: Recut the implementation and comments**

In `src/shared/identity.rs`:

```rust
    /// System-generated message (addressed delivery; does not broadcast).
    System,
```

```rust
    /// External senders broadcast to everyone. System senders are
    /// addressed-only: `hcom send --as-system` requires explicit @targets.
    pub fn broadcasts(&self) -> bool {
        matches!(self.kind, SenderKind::External)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --bin hcom shared::identity`
Expected: PASS (all tests in the module, including the updated
`test_sender_identity_broadcasts`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/identity.rs
git commit -m "identity: recut broadcasts() — System is addressed-only, External still broadcasts"
```

---

- [x] ### Task 2: `--as-system` flag, validation, mutual exclusion, System sender identity

**Owner:** builder
**Files:**
- Modify: `src/commands/send.rs:100-115` (SendArgs sender group), `src/commands/send.rs:699-737` (validation + guards), `src/commands/send.rs:863-908` (identity chain)
- Test: `src/commands/send.rs` (tests module, alongside existing `#[serial]` DB tests)

**Verification (anti-gameable):** `cargo test --bin hcom commands::send` runs the new tests, which assert the actual events row written to a real SQLite DB (`instance='sys_omp-runtime'`, `from='omp-runtime'`, `sender_kind='system'`, `delivered_to='["gina"]'` with a second instance `nova` present and excluded) and assert exit 1 + zero `message` events for the conflict/validation cases. DB state cannot be faked by the implementer.

- [ ] **Step 1: Write the failing tests**

Add to the tests module in `src/commands/send.rs`:

```rust
    #[test]
    fn parse_as_system_flag() {
        let args = SendArgs::try_parse_from([
            "send", "--as-system", "omp-runtime", "@gina", "--", "msg",
        ])
        .unwrap();
        assert_eq!(args.as_system.as_deref(), Some("omp-runtime"));

        let args = SendArgs::try_parse_from([
            "send", "--as-system=omp-runtime", "@gina", "--", "msg",
        ])
        .unwrap();
        assert_eq!(args.as_system.as_deref(), Some("omp-runtime"));
    }

    #[test]
    #[serial]
    fn as_system_send_writes_system_sender_event() {
        let (db, path, _env) = setup_test_db();
        db.conn()
            .execute(
                "INSERT INTO instances (name, created_at) VALUES ('gina', 1000.0), ('nova', 1000.0)",
                [],
            )
            .unwrap();

        let mut args = SendArgs::try_parse_from([
            "send", "--as-system", "omp-runtime", "@gina",
            "--intent", "inform", "--", "gen published",
        ])
        .unwrap();
        args.had_separator = true;

        let code = cmd_send(&db, &args, None);
        assert_eq!(code, 0);

        let (instance, from, sender_kind, scope, delivered_to): (
            String, String, String, String, String,
        ) = db
            .conn()
            .query_row(
                "SELECT instance,
                        json_extract(data, '$.from'),
                        json_extract(data, '$.sender_kind'),
                        json_extract(data, '$.scope'),
                        json_extract(data, '$.delivered_to')
                 FROM events WHERE type = 'message'
                 ORDER BY id DESC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(instance, "sys_omp-runtime");
        assert_eq!(from, "omp-runtime");
        assert_eq!(sender_kind, "system");
        assert_eq!(scope, "mentions");
        assert_eq!(delivered_to, "[\"gina\"]");

        cleanup_test_db(path);
    }

    #[test]
    #[serial]
    fn as_system_conflicts_with_from() {
        let (db, path, _env) = setup_test_db();
        let mut args = SendArgs::try_parse_from([
            "send", "--as-system", "omp-runtime", "--from", "healthcheck",
            "@gina", "--", "x",
        ])
        .unwrap();
        args.had_separator = true;

        assert_eq!(cmd_send(&db, &args, None), 1);
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM events WHERE type = 'message'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);

        cleanup_test_db(path);
    }

    #[test]
    #[serial]
    fn as_system_conflicts_with_as_instance() {
        let (db, path, _env) = setup_test_db();
        let mut args = SendArgs::try_parse_from([
            "send", "--as-system", "omp-runtime", "--as-instance", "@gina", "--", "x",
        ])
        .unwrap();
        args.had_separator = true;

        assert_eq!(cmd_send(&db, &args, None), 1);
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM events WHERE type = 'message'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);

        cleanup_test_db(path);
    }

    #[test]
    #[serial]
    fn as_system_source_id_validation() {
        let (db, path, _env) = setup_test_db();
        db.conn()
            .execute(
                "INSERT INTO instances (name, created_at) VALUES ('gina', 1000.0)",
                [],
            )
            .unwrap();

        for bad in ["@bad", "bad;id", &"x".repeat(51)] {
            let mut args = SendArgs::try_parse_from([
                "send", "--as-system", bad, "@gina", "--", "x",
            ])
            .unwrap();
            args.had_separator = true;
            assert_eq!(cmd_send(&db, &args, None), 1, "should reject: {bad}");
        }

        // Colons and hyphens are valid (systemd-ops:<operation-stem>)
        let mut args = SendArgs::try_parse_from([
            "send", "--as-system", "systemd-ops:operation-stem", "@gina", "--", "x",
        ])
        .unwrap();
        args.had_separator = true;
        assert_eq!(cmd_send(&db, &args, None), 0);

        cleanup_test_db(path);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --bin hcom commands::send`
Expected: FAIL to compile — `SendArgs` has no field `as_system`
(`parse_as_system_flag` and the others reference it).

- [ ] **Step 3: Add the flag to `SendArgs`**

In `src/commands/send.rs`, in the `── Sender ──` group of `SendArgs`,
immediately after the `as_instance` field:

```rust
    /// System sender identity (addressed @targets required, never broadcasts)
    #[arg(long = "as-system")]
    pub as_system: Option<String>,
```

- [ ] **Step 4: Add validation, mutual exclusion, and widen the subagent guard**

In `cmd_send`, immediately after the existing `from_name` validation block
(the `if let Some(ref name) = from_name { … }` that checks length/charset):

```rust
    if let Some(ref id) = args.as_system {
        if id.is_empty() || id.len() > 50 {
            eprintln!("Error: Source id must be 1-50 characters (got {})", id.len());
            return 1;
        }
        if !id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ':')
        {
            eprintln!(
                "Error: Source id must be alphanumeric with hyphens/underscores/colons"
            );
            return 1;
        }
    }

    if args.as_system.is_some() && (from_name.is_some() || args.as_instance) {
        eprintln!("Error: --as-system cannot be combined with --from/-b/--as-instance");
        return 1;
    }
```

Then widen the subagent guard: change

```rust
    // Guard: subagents cannot use --from/-b
    if from_name.is_some() {
```

to

```rust
    // Guard: subagents cannot use --from/-b/--as-system
    if from_name.is_some() || args.as_system.is_some() {
```

and inside it change the error line to:

```rust
                    eprintln!("Error: Subagents cannot use --from/-b/--as-system (sender spoofing)");
```

- [ ] **Step 5: Add the System sender identity branch**

In `cmd_send`'s sender-identity chain, insert a new branch **before**
`} else if let Some(ref name) = from_name {`:

```rust
    } else if let Some(ref source_id) = args.as_system {
        SenderIdentity {
            kind: SenderKind::System,
            name: source_id.clone(),
            instance_data: None,
            session_id: None,
        }
    } else if let Some(ref name) = from_name {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test --bin hcom commands::send`
Expected: PASS — `parse_as_system_flag`,
`as_system_send_writes_system_sender_event`,
`as_system_conflicts_with_from`, `as_system_conflicts_with_as_instance`,
`as_system_source_id_validation`, and all pre-existing send tests.

- [ ] **Step 7: Commit**

```bash
git add src/commands/send.rs
git commit -m "send: add --as-system flag with validation, conflicts, System sender identity"
```

---

- [x] ### Task 3: Trap settlement — `--as-system` never broadcasts

**Owner:** builder
**Files:**
- Modify: `src/commands/send.rs:945-956` (between preview delivery and the broadcast-preview gate)
- Test: `src/commands/send.rs` (tests module)

**Verification (anti-gameable):** `cargo test --bin hcom commands::send as_system_without_recipient` — the test asserts exit 1 **and** zero `message` events in the DB while two deliverable instances exist, i.e. proves no village broadcast row was written.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src/commands/send.rs`:

```rust
    #[test]
    #[serial]
    fn as_system_without_recipient_refuses_broadcast() {
        let (db, path, _env) = setup_test_db();
        db.conn()
            .execute(
                "INSERT INTO instances (name, created_at) VALUES ('gina', 1000.0), ('nova', 1000.0)",
                [],
            )
            .unwrap();

        let mut args = SendArgs::try_parse_from([
            "send", "--as-system", "omp-runtime", "--intent", "inform", "--", "x",
        ])
        .unwrap();
        args.had_separator = true;

        assert_eq!(cmd_send(&db, &args, None), 1);
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM events WHERE type = 'message'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "no event may be written for a recipient-less --as-system send");

        cleanup_test_db(path);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin hcom commands::send as_system_without_recipient`
Expected: FAIL — `cmd_send` returns 0 (message broadcasts), so the first
assertion fails.

- [ ] **Step 3: Add the trap guard**

In `cmd_send`, immediately after the `preview_delivery` `match` block (after
`Ok(delivery) => delivery, … };`) and **before** the `if is_inside_ai_tool()`
broadcast-preview block:

```rust
    // Trap settlement: --as-system is addressed-only. A recipient-less send
    // would broadcast to the village — refuse before anything is written.
    if args.as_system.is_some() && preview_delivery.original_scope == MessageScope::Broadcast {
        eprintln!(
            "Error: --as-system requires at least one @recipient. Refusing to broadcast to the village. No message sent."
        );
        return 1;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --bin hcom commands::send`
Expected: PASS — `as_system_without_recipient_refuses_broadcast` plus all
prior send tests (the Task 2 happy-path test proves addressed sends still
work).

- [ ] **Step 5: Commit**

```bash
git add src/commands/send.rs
git commit -m "send: --as-system requires a resolved @recipient, never broadcasts"
```

---

- [x] ### Task 4: Identity-gate bypass for unbound CLI (`router.rs`)

**Owner:** builder
**Files:**
- Modify: `src/router.rs:746` (extract helper), `src/router.rs` (helper definition near `maybe_external_send_name_hint`, ~line 56)
- Test: `src/router.rs` (tests module; reuse the existing `sv` helper)

**Verification (anti-gameable):** `cargo test --bin hcom router` — the new unit test drives the pure helper with exact argv vectors; the helper is the only thing `has_from_flag` derives from, so the gate bypass for `--as-system` is directly proven.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src/router.rs`:

```rust
    #[test]
    fn send_gate_bypass_flags() {
        assert!(send_has_external_sender_flag(&sv(&["--from", "x"])));
        assert!(send_has_external_sender_flag(&sv(&["-b"])));
        assert!(send_has_external_sender_flag(&sv(&["--as-system", "omp-runtime"])));
        assert!(send_has_external_sender_flag(&sv(&["--as-system=omp-runtime"])));
        assert!(!send_has_external_sender_flag(&sv(&["--intent", "inform"])));
        assert!(!send_has_external_sender_flag(&sv(&[])));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --bin hcom router`
Expected: FAIL to compile — `send_has_external_sender_flag` does not exist.

- [ ] **Step 3: Extract the helper and use it**

In `src/router.rs`, near `maybe_external_send_name_hint`:

```rust
/// Whether argv carries a sender flag that bypasses the send identity gate
/// (--from, -b, --as-system). Scans raw argv because the gate decision
/// happens before clap parsing.
fn send_has_external_sender_flag(cmd_argv: &[String]) -> bool {
    cmd_argv.iter().any(|a| {
        a == "--from" || a == "-b" || a == "--as-system" || a.starts_with("--as-system=")
    })
}
```

Replace the `has_from_flag` line (currently
`let has_from_flag = cmd_argv.iter().any(|a| a == "--from" || a == "-b");`)
with:

```rust
    let has_from_flag = send_has_external_sender_flag(&cmd_argv);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --bin hcom router`
Expected: PASS — `send_gate_bypass_flags` and all pre-existing router tests.

- [ ] **Step 5: Commit**

```bash
git add src/router.rs
git commit -m "router: --as-system bypasses the send identity gate like --from"
```

---

- [x] ### Task 5: Help table row + regression coverage

**Owner:** builder
**Files:**
- Modify: `src/commands/help.rs:242-248` (`SEND_HELP` Sender section)
- Test: `src/commands/help.rs` (tests module), `src/commands/send.rs` (tests module)

**Verification (anti-gameable):** `cargo test --bin hcom help` and `cargo test --bin hcom commands::send from_flag_still_external` — help test asserts the rendered help text contains the flag; the regression test asserts a `--from` send still records `sender_kind = "external"` in the DB.

- [ ] **Step 1: Write the failing tests**

In `src/commands/help.rs` tests module:

```rust
    #[test]
    fn send_help_lists_as_system() {
        let help = get_command_help("send");
        assert!(
            help.contains("--as-system <source-id>"),
            "send help should list --as-system"
        );
    }
```

In `src/commands/send.rs` tests module (regression — passes immediately, but
pins Brief contract "`--from healthcheck @gina` still External"):

```rust
    #[test]
    #[serial]
    fn from_flag_still_external_sender() {
        let (db, path, _env) = setup_test_db();
        db.conn()
            .execute(
                "INSERT INTO instances (name, created_at) VALUES ('gina', 1000.0)",
                [],
            )
            .unwrap();

        let mut args = SendArgs::try_parse_from([
            "send", "--from", "healthcheck", "@gina", "--", "hi",
        ])
        .unwrap();
        args.had_separator = true;

        assert_eq!(cmd_send(&db, &args, None), 0);
        let (from, sender_kind): (String, String) = db
            .conn()
            .query_row(
                "SELECT json_extract(data, '$.from'), json_extract(data, '$.sender_kind')
                 FROM events WHERE type = 'message'
                 ORDER BY id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(from, "healthcheck");
        assert_eq!(sender_kind, "external");

        cleanup_test_db(path);
    }
```

- [ ] **Step 2: Run tests to verify the help test fails**

Run: `cargo test --bin hcom help`
Expected: FAIL — `send_help_lists_as_system` panics (help has no
`--as-system` row yet).

- [ ] **Step 3: Add the help row**

In `src/commands/help.rs`, `SEND_HELP`, in the `Sender:` section immediately
after the `--as-instance` entry:

```rust
    (
        "  --as-system <source-id>",
        "System sender identity (requires @targets, never broadcasts)",
    ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --bin hcom help && cargo test --bin hcom commands::send from_flag_still_external`
Expected: PASS — `send_help_lists_as_system` and
`from_flag_still_external_sender`.

- [ ] **Step 5: Full binary test sweep (once, final integration check)**

Run: `cargo test --bin hcom`
Expected: PASS — entire suite green, including all tasks' tests.

- [ ] **Step 6: Commit**

```bash
git add src/commands/help.rs src/commands/send.rs
git commit -m "help: list --as-system; test: --from stays External (regression)"
```

---

## Self-review notes (planner)

- Spec coverage: flag/validation (T2), mutual exclusion (T2), subagent guard
  (T2), identity branch + event contract (T2), trap settlement (T3),
  `broadcasts()` recut (T1), gate bypass (T4), help row (T5), `--from`
  regression (T5). Every Brief acceptance bullet has a test.
- No placeholders; all test/impl code is exact. Commands are the project's
  real runner, targeted per step, one full sweep at the end.
- Type consistency: `as_system: Option<String>` used identically in Tasks
  2–3; helper name `send_has_external_sender_flag` identical in Task 4
  definition, call site, and test.
- No invented product: every behavior traces to a quoted Brief line in the
  spec. Commits are builder instructions; the planner commits nothing.
