// The plugin reads HCOM_DIR/LOG_PATH into module constants at load, so the
// environment must be in place before the module is evaluated — the one case
// static imports cannot express.
process.env.HCOM_DIR = mkdtempSync(join(tmpdir(), "hcom-pi-plugin-test-"));
process.env.HCOM_LAUNCHED = "1";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// Type-only: erased at runtime, so it does not defeat the dynamic import below.
import type { PendingMessage } from "./hcom.ts";
import { afterEach, describe, expect, test } from "bun:test";
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
	/** Every `pi-read --ack` cursor the plugin advanced to. */
	ackedTo: () => number[];
	count: (command: string) => number;
	setAckFailure: (exitCode: number) => void;
};

function fakePi(): FakePi {
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
		},
	};
	async function emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
		return last;
	}
	return { api: api as unknown as ExtensionAPI, sent, emit };
}

function fakeCtx(idle: boolean): ExtensionContext {
	// `ExtensionContext` carries the full SDK surface; only these members are used.
	return {
		cwd: "/repo",
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/tmp/sid-1.jsonl" },
	} as unknown as ExtensionContext;
}

function fakeHcom(initial: PendingMessage[] = []): FakeHcom {
	const mailbox = [...initial];
	const calls: string[][] = [];
	let ackExitCode = 0;
	const ok = (value: unknown): HcomResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
	async function run(args: string[]): Promise<HcomResult> {
		calls.push(args);
		if (args[0] === "pi-start") {
			return ok({ name: "test", session_id: "sid-1", bootstrap: "BOOTSTRAP TEXT" });
		}
		if (args[0] !== "pi-read") return ok({});
		if (!args.includes("--ack")) return ok(mailbox);
		if (ackExitCode !== 0) return { code: ackExitCode, stdout: "", stderr: "ack failed" };
		const upTo = Number(args[args.indexOf("--up-to") + 1]);
		for (let i = mailbox.length - 1; i >= 0; i--) {
			if (Number(mailbox[i].event_id) <= upTo) mailbox.splice(i, 1);
		}
		return ok({ acked_to: upTo });
	}
	return {
		run,
		mailbox,
		setAckFailure(exitCode) {
			ackExitCode = exitCode;
		},
		ackedTo: () =>
			calls
				.filter((args) => args[0] === "pi-read" && args.includes("--ack"))
				.map((args) => Number(args[args.indexOf("--up-to") + 1])),
		count: (command) => calls.filter((args) => args[0] === command).length,
	};
}

function message(eventId: number, delivery?: string, intent?: string): PendingMessage {
	return { event_id: eventId, from: "peer", message: `body-${eventId}`, delivery, intent };
}

let instances: FakePi[] = [];

/** Bring up a bound extension instance against one fake hcom. */
async function start(hcom: FakeHcom, ctx: ExtensionContext): Promise<FakePi> {
	const pi = fakePi();
	hcomExtension(pi.api, { runHcom: hcom.run });
	instances.push(pi);
	await pi.emit("session_start", {}, ctx);
	return pi;
}

afterEach(async () => {
	for (const pi of instances) await pi.emit("session_shutdown", { reason: "test" }, fakeCtx(true));
	instances = [];
});

describe("decideInjection", () => {
	test("holds an empty batch, steers a live run, and never starts a turn for queue", () => {
		expect(decideInjection([], true)).toBe("hold");
		expect(decideInjection([message(1, "steer", "inform")], false)).toEqual({ deliverAs: "steer" });
		expect(decideInjection([message(1, "queue", "request")], true)).toBe("hold");
		expect(decideInjection([message(1, "queue", "request")], false)).toEqual({ deliverAs: "followUp" });
	});

	test("demandingness covers the whole batch and absent fields are demanding auto", () => {
		expect(decideInjection([message(1)], false)).toEqual({ deliverAs: "steer" });
		expect(decideInjection([message(1, "auto", "inform")], false)).toEqual({ deliverAs: "followUp" });
		expect(decideInjection([message(1, "queue", "request"), message(2, "auto", "inform")], false)).toEqual({
			deliverAs: "steer",
		});
		expect(decideInjection([message(1, "auto", "inform")], true)).toEqual({});
	});
});

describe("lane-aware delivery", () => {
	test("idle demanding mail is injected as a prompt and acked through its high-water id", async () => {
		const hcom = fakeHcom([message(101, "auto", "request"), message(102, "auto", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent.length).toBe(1);
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].text).toContain("body-101");
		expect(hcom.ackedTo()).toEqual([102]);
		expect(hcom.mailbox).toEqual([]);
	});

	test("steer into a live run is injected as steer and acked immediately", async () => {
		const hcom = fakeHcom([message(101, "steer", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent[0].options).toEqual({ deliverAs: "steer" });
		expect(hcom.ackedTo()).toEqual([101]);
	});

	test("non-demanding auto waits for the run that drains it", async () => {
		const hcom = fakeHcom([message(101, "auto", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
		expect(hcom.ackedTo()).toEqual([]);

		await pi.emit("agent_start", {}, ctx);
		expect(hcom.ackedTo()).toEqual([101]);
	});

	test("a rebound session drops a tracked batch instead of acking mail it lost", async () => {
		const hcom = fakeHcom([message(101, "queue", "inform")]);
		const ctx = fakeCtx(false);
		const pi = await start(hcom, ctx);

		// Active: injected as a follow-up and tracked, not yet acknowledged.
		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent[0].options).toEqual({ deliverAs: "followUp" });
		expect(hcom.ackedTo()).toEqual([]);

		// A new session drops the queued message. If the tracker survived the
		// rebind, the next run would advance the cursor past mail the old
		// session never consumed and the message would be lost for good.
		await pi.emit("session_start", {}, ctx);
		await pi.emit("agent_start", {}, ctx);

		expect(hcom.ackedTo()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);
	});

	test("queue mail is held at idle and never injected", async () => {
		const hcom = fakeHcom([message(101, "queue", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		await pi.emit("tool_result", { toolName: "read" }, ctx);

		expect(pi.sent).toEqual([]);
		expect(hcom.ackedTo()).toEqual([]);
		expect(hcom.mailbox.map((m) => m.event_id)).toEqual([101]);
	});

	test("an injected-but-unacked batch is not re-injected when the ack fails", async () => {
		const hcom = fakeHcom([message(101, "auto", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);
		hcom.setAckFailure(1);

		await pi.emit("tool_result", { toolName: "read" }, ctx);
		expect(pi.sent.length).toBe(1);
		expect(hcom.ackedTo()).toEqual([101]);

		// The cursor never moved, so the batch is still unread — it must not be
		// injected a second time, and the retry must ack the same cursor.
		hcom.setAckFailure(0);
		await pi.emit("before_agent_start", {}, ctx);
		expect(pi.sent.length).toBe(1);
		expect(hcom.ackedTo()).toEqual([101, 101]);
		expect(hcom.mailbox).toEqual([]);
	});
});

describe("wake and bootstrap", () => {
	test("the bodyless wake carries mail and is acked by the turn it triggers", async () => {
		const hcom = fakeHcom([message(101, "queue", "request")]);
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		const result = (await pi.emit("input", { text: "<hcom>", source: "user" }, ctx)) as { text?: string };

		expect(result.text).toContain("body-101");
		expect(pi.sent).toEqual([]);
		expect(hcom.ackedTo()).toEqual([]);

		const bootstrap = (await pi.emit("before_agent_start", {}, ctx)) as {
			message?: { customType?: string; content?: string };
		};
		expect(hcom.ackedTo()).toEqual([101]);
		expect(bootstrap?.message?.customType).toBe("hcom-bootstrap");
		expect(bootstrap?.message?.content).toBe("BOOTSTRAP TEXT");
	});

	test("a wake with no mail reports handled", async () => {
		const hcom = fakeHcom();
		const ctx = fakeCtx(true);
		const pi = await start(hcom, ctx);

		expect(await pi.emit("input", { text: "<hcom></hcom>", source: "user" }, ctx)).toEqual({ action: "handled" });
	});
});
