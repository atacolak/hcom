// The plugin reads HCOM_DIR/LOG_PATH into module constants at load, so the
// environment must be in place before the module is evaluated — the one case
// static imports cannot express.
process.env.HCOM_DIR = mkdtempSync(join(tmpdir(), "hcom-plugin-test-"));
process.env.HCOM_LAUNCHED = "1";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
// Type-only: erased at runtime, so it does not defeat the dynamic import below.
import type { HcomDeps, PendingMessage } from "./hcom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
	const sessionFile = options.sessionFile === undefined ? "/tmp/sid-1.jsonl" : options.sessionFile;
	const manager: Record<string, unknown> = {
		getSessionId: () => "sid-1",
		getSessionFile: () => sessionFile,
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

	test("auto is demanding unless the intent is inform/ack", () => {
		expect(decideInjection([message(1, "auto", "request")], false)).toEqual({ deliverAs: "steer" });
		expect(decideInjection([message(1, "auto", "inform")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "auto", "ack")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("absent lane and absent intent both degrade to demanding auto", () => {
		expect(decideInjection([message(1)], false)).toEqual({ deliverAs: "steer" });
		expect(decideInjection([message(1, undefined, "inform")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("a non-queue batch starts a turn when idle", () => {
		expect(decideInjection([message(1, "auto", "request")], true)).toEqual({});
		expect(decideInjection([message(1, "auto", "inform")], true)).toEqual({});
	});

	test("queue never starts a turn but rides a live one", () => {
		expect(decideInjection([message(1, "queue", "request")], true)).toBe("hold");
		expect(decideInjection([message(1, "queue", "request")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("a batch resolves to its most urgent lane", () => {
		expect(decideInjection([message(1, "queue", "inform"), message(2, "steer", "inform")], true)).toEqual({});
		expect(decideInjection([message(1, "queue", "inform"), message(2, "auto", "inform")], false)).toEqual({
			deliverAs: "followUp",
		});
		expect(decideInjection([message(1, "queue", "inform"), message(2, "auto", "request")], false)).toEqual({
			deliverAs: "steer",
		});
		// Demandingness is a property of the whole batch, not of the loudest lane.
		expect(decideInjection([message(1, "queue", "request"), message(2, "auto", "inform")], false)).toEqual({
			deliverAs: "steer",
		});
	});
});

describe("lane-aware delivery", () => {
	test("idle demanding mail is injected as a prompt and acked by exact ids", async () => {
		const hcom = fakeHcom([message(101, "auto", "request"), message(102, "auto", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].text).toContain("body-101");
		expect(pi.sent[0].text).toContain("body-102");
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

	test("non-demanding auto waits for the turn and is acked when that run starts", async () => {
		const hcom = fakeHcom([message(101, "auto", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);

		await pi.emit("agent_start", {}, ctx);
		expect(hcom.acks()).toEqual(["101"]);
	});

	test("queue mail is held at idle and never injected or acked", async () => {
		const hcom = fakeHcom([message(101, "queue", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent).toEqual([]);
		expect(hcom.acks()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);
	});

	test("queue mail rides a live run as a follow-up", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
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
		const hcom = fakeHcom([message(101, "queue", "inform"), message(102, "auto", "request")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toEqual({ deliverAs: "steer" });
		expect(pi.sent[0].text).toContain("body-101");
		expect(pi.sent[0].text).toContain("body-102");
		expect(hcom.acks()).toEqual(["101,102"]);
	});

	test("an unacknowledged batch is not re-injected, and new mail supersedes it", async () => {
		const hcom = fakeHcom([message(101, "auto", "inform")]);
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
		hcom.mailbox.push(message(103, "steer", "request"));
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(2);
		expect(pi.sent[1].text).toContain("body-103");
		expect(pi.sent[1].text).not.toContain("body-101");
		expect(hcom.acks()).toEqual(["101,103"]);
	});

	test("a rejected ack keeps the batch tracked and is retried", async () => {
		const hcom = fakeHcom([message(101, "auto", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);
		hcom.setAckError("--ids incomplete: unread delivered messages missing from ack: [101]");

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
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
