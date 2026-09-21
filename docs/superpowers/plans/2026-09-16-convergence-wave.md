# ATA Convergence Wave (HCOM transport) Implementation Plan

**Technical Spec:** `docs/superpowers/specs/2026-09-16-convergence-wave.md`
**Design Brief:** `/home/sf/worlds/personal/designs/hcom/convergence-wave-mail-loss.md` (via spec; do not bypass)

> **For the project lead:** first `br where` in this repo. no board → `br init --prefix <xx>` here (never `~/.beads`). then one campaign parent bead for this plan, then task-by-task with isolated `builder` workers. Do not implement these tasks inline. Persist progress in this file's checkboxes **and** as one parent-child bead per Task (`br create --parent --body`). Title `tN: <ask>` (prefix `[done] ` after verifier pass). Description markdown, ≤800 characters, wrap at ~60 cols: `Asked:` paragraph, then `## Landed` with sha/tests/leftover (`not yet` while in flight). Do not paste this plan packet. After pass, keep the child `in_progress` (mgr Rolling), assignee cleared — do not defer, do not `br close` until the parent parks (closed = Past the Stand). Lined Up is only for minted-not-yet-claimed children.
>
> Board note: `hcom-rfy` already exists with children `hcom-rfy.1` (Task 1 + Task 2), `hcom-rfy.2` (Task 3 + Task 4 + the lane half of Task 6), `hcom-rfy.3` (Task 5 + the receipt half of Task 6). Use those instead of minting new children.

**Goal:** HCOM stops advancing its read cursor past mail no transcript kept, stops
accepting the `auto` delivery lane, and returns a truthful persist-time receipt.

**Architecture:** A `PersistGate` (transcript path + byte offset + per-message
markers) hangs on the existing `PendingAck` tracker in `src/omp_plugin/hcom.ts`;
every ack site becomes `settlePendingAck`, which acks only when every gate's
markers appear in a user transcript entry written after the injection, and
`turn_end` becomes the settle boundary. The delivery lane vocabulary collapses to
`steer | queue` with `queue` as the fail-closed default across CLI, enum, read
side and both plugins. `hcom send --json` prints one receipt object built from the
event id and timestamp that `log_event_with_ts` already produces.

**Tech stack:** what the repo already uses — Rust 2024 + clap + rusqlite +
`serial_test` for the CLI/DB, TypeScript plugins tested with `bun test`, `just`
wrapping `cargo test --locked`.

**Repo notes for every builder:**

- Repo root: `/home/sf/workspace/hcom`. Never edit anything under `/home/sf/worlds`
  and never run `install_omp_plugin` or `uv tool install`: the installed plugin
  inode belongs to another agent's dirty tree.
- The working tree already has unrelated uncommitted changes in
  `src/cli_context.rs`, `src/commands/discard.rs`, `src/launcher.rs`,
  `src/messages.rs` (a rustfmt reflow inside `mod tests`) and
  `tests/support/real_tool.rs`. Leave them alone; `git add` only the files your
  task names.
- Rust tests run with `just test <cargo args>` (that is `cargo test --locked` with
  the CI TMPDIR). Plugin tests run with `bun test <file>`.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/omp_plugin/hcom.ts` | OMP delivery/ack plugin: gains the persist gate, loses the `auto` lane | 1, 3 |
| `src/omp_plugin/hcom.test.ts` | OMP plugin suite: gains a real transcript harness + the seven ported tests + the abort proof; lane fixtures become explicit | 1, 2, 3 |
| `src/pi_plugin/hcom.ts` | Pi delivery plugin: loses the `auto` lane only (no persist gate — spec non-goal) | 3 |
| `src/pi_plugin/hcom.test.ts` | Pi plugin suite: lane tests and fixtures | 3 |
| `src/messages.rs` | `DeliveryLane` enum, `FromStr`, `build_message_prefix` | 4 |
| `src/db/events.rs` | `get_unread_messages` read-side lane normalization | 4 |
| `src/hooks/omp/handlers.rs` | `omp-read` lane round-trip tests | 4 |
| `src/commands/send.rs` | `--delivery` value parser, `--json` flag, `SendReceipt`, `send_message_with_receipt`, `cmd_send` output | 4, 5 |
| `tests/cli_smoke.rs` | end-to-end `hcom send --json` receipt shape | 5 |
| `README.md`, `src/commands/help.rs` | documented lane vocabulary and the receipt flag | 6 |

---

## Task 1: Persist-before-ack gate + the six ported assertions

**Owner:** builder
**Bead:** `hcom-rfy.1`
**Files:**
- Modify: `src/omp_plugin/hcom.ts` (imports at 2; `formatMessagesForInjection` 74-87; `PendingAck` 158-163; `deliverPending` 475-492; `ackPending` neighbourhood 525-580; handlers 743-753, 756-762, 780-791, 842-845)
- Test: `src/omp_plugin/hcom.test.ts` (harness 1-13 and 77-94; existing tests at 250-264, 278-288, 324-345; new describe block appended)
- Read-only source of truth: `/home/sf/worlds/base/extensions/hcom.test.ts` (never edit)

**Context a builder needs (do not skip):** `src/omp_plugin/hcom.ts:752` acks a
tracked batch the moment a run starts, with no check that the injected prompt is
on disk. A follow-up whose run starts before OMP writes the user line advances
HCOM's `last_event_id` past mail the transcript never kept, so a recycle cannot
re-fetch it. The invariant to establish: *HCOM must not advance consumption/ack
state beyond a message that is not durably present in a recipient transcript/turn
that can consume it.* Steer, idle-prompt and bodyless-wake injections keep acking
immediately — for those the message IS the turn. Only a `deliverAs: "followUp"`
injection owes transcript evidence.

**Verification (anti-gameable):** with the plugin changed, copy the **untouched**
Worlds test file next to the new plugin in a temp dir and run it; it must go from
today's 7 pass / 6 fail to 13 pass / 0 fail, and the Worlds files must still hash
to their recorded baselines:

```bash
cd /home/sf/workspace/hcom
T=$(mktemp -d) && cp src/omp_plugin/hcom.ts "$T/hcom.ts" \
  && cp /home/sf/worlds/base/extensions/hcom.test.ts "$T/hcom.test.ts" \
  && (cd "$T" && HCOM_DIR=$(mktemp -d) bun test hcom.test.ts)
md5sum /home/sf/worlds/base/extensions/hcom.test.ts /home/sf/worlds/base/extensions/hcom.ts
# expected: 13 pass, 0 fail
# expected: c7c904c74a447e6df5dcb98c3bd0553d  .../hcom.test.ts
# expected: 688c3b9c80abefe0d2636f30e70667cf  .../hcom.ts
```

- [x] **Step 1: Give the existing test harness a real transcript file**

In `src/omp_plugin/hcom.test.ts`, change the `node:fs` import (line 11) from
`import { mkdtempSync } from "node:fs";` to:

```ts
import { appendFileSync, mkdtempSync } from "node:fs";
```

Immediately after the `function message(...)` helper (ends line 144), add:

```ts
// The plugin proves an injected follow-up reached the transcript before it lets
// the HCOM cursor move past it, so every test needs a real session file.
const SESSION_DIR = mkdtempSync(join(tmpdir(), "hcom-plugin-session-"));
let sessionSeq = 0;
let sessionFile = join(SESSION_DIR, "sid-0.jsonl");

/** Append a persisted user message, the shape OMP writes on `message_end`. */
function persistUserMessage(text: string): void {
	appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		})}\n`,
	);
}
```

In `fakeCtx` (line 78), replace:

```ts
	const sessionFile = options.sessionFile === undefined ? "/tmp/sid-1.jsonl" : options.sessionFile;
```

with:

```ts
	const file = options.sessionFile === undefined ? sessionFile : options.sessionFile;
```

and replace the `getSessionFile` line inside `manager` (line 81) with:

```ts
		getSessionFile: () => file,
```

In the module-level `beforeEach` (line 164-167), add a fresh transcript per test
as the first statement:

```ts
	sessionSeq += 1;
	sessionFile = join(SESSION_DIR, `sid-${sessionSeq}.jsonl`);
```

- [x] **Step 2: Port worlds `hcom.test.ts:175-358` verbatim**

Append one new `describe` block at the end of `src/omp_plugin/hcom.test.ts`. Its
helpers are deliberately local copies of the Worlds harness so the seven test
bodies can be pasted byte-for-byte with no adaptation. Paste this frame first:

```ts
/**
 * Ported verbatim from worlds/base/extensions/hcom.test.ts:175-358 — those
 * assertions are the acceptance criteria for persist-before-ack and must not be
 * weakened. The Worlds harness is copied in with them so the bodies need no
 * adaptation; that file itself is read-only for this repo.
 */
describe("persist-before-ack (ported from worlds/base/extensions/hcom.test.ts)", () => {
	type HcomCall = { args: string[] };

	function fakePi() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
		return {
			handlers,
			sent,
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers.set(event, handler);
			},
			async sendUserMessage(text: string, options?: Record<string, unknown>) {
				sent.push({ text, options });
			},
		};
	}

	function fakeCtx(idle: { value: boolean }) {
		return {
			cwd: "/repo",
			isIdle: () => idle.value,
			sessionManager: {
				getSessionId: () => "sid-1",
				getSessionFile: () => portedSessionFile,
				ensureOnDisk: async () => {},
			},
		};
	}

	function persistUserMessage(text: string): void {
		appendFileSync(
			portedSessionFile,
			`${JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
			})}\n`,
		);
	}

	function fakeRunHcom(calls: HcomCall[], mailbox: { messages: unknown[] }) {
		return async (args: string[]) => {
			calls.push({ args });
			if (args[0] === "omp-start") {
				return { code: 0, stdout: JSON.stringify({ name: "test", session_id: "sid-1" }), stderr: "" };
			}
			if (args[0] === "omp-read" && args.includes("--ack")) {
				mailbox.messages = [];
				return { code: 0, stdout: JSON.stringify({ acked_to: 102 }), stderr: "" };
			}
			if (args[0] === "omp-read") {
				return { code: 0, stdout: JSON.stringify(mailbox.messages), stderr: "" };
			}
			if (args[0] === "omp-status" || args[0] === "omp-stop") {
				return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
			}
			if (args[0] === "omp-beforetool") {
				return { code: 0, stdout: JSON.stringify({ decision: "allow" }), stderr: "" };
			}
			return { code: 1, stdout: "", stderr: `unexpected hcom ${args.join(" ")}` };
		};
	}

	function resetIdentity() {
		(globalThis as Record<symbol, unknown>)[Symbol.for("hcom.omp.identity")] = {
			owner: null,
			tearingDown: false,
		};
		delete process.env.HCOM_OMP_IDENTITY_OWNER;
	}

	let portedSessionDir: string;
	let portedSessionFile: string;

	beforeEach(() => {
		portedSessionDir = mkdtempSync(join(tmpdir(), "hcom-ack-"));
		portedSessionFile = join(portedSessionDir, "sid-1.jsonl");
		resetIdentity();
	});

	afterEach(() => {
		rmSync(portedSessionDir, { recursive: true, force: true });
		resetIdentity();
	});

	// >>> paste worlds/base/extensions/hcom.test.ts lines 175-358 here, verbatim <<<
});
```

Then paste `/home/sf/worlds/base/extensions/hcom.test.ts` lines 175 through 358
(inclusive) where the marker comment says so, and delete the marker comment. That
contiguous range is exactly these seven tests — do not retype them, do not rename
them, do not touch a single `expect()`:

1. `queues a non-demanding active batch as a follow-up and acks only when its run starts`
2. `settles a held follow-up ack at the turn boundary that persisted it`
3. `acks a follow-up whose persisted text the transcript had to escape`
4. `holds a combined follow-up batch until every message in it is persisted`
5. `does not accept a transcript entry that predates the injection`
6. `keeps a queued follow-up's markers when a later batch rides the same ack`
7. `keeps an unpersisted follow-up unread so a recycle re-fetches it`

Add the imports these bodies need. The top-of-file import line 10 becomes:

```ts
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
```

and the `node:fs` import from Step 1 becomes:

```ts
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
```

- [x] **Step 3: Run the suite to watch the six new assertions fail**

Run: `cd /home/sf/workspace/hcom && HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts`

Expected: `6 fail`, and the failures are exactly

```
(fail) persist-before-ack ... > settles a held follow-up ack at the turn boundary that persisted it
(fail) persist-before-ack ... > acks a follow-up whose persisted text the transcript had to escape
(fail) persist-before-ack ... > holds a combined follow-up batch until every message in it is persisted
(fail) persist-before-ack ... > does not accept a transcript entry that predates the injection
(fail) persist-before-ack ... > keeps a queued follow-up's markers when a later batch rides the same ack
(fail) persist-before-ack ... > keeps an unpersisted follow-up unread so a recycle re-fetches it
```

with messages of the form `expect(received).toBe(expected) Expected: false Received: true`
(acked too early) and `toHaveLength(1) ... Received length: 0` (never acked). The
seventh ported test passes already, because it persists before the draining
`agent_start`.

- [x] **Step 4: Tighten the three existing HCOM tests that pin the old behavior**

These currently pass only because the plugin acks at `agent_start` regardless of
the transcript. Add the persist that the tightened contract requires; they must
keep passing both before and after Step 5.

In `test("non-demanding auto waits for the turn and is acked when that run starts", ...)`
(around line 250), insert before `await pi.emit("agent_start", {}, ctx);`:

```ts
		// The draining run writes the prompt to the transcript before it acks.
		persistUserMessage(pi.sent[0].text);
```

In `test("queue mail rides a live run as a follow-up", ...)` (around line 278),
insert before `await pi.emit("agent_start", {}, ctx);`:

```ts
		persistUserMessage(pi.sent[0].text);
```

In `test("an unacknowledged batch is not re-injected, and new mail supersedes it", ...)`
(around line 324), insert immediately before `hcom.mailbox.push(message(103, "steer", "request"));`:

```ts
		// The follow-up reached the transcript, so the superseding steer's ack
		// may name both ids.
		persistUserMessage(pi.sent[0].text);
```

- [x] **Step 5: Implement the persist gate**

In `src/omp_plugin/hcom.ts`, line 2, widen the `node:fs` import:

```ts
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
```

Replace `formatMessagesForInjection` (lines 74-87) with the same output, factored
so the per-message text is reusable as a gate marker:

```ts
/** The per-message text an injection embeds; also the persist-gate marker. */
function messagePart(m: any, recipientName: string): string {
	const prefix = m.intent
		? m.thread
			? `[${m.intent}:${m.thread} #${m.event_id}]`
			: `[${m.intent} #${m.event_id}]`
		: m.thread
			? `[thread:${m.thread} #${m.event_id}]`
			: `[new message #${m.event_id}]`;
	return `${prefix} ${m.from} -> ${recipientName}: ${m.message}`;
}

function formatMessagesForInjection(messages: any[], recipientName: string): string {
	const parts = messages.map((m: any) => messagePart(m, recipientName));
	if (messages.length === 1) return `<hcom>${parts[0]}</hcom>`;
	return `<hcom>[${messages.length} new messages] | ${parts.join(" | ")}</hcom>`;
}
```

Replace the `PendingAck` type (lines 158-163) with the gated tracker plus its
helpers:

```ts
/**
 * A deferred injection whose transcript evidence is still owed. A `followUp` is
 * drained by a later run, so the cursor may only move over it once the prompt
 * carrying it is durably in the transcript. `offset` is the transcript size at
 * injection: an identical line written earlier is not evidence. A `null` path
 * can never be satisfied — fail closed toward unread.
 */
type PersistGate = {
	path: string | null;
	offset: number;
	markers: string[];
};

/** A batch with `omp-read --ack` still owed. Tracked so the ack names its exact ids. */
type PendingAck = {
	ids: number[];
	/** High-water id, used only when the batch carried no usable ids (`--up-to`). */
	maxId: number;
	/** Empty for immediate consumption: steer, idle prompt, wake transform. */
	gates: PersistGate[];
};

/** Transcript size now, so evidence written later can be told apart. */
function transcriptOffset(path: string | null): number {
	if (!path) return 0;
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/**
 * Text of every user entry appended past `gate.offset`. The transcript escapes
 * quotes and newlines, so entries are parsed rather than string-searched.
 */
function persistedUserTexts(gate: PersistGate): string[] {
	if (!gate.path) return [];
	let region: string;
	try {
		region = readFileSync(gate.path).subarray(gate.offset).toString("utf8");
	} catch {
		return [];
	}
	const texts: string[] = [];
	for (const line of region.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.message?.role !== "user") continue;
		const content = entry.message.content;
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part?.text === "string") texts.push(part.text);
			}
		}
	}
	return texts;
}

/** Whether every owed marker is now in the transcript. No gates = settled. */
function gatesSatisfied(batch: PendingAck): boolean {
	return batch.gates.every((gate) => {
		const texts = persistedUserTexts(gate);
		return gate.markers.every((marker) => texts.some((text) => text.includes(marker)));
	});
}
```

In `deliverPending`, replace the single line that builds the batch (line 475):

```ts
			const batch: PendingAck = { ids: injectedIds(prior, pending.messages), maxId: pending.maxId };
```

with:

```ts
			// A follow-up is drained by a later run, so its ack owes transcript
			// evidence. An earlier unsettled batch's gates ride along, so a newer
			// batch cannot settle mail the transcript still has not kept.
			const gates: PersistGate[] = [...(prior?.gates ?? [])];
			if (plan.deliverAs === "followUp") {
				const transcriptPath = ctx.sessionManager.getSessionFile();
				// Bound to a const: a nested closure does not keep the non-null
				// narrowing of the mutable `instanceName`.
				const recipient = instanceName;
				gates.push({
					path: transcriptPath,
					offset: transcriptOffset(transcriptPath),
					markers: fresh.map((message) => messagePart(message, recipient)),
				});
			}
			const batch: PendingAck = {
				ids: injectedIds(prior, pending.messages),
				maxId: pending.maxId,
				gates,
			};
```

Still inside `deliverPending`, replace the immediate-ack line (492):

```ts
				if (plan.deliverAs !== "followUp") await ackPending("delivery");
```

with:

```ts
				// A steer (always into a live run) and a no-`deliverAs` prompt ARE
				// the consuming turn, so they settle now; a followUp waits for the
				// run that drains it and for the write that proves it.
				await settlePendingAck("delivery");
```

Add `settlePendingAck` directly after the `ackPending` function (after line 580),
inside the same closure:

```ts
	/**
	 * Ack the tracked batch, but only once every deferred injection in it is
	 * durably in the transcript. A batch with no gates settles exactly as before.
	 */
	async function settlePendingAck(source: string): Promise<boolean> {
		const batch = pendingAck;
		if (batch === null) return false;
		if (!gatesSatisfied(batch)) {
			log("DEBUG", "plugin.ack_held_unpersisted", instanceName, { ids: batch.ids, source });
			return false;
		}
		return ackPending(source);
	}
```

Rewrite the four ack call sites. In `agent_start` (743-753), replace

```ts
		if (pendingAck !== null) await ackPending("agent_start");
```

with

```ts
		// The run that drains a follow-up starts here, but the prompt may not be
		// on disk yet: settle only against transcript evidence.
		await settlePendingAck("agent_start");
```

In the `input` handler's extension branch (761), replace `await ackPending("extension");`
with `await settlePendingAck("extension");`. In `before_agent_start` (790), replace
`if (pendingAck !== null) await ackPending("before_agent_start");` with
`await settlePendingAck("before_agent_start");`. In `turn_end` (842-845), replace
the body with:

```ts
	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		// The turn boundary is where a follow-up's own persisted prompt settles.
		await settlePendingAck("turn_end");
		await deliverPending(ctx);
	});
```

Leave `formatMessagesForInjection`'s output, `decideInjection`, `LANE_RANK`,
`ackPending`, `resetBinding` and `reconcile` otherwise untouched.

- [x] **Step 6: Run the suite to verify it passes**

Run: `cd /home/sf/workspace/hcom && HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts`
Expected: `0 fail`, and these six names reported as passing —
`settles a held follow-up ack at the turn boundary that persisted it`,
`keeps a queued follow-up's markers when a later batch rides the same ack`,
`keeps an unpersisted follow-up unread so a recycle re-fetches it`,
`acks a follow-up whose persisted text the transcript had to escape`,
`holds a combined follow-up batch until every message in it is persisted`,
`does not accept a transcript entry that predates the injection`.

- [x] **Step 7: Run the untouched Worlds suite against the new plugin**

Run:

```bash
cd /home/sf/workspace/hcom
T=$(mktemp -d) && cp src/omp_plugin/hcom.ts "$T/hcom.ts" \
  && cp /home/sf/worlds/base/extensions/hcom.test.ts "$T/hcom.test.ts" \
  && (cd "$T" && HCOM_DIR=$(mktemp -d) bun test hcom.test.ts)
md5sum /home/sf/worlds/base/extensions/hcom.test.ts /home/sf/worlds/base/extensions/hcom.ts
```

Expected: `13 pass`, `0 fail`; hashes still
`c7c904c74a447e6df5dcb98c3bd0553d` and `688c3b9c80abefe0d2636f30e70667cf`. If
either hash changed, you edited Worlds — revert that file with
`git -C /home/sf/worlds checkout -- <path>` only if that repo is clean, otherwise
stop and report.

- [x] **Step 8: Typecheck the plugin sources**

Run: `cd /home/sf/workspace/hcom && npm run typecheck`
Expected: exit 0, no diagnostics naming `src/omp_plugin/hcom.ts`. (On Android the
wrapper script skips loudly; that is an acceptable skip, not a pass to fake.)

- [ ] **Step 9: Commit**

```bash
git add src/omp_plugin/hcom.ts src/omp_plugin/hcom.test.ts
git commit -m "fix(omp-plugin): gate follow-up acks on transcript persistence

Ports the six Worlds acceptance assertions plus the acks-when-its-run-starts
tightening into the canonical HCOM suite. A followUp injection now records a
persist gate (transcript path, byte offset at injection, per-message markers)
and every ack site settles through it, with turn_end as the settle boundary.
Steer, idle-prompt and wake-transform acks are unchanged."
```

---

## Task 2: Abort-acks proof — an unpersisted, dropped follow-up stays unread

**Owner:** builder
**Bead:** `hcom-rfy.1` (evidence for `hcom-abort-acks-unconsumed-followup-mlj`, which stays OPEN)
**Depends on:** Task 1
**Files:**
- Test: `src/omp_plugin/hcom.test.ts` (append one test to the `describe("lane-aware delivery", ...)` block)
- No product code changes. If this test fails, stop and report — do not adjust the gate to make it pass.

**Context a builder needs:** the abort hole is the same defect with a different
trigger. An operator presses Esc, OMP clears the queued follow-up for the
interrupt, and today the next `agent_start` acks a message no turn ever consumed.
The plugin cannot observe the interrupt-time queue clear, so the proof is at the
ack gate: a follow-up that never reaches the transcript must never move the
cursor, no matter which later events fire. Duplicate delivery after a recycle is
the accepted failure; silent loss is not. The bead
`hcom-abort-acks-unconsumed-followup-mlj` must be left open with the residual gap
named — this task supplies the evidence, not a closure.

**Verification:** `cd /home/sf/workspace/hcom && HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts`
→ `0 fail`, including the new test name. Then confirm the test actually exercises
the gate: temporarily change `settlePendingAck` in `src/omp_plugin/hcom.ts` to
`return ackPending(source);` unconditionally, re-run, observe this test fail,
then `git checkout -- src/omp_plugin/hcom.ts` and re-run to green. Report both
observations.

- [x] **Step 1: Add the abort proof test**

Append inside `describe("lane-aware delivery", ...)` in
`src/omp_plugin/hcom.test.ts`:

```ts
	test("an aborted follow-up that never persisted stays unread", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		// Delivered as a follow-up, so its ack owes transcript evidence.
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });

		// Operator abort: omp drops the queued message for the interrupt, so the
		// prompt never reaches the transcript. No later trigger may move the
		// cursor over a message no turn consumed.
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("turn_end", {}, ctx);
		await pi.emit("before_agent_start", {}, ctx);

		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);
		// Still unread at HCOM, so the next wake or recycle re-fetches it:
		// duplicate delivery is the accepted failure, silent loss is not.
	});
```

- [x] **Step 2: Run it, then prove it bites**

Run `HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts` (expect `0 fail`),
then run the mutation check described in Verification and restore the file.

- [ ] **Step 3: Commit**

```bash
git add src/omp_plugin/hcom.test.ts
git commit -m "test(omp-plugin): prove an unpersisted aborted follow-up stays unread

Abort-acks evidence for the persist gate: the queued follow-up is dropped
before any transcript write, and agent_start / turn_end / before_agent_start
all refuse to ack it. The plugin still cannot observe the interrupt itself,
so hcom-abort-acks-unconsumed-followup-mlj stays open with that gap named."
```

**Leftover for the lead (do not close the bead):** report on
`hcom-abort-acks-unconsumed-followup-mlj` that the gate covers the *consequence*
(no cursor advance without transcript evidence) but not the *signal* (the plugin
never sees `clearQueue({forInterrupt})`), and that a live-pane Esc dogfood is
still owed before it can close.

---

## Task 3: Plugins drop the `auto` lane

**Owner:** builder
**Bead:** `hcom-rfy.2`
**Depends on:** Task 1 (its 13/13 Worlds cross-check must be recorded first, because this task intentionally diverges two Worlds fixtures)
**Files:**
- Modify: `src/omp_plugin/hcom.ts` (104-140), `src/pi_plugin/hcom.ts` (85-121)
- Test: `src/omp_plugin/hcom.test.ts` (186-219 and the fixtures named below), `src/pi_plugin/hcom.test.ts` (127-134 and the fixtures named below)

**Context a builder needs:** Ata removed the public `auto` lane. Models must pick
`steer` or `queue`; an omitted, unknown or legacy lane is `queue` — hold at idle,
`followUp` when a turn is in flight. HCOM must never infer a steer from
`request` + busy: that inference is exactly the mid-work interrupt Ata observed.
So `laneOf` returns `steer` only for a literal `"steer"`, `LANE_RANK` has two
entries, and the whole `demanding`/intent computation disappears from
`decideInjection`. Item 1's persist gate is OMP-only and is not touched here.

Expect this consequence and report it: after this change the Worlds test file
(which this repo must not edit) fails **three** of its own tests —
`injects an idle batch as one combined turn and acks its exact event ids`,
`steers a demanding batch into the live run and acks it immediately`, and
`keeps a queued follow-up's markers when a later batch rides the same ack`
(its 902 row also omits `delivery`; that third case is the Worlds twin of the
Step 3b fixture this repo names explicitly, and the spec's §1b contradiction
check prescribes the sender-names-its-lane fix for it). Measured 2026-09-16:
new plugin against the untouched Worlds file = 10 pass / 3 fail; HEAD plugin
against the same file = 7 pass / 6 fail. All three failures are fixtures that
omit `delivery` and relied on the deleted inference. That is a Worlds-side
fixture reconciliation for midi/soma, not a weakened assertion.

**Verification:**
`cd /home/sf/workspace/hcom && HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts && HCOM_DIR=$(mktemp -d) bun test src/pi_plugin/hcom.test.ts && npm run typecheck`
→ both suites `0 fail` (including all six ported assertions from Task 1 and the
Task 2 abort proof), typecheck exit 0, and
`rg -n 'auto' src/omp_plugin/hcom.ts src/pi_plugin/hcom.ts` returns only the
comment that names `"auto"` as a legacy value degrading to `queue`.

- [x] **Step 1: Rewrite the lane block in both plugins**

In `src/omp_plugin/hcom.ts`, replace lines 104-140 (from
`export type DeliveryLane` through the end of `decideInjection`) with:

```ts
export type DeliveryLane = "steer" | "queue";

/** Lane urgency; a batch resolves to its most urgent lane. */
const LANE_RANK: Record<DeliveryLane, number> = { queue: 1, steer: 2 };

/** `"hold"` = inject nothing and ack nothing. Otherwise the exact `sendUserMessage` options. */
export type InjectionPlan = "hold" | { deliverAs?: "steer" | "followUp" };

function laneOf(message: PendingMessage): DeliveryLane {
	// Absent (legacy row), the retired "auto" value, and anything unknown all
	// degrade to "queue": the sender must ask for a steer explicitly.
	return message.delivery === "steer" ? "steer" : "queue";
}

/**
 * Lane-aware plan for one unread batch.
 *
 * - `queue` at an idle session is HELD: injecting it would start a turn the
 *   sender did not ask for. It is delivered by the next trigger that finds a
 *   turn already in flight (or a bodyless wake carrying it).
 * - At idle a `steer` batch is injected with NO `deliverAs`, so
 *   `sendUserMessage` takes the `prompt()` path and starts the consuming turn
 *   synchronously.
 * - With a turn in flight only `steer` interrupts it; `queue` waits for the turn
 *   to end. Intent never promotes a lane — a steer is never inferred from a
 *   demanding message arriving at a busy actor.
 */
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

Apply the identical replacement to `src/pi_plugin/hcom.ts` lines 85-121 (same
`DeliveryLane`, `LANE_RANK`, `InjectionPlan`, `laneOf`, `decideInjection` block;
keep whatever doc comment wording differences exist around it, and do not touch
that file's ack logic).

- [x] **Step 2: Rewrite the OMP lane tests**

In `src/omp_plugin/hcom.test.ts`, replace lines 186-219 (from
`test("auto is demanding unless the intent is inform/ack", ...)` through the end
of `test("a batch resolves to its most urgent lane", ...)`) with:

```ts
	test("absent, legacy auto, and unknown lanes all degrade to queue", () => {
		expect(decideInjection([message(1)], true)).toBe("hold");
		expect(decideInjection([message(1)], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "auto", "request")], true)).toBe("hold");
		expect(decideInjection([message(1, "auto", "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "sideways", "request")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("intent never promotes a lane to steer", () => {
		expect(decideInjection([message(1, "queue", "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, undefined, "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "steer", "inform")], false)).toEqual({ deliverAs: "steer" });
	});

	test("queue never starts a turn but rides a live one", () => {
		expect(decideInjection([message(1, "queue", "request")], true)).toBe("hold");
		expect(decideInjection([message(1, "queue", "request")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("a batch resolves to its most urgent lane", () => {
		expect(decideInjection([message(1, "queue", "inform"), message(2, "steer", "inform")], true)).toEqual({});
		expect(decideInjection([message(1, "queue", "inform"), message(2, "steer", "inform")], false)).toEqual({
			deliverAs: "steer",
		});
		expect(decideInjection([message(1, "queue", "request"), message(2, undefined, "request")], false)).toEqual({
			deliverAs: "followUp",
		});
	});
```

- [x] **Step 3: Make the OMP delivery fixtures name their lane explicitly**

Every fixture below used to rely on absent-or-`auto` meaning steer. Change only
the fixture values and the test names that describe them; leave the `expect()`s
alone.

| Location (approx. line) | Change |
|---|---|
| 223-224 `test("idle demanding mail is injected as a prompt and acked by exact ids"` | rename to `test("idle steer mail is injected as a prompt and acked by exact ids"`; fixture becomes `fakeHcom([message(101, "steer", "request"), message(102, "steer", "request")])` |
| 250-251 `test("non-demanding auto waits for the turn and is acked when that run starts"` | rename to `test("a queue-lane batch waits for the turn and is acked when that run persists it"`; fixture becomes `fakeHcom([message(101, "queue", "inform")])` |
| 311 mixed-lane test fixture | becomes `fakeHcom([message(101, "queue", "inform"), message(102, "steer", "request")])` |
| 325 supersede test fixture | becomes `fakeHcom([message(101, "queue", "inform")])` |
| 348 rejected-ack test fixture | becomes `fakeHcom([message(101, "steer", "request")])` |

- [x] **Step 3b: The one ported assertion whose fixture names a steer**

Of the six ported Worlds assertions, exactly one sends mail that expects a steer:
`keeps a queued follow-up's markers when a later batch rides the same ack` adds
`{ from: "kilo", intent: "request", event_id: 902, message: "now" }` with no
`delivery` key and asserts `expect(pi.sent[1]?.options).toEqual({ deliverAs: "steer" })`.
Under the rule this task implements, an absent lane is `queue`, so that input no
longer describes a steer. In `src/omp_plugin/hcom.test.ts`, inside that ported
test, change only that fixture line to:

```ts
			{ from: "kilo", intent: "request", delivery: "steer", event_id: 902, message: "now" },
```

Do not touch its `expect()`s. The assertion's subject — a later batch riding the
same ack must not settle the still-unpersisted follow-up — is unchanged; §1b
simply requires the sender to say which lane it wants. Verify the other five
still need no fixture change: they all send `intent: "inform"` into a busy
session, which is `followUp` before and after this task.

- [x] **Step 4: Rewrite the Pi lane tests and fixtures**

In `src/pi_plugin/hcom.test.ts`, replace lines 127-134
(`test("demandingness covers the whole batch and absent fields are demanding auto", ...)`)
with:

```ts
	test("absent, legacy auto, and unknown lanes all degrade to queue", () => {
		expect(decideInjection([message(1)], true)).toBe("hold");
		expect(decideInjection([message(1)], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "auto", "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "queue", "request"), message(2, "auto", "inform")], false)).toEqual({
			deliverAs: "followUp",
		});
		expect(decideInjection([message(1, "steer", "inform")], true)).toEqual({});
	});
```

Then update the fixtures that relied on the inference:

| Location (approx. line) | Change |
|---|---|
| 138-139 `test("idle demanding mail is injected as a prompt and acked through its high-water id"` | rename `demanding` to `steer`; fixture becomes `fakeHcom([message(101, "steer", "request"), message(102, "steer", "request")])` |
| 163-164 `test("non-demanding auto waits for the run that drains it"` | rename to `test("a queue-lane batch waits for the run that drains it"`; fixture becomes `fakeHcom([message(101, "queue", "inform")])` |
| 210 `test("an injected-but-unacked batch is not re-injected when the ack fails"` | fixture becomes `fakeHcom([message(101, "steer", "request")])` (an idle `queue` batch would be held and never injected) |

- [x] **Step 5: Run both suites and the typecheck**

```bash
cd /home/sf/workspace/hcom
HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts
HCOM_DIR=$(mktemp -d) bun test src/pi_plugin/hcom.test.ts
npm run typecheck
rg -n 'auto' src/omp_plugin/hcom.ts src/pi_plugin/hcom.ts
```

Expected: both suites `0 fail`; typecheck exit 0; the `rg` output shows only the
`laneOf` comment naming `"auto"` as a retired legacy value.

- [ ] **Step 6: Commit**

```bash
git add src/omp_plugin/hcom.ts src/omp_plugin/hcom.test.ts src/pi_plugin/hcom.ts src/pi_plugin/hcom.test.ts
git commit -m "feat(plugins)!: drop the auto delivery lane

laneOf, LANE_RANK and decideInjection now know only steer and queue. An
absent, legacy-auto or unknown lane degrades to queue: held at idle, followUp
into a live turn. Intent no longer promotes a lane, so a steer is never
inferred from a demanding message arriving at a busy actor."
```

---

## Task 4: Rust side drops the `auto` lane, defaulting to `queue`

**Owner:** builder
**Bead:** `hcom-rfy.2`
**Depends on:** none (independent of Task 3; may run in parallel, different files)
**Files:**
- Modify: `src/messages.rs` (74-107, 564-573, tests at ~1830-1858), `src/commands/send.rs` (96, 1104, tests at ~1839-1846 and ~2143-2170), `src/db/events.rs` (196-200, test at ~781-800), `src/hooks/omp/handlers.rs` (test fixture at ~639, tests at ~840-883)

**Context a builder needs:** `hcom send --delivery` must accept `steer|queue`
only, and the fail-closed default for an omitted flag, an unknown value or a
legacy row is `queue`, never steer. `auto` must not survive as a silent alias:
`--delivery auto` now fails loudly. Rows already on disk carrying the old `auto`
string keep working — they read as `queue`. The human message prefix surfaces a
lane only when it deviates from the default, so it now shows `steer` and hides
`queue`, absent and legacy `auto` (that is the existing rule applied to the new
default; without it every default message would start carrying a `queue` word).

**Verification:**

```bash
cd /home/sf/workspace/hcom
just test --bin hcom delivery_lane
just test --bin hcom build_message_prefix
just test --bin hcom get_unread_messages_defaults
just test --bin hcom omp_read
just test --bin hcom commands::send
```

(Amended at execution: this crate is binary-only — `just test --lib <filter>`
targets nothing and exits 101 with `no library targets found in package hcom`.
The `--bin hcom` form above is the one that runs. The step-6 sweep below means
`just test --bin hcom` with no filter.)

all green, plus a direct check that the retired value is refused and the default
is recorded:

```bash
cargo run --quiet -- send --delivery auto @nobody -- hi; echo "exit=$?"   # expect a clap error naming steer|queue, exit 1
rg -n 'auto' src/messages.rs src/db/events.rs | rg -v '^src/[a-z/]*\.rs:[0-9]+: *//'
```

The second command must show no remaining `auto` lane value outside comments.

(Amended: the exit code is **1**, not 2 — `router.rs` maps a clap parse error
through `if e.use_stderr() { 1 } else { 0 }`, and the pre-existing
`--delivery bogus` behaves the same way. Nonzero is what the Brief requires.)

- [x] **Step 1: Collapse the enum**

In `src/messages.rs`, replace the `DeliveryLane` definition, `as_str` and
`FromStr` (lines 73-107) with:

```rust
/// Delivery lane for envelope: how the recipient's client should inject the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeliveryLane {
    /// Interrupt/steer the active turn. Must be asked for explicitly.
    Steer,
    /// Queue without interrupting. The fail-closed default: an omitted flag, an
    /// unknown value, and a legacy row all mean this.
    #[default]
    Queue,
}

impl DeliveryLane {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeliveryLane::Steer => "steer",
            DeliveryLane::Queue => "queue",
        }
    }
}

impl std::str::FromStr for DeliveryLane {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "steer" => Ok(DeliveryLane::Steer),
            "queue" => Ok(DeliveryLane::Queue),
            // "auto" is retired, not aliased: a caller asking for it is told.
            _ => Err(format!(
                "invalid delivery lane: {s} (expected steer|queue)"
            )),
        }
    }
}
```

- [x] **Step 2: Surface only the non-default lane in the prefix**

In `src/messages.rs`, replace the filter inside `build_message_prefix`
(lines 564-568):

```rust
    // Non-auto delivery lanes are operator-visible routing signals; surface them.
    let delivery = msg
        .get("delivery")
        .and_then(|v| v.as_str())
        .filter(|d| *d != "auto");
```

with:

```rust
    // Only a lane that deviates from the default is an operator-visible routing
    // signal. `queue` is the default now, and legacy rows say "auto" or nothing.
    let delivery = msg
        .get("delivery")
        .and_then(|v| v.as_str())
        .filter(|d| *d == "steer");
```

- [x] **Step 3: Normalize the lane once, on read**

In `src/db/events.rs`, replace the `delivery` extraction in `get_unread_messages`
(lines 196-200):

```rust
                let delivery = json
                    .get("delivery")
                    .and_then(|v| v.as_str())
                    .unwrap_or("auto")
                    .to_string();
```

with:

```rust
                // The only lane a sender can ask for is "steer"; absent, legacy
                // "auto" and anything unknown are the fail-closed "queue".
                let delivery = match json.get("delivery").and_then(|v| v.as_str()) {
                    Some("steer") => "steer",
                    _ => "queue",
                }
                .to_string();
```

- [x] **Step 4: Tighten the CLI**

In `src/commands/send.rs`, replace the `--delivery` argument (lines 95-97):

```rust
    /// Delivery lane (auto|steer|queue)
    #[arg(long, value_parser = ["auto", "steer", "queue"])]
    pub delivery: Option<String>,
```

with:

```rust
    /// Delivery lane (steer|queue); omitted means queue
    #[arg(long, value_parser = ["steer", "queue"])]
    pub delivery: Option<String>,
```

and replace the envelope gate (line 1104):

```rust
        || envelope.delivery != crate::messages::DeliveryLane::Auto;
```

with:

```rust
        || envelope.delivery != crate::messages::DeliveryLane::default();
```

- [x] **Step 5: Update the tests that pinned `auto`**

Make these exact edits, then run the suites in Verification.

`src/messages.rs`, in `fn delivery_lane_roundtrip` (~1830): delete the
`"auto".parse()` assertion, change `assert_eq!(DeliveryLane::default(), DeliveryLane::Auto);`
to `assert_eq!(DeliveryLane::default(), DeliveryLane::Queue);`, and add
`assert!("auto".parse::<DeliveryLane>().is_err());` next to the existing `"bogus"`
assertion.

`src/messages.rs`, replace `fn build_message_prefix_shows_non_auto_lane` and
`fn build_message_prefix_hides_auto_lane` (~1845-1858) with:

```rust
    #[test]
    fn build_message_prefix_shows_steer_lane() {
        let msg = serde_json::json!({"delivery": "steer", "event_id": 42});
        assert_eq!(build_message_prefix(&msg), "[steer new message #42]");
    }

    #[test]
    fn build_message_prefix_hides_the_default_lane() {
        let queued = serde_json::json!({"delivery": "queue", "event_id": 42});
        assert_eq!(build_message_prefix(&queued), "[new message #42]");
        let legacy_auto = serde_json::json!({"delivery": "auto", "event_id": 42});
        assert_eq!(build_message_prefix(&legacy_auto), "[new message #42]");
        let legacy_absent = serde_json::json!({"event_id": 42});
        assert_eq!(build_message_prefix(&legacy_absent), "[new message #42]");
    }
```

`src/db/events.rs`, rename `fn get_unread_messages_defaults_delivery_auto_for_legacy_rows`
to `fn get_unread_messages_defaults_delivery_queue_for_legacy_rows` and change its
`assert_eq!(msgs[0].delivery, "auto");` to `"queue"`.

`src/commands/send.rs`: in the `--delivery` parse test (~1839-1846) keep the
`steer` case and the `bogus` rejection, and add

```rust
        // "auto" is retired from the public CLI, not aliased to a lane.
        assert!(SendArgs::try_parse_from(["send", "--delivery", "auto", "@luna", "--", "hi"]).is_err());
```

Rename `fn send_message_defaults_delivery_auto` (~2143) to
`fn send_message_defaults_delivery_queue` and change its final
`assert_eq!(stored, "auto");` to `assert_eq!(stored, "queue");`.

`src/hooks/omp/handlers.rs`: in the `send_to_bob` test helper (~639) change
`"delivery": "auto",` to `"delivery": "queue",`. Rename
`fn omp_read_raw_defaults_legacy_rows_to_auto` to
`fn omp_read_raw_defaults_legacy_rows_to_queue` and change its
`assert_eq!(msgs[0]["delivery"], "auto");` to `"queue"`. Replace
`fn omp_read_format_path_agrees_with_raw` and `fn omp_read_format_path_hides_auto`
(~861-883) with:

```rust
    #[test]
    #[serial]
    fn omp_read_format_path_agrees_with_raw() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        send_lane_to_bob(&db, DeliveryLane::Steer, "steered");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--format"]));
        assert!(
            out.contains("[steer "),
            "format path must surface a non-default lane: {out}"
        );
        assert!(out.contains("steered"));
        cleanup(path);
    }

    #[test]
    #[serial]
    fn omp_read_format_path_hides_the_default_lane() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        send_lane_to_bob(&db, DeliveryLane::Queue, "plain");
        let (_, out) = handle_read(&db, &argv(&["--name", "bob", "--format"]));
        assert!(
            !out.contains("[queue "),
            "the default lane must not add noise: {out}"
        );
        cleanup(path);
    }
```

- [x] **Step 6: Build, test, and sweep for leftovers**

Run every command in Verification. Then run `just test --bin hcom` once for the
whole binary; if any other test still asserts an `auto` lane, apply the same rule
(absent / legacy `auto` / unknown reads as `queue`; only `steer` is surfaced) and
say which tests you touched. Do not silence a failure by deleting an assertion.
(Amended: the plan said `just test --lib`; measured 2026-09-16 as `2279 passed;
0 failed; 1 ignored` under `--bin hcom`.)

- [ ] **Step 7: Commit**

```bash
git add src/messages.rs src/db/events.rs src/commands/send.rs src/hooks/omp/handlers.rs
git commit -m "feat(send)!: remove the public auto delivery lane

--delivery accepts steer|queue only and an omitted flag records queue. Reads
normalize absent, legacy auto and unknown lanes to queue in one place, and the
message prefix surfaces only the non-default steer lane. --delivery auto now
fails loudly instead of becoming an undocumented alias."
```

---

## Task 5: `hcom send --json` returns a persist-time receipt

**Owner:** builder
**Bead:** `hcom-rfy.3`
**Depends on:** Task 4 (both edit `src/commands/send.rs`; do not run them in parallel)
**Files:**
- Modify: `src/commands/send.rs` (`SendArgs` ~96, `send_message` 388-495, `cmd_send` ~1097-1123)
- Test: `src/commands/send.rs` (`#[cfg(test)] mod tests`)

**Context a builder needs:** a sender today gets prose back and no handle. The
`event_id` already exists — `send.rs:464` binds it as `_event_id` and throws it
away. `--json` must print one JSON object on stdout the moment the row is
committed, so the sender can thread a reply (`--reply-to <event_id>`) without
scraping text. The receipt is a *persist-time* receipt: it says the row is
durable and names who it was addressed to. It must NOT wait for injection,
because a queue-lane message to an idle actor is deliberately held until that
actor's next turn, and blocking on that would hang the sender. Without `--json`
the human output must be byte-identical to today.

`accepted_at` must be the row's own timestamp, not a second `now()` — generate it
once and hand it to the existing `log_event_with_ts` so the receipt and the
`events` row can never disagree.

**Verification:**

```bash
cd /home/sf/workspace/hcom
just test --bin hcom commands::send
just test --bin hcom send_json
cargo run --quiet -- send --json @luna -- "receipt please" | tee /tmp/receipt.json | jq -e '
  (.event_id|type=="number") and (.accepted_at|type=="string")
  and (.delivered_to|type=="array") and (.delivery=="queue") and (.from|type=="string")'
sqlite3 "${HCOM_DIR:-$HOME/.hcom}/hcom.db" \
  "select id, timestamp from events where id = $(jq .event_id /tmp/receipt.json)"
```

The `sqlite3` row's `id` and `timestamp` must equal the receipt's `event_id` and
`accepted_at` exactly. Also confirm the human path is untouched:
run the human path **without** `--json` and confirm it still prints `Sent to: …`
and no JSON object. Do **not** `git stash`: this wave's Tasks 1-5 are uncommitted
and a stash would take them all out from under the check. (Amended at execution;
also note the crate is binary-only, so `just test --lib <filter>` targets nothing
— the `--bin hcom` form above is the one that runs.)

- [x] **Step 1: Add the flag**

In `src/commands/send.rs`, after the `--delivery` argument in `SendArgs`, add:

```rust
    /// Emit a machine-readable persist-time receipt instead of human output
    #[arg(long)]
    pub json: bool,
```

- [x] **Step 2: Return the receipt from the send path**

Add above `send_message`:

```rust
/// Persist-time receipt for one accepted send.
///
/// Returned when the `events` row is committed. It does NOT mean the message was
/// injected into the recipient's turn: a queue-lane message to an idle actor is
/// held for that actor's next turn by design.
#[derive(Debug, Clone)]
pub struct SendReceipt {
    pub event_id: i64,
    /// The row's own `events.timestamp`, not a second clock read.
    pub accepted_at: String,
    pub delivered_to: Vec<String>,
}
```

Rename the existing `pub fn send_message(...) -> Result<Vec<String>, String>` to
`pub fn send_message_with_receipt(...) -> Result<SendReceipt, String>`, and keep
the old name as a thin wrapper so the ~14 existing callsites
(`src/hooks/common.rs:2950`, `src/hooks/omp/handlers.rs:815`, and the tests) do
not change:

```rust
/// Backwards-compatible wrapper: delivered_to only.
pub fn send_message(
    db: &HcomDb,
    identity: &SenderIdentity,
    message: &str,
    envelope: Option<&MessageEnvelope>,
    explicit_targets: Option<&[String]>,
) -> Result<Vec<String>, String> {
    send_message_with_receipt(db, identity, message, envelope, explicit_targets)
        .map(|receipt| receipt.delivered_to)
}
```

Inside `send_message_with_receipt`, replace the log call at 463-465:

```rust
    // Log event to DB
    let _event_id = db
        .log_event("message", &routing_instance, &data)
        .map_err(|e| format!("Failed to write message to database: {e}"))?;
```

with a version that keeps the id and fixes the timestamp once:

```rust
    // Log event to DB. The timestamp is generated here so the receipt's
    // accepted_at is the row's own timestamp rather than a second clock read.
    let accepted_at = crate::db::chrono_now_iso();
    let event_id = db
        .log_event_with_ts("message", &routing_instance, &data, Some(&accepted_at))
        .map_err(|e| format!("Failed to write message to database: {e}"))?;
```

Replace the two later uses of `_event_id` (the `create_request_watches` call at
~483) with `event_id`, and change the function's tail from
`Ok(delivery.delivered_to)` to:

```rust
    Ok(SendReceipt {
        event_id,
        accepted_at,
        delivered_to: delivery.delivered_to,
    })
```

If `chrono_now_iso` is not public at that path, find its actual definition with
`rg -n 'fn chrono_now_iso' src/` and use that path; do not introduce a second
timestamp helper.

- [x] **Step 3: Print the receipt in `cmd_send`**

In `cmd_send`, change the send call (~1106) to capture the receipt:

```rust
    let receipt = match send_message_with_receipt(
        db,
        &sender_identity,
        &message,
        if has_envelope { Some(&envelope) } else { None },
        targets_to_pass,
    ) {
        Ok(r) => r,
        Err(e) => {
            if args.json {
                println!(
                    "{}",
                    serde_json::json!({"error": e.to_string()})
                );
            } else {
                eprintln!("Error: {e}");
            }
            return 1;
        }
    };
    let delivered_to = receipt.delivered_to.clone();
```

Then, immediately before the existing `if args.quiet { ... }` feedback block, add:

```rust
    // ── Machine-readable receipt ──
    // Persist-time only: the row is durable and addressed. Injection is the
    // recipient client's business, and a held queue-lane message may not be
    // injected until that actor's next turn.
    if args.json {
        println!(
            "{}",
            serde_json::json!({
                "event_id": receipt.event_id,
                "accepted_at": receipt.accepted_at,
                "delivered_to": receipt.delivered_to,
                "delivery": envelope.delivery.as_str(),
                "from": sender_identity.name,
            })
        );
        crate::relay::worker::ensure_worker(true);
        return 0;
    }
```

Placing it above the feedback block is what keeps the human path byte-identical:
when `--json` is absent, nothing above changes. `--json` suppresses the prose and
the unread-mail drain exactly the way `--quiet` already does, so it does not
silently advance the sender's own read cursor.

- [x] **Step 4: Test the receipt**

Add to the `tests` module in `src/commands/send.rs`:

```rust
    #[test]
    #[serial]
    fn send_json_flag_parses() {
        let args = SendArgs::try_parse_from(["send", "--json", "@luna", "--", "hi"]).unwrap();
        assert!(args.json);
        let plain = SendArgs::try_parse_from(["send", "@luna", "--", "hi"]).unwrap();
        assert!(!plain.json);
    }

    #[test]
    #[serial]
    fn send_receipt_event_id_and_accepted_at_match_the_stored_row() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        register_instance(&db, "nova");
        let sender = external_sender("cli");

        let receipt =
            send_message_with_receipt(&db, &sender, "hi", None, Some(&["nova".to_string()]))
                .unwrap();

        assert_eq!(receipt.delivered_to, vec!["nova".to_string()]);
        assert!(receipt.event_id > 0);

        let (id, ts): (i64, String) = db
            .conn()
            .query_row(
                "SELECT id, timestamp FROM events WHERE id = ?",
                rusqlite::params![receipt.event_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(id, receipt.event_id);
        // The receipt must quote the row's own timestamp, not a second now().
        assert_eq!(ts, receipt.accepted_at);
        cleanup(path);
    }

    #[test]
    #[serial]
    fn send_receipt_reply_to_round_trips_its_own_event_id() {
        let _env = isolated_test_env();
        let (db, path) = setup();
        register_instance(&db, "nova");
        let sender = external_sender("cli");

        let first =
            send_message_with_receipt(&db, &sender, "ping", None, Some(&["nova".to_string()]))
                .unwrap();

        // The receipt's event_id is the handle a sender threads a reply to.
        let mut envelope = MessageEnvelope::default();
        envelope.reply_to = Some(first.event_id.to_string());
        let second = send_message_with_receipt(
            &db,
            &sender,
            "pong",
            Some(&envelope),
            Some(&["nova".to_string()]),
        )
        .unwrap();

        let data: String = db
            .conn()
            .query_row(
                "SELECT data FROM events WHERE id = ?",
                rusqlite::params![second.event_id],
                |row| row.get(0),
            )
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&data).unwrap();
        assert_eq!(json["reply_to_local"], serde_json::json!(first.event_id));
        cleanup(path);
    }
```

Reuse whatever helper names the surrounding tests already use for
`setup`/`cleanup`/`register_instance`/`external_sender`/`isolated_test_env`; do
not invent new fixtures. If a helper does not exist under that name, copy the
pattern from `send_message_defaults_delivery_queue` (Task 4, Step 5).

- [x] **Step 5: Run the verification block**

Run every command in Verification, including the `sqlite3` equality check and the
human-output `diff`. Report the receipt JSON you actually got.

- [ ] **Step 6: Commit**

```bash
git add src/commands/send.rs
git commit -m "feat(send): add --json persist-time receipt

send_message_with_receipt returns the event_id that send.rs previously bound to
_event_id and dropped, alongside the row's own timestamp. --json prints
event_id, accepted_at, delivered_to, delivery and from as soon as the row is
committed, so a sender can thread a reply without scraping prose. It does not
wait for injection: a queue-lane message to an idle actor is held by design.
Human output without --json is unchanged."
```

---

## Task 6: Document the HCOM handshake seam

**Owner:** builder
**Bead:** `hcom-rfy.3`
**Depends on:** Task 4, Task 5
**Files:**
- Modify: `src/commands/help.rs` (the `send` help text), `README.md` (the `--delivery` and `hcom send` sections)

**Context a builder needs:** two user-visible contracts changed, so the docs must
change with them or the next reader learns the old rules. The seam to document is
exactly three fields and nothing more: `event_id` (the handle a receipt returns
and `--reply-to` consumes), `thread` (the conversation grouping that already
exists), and `reply-to` (the pointer back to a specific `event_id`). There is no
registry, no capability list, and no new lifecycle vocabulary — if you find
yourself documenting an actor state machine, stop, that is out of scope.

**Verification:**

```bash
cd /home/sf/workspace/hcom
cargo run --quiet -- send --help | rg -n 'delivery|json'
rg -n 'auto' README.md src/commands/help.rs
just test --bin hcom help
```

(Amended at execution: there is no `hcom help <cmd>` subcommand — `hcom help`
exits `Unknown command 'help'` — and this crate is binary-only, so `--lib` targets
nothing. The two commands above are the ones that actually run.)

The help output must show `steer|queue` and the `--json` flag; the `rg` must find
no surviving claim that `auto` is a valid lane; the help tests must pass.

- [x] **Step 1: Update `hcom send --help` (the plan's `help send` subcommand does not exist)**

In `src/commands/help.rs`, find the `send` help block with
`rg -n 'delivery' src/commands/help.rs`. Change the lane line to read
`--delivery steer|queue   Lane (default queue: never interrupts a live turn)`
and add, next to the other output flags,
`--json                   Print a persist-time receipt (event_id, accepted_at, delivered_to, delivery, from)`.

If the block contains prose describing `auto` as the default, replace it with one
sentence: `queue` is the default and waits for the recipient's next turn; `steer`
interrupts the turn in flight and must be asked for explicitly.

- [x] **Step 2: Update the README**

In `README.md`, find the delivery documentation with `rg -n 'delivery' README.md`
and make three edits:

1. The lane table/list loses its `auto` row. `queue` is documented as the
   default; `steer` as the explicit interrupt.
2. Add a short `hcom send --json` example showing a real receipt shape:

```json
{"event_id":4128,"accepted_at":"2026-09-16T10:31:04.882Z","delivered_to":["luna"],"delivery":"queue","from":"nova"}
```

   with one sentence: the receipt is written when the row is committed, not when
   the recipient reads it.
3. Add a short "handshake seam" paragraph naming only the three fields:
   `event_id` is the durable handle a send returns; `reply-to` points at an
   `event_id` to answer it; `thread` groups a conversation so its members are
   subscribed. Say explicitly that there is no separate registry or
   capability negotiation — these three fields are the whole seam.

- [ ] **Step 3: Verify and commit** — the VERIFY half is done (VfyRfy6 against
  the cjh/ca3 acceptances, then VfyDocDeliveredTo on the delta: the help test, the
  cli_smoke guard, the rendered help). Only the commit remains, unchecked with the
  other five on purpose: nothing in this wave is committed until the operator
  chooses integration.

```bash
git add README.md src/commands/help.rs
git commit -m "docs(send): document steer|queue lanes, --json receipt, and the handshake seam

The retired auto lane is gone from help and README, queue is named as the
default, and the receipt example shows that it is written at persist time. The
handshake seam is event_id / reply-to / thread and nothing else: no registry,
no capability negotiation."
```

---

## Execution order and parallelism

Task 1 → Task 2 are strictly sequential (Task 2 asserts against Task 1's gate).
Task 3 must wait for Task 1's Worlds cross-check to be recorded, because it
knowingly diverges two Worlds fixtures and that evidence is worthless if taken
after the divergence. Task 4 touches only Rust and may run alongside Tasks 1-3.
Task 5 must follow Task 4 (same file). Task 6 is last.

```
Task 1 ──> Task 2
   └─────> Task 3
Task 4 ──> Task 5 ──> Task 6
                ↑
Task 3 ─────────┘ (docs describe both)
```

## Final full-suite gate (run once, after Task 6)

```bash
cd /home/sf/workspace/hcom
HCOM_DIR=$(mktemp -d) bun test src/omp_plugin/hcom.test.ts
HCOM_DIR=$(mktemp -d) bun test src/pi_plugin/hcom.test.ts
npm run typecheck
just test
```

Everything green. Then run the Worlds suite once for the record and report its
result without editing it:

```bash
cp src/omp_plugin/hcom.ts /tmp/hcom-candidate.ts
cd /home/sf/worlds && HCOM_DIR=$(mktemp -d) bun test base/extensions/hcom.test.ts
```

Expected: the six protected assertions pass (they were failing before Task 1),
and exactly two tests fail on stale fixtures that omit `delivery` —
`injects an idle batch as one combined turn and acks its exact event ids` and
`steers a demanding batch into the live run and acks it immediately`. Report both
names to the lead as the Worlds-side reconciliation owed to midi. Do not edit
anything under `/home/sf/worlds`.

### Observed at closure (2026-09-17 ~05:0x local, HEAD 1870bc2, nothing committed)

```
just test --bin hcom   run 1: 2292 passed / 1 failed / 2 ignored
                       run 2: 2293 passed / 0 failed / 2 ignored
cargo test --test cli_smoke   25 passed / 0 failed
bun test src/omp_plugin/hcom.test.ts   50 passed / 0 failed
bun test src/pi_plugin/hcom.test.ts    13 passed / 0 failed
npm run typecheck                      exit 0
```

The single red was NOT this wave: `hcom-vxd`, a pre-existing
test-isolation flake in `src/tools/codex_preprocessing.rs` (that
file's last commit is the 0.7.25 bump and it has no diff) — red in
a full run, green alone, green on a re-run. Filed with evidence and
a narrowed mechanism. It guards codex hook-trust bypass.

One rider landed AFTER Task 6 and is therefore not in this plan's
task list: `hcom-5l3` (`--run-here` fd hygiene) plus a
pointer-hardening change to the same helper, and `hcom-kfy` (the
third boundary, `hcom pty`). See the epic `hcom-rfy` comments for
the verification records.

Worlds at closure: `git -C /home/sf/worlds status --short --
base/extensions/` reports `actors.ts`, `actors.test.ts`, `hcom.ts`
and `hcom.test.ts` modified. mtimes place `actors.*` at 00:35-00:37
local (midi's self-recycle / actor-bridge work — their commits
`7b410b2`, `b7041c7` are in that file's history) and `hcom.ts` at
22:15:57, which is inside the window this session called the
"mirror refresh". Worlds' `hcom.ts` is md5 40e948ed…, which is NOT
this repo's `src/omp_plugin/hcom.ts` (8caf615b…), so what sits
there is the deployed lineage, not this tree's plugin. This session
wrote nothing under `/home/sf/worlds`; every dogfood launch used a
scratch HOME, because a launch with `HOME=/home/sf` would run
`ensure_omp_plugin_installed()` and write the running binary's
embedded plugin through `~/.omp/agent/extensions` into that tree.
The 22:15:57 write cannot be attributed from this session's own
records (midi's mirror refresh and this session's install sequence
both touched that minute); it is recorded as unattributed rather
than claimed either way.

## Risks

- **Worlds fixture divergence (expected, not a regression).** Task 3 deletes the
  `request`+busy → steer inference the brief forbids, and two Worlds tests
  encode it in their fixtures. The plan's answer is to keep the assertions and
  name the fixtures; reconciling the Worlds copy is midi's, not this repo's.
- **Transcript format coupling.** The persist gate greps the session JSONL for
  the injected text. If OMP changes how a user message is serialized, the gate
  stops recognizing its own writes and follow-ups stay unread forever — mail is
  re-delivered, never lost, but it can loop. The `messagePart` helper is the one
  place that knowledge lives; the escaped-text assertion is what pins it.
- **Abort-acks is evidenced, not closed.** Task 2 proves the consequence; the
  plugin still cannot observe the interrupt-time queue clear.
  `hcom-abort-acks-unconsumed-followup-mlj` stays open and needs a live-pane Esc
  dogfood.
- **`--json` does not mean delivered.** A caller that treats the receipt as proof
  of injection will be wrong for every held queue-lane message. The field name
  `accepted_at` and the doc sentence in Task 6 are the mitigation.
