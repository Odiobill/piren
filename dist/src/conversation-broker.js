/**
 * C2 — Conversation broker (ADR-0042, accepted C2 contract §4).
 *
 * Per-conversation×agent isolated Pi RPC client lifecycle mirroring the
 * accepted room broker SEMANTICS (at-most-one-active-run, durable-first
 * typed outcome evidence) without generalizing or changing room code: no
 * handoff or agent-address expansion; C3-C1 adds only the exact in-memory
 * conversation approval registry. No queue/retry/fallback/reroute/auto-approval.
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
import { classifyRunOutcome, isFallbackEligibleOutcome, } from "./model-fallback-outcome.js";
import { planFallbackAttempt, buildFallbackHandoffPrompt } from "./model-fallback-rotation.js";
import { loadAgentFallbackPolicy, splitFallbackModelId, } from "./model-fallback-gateway.js";
/** C2 committed context budget (contract §5). */
export const CONVERSATION_CONTEXT_MAX_ITEMS = 8;
export const CONVERSATION_CONTEXT_MAX_CHARS = 16384;
function defaultTimers() {
    return {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle),
    };
}
/** Only these Pi UI request methods are approvable conversation approvals. */
const APPROVABLE_METHODS = new Set(["confirm", "select", "input"]);
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
/**
 * C3-C1: validate a raw approval response into the room-precedent exactly-one
 * shape (`{confirmed:boolean}` | `{value:string}` | `{cancelled:true}`).
 * Returns null for missing, wrong-typed, multiple, or non-object shapes so
 * the core rejects malformed responses deterministically (the later gateway
 * slice maps the bounded rejection to its HTTP vocabulary).
 */
export function parseConversationApprovalResponse(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const record = value;
    const confirmed = record.confirmed;
    const responseValue = record.value;
    const cancelled = record.cancelled;
    if (cancelled === true && confirmed === undefined && responseValue === undefined) {
        return { cancelled: true };
    }
    if (typeof confirmed === "boolean" && responseValue === undefined && cancelled === undefined) {
        return { confirmed };
    }
    if (typeof responseValue === "string" && confirmed === undefined && cancelled === undefined) {
        return { value: responseValue };
    }
    return null;
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
    fallbackPolicyLoader;
    activeRuns = new Map();
    eventListeners = new Map();
    /** C3-C1: in-memory pending approvals keyed exactly conversationId:agent:requestId. */
    pendingApprovals = new Map();
    approvalListeners = new Map();
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
        // TB6: production default reads the agent-local config best-effort; an
        // injected loader keeps the broker core fake-client/filesystem-testable.
        this.fallbackPolicyLoader = options.fallbackPolicyLoader ?? ((agent) => loadAgentFallbackPolicy(this.vaultRoot, agent));
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
    /** C3-C1: whether an exact conversation×agent×requestId approval is pending. */
    hasPendingApproval(conversationId, agent, requestId) {
        return this.pendingApprovals.has(`${conversationId}:${agent}:${requestId}`);
    }
    /**
     * C3-C1: subscribe to pending-approval notifications for exactly one
     * conversation. Fired only when an active conversation×agent run registers
     * an exact approvable request. Never auto-approves and never persists
     * approval payloads.
     */
    onConversationApproval(conversationId, listener) {
        let listeners = this.approvalListeners.get(conversationId);
        if (!listeners) {
            listeners = new Set();
            this.approvalListeners.set(conversationId, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.approvalListeners.delete(conversationId);
            }
        };
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
            terminalEventId: undefined,
            events: [],
            attemptEvents: [],
            attemptedModelIds: [],
            currentModelId: null,
            fallbackPolicy: undefined,
            exhaustion: undefined,
            originalPrompt: "",
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
        // C3-C1 cancellation boundary: abort/close won while the session was
        // starting. Cancellation wins over any startup outcome: clean up only
        // the just-created exact session (when one materialized), never write
        // run_started, never record launch_failure.
        if (run.settled) {
            if (session !== undefined) {
                await session.client.stop().catch(() => { });
                this.sessions.forgetSession("conversation", run.key, session.client);
            }
            return await this.finalizeCancelledDuringInit(run);
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
        // TB6: the ORIGINAL prompt is stored so every fallback handoff re-prompt
        // wraps it verbatim (never a prior handoff, never a new request).
        run.originalPrompt = prompt;
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
        run.attemptEvents.push(event);
        if (event.type === "extension_ui_request" && typeof event.id === "string") {
            // C3-C1: only approvable request kinds register; other Pi UI requests
            // (notify, setStatus, ...) never become conversation approvals. The
            // registry is keyed exactly conversation×agent×requestId and lives in
            // memory only — approval payloads are never persisted.
            const method = typeof event.method === "string" ? event.method : "";
            if (!APPROVABLE_METHODS.has(method))
                return;
            this.pendingApprovals.set(`${run.key}:${event.id}`, {
                conversationId: run.conversationId,
                agent: run.agent,
                requestId: event.id,
                run,
            });
            const { type: _type, id: _id, ...payload } = event;
            const notification = {
                conversationId: run.conversationId,
                agent: run.agent,
                requestId: event.id,
                method,
                payload,
            };
            const listeners = this.approvalListeners.get(run.conversationId);
            if (listeners) {
                for (const listener of [...listeners]) {
                    // Same containment as conversation events: a throwing observer must
                    // not escape the Pi event handler or affect the run lifecycle.
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
     * TB6 rotation decision after one logical attempt reaches agent_settled
     * (mirrors the room broker). Continuation ONLY for a fully-settled
     * zero-side-effect eligible provider error on the SAME live isolated
     * client/session: durable `model_fallback` evidence is appended first
     * (correlated to the steward event), then `set_model(next)` and a handoff
     * re-prompt wrapping the ORIGINAL prompt verbatim. Declaration-order
     * at-most-once; a rejected `set_model` is an attempted unavailable skip
     * keeping the settled outcome pending (never re-runs the request on the
     * just-failed model); exhaustion settles a visible `provider_error`
     * terminal. Abort/close/timeout/exit settling the run at any await
     * boundary (including during `set_model`) cancels remaining attempts.
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
            // A planned attempt: durable evidence FIRST, then set_model on the
            // same live client.
            try {
                await this.appendAndPublish(run.conversationId, {
                    kind: "model_fallback",
                    authorKind: "system",
                    author: "system",
                    body: `Model ${run.currentModelId ?? ""} failed (${pendingOutcome.category}) on attempt ${plan.attemptNumber}; switching to ${plan.modelId}`,
                    correlationId: run.stewardEventId,
                });
            }
            catch {
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
                // Unavailable fallback: bounded attempted skip.
            }
            run.attemptedModelIds.push(plan.modelId);
            if (!switched) {
                try {
                    await this.appendAndPublish(run.conversationId, {
                        kind: "model_fallback",
                        authorKind: "system",
                        author: "system",
                        body: `Fallback model ${plan.modelId} unavailable on attempt ${plan.attemptNumber}; skipping`,
                        correlationId: run.stewardEventId,
                    });
                }
                catch {
                    this.settle(run, "ambiguous");
                    return;
                }
                if (run.settled)
                    return;
                continue;
            }
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
        run.resolveDone();
    }
    async finalizeRun(run) {
        const kind = run.settleKind ?? "cancel";
        // C3-C1 room-precedent: abort only the exact conversation-agent client
        // for a timeout or cancel settle. Stale agent_end emitted by the abort
        // is ignored: listeners were unsubscribed at settle time.
        if (kind === "timeout" || kind === "cancel") {
            if (run.client !== undefined) {
                await run.client.abort().catch(() => { });
            }
        }
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
            run.terminalEventId = terminal.id;
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
            run.terminalEventId = terminal.id;
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
            run.terminalEventId = terminal.id;
            return { status: "failed", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id, failureKind: "ambiguous" };
        }
        if (kind === "provider_error") {
            // TB6 terminal exhaustion: exactly one visible run_finished failed
            // provider_error, distinct from ambiguous/launch_failure, with safe
            // bounded evidence; the live client keeps the fallback model (session
            // affinity); no further automatic action.
            const exhaustion = run.exhaustion;
            const body = exhaustion !== undefined
                ? `Run ended with a provider error after ${exhaustion.attemptedCount} fallback attempt(s); last model ${exhaustion.lastModelId} (${exhaustion.category}).`
                : "Run ended with a provider error.";
            const terminal = await this.appendAndPublish(run.conversationId, {
                kind: "run_finished",
                authorKind: "system",
                author: "system",
                body,
                runStatus: "failed",
                failureKind: "provider_error",
                correlationId: run.stewardEventId,
            });
            run.terminalEventId = terminal.id;
            return { status: "failed", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id, failureKind: "provider_error" };
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
        run.terminalEventId = terminal.id;
        return { status: "cancelled", conversationId: run.conversationId, agent: run.agent, stewardEventId: run.stewardEventId, terminalEventId: terminal.id };
    }
    /**
     * C3-C1: respond to a pending approval on the exact conversation×agent
     * client that raised it. The response is validated into the exactly-one
     * shape; unknown, stale, or already-settled requests reject with the
     * contract's bounded strict 409-ready message (the gateway mapping is a
     * later slice). Calls `respondToUiRequest` at most once and cleans up the
     * entry. Never auto-approves, never persists approval payloads, and never
     * consults manifest lifecycle status (controls are run-scoped).
     */
    respondToConversationApproval(input) {
        const response = parseConversationApprovalResponse(input.response);
        if (response === null) {
            throw new Error("Exactly one of confirmed, value, or cancelled is required.");
        }
        const approvalKey = `${input.conversationId}:${input.agent}:${input.requestId}`;
        const pending = this.pendingApprovals.get(approvalKey);
        if (!pending) {
            throw new Error(`Unknown or stale approval request '${input.requestId}' for conversation '${input.conversationId}' and agent '${input.agent}'.`);
        }
        if (pending.run.settled || pending.run.client === undefined || this.activeRuns.get(pending.run.key) !== pending.run) {
            this.pendingApprovals.delete(approvalKey);
            throw new Error(`Unknown or stale approval request '${input.requestId}' for conversation '${input.conversationId}' and agent '${input.agent}'.`);
        }
        pending.run.client.respondToUiRequest(input.requestId, response);
        this.pendingApprovals.delete(approvalKey);
    }
    /**
     * C3-C1: abort the active run for exactly one conversation × agent key. No
     * active run returns `no-active-run`. A real abort settles the run once
     * with cancel, the dispatch finalization performs the client abort and
     * appends exactly one durable `run_cancelled`; this method waits for that
     * terminal record. A second abort for the same key sees `no-active-run`
     * and never duplicates the record. Run-scoped: manifest lifecycle status
     * is never consulted.
     */
    async abort(conversationId, agent) {
        const key = `${conversationId}:${agent}`;
        const run = this.activeRuns.get(key);
        if (!run) {
            return { status: "no-active-run", conversationId, agent };
        }
        this.settle(run, "cancel");
        await run.finalized;
        return { status: "cancelled", conversationId, agent, terminalEventId: run.terminalEventId };
    }
    /** C3-C1: exactly one run_cancelled when cancellation wins during startup. */
    async finalizeCancelledDuringInit(run) {
        const terminal = await this.appendAndPublish(run.conversationId, {
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
            conversationId: run.conversationId,
            agent: run.agent,
            stewardEventId: run.stewardEventId,
            terminalEventId: terminal.id,
        };
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
        this.pendingApprovals.clear();
        for (const run of [...this.activeRuns.values()]) {
            await run.finalized;
        }
        await this.sessions.closeAll();
    }
}
//# sourceMappingURL=conversation-broker.js.map