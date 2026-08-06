import { TransportSessionManager } from "./transport-session-manager.js";
import { extractAssistantText, } from "./gateway-rpc.js";
import { appendRoomEvent, isValidAgentName, readRoom, } from "./rooms.js";
import { classifyRunOutcome, isFallbackEligibleOutcome, } from "./model-fallback-outcome.js";
import { planFallbackAttempt, buildFallbackHandoffPrompt } from "./model-fallback-rotation.js";
import { loadAgentFallbackPolicy, splitFallbackModelId, } from "./model-fallback-gateway.js";
import { isHandoffInputRequest, parseHandoffInputRequest, renderHandoffResultValue, truncateHandoffReply, ROOM_MENTION_ENABLED_ENV_VAR, } from "./room-handoff-protocol.js";
export const DEFAULT_ROOM_RUN_TIMEOUT_MS = 120_000;
/** Only these Pi UI request methods are approvable room approvals. */
const APPROVABLE_METHODS = new Set(["confirm", "select", "input"]);
function defaultTimers() {
    return {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle),
    };
}
/**
 * The bounded prompt handed to Pi for one room mention. It makes the room
 * context explicit without granting new authority and never asks the agent
 * to address another agent. Rendered `@text` is never parsed.
 */
export function buildRoomMentionPrompt(input) {
    return [
        `You are participating in Piren room '${input.roomId}' as agent '${input.agent}'.`,
        "The steward has explicitly addressed you with one bounded request, recorded as an immutable room steward_message event.",
        "Respond to this request only. Do not address, mention, or dispatch other agents. This message grants no new authority.",
        "",
        "Steward request:",
        input.text,
    ].join("\n");
}
/**
 * The bounded prompt handed to a worker agent started by an accepted
 * handoff. It names the lead and the request only; it grants no new
 * authority and forbids further dispatch.
 */
export function buildHandoffPrompt(input) {
    return [
        `You are participating in Piren room '${input.roomId}' as agent '${input.target}'.`,
        `Agent '${input.source}' has asked you for bounded help with one request, recorded as an immutable room agent_message handoff event.`,
        "Respond to this request only. Do not address, mention, or dispatch other agents. This message grants no new authority.",
        "",
        `Request from ${input.source}:`,
        input.text,
    ].join("\n");
}
/**
 * Decorate a room-client spawn target with the gated `room_mention`
 * activation flag (ADR-0041 R2b). Returns a NEW target object with a NEW env
 * object: every existing entry is preserved, the input target and its env are
 * never mutated, and the global `process.env` is never touched. Only the
 * broker's spawned room clients (root leads and handoff workers) receive the
 * flag; ordinary gateway/transport/ask/worker/review processes do not.
 */
export function decorateRoomClientTarget(target) {
    return {
        ...target,
        env: {
            ...target.env,
            [ROOM_MENTION_ENABLED_ENV_VAR]: "1",
        },
    };
}
export class RoomBroker {
    vaultRoot;
    runnableAgents;
    sessions;
    now;
    nonce;
    timers;
    runTimeoutMs;
    io;
    roomReader;
    activeRuns = new Map();
    pendingApprovals = new Map();
    /** Accepted source->target pairs keyed by steward root event id (R2 budgets). */
    acceptedHandoffPairs = new Map();
    roomEventListeners = new Map();
    roomApprovalListeners = new Map();
    fallbackPolicyLoader;
    closed = false;
    constructor(options) {
        this.vaultRoot = options.vaultRoot;
        this.runnableAgents = [...options.runnableAgents];
        this.now = options.now ?? (() => new Date());
        this.nonce = options.nonce;
        this.timers = options.timers ?? defaultTimers();
        this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_ROOM_RUN_TIMEOUT_MS;
        this.io = options.io;
        this.roomReader = options.roomReader ?? readRoom;
        // TB6: production default reads the agent-local config best-effort; an
        // injected loader keeps the broker core fake-client/filesystem-testable.
        this.fallbackPolicyLoader = options.fallbackPolicyLoader ?? ((agent) => loadAgentFallbackPolicy(this.vaultRoot, agent));
        this.sessions = new TransportSessionManager({
            runnableAgents: this.runnableAgents,
            // Decorate only room-client spawn targets with the activation flag; the
            // caller's targetBuilder output and the global env are never mutated.
            targetBuilder: async (agent) => decorateRoomClientTarget(await options.targetBuilder(agent)),
            clientFactory: options.clientFactory,
            // The manager tracks last-used millis; the broker clock returns Dates.
            now: () => this.now().getTime(),
        });
    }
    hasActiveRun(roomId, agent) {
        return this.activeRuns.has(`${roomId}:${agent}`);
    }
    hasPendingApproval(roomId, agent, requestId) {
        return this.pendingApprovals.has(`${roomId}:${agent}:${requestId}`);
    }
    /** Read-only introspection: does this steward root still hold accepted-handoff budget state? */
    hasHandoffBudgetForRoot(rootEventId) {
        return this.acceptedHandoffPairs.has(rootEventId);
    }
    /**
     * Subscribe to committed events for exactly one room. Listeners receive
     * structured safe data only AFTER each immutable event file was appended;
     * the returned function unsubscribes cleanly.
     */
    onRoomEvent(roomId, listener) {
        let listeners = this.roomEventListeners.get(roomId);
        if (!listeners) {
            listeners = new Set();
            this.roomEventListeners.set(roomId, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.roomEventListeners.delete(roomId);
            }
        };
    }
    /**
     * Subscribe to pending approval notifications for exactly one room.
     * Only confirm/select/input requests are forwarded, only after the broker
     * registered the exact active room-agent-request approval. Never
     * auto-approves and never persists approval payloads.
     */
    onRoomApproval(roomId, listener) {
        let listeners = this.roomApprovalListeners.get(roomId);
        if (!listeners) {
            listeners = new Set();
            this.roomApprovalListeners.set(roomId, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.roomApprovalListeners.delete(roomId);
            }
        };
    }
    /**
     * Append one immutable room event, then publish its structured safe data
     * to that room's listeners. Publication happens only after the durable
     * no-clobber append succeeded.
     */
    async appendAndPublish(roomId, options) {
        const result = await appendRoomEvent({ ...this.appendBase(roomId), ...options });
        const notification = {
            roomId,
            id: result.id,
            kind: options.kind,
            authorKind: options.authorKind,
            author: options.author,
            created: result.created,
            body: options.body,
        };
        if (options.addressedAgent !== undefined)
            notification.addressedAgent = options.addressedAgent;
        if (options.correlationId !== undefined)
            notification.correlationId = options.correlationId;
        if (options.runStatus !== undefined)
            notification.runStatus = options.runStatus;
        if (options.failureKind !== undefined)
            notification.failureKind = options.failureKind;
        const listeners = this.roomEventListeners.get(roomId);
        if (listeners) {
            for (const listener of [...listeners]) {
                // Observers are non-authoritative: one throwing listener must never
                // turn a durable append into a broker failure or affect other
                // listeners. Exceptions are contained, never persisted.
                try {
                    listener(notification);
                }
                catch {
                    // contained
                }
            }
        }
        return result;
    }
    async dispatchRoomMention(input) {
        if (this.closed) {
            throw new Error("Room broker is closed.");
        }
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (text === "") {
            throw new Error("Room mention text is required.");
        }
        let room;
        try {
            room = await this.roomReader({ vaultRoot: this.vaultRoot, roomId: input.roomId });
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error(`Room not found: ${input.roomId}`);
            }
            throw error;
        }
        if (room.status !== "open") {
            throw new Error(`Room '${input.roomId}' is closed.`);
        }
        if (!room.participants.includes(input.agent)) {
            throw new Error(`Agent '${input.agent}' is not a participant of room '${input.roomId}'.`);
        }
        if (!this.runnableAgents.includes(input.agent)) {
            throw new Error(`Agent '${input.agent}' is not in the runnable set.`);
        }
        // Post-validation close boundary: close() may have run entirely while
        // validation was awaited (no reservation existed for it to settle).
        // This check and the reservation below are one synchronous block with no
        // await between them, so close() cannot interleave.
        if (this.closed) {
            throw new Error("Room broker is closed.");
        }
        const { run, done } = this.reserveRun(input.roomId, input.agent, 0, "", room.participants);
        try {
            // 1. Immutable steward message with the structured addressed agent.
            const stewardEvent = await this.appendAndPublish(input.roomId, {
                kind: "steward_message",
                authorKind: "steward",
                author: "steward",
                body: text,
                addressedAgent: input.agent,
            });
            run.stewardEventId = stewardEvent.id;
            run.correlationEventId = stewardEvent.id;
            run.rootEventId = stewardEvent.id;
            // Cancellation boundary 1: close/abort won while the steward event was
            // being written. Record one cancellation; never build/start a session
            // or write run_started.
            if (run.settled) {
                return await this.finalizeCancelledDuringInit(run);
            }
            return await this.executeRoomRun(run, buildRoomMentionPrompt({ roomId: input.roomId, agent: input.agent, text }), done);
        }
        finally {
            // Await any in-flight reserved handoff so abort/close/dispatch
            // deterministically observe a correlated child cancellation before this
            // root's `finalized` resolves. A lead that never handed off has no
            // promise; awaiting undefined resolves immediately. processHandoff is
            // non-throwing, but guard defensively so a rejection cannot escape the
            // finally and leak the reservation.
            if (run.handoffPromise !== undefined) {
                await run.handoffPromise.catch(() => { });
            }
            this.activeRuns.delete(run.key);
            // Budget is active-root state only: once this root reaches terminal
            // finalization it must not grow forever across completed roots.
            this.acceptedHandoffPairs.delete(run.rootEventId);
            run.resolveFinalized();
        }
    }
    /**
     * Race-safe in-process reservation: check-and-set is synchronous, before
     * the first event or client side effect. No implicit queue. Shared by the
     * steward-rooted lead run (depth 0) and an accepted handoff child (depth 1).
     */
    reserveRun(roomId, agent, depth, rootEventId, participants) {
        const key = `${roomId}:${agent}`;
        if (this.activeRuns.has(key)) {
            throw new Error(`A run is already active for room '${roomId}' and agent '${agent}'.`);
        }
        let resolveDone;
        let resolveFinalized;
        const finalized = new Promise((resolve) => {
            resolveFinalized = resolve;
        });
        const run = {
            key,
            roomId,
            agent,
            depth,
            rootEventId,
            correlationEventId: "",
            participants,
            client: undefined,
            stewardEventId: "",
            settled: false,
            events: [],
            attemptEvents: [],
            attemptedModelIds: [],
            currentModelId: null,
            fallbackPolicy: undefined,
            exhaustion: undefined,
            originalPrompt: "",
            resolveDone: () => resolveDone(),
            resolveFinalized,
            finalized,
        };
        const done = new Promise((resolve) => {
            resolveDone = resolve;
        });
        this.activeRuns.set(key, run);
        return { run, done };
    }
    appendBase(roomId) {
        const base = {
            vaultRoot: this.vaultRoot,
            roomId,
            now: this.now,
        };
        // exactOptionalPropertyTypes: never assign explicit undefined optionals.
        if (this.nonce !== undefined) {
            base.nonce = this.nonce;
        }
        if (this.io !== undefined) {
            base.io = this.io;
        }
        return base;
    }
    /**
     * Shared isolated room-run execution (session start -> run_started -> wire ->
     * prompt -> await terminal -> finalize). Used by both the steward-rooted
     * lead and an accepted handoff child; the correlation root and prompt are
     * supplied by the caller. Preserves the R1 cancellation barriers.
     */
    async executeRoomRun(run, prompt, done) {
        // Start the isolated room × agent session.
        let session;
        let startupFailed = false;
        try {
            session = await this.sessions.getSession("room", run.key, run.agent);
        }
        catch {
            startupFailed = true;
        }
        // Cancellation boundary 2: close/abort won while the session was
        // starting. Cancellation wins over any startup outcome: clean up only
        // the just-created exact session (when one materialized), never write
        // run_started, never record launch_failure.
        if (run.settled) {
            if (session !== undefined) {
                await session.client.stop().catch(() => { });
                this.sessions.forgetSession("room", run.key, session.client);
            }
            return await this.finalizeCancelledDuringInit(run);
        }
        if (startupFailed || session === undefined) {
            // Cancellation did NOT win and the client never reached run_started:
            // this is the only launch_failure path (ADR-0038 boundary).
            const terminal = await this.appendAndPublish(run.roomId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run could not be started.",
                runStatus: "failed",
                failureKind: "launch_failure",
                correlationId: run.correlationEventId,
            });
            return {
                status: "failed",
                roomId: run.roomId,
                agent: run.agent,
                stewardEventId: run.correlationEventId,
                terminalEventId: terminal.id,
                failureKind: "launch_failure",
            };
        }
        run.client = session.client;
        // TB6: the ORIGINAL prompt is stored so every fallback handoff re-prompt
        // wraps it verbatim (never a prior handoff, never a new request).
        run.originalPrompt = prompt;
        // 2. run_started after the isolated client/session started.
        await this.appendAndPublish(run.roomId, {
            kind: "run_started",
            authorKind: "system",
            author: "system",
            body: `Run started for agent '${run.agent}'.`,
            runStatus: "running",
            correlationId: run.correlationEventId,
        });
        // Cancellation boundary 3: close/abort won while run_started was being
        // written. Skip wiring and prompt; the cancel finalization below aborts
        // the just-started client and records exactly one run_cancelled.
        if (!run.settled) {
            run.unsubscribeEvents = run.client.onEvent((event) => this.handleClientEvent(run, event));
            run.unsubscribeExit = run.client.onExit(() => {
                run.clientExited = true;
                this.settle(run, "ambiguous");
            });
            run.timeoutHandle = this.timers.setTimeout(() => this.settle(run, "timeout"), this.runTimeoutMs);
            try {
                await run.client.prompt(prompt);
            }
            catch {
                // ADR-0038 boundary: the prompt was handed to Pi after run_started, so
                // the broker cannot infer whether side effects occurred. Classified by
                // control-flow position only, never by error text.
                this.settle(run, "ambiguous");
            }
        }
        await done;
        return await this.finalizeRun(run);
    }
    /**
     * Synchronous accept gate for a reserved handoff control request. Parse and
     * authorize the bounded request; a malformed or rejected request is answered
     * with a bounded rejection and performs no dispatch, no queued work, and no
     * retry — and CRUCIALLY never touches `run.handoffPromise`. Only an ACCEPTED
     * handoff records the budget, reserves the exact depth-1 child target
     * synchronously, binds it to the source, and assigns `run.handoffPromise` to
     * the actual in-flight async work, so a later rejected request can never
     * overwrite the accepted handoff's finalization dependency.
     */
    startHandoffIfAccepted(sourceRun, event) {
        const requestId = event.id;
        const parsed = parseHandoffInputRequest(event);
        if (!parsed.ok) {
            this.respondToHandoffInput(sourceRun, requestId, { status: "rejected", reason: parsed.reason });
            return;
        }
        const auth = this.evaluateHandoffAuthorization(sourceRun, parsed.to);
        if (!auth.ok) {
            this.respondToHandoffInput(sourceRun, requestId, { status: "rejected", reason: auth.reason });
            return;
        }
        // Accept: record the budget AND reserve the exact depth-1 child target
        // synchronously BEFORE any awaited H append. The reservation makes the
        // target occupied immediately, so a concurrent mention for the same target
        // is rejected at its own reservation and can never interleave between an
        // accepted H and the child reservation (no orphan H). Only now does the
        // accepted handoff become the root's finalization dependency.
        this.recordHandoffAcceptance(sourceRun.rootEventId, sourceRun.agent, parsed.to);
        const { run: childRun, done: childDone } = this.reserveRun(sourceRun.roomId, parsed.to, 1, sourceRun.rootEventId, sourceRun.participants);
        sourceRun.childRun = childRun;
        sourceRun.handoffPromise = this.runAcceptedHandoff(sourceRun, childRun, childDone, parsed, requestId);
    }
    /**
     * The async body of an ACCEPTED handoff. Fully contained: it NEVER rejects,
     * so `run.handoffPromise` always resolves and the lead is always answered
     * (or skipped when already settled). Appends the immutable agent_message
     * handoff H, binds the child correlation, executes exactly one isolated
     * child run, and answers the same Pi request id with a bounded result.
     */
    async runAcceptedHandoff(sourceRun, childRun, childDone, parsed, requestId) {
        // H: immutable agent_message handoff (author: lead, addressed: worker,
        // correlation: the steward root S).
        let handoffEvent;
        try {
            handoffEvent = await this.appendAndPublish(sourceRun.roomId, {
                kind: "agent_message",
                authorKind: "agent",
                author: sourceRun.agent,
                body: parsed.text,
                addressedAgent: parsed.to,
                correlationId: sourceRun.rootEventId,
            });
        }
        catch {
            // H append failed: release ONLY the pre-reserved child/key/link cleanly.
            // Create no terminal for a nonexistent H, keep no leaked active key or
            // session, and never retry.
            this.releasePreReservedChild(sourceRun, childRun);
            if (!sourceRun.settled) {
                this.respondToHandoffInput(sourceRun, requestId, {
                    status: "failed",
                    reason: "handoff dispatch failed",
                    failureKind: "ambiguous",
                });
            }
            return;
        }
        // Bind the child correlation once H exists.
        childRun.correlationEventId = handoffEvent.id;
        childRun.stewardEventId = handoffEvent.id;
        // Source settled while H was appended (the settle cascade already marked
        // the child settled): write exactly one child run_cancelled correlated to
        // H, with no session start and no prompt. Never a launch_failure: the
        // child never attempted to start.
        if (sourceRun.settled) {
            await this.finalizeCancelledDuringInit(childRun).catch(() => { });
            this.releasePreReservedChild(sourceRun, childRun);
            return;
        }
        // Execute the pre-reserved child. Contain every post-H execution exception
        // so the lead is answered and no session/key leaks.
        const { outcome, reply } = await this.executeHandoffChild(sourceRun, childRun, childDone, parsed.to, parsed.text);
        if (!sourceRun.settled) {
            this.respondToHandoffInput(sourceRun, requestId, this.outcomeToHandoffResult(outcome, reply, parsed.to));
        }
    }
    /**
     * Release a child that was pre-reserved but never executed (H append failed
     * or the source settled before start): clear the source link, drop the
     * active-key reservation, and resolve its finalization. No terminal event
     * is written here; callers write the correlated cancellation when H exists.
     */
    releasePreReservedChild(sourceRun, childRun) {
        if (sourceRun.childRun === childRun) {
            delete sourceRun.childRun;
        }
        this.activeRuns.delete(childRun.key);
        childRun.resolveFinalized();
    }
    /**
     * Strict fail-closed handoff authorization with deterministic non-secret
     * reasons. Repeat-pair is checked before one-per-root so each budget is
     * independently observable.
     */
    evaluateHandoffAuthorization(sourceRun, target) {
        if (sourceRun.depth !== 0) {
            return { ok: false, reason: "only a steward-addressed lead may hand off (depth limit reached)" };
        }
        if (!isValidAgentName(target)) {
            return { ok: false, reason: "handoff target is not a valid agent name" };
        }
        if (target === sourceRun.agent) {
            return { ok: false, reason: "an agent cannot hand off to itself" };
        }
        if (!this.runnableAgents.includes(target)) {
            return { ok: false, reason: `agent '${target}' is not in the runnable set` };
        }
        if (!sourceRun.participants.includes(target)) {
            return { ok: false, reason: `agent '${target}' is not a participant of room '${sourceRun.roomId}'` };
        }
        const accepted = this.acceptedHandoffPairs.get(sourceRun.rootEventId);
        if (accepted !== undefined && accepted.has(`${sourceRun.agent}->${target}`)) {
            return { ok: false, reason: "this source-target pair has already accepted a handoff for this steward root" };
        }
        if (accepted !== undefined && accepted.size >= 1) {
            return { ok: false, reason: "this steward root has already accepted one agent handoff" };
        }
        if (this.activeRuns.has(`${sourceRun.roomId}:${target}`)) {
            return { ok: false, reason: `a run is already active for room '${sourceRun.roomId}' and agent '${target}'` };
        }
        return { ok: true };
    }
    recordHandoffAcceptance(rootEventId, source, target) {
        let set = this.acceptedHandoffPairs.get(rootEventId);
        if (set === undefined) {
            set = new Set();
            this.acceptedHandoffPairs.set(rootEventId, set);
        }
        set.add(`${source}->${target}`);
    }
    /**
     * Execute the pre-reserved depth-1 handoff child (already bound to the
     * source and correlated to H). Reuses the shared room-run execution; its
     * terminal outcome and reply text are returned to the caller. The
     * source-child link and active key are cleared exactly once. EVERY post-H
     * execution exception is contained here: the materialized exact child
     * session is stopped/forgotten so it cannot be reused as an untracked
     * session, a best-effort correlated terminal is written when writable, and
     * a bounded failed/ambiguous outcome is returned so the lead is always
     * answered. This method never throws; no orphan record, no retry, and the
     * launch-failure boundary (session start failure) is preserved.
     */
    async executeHandoffChild(sourceRun, childRun, childDone, target, text) {
        try {
            const outcome = await this.executeRoomRun(childRun, buildHandoffPrompt({ roomId: sourceRun.roomId, source: sourceRun.agent, target, text }), childDone);
            const reply = extractAssistantText(childRun.events).trim();
            return { outcome, reply };
        }
        catch {
            await this.containFailedHandoffChild(childRun);
            return {
                outcome: {
                    status: "failed",
                    roomId: childRun.roomId,
                    agent: childRun.agent,
                    stewardEventId: childRun.correlationEventId,
                    terminalEventId: childRun.terminalEventId ?? "",
                    failureKind: "ambiguous",
                },
                reply: "",
            };
        }
        finally {
            this.releasePreReservedChild(sourceRun, childRun);
        }
    }
    /**
     * Contain a child that threw during post-H execution (for example a child
     * run_started append failure after the session was constructed): stop and
     * forget the exact materialized session so it cannot be reused, settle the
     * child, and write a best-effort correlated run_finished(ambiguous) when
     * writable. Never retries and never throws.
     */
    async containFailedHandoffChild(childRun) {
        if (childRun.client !== undefined) {
            await childRun.client.stop().catch(() => { });
            this.sessions.forgetSession("room", childRun.key, childRun.client);
        }
        // Settle so any later cascade/listener is inert; resolves the child wait.
        this.settle(childRun, "cancel");
        try {
            const terminal = await this.appendAndPublish(childRun.roomId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run ended unexpectedly.",
                runStatus: "failed",
                failureKind: "ambiguous",
                correlationId: childRun.correlationEventId,
            });
            childRun.terminalEventId = terminal.id;
        }
        catch {
            // best-effort: the terminal could not be written; do not retry.
        }
    }
    /** Map a child terminal outcome to the bounded non-secret handoff result. */
    outcomeToHandoffResult(outcome, reply, target) {
        switch (outcome.status) {
            case "completed":
                // Bound the control-plane reply; the immutable worker evidence keeps
                // the full text, only the result is deterministically truncated.
                return { status: "ok", reply: truncateHandoffReply(reply) };
            case "failed":
                return { status: "failed", reason: `worker '${target}' run failed`, failureKind: outcome.failureKind };
            case "timed_out":
                return { status: "timed_out" };
            case "cancelled":
                return { status: "cancelled" };
        }
    }
    /** Answer the lead's waiting input request id with a structured value. */
    respondToHandoffInput(sourceRun, requestId, result) {
        if (sourceRun.client === undefined)
            return;
        try {
            sourceRun.client.respondToUiRequest(requestId, { value: renderHandoffResultValue(result) });
        }
        catch {
            // contained: a dead client cannot receive the response.
        }
    }
    handleClientEvent(run, event) {
        if (run.settled)
            return;
        run.events.push(event);
        run.attemptEvents.push(event);
        if (event.type === "extension_ui_request" && typeof event.id === "string") {
            // R2a: a reserved handoff control request is consumed only from this
            // exact active run, BEFORE generic input approval forwarding. It never
            // enters the approval registry or notifications, and is never
            // answerable through the public room approval path.
            if (isHandoffInputRequest(event)) {
                this.startHandoffIfAccepted(run, event);
                return;
            }
            const method = typeof event.method === "string" ? event.method : "";
            // Only approvable request kinds register or forward; other Pi UI
            // requests (notify, setStatus, ...) never become room approvals.
            if (!APPROVABLE_METHODS.has(method))
                return;
            this.pendingApprovals.set(`${run.key}:${event.id}`, {
                roomId: run.roomId,
                agent: run.agent,
                requestId: event.id,
                run,
            });
            const { type: _type, id: _id, ...payload } = event;
            const notification = {
                roomId: run.roomId,
                agent: run.agent,
                requestId: event.id,
                method,
                payload,
            };
            const listeners = this.roomApprovalListeners.get(run.roomId);
            if (listeners) {
                for (const listener of [...listeners]) {
                    // Same containment as room events: a throwing observer must not
                    // escape the Pi event handler or affect the run lifecycle.
                    try {
                        listener(notification);
                    }
                    catch {
                        // contained
                    }
                }
            }
            return;
        }
        if (event.type === "agent_end") {
            // TB0/G1: agent_end alone is never terminal (Pi may still auto-retry,
            // retry compaction, or drain queued follow-ups). Only agent_settled
            // proves the run is fully settled.
            return;
        }
        if (event.type === "agent_settled") {
            // TB6: agent_settled starts the rotation decision instead of an
            // unconditional completed settle; an eligible zero-side-effect
            // provider error may continue on the same client, otherwise the run
            // settles with the existing completed semantics.
            void this.onSettledAttempt(run);
        }
    }
    /**
     * TB6 rotation decision after one logical attempt reaches agent_settled.
     *
     * Continuation happens ONLY for a fully-settled zero-side-effect eligible
     * provider error (`classifyRunOutcome` + `isFallbackEligibleOutcome`) on
     * the SAME live isolated client/session: durable `model_fallback` evidence
     * is appended first (correlated to the steward root), then `set_model(next)`
     * and a handoff re-prompt wrapping the ORIGINAL prompt verbatim. Rotation
     * is declaration-order at-most-once through `planFallbackAttempt`; a
     * rejected `set_model` is an attempted unavailable skip that keeps the
     * settled outcome pending (never re-runs the request on the just-failed
     * model) and tries the next candidate; exhaustion settles the run as a
     * visible `provider_error` terminal. Abort/close/timeout/exit settling the
     * run at ANY await boundary (including during `set_model`) cancels
     * remaining attempts and never issues a handoff re-prompt.
     */
    async onSettledAttempt(run) {
        if (run.settled)
            return;
        if (run.fallbackPolicy === undefined) {
            try {
                run.fallbackPolicy = await this.fallbackPolicyLoader(run.agent);
            }
            catch {
                run.fallbackPolicy = null;
            }
            if (run.settled)
                return;
        }
        const policy = run.fallbackPolicy;
        // Sam's dc81a41 guard: without a configured primary identity the broker
        // cannot prove a fallback differs from the just-failed Pi model; stay
        // inert (never risk a same-model re-prompt). Absent/malformed/disabled
        // policy is equally inert.
        if (policy === null || policy.primaryModelId === null || !policy.fallback.ok || !policy.fallback.present) {
            this.settle(run, "completed");
            return;
        }
        const config = policy.fallback.config;
        if (run.currentModelId === null) {
            run.currentModelId = policy.primaryModelId;
        }
        // The settled attempt awaiting a rotation decision. A rejected set_model
        // keeps it pending so the loop plans the NEXT configured fallback
        // directly instead of re-running the request on the just-failed model;
        // only a successful switch clears it, triggering the handoff re-prompt.
        let pendingOutcome = classifyRunOutcome(run.attemptEvents);
        while (pendingOutcome !== null) {
            if (run.settled)
                return;
            const plan = planFallbackAttempt({
                configuredFallbacks: config.models,
                autoSwitch: config.autoSwitch,
                explicitModelSelected: false,
                aborted: false,
                outcome: pendingOutcome,
                currentModelId: run.currentModelId ?? "",
                attemptedModelIds: run.attemptedModelIds,
            });
            if (plan.kind === "no-attempt") {
                this.settle(run, "completed");
                return;
            }
            // planFallbackAttempt only reaches attempt/exhausted for eligible
            // outcomes; TS cannot see that correlation, so narrow explicitly and
            // fail closed if it ever disagrees.
            if (!isFallbackEligibleOutcome(pendingOutcome)) {
                this.settle(run, "completed");
                return;
            }
            if (plan.kind === "exhausted") {
                run.exhaustion = {
                    category: pendingOutcome.category,
                    lastModelId: run.currentModelId ?? "",
                    attemptedCount: plan.attemptedCount,
                };
                this.settle(run, "provider_error");
                return;
            }
            // A planned attempt: durable evidence FIRST (never rotate without a
            // durable record), then set_model on the same live client.
            try {
                await this.appendAndPublish(run.roomId, {
                    kind: "model_fallback",
                    authorKind: "system",
                    author: "system",
                    body: `Model ${run.currentModelId ?? ""} failed (${pendingOutcome.category}) on attempt ${plan.attemptNumber}; switching to ${plan.modelId}`,
                    correlationId: run.correlationEventId,
                });
            }
            catch {
                // Durable evidence could not be written: fail closed, never rotate
                // without evidence.
                this.settle(run, "ambiguous");
                return;
            }
            if (run.settled)
                return;
            const split = splitFallbackModelId(plan.modelId);
            const client = run.client;
            let switched = false;
            try {
                if (client === undefined || typeof client.setModel !== "function") {
                    throw new Error("RPC client does not support set_model");
                }
                await client.setModel(split.provider, split.modelId);
                run.currentModelId = plan.modelId;
                switched = true;
            }
            catch {
                // Unavailable fallback: bounded attempted skip; never retried within
                // the incident and never re-prompts the just-failed model.
            }
            run.attemptedModelIds.push(plan.modelId);
            if (!switched) {
                try {
                    await this.appendAndPublish(run.roomId, {
                        kind: "model_fallback",
                        authorKind: "system",
                        author: "system",
                        body: `Fallback model ${plan.modelId} unavailable on attempt ${plan.attemptNumber}; skipping`,
                        correlationId: run.correlationEventId,
                    });
                }
                catch {
                    this.settle(run, "ambiguous");
                    return;
                }
                if (run.settled)
                    return;
                // Keep the pending outcome: plan the next candidate without a
                // re-prompt on the just-failed model.
                continue;
            }
            // Abort/close/timeout/exit landed during set_model: steward intent
            // wins, never issue the handoff re-prompt.
            if (run.settled)
                return;
            if (client === undefined) {
                this.settle(run, "ambiguous");
                return;
            }
            run.attemptEvents = [];
            try {
                await client.prompt(buildFallbackHandoffPrompt(run.originalPrompt, plan.modelId, pendingOutcome.category));
            }
            catch {
                // The handoff re-prompt was handed to Pi after run_started; classified
                // by control-flow position only, never by error text.
                this.settle(run, "ambiguous");
            }
            pendingOutcome = null; // await the next agent_settled
        }
    }
    settle(run, kind) {
        if (run.settled)
            return;
        run.settled = true;
        run.settleKind = kind;
        if (run.timeoutHandle !== undefined) {
            this.timers.clearTimeout(run.timeoutHandle);
            run.timeoutHandle = undefined;
        }
        run.unsubscribeEvents?.();
        run.unsubscribeExit?.();
        for (const [approvalKey, approval] of [...this.pendingApprovals.entries()]) {
            if (approval.run === run) {
                this.pendingApprovals.delete(approvalKey);
            }
        }
        // R2a: a source abort/timeout/exit/close cancels ONLY its exact live
        // handoff child. Depth is bounded to 1, so no recursive cascade beyond
        // one level; a child can never have its own accepted child.
        if (run.childRun !== undefined && !run.childRun.settled) {
            this.settle(run.childRun, "cancel");
        }
        run.resolveDone();
    }
    /**
     * Terminal cancellation for a run that never became active (close/abort
     * won during initialization): exactly one correlated run_cancelled, with
     * no session usage, no run_started, and no client access.
     */
    async finalizeCancelledDuringInit(run) {
        const terminal = await this.appendAndPublish(run.roomId, {
            kind: "run_cancelled",
            authorKind: "system",
            author: "system",
            body: "Run cancelled by the steward.",
            runStatus: "cancelled",
            correlationId: run.correlationEventId,
        });
        run.terminalEventId = terminal.id;
        return {
            status: "cancelled",
            roomId: run.roomId,
            agent: run.agent,
            stewardEventId: run.correlationEventId,
            terminalEventId: terminal.id,
        };
    }
    async finalizeRun(run) {
        // settle() always assigns a kind before resolving the wait; the fallback
        // is defensive only.
        const kind = run.settleKind ?? "cancel";
        const correlationId = run.correlationEventId;
        if (kind === "timeout" || kind === "cancel") {
            // Abort only the exact room-agent client. Stale agent_end emitted by
            // the abort is ignored: listeners were unsubscribed at settle time.
            if (run.client !== undefined) {
                await run.client.abort().catch(() => { });
            }
        }
        if (kind === "completed") {
            const text = extractAssistantText(run.events).trim();
            let agentEventId;
            if (text !== "") {
                const agentEvent = await this.appendAndPublish(run.roomId, {
                    kind: "agent_message",
                    authorKind: "agent",
                    author: run.agent,
                    body: text,
                    correlationId,
                });
                agentEventId = agentEvent.id;
            }
            const terminal = await this.appendAndPublish(run.roomId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "Run completed.",
                runStatus: "completed",
                correlationId,
            });
            run.terminalEventId = terminal.id;
            const outcome = {
                status: "completed",
                roomId: run.roomId,
                agent: run.agent,
                stewardEventId: correlationId,
                terminalEventId: terminal.id,
            };
            if (agentEventId !== undefined) {
                outcome.agentEventId = agentEventId;
            }
            return outcome;
        }
        if (kind === "ambiguous") {
            const terminal = await this.appendAndPublish(run.roomId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run ended unexpectedly.",
                runStatus: "failed",
                failureKind: "ambiguous",
                correlationId,
            });
            run.terminalEventId = terminal.id;
            if (run.clientExited === true) {
                // The cached client is dead: forget exactly this composite session
                // (without stopping it) so a later explicit mention builds a fresh
                // client. Never a retry of the failed run; unrelated sessions stay.
                this.sessions.forgetSession("room", run.key, run.client);
            }
            return {
                status: "failed",
                roomId: run.roomId,
                agent: run.agent,
                stewardEventId: correlationId,
                terminalEventId: terminal.id,
                failureKind: "ambiguous",
            };
        }
        if (kind === "provider_error") {
            // TB6 terminal exhaustion: exactly one visible run_finished failed
            // provider_error, distinct from ambiguous/launch_failure, with safe
            // bounded evidence (category + last model + attempt count; never raw
            // provider error text). The live client keeps the fallback model
            // (session affinity); no further automatic action.
            const exhaustion = run.exhaustion;
            const body = exhaustion !== undefined
                ? `Run ended with a provider error after ${exhaustion.attemptedCount} fallback attempt(s); last model ${exhaustion.lastModelId} (${exhaustion.category}).`
                : "Run ended with a provider error.";
            const terminal = await this.appendAndPublish(run.roomId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body,
                runStatus: "failed",
                failureKind: "provider_error",
                correlationId,
            });
            run.terminalEventId = terminal.id;
            return {
                status: "failed",
                roomId: run.roomId,
                agent: run.agent,
                stewardEventId: correlationId,
                terminalEventId: terminal.id,
                failureKind: "provider_error",
            };
        }
        if (kind === "timeout") {
            const terminal = await this.appendAndPublish(run.roomId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "Run timed out.",
                runStatus: "timed_out",
                correlationId,
            });
            run.terminalEventId = terminal.id;
            return {
                status: "timed_out",
                roomId: run.roomId,
                agent: run.agent,
                stewardEventId: correlationId,
                terminalEventId: terminal.id,
            };
        }
        // cancel
        const terminal = await this.appendAndPublish(run.roomId, {
            kind: "run_cancelled",
            authorKind: "system",
            author: "system",
            body: "Run cancelled by the steward.",
            runStatus: "cancelled",
            correlationId,
        });
        run.terminalEventId = terminal.id;
        return {
            status: "cancelled",
            roomId: run.roomId,
            agent: run.agent,
            stewardEventId: correlationId,
            terminalEventId: terminal.id,
        };
    }
    /**
     * Respond to a pending approval on the exact room-agent client that raised
     * it. Unknown, stale, wrong-room, wrong-agent, or already-resolved
     * responses reject and write no room record. Never auto-approves.
     */
    respondToRoomApproval(input) {
        const approvalKey = `${input.roomId}:${input.agent}:${input.requestId}`;
        const pending = this.pendingApprovals.get(approvalKey);
        if (!pending) {
            throw new Error(`Unknown room approval '${input.requestId}' for room '${input.roomId}' and agent '${input.agent}'.`);
        }
        if (pending.run.settled || pending.run.client === undefined || this.activeRuns.get(pending.run.key) !== pending.run) {
            this.pendingApprovals.delete(approvalKey);
            throw new Error(`Room approval '${input.requestId}' is stale.`);
        }
        pending.run.client.respondToUiRequest(input.requestId, input.response);
        this.pendingApprovals.delete(approvalKey);
    }
    /**
     * Abort the active run for exactly one room × agent key. The dispatch
     * finalization performs the client abort and appends the single
     * run_cancelled event; this method waits for that terminal record.
     */
    async abort(roomId, agent) {
        const key = `${roomId}:${agent}`;
        const run = this.activeRuns.get(key);
        if (!run) {
            return { status: "no-active-run", roomId, agent };
        }
        this.settle(run, "cancel");
        await run.finalized;
        return { status: "cancelled", roomId, agent, terminalEventId: run.terminalEventId };
    }
    /**
     * Close the broker: cancel every active run exactly once with a durable
     * non-secret run_cancelled record, wait for all finalization writes, then
     * stop all room sessions. Stale agent_end events from shutdown append
     * nothing. Idempotent; a close with no active runs writes no records.
     */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        const finalizations = [];
        for (const run of [...this.activeRuns.values()]) {
            this.settle(run, "cancel");
            finalizations.push(run.finalized);
        }
        this.pendingApprovals.clear();
        await Promise.all(finalizations);
        await this.sessions.closeAll();
    }
}
//# sourceMappingURL=room-broker.js.map