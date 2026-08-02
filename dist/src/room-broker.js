import { TransportSessionManager } from "./transport-session-manager.js";
import { extractAssistantText, } from "./gateway-rpc.js";
import { appendRoomEvent, readRoom } from "./rooms.js";
export const DEFAULT_ROOM_RUN_TIMEOUT_MS = 120_000;
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
export class RoomBroker {
    vaultRoot;
    runnableAgents;
    sessions;
    now;
    nonce;
    timers;
    runTimeoutMs;
    activeRuns = new Map();
    pendingApprovals = new Map();
    closed = false;
    constructor(options) {
        this.vaultRoot = options.vaultRoot;
        this.runnableAgents = [...options.runnableAgents];
        this.now = options.now ?? (() => new Date());
        this.nonce = options.nonce;
        this.timers = options.timers ?? defaultTimers();
        this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_ROOM_RUN_TIMEOUT_MS;
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
            room = await readRoom({ vaultRoot: this.vaultRoot, roomId: input.roomId });
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
        // Race-safe in-process reservation: check-and-set is synchronous, before
        // the first event or client side effect. No implicit queue.
        const key = `${input.roomId}:${input.agent}`;
        if (this.activeRuns.has(key)) {
            throw new Error(`A run is already active for room '${input.roomId}' and agent '${input.agent}'.`);
        }
        let resolveDone;
        let resolveFinalized;
        const finalized = new Promise((resolve) => {
            resolveFinalized = resolve;
        });
        const run = {
            key,
            roomId: input.roomId,
            agent: input.agent,
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
        try {
            return await this.runMention(run, input, text, done);
        }
        finally {
            this.activeRuns.delete(key);
            run.resolveFinalized();
        }
    }
    appendBase(roomId) {
        const base = {
            vaultRoot: this.vaultRoot,
            roomId,
            now: this.now,
        };
        // exactOptionalPropertyTypes: never assign an explicit undefined nonce.
        if (this.nonce !== undefined) {
            base.nonce = this.nonce;
        }
        return base;
    }
    async runMention(run, input, text, done) {
        const appendBase = this.appendBase(input.roomId);
        // 1. Immutable steward message with the structured addressed agent.
        const stewardEvent = await appendRoomEvent({
            ...appendBase,
            kind: "steward_message",
            authorKind: "steward",
            author: "steward",
            body: text,
            addressedAgent: input.agent,
        });
        run.stewardEventId = stewardEvent.id;
        // Start the isolated room × agent session. A pre-start failure is a
        // launch failure: no run_started, exactly one terminal run_finished.
        let session;
        try {
            session = await this.sessions.getSession("room", run.key, input.agent);
        }
        catch {
            const terminal = await appendRoomEvent({
                ...appendBase,
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run could not be started.",
                runStatus: "failed",
                failureKind: "launch_failure",
                correlationId: stewardEvent.id,
            });
            return {
                status: "failed",
                roomId: input.roomId,
                agent: input.agent,
                stewardEventId: stewardEvent.id,
                terminalEventId: terminal.id,
                failureKind: "launch_failure",
            };
        }
        run.client = session.client;
        // 2. run_started after the isolated client/session started.
        await appendRoomEvent({
            ...appendBase,
            kind: "run_started",
            authorKind: "system",
            author: "system",
            body: `Run started for agent '${input.agent}'.`,
            runStatus: "running",
            correlationId: stewardEvent.id,
        });
        run.unsubscribeEvents = run.client.onEvent((event) => this.handleClientEvent(run, event));
        run.unsubscribeExit = run.client.onExit(() => this.settle(run, "exit"));
        run.timeoutHandle = this.timers.setTimeout(() => this.settle(run, "timeout"), this.runTimeoutMs);
        try {
            await run.client.prompt(buildRoomMentionPrompt({ roomId: input.roomId, agent: input.agent, text }));
        }
        catch {
            this.settle(run, "launch_failure");
        }
        await done;
        return await this.finalizeRun(run, input, appendBase);
    }
    handleClientEvent(run, event) {
        if (run.settled)
            return;
        run.events.push(event);
        if (event.type === "extension_ui_request" && typeof event.id === "string") {
            this.pendingApprovals.set(`${run.key}:${event.id}`, {
                roomId: run.roomId,
                agent: run.agent,
                requestId: event.id,
                run,
            });
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
        run.resolveDone();
    }
    async finalizeRun(run, input, appendBase) {
        const kind = run.settleKind ?? "closed";
        if (kind === "closed") {
            return { status: "closed", roomId: input.roomId, agent: input.agent, stewardEventId: run.stewardEventId };
        }
        if (kind === "timeout" || kind === "cancel") {
            // Abort only the exact room-agent client. Stale agent_end emitted by
            // the abort is ignored: listeners were unsubscribed at settle time.
            await run.client.abort().catch(() => { });
        }
        if (kind === "completed") {
            const text = extractAssistantText(run.events).trim();
            let agentEventId;
            if (text !== "") {
                const agentEvent = await appendRoomEvent({
                    ...appendBase,
                    kind: "agent_message",
                    authorKind: "agent",
                    author: input.agent,
                    body: text,
                    correlationId: run.stewardEventId,
                });
                agentEventId = agentEvent.id;
            }
            const terminal = await appendRoomEvent({
                ...appendBase,
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "Run completed.",
                runStatus: "completed",
                correlationId: run.stewardEventId,
            });
            run.terminalEventId = terminal.id;
            const outcome = {
                status: "completed",
                roomId: input.roomId,
                agent: input.agent,
                stewardEventId: run.stewardEventId,
                terminalEventId: terminal.id,
            };
            if (agentEventId !== undefined) {
                outcome.agentEventId = agentEventId;
            }
            return outcome;
        }
        if (kind === "launch_failure") {
            const terminal = await appendRoomEvent({
                ...appendBase,
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run could not be started.",
                runStatus: "failed",
                failureKind: "launch_failure",
                correlationId: run.stewardEventId,
            });
            run.terminalEventId = terminal.id;
            return {
                status: "failed",
                roomId: input.roomId,
                agent: input.agent,
                stewardEventId: run.stewardEventId,
                terminalEventId: terminal.id,
                failureKind: "launch_failure",
            };
        }
        if (kind === "exit") {
            const terminal = await appendRoomEvent({
                ...appendBase,
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run ended unexpectedly.",
                runStatus: "failed",
                failureKind: "ambiguous",
                correlationId: run.stewardEventId,
            });
            run.terminalEventId = terminal.id;
            return {
                status: "failed",
                roomId: input.roomId,
                agent: input.agent,
                stewardEventId: run.stewardEventId,
                terminalEventId: terminal.id,
                failureKind: "ambiguous",
            };
        }
        if (kind === "timeout") {
            const terminal = await appendRoomEvent({
                ...appendBase,
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "Run timed out.",
                runStatus: "timed_out",
                correlationId: run.stewardEventId,
            });
            run.terminalEventId = terminal.id;
            return {
                status: "timed_out",
                roomId: input.roomId,
                agent: input.agent,
                stewardEventId: run.stewardEventId,
                terminalEventId: terminal.id,
            };
        }
        // cancel
        const terminal = await appendRoomEvent({
            ...appendBase,
            kind: "run_cancelled",
            authorKind: "system",
            author: "system",
            body: "Run cancelled by the steward.",
            runStatus: "cancelled",
            correlationId: run.stewardEventId,
        });
        run.terminalEventId = terminal.id;
        return {
            status: "cancelled",
            roomId: input.roomId,
            agent: input.agent,
            stewardEventId: run.stewardEventId,
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
        if (pending.run.settled || this.activeRuns.get(pending.run.key) !== pending.run) {
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
     * Close the broker: settle every active run silently (no further room
     * records), clear all pending approvals, and stop all room sessions.
     */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const run of [...this.activeRuns.values()]) {
            this.settle(run, "closed");
        }
        this.pendingApprovals.clear();
        await this.sessions.closeAll();
    }
}
//# sourceMappingURL=room-broker.js.map