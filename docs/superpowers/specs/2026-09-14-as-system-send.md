# `hcom send --as-system` Technical Spec

**Design Brief:** `/home/sf/worlds/personal/designs/hcom/as-system-send.md` (Status: approved)
**Status:** sound
**Repo:** `/home/sf/workspace/hcom`

## Intent (from the Brief — do not rewrite)

> systemd-ops (and other trusted host automations) need a public CLI to send
> addressed inform mail as `sender_kind=system` with a stable source id in
> `from`, without spoofing an instance and without broadcasting to the village.

Add:

```
hcom send --as-system <source-id> @<recipient> --intent inform [--delivery ...] -- "<message>"
```

Brief invariants (quoted):

- "`sender_kind=system`", "`from` = the supplied source-id (stored as
  `SenderIdentity.name` / events `from`; existing `sys_<name>` display prefix
  may stay)".
- "no bound actor identity required (same gate bypass as `--from`)".
- "refuse combination with `--from` / `-b` / `--as-instance`".
- "honour explicit `@recipient` (and `@role-` groups if send already does).
  `compute_scope` Mentions. `delivered_to` = those names only."
- "**trap settlement:** `--as-system` REQUIRES at least one resolved
  `@recipient`. Empty / missing targets → error, no send, no village
  broadcast. Do not use `SenderIdentity::broadcasts()` (currently `true` for
  System) to force Broadcast for this path. Recut `broadcasts()` / its
  comment / tests so System is not 'always broadcast'. Existing internal
  launch/notify system messages that *intentionally* broadcast must keep
  working — inspect those call sites; do not silently un-broadcast them. The
  public CLI primitive is addressed-only."
- "source-id charset: alphanumeric, hyphen, underscore, colon … Max length
  same as `--from` (50) … Reject `@` and shell metacharacters like `--from`
  already does."
- "subagents cannot use `--as-system` (same spoofing guard as `--from`)".
- "curated help table in `src/commands/help.rs` gains the flag."

Preserve (quoted): "`SenderKind::{Instance, External, System}` … Do not
collapse kinds." "`--from` / `-b` remain External. `--as-instance` remains
bound Instance." "Envelope: `--intent`, `--delivery`, `--reply-to`,
`--thread`, `--file` / `--` body."

## Mapping onto the current system

All claims below are **observed** in the repo unless marked otherwise.

- `SendArgs` (`src/commands/send.rs:60`) already carries the sender flags:
  `--from` (`from: Option<String>`), `-b` (`bigboss: bool`), `--as-instance`
  (`as_instance: bool`). `--as-system <source-id>` joins this group as
  `as_system: Option<String>` with `#[arg(long = "as-system")]`. Clap accepts
  both `--as-system <id>` and `--as-system=<id>` for `Option<String>`; the
  Brief allows both forms.
- Sender-name validation for `--from` lives at `src/commands/send.rs:699-710`
  (empty / >50 chars / blocklist of `@ | & ; < > \` $ ' " \ \n \r`). The
  `--as-system` source-id gets its own validator implementing the Brief's
  whitelist charset (`[A-Za-z0-9_-:]`, length 1–50). The whitelist rejects
  `@` and every shell metacharacter the `--from` blocklist rejects, so it
  satisfies "reject … like `--from` already does".
- Mutual-exclusion checks are manual `eprintln!` + `return 1` in `cmd_send`
  (e.g. `--as-instance` vs `--from/-b` at `src/commands/send.rs:712-715`).
  `--as-system` follows the same pattern (clap `conflicts_with` would exit 2,
  violating the Brief's "exits 1" acceptance).
- Subagent spoofing guard (`src/commands/send.rs:718-737`) fires today when
  `from_name.is_some()`; its condition widens to also fire when
  `as_system.is_some()`. No test pins the current message text (observed).
- Identity resolution in `cmd_send` (`src/commands/send.rs:863-908`) is an
  if/else chain: `--as-instance` → bound identity; `--from` →
  `SenderKind::External`; ctx / `--name` / auto-detect otherwise. A new
  branch constructs
  `SenderIdentity { kind: SenderKind::System, name: <source-id>, instance_data: None, session_id: None }`.
  Everything downstream already handles `SenderKind::System`: event
  `sender_kind: "system"` (`src/commands/send.rs:408`), routing instance
  `sys_<name>` (`src/commands/send.rs:455`), bundle instance
  (`src/commands/send.rs:966`, `src/core/helpers.rs:44`). **Contract pin
  (Brief acceptance):** events row `data.from` = the raw source-id (no
  `sys_` prefix); `data.sender_kind` = `"system"`; the `sys_` prefix appears
  only in the events `instance` column. This is what systemd-ops reads.
- Identity-gate bypass: the router computes
  `has_from_flag` (`src/router.rs:746`) and `check_identity_gate`
  (`src/cli_context.rs:92-108`) bypasses the gate for `send` when it is true.
  The argv scan widens to recognize `--as-system` / `--as-system=<id>`. To
  keep this unit-testable the scan becomes a small pure helper in
  `src/router.rs` (targeted boundary cleanup serving the Brief's "unbound CLI
  can send `--as-system`" acceptance). Side effect, intended:
  `maybe_external_send_name_hint` (`src/router.rs:56`) stays quiet when
  `--as-system` is present, same as `--from` today.
- **Trap settlement.** `resolve_delivery` (`src/commands/send.rs:278`)
  already returns `original_scope`. `cmd_send` computes a preview delivery at
  `src/commands/send.rs:929-945` before anything is written. The guard
  rejects `--as-system` when `original_scope == MessageScope::Broadcast`,
  i.e. no explicit `@target` positionals and no `@mention` in the message
  resolved to a deliverable instance. This is the Brief's literal "REQUIRES
  at least one resolved `@recipient`". Consequence (recorded, not invented):
  a `--as-system` send that relies **only** on `--thread` membership (no
  `@recipient` in this invocation) is rejected, because its original scope is
  Broadcast; `--thread` remains fully usable together with `@recipient`s
  (seed + addressed send), preserving the Brief's envelope list. Unmatched
  targets already hard-error inside `compute_scope`
  (`src/messages.rs:392-394`), so "resolved" is guaranteed by the time the
  guard runs. The guard runs before the broadcast-preview gate
  (`src/commands/send.rs:947-955`), so the operator gets the precise error,
  not the generic broadcast preview.
- **`broadcasts()` recut.** `SenderIdentity::broadcasts()`
  (`src/shared/identity.rs:29-31`) currently returns true for
  `External | System` with the comment "External and system senders broadcast
  to everyone." Recut to `External` only; the `SenderKind::System` variant
  comment ("broadcasts to all", `src/shared/identity.rs:23`) is corrected to
  addressed-only; `test_sender_identity_broadcasts`
  (`src/shared/identity.rs:76-100`) is updated to assert
  `!system.broadcasts()`. **Observed:** `broadcasts()` has zero production
  callers — only its own test references it — so the recut changes no runtime
  behavior. **Observed:** the only internal `sender_kind=system` messages are
  `notify_batch_ready` / `notify_batch_failure` (`src/db/events.rs:385-438`),
  and both already write `"scope": "mentions"` directly via
  `log_event_with_ts`; neither calls `broadcasts()` or `send_message`. No
  internal system broadcast exists, so nothing is silently un-broadcast and
  launch/notify keep working unchanged.
- Help: the `SEND_HELP` table's `Sender:` section
  (`src/commands/help.rs:242-248`) gains a `--as-system <source-id>` row.

## Architecture

One new CLI sender flag mapped onto the existing `SenderKind::System`
plumbing. No new transport, no new event shape, no schema change. The send
pipeline (`cmd_send` → `resolve_delivery` → `send_message` → `log_event` →
`wake_all` / relay push) is reused verbatim; the only new logic is argument
validation, one identity-construction branch, and one pre-send scope guard.

## Components and interfaces

| Component | File | Change |
|---|---|---|
| `SendArgs.as_system: Option<String>` | `src/commands/send.rs` | New clap flag `--as-system <source-id>` in the `── Sender ──` group |
| source-id validation | `src/commands/send.rs` (`cmd_send`, beside the `--from` check at :699) | Whitelist `[A-Za-z0-9_-:]`, length 1–50; error + exit 1 |
| mutual exclusion | `src/commands/send.rs` (`cmd_send`, beside :712) | `--as-system` + (`--from` / `-b` / `--as-instance`) → error + exit 1 |
| subagent guard | `src/commands/send.rs` (:718) | Condition widened to `from_name.is_some() \|\| args.as_system.is_some()`; message mentions the flag used |
| sender identity branch | `src/commands/send.rs` (:863 chain) | `SenderKind::System` identity with `name = source-id` |
| trap guard | `src/commands/send.rs` (after :945, before :947) | `as_system.is_some() && preview_delivery.original_scope == Broadcast` → error + exit 1, no event |
| `broadcasts()` | `src/shared/identity.rs:29` | `External` only; comment + `SenderKind::System` doc + test updated |
| gate bypass scan | `src/router.rs:746` | Extract pure helper `send_has_external_sender_flag(&[String]) -> bool` recognizing `--from`, `-b`, `--as-system`, `--as-system=*`; used for `has_from_flag` |
| help row | `src/commands/help.rs` (`SEND_HELP`, :242 section) | `("  --as-system <source-id>", "System sender identity (requires @targets, never broadcasts)")` |

No signatures of existing public functions change. `send_message`,
`compute_scope`, `resolve_delivery`, `check_identity_gate` are untouched.

## Data / control flow

```
hcom send --as-system omp-runtime @gina --intent inform --go -- "gen published"
  └─ router (src/router.rs)
       └─ send_has_external_sender_flag(cmd_argv) == true
            → check_identity_gate bypasses (unbound CLI allowed)
       └─ clap parse → SendArgs { as_system: Some("omp-runtime"), … }
  └─ cmd_send (src/commands/send.rs)
       ├─ validate source-id charset/length            → exit 1 on violation
       ├─ reject --from/-b/--as-instance combination   → exit 1
       ├─ subagent spoofing guard                      → exit 1 for subagents
       ├─ envelope: intent=inform, delivery, …         (unchanged)
       ├─ sender_identity = System("omp-runtime")      (new branch)
       ├─ resolve_delivery → original_scope
       ├─ TRAP: original_scope == Broadcast            → exit 1, NO event
       └─ send_message
            ├─ compute_scope → Mentions(["gina"])
            ├─ log_event: instance="sys_omp-runtime",
            │    data={from:"omp-runtime", sender_kind:"system",
            │          scope:"mentions", delivered_to:["gina"], intent:"inform", …}
            └─ wake_all + relay push                  (unchanged)
```

Error paths all return exit code 1 from `cmd_send` before `send_message` is
reached, so a rejected invocation writes no events row.

## Error handling

| Case | Behavior |
|---|---|
| `--as-system` + `--from`/`-b`/`--as-instance` | `Error: --as-system cannot be combined with --from/-b/--as-instance`, exit 1, no event |
| source-id empty / >50 chars / bad charset | `Error: …` (mirrors `--from` validation style), exit 1, no event |
| no resolved `@recipient` (broadcast scope) | `Error: --as-system requires at least one @recipient …`, exit 1, no event |
| `@target` matches nothing | existing `compute_scope` strict error, exit 1, no event |
| subagent caller | existing guard message extended to name `--as-system`, exit 1, no event |
| unbound CLI, no identity | allowed (gate bypass), sends as System |

## Testing (behavioral contracts; exact tests live in the plan)

All tests run under `cargo test --bin hcom` (crate is binary-only). Existing
harness: `setup_test_db()` / `cleanup_test_db()` in `src/commands/send.rs`
tests, `#[serial]` for DB tests, `SendArgs::try_parse_from` + manual
`had_separator = true`.

1. `--as-system omp-runtime @gina --intent inform --go -- "gen published"`
   exits 0; newest `message` event has `instance = 'sys_omp-runtime'`,
   `data.from = 'omp-runtime'`, `data.sender_kind = 'system'`,
   `data.scope = 'mentions'`, `data.delivered_to = ["gina"]` — with a second
   deliverable instance present that is **not** in `delivered_to`.
2. `--as-system` + `--from` → exit 1, zero `message` events written.
   `--as-system` + `--as-instance` → exit 1, zero events.
3. `--as-system omp-runtime --intent inform --go -- "x"` (no `@recipient`)
   → exit 1, zero events (trap settlement; no village broadcast).
4. Source-id validation: `@bad`, `bad;id`, 51-char id → exit 1;
   `systemd-ops:operation-stem` (colon + hyphens) accepted.
5. Unbound CLI (`ctx` with no identity, no `--name`) sends `--as-system`
   successfully — covered at unit level by the identity-branch test (no
   `resolve_identity` call on that path) plus the router helper test.
6. Router helper: `["--as-system", "x"]`, `["--as-system=x"]`, `["--from", "x"]`,
   `["-b"]` → true; `[]`, `["--intent", "inform"]` → false.
7. `broadcasts()`: System → false, External → true, Instance → false.
8. `--from healthcheck @gina` still records `sender_kind = "external"`
   (regression).
9. `get_command_help("send")` contains `--as-system <source-id>`.

## Non-goals

- worlds `send_to_actor` growing a system origin (Brief non-goal).
- systemd-ops notification copy/wiring — hera wires after this lands
  (Brief: hera contract; her blocked task `sdo-notify-provenance-r4j.1`).
- Changing External `--from` broadcast behavior.
- discard / resume / participant bootstrap.
- Any production implementation, commit, or git operation by the planner.
- Restructuring `send.rs` beyond the listed insertions.

## Implementation approach chosen (and rejected internals)

**Chosen: map onto the existing `SenderKind::System` plumbing** (flag →
manual validation → identity branch → pre-send scope guard). Every
downstream consumer (event write, `sys_` routing instance, bundle instance,
subscription recursion guard at `src/db/subscriptions.rs:482`) already
handles System, so the diff stays inside `send.rs`, `shared/identity.rs`,
`router.rs`, `help.rs`.

Rejected internals (all would satisfy the Brief but lose on YAGNI /
existing-pattern grounds):

- **Clap `conflicts_with` for mutual exclusion** — exits 2, violating the
  Brief's "exits 1" acceptance; manual checks match the file's pattern.
- **Enforcing the trap inside `compute_scope` / `send_message`** — those are
  shared by internal callers; a `cmd_send`-level guard keeps the public-CLI
  rule out of the library path. (Internal launch/notify never reach it.)
- **Passing `--as-system` through `resolve_identity`'s `system_sender`
  parameter** — that parameter is an internal-callers priority slot
  (`src/identity.rs:300-308`); the CLI branch constructs the identity
  directly, same as the existing `--from` branch constructs External
  directly. No change to `resolve_identity`.
- **Deleting `broadcasts()`** — it has no production callers, but the Brief
  says "recut", not "remove"; keeping it documents the kind semantics.

## Open questions

None affecting product. (Recorded assumption, internal: a `--as-system` send
whose only targeting is a seeded `--thread` — no `@recipient` in the
invocation — is rejected under the trap, per the Brief's literal "REQUIRES at
least one resolved `@recipient`"; `--thread` + `@recipient` together works.)
