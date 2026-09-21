import type { ExtensionAPI, ExtensionContext, InputEvent } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
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

const HCOM_TIMEOUT_MS = 1800;

function hcom(args: string[]): Promise<HcomResult> {
	return new Promise((resolve) => {
		const child = spawn("hcom", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(124);
		}, HCOM_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			stderr = stderr || String(error);
			finish(127);
		});
		child.on("close", (code) => finish(code === null ? 1 : code));
	});
}

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

function isBodylessWake(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "<hcom>" || trimmed === "<hcom></hcom>";
}

/** A message as returned by `omp-read` (the subset this plugin reads). */
export type PendingMessage = {
	event_id?: number;
	from?: string;
	message?: string;
	thread?: string;
	intent?: string;
	delivery?: string;
	/** Stored on the row (`[hcom-events]` notices carry `system`); today's
	 * `omp-read` projection omits it, so `from` is the usual handle. */
	sender_kind?: string;
};

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
 * At an idle session there is no turn to wait for, so BOTH lanes are delivered
 * with NO `deliverAs`: `sendUserMessage` takes the `prompt()` path and starts
 * the consuming turn synchronously. Holding `queue` there would deadlock on the
 * very mail that must start that turn.
 * - The lanes differ ONLY while a turn is in flight: `steer` interrupts it,
 *   `queue` waits for the boundary. Intent never promotes a lane — a steer is
 *   never inferred from a demanding message arriving at a busy actor.
 */
export function decideInjection(messages: PendingMessage[], isIdle: boolean): InjectionPlan {
	if (messages.length === 0) return "hold";
	let lane: DeliveryLane = "queue";
	for (const message of messages) {
		const candidate = laneOf(message);
		if (LANE_RANK[candidate] > LANE_RANK[lane]) lane = candidate;
	}
	if (isIdle) return {};
	return lane === "steer" ? { deliverAs: "steer" } : { deliverAs: "followUp" };
}

/** Event ids a notice names as `#<id>`; the CLI renders the event it reports that way. */
function referencedEventIds(text: string): number[] {
	const ids: number[] = [];
	for (const match of text.matchAll(/#(\d+)/g)) {
		const id = Number(match[1]);
		if (Number.isInteger(id) && id > 0) ids.push(id);
	}
	return ids;
}

/**
 * Whether this row is the events-sub notice for an event the same fetch already
 * carries: a `sys_[hcom-events]` row quoting `#<id>` of a row next to it.
 *
 * The notice is real mail (`send_sub_notification` writes it milliseconds after
 * the event it reports), so an unfiltered batch hands the recipient its own
 * subscription echo as peer mail (midi #57749). A notice naming an event the
 * fetch does not carry is the only copy of that news, and is kept.
 */
function isSubscriptionEcho(message: PendingMessage, carried: Set<number>): boolean {
	// Every system notice today is from `[hcom-events]`; `sender_kind` is the
	// row's own marking of the same thing.
	if (message.from !== "[hcom-events]" && message.sender_kind !== "system") return false;
	const text = typeof message.message === "string" ? message.message : "";
	return referencedEventIds(text).some((id) => carried.has(id));
}

/**
 * Split one `omp-read` fetch into the rows that may be injected and the echoes
 * dropped from it.
 *
 * Runs once, on the fetched rows, before ids, gate markers and text are
 * derived: all three then describe the same rows. A dropped row left in the
 * gate markers would owe transcript evidence for text that is never injected,
 * and the batch could never settle (the echo's own `messagePart`).
 */
function splitSubscriptionEchoes(messages: PendingMessage[]): {
	deliverable: PendingMessage[];
	dropped: PendingMessage[];
} {
	const carried = new Set<number>();
	for (const message of messages) {
		const id = Number(message.event_id);
		if (Number.isInteger(id) && id > 0) carried.add(id);
	}
	const deliverable: PendingMessage[] = [];
	const dropped: PendingMessage[] = [];
	for (const message of messages) {
		if (isSubscriptionEcho(message, carried)) dropped.push(message);
		else deliverable.push(message);
	}
	return { deliverable, dropped };
}

/**
 * Exact event ids to name in `omp-read --ack --ids`: every message injected so
 * far, including a still-unacknowledged earlier batch. The server rejects a
 * batch that omits an unread message below its high-water id, and it must never
 * see an id we did not inject.
 */
function injectedIds(prior: PendingAck | null, messages: PendingMessage[]): number[] {
	const ids = new Set<number>(prior?.ids ?? []);
	for (const message of messages) {
		const id = Number(message.event_id);
		if (Number.isInteger(id) && id > 0) ids.add(id);
	}
	return [...ids].sort((a, b) => a - b);
}

/**
 * Exact event ids to name in `omp-read --ack --ids`: every injected row, plus a
 * discarded echo below the batch's high-water id.
 *
 * `ack_by_ids` rejects a batch that omits an unread delivered message below its
 * high-water id, and a discarded echo is unread until some ack names it. Left
 * unnamed below the high-water, it keeps every later ack rejected and the
 * cursor frozen on mail the model already read. Above it the cursor stops short
 * of the echo either way, so it is left for a later pass.
 */
function ackedIds(prior: PendingAck | null, deliverable: PendingMessage[], dropped: PendingMessage[]): number[] {
	const ids = new Set<number>(injectedIds(prior, deliverable));
	const highWater = Math.max(...ids);
	for (const message of dropped) {
		const id = Number(message.event_id);
		if (Number.isInteger(id) && id > 0 && id < highWater) ids.add(id);
	}
	return [...ids].sort((a, b) => a - b);
}

/**
 * A deferred injection whose transcript evidence is still owed. A `followUp` is
 * drained by a later run and an idle prompt starts the run that must consume it,
 * so the cursor may only move over either once the prompt carrying it is durably
 * in the transcript. `offset` is the transcript size at injection: an identical
 * line written earlier is not evidence. A `null` path can never be satisfied —
 * fail closed toward unread.
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
	/** Empty only for immediate consumption: a steer into a live turn, and the
	 * bodyless-wake transform, whose text no measurement shows landing verbatim. */
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

/** `omp-read --ack` reports a rejected batch as exit 0 + `{"error": ...}`, cursor untouched. */
function ackRejection(stdout: string): string | null {
	try {
		const json = JSON.parse(stdout || "{}") as { error?: unknown };
		return typeof json.error === "string" ? json.error : null;
	} catch {
		return null;
	}
}

/** Test seam: the plugin's only external dependency. */
export type HcomDeps = {
	runHcom?: (args: string[]) => Promise<HcomResult>;
	/** Test-only override for actor-tool detection; see `hasSendToActor`. */
	hasSendToActor?: boolean;
};

/**
 * Whether this process has the actor bridge (`send_to_actor`) in the
 * model-visible tool surface, and must therefore get the participant primer
 * instead of the CLI catalog. Unknown reads as `false`: fail closed toward the
 * full catalog, never toward stripping the primer.
 */
function hasSendToActor(pi: ExtensionAPI, ctx: ExtensionContext, deps: HcomDeps): boolean {
	if (typeof deps.hasSendToActor === "boolean") return deps.hasSendToActor;
	// Not on the public `ExtensionAPI`; a runtime may still expose the loader's
	// tool map. Unchecked cast, named: it is only a fast path — the prompt scan
	// below is the authority, and a wrong read falls through to it.
	const loaderTools = pi as { tools?: { has?: (name: string) => boolean } };
	if (loaderTools.tools?.has?.("send_to_actor") === true) return true;
	// A runtime without `getSystemPrompt` (a fake ctx, an older SDK) reads as no
	// actor tools, which keeps the full catalog.
	const prompt: unknown = ctx.getSystemPrompt?.();
	const text = Array.isArray(prompt) ? prompt.join("\n") : typeof prompt === "string" ? prompt : "";
	return /\bsend_to_actor\b/.test(text);
}

// Same-process latch: OMP task subagents load a fresh extension instance in the
// parent Node process (SessionShutdownEvent has no sessionId). The first binder
// owns hcom identity; nested instances skip bind/stop so dispose cannot soft-stop
// the parent (lefo / task repro). ExtensionContext does not expose taskDepth.
const IDENTITY_REGISTRY_KEY = Symbol.for("hcom.omp.identity");
const IDENTITY_OWNER_ENV = "HCOM_OMP_IDENTITY_OWNER";

type OmpIdentityRegistry = {
	owner: string | null;
	tearingDown: boolean;
};

function getIdentityRegistry(): OmpIdentityRegistry {
	const g = globalThis as Record<symbol, OmpIdentityRegistry | undefined>;
	if (!g[IDENTITY_REGISTRY_KEY]) {
		g[IDENTITY_REGISTRY_KEY] = { owner: null, tearingDown: false };
	}
	return g[IDENTITY_REGISTRY_KEY]!;
}

function syncIdentityOwnerEnv(owner: string | null): void {
	if (owner) process.env[IDENTITY_OWNER_ENV] = owner;
	else delete process.env[IDENTITY_OWNER_ENV];
}

function clearIdentityOwnership(): void {
	const reg = getIdentityRegistry();
	reg.owner = null;
	reg.tearingDown = false;
	syncIdentityOwnerEnv(null);
}

export default function hcomExtension(pi: ExtensionAPI, deps: HcomDeps = {}) {
	const runHcom = deps.runHcom ?? hcom;
	let instanceName: string | null = null;
	let sessionId: string | null = null;
	let ownsIdentity = false;
	let nestedOptOut = false;
	let bootstrapText: string | null = null;
	let bootstrapParticipantText: string | null = null;
	let bindingPromise: Promise<void> | null = null;
	let notifyServer: Server | null = null;
	let notifyPort: number | null = null;
	let currentCtx: ExtensionContext | null = null;
	let pendingAck: PendingAck | null = null;
	let ackInFlight: Promise<boolean> | null = null;
	let bindingGeneration = 0;
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

	function nestedSkipReason(): string | null {
		const reg = getIdentityRegistry();
		if (nestedOptOut) return "sticky_nested_opt_out";
		// Owner may rebind after a failed soft-stop while keepOwner retained the latch;
		// tearingDown only blocks nested/non-owner extensions.
		if (reg.tearingDown && !ownsIdentity) return "tearing_down";
		if (reg.owner && !ownsIdentity) return "nested_registry";
		if (!reg.owner && process.env[IDENTITY_OWNER_ENV] && !ownsIdentity) return "nested_env";
		return null;
	}

	/**
	 * `omp-start` binds the hcom instance to the session's transcript path. An
	 * OMP session that was never persisted has no file to hand over, so the bind
	 * would register an instance pointed at a path that never exists.
	 *
	 * `ensureOnDisk` lives on the full `SessionManager`; `ctx.sessionManager` is
	 * the narrowed `ReadonlySessionManager` Pick, hence the cast — the runtime
	 * object handed to extensions is the full manager. It silently no-ops when
	 * persistence is off, so durability is confirmed by the session file, not by
	 * the resolved promise. Fail closed: log and let a later bind retry
	 * (bindingPromise is cleared).
	 */
	async function ensureSessionDurable(ctx: ExtensionContext): Promise<boolean> {
		try {
			const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
				ensureOnDisk?: () => Promise<void>;
			};
			if (typeof manager.ensureOnDisk !== "function") {
				log("WARN", "plugin.session_durability_failed", null, { reason: "ensure_on_disk_unavailable" });
				return false;
			}
			await manager.ensureOnDisk();
			if (!ctx.sessionManager.getSessionFile()) {
				log("WARN", "plugin.session_durability_failed", null, { reason: "no_session_file" });
				return false;
			}
			return true;
		} catch (error) {
			log("ERROR", "plugin.session_durability_failed", null, { error: String(error) });
			return false;
		}
	}

	async function bindIdentity(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx;
		if (instanceName || bindingPromise) return bindingPromise ?? Promise.resolve();
		if (process.env.HCOM_LAUNCHED !== "1") return;
		const skipReason = nestedSkipReason();
		if (skipReason) {
			nestedOptOut = true;
			const reg = getIdentityRegistry();
			log("INFO", "plugin.bind_skipped_nested", null, {
				reason: skipReason,
				owner: reg.owner ?? process.env[IDENTITY_OWNER_ENV] ?? null,
			});
			return;
		}
		bindingPromise = (async () => {
			try {
				const reg = getIdentityRegistry();
				if ((reg.tearingDown && !ownsIdentity) || (reg.owner && !ownsIdentity)) {
					nestedOptOut = true;
					log("INFO", "plugin.bind_skipped_nested", null, {
						reason: reg.tearingDown && !ownsIdentity ? "tearing_down" : "nested_registry",
						owner: reg.owner,
					});
					return;
				}
				if (!(await ensureSessionDurable(ctx))) return;
				const sid = ctx.sessionManager.getSessionId();
				const transcriptPath = ctx.sessionManager.getSessionFile();
				const port = await startNotifyServer();
				const args = ["omp-start", "--session-id", sid, "--cwd", ctx.cwd];
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
				ownsIdentity = true;
				reg.owner = instanceName;
				syncIdentityOwnerEnv(instanceName ?? "1");
				bootstrapText = typeof json.bootstrap === "string" ? json.bootstrap : null;
				bootstrapParticipantText =
					typeof json.bootstrap_participant === "string" ? json.bootstrap_participant : null;
				startReconcileTimer();
				log("INFO", "plugin.bound", instanceName, {
					session_id: sessionId,
					notify_port: port,
					bootstrap_len: bootstrapText?.length ?? 0,
					participant_len: bootstrapParticipantText?.length ?? 0,
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
		const result = await runHcom(["omp-read", "--name", instanceName]);
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
			// Before any id, marker or text is derived: an echo dropped later
			// strands the batch it was dropped from.
			const { deliverable, dropped } = splitSubscriptionEchoes(pending.messages);
			if (dropped.length > 0) {
				log("DEBUG", "plugin.subscription_echo_dropped", instanceName, {
					ids: injectedIds(null, dropped),
					count: dropped.length,
				});
			}
			const prior = pendingAck;
			// A deferred batch is already in the model's context; only newer mail is
			// injected, and the ack keeps naming both (newest supersedes, oldest is
			// never silently swept under the cursor).
			const tracked = new Set(prior?.ids ?? []);
			const fresh = deliverable.filter((message) => !tracked.has(Number(message.event_id)));
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
			// A follow-up is drained by a later run and an idle prompt starts the
			// run that must consume it, so both acks owe transcript evidence: the
			// session that cannot run a turn (expired auth, provider outage) then
			// holds its mail instead of consuming it silently. An earlier unsettled
			// batch's gates ride along, so a newer batch cannot settle mail the
			// transcript still has not kept.
			//
			// A steer into a live turn is not gated: a turn is already running, so
			// the "session cannot run a turn" risk does not apply, and nothing
			// measures its text landing in the transcript - a marker that never
			// appears would hold the batch forever.
			const gates: PersistGate[] = [...(prior?.gates ?? [])];
			if (plan.deliverAs !== "steer") {
				const transcriptPath = ctx.sessionManager.getSessionFile() ?? null;
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
				ids: ackedIds(prior, deliverable, dropped),
				maxId: pending.maxId,
				gates,
			};
			pendingAck = batch;
			try {
				const formatted = formatMessagesForInjection(fresh, instanceName);
				await pi.sendUserMessage(formatted, plan.deliverAs ? { deliverAs: plan.deliverAs } : undefined);
				const sender = String(fresh[0]?.from ?? "");
				await reportStatus(ctx, "active", sender ? `deliver:${sender}` : "deliver");
				log("INFO", "plugin.delivery_pending", instanceName, {
					count: fresh.length,
					ids: batch.ids,
					idle: isIdle,
					deliver_as: plan.deliverAs ?? null,
				});
				// A steer (always into a live run) IS the consuming turn, so it
				// settles now; a followUp and an idle prompt wait for the run that
				// drains or starts from them, and for the write that proves it.
				await settlePendingAck("delivery");
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
	 * Ack the tracked batch by its exact ids.
	 *
	 * The cursor must never move past mail the model has not seen, so a rejected
	 * batch (exit 0 + `{"error": ...}`, cursor untouched) leaves the tracker in
	 * place for a later pass to retry.
	 */
	async function ackPending(source: string): Promise<boolean> {
		if (ackInFlight) return ackInFlight;
		const batch = pendingAck;
		if (!instanceName || batch === null) return false;
		const ackInstance = instanceName;
		const generation = bindingGeneration;
		const attempt = (async (): Promise<boolean> => {
			const args = ["omp-read", "--name", ackInstance, "--ack"];
			if (batch.ids.length > 0) args.push("--ids", batch.ids.join(","));
			else args.push("--up-to", String(batch.maxId));
			const result = await runHcom(args);
			if (result.code !== 0) {
				log("WARN", "plugin.delivery_ack_failed", ackInstance, {
					ids: batch.ids,
					source,
					exit_code: result.code,
					stderr: result.stderr.slice(0, 300),
				});
				return false;
			}
			const rejection = ackRejection(result.stdout);
			if (rejection) {
				log("WARN", "plugin.delivery_ack_rejected", ackInstance, {
					ids: batch.ids,
					source,
					error: rejection,
				});
				return false;
			}
			// Keep the delivery gate closed until the durable acknowledgement has
			// succeeded. A reset/rebind invalidates this attempt's local state.
			if (bindingGeneration === generation && instanceName === ackInstance && pendingAck === batch) {
				pendingAck = null;
				log("INFO", "plugin.deferred_ack", ackInstance, {
					acked: batch.ids.length,
					acked_to: batch.maxId,
					source,
				});
				drainPendingDelivery("post_ack_wake");
			}
			return true;
		})();
		ackInFlight = attempt;
		try {
			return await attempt;
		} finally {
			if (ackInFlight === attempt) ackInFlight = null;
		}
	}

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

	async function reportStatus(ctx: ExtensionContext, status: "active" | "listening", context = "", detail = ""): Promise<void> {
		await bindIdentity(ctx);
		if (!instanceName) return;
		const args = ["omp-status", "--name", instanceName, "--status", status];
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
			// No ack here: a tracked batch is a follow-up whose consuming turn has
			// not started yet. Reconciling is not consumption.
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
		stopReconcileTimer();
		reconcileTimer = setInterval(() => void reconcile(), 5_000);
	}

	function stopReconcileTimer(): void {
		if (reconcileTimer) {
			clearInterval(reconcileTimer);
			reconcileTimer = null;
		}
	}

	function resetBinding(opts?: { keepOwner?: boolean }): void {
		stopReconcileTimer();
		stopNotifyServer();
		bindingGeneration++;
		instanceName = null;
		sessionId = null;
		bootstrapText = null;
		bootstrapParticipantText = null;
		bindingPromise = null;
		pendingAck = null;
		ackInFlight = null;
		deliveryInFlight = false;
		deliveryPending = false;
		deliveryRetryScheduled = false;
		bootstrapInjectedForSession = null;
		lastReportedStatusKey = null;
		lastPendingPollAt = 0;
		agentActive = false;
		clearIdleTimer();
		// keepOwner: session_branch rebinds in the same extension instance — retain
		// process-local ownership so nested task extensions still skip bind.
		if (!opts?.keepOwner && ownsIdentity) {
			clearIdentityOwnership();
			ownsIdentity = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		resetBinding();
		await bindIdentity(ctx);
	});

	// SessionShutdownEvent is only `{ type: "session_shutdown" }` — no sessionId.
	// Soft-stop only when THIS extension instance owns the identity (nested task
	// instances never bind, so they never stop the parent).
	pi.on("session_shutdown", async () => {
		let keepOwner = false;
		if (instanceName && ownsIdentity) {
			const reg = getIdentityRegistry();
			reg.tearingDown = true;
			const reason = "shutdown";
			const stopName = instanceName;
			let softStopOk = false;
			try {
				const result = await runHcom(["omp-stop", "--name", stopName, "--reason", reason, "--soft"]);
				if (result.code === 0) {
					softStopOk = true;
				} else {
					log("WARN", "plugin.session_shutdown_soft_stop_failed", stopName, {
						exit_code: result.code,
						reason,
						stderr: result.stderr.slice(0, 300),
					});
				}
			} catch (error) {
				log("ERROR", "plugin.session_shutdown_soft_stop_error", stopName, {
					error: String(error),
					reason,
				});
			}
			keepOwner = !softStopOk;
			// Shutdown attempt finished. If we retain ownership after a failed stop,
			// drop tearingDown so the owner can re-omp-start; nested skip still uses reg.owner.
			if (keepOwner) {
				reg.tearingDown = false;
			}
		} else {
			const skipReason = nestedSkipReason();
			if (skipReason) {
				nestedOptOut = true;
				const reg = getIdentityRegistry();
				log("INFO", "plugin.session_shutdown_skipped", null, {
					reason: "nested_session",
					skip_reason: skipReason,
					owner: reg.owner ?? process.env[IDENTITY_OWNER_ENV] ?? null,
				});
			}
		}
		resetBinding({ keepOwner });
	});

	pi.on("session_switch", async (_event, ctx) => {
		currentCtx = ctx;
		// Keep process-local ownership across switch rebind so a live nested task
		// extension cannot claim identity in the window between clear and omp-start.
		resetBinding({ keepOwner: true });
		await bindIdentity(ctx);
	});

	// OMP's /branch (and /btw's branched path) calls createBranchedSession(),
	// which mints a NEW session id + file and emits only session_branch — not
	// session_switch. Without rebinding here the cached sessionId stays stale,
	// isBoundSession() fails against the new id, and every later deliverPending
	// silently returns false (delivery dead after branch). Rebind like a switch,
	// but keep process-local ownership so nested task extensions still skip bind.
	// session_tree does NOT mint a new session id/file, so it needs no rebind.
	pi.on("session_branch", async (_event, ctx) => {
		currentCtx = ctx;
		resetBinding({ keepOwner: true });
		await bindIdentity(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		clearIdleTimer();
		agentActive = true;
		// The run that drains a follow-up starts here, but the prompt may not be
		// on disk yet: settle only against transcript evidence.
		await settlePendingAck("agent_start");
		await reportStatus(ctx, "active", "agent");
	});

	pi.on("input", async (event: InputEvent, ctx) => {
		currentCtx = ctx;
		await bindIdentity(ctx);
		if (!instanceName) return {};
		if (event.source === "extension") {
			await settlePendingAck("extension");
			return {};
		}
		if (isBodylessWake(event.text)) {
			const pending = await fetchPending();
			if (!pending) return { handled: true };
			const { deliverable, dropped } = splitSubscriptionEchoes(pending.messages);
			const prior = pendingAck;
			const tracked = new Set(prior?.ids ?? []);
			const fresh = deliverable.filter((message) => !tracked.has(Number(message.event_id)));
			if (fresh.length === 0) return { handled: true };
			// The submission carrying this wake IS the consuming turn, so the batch
			// rides the transform instead of starting a turn of its own. At an idle
			// session nothing waits: there `decideInjection` delivers BOTH lanes as
			// a prompt, and the wake transform only ever carries a batch for a
			// session a submission is already waking. A `queue` batch waits only
			// against a turn already in flight, where it is delivered at the
			// boundary.
			//
			// `gates: []` is deliberate and stays that way: this text is delivered
			// as a transform payload, and nothing measures it landing verbatim in
			// the transcript (the delivery path's own blob does). Gating on
			// evidence that may never arrive would hold the batch forever.
			pendingAck = { ids: ackedIds(prior, deliverable, dropped), maxId: pending.maxId, gates: [] };
			return { text: formatMessagesForInjection(fresh, instanceName) };
		}
		await reportStatus(ctx, "active", event.text.trim() === "<hcom>" ? "trigger" : "prompt");
		return {};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		await bindIdentity(ctx);
		if (!instanceName) return undefined;
		// Ack a tracked batch whose consuming turn is this prompt. The input
		// handler sets the tracker and returns { text } for a bare <hcom>; omp
		// applies that transform INLINE and submits it (input-controller.ts) — it
		// never re-emits an input event with source "extension", so the input
		// handler's extension-ack branch is dead for the transform path. A
		// follow-up drained at idle takes the agent_start path instead.
		await settlePendingAck("before_agent_start");
		if (!bootstrapText) return undefined;
		const sid = ctx.sessionManager.getSessionId();
		if (bootstrapInjectedForSession === sid) return undefined;
		bootstrapInjectedForSession = sid;
		// An actor-bridge process gets the participant primer; every other
		// runtime keeps the full CLI catalog. A binary too old to send
		// `bootstrap_participant` (or an empty one) always fails closed to full.
		const participant = hasSendToActor(pi, ctx, deps) && bootstrapParticipantText ? bootstrapParticipantText : null;
		const text = participant ?? bootstrapText;
		log("DEBUG", "plugin.hidden_bootstrap", instanceName, {
			bootstrap_len: text.length,
			shape: participant ? "participant" : "full",
		});
		return {
			message: {
				customType: "hcom-bootstrap",
				content: text,
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
			"omp-beforetool",
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
		// The turn boundary is where a follow-up's own persisted prompt settles.
		await settlePendingAck("turn_end");
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
