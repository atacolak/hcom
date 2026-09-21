# hcom rename Technical Spec

**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (Status: approved; supplies the chosen-name invariants — `--instance` mint, fail-closed on conflict, frozen grammar via hcom-4n3.1)
**Packet:** bead `hcom-4n3.2` (operator ask, Ata 2026-09-19) under epic `hcom-4n3` ("Rename primitive … rewrites *live* bindings … Historical mail/events keep the old token; resolution must still find the actor from either name"). The Brief predates the rename ask and is silent on it; rename product intent flows from the operator-approved epic + bead packet, which this spec quotes rather than paraphrases.
**Status:** sound
**Repo:** `/home/sf/workspace/hcom`

## Intent (from the Brief / packet — do not rewrite)

From bead hcom-4n3.2 (operator ask):

- "`hcom rename <old> <new>`"
- "`new` must pass the frozen grammar (.1)." — frozen in hcom-4n3.1 as `^[a-z][a-z0-9_]{0,23}$` (1–24 chars, starts with a letter; no dashes, no spaces, no uppercase), reserved: `all` plus `instance_names::banned_names`. This supersedes the epic's earlier `[a-z][a-z0-9-]{1,23}` sketch, which the epic itself marked "(or similar)".
- "Fail closed if `new` is taken (live row or reserved former name)."
- "Fail closed if `old` has a live pid (HCOM_INSTANCE_NAME is process env; live rewrite split-brains the plugin). Worlds stops/recycles then calls this."
- "Rewrite live PK: `instances.name`, `process_bindings.instance_name`, `session_bindings` if keyed by name, `claude_actor_capabilities.instance_name`, parent_name FKs, notify endpoints if any."
- "Do NOT rewrite historical `events.instance` or mail JSON (`from`, `mentions`, `delivered_to`). Those tokens stay."
- "Record alias old -> new so send / list / start --as / identity resolve the former name to the current row. Former name stays taken (historical stability; not discard)."
- "Write a `life` event `action=renamed`."
- "Help table in help.rs. Router + STATUS_SKIP_COMMANDS like discard."
- "Schema bump (currently 18)."

From the Brief (named-launch-instance, approved) — invariants rename must not weaken:

- "`--name` stays caller identity on launch, send, start … everything else."
- "`hcom start --as` stays reclaim, not launch mint."
- "Name held by listening/active/blocked → fail closed."

## Mapping onto the current system

Observed (path:line, this tree):

| Packet directive | Seam | Observation |
|---|---|
| Mirror `discard` command shape | `src/commands/discard.rs:20-31` (`DiscardArgs`), `:139-237` (`cmd_discard` → exit-code contract 0/1), `:117-129` (initiator resolution), `:245-250` (isolated-DB test fixture) | `rename.rs` mirrors this structure: clap `Parser` args, `cmd_rename(db, args, ctx) -> i32`, `--json` flag (discard's documented machine-readable mode, `discard.rs:27-30`; the primary caller is worlds automation per the bead) |
| `instances.name` PK rewrite | `src/db/mod.rs:308-342` (`name TEXT PRIMARY KEY` at `:309`) | Single `UPDATE instances SET name=?2 WHERE name=?1`; affected-rows==1 is the concurrency CAS (mirrors the CAS spirit of `finalize_instance_stop`, `src/db/instances.rs:413-423`) |
| parent_name FKs | `src/db/mod.rs:312` (`parent_name TEXT`; no FK constraint — only `parent_session_id` has one, `:341`) | `UPDATE instances SET parent_name=?2 WHERE parent_name=?1` — children follow the rename |
| `session_bindings` keyed by name | `src/db/mod.rs:299-304` (`instance_name TEXT NOT NULL` `:301`, FK `REFERENCES instances(name) ON DELETE CASCADE` `:303`) | Keyed by name → rewrite. FK has no `ON UPDATE CASCADE` and is not DEFERRABLE, so the transaction must `PRAGMA defer_foreign_keys = ON` (transaction-scoped; `PRAGMA foreign_keys` is a no-op inside a transaction) |
| `process_bindings.instance_name` | `src/db/mod.rs:289-294` (`:292`; no FK) | Rewrite |
| `claude_actor_capabilities.instance_name` | `src/db/mod.rs:345-354` (`:350`; created by migration 18, `src/db/mod.rs:51-69`) | Rewrite |
| notify endpoints "if any" | `src/db/mod.rs:278-284` — `notify_endpoints.instance TEXT NOT NULL`, PK `(instance, kind)` | Keyed by name → rewrite. Accessors in `src/db/notify.rs:23-90` confirm name-keyed |
| Do NOT rewrite `events.instance` / mail JSON | `src/db/mod.rs:269-275` (`instance TEXT NOT NULL` `:273`); mail tokens live in `events.data` JSON (`from`/`mentions`/`delivered_to`, view columns `src/db/mod.rs:379-407`) | No UPDATE on `events`. Historical tokens stay referentially stable (epic: "Historical names are referentially stable by design") |
| Live-pid refusal | `InstanceRow.pid: Option<i64>` `src/db/instances.rs:45`; `crate::sys::process::is_alive` `src/sys/process.rs:119`; existing pattern `src/commands/discard.rs:58-62` | Fail closed when `row.pid` is Some and alive. Note: `hcom stop` *deletes* the instances row (`finalize_instance_stop`, `src/db/instances.rs:402-465`), so "old missing" and "old stopped" are the same case — rename operates on a present row with a dead/NULL pid (worlds kills/recycles the process, then calls rename) |
| Alias table, schema 19 | `SCHEMA_VERSION: i32 = 18` `src/db/mod.rs:40`; `MIGRATIONS` `src/db/mod.rs:42-70`; fresh-schema block `src/db/mod.rs:266-426` | New table `instance_aliases (former TEXT PRIMARY KEY, current TEXT NOT NULL)` in both the v19 migration and `init_db` |
| `collect_taken_names` includes former names | `src/instance_names.rs:249-267` | Extend `taken_names` with `SELECT former FROM instance_aliases`; generated mints (`allocate_unreserved_name`, `:300-308`) then never collide with former names |
| Former name stays taken vs explicit mint | `resolve_explicit_name_conflict` `src/launcher.rs:1548-1580` only checks the live row | Without a guard, `hcom omp --instance <former>` would mint onto a reserved former name and silently break the alias invariant. Add a former-name bail here. This is required by the packet's own invariant ("Former name stays taken … not discard"), not new product |
| identity resolve: exact → alias → tag/uuid | `resolve_display_name` `src/identity.rs:125-142` (exact → tag-name); `resolve_from_name` `src/identity.rs:202-267` (exact → agent_id); `resolve_display_name_or_stopped` `:146-192` delegates to `resolve_display_name` first | Insert the alias hop after the exact-name miss, before the existing tag-name/uuid paths, in both functions. Covers `list` (`src/commands/list.rs:274`), `start --as` (`src/commands/start.rs:89`, `:364`), transcript/bundle/run callers of `resolve_display_name` |
| send resolves former name | `compute_scope` `src/messages.rs:372` → `resolve_targets` `:343-361` → `match_target` `:256-327` (resolution order documented `:248-254`); sole production caller `resolve_delivery` `src/commands/send.rs:285-298` | Thread an alias map (`HashMap<former, current>`) from `resolve_delivery` (has `db`) into `compute_scope`/`resolve_targets`. On exact miss, map target through aliases and re-match. Former names can never equal a live name (they stay taken), so exact-then-alias ordering is preserved |
| life event `action=renamed` | `log_event` `src/db/events.rs:472-480`; `log_life_event` `:444-451` (fixed shape action/by/reason/snapshot — too narrow for `{from,to}`); tx-scoped event insert + post-commit subscription processing pattern `src/db/instances.rs:450-463` | Insert `('life', instance=<new>, {"action":"renamed","from":<old>,"to":<new>,"by":<initiator>})` inside the transaction via `tx.execute`; after commit, `subscriptions::process_logged_event` (mirrors `finalize_instance_stop`) |
| Router like discard | `COMMANDS` `src/router.rs:23-43` (`"discard"` `:38`); `Action::Command` guard `:602-622` (`:608`); dispatch arm `:832-837` | Three additions |
| STATUS_SKIP_COMMANDS | `src/cli_context.rs:23-26` | Add `"rename"` — lifecycle command handled internally, same class as stop/kill/discard |
| Help table | `DISCARD_HELP` `src/commands/help.rs:418-430`; `COMMAND_NAMES` `:939-975`; top-level table `:1019-1036` (`discard` line `:1027`); per-command dispatch `:1152`; `all_commands_have_help` test list `:1425-1431` | `RENAME_HELP` + four wiring points + test list |
| README one line | `README.md:35-37` documents `discard` as a bullet; commands listed at `README.md:327-336` | Add one bullet/line for `rename` |

**Implementation consequence recorded (not a new requirement):** `kv` rows under the `events_sub:` prefix carry a live `caller` field holding the instance name (`src/db/subscriptions.rs:3-20`). Thread-delivery memberships are matched **literally** against live instance names at delivery time (`src/commands/send.rs:302`, `:326-333`), and stop/resume deliberately preserves delivery-only memberships because the identity continues (`src/commands/discard.rs:204-208`; stop deletes only non-delivery-only rows, `src/db/instances.rs:443-449`). Rename is identity *continuation* (like stop/resume), not identity *replacement* (discard). Therefore the transaction rewrites `$.caller` on `events_sub:` rows where `caller = <old>`; `sql`/`params`/`filters` text is NOT touched (declarative string tokens stay, same rule as `events.instance`/mail JSON). Without this, a renamed actor silently loses thread delivery — contradicting the epic's "rewrites *live* bindings".

**Consequences accepted (recorded, not requirements):**

- Historical display: `resolve_display_name` alias hop means tooling that renders a historical old token (transcript/bundle) resolves it to the current row's display name. This is the packet's directive ("identity resolve the former name to the current row").
- Rename is one-way: `rename b → a` after `a → b` fails closed because `a` is a reserved former name. Historical stability; not discard.
- `pidtrack` file entries (`src/pidtrack.rs`) and on-disk transcript paths keyed by old name are left as-is; the packet scopes the rewrite to DB tables, and live-pid renames are refused.
- `[hcom:<name>]` transcript markers (Brief preserve-list) are historical text — untouched.

## Architecture

One new native command mirroring `discard`, one new DB table, one new alias-read path threaded through the three existing resolution seams (identity, send targets, taken-names). No new subsystems. The rename itself is a single `with_immediate_transaction` (`src/db/mod.rs:152-160`) with deferred FK enforcement; the audit event is inserted in the same transaction so a failure rolls the whole rename back (mirrors `finalize_instance_stop`'s "event failure rolls the deletion back", `src/hooks/common.rs:1534-1537`).

## Components and interfaces

1. **`src/db/aliases.rs`** (new; `pub(crate) mod aliases;` in `src/db/mod.rs` near `:30`, mirroring the `subscriptions` module pattern) — owns `instance_aliases`:
   - `pub fn alias_current(db: &HcomDb, former: &str) -> Result<Option<String>>`
   - `pub fn alias_map(db: &HcomDb) -> Result<HashMap<String, String>>`
   - `pub fn former_names(db: &HcomDb) -> Result<Vec<String>>`
   - `pub(crate) fn record_alias_tx(tx: &Transaction, old: &str, new: &str) -> Result<()>` — `UPDATE instance_aliases SET current=?2 WHERE current=?1` (chain collapse) then `INSERT INTO instance_aliases (former,current) VALUES (?1,?2)` (plain INSERT: the taken-invariant makes a duplicate `former` impossible; a PK violation rolls back and surfaces invariant breakage)
   - `HcomDb` delegation wrappers in `src/db/mod.rs`, mirroring `:929-937`
2. **Schema 19** — `src/db/mod.rs:40` → 19; `MIGRATIONS` (`:42-70`) gains `(19, "CREATE TABLE IF NOT EXISTS instance_aliases (former TEXT PRIMARY KEY, current TEXT NOT NULL);")`; same `CREATE TABLE` in `init_db` (near `:360`).
3. **`src/instance_names.rs:249-267`** — `collect_taken_names` extends `taken_names` with `former_names(db)`.
4. **`src/identity.rs`** — alias hop in `resolve_display_name` (`:125-142`) and `resolve_from_name` (`:202-267`): on exact miss, `db.alias_current(input)`; if it maps to a name with a live row, resolve to that. Then existing tag-name/uuid paths unchanged.
5. **`src/messages.rs` + `src/commands/send.rs`** — `compute_scope`/`resolve_targets` gain an `aliases: &HashMap<String, String>` parameter; `match_target` unchanged; `resolve_targets` tries `match_target(target)` first, then `match_target(aliases[target])` on miss. `resolve_delivery` (`send.rs:285-298`) loads `db.alias_map().unwrap_or_default()` and passes it down.
6. **`src/commands/rename.rs`** (new) — `RenameArgs { old: String, new: String, json: bool }`; `pub fn cmd_rename(db: &HcomDb, args: &RenameArgs, ctx: Option<&CommandContext>) -> i32`. Initiator resolution mirrors `discard.rs:117-129`.
7. **Wiring** — `src/commands/mod.rs:10` area (`pub mod rename;` in Lifecycle), `src/router.rs` (three points above), `src/cli_context.rs:23-26`.
8. **`src/launcher.rs:1548-1580`** — `resolve_explicit_name_conflict` bails when `name` is a former name.
9. **Docs** — `src/commands/help.rs` (`RENAME_HELP`, `COMMAND_NAMES`, top-level table, dispatch, test list), `README.md` one line.

**External contract (sibling hcom-4n3.1, not this spec's work):** the shared chosen-name validator, expected as `crate::instance_names::validate_chosen_name(name: &str) -> Result<(), String>` implementing the frozen grammar `^[a-z][a-z0-9_]{0,23}$` with reserved `all` + `banned_names`. Rename calls it; rename does not implement it. If .1 has not landed when builders start, that is a blocker to report to the lead, not license to write the grammar here.

## Data / control flow

`hcom rename <old> <new>`:

1. Parse (`RenameArgs`). Load `old` row via `db.get_instance_full` (`src/db/instances.rs:705`). None → `not_found`, exit 1.
2. Live-pid check: `row.pid` Some and `is_alive` → `live_process`, exit 1 (hint: stop/recycle the process first).
3. Grammar: `validate_chosen_name(new)` Err → `invalid_name`, exit 1.
4. Taken: `collect_taken_names(db)` (alive + stopped-historical + former) contains `new` → `name_taken`, exit 1. (`new == old` is caught here: `old`'s live row is in the taken set.)
5. Transaction (`with_immediate_transaction`):
   - `PRAGMA defer_foreign_keys = ON` (required for the `session_bindings` FK, `src/db/mod.rs:303`)
   - `UPDATE instances SET name=?2 WHERE name=?1` — 0 rows ⇒ concurrent change ⇒ rollback, exit 1
   - `UPDATE instances SET parent_name=?2 WHERE parent_name=?1`
   - `UPDATE process_bindings SET instance_name=?2 WHERE instance_name=?1`
   - `UPDATE session_bindings SET instance_name=?2 WHERE instance_name=?1`
   - `UPDATE claude_actor_capabilities SET instance_name=?2 WHERE instance_name=?1`
   - `UPDATE notify_endpoints SET instance=?2 WHERE instance=?1`
   - `UPDATE kv SET value=json_set(value,'$.caller',?2) WHERE key LIKE 'events\_sub:%' ESCAPE '\' AND json_extract(value,'$.caller')=?1`
   - `record_alias_tx(tx, old, new)`
   - `INSERT INTO events (timestamp,type,instance,data) VALUES (?,'life',?2,'{"action":"renamed","from":?1,"to":?2,"by":…}')`
6. Post-commit: `subscriptions::process_logged_event(db, event_id, "life", new, &data)` (mirrors `src/db/instances.rs:459-463`).
7. Output: human `Renamed '<old>' → '<new>' (former name stays reserved)` or `--json` `{"renamed":{"from":…,"to":…}}`. Exit 0.

Resolution after rename: `send @old` / `list <old>` / `start --as <old>` / `--name <old>` hit the alias hop and land on the current row; historical `events.instance=<old>` and mail JSON keep the old token.

## Error handling

All failures exit 1 with stderr message, and `--json` prints `{"error": "<code>", …}` (mirrors `discard.rs:154-170`, `:173-192`):

| code | condition |
|---|---|
| `not_found` | no `instances` row for `old` (never existed, or already stopped — stop deletes the row) |
| `live_process` | `old` has a live pid |
| `invalid_name` | `new` fails the frozen grammar (validator message propagated) |
| `name_taken` | `new` in taken set (live row, stopped-historical, or reserved former name) |
| `rename_failed` | transaction error / lost concurrency race (0 rows on the PK UPDATE) |

## Testing (behavioral contracts; exact tests live in the plan)

Isolated-DB tests mirroring `discard.rs:245-250` (`tempfile` + `HcomDb::open_raw` + `init_db`; permitted by `src/db/mod.rs:101-119`). Bead acceptance maps to:

1. Row `luna` with session/process bindings, notify endpoint, capability row, a child row (`parent_name='luna'`), and one historical message → rename to `luna_lead` exits 0; every live surface follows; the historical event row still reads `instance='luna'` with byte-identical `data`.
2. `send`-path resolution: after rename, targets `luna` and `luna_lead` both resolve to `luna_lead`; `resolve_display_name(db, "luna")` returns `luna_lead`.
3. Live-pid rename (`pid = std::process::id()`, pattern `src/sys/process.rs:850-856`) exits 1 and leaves every table untouched.
4. Taken target (live row / stopped-historical / former name) exits 1; grammar-violating `new` exits 1; missing `old` exits 1.
5. Chain: `luna→luna_lead`, then `luna_lead→luna_lead2`; `alias_current("luna")` = `luna_lead2`; `collect_taken_names` contains `luna` and `luna_lead`.
6. `life` event `action=renamed` with `from`/`to`/`by` exists, attributed to the new name.
7. Migration: a v18 DB gains `instance_aliases` at `user_version=19` with data preserved (pattern `src/db/mod.rs:1576-1660`).
8. `resolve_explicit_name_conflict` rejects a former name.

## Non-goals

- Worlds scope.toml / Beads assignees / Herdr titles (sibling hcom-4n3.3, midi). No writes under `/home/sf/worlds`.
- Grammar implementation (sibling hcom-4n3.1) — the shared validator is assumed to exist.
- Blurb (hcom-4n3 sibling), `hcom-fu2`, git operations, any `src` implementation in this spec.
- Rewriting `events.instance`, mail JSON (`from`/`mentions`/`delivered_to`), `[hcom:<name>]` markers, `events_sub:` `sql`/`params` text, pidtrack files, on-disk transcript paths.
- Renaming row-less (stopped) identities: stop deletes the row (`src/db/instances.rs:402-465`); "old missing" fails closed per the packet.
- A `--go` confirmation gate: the packet specifies the command as `hcom rename <old> <new>` with fail-closed exits; adding a gate would be stricter than the packet. (`--json` is kept: it is part of the discard shape the packet says to mirror, and the named caller is worlds automation.)

## Implementation approach chosen (and rejected internals)

**Chosen:** in-place PK `UPDATE` inside one immediate transaction with `PRAGMA defer_foreign_keys = ON`, alias table with write-time chain collapse (O(1) single-hop resolution), alias hop added to the two existing identity resolvers and the send target matcher.

Rejected internals (all would satisfy the Brief; these lose on YAGNI/existing patterns):

- **Insert-new-row + delete-old-row** instead of PK UPDATE: trips `session_id`/`agent_id` UNIQUE bookkeeping, fires `ON DELETE CASCADE` on `session_bindings` (`src/db/mod.rs:303`) requiring delete/re-insert of children, and abandons the affected-rows CAS. More moving parts, same behavior.
- **`PRAGMA foreign_keys = OFF`** around the transaction: connection-global (set ON at open, `src/db/mod.rs:136`), a no-op once a transaction is open, and races with WAL readers. `defer_foreign_keys` is transaction-scoped and local.
- **Read-time alias chain walking** instead of write-time collapse: resolution would need a loop/recursive CTE at every call site for a chain that collapses to one hop at write time.
- **Alias-overlay instead of PK rewrite** (the epic's fallback): the bead explicitly took the PK rewrite ("Renaming MUST rewrite live declaration surfaces (HCOM PK plus …)"). Not a live option.
- **New resolver function** instead of extending `resolve_display_name`/`resolve_from_name`: the packet wants alias resolution in "identity resolve" generally; a parallel resolver would leave `list`/`start --as`/transcript callers on the old path.

## Open questions

None affecting product. (Internal mappings flagged for lead veto: the `events_sub:` `caller` rewrite and `--json`, both justified inline above.)
