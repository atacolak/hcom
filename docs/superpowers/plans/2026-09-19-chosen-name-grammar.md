# Chosen-Name Grammar Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-09-19-chosen-name-grammar.md`
**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix <xx>` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.

**Goal:** Pin every chosen-name path (`--instance` mint, identity lookup, `start --as` fresh claims) to one shared validator implementing the frozen grammar `^[a-z][a-z0-9_]{0,23}$` with `all` + `banned_names` reserved, without breaking UUID/agent-id lookup or the CVCV mint.

**Architecture:** Tighten `identity::BASE_NAME_RE` and extend `identity::is_valid_base_name` with the reserved set so it is the single shared validator. Call it at parse time in `parse_launch_argv` (fail closed) and on the fresh-claim branch of `start_rebind`; exempt `looks_like_agent_id` in the `resolve_from_name` gate so digit-starting 7-hex agent ids still resolve. Update the launch-only `--instance` help line to state the grammar.

**Tech stack:** Rust (existing crate), `regex` + `LazyLock` (already used in `identity.rs`), `anyhow::bail`, `clap` (untouched), tests via `cargo test` through `just test <filter>` (Justfile:75-77 forwards args to `cargo test --locked`).

---

## File structure

- Modify `src/identity.rs` — the shared validator: `BASE_NAME_RE` (:15), `is_valid_base_name` (:38-40), `base_name_error` (:42-46), `resolve_from_name` gate (:206). Tests in its `#[cfg(test)]` module (:540-700).
- Modify `src/commands/launch.rs` — replace the empty-only `--instance` check in `parse_launch_argv` (:498-502) with the shared validator. Tests in its `tests` module (:1416-1442).
- Modify `src/commands/start.rs` — validate fresh-claim targets in `start_rebind` (:364-365). Tests in its `tests` module (harness at :917-935, rebind tests at :1189+).
- Modify `src/commands/help.rs` — grammar text on the launch-only `--instance` line (:774-777). Test near :1566. Do **not** touch `SHARED_LAUNCH_FLAGS` (:1049-1063).

No files created. No README change (flag table at `README.md:344` makes no four-letter claim).

Builders: run only the targeted `just test <filter>` commands shown in each task. Do not run the full suite.

---

### Task 1: Shared validator in `identity.rs`

**Owner:** builder
**Files:**
- Modify: `src/identity.rs:15` (regex), `src/identity.rs:38-46` (`is_valid_base_name` + `base_name_error`), `src/identity.rs:206` (gate)
- Test: `src/identity.rs` tests module — rewrite `test_is_valid_base_name` (:600-608), add `test_resolve_from_name_agent_id_digit_start` after `test_resolve_from_name_agent_id` (:657-669)

**Verification (anti-gameable):** `just test test_is_valid_base_name` and `just test test_resolve_from_name` pass with the new assertions below; the rewritten `test_is_valid_base_name` must be observed FAILING before the implementation (step 2).

- [x] **Step 1: Write the failing tests**

Replace the body of `test_is_valid_base_name` (`src/identity.rs:600-608`):

```rust
    #[test]
    fn test_is_valid_base_name() {
        assert!(is_valid_base_name("luna"));
        assert!(is_valid_base_name("test_name_123"));
        assert!(is_valid_base_name("hello_world"));
        assert!(is_valid_base_name("a")); // single letter
        assert!(is_valid_base_name("abcdefghijklmnopqrstuvwx")); // 24 chars
        assert!(!is_valid_base_name("Luna")); // uppercase
        assert!(!is_valid_base_name("my-name")); // dash
        assert!(!is_valid_base_name("")); // empty
        assert!(!is_valid_base_name("name with space"));
        assert!(!is_valid_base_name("9lives")); // must start with a letter
        assert!(!is_valid_base_name("abcdefghijklmnopqrstuvwxy")); // 25 chars
        assert!(!is_valid_base_name("all")); // reserved broadcast word
        assert!(!is_valid_base_name("test")); // instance_names::banned_names
    }
```

Add immediately after `test_resolve_from_name_agent_id` (`src/identity.rs:657-669`). NOTE: this is a regression guard — it PASSES both before and after this task (the old regex admits digit-start ids; the new gate exempts them explicitly). It exists so the gate change cannot silently break agent-id lookup:

```rust
    #[test]
    fn test_resolve_from_name_agent_id_digit_start() {
        let (db, _dir) = make_test_db();
        insert_instance(&db, "luna", None, None);
        db.conn().execute(
            "UPDATE instances SET agent_id = '6d9cafa' WHERE name = 'luna'",
            [],
        ).unwrap();

        // 7-char hex agent ids may start with a digit; the name-grammar gate
        // must not reject them before the agent-id lookup runs.
        let identity = resolve_from_name(&db, "6d9cafa").unwrap();
        assert_eq!(identity.name, "luna");
    }
```

- [x] **Step 2: Run tests to verify the validator test fails**

Run: `just test test_is_valid_base_name`
Expected: FAIL — `is_valid_base_name("9lives")` (and `"all"`, `"test"`, the 25-char string) currently return `true` under `^[a-z0-9_]+$`, so the new `assert!(!...)` lines panic.

Run: `just test test_resolve_from_name_agent_id_digit_start`
Expected: PASS (regression guard; passes before the change).

- [x] **Step 3: Implement the shared validator**

Edit `src/identity.rs:15`:

```rust
/// Valid base instance name: 1-24 chars, starts with a lowercase letter, then
/// lowercase letters, digits, or underscore. Frozen grammar (hcom-4n3.1).
static BASE_NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_]{0,23}$").unwrap());
```

Edit `src/identity.rs:38-46` (`is_valid_base_name` and `base_name_error`):

```rust
/// Check if name is a valid base instance name (frozen grammar; `all` and
/// `instance_names::banned_names()` are reserved). The ONE shared validator
/// for `--instance` mints, identity lookup, and `start --as` fresh claims.
pub fn is_valid_base_name(name: &str) -> bool {
    BASE_NAME_RE.is_match(name)
        && name != "all"
        && !crate::instance_names::banned_names().contains(name)
}

/// Build error message for invalid base instance names.
pub fn base_name_error(name: &str) -> String {
    if name == "all" || crate::instance_names::banned_names().contains(name) {
        return format!("Invalid instance name '{name}': reserved.");
    }
    format!(
        "Invalid instance name '{name}'. Use 1-24 characters: start with a lowercase letter, then lowercase letters, numbers, or underscore."
    )
}
```

Edit the `resolve_from_name` gate (`src/identity.rs:205-206`) — add the agent-id exemption:

```rust
    // Reject invalid base names, but allow tag-name format (e.g. "team-luna").
    // UUIDs and 7-char hex agent ids are exempt: they must reach the id
    // lookups below even when they don't match the name grammar.
    if !looks_like_uuid(name) && !looks_like_agent_id(name) && !is_valid_base_name(name) {
```

- [x] **Step 4: Run tests to verify they pass**

Run: `just test test_is_valid_base_name`
Expected: PASS (1 test)

Run: `just test test_resolve_from_name`
Expected: PASS — all 6 `resolve_from_name` tests including the new digit-start guard and the existing `test_resolve_from_name_invalid` ("Invalid-Name!" still errors).

Run: `just test identity::tests`
Expected: PASS — whole identity test module, no regressions in `test_looks_like_agent_id`, `test_instance_not_found_error`, `test_validate_name_input`, display-name tests.

- [ ] **Step 5: Commit**

```bash
git add src/identity.rs
git commit -m "identity: frozen chosen-name grammar validator (hcom-4n3.1)"
```

---

### Task 2: Fail-closed `--instance` parse validation

**Owner:** builder
**Files:**
- Modify: `src/commands/launch.rs:498-502`
- Test: `src/commands/launch.rs` tests module — add `test_parse_launch_argv_instance_grammar` after `test_parse_launch_argv_instance_empty_fails` (:1438-1442)

**Verification (anti-gameable):** `just test test_parse_launch_argv_instance` passes all 5 tests (4 existing + new grammar test); the new grammar test must be observed FAILING before the implementation.

Depends on: Task 1 (uses `identity::is_valid_base_name` / `base_name_error`).

- [x] **Step 1: Write the failing test**

Add after `test_parse_launch_argv_instance_empty_fails` (`src/commands/launch.rs:1438-1442`):

```rust
    #[test]
    fn test_parse_launch_argv_instance_grammar() {
        // Frozen grammar ^[a-z][a-z0-9_]{0,23}$: chosen names parse through.
        let (_, _, flags, _) =
            parse_launch_argv(&s(&["omp", "--instance", "hello_world"])).unwrap();
        assert_eq!(flags.instance, Some("hello_world".to_string()));
        let (_, _, flags, _) = parse_launch_argv(&s(&["omp", "--instance", "luna"])).unwrap();
        assert_eq!(flags.instance, Some("luna".to_string()));
        let (_, _, flags, _) = parse_launch_argv(&s(&["omp", "--instance=reko"])).unwrap();
        assert_eq!(flags.instance, Some("reko".to_string()));

        // Invalid names fail closed at parse with the shared validator error.
        for bad in [
            "my-name",                  // dash
            "Luna",                     // uppercase
            "9lives",                   // starts with a digit
            "abcdefghijklmnopqrstuvwxy", // 25 chars
            "all",                      // reserved
            "test",                     // instance_names::banned_names
        ] {
            let err = parse_launch_argv(&s(&["omp", "--instance", bad])).unwrap_err();
            assert!(
                err.to_string().contains("Invalid instance name"),
                "--instance {bad:?} must fail with the shared validator error"
            );
        }
        // Equals form is validated too.
        assert!(parse_launch_argv(&s(&["omp", "--instance=all"])).is_err());
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `just test test_parse_launch_argv_instance_grammar`
Expected: FAIL — `.unwrap_err()` panics on the first accepted invalid name (`my-name`); only empty/whitespace are rejected today.

- [x] **Step 3: Replace the empty-only check with the shared validator**

Replace `src/commands/launch.rs:498-502`:

```rust
    if let Some(name) = &flags.instance
        && !crate::identity::is_valid_base_name(name)
    {
        bail!("{}", crate::identity::base_name_error(name));
    }
```

(Empty/whitespace rejection is subsumed: the grammar requires ≥1 char and no spaces, so the existing `test_parse_launch_argv_instance_empty_fails` keeps passing. Use fully-qualified `crate::identity::` paths — no import edit needed.)

- [x] **Step 4: Run tests to verify they pass**

Run: `just test test_parse_launch_argv_instance`
Expected: PASS — 5 tests: `..._space_form`, `..._equals_form`, `..._after_tool_args`, `..._empty_fails`, `..._grammar`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/launch.rs
git commit -m "launch: validate --instance against shared name grammar at parse (hcom-4n3.1)"
```

---

### Task 3: `start --as` fresh-claim validation

**Owner:** builder
**Files:**
- Modify: `src/commands/start.rs:364-365`
- Test: `src/commands/start.rs` tests module — add `test_start_rebind_fresh_claim_uses_shared_grammar` near the other `start_rebind` tests (:1189+)

**Verification (anti-gameable):** `just test start_rebind` passes all rebind tests including the new one; the new test must be observed FAILING before the implementation (today a fresh `bad-name` claim succeeds).

Depends on: Task 1.

- [x] **Step 1: Write the failing test**

Add to the `tests` module in `src/commands/start.rs` (harness: `make_claude_ctx` at :927, `isolated_test_env` used at :1190):

```rust
    #[test]
    #[serial]
    fn test_start_rebind_fresh_claim_uses_shared_grammar() {
        let (_dir, hcom_dir, _home, _guard) = crate::hooks::test_helpers::isolated_test_env();
        let db = HcomDb::open().unwrap();
        assert!(crate::hooks::claude::setup_claude_hooks(false));
        let ctx = make_claude_ctx(
            Some(("CLAUDE_CODE_SESSION_ID", "sess-grammar-claim")),
            "/tmp/project",
        );
        assert_eq!(start_bare(&db, &hcom_dir, &ctx, None).unwrap(), 0);

        // A minted-style chosen name is claimable and owns the session.
        assert_eq!(start_rebind(&db, "hello_world", &ctx, None).unwrap(), 0);
        assert_eq!(
            db.get_session_binding("sess-grammar-claim").unwrap().as_deref(),
            Some("hello_world"),
            "start --as hello_world must resolve and own the session"
        );

        // Fresh claims outside the frozen grammar fail closed before mutation.
        let err = start_rebind(&db, "bad-name", &ctx, None).unwrap_err();
        assert!(err.to_string().contains("Invalid instance name"));
        let err = start_rebind(&db, "all", &ctx, None).unwrap_err();
        assert!(err.to_string().contains("reserved"));
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `just test test_start_rebind_fresh_claim_uses_shared_grammar`
Expected: FAIL — `start_rebind(&db, "bad-name", ...)` currently succeeds (no grammar check), so `.unwrap_err()` panics.

- [x] **Step 3: Validate fresh claims in `start_rebind`**

Replace `src/commands/start.rs:363-365`:

```rust
    // Resolve the target name. A target matching no live or stopped identity
    // is a fresh claim: it must pass the shared name grammar (the same helper
    // as the --instance mint), so every claimable name is resolvable. Targets
    // that resolve are reclaimed as-is, even if they predate the grammar.
    let target_name = match identity::resolve_display_name_or_stopped(db, rebind_target) {
        Some(base) => base,
        None => {
            if !identity::is_valid_base_name(rebind_target) {
                bail!("{}", identity::base_name_error(rebind_target));
            }
            rebind_target.to_string()
        }
    };
```

- [x] **Step 4: Run tests to verify they pass**

Run: `just test test_start_rebind_fresh_claim_uses_shared_grammar`
Expected: PASS

Run: `just test start_rebind`
Expected: PASS — all 7+ rebind tests, including the existing `test_start_rebind_rejects_cross_tool_stopped_snapshot_hijack`, `test_start_rebind_allows_matching_stopped_snapshot_reclaim`, and `test_start_rebind_reclaims_stopped_omp_identity_with_leaked_native_marker` (reclaim of existing identities is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/commands/start.rs
git commit -m "start: validate --as fresh claims against shared name grammar (hcom-4n3.1)"
```

---

### Task 4: Help text states the grammar (launch tools only)

**Owner:** builder
**Files:**
- Modify: `src/commands/help.rs:774-777`
- Test: `src/commands/help.rs` tests module — add `launch_help_instance_flag_states_grammar` after `launch_help_lists_instance_flag_but_resume_help_does_not` (:1566-1577)

**Verification (anti-gameable):** `just test launch_help` passes both help tests; the new test must be observed FAILING before the edit (current text has no `1-24`).

- [x] **Step 1: Write the failing test**

```rust
    #[test]
    fn launch_help_instance_flag_states_grammar() {
        let omp_help = get_command_help("omp");
        assert!(
            omp_help.contains("--instance <name>"),
            "hcom omp --help must list --instance"
        );
        assert!(
            omp_help.contains("1-24"),
            "--instance help must state the frozen name grammar"
        );
        // SHARED_LAUNCH_FLAGS stays charset-free: resume/fork never mint names.
        let resume_help = get_command_help("r");
        assert!(
            !resume_help.contains("--instance"),
            "hcom r --help must not list --instance"
        );
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `just test launch_help_instance_flag_states_grammar`
Expected: FAIL — `omp_help.contains("1-24")` is false today.

- [x] **Step 3: Update the launch-only `--instance` help line**

Replace `src/commands/help.rs:774-777`:

```rust
    lines.push(format!(
        "    {:<29}{}",
        "--instance <name>",
        "Mint this name for the launched instance (1-24 chars: start lowercase letter, then lowercase/digits/_; fails if taken)"
    ));
```

Do not touch `SHARED_LAUNCH_FLAGS` (`src/commands/help.rs:1049-1063`) or `resume_fork_help`. Do not edit `README.md`.

- [x] **Step 4: Run tests to verify they pass**

Run: `just test launch_help`
Expected: PASS — `launch_help_lists_instance_flag_but_resume_help_does_not` and `launch_help_instance_flag_states_grammar`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/help.rs
git commit -m "help: state chosen-name grammar on launch --instance line (hcom-4n3.1)"
```

---

## Final verification (lead/verifier, after all tasks)

Run these targeted filters; every listed test must PASS:

```bash
just test test_is_valid_base_name
just test test_resolve_from_name
just test test_parse_launch_argv_instance
just test start_rebind
just test launch_help
just test resolve_explicit_name_conflict
```

Manual smoke (optional, needs a scratch hcom home): `hcom omp --instance hello_world --go` mints `hello_world`; `hcom omp --instance bad-name --go` exits non-zero with `Invalid instance name 'bad-name'...` before launching anything.
