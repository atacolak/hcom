# ATA Convergence Wave (HCOM transport) Technical Spec

**Design Brief:** `/home/sf/worlds/personal/designs/hcom/convergence-wave-mail-loss.md`
**Status:** sound
**Repo:** `/home/sf/workspace/hcom`
**Epic:** `hcom-rfy` (children `hcom-rfy.1`, `hcom-rfy.2`, `hcom-rfy.3`)

## Intent (from the Brief — do not rewrite)

Quoted, not paraphrased.

**Invariant (§1):**

> HCOM must not advance consumption/ack state beyond a message that is not
> durably present in a recipient transcript/turn that can consume it.

**Mechanism (§1):** `src/omp_plugin/hcom.ts:752`

> `if (pendingAck !== null) await ackPending("agent_start");`
>
> No check that the injected prompt is on disk. A follow-up whose run starts
> before `message_end` writes the user line advances `last_event_id` past mail
> the transcript never kept. A recycle then cannot re-fetch it.

**Settle site (§1):**

> `turn_end` currently only calls `deliverPending`. It is the settle site the six
> tests expect. Gate follow-up acks on transcript evidence; keep
> steer/immediate-consumption acks as they are (the message IS the turn).

**The six assertions ARE acceptance (§Preserve, §1):**

> Do not weaken or edit the six Worlds assertions in
> `worlds/base/extensions/hcom.test.ts`. They are the acceptance criteria. Port
> them into `src/omp_plugin/hcom.test.ts` (HCOM is canonical) without relaxing a
> single `expect()`.

> The existing "acks only when its run starts" test was also tightened to persist
> before the draining `agent_start`. Port that tightening too; do not keep the
> old ack-on-naked-`agent_start` pin in HCOM's suite.

**Abort-acks (§1):**

> Do not close it as a side effect of a story. After the gate lands, prove the
> abort path: unpersisted + dropped follow-up stays unread (duplicate-on-recycle
> is the acceptable failure). If the persist gate does not cover abort, leave
> abort-acks open with the remaining gap named.

**Remove public `auto` (§1b):**

> - Drop `auto` from the public CLI (`hcom send --delivery` accepts `steer|queue` only).
> - Legacy rows / omitted `--delivery`: fail-closed default is `queue`, not steer.
>   Do not keep a third public lane.
> - Plugin `laneOf` / `decideInjection` / `LANE_RANK` lose `auto`. Absent/unknown
>   lane degrades to `queue` (hold at idle, followUp when active). Never infer
>   steer from request+busy.
> - Worlds `send_to_actor` default remap is midi's. HCOM just stops advertising
>   and accepting `auto`.

> Do not silently keep `auto` as an undocumented alias.

**Receipt (§2):**

> `accepted`/`persisted` = HCOM stored the event (have this the instant
> `log_event` returns; `_event_id` is currently discarded at `send.rs:464`).

> Preferred boring shape: `hcom send --json` prints one object with `event_id`,
> `accepted_at`, `delivered_to`, `delivery`, `from`. Keep the human line as
> default. Do not wait for injection.

**Handshake / lifecycle (§3, §4):**

> No new work registry in HCOM. HCOM carries provenance and receipts only
> (`event_id`, `--thread`, `--reply-to`, `--intent`).

> Keep HCOM internal `active`/`listening`. They drive delivery.

**Preserve (§Preserve):** unread/rebind survival (rebind drops `pendingAck`
rather than acking mail the old session lost); "prefer duplicate delivery over
silent loss if a crash lands in the persist-before-ack window";
`customType: "hcom-bootstrap"`; `[hcom:<name>]` markers; soft-stop / kill /
discard semantics unchanged; do not write `/home/sf/worlds`; do not
`install_omp_plugin` / `uv tool install` this hop.

## Mapping onto the current system

Every claim below is labeled **observed** (read or executed), **inferred**, or
**unknown**.

**observed** — The plugin is byte-identical in three places, so the Worlds test
file is a new harness written against unfixed code, not a fix HCOM is behind on:

```
688c3b9c80abefe0d2636f30e70667cf  src/omp_plugin/hcom.ts
688c3b9c80abefe0d2636f30e70667cf  /home/sf/worlds/base/extensions/hcom.ts
688c3b9c80abefe0d2636f30e70667cf  /home/sf/.omp/agent/extensions/hcom.ts
```

**observed** — Baselines, run 2026-09-16:

- `bun test src/omp_plugin/hcom.test.ts` → 31 pass, 0 fail.
- `bun test /home/sf/worlds/base/extensions/hcom.test.ts` → **7 pass, 6 fail**.
  The six failures are exactly the six Brief assertions.
- The Worlds suite runs standalone: copy `src/omp_plugin/hcom.ts` and
  `/home/sf/worlds/base/extensions/hcom.test.ts` into one temp dir and run
  `bun test hcom.test.ts` → the same 7/6 split with no `node_modules` present
  (the plugin's SDK import is `import type`, erased at runtime). This gives an
  unfakeable cross-check for the port (see Testing).
- `md5sum /home/sf/worlds/base/extensions/hcom.test.ts` →
  `c7c904c74a447e6df5dcb98c3bd0553d` (baseline for "Worlds file untouched").

**observed** — ack seams in `src/omp_plugin/hcom.ts`:

| Site | Line | Today |
|---|---|---|
| `deliverPending` immediate ack | 492 | `if (plan.deliverAs !== "followUp") await ackPending("delivery")` |
| `agent_start` | 752 | `if (pendingAck !== null) await ackPending("agent_start")` — the defect |
| `input` (`source === "extension"`) | 761 | `await ackPending("extension")` |
| `before_agent_start` | 790 | `if (pendingAck !== null) await ackPending("before_agent_start")` |
| `turn_end` | 842-845 | `deliverPending` only — no ack path at all |
| `reconcile` | 616-621 | documented "no ack here" |
| `resetBinding` | 650 | drops `pendingAck` (the Brief's rebind-survival property) |

**observed** — `PendingAck` is `{ ids: number[]; maxId: number }` (159-163). It
tracks *which* ids to name, never *whether they were consumed*. Injected text is
formed by `formatMessagesForInjection` (74-87) as
`<hcom>[intent #id] from -> to: body</hcom>` or
`<hcom>[N new messages] | part | part</hcom>`; the per-message `part` is a
substring of both shapes.

**observed** — the transcript is reachable: `ctx.sessionManager.getSessionFile()`
(used at 337/375), and bind already refuses a session with no file
(`ensureSessionDurable`, 327-345). The Worlds harness writes the OMP
`message_end` shape the gate must read —
`{"type":"message","message":{"role":"user","content":[{"type":"text","text":…}]}}`
— one JSON object per line.

**observed** — lane vocabulary today:

| Layer | File:line | `auto` today |
|---|---|---|
| CLI | `src/commands/send.rs:96` | `value_parser = ["auto","steer","queue"]` |
| Enum | `src/messages.rs:74-107` | `Auto` variant, `#[default] Auto`, `FromStr` accepts `"auto"` |
| Envelope gate | `src/commands/send.rs:1104` | `envelope.delivery != DeliveryLane::Auto` |
| Read side | `src/db/events.rs:196-200` | absent lane → `.unwrap_or("auto")` |
| Human prefix | `src/messages.rs:564-573` | shows the lane unless it is `"auto"` |
| OMP plugin | `src/omp_plugin/hcom.ts:104-141` | `LANE_RANK` `auto: 2`; absent/unknown → `auto`; `auto` + demanding intent → steer |
| Pi plugin | `src/pi_plugin/hcom.ts:85-121` | identical lane block |
| Docs | `README.md:16-22`, `src/commands/help.rs:238-239` | advertises `auto` as the default |

**observed** — `send.rs:464` is `let _event_id = db.log_event(...)`. The id is
used locally for `create_request_watches` (483) and then dropped; `send_message`
returns `Result<Vec<String>, String>` (delivered base names). `rg` finds no
production caller outside `cmd_send`: the two out-of-file callers
(`src/hooks/common.rs:2950`, `src/hooks/omp/handlers.rs:815`) are inside
`#[cfg(test)]` blocks, plus ~10 in-file test callsites. `log_event_with_ts`
(`src/db/events.rs:480`) is `pub` and accepts the timestamp, so a receipt can
carry the exact stored `events.timestamp` with no second query.
`crate::shared::time::now_iso()` is `pub` and formats
`%Y-%m-%dT%H:%M:%S%.6f+00:00`.

**observed** — `--json` is already a repo-wide convention (`status --json`,
`list --json`, `config --json`), and the router already suppresses the
pre-dispatch unread dump when any `--json` is present (`src/router.rs:792` →
`src/cli_context.rs:199-206`, which returns `None` and therefore does **not**
advance the sender's cursor).

**inferred** — a `followUp` injection reaches the transcript as a user message
whose text contains the injected string (possibly wrapped by OMP). The gate
therefore tests *containment of each per-message part*, not equality of the whole
prompt: wrapping stays satisfiable, and a partially persisted combined batch
stays unsatisfied.

**unknown** — whether OMP ever rewrites a queued follow-up's text beyond
wrapping. If it did, the gate would hold and the mail would be re-delivered after
a recycle — a duplicate, which is the Brief's explicitly accepted failure
direction.

### Contradiction check (Brief vs reality)

1. **No product-shaped gap for §1.** The transcript file, the settle site
   (`turn_end`), and the batch tracker all already exist. The gate is additive.
2. **§1b vs two Worlds fixtures (not assertions).** The Worlds file's
   `injects an idle batch as one combined turn and acks its exact event ids` and
   `steers a demanding batch into the live run and acks it immediately` use mail
   with **no** `delivery` key and depend on today's absent → `auto` → steer
   inference. §1b forbids that inference, so after §1b those two *inputs* no
   longer describe a steer. Their `expect()`s are untouched by this repo; HCOM's
   ported copies carry an explicit `delivery: "steer"` fixture.
3. **§1b vs one of the six (fixture only).** `keeps a queued follow-up's markers
   when a later batch rides the same ack` sends
   `{intent:"request", event_id:902}` with no lane and expects
   `{deliverAs:"steer"}` (line 316). Under §1b an absent lane is `queue`, so the
   sender must say `delivery: "steer"` for that message. That is an **input
   fixture** change demanded by §1b itself ("Models must pick `steer` or
   `queue`"); no `expect()` is relaxed and the assertion's subject — a later
   batch riding the same ack must not settle the still-unpersisted follow-up — is
   preserved exactly. Sequencing keeps it honest: the six are ported **verbatim**
   in Task 1, where all 13 Worlds tests pass against the new plugin; only Task 3
   (§1b) touches that fixture.
4. **No product change needed for §2, §3 or §4.** The receipt is a read-out of
   state that already exists the instant `log_event` returns, and the handshake
   needs no new HCOM state.

Nothing here requires weakening a Brief invariant, so there is nothing to block on.

## Architecture

One new idea: a **persist gate** on the existing ack tracker.

`PendingAck` keeps its ids and gains a list of `PersistGate`s. A gate is recorded
only for an injection whose consumption is *deferred* — `deliverAs: "followUp"`.
Immediate-consumption injections (the idle `prompt()` path, a `steer` into a live
run, the bodyless-wake transform) record no gate, because for them the message
*is* the turn; the Brief says to leave those acks alone.

A gate is satisfied when every per-message marker it carries is found in a
**user** transcript entry written **after** the injection. A byte offset captured
at injection time is what makes "after" real: a same-text line already on disk is
not evidence.

Acks stop being unconditional. Every ack site calls `settlePendingAck(source)`,
which acks only when *all* gates on the tracker are satisfied; a tracker with no
gates settles immediately, exactly as today (so the rejected-ack retry and the
steer path keep their current behavior). `turn_end` becomes an ack site — the
settle boundary the six tests expect — and keeps its `deliverPending` call.

Because gates accumulate on the tracker, a later batch that rides the same ack
(the `injectedIds` union) cannot settle an earlier unpersisted follow-up. Because
`resetBinding` already drops `pendingAck`, rebind survival is unchanged. Because
an unsatisfiable gate never acks, an aborted or dropped follow-up stays unread and
is re-delivered after a recycle: duplicate delivery, which the Brief prefers over
silent loss.

`auto` disappears from the lane vocabulary in one pass across CLI → enum → read
side → both plugins → docs, with `queue` as the single fail-closed default. The
receipt is a new return shape on the send path plus a `--json` printer.

## Components and interfaces

### 1. `src/omp_plugin/hcom.ts` — persist gate (`hcom-rfy.1`)

```ts
/** One deferred injection whose transcript evidence is still owed. */
type PersistGate = {
	/** Transcript path captured at injection; `null` can never be satisfied. */
	path: string | null;
	/** Byte size of the transcript at injection: evidence must be newer. */
	offset: number;
	/** One per-message marker; every one must appear post-offset. */
	markers: string[];
};

type PendingAck = {
	ids: number[];
	maxId: number;
	/** Empty = immediate consumption, settles like today. */
	gates: PersistGate[];
};

/** The per-message text `formatMessagesForInjection` embeds; the gate marker. */
function messagePart(message: PendingMessage, recipientName: string): string;

/** Post-offset user-message text from a transcript; `[]` when unreadable. */
function persistedUserTexts(gate: PersistGate): string[];

/** Every marker of every gate found post-offset. No gates = true. */
function gatesSatisfied(batch: PendingAck): boolean;

/** Ack only when the gates allow it. Replaces every naked `ackPending` call. */
async function settlePendingAck(source: string): Promise<boolean>;
```

- `messagePart` is extracted from `formatMessagesForInjection`, which keeps its
  current output byte-for-byte (it maps over `messagePart`).
- `persistedUserTexts` reads the file as a `Buffer`, takes `subarray(offset)`,
  splits on newlines, `JSON.parse`s each line (skipping unparseable ones), keeps
  entries whose `message.role === "user"`, and collects their text parts
  (`content` as an array of `{type:"text",text}` or as a plain string). Parsing —
  not raw-substring search — is what makes the escaped-text assertion pass.
- Offset capture: `statSync(path).size`, or `0` when the file does not exist yet.
- `LANE_RANK` / `decideInjection` are untouched by this component.

Call-site changes (all of them):

| Site | Was | Becomes |
|---|---|---|
| `deliverPending` 492 | `if (plan.deliverAs !== "followUp") await ackPending("delivery")` | record a gate when `plan.deliverAs === "followUp"`, then `await settlePendingAck("delivery")` |
| `agent_start` 752 | `if (pendingAck !== null) await ackPending("agent_start")` | `await settlePendingAck("agent_start")` |
| `input` extension 761 | `await ackPending("extension")` | `await settlePendingAck("extension")` |
| `before_agent_start` 790 | `if (pendingAck !== null) await ackPending("before_agent_start")` | `await settlePendingAck("before_agent_start")` |
| `turn_end` 842 | `await deliverPending(ctx)` | `await settlePendingAck("turn_end"); await deliverPending(ctx)` |

`ackPending` itself is unchanged: exit codes, rejection handling (`exit 0` plus an
`error` field), generation/instance guards, `drainPendingDelivery`.

### 2. Lane vocabulary loses `auto` (`hcom-rfy.2`)

TypeScript, both `src/omp_plugin/hcom.ts:104-141` and `src/pi_plugin/hcom.ts:85-121`:

```ts
export type DeliveryLane = "steer" | "queue";
const LANE_RANK: Record<DeliveryLane, number> = { queue: 1, steer: 2 };

function laneOf(message: PendingMessage): DeliveryLane {
	// Absent (legacy row), "auto", or any unknown value degrades to "queue".
	return message.delivery === "steer" ? "steer" : "queue";
}

export function decideInjection(messages: PendingMessage[], isIdle: boolean): InjectionPlan {
	if (messages.length === 0) return "hold";
	let lane: DeliveryLane = "queue";
	for (const message of messages) {
		const candidate = laneOf(message);
		if (LANE_RANK[candidate] > LANE_RANK[lane]) lane = candidate;
	}
	if (isIdle) return lane === "queue" ? "hold" : {};
	return lane === "steer" ? { deliverAs: "steer" } : { deliverAs: "followUp" };
}
```

The `demanding` computation is deleted: intent no longer affects the lane, which
is precisely "never infer steer from request+busy".

Rust:

- `src/commands/send.rs:96` → `value_parser = ["steer", "queue"]`.
- `src/messages.rs:74-107` → drop the `Auto` variant, `#[default] Queue`,
  `FromStr` accepts `steer|queue` and errors
  `invalid delivery lane: {s} (expected steer|queue)`.
- `src/commands/send.rs:1104` → `envelope.delivery != DeliveryLane::default()`
  (the recorded data is identical either way; `send_message` already defaults an
  absent envelope's lane).
- `src/db/events.rs:196-200` → the single read-side normalization point:
  `Some("steer")` stays `"steer"`, everything else (absent, `"auto"`, unknown)
  becomes `"queue"`. The plugin's `laneOf` keeps its own degrade as defense in
  depth.
- `src/messages.rs:564-573` → surface only the non-default lane:
  `.filter(|d| *d == "steer")`.

### 3. `hcom send --json` persist-time receipt (`hcom-rfy.3`)

```rust
/// What HCOM knows the instant the event is durable. Not consumption.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SendReceipt {
    pub event_id: i64,
    /// Exactly the `events.timestamp` of the logged row.
    pub accepted_at: String,
    pub delivered_to: Vec<String>,
    /// Recorded lane: "steer" | "queue".
    pub delivery: String,
    pub from: String,
}

pub fn send_message_with_receipt(
    db: &HcomDb,
    identity: &SenderIdentity,
    message: &str,
    envelope: Option<&MessageEnvelope>,
    explicit_targets: Option<&[String]>,
) -> Result<SendReceipt, String>;

/// Unchanged signature for every existing caller.
pub fn send_message(/* same args */) -> Result<Vec<String>, String>;
```

`send_message_with_receipt` is today's `send_message` body with two edits:
`let accepted_at = crate::shared::time::now_iso();` and
`db.log_event_with_ts("message", &routing_instance, &data, Some(&accepted_at))`,
whose returned id becomes the receipt's `event_id` (the same binding
`create_request_watches` already consumes). `send_message` becomes a thin wrapper
that maps the receipt to `delivered_to`, so every existing caller and test
compiles untouched.

`SendArgs` gains `#[arg(long)] pub json: bool`. In `cmd_send`, immediately after a
successful send and before any human feedback, `--json` prints exactly one line of
serialized receipt, calls `crate::relay::worker::ensure_worker(true)`, and returns
`0`. That suppresses the feedback line, the unread dump (and therefore its cursor
advance — fail-closed toward unread), the trailing-`--name` hint, the adhoc
preview, and the intent tip. `--json` wins over `--quiet`. Errors keep today's
shape: human text on stderr, exit 1, no JSON object. Nothing on this path waits
for injection.

### 4. Handshake + lifecycle seam (spec-only; no code)

HCOM exposes identity and provenance only; Worlds owns the hop. See "Midi
contract" below. No registry, no WAITING promotion, no remote-bead table, and no
change to `active` / `listening`.

## Data / control flow

Follow-up, happy path (Worlds assertion 1):

1. `turn_end` → `settlePendingAck("turn_end")` (nothing tracked) → `deliverPending`.
2. `deliverPending` fetches `[#501]`; `decideInjection` → `{deliverAs:"followUp"}`.
3. Gate recorded: `path` = `getSessionFile()`, `offset` = current byte size,
   `markers` = the one per-message part string. `pendingAck` becomes
   `{ids:[501], maxId:501, gates:[gate]}`.
4. `sendUserMessage(text, {deliverAs:"followUp"})`, then
   `settlePendingAck("delivery")` → gate unsatisfied → **no ack**.
5. The draining run starts: `agent_start` → `settlePendingAck("agent_start")` →
   nothing post-offset → **no ack**. This is the defect closed.
6. OMP persists the prompt at `message_end`.
7. `turn_end` → `settlePendingAck("turn_end")` → marker found post-offset →
   `ackPending` → `omp-read --ack --ids 501`; `pendingAck = null`.

Variants:

- **Steer / idle prompt / bodyless wake:** no gate, so `settlePendingAck` behaves
  exactly like today's `ackPending`, including the rejected-ack retry.
- **Later batch rides the ack:** the new `PendingAck` inherits `prior.gates` and
  appends its own (none, for a steer). Ids union to `901,902`; the ack waits for
  901's evidence and then names both.
- **Combined batch:** one gate, two markers. Partial persist leaves marker two
  unfound → hold. Full persist → ack `701,702`.
- **Pre-existing same-text line:** below `offset`, so not evidence.
- **Crash / recycle before persist:** the process dies with the gate unsatisfied,
  HCOM never moved the cursor, and the new process re-fetches and re-injects
  `#62951`.
- **Abort (Esc, which drops the queued follow-up):** the plugin never observes the
  drop, but the gate is never satisfied either, so the cursor never advances and
  the message stays unread. Re-delivery on the next wake or recycle is a
  duplicate, not a loss.

Send receipt flow: validate → `resolve_delivery` → build data → `now_iso()` →
`log_event_with_ts` (durable here) → request watches / thread membership →
`wake_all` → `trigger_push` → receipt returned → `--json` line printed. No step
waits for a recipient.

## Error handling

- Unreadable or missing transcript, `statSync`/`readFileSync` throwing,
  unparseable JSONL lines, `path: null`: all treated as **no evidence**. The
  tracker stays, no ack, mail stays unread. Every failure mode of the gate is a
  duplicate-delivery risk, never a loss risk.
- Ack rejection (exit 0 plus an `error` field) and non-zero exit: unchanged — the
  batch stays tracked and a later settle retries it.
- Rebind (`session_switch` / `session_branch` / `resetBinding`): `pendingAck`, and
  with it every gate, is dropped; unread mail is re-fetched.
- `--json` serialization failure: human error on stderr, exit 1 (unreachable in
  practice; the receipt is plain data).
- `--delivery auto` after this wave: clap rejects it with the value-parser error
  naming `steer|queue`. Intentionally loud, not an alias.
- Legacy event rows holding an `auto` lane string still read and render; they
  normalize to `queue`.

## Testing (behavioral contracts; exact tests live in the plan)

Acceptance strings, verbatim from `worlds/base/extensions/hcom.test.ts`, which
must appear as test names in `src/omp_plugin/hcom.test.ts`:

1. `settles a held follow-up ack at the turn boundary that persisted it`
2. `keeps a queued follow-up's markers when a later batch rides the same ack`
3. `keeps an unpersisted follow-up unread so a recycle re-fetches it`
4. `acks a follow-up whose persisted text the transcript had to escape`
5. `holds a combined follow-up batch until every message in it is persisted`
6. `does not accept a transcript entry that predates the injection`

Plus the ported tightening of
`queues a non-demanding active batch as a follow-up and acks only when its run starts`
(persist before the draining `agent_start`), and the removal of HCOM's old
ack-on-naked-`agent_start` pin.

Contracts:

- **Cross-check (anti-gameable):** the untouched Worlds file, copied beside the new
  plugin into a temp dir, must go from 7 pass / 6 fail to **13 pass / 0 fail** at
  the Task-1 commit. `md5sum /home/sf/worlds/base/extensions/hcom.test.ts` must
  still be `c7c904c74a447e6df5dcb98c3bd0553d` and the worlds plugin must still be
  `688c3b9c80abefe0d2636f30e70667cf` (proves no Worlds edits and no install).
- **Abort proof:** a follow-up injected, never persisted and never drained leaves
  `omp-read --ack` uncalled and the mailbox non-empty across `agent_start` +
  `turn_end` + `session_shutdown`.
- **Lane contracts:** absent / `auto` / unknown lane holds at idle and injects as
  `followUp` when active; `steer` starts an idle turn and interrupts a live one; a
  mixed batch takes `steer`; intent never changes the lane. The CLI rejects
  `--delivery auto`; an omitted `--delivery` records `queue`; a legacy row with no
  lane reads as `queue`; only `steer` is surfaced in the human prefix.
- **Receipt contracts:** `hcom send --json` prints exactly one JSON object with
  `event_id`, `accepted_at`, `delivered_to`, `delivery`, `from`; `event_id` and
  `accepted_at` equal the `events` row's `id` and `timestamp`; the same send
  without `--json` produces the same human output as today.

## Non-goals

- Worlds `send_to_actor` / `messaging.ts` implementation or default remap.
- Editing `worlds/base/extensions/hcom.test.ts` or any file under `/home/sf/worlds`.
- Installing the plugin into the live worlds inode (`install_omp_plugin`,
  `uv tool install`).
- A work registry, remote-bead table, or handshake state machine in HCOM.
- Closing `hcom-hcom-fork-sprint-5kk`, or inventing `5kk.9` / `fu2` / `5kk.17` fixes.
- A persist gate in `src/pi_plugin/hcom.ts` (Item 1 is the OMP plugin; the Pi
  plugin takes the lane change only).
- `retired` identity / name reuse (Brief §4: design or proof only if time allows).
- Bouncing midi / kilo / reko / hera; removing leftover panes.
- The latency dogfood (Brief §2 assigns it to the lead, "not a builder task").

## Implementation approach chosen (and rejected internals)

All candidates below satisfy the Brief; they differ only in internals.

**Chosen: byte-offset + per-message marker gate on `PendingAck`.** Evidence is "a
user transcript entry, parsed, written after this injection, containing this
message's part string". The offset gives the predates-the-injection property;
parsing gives the escaped-text property; per-message markers give the
partial-combined-batch property; hanging gates on the existing tracker gives the
later-batch-rides-the-ack property for free and leaves rebind survival untouched.

Rejected internals:

- **Whole-prompt equality instead of per-message containment.** Breaks the
  partial-persist assertion (the partial line is not the whole prompt) and is
  brittle if OMP wraps the follow-up text.
- **Raw substring search over the file region.** Cheaper, but the escaped-text
  assertion fails because the stored bytes escape quotes and newlines.
- **An id-only marker such as `#701`.** Survives escaping, but any later text
  containing that id would falsely satisfy the gate — and a false positive is mail
  loss, the exact failure this wave closes.
- **Line/entry counting instead of a byte offset.** Equivalent when appends are
  whole lines, but it forces a full-file parse on every settle: the same guarantee
  for more work.
- **Acking on a `message_end` / transcript-watch event instead of at `turn_end`.**
  The Brief names `turn_end` as the settle site and the tests poll it; a watcher
  adds a second timing source and a file-watch dependency. YAGNI.
- **Also settling in `reconcile`.** `turn_end` and `agent_start` already cover
  every drain path, and the existing "reconciling is not consumption" comment
  stays true. YAGNI.
- **Keeping `auto` as a silent alias mapped to `queue`.** Forbidden by the Brief.
- **Normalizing the lane only inside the plugin, leaving `auto` on the `omp-read`
  wire.** Keeps `auto` in the vocabulary HCOM advertises.
- **Changing `send_message`'s signature in place.** Would churn ~12 callsites for
  no behavior gain; `_with_receipt` plus a thin wrapper keeps every caller
  compiling.
- **Human prefix showing `queue`.** `build_message_prefix` surfaces *deviation
  from the default lane*; once `queue` is the default, keeping the literal
  not-equal-`auto` filter would stamp a `queue` word on every default and legacy
  message. Chosen instead: surface `steer` only — the existing rule unchanged in
  spirit, and today's default rendering preserved. Consequence in Risks 1.

## Risks

1. **Explicit `queue` sends lose their `queue` prefix word** in the human and
   `--format` paths, because `queue` is now the default lane and the prefix
   surfaces only non-default lanes. Nothing in the Brief asks for that marker; if
   Ata wants `queue` surfaced, it is a one-line follow-up, not a redesign.
2. **After §1b the untouched Worlds test file will show 2 failures against the new
   plugin bytes** — `injects an idle batch as one combined turn and acks its exact
   event ids` and `steers a demanding batch into the live run and acks it
   immediately` — because their fixtures omit `delivery` and rely on the
   `auto`-steer inference §1b deletes. HCOM's ported copies carry
   `delivery: "steer"`. The lead must hand this to midi with the SHA; it is a
   Worlds-side fixture reconciliation, not a weakened assertion. Task 1's 13/13
   cross-check pins the pre-§1b state so the divergence is attributable to §1b
   alone.
3. **A follow-up OMP never persists wedges the cursor** (no ack, re-delivery on
   every later wake until a recycle). That is the Brief's chosen direction
   (duplicate over loss), but it means a future OMP change to follow-up
   persistence would surface as repeated re-injection rather than as silence.
4. **`hcom-abort-acks-unconsumed-followup-mlj` is covered at the ack-gate level,
   not at the abort-signal level.** The plugin cannot observe the interrupt-time
   queue clear, so the proof asserts "unpersisted + never-drained follow-up stays
   unread", not "the plugin saw the abort". Leave the bead open with that gap
   named until the Esc path is dogfooded in a live pane. Do not close it.
5. **The Pi plugin keeps no persist gate**, so a Pi-hosted actor retains the §1
   hole. Out of scope here (Brief §1 names the OMP plugin and its test file);
   worth a follow-up bead if Pi actors carry real mail.

## Open questions

None. Every choice above is either quoted from the Brief or an internals-only pick
recorded in "Implementation approach chosen". The two operator-visible
consequences (Risks 1 and 2) follow directly from decisions the Brief already
made — `queue` is the default, `auto` is gone — so they are reported, not asked.

## Midi contract (Brief §2, §3, §4 — written contract, no Worlds edits)

**Delivery truth (§2).** `deliverHcom` (`base/lib/actors/messaging.ts:143-155`)
must stop reading `hcom send` exit 0 as `delivered: true`. HCOM's truth ladder:

| Stage | Meaning | Where Worlds gets it |
|---|---|---|
| `accepted` / `persisted` | HCOM stored the event | `hcom send --json` → `event_id`, `accepted_at` (this spec) |
| `injected` | the recipient plugin injected it | observe only; `hcom send` never waits for it |
| `consumed` / `acked` | durable transcript evidence | HCOM's cursor, advanced only through the Item-1 gate |

Suggested remap: `accepted: true` from the receipt, with `delivered` reserved for
`injected` / `acked` evidence. `hcom send` without `--json` is unchanged, so
nothing breaks before Worlds opts in.

**Handshake provenance (§3).** HCOM carries identity only: `event_id` (from the
receipt), `--thread`, `--reply-to`, `--intent`. The origin-bead → request/thread →
recipient ACK → origin WAITING → recipient DONE → origin verifies hop is
Worlds-owned; HCOM adds no registry, no WAITING state, and no remote-bead
adoption.

**Lifecycle (§4).** HCOM keeps internal `active` / `listening` because they drive
delivery. Any `lifecycle=alive` plus working/idle projection belongs to
`discover_actors` / `actor_status`. `retired` identity or name reuse must not be
faked with `discard` (provisional-only) or destructive `kill`; historical identity
and transcripts survive.

**Plugin bytes.** Item 1 lands in `atacolak/hcom` only. The installed inode
(`~/.omp/agent/extensions/hcom.ts`, which is `worlds/base/extensions/hcom.ts`) is
midi's to update; this wave does not touch it. Ping midi with the SHA plus Risk 2.
