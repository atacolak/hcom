// The plugin reads HCOM_DIR/LOG_PATH into module constants at load, so the
// environment must be in place before the module is evaluated — the one case
// static imports cannot express.
process.env.HCOM_DIR = mkdtempSync(join(tmpdir(), "hcom-plugin-test-"));
process.env.HCOM_LAUNCHED = "1";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
// Type-only: erased at runtime, so it does not defeat the dynamic import below.
import type { HcomDeps, PendingMessage } from "./hcom.ts";
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { decideInjection, default: hcomExtension } = await import("./hcom.ts");

type HcomResult = { code: number; stdout: string; stderr: string };
type SentMessage = { text: string; options?: { deliverAs?: "steer" | "followUp" } };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type FakePi = {
	api: ExtensionAPI;
	sent: SentMessage[];
	emit: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<unknown>;
};

type FakeHcom = {
	run: (args: string[]) => Promise<HcomResult>;
	mailbox: PendingMessage[];
	calls: string[][];
	setAckError: (error: string | null) => void;
	/** Every `omp-read --ack` invocation, as the batch it named. */
	acks: () => string[];
	count: (command: string) => number;
};

const IDENTITY_REGISTRY_KEY = Symbol.for("hcom.omp.identity");
const IDENTITY_OWNER_ENV = "HCOM_OMP_IDENTITY_OWNER";

/**
 * Handlers run in registration order, matching the extension runner.
 *
 * `tools` models the loader's tool registry when a runtime happens to expose
 * it; omitting it models the public `ExtensionAPI`, which has no registry.
 */
function fakePi(tools?: { has: (name: string) => boolean }): FakePi {
	const handlers = new Map<string, Handler[]>();
	const sent: SentMessage[] = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendUserMessage(text: string, options?: SentMessage["options"]) {
			sent.push({ text, options });
			return Promise.resolve();
		},
		...(tools ? { tools } : {}),
	};
	async function emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
		return last;
	}
	return { api: api as unknown as ExtensionAPI, sent, emit };
}

type CtxOptions = {
	sessionFile?: string | null;
	/** `null` models a runtime whose session manager has no durability action. */
	ensureOnDisk?: (() => Promise<void>) | null;
	/** Omitted models a runtime whose context exposes no system prompt at all. */
	systemPrompt?: string[];
};

function fakeCtx(idle: boolean, options: CtxOptions = {}): ExtensionContext {
	const file = options.sessionFile === undefined ? sessionFile : options.sessionFile;
	const manager: Record<string, unknown> = {
		getSessionId: () => "sid-1",
		getSessionFile: () => file,
	};
	if (options.ensureOnDisk !== null) {
		manager.ensureOnDisk = options.ensureOnDisk ?? (async () => {});
	}
	const prompt = options.systemPrompt;
	// `ExtensionContext` carries the full SDK surface; only these members are used.
	return {
		cwd: "/repo",
		isIdle: () => idle,
		sessionManager: manager,
		...(prompt ? { getSystemPrompt: () => prompt } : {}),
	} as unknown as ExtensionContext;
}

/**
 * `start` overrides the `omp-start` JSON per call, so a test can mutate it
 * between binds (e.g. drop `bootstrap_participant`) or return both primers.
 */
function fakeHcom(initial: PendingMessage[] = [], start: Record<string, unknown> = {}): FakeHcom {
	const mailbox = [...initial];
	const calls: string[][] = [];
	let ackError: string | null = null;
	const ok = (value: unknown): HcomResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
	async function run(args: string[]): Promise<HcomResult> {
		calls.push(args);
		if (args[0] === "omp-start") {
			return ok({ name: "test", session_id: "sid-1", bootstrap: "BOOTSTRAP TEXT", ...start });
		}
		if (args[0] !== "omp-read") return ok({});
		if (!args.includes("--ack")) return ok(mailbox);
		if (ackError) return { code: 0, stdout: JSON.stringify({ error: ackError }), stderr: "" };
		const idsFlag = args.indexOf("--ids");
		const upToFlag = args.indexOf("--up-to");
		const acked =
			idsFlag >= 0
				? args[idsFlag + 1].split(",").map(Number)
				: mailbox.map((m) => Number(m.event_id)).filter((id) => id <= Number(args[upToFlag + 1]));
		for (let i = mailbox.length - 1; i >= 0; i--) {
			if (acked.includes(Number(mailbox[i].event_id))) mailbox.splice(i, 1);
		}
		return ok({ acked: acked.length, acked_to: Math.max(...acked), already_acked: 0 });
	}
	return {
		run,
		mailbox,
		calls,
		setAckError(error) {
			ackError = error;
		},
		acks: () =>
			calls
				.filter((args) => args[0] === "omp-read" && args.includes("--ack"))
				.map((args) => {
					const ids = args.indexOf("--ids");
					return ids >= 0 ? args[ids + 1] : `--up-to ${args[args.indexOf("--up-to") + 1]}`;
				}),
		count: (command) => calls.filter((args) => args[0] === command).length,
	};
}

function message(eventId: number, delivery?: string, intent?: string): PendingMessage {
	return { event_id: eventId, from: "peer", message: `body-${eventId}`, delivery, intent };
}

/**
 * A `sys_[hcom-events]` subscription notice as `omp-read` returns it: the row
 * `send_sub_notification` writes (`src/db/subscriptions.rs`), naming the event
 * it reports as `#<id>` and defaulting to the `queue` lane.
 */
function eventsNotice(eventId: number, text: string, from = "[hcom-events]"): PendingMessage {
	return { event_id: eventId, from, message: text, delivery: "queue" };
}

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

let instances: FakePi[] = [];

type StartOptions = {
	/** Test-only detection hook plus the usual seam. */
	deps?: Partial<HcomDeps>;
	/** Models a runtime whose extension API exposes the loader's tool registry. */
	tools?: { has: (name: string) => boolean };
};

/** Bring up a bound extension instance against one fake hcom. */
async function start(hcom: FakeHcom, ctx: ExtensionContext, options: StartOptions = {}): Promise<FakePi> {
	const pi = fakePi(options.tools);
	hcomExtension(pi.api, { runHcom: hcom.run, ...options.deps });
	instances.push(pi);
	await pi.emit("session_start", {}, ctx);
	return pi;
}

beforeEach(() => {
	sessionSeq += 1;
	sessionFile = join(SESSION_DIR, `sid-${sessionSeq}.jsonl`);
	delete (globalThis as Record<symbol, unknown>)[IDENTITY_REGISTRY_KEY];
	delete process.env[IDENTITY_OWNER_ENV];
});

afterEach(async () => {
	// Stops the per-instance reconcile timer and notify server.
	for (const pi of instances) await pi.emit("session_shutdown", {}, fakeCtx(true));
	instances = [];
});

describe("decideInjection", () => {
	test("empty batch holds", () => {
		expect(decideInjection([], true)).toBe("hold");
		expect(decideInjection([], false)).toBe("hold");
	});

	test("steer interrupts a live run and starts a turn when idle", () => {
		expect(decideInjection([message(1, "steer", "request")], true)).toEqual({});
		expect(decideInjection([message(1, "steer", "request")], false)).toEqual({ deliverAs: "steer" });
	});

	test("absent, legacy auto, and unknown lanes all degrade to queue", () => {
		expect(decideInjection([message(1)], true)).toEqual({});
		expect(decideInjection([message(1)], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "auto", "request")], true)).toEqual({});
		expect(decideInjection([message(1, "auto", "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "sideways", "request")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("intent never promotes a lane to steer", () => {
		expect(decideInjection([message(1, "queue", "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, undefined, "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "steer", "inform")], false)).toEqual({ deliverAs: "steer" });
	});

	test("queue is a prompt at idle and rides a live turn", () => {
		expect(decideInjection([message(1, "queue", "request")], true)).toEqual({});
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

	test("both lanes inject as a prompt at idle and diverge only against a live run", () => {
		expect(decideInjection([message(1, "queue", "request")], true)).toEqual({});
		expect(decideInjection([message(1, "steer", "request")], true)).toEqual({});
		// Against a live turn the lanes differ: queue waits for the boundary,
		// steer interrupts it.
		expect(decideInjection([message(1, "queue", "request")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "steer", "request")], false)).toEqual({ deliverAs: "steer" });
	});

	test("a mixed batch at idle still injects once", () => {
		expect(decideInjection([message(1, "queue", "inform"), message(2, "steer", "inform")], true)).toEqual({});
	});
});

describe("lane-aware delivery", () => {
	test("idle steer mail is injected as a prompt and acked by exact ids", async () => {
		const hcom = fakeHcom([message(101, "steer", "request"), message(102, "steer", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].text).toContain("body-101");
		expect(pi.sent[0].text).toContain("body-102");
		// The started turn writes the prompt, and that write moves the cursor.
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["101,102"]);
		expect(hcom.mailbox).toEqual([]);
	});

	test("steer into a live run is injected as steer and acked immediately", async () => {
		const hcom = fakeHcom([message(101, "steer", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "steer" });
		expect(hcom.acks()).toEqual(["101"]);
	});

	test("a queue-lane batch waits for the turn and is acked when that run persists it", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);

		// The draining run writes the prompt to the transcript before it acks.
		persistUserMessage(pi.sent[0].text);
		await pi.emit("agent_start", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
	});

	test("queue mail at idle is injected as a prompt and acked by exact ids", async () => {
		const hcom = fakeHcom([message(101, "queue", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].text).toContain("body-101");
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
		expect(hcom.mailbox).toEqual([]);
	});

	test("queue mail rides a live run as a follow-up", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
		persistUserMessage(pi.sent[0].text);
		await pi.emit("agent_start", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
	});

	test("a rebind drops a tracked batch instead of acking mail the old session lost", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		// Active: injected as a follow-up and tracked, not yet acknowledged.
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
		expect(hcom.acks()).toEqual([]);

		// OMP drops the queued message on a session switch. If the tracker
		// survived the rebind, the next run would acknowledge mail the old
		// session never consumed and the message would be lost for good.
		await pi.emit("session_switch", {}, ctx);
		await pi.emit("agent_start", {}, ctx);

		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);
	});

	test("a mixed batch takes the most urgent lane and delivers the queued passenger", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform"), message(102, "steer", "request")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "steer" });
		expect(pi.sent[0].text).toContain("body-101");
		expect(pi.sent[0].text).toContain("body-102");
		expect(hcom.acks()).toEqual(["101,102"]);
	});

	test("a mixed batch at idle is injected once as a prompt", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform"), message(102, "steer", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].text).toContain("body-101");
		expect(pi.sent[0].text).toContain("body-102");
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["101,102"]);
	});

	test("an unacknowledged batch is not re-injected, and new mail supersedes it", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(1);
		expect(hcom.acks()).toEqual([]);

		// Same unread batch, no new mail: nothing is sent again.
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(1);
		expect(hcom.acks()).toEqual([]);

		// Newer mail supersedes: only it is injected, and the ack names the union.
		// The follow-up reached the transcript, so the superseding steer's ack
		// may name both ids.
		persistUserMessage(pi.sent[0].text);
		hcom.mailbox.push(message(103, "steer", "request"));
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(2);
		expect(pi.sent[1].text).toContain("body-103");
		expect(pi.sent[1].text).not.toContain("body-101");
		expect(hcom.acks()).toEqual(["101,103"]);
	});

	test("a rejected ack keeps the batch tracked and is retried", async () => {
		const hcom = fakeHcom([message(101, "steer", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);
		hcom.setAckError("--ids incomplete: unread delivered messages missing from ack: [101]");

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		// The idle prompt reaches the transcript, so the ack is attempted.
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);

		hcom.setAckError(null);
		await pi.emit("before_agent_start", {}, ctx);
		expect(hcom.acks()).toEqual(["101", "101"]);
		expect(hcom.mailbox).toEqual([]);
	});

	test("the hidden bootstrap keeps its ownership marker", async () => {
		const hcom = fakeHcom();
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		const result = (await pi.emit("before_agent_start", {}, ctx)) as {
			message?: { customType?: string; display?: boolean };
		};
		expect(result?.message?.customType).toBe("hcom-bootstrap");
		expect(result?.message?.display).toBe(false);
	});

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
});

describe("idle-path persist gate", () => {
	// hcom-9tm: the idle prompt path acked AT INJECTION, so a session that is up
	// but cannot run a turn (expired auth, provider outage) consumed mail that
	// never reached a transcript. The cursor now waits for the same evidence the
	// followUp path owes. The injection itself stays immediate: only the cursor
	// waits, so the failure mode is a visible duplicate, never a silent loss.
	test("an idle injection whose turn never ran stays unread", async () => {
		const hcom = fakeHcom([message(101, "queue", "request"), message(102, "steer", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		// Immediate: an idle prompt is injected, never withheld for evidence.
		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].text).toContain("body-101");
		expect(pi.sent[0].text).toContain("body-102");

		// The session started no turn, so the transcript holds none of it. No
		// later trigger may move the cursor over mail no turn consumed.
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("before_agent_start", {}, ctx);
		await pi.emit("turn_end", {}, ctx);

		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101, 102]);
	});

	test("an idle injection the transcript kept advances the cursor by exact ids", async () => {
		const hcom = fakeHcom([message(101, "queue", "request"), message(102, "steer", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		// Immediate again, and the cursor has not moved yet: the write the turn
		// is about to make is what the ack is waiting for.
		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(hcom.acks()).toEqual([]);

		// The turn the prompt started writes it to the transcript, and the
		// boundary settles the batch by its exact ids.
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);

		expect(hcom.acks()).toEqual(["101,102"]);
		expect(hcom.mailbox).toEqual([]);
	});

	test("an idle injection whose turn never ran re-delivers after a rebind", async () => {
		const hcom = fakeHcom([message(101, "queue", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(1);
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);

		// Still unread at HCOM: the rebind drops the tracker, and the next wake
		// fetches the same message again. A duplicate the actor can see, never a
		// message the cursor swept past.
		await pi.emit("session_switch", {}, ctx);
		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(2);
		expect(pi.sent[1].text).toContain("body-101");
	});
});

describe("events-sub echo", () => {
	test("a notice quoting a message in the same batch is dropped", async () => {
		// midi #57749: one blob carried `[request #57665]` and, 6ms later, the
		// sys_[hcom-events] notice for that same event.
		const hcom = fakeHcom([
			message(57665, "steer", "request"),
			eventsNotice(57666, '[sub:sub-57665] #57665 message peer from:peer "body-57665"'),
		]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].text).toBe("<hcom>[request #57665] peer -> test: body-57665</hcom>");
		// An idle prompt owes transcript evidence before the cursor moves.
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["57665"]);
	});

	test("a notice naming an event outside the batch is still peer mail", async () => {
		const hcom = fakeHcom([
			message(57665, "steer", "request"),
			eventsNotice(57666, "[sub:sub-9] #57000 status sable listening"),
		]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].text).toContain("[2 new messages]");
		expect(pi.sent[0].text).toContain("[hcom-events]");
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["57665,57666"]);
	});

	test("a system row is recognized without the hcom-events sender name", async () => {
		const hcom = fakeHcom([
			message(57665, "steer", "request"),
			{ ...eventsNotice(57666, "#57665 echoed", "sys_watcher"), sender_kind: "system" },
		]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent[0].text).not.toContain("sys_watcher");
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		expect(hcom.acks()).toEqual(["57665"]);
	});

	test("the count and the ack describe the filtered batch, not the echo", async () => {
		const hcom = fakeHcom([
			message(57665, "steer", "request"),
			eventsNotice(57666, '[sub:sub-57665] #57665 message peer from:peer "body-57665"'),
			message(57667, "steer", "inform"),
		]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent[0].text).toContain("[2 new messages]");
		expect(pi.sent[0].text).not.toContain("[hcom-events]");
		expect(pi.sent[0].text).toContain("body-57667");
		persistUserMessage(pi.sent[0].text);
		await pi.emit("turn_end", {}, ctx);
		// 57666 sits below the batch's high-water id, and `ack_by_ids` rejects a
		// batch that omits an unread delivered message below it: naming the
		// discarded echo is what lets the cursor move at all.
		expect(hcom.acks()).toEqual(["57665,57666,57667"]);
		expect(hcom.mailbox).toEqual([]);
	});

	test("a fetch left with nothing but a dropped echo injects and acks nothing", async () => {
		const hcom = fakeHcom([message(57665, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		// The follow-up for 57665 is tracked but not acknowledged yet, so 57665
		// still rides the fetch when its notice lands.
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });

		hcom.mailbox.push(eventsNotice(57666, '[sub:sub-57665] #57665 message peer from:peer "body-57665"'));
		await pi.emit("tool_result", { toolName: "read" }, ctx);

		// Nothing new is injected: no bare `<hcom>` turn for a fetch whose only
		// new row was its own echo, and no ack of mail that was never injected.
		expect(pi.sent.length).toBe(1);
		expect(hcom.acks()).toEqual([]);
	});

	test("a bodyless wake carries the batch without the echo", async () => {
		// The wake transform renders the same blob the delivery path does, so the
		// echo has to be dropped there too.
		const hcom = fakeHcom([
			message(101, "queue", "request"),
			eventsNotice(102, '[sub:sub-101] #101 message peer from:peer "body-101"'),
		]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		const result = (await pi.emit("input", { text: "<hcom>", source: "user" }, ctx)) as { text?: string };

		expect(result.text).toBe("<hcom>[request #101] peer -> test: body-101</hcom>");
		await pi.emit("before_agent_start", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
	});
});

describe("hidden bootstrap shape", () => {
	const bothPrimers = { bootstrap: "BOOTSTRAP TEXT", bootstrap_participant: "PARTICIPANT TEXT" };
	const actorPrompt = ["Registered tools:", "- send_to_actor: deliver a message to a named actor"];

	async function injectBootstrap(
		pi: FakePi,
		ctx: ExtensionContext,
	): Promise<{ customType?: string; content?: string; display?: boolean } | undefined> {
		const result = (await pi.emit("before_agent_start", {}, ctx)) as {
			message?: { customType?: string; content?: string; display?: boolean };
		};
		return result?.message;
	}

	test("the participant primer is injected when the hook reports actor tools", async () => {
		const hcom = fakeHcom([], bothPrimers);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx, { deps: { hasSendToActor: true } });

		const message = await injectBootstrap(pi, ctx);

		expect(message?.content).toBe("PARTICIPANT TEXT");
		expect(message?.customType).toBe("hcom-bootstrap");
		expect(message?.display).toBe(false);
	});

	test("the full catalog is injected when the hook reports no actor tools", async () => {
		const hcom = fakeHcom([], bothPrimers);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx, { deps: { hasSendToActor: false } });

		expect((await injectBootstrap(pi, ctx))?.content).toBe("BOOTSTRAP TEXT");
	});

	test("the full catalog is injected when no tool surface names send_to_actor", async () => {
		const hcom = fakeHcom([], bothPrimers);
		const ctx = fakeCtx(true, { systemPrompt: ["You are a helpful coding agent."] });
		const pi = await start(hcom, ctx);

		expect((await injectBootstrap(pi, ctx))?.content).toBe("BOOTSTRAP TEXT");
	});

	test("a loader tool registry exposing send_to_actor selects the participant primer", async () => {
		const hcom = fakeHcom([], bothPrimers);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx, { tools: { has: (name) => name === "send_to_actor" } });

		expect((await injectBootstrap(pi, ctx))?.content).toBe("PARTICIPANT TEXT");
	});

	test("a system prompt naming send_to_actor selects the participant primer", async () => {
		const hcom = fakeHcom([], bothPrimers);
		const ctx = fakeCtx(true, { systemPrompt: actorPrompt });
		const pi = await start(hcom, ctx);

		expect((await injectBootstrap(pi, ctx))?.content).toBe("PARTICIPANT TEXT");
	});

	test("an omp-start without bootstrap_participant falls back to the full catalog", async () => {
		const hcom = fakeHcom([], { bootstrap: "BOOTSTRAP TEXT" });
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx, { deps: { hasSendToActor: true } });

		expect((await injectBootstrap(pi, ctx))?.content).toBe("BOOTSTRAP TEXT");
	});

	test("an empty bootstrap_participant falls back to the full catalog", async () => {
		const hcom = fakeHcom([], { bootstrap: "BOOTSTRAP TEXT", bootstrap_participant: "" });
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx, { deps: { hasSendToActor: true } });

		expect((await injectBootstrap(pi, ctx))?.content).toBe("BOOTSTRAP TEXT");
	});

	test("a rebind re-reads the primer instead of keeping the stale one", async () => {
		const startJson: Record<string, unknown> = { ...bothPrimers };
		const hcom = fakeHcom([], startJson);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx, { deps: { hasSendToActor: true } });
		expect((await injectBootstrap(pi, ctx))?.content).toBe("PARTICIPANT TEXT");

		delete startJson.bootstrap_participant;
		await pi.emit("session_switch", {}, ctx);

		expect((await injectBootstrap(pi, ctx))?.content).toBe("BOOTSTRAP TEXT");
	});
});

describe("bodyless wake", () => {
	test("carries a held queue batch without starting a turn of its own", async () => {
		const hcom = fakeHcom([message(101, "queue", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		const result = (await pi.emit("input", { text: "<hcom>", source: "user" }, ctx)) as { text?: string };

		expect(result.text).toContain("body-101");
		expect(pi.sent).toEqual([]);
		expect(hcom.acks()).toEqual([]);

		// The submission that carried the wake is the consuming turn.
		await pi.emit("before_agent_start", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
	});

	test("reports handled and injects nothing when there is no mail", async () => {
		const hcom = fakeHcom();
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		expect(await pi.emit("input", { text: "<hcom></hcom>", source: "user" }, ctx)).toEqual({ handled: true });
	});
});

describe("durable session", () => {
	test("persists the session before binding", async () => {
		const hcom = fakeHcom();
		let durable = false;
		const ctx = fakeCtx(true, {
			ensureOnDisk: async () => {
				durable = true;
			},
		});
		await start(hcom, ctx);

		expect(durable).toBe(true);
		expect(hcom.count("omp-start")).toBe(1);
	});

	test("fails closed when the session cannot be made durable", async () => {
		const hcom = fakeHcom();
		const ctx = fakeCtx(true, { ensureOnDisk: null });
		const pi = await start(hcom, ctx);

		expect(hcom.count("omp-start")).toBe(0);
		expect(await pi.emit("before_agent_start", {}, ctx)).toBeUndefined();
	});

	test("fails closed when the session file is still missing after persistence", async () => {
		const hcom = fakeHcom();
		const ctx = fakeCtx(true, { sessionFile: null });
		await start(hcom, ctx);

		expect(hcom.count("omp-start")).toBe(0);
	});
});

describe("identity latch", () => {
	test("a nested instance neither binds nor soft-stops the parent", async () => {
		const hcom = fakeHcom();
		const ctx = fakeCtx(true);
		await start(hcom, ctx);
		expect(hcom.count("omp-start")).toBe(1);

		const nested = fakePi();
		hcomExtension(nested.api, { runHcom: hcom.run });
		instances.push(nested);
		await nested.emit("session_start", {}, ctx);
		expect(hcom.count("omp-start")).toBe(1);

		await nested.emit("session_shutdown", {}, ctx);
		expect(hcom.count("omp-stop")).toBe(0);
	});
});

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

	it("queues a non-demanding active batch as a follow-up and acks only when its run starts", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = { messages: [{ from: "vase", intent: "inform", event_id: 301, message: "fyi" }] };
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.options).toEqual({ deliverAs: "followUp" });
		// A follow-up is drained by the next run, so the ack waits for that run.
		expect(calls.some((call) => call.args.includes("--ack"))).toBe(false);
		expect(mailbox.messages).toHaveLength(1);
		// The draining run writes the prompt to the transcript before it acks.
		persistUserMessage(pi.sent[0]!.text);
		await pi.handlers.get("agent_start")?.({}, ctx);
		const acks = calls.filter((call) => call.args[0] === "omp-read" && call.args.includes("--ack"));
		expect(acks).toHaveLength(1);
		expect(acks[0]?.args).toContain("301");
		expect(mailbox.messages).toHaveLength(0);
		await pi.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("settles a held follow-up ack at the turn boundary that persisted it", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = { messages: [{ from: "vase", intent: "inform", event_id: 501, message: "fyi" }] };
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		expect(pi.sent[0]?.options).toEqual({ deliverAs: "followUp" });
		// The draining run starts, then persists — the ack waits for the write.
		await pi.handlers.get("agent_start")?.({}, ctx);
		expect(calls.some((call) => call.args.includes("--ack"))).toBe(false);
		persistUserMessage(pi.sent[0]!.text);
		await pi.handlers.get("turn_end")?.({}, ctx);
		const acks = calls.filter((call) => call.args[0] === "omp-read" && call.args.includes("--ack"));
		expect(acks).toHaveLength(1);
		expect(acks[0]?.args).toContain("501");
		expect(mailbox.messages).toHaveLength(0);
		await pi.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("acks a follow-up whose persisted text the transcript had to escape", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = {
			messages: [{ from: "vase", intent: "inform", event_id: 601, message: 'line one\nline "two" — done' }],
		};
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		persistUserMessage(pi.sent[0]!.text);
		await pi.handlers.get("turn_end")?.({}, ctx);
		// Quote and newline escaping in the transcript must not hide the message.
		const acks = calls.filter((call) => call.args[0] === "omp-read" && call.args.includes("--ack"));
		expect(acks).toHaveLength(1);
		expect(acks[0]?.args).toContain("601");
		await pi.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("holds a combined follow-up batch until every message in it is persisted", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = {
			messages: [
				{ from: "vase", intent: "inform", event_id: 701, message: "first" },
				{ from: "kilo", intent: "inform", event_id: 702, message: "second" },
			],
		};
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		const combined = pi.sent[0]!.text;
		expect(combined).toContain("[2 new messages]");
		// Only the first of the pair reached the transcript so far.
		const [first] = combined.slice("<hcom>[2 new messages] | ".length, -"</hcom>".length).split(" | ");
		persistUserMessage(first!);
		await pi.handlers.get("turn_end")?.({}, ctx);
		// Acking now would advance the cursor over 702, which is nowhere on disk.
		expect(calls.some((call) => call.args.includes("--ack"))).toBe(false);
		persistUserMessage(combined);
		await pi.handlers.get("turn_end")?.({}, ctx);
		const acks = calls.filter((call) => call.args[0] === "omp-read" && call.args.includes("--ack"));
		expect(acks).toHaveLength(1);
		expect(acks[0]?.args).toContain("701,702");
		await pi.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("does not accept a transcript entry that predates the injection", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = { messages: [{ from: "vase", intent: "inform", event_id: 801, message: "fyi" }] };
		// An earlier delivery of this same mail is already on disk while the cursor
		// is still short of it: text alone would prove the wrong entry.
		persistUserMessage("<hcom>[inform #801] vase -> test: fyi</hcom>");
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		expect(pi.sent[0]?.options).toEqual({ deliverAs: "followUp" });
		await pi.handlers.get("turn_end")?.({}, ctx);
		expect(calls.some((call) => call.args.includes("--ack"))).toBe(false);
		persistUserMessage(pi.sent[0]!.text);
		await pi.handlers.get("turn_end")?.({}, ctx);
		const acks = calls.filter((call) => call.args[0] === "omp-read" && call.args.includes("--ack"));
		expect(acks).toHaveLength(1);
		expect(acks[0]?.args).toContain("801");
		await pi.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("keeps a queued follow-up's markers when a later batch rides the same ack", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = {
			messages: [{ from: "vase", intent: "inform", delivery: "queue", event_id: 901, message: "fyi" }],
		};
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		expect(pi.sent[0]?.options).toEqual({ deliverAs: "followUp" });
		// A steer-named message arrives while that follow-up is still queued.
		mailbox.messages = [
			{ from: "vase", intent: "inform", delivery: "queue", event_id: 901, message: "fyi" },
			{ from: "kilo", intent: "request", delivery: "steer", event_id: 902, message: "now" },
		];
		await pi.handlers.get("tool_result")?.({ toolName: "read" }, ctx);
		expect(pi.sent[1]?.options).toEqual({ deliverAs: "steer" });
		// The steer is consumed by the live run; 901 is still only queued.
		expect(calls.some((call) => call.args.includes("--ack"))).toBe(false);
		persistUserMessage(pi.sent[0]!.text);
		await pi.handlers.get("turn_end")?.({}, ctx);
		const acks = calls.filter((call) => call.args[0] === "omp-read" && call.args.includes("--ack"));
		expect(acks).toHaveLength(1);
		expect(acks[0]?.args).toContain("901,902");
		await pi.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("keeps an unpersisted follow-up unread so a recycle re-fetches it", async () => {
		const pi = fakePi();
		const idle = { value: false };
		const ctx = fakeCtx(idle);
		const calls: HcomCall[] = [];
		const mailbox = { messages: [{ from: "kilo", intent: "inform", event_id: 62951, message: "READY_FOR_REVIEW" }] };
		hcomExtension(pi as never, { runHcom: fakeRunHcom(calls, mailbox) });
		await pi.handlers.get("session_start")?.({}, ctx);
		await pi.handlers.get("agent_start")?.({}, ctx);
		await pi.handlers.get("turn_end")?.({}, ctx);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]?.options).toEqual({ deliverAs: "followUp" });
		// The follow-up's run starts BEFORE its prompt reaches the transcript.
		await pi.handlers.get("agent_start")?.({}, ctx);
		// Acking here would advance the cursor past mail the transcript never kept.
		expect(calls.some((call) => call.args.includes("--ack"))).toBe(false);
		expect(mailbox.messages).toHaveLength(1);
		// Recycle: this process stops, the pane resumes the same transcript.
		resetIdentity();
		const rebooted = fakePi();
		const rebootedCtx = fakeCtx(idle);
		const rebootedCalls: HcomCall[] = [];
		hcomExtension(rebooted as never, { runHcom: fakeRunHcom(rebootedCalls, mailbox) });
		await rebooted.handlers.get("session_start")?.({}, rebootedCtx);
		await rebooted.handlers.get("agent_start")?.({}, rebootedCtx);
		await rebooted.handlers.get("turn_end")?.({}, rebootedCtx);
		// Unread at HCOM, so the new process re-reads it instead of dropping it.
		expect(rebooted.sent).toHaveLength(1);
		expect(rebooted.sent[0]?.text).toContain("#62951");
		await pi.handlers.get("session_shutdown")?.({}, ctx);
		await rebooted.handlers.get("session_shutdown")?.({}, rebootedCtx);
	});
});
