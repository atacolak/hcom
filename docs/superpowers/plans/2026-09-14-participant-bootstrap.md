# Implementation Plan: Participant bootstrap

**Spec:** `docs/superpowers/specs/2026-09-14-participant-bootstrap.md`
**Brief:** `/home/sf/worlds/personal/designs/hcom/participant-bootstrap.md`
**Repo:** `/home/sf/workspace/hcom`

One builder, two serial tasks (same files would collide if parallel).
No git commit from the builder. Skip formatters and full `cargo test`.
This crate is binary-only — no `cargo test --lib`.

---

- [x] ## Task 1: rust participant template + omp-start field

**Owner:** builder
**Files:**

- Modify: `src/bootstrap.rs`
- Modify: `src/hooks/omp/handlers.rs` (`handle_start` JSON)

**Change:**

1. Add `PARTICIPANT` template next to `UNIVERSAL`. Identity,
   inbound intent, `<hcom>` is mail, outbound `send_to_actor` never
   CLI `hcom send`, wait rules (end turn; no sleep; no `hcom listen`
   for inbound). No capabilities table. No `UVX_CMD_NOTICE`.
2. `pub fn get_participant_bootstrap(...)` — same args as
   `get_bootstrap` minus `tool` if unused. Render `PARTICIPANT` +
   tag/relay/headless/notes. Wrap in `<hcom_system_context>`.
   Do **not** run the `\bhcom\b` → `uvx hcom` rewrite (there is no
   CLI catalog). Keep `[hcom:` / `<hcom>` tags intact.
3. `handle_start` response JSON:

   ```json
   { "name", "session_id", "bootstrap", "bootstrap_participant" }
   ```

   `bootstrap` = existing `get_bootstrap(...)`.
   `bootstrap_participant` = `get_participant_bootstrap(...)`.

4. Tests in `src/bootstrap.rs`:
   - participant contains `Your name:`, inbound request/inform/ack,
     `send_to_actor`, end-turn wait.
   - participant does not contain `You MUST use`, `hcom <cmd+flags>`,
     `hcom 1 claude`, `hcom kill`, `UVX` notice, `--name luna` CLI
     recipe.
   - existing `test_get_bootstrap_omp_launched_gets_auto_delivery`
     and claude/pi tests still pass (full catalog).

**Acceptance:** `cargo test --bin hcom -- bootstrap:: -- --test-threads=1`
green. `handle_start` JSON includes both keys (extend an existing
omp start test if one already parses the JSON; otherwise a tight
new test in `src/hooks/omp/tests.rs`).

**Verification:** command output, not a story.

**Forbidden:** worlds tree, plugin inject logic (task 2), commits,
full-suite.

---

- [x] ## Task 2: plugin chooses participant vs full

**Owner:** builder
**Depends:** Task 1
**Files:**

- Modify: `src/omp_plugin/hcom.ts`
- Modify: `src/omp_plugin/hcom.test.ts`
- The plugin is also embedded (`PLUGIN_SOURCE`); keep that path
  consistent with however this repo already embeds `hcom.ts`
  (do not invent a second copy).

**Change:**

1. `bindIdentity` stores `bootstrapText` (full) and
   `bootstrapParticipantText` from `json.bootstrap_participant`.
2. Helper `hasSendToActor(pi, ctx, deps)`:
   - `deps.hasSendToActor === true|false` wins (tests).
   - else duck-type `pi.tools?.has("send_to_actor")` if present.
   - else scan `ctx.getSystemPrompt?.()` joined text for
     `send_to_actor` as a tool name (word boundary).
   - else false (full catalog).
3. `before_agent_start` injects participant text when
   `hasSendToActor`, else full. Missing participant field → full.
   `customType` stays `"hcom-bootstrap"`, `display: false`.
4. Log `shape: "participant" | "full"`.
5. Tests:
   - existing ownership-marker test still passes (full path).
   - with `hasSendToActor: true` and both JSON fields, injected
     content is the participant string, still `hcom-bootstrap`.
   - with `hasSendToActor: false` / omitted, injected content is
     full `bootstrap`.
   - old `omp-start` JSON without `bootstrap_participant` +
     `hasSendToActor: true` still injects full (fail closed).

**Acceptance:** `bun test src/omp_plugin/hcom.test.ts` (or the
repo's existing plugin test command) green. Marker test still
asserts `customType === "hcom-bootstrap"`.

**Forbidden:** worlds tree, rust template rewrite (task 1),
commits, changing delivery-lane `decideInjection`.

---

## Out of scope (midi / later)

- `queued: false` lie in `deliverHcom`
- `discover_actors` fail-loud vs `actor list` tolerate
- `[coordination].lead` for hcom (gina-as-sibling)
- hide `skill://hcom` from named-lead catalogs
- recut `project-lead.md` three-verb teaching (midi after this lands)
