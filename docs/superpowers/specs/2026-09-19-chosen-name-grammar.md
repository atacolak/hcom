# Chosen-Name Grammar Technical Spec

**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (Status: approved)
**Status:** sound
**Repo:** `/home/sf/workspace/hcom`
**Bead:** hcom-4n3.1 (frozen grammar from campaign lead: `^[a-z][a-z0-9_]{0,23}$`, reserved `all` + `instance_names::banned_names`)

## Intent (from the Brief — do not rewrite)

The Brief (`named-launch-instance.md`) added the launch-only `--instance <name>` flag that fills
`LaunchParams.name` so `hcom omp --instance reko --go` mints `reko` instead of a generated CVCV
name. That flag shipped; this spec pins the **grammar** of chosen names per bead hcom-4n3.1:

- Frozen grammar: `^[a-z][a-z0-9_]{0,23}$` (1–24 chars, must start with a lowercase letter).
- No dashes: `{tag}-{name}` display (`identity::get_full_name`, `src/identity.rs:108-113`) and
  worlds split-on-dash parsers would break. No spaces, no uppercase.
- Reserved: `all` plus `instance_names::banned_names` (`src/instance_names.rs:44-51`).
- Empty/whitespace already rejected (`src/commands/launch.rs:498-502`).
- `--name` stays caller identity. Omitted `--instance` still mints CVCV via `gold_names`.
- Bead acceptance: `hcom omp --instance hello_world --go` mints that name; invalid names fail
  closed at parse with a clear error; `start --as hello_world` resolves; four-letter mint path
  unchanged when `--instance` is omitted.

## Mapping onto the current system

Observed in this tree:

1. **Mint parse** — `--instance` is extracted in `extract_launch_flags`
   (`src/commands/launch.rs:616-619` `--instance=` form, `src/commands/launch.rs:638-641`
   space form) into `HcomLaunchFlags.instance` (`src/commands/launch.rs:447`). The only
   validation today is the empty/whitespace check in `parse_launch_argv`
   (`src/commands/launch.rs:498-502`). Any non-empty string currently reaches the launcher.
2. **Mint consume** — `name: hcom_flags.instance` feeds `LaunchParams.name`
   (`src/commands/launch.rs:201`). The launcher applies count>1 bail and
   `resolve_explicit_name_conflict` (`src/launcher.rs:1851-1859`, conflict rules at
   `src/launcher.rs:1548-1580`). No charset check anywhere on this path.
3. **Lookup validator** — `identity::BASE_NAME_RE` is `^[a-z0-9_]+$` (`src/identity.rs:15`),
   exposed as `is_valid_base_name` (`src/identity.rs:38-40`) with error text from
   `base_name_error` (`src/identity.rs:42-46`). Callers: the `resolve_from_name` gate
   (`src/identity.rs:206`) and orphan-recover name reuse (`src/commands/start.rs:263`).
4. **Lookup fallback** — names failing the gate fall through to `resolve_display_name`
   (`src/identity.rs:208`), whose first arm is an exact `get_instance_full` match
   (`src/identity.rs:126-128`); only then is `InvalidInput` returned (`src/identity.rs:210`).
   So existing rows with legacy non-grammar names still resolve.
5. **UUID / agent-id paths** — the gate already exempts UUIDs (`looks_like_uuid`,
   `src/identity.rs:206`). Seven-char hex agent ids (`looks_like_agent_id`,
   `src/identity.rs:33-35`) are *not* exempted today: they pass only because the old regex
   allows digit-start strings. Agent-id lookup happens after the gate
   (`src/identity.rs:234-236`). Under the frozen grammar a digit-starting agent id
   (e.g. `6d9cafa`) would be rejected before that lookup — a regression the bead forbids
   ("keep UUID/agent-id lookup paths working").
6. **`start --as`** — `start_rebind` (`src/commands/start.rs:355`) resolves the target via
   `identity::resolve_display_name_or_stopped` and falls back to the raw string
   (`src/commands/start.rs:364-365`), then creates a fresh instance row with that name
   (`src/commands/start.rs:456-472`). There is **no** grammar validation on a fresh claim
   today, so `hcom start --as bad-name` would mint an unparseable identity.
7. **Help** — the `--instance` line is launch-only, emitted by `generate_tool_help`
   (`src/commands/help.rs:774-777`), deliberately absent from `SHARED_LAUNCH_FLAGS`
   (`src/commands/help.rs:1049-1063`); pinned by
   `launch_help_lists_instance_flag_but_resume_help_does_not` (`src/commands/help.rs:1566-1577`).
   Neither the help line nor the README flag table (`README.md:344`) claims "four-letter",
   so the packet's README condition is not triggered: **README stays unchanged**.
8. **`all` as a positional** — `stop all` / `kill all` / broadcast-without-targets never pass
   through `resolve_from_name` or `is_valid_base_name` (observed: `src/router.rs:1219-1220`,
   `src/commands/send.rs:383`), so reserving `all` in the validator does not break them.

## Architecture

One shared validator in `identity.rs` — the module that already owns name validity — used by
every path that *mints or claims* a name, and by the lookup gate:

```
identity::is_valid_base_name  (tightened: grammar + reserved-set rejection)
        ├── parse_launch_argv (--instance mint, fail closed at parse)
        ├── identity::resolve_from_name gate (lookup; UUID + agent-id exempt)
        ├── start_rebind fresh-claim check (start --as)
        └── orphan-recover reuse check (start.rs:263, unchanged call site)
```

`identity.rs` gains a dependency on `instance_names::banned_names`. No cycle:
`instance_names.rs` imports only `crate::db` and `crate::shared` (observed,
`src/instance_names.rs:5-6`).

## Components and interfaces

1. **`identity::BASE_NAME_RE`** (`src/identity.rs:15`) — tighten to `^[a-z][a-z0-9_]{0,23}$`.
2. **`identity::is_valid_base_name`** (`src/identity.rs:38-40`) — keep the name and signature
   `pub fn is_valid_base_name(name: &str) -> bool`; additionally return `false` for `"all"` and
   any `instance_names::banned_names()` entry. This is the ONE shared validator.
3. **`identity::base_name_error`** (`src/identity.rs:42-46`) — two messages: reserved names get
   `Invalid instance name '{name}': reserved.`; everything else gets the grammar description
   (1–24 chars, start with a lowercase letter, then lowercase letters/numbers/underscore).
4. **`identity::resolve_from_name` gate** (`src/identity.rs:206`) — add a
   `looks_like_agent_id` exemption alongside the existing `looks_like_uuid` one, so
   digit-starting 7-hex agent ids still reach `get_instance_by_agent_id`.
5. **`parse_launch_argv`** (`src/commands/launch.rs:498-502`) — replace the empty-only check
   with `is_valid_base_name` + `base_name_error`. Empty/whitespace rejection is subsumed
   (regex requires ≥1 char); the existing `test_parse_launch_argv_instance_empty_fails`
   (`src/commands/launch.rs:1438-1442`) keeps passing unchanged.
6. **`start_rebind`** (`src/commands/start.rs:364-365`) — validate only on the **fresh-claim**
   branch (resolution returned `None`). A target that resolves to a live or stopped identity
   is reclaimed as today, even if its name predates the grammar — mirroring the lookup
   fallback (item 4 above) so reclaim and lookup stay consistent.

## Data / control flow

**Mint:** `hcom omp --instance hello_world --go` → router strips globals →
`parse_launch_argv` → `extract_launch_flags` fills `flags.instance` → **new:** grammar check
fails closed with `base_name_error` on invalid input → `LaunchParams.name` → launcher
count>1 bail + `resolve_explicit_name_conflict` (unchanged) → row + `HCOM_INSTANCE_NAME`.

**Lookup:** `resolve_from_name(name)` → if not UUID and not agent-id and not valid base name
→ try `resolve_display_name` (exact row, then tag-name split) → else `InvalidInput` with
`base_name_error`. Valid names and exempt ids proceed to instance-name then agent-id lookup,
unchanged.

**Reclaim:** `hcom start --as hello_world` → `start_rebind` → resolve live-or-stopped →
found: reclaim as today → not found: **new** grammar check → fresh identity row.

## Error handling

- Parse-time rejection is fail-closed: `parse_launch_argv` returns `Err` before any launch
  side effect. Message comes from `base_name_error` and distinguishes *reserved* from
  *grammar* violations.
- `start --as` fresh-claim rejection bails before any DB mutation (the check sits
  immediately after target resolution, before the subagent guard and session logic).
- Launcher conflict behavior (`resolve_explicit_name_conflict`) is untouched: taken
  listening/active/blocked names still fail; inactive rows and own pending placeholders
  still succeed.

## Testing (behavioral contracts; exact tests live in the plan)

- `is_valid_base_name`: accepts `luna`, `hello_world`, `test_name_123`, single letter,
  24 chars; rejects uppercase, dash, empty, space, digit-start (`9lives`), 25 chars,
  `all`, banned (`test`).
- `parse_launch_argv`: rejects `--instance` with dash / uppercase / empty / whitespace /
  digit-start / 25 chars / `all` / banned, in both space and `=` forms; accepts
  `hello_world` and four-letter gold names (`luna`, `reko`).
- `resolve_from_name`: a digit-starting 7-hex agent id (e.g. `6d9cafa`) still resolves via
  agent-id lookup; `Invalid-Name!` still yields `Invalid instance name`.
- `start_rebind`: fresh claim of `hello_world` succeeds and binds the session; fresh claim
  of `bad-name` and `all` fails with the shared error.
- Existing tests keep passing: `test_parse_launch_argv_instance_*` (4 tests,
  `src/commands/launch.rs:1416-1442`), `launch_help_lists_instance_flag_but_resume_help_does_not`,
  `resolve_explicit_name_conflict_*` (`src/launcher.rs:3702-3747`), all `start_rebind` tests.
- Help: `hcom omp --help` `--instance` line states the grammar; `hcom r --help` still has no
  `--instance`.

## Non-goals

- `hcom rename` (sibling bead hcom-4n3.2).
- Worlds `NAME_RE` / spawn name param (sibling bead hcom-4n3.3). No writes to `/home/sf/worlds`.
- Blurb/durable-blurb work. Any git operation. Any src implementation from the planner.
- README edit — the flag table (`README.md:344`) makes no four-letter claim; packet condition
  not triggered.
- Charset text on `SHARED_LAUNCH_FLAGS` (`src/commands/help.rs:1049-1063`) — `--instance` is
  mint-at-launch-only; resume/fork must not advertise it.
- Changing `--name` meaning; `HCOM_INSTANCE_NAME` as a request channel; `hcom-fu2`
  (Brief "Out of scope").
- Validating names that already exist in the DB (legacy rows stay resolvable/reclaimable).

## Implementation approach chosen (and rejected internals)

**Chosen:** tighten `BASE_NAME_RE` in place and extend `is_valid_base_name` with the reserved
set, keeping the function name and both existing call sites. Minimal diff, single source of
truth, no new module.

Rejected internals (all would satisfy the Brief; dropped on YAGNI/pattern grounds):

- *New `is_valid_instance_name` alongside `is_valid_base_name`* — two validators invite
  drift; the bead wants ONE shared helper.
- *Validation inside `launcher::launch` instead of parse* — the bead requires fail-closed
  **at parse**; launcher-side would also fire on fork/resume's internally generated names,
  which are valid by construction.
- *Unconditional grammar check on the `start --as` target* — would break reclaim of legacy
  stopped rows whose names predate the grammar, while lookup (`resolve_from_name`) still
  resolves them via the exact-match fallback. Fresh-claim-only validation keeps reclaim and
  lookup consistent.
- *README grammar line* — packet makes it conditional on a four-letter claim that does not
  exist.

## Open questions

None. The grammar, reserved set, and scope are frozen by bead hcom-4n3.1; the Brief's
`--instance` semantics are unchanged.

## Implementation consequences / risks (recorded, not requirements)

- Orphan recover (`src/commands/start.rs:263`) reuses the old name only if it passes the
  tightened validator; a pre-crash name that violates the grammar now yields a fresh CVCV
  name instead of reuse.
- A legacy row named e.g. `test` or `9lives` still resolves via the `resolve_display_name`
  exact-match fallback and can still be reclaimed via `start --as`; only *new* claims are
  grammar-gated.
- A chosen name that is itself 7 hex chars (e.g. `--instance a6d9caf`) remains mintable and
  takes precedence in `resolve_from_name`'s instance-first order — pre-existing ambiguity,
  unchanged by this spec.
