# Named Launch Instance (`--instance`) Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-09-15-named-launch-instance.md`
**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix <xx>` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.

**Goal:** Add a launch-only `--instance <name>` flag that fills `LaunchParams.name` so `hcom omp --name <caller> --instance <child> --go` mints `<child>` while `--name` stays caller identity.

**Architecture:** Parse `--instance` in the existing launch argv seam (`extract_launch_flags` → `HcomLaunchFlags.instance`), thread it into `LaunchParams.name` on both the local and remote (`--device` relay) launch paths, and list it in generated launch-tool help plus the README flag table. The launcher itself is untouched: count>1 bail, `resolve_explicit_name_conflict` fail-closed, row mint, and `HCOM_INSTANCE_NAME` already work when `name` is `Some`.

**Tech stack:** Rust (existing hcom CLI), `anyhow` for errors, `serde_json::json!` for relay params, `cargo test --locked` via `just test <filter>`.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/commands/launch.rs` | Modify | `HcomLaunchFlags.instance` field; `--instance` arms in `extract_launch_flags`; empty-value bail in `parse_launch_argv`; wire `name:` in local `LaunchParams`; add `"name"` to remote dispatch JSON |
| `src/relay/control.rs` | Modify | `RemoteLaunchRequest.name` field + `from_params` parse; pass to `LaunchParams.name` in `handle_remote_launch` |
| `src/commands/help.rs` | Modify | `--instance <name>` line in `generate_tool_help` (launch-only; NOT in `SHARED_LAUNCH_FLAGS`) |
| `README.md` | Modify | One row in the launch flags table |

No new files. No launcher, router, resume/fork, or worlds changes.

---

- [x] ### Task 1: Parse `--instance` in launch argv

**Owner:** builder
**Files:**
- Modify: `src/commands/launch.rs` (`HcomLaunchFlags` struct ~line 433, `parse_launch_argv` ~line 448, `extract_launch_flags` ~line 574, tests module ~line 864)

**Verification (anti-gameable):** `just test test_parse_launch_argv_instance` passes 4 new tests; `just test commands::launch` shows no regressions.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `src/commands/launch.rs` (the `s()` helper already exists at ~line 867):

```rust
#[test]
fn test_parse_launch_argv_instance_space_form() {
    let (_, tool, flags, args) =
        parse_launch_argv(&s(&["omp", "--instance", "reko"])).unwrap();
    assert_eq!(tool, "omp");
    assert_eq!(flags.instance, Some("reko".to_string()));
    assert!(args.is_empty());
}

#[test]
fn test_parse_launch_argv_instance_equals_form() {
    let (_, _, flags, _) = parse_launch_argv(&s(&["omp", "--instance=reko"])).unwrap();
    assert_eq!(flags.instance, Some("reko".to_string()));
}

#[test]
fn test_parse_launch_argv_instance_after_tool_args() {
    // Order-independent, like --tag: extracted even after tool-specific args.
    let (_, _, flags, args) =
        parse_launch_argv(&s(&["omp", "--model", "fast", "--instance", "reko"])).unwrap();
    assert_eq!(flags.instance, Some("reko".to_string()));
    assert_eq!(args, s(&["--model", "fast"]));
}

#[test]
fn test_parse_launch_argv_instance_empty_fails() {
    assert!(parse_launch_argv(&s(&["omp", "--instance", ""])).is_err());
    assert!(parse_launch_argv(&s(&["omp", "--instance", "   "])).is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test test_parse_launch_argv_instance`
Expected: FAIL — compile error `no field 'instance' on type '&HcomLaunchFlags'` (field does not exist yet).

- [ ] **Step 3: Add the field, the flag arms, and the empty-value bail**

In `HcomLaunchFlags` (~line 433), add the field:

```rust
pub(crate) struct HcomLaunchFlags {
    pub tag: Option<String>,
    pub terminal: Option<String>,
    pub device: Option<String>,
    pub headless: bool,
    pub system_prompt: Option<String>,
    pub initial_prompt: Option<String>,
    pub run_here: Option<bool>,
    pub batch_id: Option<String>,
    pub dir: Option<String>,
    pub instance: Option<String>,
}
```

In `extract_launch_flags`, add the `--instance=` arm next to the other `starts_with` arms (~line 585, beside `--tag=`):

```rust
if args[i].starts_with("--instance=") {
    flags.instance = Some(args[i][11..].to_string());
    i += 1;
    continue;
}
```

In the same function's `match args[i].as_str()`, add the space form beside the `"--tag"` arm (~line 607):

```rust
"--instance" if i + 1 < args.len() => {
    flags.instance = Some(args[i + 1].clone());
    i += 2;
}
```

In `parse_launch_argv`, reject an empty/whitespace value right after flag extraction (~line 491):

```rust
let (flags, tool_args) = extract_launch_flags(&argv[idx..]);

if let Some(ref name) = flags.instance
    && name.trim().is_empty()
{
    bail!("--instance requires a non-empty instance name");
}

Ok((count, tool, flags, tool_args))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `just test test_parse_launch_argv_instance`
Expected: `test result: ok. 4 passed`

Run: `just test commands::launch`
Expected: `test result: ok.` — all existing launch tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/launch.rs
git commit -m "launch: parse --instance <name> flag (space and = forms, non-empty)"
```

---

- [x] ### Task 2: Wire `--instance` into the local launch path

**Owner:** builder
**Files:**
- Modify: `src/commands/launch.rs:198` (local `LaunchParams` construction in `run()`)

**Verification (anti-gameable):** real mint — after `cargo build --locked`, `./target/debug/hcom omp --instance quvz --headless --go` then `./target/debug/hcom list` shows a row named `quvz` (not a generated name); re-running the same command fails with an error containing `already exists`; `./target/debug/hcom 2 omp --instance quvx --headless --go` fails with `Cannot use explicit name with count > 1`. Optional cleanup: `./target/debug/hcom kill quvz`. Use only throwaway names (never midi/kilo/reko/hera).

- [ ] **Step 1: Write the failing check**

There is no unit seam into `run()` (it opens the DB and spawns processes); the behavioral check is the real CLI. First confirm current behavior ignores the mint:

Run: `cargo build --locked && ./target/debug/hcom omp --instance quvz --headless --go && ./target/debug/hcom list`
Expected: launch succeeds but the minted name is a random four-letter generated name, NOT `quvz` (flag parses but is dropped). Clean up: `./target/debug/hcom kill <generated-name>`.

- [ ] **Step 2: Wire the field**

In `src/commands/launch.rs`, `run()`, local `LaunchParams` (~line 198), replace:

```rust
name: None, // --name is caller identity, not instance name
```

with:

```rust
// --name stays caller identity (resolve_launcher_name /
// HCOM_LAUNCHED_BY); --instance is the launch mint request.
name: hcom_flags.instance,
```

- [ ] **Step 3: Run the behavioral check to verify it passes**

Run: `cargo build --locked && ./target/debug/hcom omp --instance quvz --headless --go && ./target/debug/hcom list`
Expected: `hcom list` shows a row named `quvz`.

Run: `./target/debug/hcom omp --instance quvz --headless --go`
Expected: FAIL — error containing `already exists` (fail-closed on live name).

Run: `./target/debug/hcom 2 omp --instance quvx --headless --go`
Expected: FAIL — error containing `Cannot use explicit name with count > 1`.

Run: `just test commands::launch`
Expected: `test result: ok.` — no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/commands/launch.rs
git commit -m "launch: fill LaunchParams.name from --instance on local launch"
```

---

- [x] ### Task 3: Forward `--instance` through remote (`--device`) launch

**Owner:** builder
**Files:**
- Modify: `src/commands/launch.rs:84-94` (remote dispatch params JSON in `run()`)
- Modify: `src/relay/control.rs` (`RemoteLaunchRequest` ~line 680, `from_params` ~line 694, `handle_remote_launch` ~line 793, tests ~line 1455)

**Verification (anti-gameable):** `just test relay::control` passes including the new `name` round-trip test; `cargo build --locked` succeeds (the `name: request.name` wiring must typecheck against `LaunchParams`).

- [ ] **Step 1: Write the failing test**

Append to the tests module in `src/relay/control.rs` (near the existing `test_remote_launch_request_from_params_*` tests, ~line 1455):

```rust
#[test]
fn test_remote_launch_request_from_params_collects_name() {
    let request = RemoteLaunchRequest::from_params(&json!({
        "tool": "claude",
        "count": 1,
        "name": "reko"
    }))
    .unwrap();
    assert_eq!(request.name.as_deref(), Some("reko"));
}

#[test]
fn test_remote_launch_request_from_params_name_defaults_none() {
    let request =
        RemoteLaunchRequest::from_params(&json!({"tool": "claude", "count": 1})).unwrap();
    assert!(request.name.is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `just test test_remote_launch_request_from_params`
Expected: FAIL — compile error `no field 'name' on type 'RemoteLaunchRequest'`.

- [ ] **Step 3: Add the field, parse it, and forward it end to end**

In `src/relay/control.rs`, `RemoteLaunchRequest` (~line 680), add the field alongside `terminal`/`cwd`:

```rust
struct RemoteLaunchRequest {
    tool: String,
    count: usize,
    args: Vec<String>,
    tag: Option<String>,
    launcher: Option<String>,
    system_prompt: Option<String>,
    initial_prompt: Option<String>,
    background: bool,
    terminal: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
}
```

In `RemoteLaunchRequest::from_params` (~line 694), add beside the other `optional_param` lines:

```rust
name: optional_param(params, "name").map(ToString::to_string),
```

In `handle_remote_launch` (~line 793), replace `name: None,` with:

```rust
name: request.name,
```

In `src/commands/launch.rs`, `run()`, remote dispatch params (~line 84-94), add the key to the `json!` bundle:

```rust
let params = json!({
    "tool": tool,
    "count": count,
    "args": tool_args,
    "tag": tag,
    "launcher": launcher_name,
    "background": headless,
    "terminal": terminal.clone(),
    "cwd": remote_cwd,
    "initial_prompt": hcom_flags.initial_prompt,
    "system_prompt": hcom_flags.system_prompt,
    "name": hcom_flags.instance,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `just test test_remote_launch_request_from_params`
Expected: `test result: ok.` — new tests pass plus existing `from_params` tests.

Run: `just test relay::control`
Expected: `test result: ok.` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/commands/launch.rs src/relay/control.rs
git commit -m "relay: forward --instance name through remote launch params"
```

---

- [x] ### Task 4: List `--instance` in launch help and README

**Owner:** builder
**Files:**
- Modify: `src/commands/help.rs` (`generate_tool_help` ~line 730-745, tests module ~line 1169)
- Modify: `README.md:316` (launch flags table)

**Verification (anti-gameable):** `just test help` passes including the new test asserting `omp` help lists `--instance` and `r` help does not; `grep -c -- '--instance' README.md` returns `1`.

- [ ] **Step 1: Write the failing test**

Append to the tests module in `src/commands/help.rs` (~line 1169):

```rust
#[test]
fn launch_help_lists_instance_flag_but_resume_help_does_not() {
    let omp_help = get_command_help("omp");
    assert!(
        omp_help.contains("--instance <name>"),
        "hcom omp --help must list --instance"
    );
    let resume_help = get_command_help("r");
    assert!(
        !resume_help.contains("--instance"),
        "hcom r --help must not advertise launch-only --instance"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `just test launch_help_lists_instance_flag`
Expected: FAIL — `hcom omp --help must list --instance` assertion fails.

- [ ] **Step 3: Add the help line and README row**

In `generate_tool_help` (`src/commands/help.rs`), immediately after the existing `--device` push (~line 742-745), add:

```rust
lines.push(format!(
    "    {:<29}{}",
    "--instance <name>", "Mint this name for the launched instance (fails if taken)"
));
```

Do NOT add `--instance` to `SHARED_LAUNCH_FLAGS` — that constant also renders in `hcom r` / `hcom f` help, where the flag is not accepted.

In `README.md`, add one row to the launch flags table, directly after the `--tag` row (~line 316):

```markdown
| `--instance <name>` | Mint this name for the launched instance (fails if taken) |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `just test help`
Expected: `test result: ok.` — new test plus all existing help tests pass.

Run: `grep -c -- '--instance' README.md`
Expected: `1`

- [ ] **Step 5: Commit**

```bash
git add src/commands/help.rs README.md
git commit -m "help: list --instance on launch tool help and README flag table"
```
