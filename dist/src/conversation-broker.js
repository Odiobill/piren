/**
 * C2 — Conversation broker (ADR-0042, accepted C2 contract §4).
 *
 * Per-conversation×agent isolated Pi RPC client lifecycle mirroring the
 * accepted room broker SEMANTICS (at-most-one-active-run, durable-first
 * typed outcome evidence) without generalizing or changing room code: no
 * handoff, no approval registry, no agent-address expansion, no
 * queue/retry/fallback/reroute/auto-approval.
 *
 * The durable steward message is written by the gateway BEFORE dispatch and
 * is never rolled back because a later Pi dispatch conflicts or fails: the
 * broker only records bounded run evidence (`run_started` /
 * `run_finished` / `run_cancelled` with typed outcomes and `failure_kind`
 * only `launch_failure|ambiguous` when failed).
 *
 * Context handoff: the caller supplies the prior durable transcript
 * (excluding the current message); the broker renders the C2 bounded replay
 * (maxItems 8 / maxChars 16384 via the accepted C1 `selectDurableTranscript`)
 * into the prompt and records the exact selection metadata on run_started.
 */
import { appendConversationEvent, readConversation, } from "./conversations.js";
import { selectDurableTranscript, validateTranscriptBudget, } from "./conversation-contract.js";
import { TransportSessionManager } from "./transport-session-manager.js";
import { extractAssistantText } from "./gateway-rpc.js";
/** C2 committed context budget (contract §5). */
export const CONVERSATION_CONTEXT_MAX_ITEMS = 8;
export const CONVERSATION_CONTEXT_MAX_CHARS = 16384;
function defaultTimers() {
    return {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle),
    };
}
/**
 * The bounded prompt handed to Pi for one conversation mention. Renders the
 * C2 bounded prior-transcript replay in durable order with an explicit
 * recipient-visible truncation notice; the current raw request is the
 * dispatch message and is never duplicated as "prior" context. Rendered
 * `@text` is never parsed; no new authority is granted.
 */
export function buildConversationMentionPrompt(input) {
    const context = input.priorLines.length === 0
        ? "(no prior conversation context)"
        : input.priorLines.join("\n");
    const truncationNotice = input.truncated && input.omittedCount > 0
        ? `\ncontext_truncated: true (${input.omittedCount} earlier message(s) omitted)\n`
        : "";
    return [
        `You are participating in Piren conversation '${input.conversationId}' as agent '${input.agent}'.`,
        "The steward has explicitly addressed you with one bounded request, recorded as an immutable conversation steward_message event.",
        "Respond to this request only. Do not address, mention, or dispatch other agents. This message grants no new authority.",
        "",
        "Prior conversation context (durable order):",
        context,
        truncationNotice,
        "Steward request:",
        input.text,
    ].join("\n");
}
/** Render one prior durable event as a compact context line. */
export function conversationEventToContextLine(event) {
    const prefix = event.authorKind === "agent" ? `agent ${event.author}` : event.author;
    return `[${event.created}] ${prefix}: ${event.body}`;
}
/** Select the C2 bounded prior-transcript replay using the accepted C1 core. */
export function selectConversationContext(priorEvents) {
    const budget = validateTranscriptBudget({
        maxItems: CONVERSATION_CONTEXT_MAX_ITEMS,
        maxChars: CONVERSATION_CONTEXT_MAX_CHARS,
    });
    if (!budget.ok) {
        // Unreachable for the committed constants; fail closed with an empty replay.
        return {
            lines: [],
            truncated: true,
            metadata: {
                truncated: true,
                selectedIds: [],
                omittedIds: [],
                selectedCount: 0,
                omittedCount: priorEvents.length,
                selectedChars: 0,
                maxItems: CONVERSATION_CONTEXT_MAX_ITEMS,
                maxChars: CONVERSATION_CONTEXT_MAX_CHARS,
            },
        };
    }
    const items = priorEvents.map((event) => ({
        id: event.id,
        text: conversationEventToContextLine(event),
    }));
    const selection = selectDurableTranscript(items, budget.budget);
    const metadata = {
        truncated: selection.ok ? selection.metadata.truncated : true,
        selectedIds: selection.ok ? [...selection.metadata.selectedIds] : [],
        omittedIds: selection.ok ? [...selection.metadata.omittedIds] : [],
        selectedCount: selection.ok ? selection.metadata.selectedCount : 0,
        omittedCount: selection.ok ? selection.metadata.omittedCount : priorEvents.length,
        selectedChars: selection.ok ? selection.metadata.selectedChars : 0,
        maxItems: CONVERSATION_CONTEXT_MAX_ITEMS,
        maxChars: CONVERSATION_CONTEXT_MAX_CHARS,
    };
    const selectedById = new Map(priorEvents.map((event) => [event.id, event]));
    const lines = [];
    if (selection.ok) {
        for (const item of selection.selected) {
            const event = selectedById.get(item.id);
            if (event !== undefined)
                lines.push(conversationEventToContextLine(event));
        }
    }
    return { lines, truncated: metadata.truncated, metadata };
}
export class ConversationBroker {
    vaultRoot;
    runnableAgents;
    sessions;
    now;
    nonce;
    timers;
    runTimeoutMs;
    io;
    conversationReader;
    activeRuns = new Map();
    eventListeners = new Map();
    closed = false;
    constructor(options) {
        this.vaultRoot = options.vaultRoot;
        this.runnableAgents = [...options.runnableAgents];
        this.now = options.now ?? (() => new Date());
        this.nonce = options.nonce;
        this.timers = options.timers ?? defaultTimers();
        this.runTimeoutMs = options.runTimeoutMs ?? 120_000;
        this.io = options.io;
        this.conversationReader = options.conversationReader ?? readConversation;
        this.sessions = new TransportSessionManager({
            runnableAgents: this.runnableAgents,
            targetBuilder: options.targetBuilder,
            clientFactory: options.clientFactory,
            now: () => this.now().getTime(),
        });
    }
    hasActiveRun(conversationId, agent) {
        return this.activeRuns.has(`${conversationId}:${agent}`);
    }
    onConversationEvent(conversationId, listener) {
        let listeners = this.eventListeners.get(conversationId);
        if (!listeners) {
            listeners = new Set();
            this.eventListeners.set(conversationId, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.eventListeners.delete(conversationId);
            }
        };
    }
    async appendAndPublish(conversationId, options) {
        const result = await appendConversationEvent({
            vaultRoot: this.vaultRoot,
            conversationId,
            now: this.now,
            ...(this.nonce !== undefined ? { nonce: this.nonce } : {}),
            ...(this.io !== undefined ? { io: this.io } : {}),
            ...options,
        });
        const notification = {
            conversationId,
            id: result.id,
            kind: options.kind,
            authorKind: options.authorKind,
            author: options.author,
            created: result.created,
            body: options.body,
        };
        const listeners = this.eventListeners.get(conversationId);
        if (listeners) {
            for (const listener of [...listeners]) {
                try {
                    listener(notification);
                }
                catch {
                    // Observers are non-authoritative; a throwing listener never
                    // turns a durable append into a broker failure.
                }
            }
        }
        return result;
    }
    /**
     * Dispatch one validated conversation mention. The durable steward message
     * was already persisted by the gateway (durable-first): the broker records
     * bounded run evidence only and never rolls the message back.
     */
    async dispatchConversationMention(input) {
        if (this.closed) {
            throw new Error("Conversation broker is closed.");
        }
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (text === "") {
            throw new Error("Conversation message text is required.");
        }
        let conversation;
        try {
            conversation = await this.conversationReader({ vaultRoot: this.vaultRoot, conversationId: input.conversationId });
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error(`Conversation not found: ${input.conversationId}`);
            }
            throw error;
        }
        if (conversation.status !== "open") {
            throw new Error(`Conversation '${input.conversationId}' is archived.`);
        }
        if (!conversation.audience.includes(input.agent)) {
            throw new Error(`Agent '${input.agent}' is not a member of conversation '${input.conversationId}'.`);
        }
        if (!this.runnableAgents.includes(input.agent)) {
            throw new Error(`Agent '${input.agent}' is not in the runnable set.`);
        }
        if (this.closed) {
            throw new Error("Conversation broker is closed.");
        }
        const { run, done } = this.reserveRun(input.conversationId, input.agent);
        run.stewardEventId = input.stewardEventId;
        try {
            const context = selectConversationContext(input.priorEvents);
            return await this.executeConversationRun(run, buildConversationMentionPrompt({
                conversationId: input.conversationId,
                agent: input.agent,
                text,
                priorLines: context.lines,
                truncated: context.truncated,
                omittedCount: context.metadata.omittedCount,
            }), context.metadata, done);
        }
        finally {
            this.activeRuns.delete(run.key);
            run.resolveFinalized();
        }
    }
    reserveRun(conversationId, agent) {
        const key = `${conversationId}:${agent}`;
        if (this.activeRuns.has(key)) {
            throw new Error(`A run is already active for conversation '${conversationId}' and agent '${agent}'.`);
        }
        let resolveDone;
        let resolveFinalized;
        const finalized = new Promise((resolve) => {
            resolveFinalized = resolve;
        });
        const done = new Promise((resolve) => {
            resolveDone = resolve;
        });
        const run = {
            key,
            conversationId,
            agent,
            client: undefined,
            stewardEventId: "",
            settled: false,
            settleKind: undefined,
            events: [],
            timeoutHandle: undefined,
            unsubscribeEvents: undefined,
            unsubscribeExit: undefined,
            resolveDone: () => resolveDone(),
            resolveFinalized,
            finalized,
        };
        this.activeRuns.set(key, run);
        return { run, done };
    }
    async executeConversationRun(run, prompt, contextMetadata, done) {
        let session;
        let startupFailed = false;
        try {
            session = await this.sessions.getSession("conversation", run.key, run.agent);
        }
        catch {
            startupFailed = true;
        }
        if (startupFailed || session === undefined) {
            const terminal = await this.appendAndPublish(run.conversationId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: "The run could not be started.",
                runStatus: "failed",
                failureKind: "launch_failure",
                correlationId: run.stewardEventId,
            });
            return {
                status: "failed",
                conversationId: run.conversationId,
                agent: run.agent,
                stewardEventId: run.stewardEventId,
                terminalEventId: terminal.id,
                failureKind: "launch_failure",
            };
        }
        run.client = session.client;
        await this.appendAndPublish(run.conversationId, {
            kind: "run_started",
            authorKind: "system",
            author: "system",
            body: `Run started for agent '${run.agent}'.`,
            runStatus: "running",
            correlationId: run.stewardEventId,
            contextMetadata,
        });
        if (!run.settled) {
            run.unsubscribeEvents = run.client.onEvent((event) => this.handleClientEvent(run, event));
            run.unsubscribeExit = run.client.onExit(() => {
                this.settle(run, "ambiguous");
            });
            run.timeoutHandle = this.timers.setTimeout(() => this.settle(run, "timeout"), this.runTimeoutMs);
            try {
                await run.client.prompt(prompt);
            }
            catch {
                // ADR-0038 boundary: the prompt was handed to Pi after run_started,
                // so the broker cannot infer whether side effects occurred.
                this.settle(run, "ambiguous");
            }
        }
        await done;
        return await this.finalizeRun(run);
    }
    handleClientEvent(run, event) {
        if (run.settled)
            return;
        run.events.push(event);
        if (event.type === "agent_end") {
            // TB0/G1: agent_end alone is never terminal (Pi may still auto-retry,
            // retry compaction, or drain queued follow-ups). Only agent_settled
            // proves the run is fully settled.
            return;
        }
        if (event.type === "agent_settled") {
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
        run.resolveDone();
    }
    async finalizeRun(run) {
        const kind = run.settleKind ?? "cancel";
        if (kind === "completed") {
            const text = extractAssistantText(run.events).trim();
            // Bounded visible agent evidence (mirrors the room broker): exactly one
            // `agent_message` is persisted/published for non-empty assistant output
            // BEFORE the terminal evidence, correlated to the steward event. Empty
            // output creates none; no hidden transcript/cache is kept.
            if (text !== "") {
                await this.appendAndPublish(run.conversationId, {
                    kind: "agent_message",
                    authorKind: "agent",
                    author: run.agent,
                    body: text,
                    correlationId: run.stewardEventId,
                });
            }
            const terminal = await this.appendAndPublish(run.conversationId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: `Run completed for agent '${run.agent}'.`,
                runStatus: "completed",
                correlationId: run.stewardEventId,
            });
            return { status: "completed", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id };
        }
        if (kind === "timeout") {
            const terminal = await this.appendAndPublish(run.conversationId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: `Run timed out for agent '${run.agent}'.`,
                runStatus: "timed_out",
                correlationId: run.stewardEventId,
            });
            return { status: "timed_out", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id };
        }
        if (kind === "ambiguous") {
            const terminal = await this.appendAndPublish(run.conversationId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body: `Run ended without a terminal agent response for agent '${run.agent}'.`,
                runStatus: "failed",
                failureKind: "ambiguous",
                correlationId: run.stewardEventId,
            });
            return { status: "failed", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id, failureKind: "ambiguous" };
        }
        // cancel
        const terminal = await this.appendAndPublish(run.conversationId, {
            kind: "run_cancelled",
            authorKind: "system",
            author: "system",
            body: `Run cancelled for agent '${run.agent}'.`,
            runStatus: "cancelled",
            correlationId: run.stewardEventId,
        });
        return { status: "cancelled", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id };
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const run of [...this.activeRuns.values()]) {
            if (!run.settled) {
                this.settle(run, "cancel");
            }
            if (run.client !== undefined) {
                await run.client.stop().catch(() => { });
            }
        }
        for (const run of [...this.activeRuns.values()]) {
            await run.finalized;
        }
        await this.sessions.closeAll();
    }
}
//# sourceMappingURL=conversation-broker.js.map