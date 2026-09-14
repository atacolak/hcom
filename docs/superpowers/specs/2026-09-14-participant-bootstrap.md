# Technical Spec: Participant bootstrap for actor-bridge omp leads

**Design Brief:** `/home/sf/worlds/personal/designs/hcom/participant-bootstrap.md`
**Status:** approved (operator 2026-09-14; midi #59450)
**Repo:** `/home/sf/workspace/hcom`

## Problem

Named omp leads with actor-bridge tools receive two outbound contracts.
Hidden `hcom-bootstrap` (`src/bootstrap.rs` `UNIVERSAL`) says
`You MUST use hcom <cmd+flags> --name {instance}` and
`hcom message → run hcom send`. `project-lead.md`, autoloaded
`actor-coordination`, and `skill://hcom` say a named lead has no
lead-safe CLI send and must use `send_to_actor`. The bootstrap is
injected as system context (`customType: "hcom-bootstrap"`), so it
wins. That is why gina used bash mail.

## Goal

Keep a primer. Split it. When this omp process has `send_to_actor`
available to the model, inject a participant primer (identity +
inbound protocol + wait rules + `send_to_actor` outbound). Otherwise
keep today's full CLI catalog. Do not delete bootstrap. Do not sniff
worlds from rust.

## Detection (observed, not `pi.tools.has`)

Public `ExtensionAPI` (`d164f414` `extensions/types.ts`) has
`registerTool`, not `tools.has`. `ExtensionContext` has no tool
registry. `Extension.tools` is loader-internal.

Boring live switch, in the omp plugin at inject time
(`before_agent_start`):

1. Scan `ctx.getSystemPrompt()` for a tool-description line that
   names `send_to_actor` as a registered tool (the actor-bridge
   description string already contains that name).
2. Optionally also duck-type `(pi as { tools?: Map<string, unknown> }).tools?.has("send_to_actor")`
   if the runtime object happens to expose the loader map. Prompt
   scan is the authority; duck-type is a fast path.

Do not rust-sniff worlds extensions. Do not key on
`HCOM_OMP_IDENTITY_OWNER`. Do not add a launch flag as the live
switch. A test-only hook on the plugin factory is allowed
(`deps.hasSendToActor?: boolean`) so unit tests do not depend on
prompt text.

If `getSystemPrompt` is missing on a fake ctx, treat as no actor
tools (full catalog). Fail closed toward CLI, not toward stripping.

## Participant primer (rust)

New template in `src/bootstrap.rs`, wrapped the same way as today
(`<hcom_system_context>…</hcom_system_context>`).

Contains:

- `[HCOM SESSION]`
- `Your name: {display_name}`
- Authority: prioritize @{SENDER}
- inbound: request always, inform if useful, ack never
- inbound `<hcom>` is mail, not a user task
- outbound: `send_to_actor`; never CLI `hcom send`
- wait: end the turn to receive; do not `sleep`; do not
  `hcom listen` for inbound hcom
- launched-omp `DELIVERY_AUTO` wait rules (same semantic as today,
  without `hcom listen` as the inbound wait)
- tag notice if tagged
- relay notice if relay enabled
- notes if present

Does **not** contain:

- `You MUST use hcom <cmd+flags> --name`
- capabilities table (send/list/transcript/events/spawn/`r`/`f`/kill/term/relay)
- `UVX_CMD_NOTICE`
- `\bhcom\b` rewrite of a CLI catalog
- spawn/kill/`hcom r` recipes

`customType` stays `"hcom-bootstrap"`. `[hcom:<name>]` marker
support unchanged. Subagent bootstrap stays CLI-shaped.

## How rust exposes both texts

`omp-start` JSON gains `bootstrap_participant` alongside existing
`bootstrap` (full UNIVERSAL). Plugin picks at inject time.

Rust does not know about actor-bridge. `get_bootstrap` stays the
full catalog. New `get_participant_bootstrap(...)` renders the
participant template. `handle_start` returns both strings.

Existing `get_bootstrap` tests stay. New rust tests pin
participant text: has identity + inbound + `send_to_actor`;
does not have `You MUST use` / `hcom send @` / spawn catalog.

## Plugin inject

`bindIdentity` stores both `bootstrapText` (full) and
`bootstrapParticipantText`. `before_agent_start` chooses:

```
hasSendToActor ? participant : full
```

Log which shape was injected (`plugin.hidden_bootstrap` gains
`shape: "participant" | "full"`).

If `bootstrap_participant` is absent (old binary), fall back to
full. Never invent participant text in TS.

## Unchanged

- claude/pi/agy/cursor/copilot/opencode bootstraps
- omp without actor tools
- delivery-lane injection besides which bootstrap string
- `skill://hcom` (not this repo)
- worlds queued-flag / discover_actors / coordination.lead

## Acceptance (quoted from Brief)

- omp process with `send_to_actor` in the model-visible tool
  surface injects participant primer; injected text does not
  contain `You MUST use` + `hcom <cmd+flags> --name` or a
  send/list/spawn CLI catalog.
- same process still contains identity, inbound intent rules, and
  end-turn wait rules.
- omp process without `send_to_actor` still gets full UNIVERSAL
  (including uvx rewrite when `hcom_cmd != "hcom"`).
- claude/pi/agy bootstrap unchanged.
- `customType` remains `"hcom-bootstrap"`.
- existing plugin bootstrap tests keep the ownership marker;
  new tests pin participant vs full selection.
- no write to `/home/sf/worlds` main.
