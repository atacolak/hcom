# hcom delete Technical Spec

**Design Brief:** `/home/sf/worlds/personal/designs/hcom/named-launch-instance.md` (Status: approved; supplies the campaign invariants — `--name` stays caller identity, `start --as` stays reclaim, fail-closed on held names)
**Packet:** bead `hcom-4n3.5` (operator ask, Ata 2026-09-20: "we also need a way to delete hcom agents. Different from retire. An actual delete.") under epic `hcom-4n3`. The Brief predates the delete ask and is silent on it; delete product intent flows from the operator-approved bead, which this spec quotes rather than paraphrases.
**Status:** sound
**Repo:** `/home/sf/workspace/hcom`

## Intent (from the Brief / packet — do not rewrite)

From bead hcom-4n3.5 (operator ask + shape, quoted):

- "`hcom delete <name>`" — "An actual delete." Distinct from:
  - `retire_sibling_lead` — "worlds: park/stop a sibling lead … Does not free the HCOM name. Does not delete the instances row."
  - `hcom stop` / `hcom kill` — "identity stays taken (historical names are referentially stable)."
  - `hcom discard` — "ONLY a never-committed provisional mint (placeholder row, no events). Refuses once the identity committed work. A launched actor like homer would be refused."
- "Fail closed if live pid (same as rename: plugin env would split-brain). Stop first."
- "Fail closed if name missing."
- "Remove the live `instances` row and live bindings (process/session/notify/claude_actor_capabilities)."
- "FREE the name: `collect_taken_names` must not keep it via the non-placeholder `life.stopped` snapshot (today that is why kill/stop names stay taken). Write a `life` event `action=deleted` that collect_taken_names treats as releasing, unlike `stopped`."
- "Do NOT rewrite historical `events.instance` or mail JSON. Archaeology keeps the old token. @name after delete matches nothing until a new mint."
- "`--go` inside AI tools. Help table in help.rs."
- "Distinct from discard (discard stays the never-committed path)."
- Out of scope (bead): worlds unbind (scope.toml/Beads/Herdr — "later, midi"), blurb, rename (.2), grammar (.1), village broadcast, writes under `/home/sf/worlds`.

Packet (lead) additions that do not amend product intent: decide the deleted-event reuse question as "free the name; @name after delete matches nothing until a new mint" (the bead's own answer); delete of a rename *current* name frees only that PK — former-name aliases stay taken and must not resolve to a ghost; router + `STATUS_SKIP_COMMANDS` like discard/rename.

From the Brief (named-launch-instance, approved) — invariants delete must not weaken:

- "`--name` stays caller identity on launch, send, start … everything else."
- "`hcom start --as` stays reclaim, not launch mint."
- "Name held by listening/active/blocked → fail closed."

## Mapping onto the current system

Observed (path:line, this tree):

| Packet directive | Seam | Observation |
|---|---|---|
| Mirror `discard` command shape | `src/commands/discard.rs:20-31` (`DiscardArgs`), `:138` (`cmd_discard(db, args, ctx) -> i32`), `:118-129` (initiator resolution), `:245-250` (isolated-DB test fixture) | `delete.rs` mirrors this structure: clap `Parser` args `{ name, json }`, exit-code contract 0/1 |
| Fail closed if name missing | `src/commands/discard.rs:141-171` | Reuse discard's exact split: no live row + a non-placeholder `life.stopped` event → `already_retired` ("name stays retired"); no row and no such event → `not_found`. Both exit 1 |
| Fail closed if live pid | `src/commands/rename.rs:81-91` (`row.pid` Some + `crate::sys::process::is_alive` → `live_process`); same predicate in `discard.rs:58-62` | Identical check. **"Stop first" means stop the *process*, not the identity:** `hcom stop`/`hcom kill` *delete* the instances row (`finalize_instance_stop`, `src/db/instances.rs:402-465`; kill calls `stop_instance` at `src/commands/kill.rs:146`), so after them delete correctly reports `already_retired`. Delete's target state — present row, dead/NULL pid — is exactly rename's target state (`rename.rs:63-64` comment); it arises from crashed/externally-killed processes and agy soft-finalize inactive rows (`src/launcher.rs:1539-1543`) |
| Remove live row + bindings | `src/db/instances.rs:402-465` `finalize_instance_stop` | Already the generic "terminal life event + delete live state" primitive: CAS `DELETE FROM instances WHERE name=? AND created_at=? AND session_id IS ? AND agent_id IS ?` (`:413-423`, 0 rows = lost race), then deletes `session_bindings`/`process_bindings` by session, `notify_endpoints` + `process_bindings` by name, non-delivery-only `events_sub:` kv rows (`:424-449`), inserts the caller-supplied life event in the same transaction (`:450-456`), and runs subscription notifications post-commit (`:459-463`). The action label lives in the caller's `event_data` — delete reuses it unchanged with `action=deleted` |
| claude_actor_capabilities removal | `src/hooks/common.rs:1570-1573` | Post-finalize: `revoke_claude_actor_capabilities_for_instance(name)` (`src/db/claude_actors.rs:167`), plus per-session revoke + `kv_delete_prefix("subagent_stop_inflight:{sid}:")` when a session exists (`claude_actors.rs:175`, `src/db/kv.rs:63`) |
| FREE the name | `src/instance_names.rs:249-271` `collect_taken_names` | Today `taken = alive ∪ stopped-non-placeholder (:254-263) ∪ former_names (:268)`. Change the stopped clause to *latest terminal event wins*: a name is stopped-taken iff its newest non-placeholder `life` event with `action IN ('stopped','deleted')` is `stopped`. A `deleted` event therefore releases the name; a later re-mint followed by `stopped` re-takes it. Placeholder stopped events stay ignored (discard's free path, `discard.rs:8-10`) |
| `life` event `action=deleted` | event shape at `src/hooks/common.rs:1537-1545` (`action`/`by`/`reason`/`snapshot`); snapshot fields `:1448-1470` | Insert `('life', instance=<name>, {"action":"deleted","by":<initiator>,"reason":"delete","snapshot":{…}})` via the reused `finalize_instance_stop`. No `placeholder` key — deleted is never placeholder-shaped |
| Do NOT rewrite historical events/mail | `src/db/mod.rs:269-275` (`events.instance`); mail tokens in `events.data` JSON | No UPDATE on `events`. The deleted event itself is attributed to the deleted name, so archaeology (`hcom events`, transcript queries) keeps the token |
| @name matches nothing until a new mint | `src/identity.rs:133-158` (`resolve_display_name`: exact live row, then alias hop `:140-143` requiring a live current row); `:218-270` (`resolve_from_name`, alias hop `:252-269`); `:161-210` (`resolve_display_name_or_stopped` consults only `action='stopped'`); send path `src/messages.rs:343-366` (alias re-match against live instances only; unmatched target fails closed), alias map loaded at `src/commands/send.rs:295` | After delete: no live row, no `stopped` event, alias hops require a live current → every resolution path misses. **No changes needed in identity.rs/messages.rs** — observed, verified against the alias-hop guards |
| Former aliases of a deleted current must not resolve to a ghost | `src/db/aliases.rs:38-44` (`former_names`), `:49-58` (`record_alias_tx`); `src/launcher.rs:1548-1553` (explicit mint refuses former names) | Delete leaves `instance_aliases` rows untouched: former names stay taken forever (`collect_taken_names` `:268`, launcher bail) and resolve dead because both alias hops require a live current row. This is the packet default: free only the deleted current PK |
| Name reusable by a new mint | `allocate_unreserved_name` `src/instance_names.rs:303-312` (uses `collect_taken_names`); explicit mint guard `src/launcher.rs:1548-1580` (checks alias + live row only); `start --as` fresh-claim path `src/commands/start.rs:366-375` (via `resolve_display_name_or_stopped`) | After delete, generated allocation may re-offer the name, explicit `--instance <name>` succeeds (no row, no alias), and `start --as <name>` treats it as a fresh claim |
| `--go` inside AI tools | `src/commands/discard.rs:195-199` (`is_inside_ai_tool()` `src/shared/platform.rs`; `ctx.go` from router `src/router.rs:763`) | Identical gate: preview + exit 0 without `--go` |
| Help table | `src/commands/help.rs`: `DISCARD_HELP` `:418-430`, `RENAME_HELP` `:432-438`; `COMMAND_NAMES` `:948-976`; top-level table `:1037-1038`; per-command dispatch `:1163-1164`; `all_commands_have_help` test list `:1437` ff. | `DELETE_HELP` + the same five wiring points |
| Router + STATUS_SKIP_COMMANDS | `src/router.rs`: `COMMANDS` `:23-44`, `Action::Command` guard `:602-624`, dispatch arms `:833-844`; `src/cli_context.rs:23-25`; `src/commands/mod.rs:9-10` | Same insertion points as rename |
| Distinct from discard | `src/commands/discard.rs` unchanged | Discard keeps the never-committed path; its conservative committed-predicate (`discard.rs:46-113`) is delete's inverse: delete *requires* nothing about commitment |

**Implementation consequences recorded (not new requirements):**

- **Children fail closed.** The bead enumerates exactly what delete removes ("the live instances row and live bindings") — child rows are not in it, stop-style cascade (`src/hooks/common.rs:1497-1532`) would destroy unnamed actors' identities, and leaving children with a dangling `parent_name` (no FK, `src/db/mod.rs:312`) corrupts the tree. Delete therefore refuses when live child rows exist (`SELECT COUNT(*) FROM instances WHERE parent_name = ?`, mirroring `discard.rs:89-96`) with a hint to stop the children first. A wrong refusal is recoverable; a wrong delete is not (`discard.rs:43-44`).
- **Placeholder rows are not refused.** The bead lists exactly two refusals (live pid, missing name); adding a "use discard instead" refusal would be stricter than the bead. Deleting a placeholder row works and frees the name — a superset of discard's mechanical effect. Discard remains the documented never-committed path.
- **Stopped-history queries simply don't see deleted names** — `was_subagent_name` (`src/db/instances.rs:478-500`), resume (`src/commands/resume.rs:1034-1040`, `:1852`), transcript (`src/commands/transcript.rs:347`, `:669`, `:857`, `:1390`), list stopped sections (`src/commands/list.rs:913-923`, `:1093`), `resolve_display_name_or_stopped` (`src/identity.rs:161-210`), subagent agent_id reclaim (`src/instance_names.rs:461-475`), bundle (`src/commands/bundle.rs:61`), delivery/hooks/TUI stopped queries. All filter `action='stopped'`; a deleted identity's terminal event is `deleted`, so it is not resumable, not listed as stopped, and not reclaimable by agent_id. That is the bead's intent ("an actual delete").
- **`start --as <deleted-name>` becomes a fresh claim** (grammar-gated, `src/commands/start.rs:366-375`) and `was_subagent_name` returns false for a deleted name — deleting a subagent slot lifts its `--as` protection. Consistent with "matches nothing until a new mint".
- **No schema bump.** No new tables; the `deleted` event is data, and the `collect_taken_names` change is a read query. `SCHEMA_VERSION` stays 19 (`src/db/mod.rs:43`).
- **No README line.** The bead names the docs surfaces (help table); README is unrequested.

## Architecture

One new native command mirroring `discard`, one read-query change in `collect_taken_names`, and wiring. No new subsystems, no schema change, no new DB helpers: the delete transaction is the existing `finalize_instance_stop` primitive called with an `action=deleted` event, and the post-commit teardown (capability revoke, thread-membership cleanup, wake, relay push) mirrors the tail of `stop_instance_inner` (`src/hooks/common.rs:1570-1580`) without its process-kill and child-cascade machinery (live pids are refused upstream; children are refused upstream).

## Components and interfaces

1. **`src/commands/delete.rs`** (new) —
   - `DeleteArgs { name: String, json: bool }` (clap `Parser`, mirrors `discard.rs:20-31`)
   - `pub fn cmd_delete(db: &HcomDb, args: &DeleteArgs, ctx: Option<&CommandContext>) -> i32`
   - `resolve_initiator` mirroring `discard.rs:118-129`
   - refusal helpers mirroring `discard.rs:141-192` / `rename.rs:47-55`
2. **`src/instance_names.rs:249-271`** — `collect_taken_names` stopped clause becomes latest-terminal-event-wins (SQL in Data / control flow). Signature unchanged: `Result<(HashSet<String>, HashSet<String>)>`.
3. **Wiring** — `src/commands/mod.rs:9-10` (`pub mod delete;`, alphabetical between `daemon` and `discard`), `src/router.rs` (`COMMANDS` after `"rename"` at `:39`; guard list after `"rename"` at `:610`; dispatch arm after the rename arm at `:840-844`), `src/cli_context.rs:23-25` (`STATUS_SKIP_COMMANDS` += `"delete"`).
4. **`src/commands/help.rs`** — `DELETE_HELP` after `RENAME_HELP` (`:432-438`), `COMMAND_NAMES` after `"rename"` (`:964`), top-level table line after `:1038`, dispatch after `:1164`, `all_commands_have_help` list after `:1444`.

No changes to `identity.rs`, `messages.rs`, `send.rs`, `db/aliases.rs`, `launcher.rs`, or any `events`/mail table.

## Data / control flow

`hcom delete <name>`:

1. Parse (`DeleteArgs`). Load row via `db.get_instance_full(name)`. None → distinguish `already_retired` (non-placeholder `life.stopped` exists, query mirrors `discard.rs:146-152`) from `not_found`; exit 1.
2. Live-pid check: `row.pid` Some and `is_alive` → `live_process` exit 1 ("process pid=N is alive; stop it first" — mirrors `rename.rs:81-91`).
3. Children check: `instances WHERE parent_name = ?` count > 0 → `delete_refused` exit 1 listing child names, hint `hcom stop <child>` first.
4. `--go` gate: `is_inside_ai_tool() && !ctx.go` → print preview ("Would delete '<name>' (committed identity; history stays; name becomes reusable). Re-run with --go to confirm."), exit 0 (mirrors `discard.rs:195-199`).
5. Snapshot wake ports (`crate::notify::snapshot_wake_ports`, `src/notify/wake.rs:77`) — before delete, so remaining listeners see the row gone.
6. Build `event_data = {"action":"deleted","by":<initiator>,"reason":"delete","snapshot":{…}}` with the snapshot fields of `src/hooks/common.rs:1448-1470`.
7. `db.finalize_instance_stop(name, row.created_at, row.session_id, row.agent_id, &event_data)` (`src/db/instances.rs:402-465`):
   - `Ok(false)` → lost the CAS race → `delete_refused` "identity changed concurrently", exit 1 (mirrors `discard.rs:218-231`)
   - `Err(e)` → exit 1 with error
   - `Ok(true)` → row + session/process/notify bindings + non-delivery-only `events_sub:` rows deleted; `life/deleted` event durable; subscription notifications fired
8. Post-commit (mirror `src/hooks/common.rs:1570-1580` and `discard.rs:208`):
   - `db.revoke_claude_actor_capabilities_for_instance(name)`; if session: `revoke_claude_actor_capabilities_for_session(sid)` + `kv_delete_prefix("subagent_stop_inflight:{sid}:")`
   - `db.cleanup_thread_memberships_for_name_reuse(name)` (`src/db/subscriptions.rs:372`) — delete is identity *replacement* (the name will be re-minted); delivery-only memberships must not survive to misroute the next incarnation
   - `crate::notify::wake_ports(&ports, crate::notify::WAKE_TARGETED_MS)`; `crate::relay::spawn_background_push()`
9. Output: human `Deleted '<name>' (name is reusable)` or `--json` `{"deleted": name, "name_reusable": true}`. Exit 0.

`collect_taken_names` (`src/instance_names.rs:254-263`) stopped clause becomes:

```sql
SELECT DISTINCT instance FROM events e
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
  )
```

Semantics: stop → taken (unchanged); delete → free; delete → re-mint → stop → taken again (the newer `stopped` wins); placeholder discard → still ignored. Alive rows and former names are unioned afterward exactly as today (`:251-252`, `:268`).

## Error handling

All failures exit 1 with stderr message; `--json` prints `{"error": "<code>", …}` (mirrors `discard.rs:154-170`, `rename.rs:47-55`):

| code | condition |
|---|---|
| `not_found` | no `instances` row and no non-placeholder `life.stopped` history |
| `already_retired` | no live row; stopped/killed history exists — name stays retired |
| `live_process` | `row.pid` is Some and alive — stop the process first |
| `delete_refused` | live child rows exist, or the CAS race was lost ("identity changed concurrently") |
| `delete_failed` | transaction / DB error from `finalize_instance_stop` |

## Testing (behavioral contracts; exact tests live in the plan)

Isolated-DB tests mirroring `discard.rs:245-250` (`tempfile` + `HcomDb::open_raw` + `init_db`). Bead acceptance maps to:

1. Committed row with session/process/notify/capability bindings and one historical message → `cmd_delete` exits 0; row gone; all four binding surfaces empty for the name; historical `events.instance`/`data` byte-identical; a `life` event `action=deleted` with `by`/`reason`/`snapshot` exists, attributed to the name.
2. Name freed: after delete, `collect_taken_names` does not contain the name; after plain stop it still does (regression guard); delete→re-mint→stop re-takes; placeholder discard still frees.
3. Live pid (`pid = std::process::id()`, pattern `src/sys/process.rs:850-856`) → exit 1; row, bindings, and taken-set untouched; no `deleted` event.
4. Missing name → `not_found` exit 1; stopped-retired name → `already_retired` exit 1.
5. Live child rows → `delete_refused` exit 1 naming the children; parent row intact.
6. Rename interplay: rename `luna → luna_lead`, delete `luna_lead` → `luna_lead` freed; `alias_current("luna")` still `Some("luna_lead")` (former stays taken); `resolve_display_name("luna")` is `None` (dead, no ghost); send-path `resolve_targets` with the alias map leaves `luna` unmatched.
7. `--go` gate: inside-AI-tool ctx without `go` → exit 0 preview, row intact; with `go` → proceeds (fixture pattern `discard.rs:385-390`).
8. Placeholder row → delete exits 0 and frees the name (no commitment refusal).
9. Help: `all_commands_have_help` covers `delete`; `DELETE_HELP` renders.

## Non-goals

- Worlds hop (scope.toml lead unbind, Beads assignees, Herdr pane close) — the bead assigns it to midi, later. No writes under `/home/sf/worlds`.
- Blurb, rename (hcom-4n3.2, shipped), grammar (hcom-4n3.1), village broadcast.
- Removing or changing `hcom discard` — it stays the never-committed path.
- Rewriting historical `events.instance`, mail JSON (`from`/`mentions`/`delivered_to`), `[hcom:<name>]` markers, pidtrack files, on-disk transcript paths.
- Freeing former-name aliases of a deleted current (they stay taken and go dead — packet default).
- Freeing already-retired (stopped/killed) names — delete requires the live row; `already_retired` fails closed.
- Schema migration, README, git operations, any `src` implementation in this spec.

## Implementation approach chosen (and rejected internals)

**Chosen:** new `delete.rs` command reusing `finalize_instance_stop` as the generic terminal-event+delete primitive; latest-terminal-event-wins in `collect_taken_names`; alias rows left intact (former names go dead); children and live pids fail closed.

Rejected internals (all would satisfy the bead; these lose on YAGNI/existing patterns):

- **New `finalize_instance_delete` DB method** duplicating `finalize_instance_stop`: the existing method is already action-agnostic (the label is caller-supplied `event_data`, `src/db/instances.rs:408`); duplication adds a second CAS/cleanup path to keep in sync for zero behavior change.
- **Reuse `stop_instance_inner` with a `delete` flag**: it carries process-kill, pidtrack, and child-cascade machinery (`src/hooks/common.rs:1310-1532`) that delete has explicitly refused upstream; a flag threading past all of it is more coupling than the ~15 lines of post-commit teardown delete actually needs.
- **`stopped`-set minus `deleted`-set** (any historical delete releases the name) instead of latest-event-wins: breaks re-mint→stop (a stale `deleted` event would cancel a newer `stopped`, freeing a name whose current incarnation stopped). Latest-event-wins is the only correct ordering.
- **Tombstone semantics** (deleted names stay taken forever): the bead decides otherwise — "free the name … until a new mint".
- **Deleting alias rows pointing at the deleted current** ("aliases go away"): would silently free former names; the packet default is historical stability — free only the deleted PK.
- **Refusing placeholder rows** ("use discard"): stricter than the bead's two named refusals; invented product.

## Open questions

None affecting product. Lead (gina, 2026-09-19) accepted all four internal mappings: children fail-closed; placeholder rows deletable; `--json` kept; snapshot on `life/deleted`.
