import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";

const HCOM_DIR = process.env.HCOM_DIR || `${homedir()}/.hcom`;
const LOG_PATH = `${HCOM_DIR}/.tmp/logs/hcom.log`;

type HcomResult = {
	code: number;
	stdout: string;
	stderr: string;
};

function log(
	level: "DEBUG" | "INFO" | "WARN" | "ERROR",
	event: string,
	instance?: string | null,
	extra?: Record<string, unknown>,
) {
	const entry = JSON.stringify({
		ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		level,
		subsystem: "plugin",
		event,
		...(instance ? { instance } : {}),
		...extra,
	});
	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		appendFileSync(LOG_PATH, `${entry}\n`);
	} catch {}
}

function hcom(args: string[]): Promise<HcomResult> {
	return new Promise((resolve) => {
		const child = spawn("hcom", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error) }));
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}

function formatMessagesForInjection(messages: any[], recipientName: string): string {
	const parts = messages.map((m: any) => {
		const prefix = m.intent
			? m.thread
				? `[${m.intent}:${m.thread} #${m.event_id}]`
				: `[${m.intent} #${m.event_id}]`
			: m.thread
				? `[thread:${m.thread} #${m.event_id}]`
				: `[new message #${m.event_id}]`;
		return `${prefix} ${m.from} -> ${recipientName}: ${m.message}`;
	});
	if (messages.length === 1) return `<hcom>${parts[0]}</hcom>`;
	return `<hcom>[${messages.length} new messages] | ${parts.join(" | ")}</hcom>`;
}

function isBodylessWake(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "<hcom>" || trimmed === "<hcom></hcom>";
}

/** A message as returned by `pi-read` (the subset this plugin reads). */
export type PendingMessage = {
	event_id?: number;
	from?: string;
	message?: string;
	thread?: string;
	intent?: string;
	delivery?: string;
};

export type DeliveryLane = "auto" | "steer" | "queue";

/** Lane urgency; a batch resolves to its most urgent lane. */
const LANE_RANK: Record<DeliveryLane, number> = { queue: 1, auto: 2, steer: 3 };

/** `"hold"` = inject nothing and ack nothing. Otherwise the exact `sendUserMessage` options. */
export type InjectionPlan = "hold" | { deliverAs?: "steer" | "followUp" };

function laneOf(message: PendingMessage): DeliveryLane {
	// Absent (legacy row) or unknown lane degrades to "auto".
	if (message.delivery === "steer" || message.delivery === "queue") return message.delivery;
	return "auto";
}

/**
 * Lane-aware plan for one unread batch.
 *
 * - `queue` at an idle session is HELD: injecting it would start a turn the
 *   sender did not ask for. It is delivered by the next trigger that finds a
 *   turn already in flight (or a bodyless wake carrying it).
 * - At idle a non-held batch is injected with NO `deliverAs`, so
 *   `sendUserMessage` takes the `prompt()` path and starts the consuming turn
 *   synchronously.
 * - With a turn in flight, `steer` — and any demanding `auto` batch — interrupts
 *   it; non-demanding `auto` and `queue` wait for the turn to end.
 */
export function decideInjection(messages: PendingMessage[], isIdle: boolean): InjectionPlan {
	if (messages.length === 0) return "hold";
	let lane: DeliveryLane = "queue";
	for (const message of messages) {
		const candidate = laneOf(message);
		if (LANE_RANK[candidate] > LANE_RANK[lane]) lane = candidate;
	}
	if (isIdle) return lane === "queue" ? "hold" : {};
	// Absent intent is demanding; only an explicit `inform`/`ack` is not.
	const demanding = messages.some((message) => message.intent !== "inform" && message.intent !== "ack");
	return lane === "steer" || (lane === "auto" && demanding) ? { deliverAs: "steer" } : { deliverAs: "followUp" };
}

/**
 * Exact event ids injected so far, including a still-unacknowledged earlier
 * batch. `pi-read` has no `--ids` ack, so this is only the in-memory record of
 * what may be swept by the `--up-to` high-water mark.
 */
function injectedIds(prior: PendingAck | null, messages: PendingMessage[]): number[] {
	const ids = new Set<number>(prior?.ids ?? []);
	for (const message of messages) {
		const id = Number(message.event_id);
		if (Number.isInteger(id) && id > 0) ids.add(id);
	}
	return [...ids].sort((a, b) => a - b);
}

/** A batch with `pi-read --ack` still owed. */
type PendingAck = {
	ids: number[];
	/** High-water id, the `--up-to` cursor `pi-read --ack` acknowledges through. */
	maxId: number;
};

/** Test seam: the plugin's only external dependency. */
export type HcomDeps = {
	runHcom?: (args: string[]) => Promise<HcomResult>;
};

export default function hcomExtension(pi: ExtensionAPI, deps: HcomDeps = {}) {
	const runHcom = deps.runHcom ?? hcom;
	let instanceName: string | null = null;
	let sessionId: string | null = null;
	let bootstrapText: string | null = null;
	let bindingPromise: Promise<void> | null = null;
	let notifyServer: Server | null = null;
	let notifyPort: number | null = null;
	let currentCtx: ExtensionContext | null = null;
	let pendingAck: PendingAck | null = null;
	let deliveryInFlight = false;
	let deliveryPending = false; // a wake arrived while delivery was gated; replay it once clear
	let deliveryRetryScheduled = false; // dedup the queued replay pass
	let reconcileTimer: ReturnType<typeof setInterval> | null = null;
	let reconcileInFlight = false;
	let bootstrapInjectedForSession: string | null = null;
	let lastReportedStatusKey: string | null = null;
	let lastPendingPollAt = 0;
	let agentActive = false;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	const PENDING_POLL_MS = 60_000;
	const FALLBACK_PENDING_POLL_MS = 5_000;
	const IDLE_DEBOUNCE_MS = 250;

	function statusKey(status: string, context: string, detail: string): string {
		return `${status}\0${context}\0${detail}`;
	}

	function isBoundSession(candidateSessionId?: string | null): boolean {
		return !candidateSessionId || !sessionId || candidateSessionId === sessionId;
	}

	function startNotifyServer(): Promise<number | null> {
		if (notifyServer && notifyPort) return Promise.resolve(notifyPort);
		return new Promise((resolve) => {
			const server = createServer((socket) => {
				socket.end();
				log("DEBUG", "notify_server.wake", instanceName, { pending_ack: pendingAck?.ids ?? null });
				if (currentCtx) void deliverPending(currentCtx);
			});
			server.on("error", (error) => {
				log("ERROR", "notify_server.start_failed", instanceName, { error: String(error) });
				resolve(null);
			});
			server.listen(0, "127.0.0.1", () => {
				notifyServer = server;
				const address = server.address();
				notifyPort = typeof address === "object" && address ? address.port : null;
				log("INFO", "notify_server.started", instanceName, { port: notifyPort });
				resolve(notifyPort);
			});
		});
	}

	function stopNotifyServer(): void {
		if (notifyServer) {
			try {
				notifyServer.close();
			} catch {}
		}
		notifyServer = null;
		notifyPort = null;
	}

	async function bindIdentity(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx;
		if (instanceName || bindingPromise) return bindingPromise ?? Promise.resolve();
		if (process.env.HCOM_LAUNCHED !== "1") return;
		bindingPromise = (async () => {
			try {
				const sid = ctx.sessionManager.getSessionId();
				const transcriptPath = ctx.sessionManager.getSessionFile();
				const port = await startNotifyServer();
				const args = ["pi-start", "--session-id", sid, "--cwd", ctx.cwd];
				if (transcriptPath) args.push("--transcript-path", transcriptPath);
				if (port) args.push("--notify-port", String(port));
				const result = await runHcom(args);
				if (result.code !== 0) {
					stopNotifyServer();
					log("WARN", "plugin.bind_failed", null, { exit_code: result.code, stderr: result.stderr.slice(0, 300) });
					return;
				}
				const json = JSON.parse(result.stdout || "{}");
				if (json.error) {
					stopNotifyServer();
					log("WARN", "plugin.bind_failed", null, { error: json.error });
					return;
				}
				instanceName = json.name;
				sessionId = json.session_id || sid;
				bootstrapText = typeof json.bootstrap === "string" ? json.bootstrap : null;
				log("INFO", "plugin.bound", instanceName, {
					session_id: sessionId,
					notify_port: port,
					bootstrap_len: bootstrapText?.length ?? 0,
				});
			} catch (error) {
				stopNotifyServer();
				log("ERROR", "plugin.bind_error", null, { error: String(error) });
			} finally {
				bindingPromise = null;
			}
		})();
		await bindingPromise;
	}

	async function fetchPending(): Promise<{ messages: PendingMessage[]; maxId: number } | null> {
		if (!instanceName) return null;
		const result = await runHcom(["pi-read", "--name", instanceName]);
		if (result.code !== 0) {
			log("WARN", "plugin.delivery_read_failed", instanceName, { exit_code: result.code, stderr: result.stderr.slice(0, 300) });
			return null;
		}
		let messages: PendingMessage[] = [];
		try {
			messages = JSON.parse(result.stdout || "[]");
		} catch (error) {
			log("WARN", "plugin.delivery_parse_failed", instanceName, { error: String(error), raw: result.stdout.slice(0, 300) });
			return null;
		}
		if (!Array.isArray(messages) || messages.length === 0) return null;
		const maxId = Math.max(...messages.map((m) => m.event_id || 0));
		if (maxId <= 0) return null;
		return { messages, maxId };
	}

	async function deliverPending(ctx: ExtensionContext): Promise<boolean> {
		currentCtx = ctx;
		await bindIdentity(ctx);
		if (!instanceName || !sessionId) return false;
		if (!isBoundSession(ctx.sessionManager.getSessionId())) return false;
		if (deliveryInFlight) {
			// A delivery is mid-flight. Drop nothing: record the wake so it is
			// replayed once clear, otherwise a message that arrives in this window
			// stays unread until an unrelated later wake (reconcile is idle-gated).
			deliveryPending = true;
			log("DEBUG", "plugin.delivery_skipped", instanceName, {
				reason: "delivery_in_flight",
				pending_ack: pendingAck?.ids ?? null,
				queued: true,
			});
			return false;
		}
		deliveryInFlight = true;
		try {
			const pending = await fetchPending();
			if (!pending) return false;
			const prior = pendingAck;
			// A deferred batch is already in the model's context; only newer mail is
			// injected, and the ack keeps naming both (newest supersedes, oldest is
			// never silently swept under the cursor).
			const tracked = new Set(prior?.ids ?? []);
			const fresh = pending.messages.filter((message) => !tracked.has(Number(message.event_id)));
			if (fresh.length === 0) return false;
			const isIdle = ctx.isIdle();
			const plan = decideInjection(fresh, isIdle);
			if (plan === "hold") {
				log("DEBUG", "plugin.delivery_held", instanceName, {
					count: fresh.length,
					ids: injectedIds(null, fresh),
					idle: isIdle,
				});
				return false;
			}
			const batch: PendingAck = { ids: injectedIds(prior, pending.messages), maxId: pending.maxId };
			pendingAck = batch;
			try {
				const formatted = formatMessagesForInjection(fresh, instanceName);
				pi.sendUserMessage(formatted, plan.deliverAs ? { deliverAs: plan.deliverAs } : undefined);
				const sender = String(fresh[0]?.from ?? "");
				await reportStatus(ctx, "active", sender ? `deliver:${sender}` : "deliver");
				log("INFO", "plugin.delivery_pending", instanceName, {
					count: fresh.length,
					ids: batch.ids,
					idle: isIdle,
					deliver_as: plan.deliverAs ?? null,
				});
				// A steer (always into a live run) is consumed by that run's steering
				// poll; no `deliverAs` means `sendUserMessage` took the `prompt()`
				// path and the message IS the turn. Either way the batch is consumed
				// now. A `followUp` waits for the run that drains it.
				if (plan.deliverAs !== "followUp") await ackPending("delivery");
				return true;
			} catch (error) {
				if (pendingAck === batch) pendingAck = prior;
				log("ERROR", "plugin.delivery_send_failed", instanceName, { error: String(error) });
				return false;
			}
		} finally {
			deliveryInFlight = false;
			drainPendingDelivery("delivery_in_flight_wake");
		}
	}

	// Replay a wake that was queued while delivery was gated. The microtask +
	// dedup flag collapse a burst of queued wakes into one pass.
	function schedulePendingDelivery(reason: string): void {
		if (deliveryRetryScheduled) return;
		deliveryRetryScheduled = true;
		log("DEBUG", "plugin.delivery_retry_scheduled", instanceName, { reason });
		queueMicrotask(() => {
			deliveryRetryScheduled = false;
			if (!instanceName || !currentCtx) return;
			void deliverPending(currentCtx);
		});
	}

	function drainPendingDelivery(reason: string): void {
		if (deliveryPending && !deliveryInFlight) {
			deliveryPending = false;
			schedulePendingDelivery(reason);
		}
	}

	/**
	 * Ack the tracked batch through its high-water id. `pi-read` has no `--ids`
	 * affordance, so the cursor advances to the newest injected message; the
	 * tracker is dropped only after the call succeeds, so a failed ack is retried
	 * by the next trigger rather than silently losing mail.
	 */
	async function ackPending(source: string): Promise<void> {
		const batch = pendingAck;
		if (!instanceName || batch === null) return;
		const result = await runHcom(["pi-read", "--name", instanceName, "--ack", "--up-to", String(batch.maxId)]);
		if (result.code !== 0) {
			log("WARN", "plugin.delivery_ack_failed", instanceName, {
				ids: batch.ids,
				source,
				exit_code: result.code,
				stderr: result.stderr.slice(0, 300),
			});
			return;
		}
		// Keep the tracker until the durable acknowledgement succeeded; a reset or a
		// newer batch superseding this one must not be clobbered by a late reply.
		if (pendingAck !== batch) return;
		pendingAck = null;
		log("INFO", "plugin.deferred_ack", instanceName, { acked: batch.ids.length, acked_to: batch.maxId, source });
		// The extension-input ack path acks outside deliverPending; replay any wake
		// that was gated while this batch was tracked.
		drainPendingDelivery("post_ack_wake");
	}

	async function reportStatus(ctx: ExtensionContext, status: "active" | "listening", context = "", detail = ""): Promise<void> {
		await bindIdentity(ctx);
		if (!instanceName) return;
		const args = ["pi-status", "--name", instanceName, "--status", status];
		if (context) args.push("--context", context);
		if (detail) args.push("--detail", detail);
		await runHcom(args);
		lastReportedStatusKey = statusKey(status, context, detail);
	}

	async function reportReconciledStatus(ctx: ExtensionContext): Promise<void> {
		const key = statusKey("listening", "", "");
		if (lastReportedStatusKey !== key) {
			await reportStatus(ctx, "listening");
		}
	}

	async function pollPendingIfDue(ctx: ExtensionContext): Promise<void> {
		const now = Date.now();
		const interval = notifyPort ? PENDING_POLL_MS : FALLBACK_PENDING_POLL_MS;
		if (now - lastPendingPollAt < interval) return;
		lastPendingPollAt = now;
		await deliverPending(ctx);
	}

	function clearIdleTimer(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	}

	async function reconcile(): Promise<void> {
		if (reconcileInFlight || !currentCtx || !instanceName) return;
		reconcileInFlight = true;
		try {
			if (currentCtx.isIdle()) {
				await reportReconciledStatus(currentCtx);
				await pollPendingIfDue(currentCtx);
			}
		} catch (error) {
			log("ERROR", "plugin.reconcile_error", instanceName, { error: String(error) });
		} finally {
			reconcileInFlight = false;
		}
	}

	function startReconcileTimer(): void {
		if (!reconcileTimer) reconcileTimer = setInterval(() => void reconcile(), 5_000);
	}

	function resetBinding(): void {
		stopNotifyServer();
		instanceName = null;
		sessionId = null;
		bootstrapText = null;
		bindingPromise = null;
		pendingAck = null;
		deliveryInFlight = false;
		deliveryPending = false;
		deliveryRetryScheduled = false;
		bootstrapInjectedForSession = null;
		lastReportedStatusKey = null;
		lastPendingPollAt = 0;
		agentActive = false;
		clearIdleTimer();
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		resetBinding();
		await bindIdentity(ctx);
		startReconcileTimer();
	});

	pi.on("session_shutdown", async (event) => {
		if (instanceName) {
			await runHcom(["pi-stop", "--name", instanceName, "--reason", event.reason ?? "shutdown"]);
		}
		resetBinding();
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		clearIdleTimer();
		agentActive = true;
		// A tracked batch is a follow-up injected with an explicit `deliverAs`; its
		// consuming run begins here. `before_agent_start` fires only inside the
		// prompt path, so a follow-up drained at idle is acknowledged here instead.
		if (pendingAck !== null) await ackPending("agent_start");
		await reportStatus(ctx, "active", "agent");
	});

	pi.on("input", async (event: InputEvent, ctx) => {
		currentCtx = ctx;
		await bindIdentity(ctx);
		if (!instanceName) return { action: "continue" };
		if (event.source === "extension") {
			await ackPending(event.streamingBehavior ?? "extension");
			return { action: "continue" };
		}
		if (isBodylessWake(event.text)) {
			const pending = await fetchPending();
			const prior = pendingAck;
			const tracked = new Set(prior?.ids ?? []);
			const fresh = (pending?.messages ?? []).filter((message) => !tracked.has(Number(message.event_id)));
			if (!pending || fresh.length === 0) return { action: "handled" };
			// The submission carrying this wake IS the consuming turn, so even a
			// `queue` batch held at idle rides the transform instead of starting a
			// turn of its own.
			pendingAck = { ids: injectedIds(prior, pending.messages), maxId: pending.maxId };
			return { action: "transform", text: formatMessagesForInjection(fresh, instanceName) };
		}
		await reportStatus(ctx, "active", event.text.trim() === "<hcom>" ? "trigger" : "prompt");
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		await bindIdentity(ctx);
		if (!instanceName) return undefined;
		// Ack a tracked batch whose consuming turn is this prompt. The input handler
		// sets the tracker and returns the transform inline; a follow-up drained at
		// idle takes the agent_start path instead.
		if (pendingAck !== null) await ackPending("before_agent_start");
		if (!bootstrapText) return undefined;
		const sid = ctx.sessionManager.getSessionId();
		if (bootstrapInjectedForSession === sid) return undefined;
		bootstrapInjectedForSession = sid;
		log("DEBUG", "plugin.hidden_bootstrap", instanceName, { bootstrap_len: bootstrapText.length });
		return {
			message: {
				customType: "hcom-bootstrap",
				content: bootstrapText,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		currentCtx = ctx;
		await bindIdentity(ctx);
		if (!instanceName) return undefined;
		await reportStatus(ctx, "active", `tool:${event.toolName}`, String((event.input as any)?.path ?? (event.input as any)?.command ?? ""));
		const result = await runHcom([
			"pi-beforetool",
			"--name",
			instanceName,
			"--tool",
			event.toolName,
			"--input-json",
			JSON.stringify(event.input ?? {}),
		]);
		try {
			const json = JSON.parse(result.stdout || "{}");
			if (json.decision === "block") {
				return { block: true, reason: String(json.reason || "Blocked by hcom") };
			}
		} catch {}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		currentCtx = ctx;
		await reportStatus(ctx, "active", `tool:${event.toolName}`);
		await deliverPending(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		await deliverPending(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		if (!agentActive) return;
		agentActive = false;
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (currentCtx?.isIdle()) {
				void (async () => {
					await reportStatus(currentCtx, "listening");
					await deliverPending(currentCtx);
				})();
			}
		}, IDLE_DEBOUNCE_MS);
		idleTimer.unref?.();
	});
}
