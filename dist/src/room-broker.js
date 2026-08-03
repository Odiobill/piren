import { TransportSessionManager } from "./transport-session-manager.js";
import { extractAssistantText, } from "./gateway-rpc.js";
import { appendRoomEvent, isValidAgentName, readRoom, } from "./rooms.js";
import { isHandoffInputRequest, parseHandoffInputRequest, renderHandoffResultValue, } from "./room-handoff-protocol.js";
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
        this.sessions = new TransportSessionManager({
            runnableAgents: this.runnableAgents,
            targetBuilder: options.targetBuilder,
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
            this.activeRuns.delete(run.key);
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
     * R2a: process a reserved handoff control request emitted by the exact
     * active parent run. Parses and authorizes the bounded request, records the
     * immutable agent_message handoff, starts exactly one isolated child run,
     * and answers the same Pi request id with a bounded structured result. A
     * malformed or rejected request returns a bounded rejection and performs no
     * dispatch, no queued work, and no retry.
     */
    async processHandoff(sourceRun, event) {
        const requestId = event.id;
        try {
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
            // Acceptance is recorded before any side effect so the fixed budgets
            // hold even if a later step fails.
            this.recordHandoffAcceptance(sourceRun.rootEventId, sourceRun.agent, parsed.to);
            // H: immutable agent_message handoff (author: lead, addressed: worker,
            // correlation: the steward root S).
            const handoffEvent = await this.appendAndPublish(sourceRun.roomId, {
                kind: "agent_message",
                authorKind: "agent",
                author: sourceRun.agent,
                body: parsed.text,
                addressedAgent: parsed.to,
                correlationId: sourceRun.rootEventId,
            });
            // Source settled while H was written: it is being torn down; skip the
            // child and the input response (its client is being aborted).
            if (sourceRun.settled) {
                return;
            }
            const { outcome, reply } = await this.dispatchHandoffChild(sourceRun, handoffEvent.id, parsed.to, parsed.text);
            if (!sourceRun.settled) {
                this.respondToHandoffInput(sourceRun, requestId, this.outcomeToHandoffResult(outcome, reply, parsed.to));
            }
        }
        catch {
            // Unexpected dispatch failure (for example a rare reservation race):
            // never leave the lead blocked and never retry. Classified ambiguous.
            if (!sourceRun.settled) {
                this.respondToHandoffInput(sourceRun, requestId, {
                    status: "failed",
                    reason: "handoff dispatch failed",
                    failureKind: "ambiguous",
                });
            }
        }
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
     * Start exactly one isolated handoff child (depth 1) correlated to H. The
     * child reuses the shared room-run execution; its terminal outcome and
     * reply text are returned to {@link processHandoff}. The source-child link
     * is cleared on completion so a later source settle cannot touch it.
     */
    async dispatchHandoffChild(sourceRun, handoffEventId, target, text) {
        const { run, done } = this.reserveRun(sourceRun.roomId, target, 1, sourceRun.rootEventId, sourceRun.participants);
        run.correlationEventId = handoffEventId;
        run.stewardEventId = handoffEventId;
        sourceRun.childRun = run;
        try {
            const outcome = await this.executeRoomRun(run, buildHandoffPrompt({ roomId: sourceRun.roomId, source: sourceRun.agent, target, text }), done);
            const reply = extractAssistantText(run.events).trim();
            return { outcome, reply };
        }
        finally {
            if (sourceRun.childRun === run) {
                delete sourceRun.childRun;
            }
            this.activeRuns.delete(run.key);
            run.resolveFinalized();
        }
    }
    /** Map a child terminal outcome to the bounded non-secret handoff result. */
    outcomeToHandoffResult(outcome, reply, target) {
        switch (outcome.status) {
            case "completed":
                return { status: "ok", reply };
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
        if (event.type === "extension_ui_request" && typeof event.id === "string") {
            // R2a: a reserved handoff control request is consumed only from this
            // exact active run, BEFORE generic input approval forwarding. It never
            // enters the approval registry or notifications, and is never
            // answerable through the public room approval path.
            if (isHandoffInputRequest(event)) {
                void this.processHandoff(run, event);
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
            this.settle(run, "completed");
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