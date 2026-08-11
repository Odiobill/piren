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
import { appendConversationEvent, readConversation, readConversationEvents, updateConversationAudience, } from "./conversations.js";
import { buildConversationStagePrompt, buildConversationGateApprovalPayload, CONVERSATION_GATE_APPROVAL_METHOD, deriveConversationWorkflowState, parseConversationHandoffRequest, planConversationHandoffEdge, } from "./conversation-handoff.js";
import { CONVERSATION_HANDOFF_ENABLED_ENV_VAR, isConversationHandoffInputRequest, parseConversationHandoffInputRequest, renderConversationHandoffResultValue, } from "./conversation-handoff-protocol.js";
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
 * `@text` is never parsed; no new authority is granted. A C5 ROOT lead may
 * additionally be offered ONLY the ability to REQUEST the steward-approved
 * initial handoff gate (never a dispatch); every other run keeps the
 * no-handoff wording byte-for-byte.
 */
export function buildConversationMentionPrompt(input) {
    const context = input.priorLines.length === 0
        ? "(no prior conversation context)"
        : input.priorLines.join("\n");
    const truncationNotice = input.truncated && input.omittedCount > 0
        ? `\ncontext_truncated: true (${input.omittedCount} earlier message(s) omitted)\n`
        : "";
    const gateLine = input.rootHandoffGateRequest === true
        ? " If this request requires team coordination, you may REQUEST a steward-approved handoff via `conversation_handoff(to, text)`; the steward approves or rejects it before anything is dispatched."
        : "";
    return [
        `You are participating in Piren conversation '${input.conversationId}' as agent '${input.agent}'.`,
        "The steward has explicitly addressed you with one bounded request, recorded as an immutable conversation steward_message event.",
        `Respond to this request only. Do not address, mention, or dispatch other agents. This message grants no new authority.${gateLine}`,
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
    /** C5-2: fallback synthesized gate-request id sequence when no nonce is injected. */
    gateSeq = 0;
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
            sequence: result.sequence,
            mentions: options.mentions === undefined ? [] : [...options.mentions],
            body: options.body,
            path: result.path,
        };
        if (options.correlationId !== undefined)
            notification.correlationId = options.correlationId;
        if (options.addressedAgent !== undefined)
            notification.addressedAgent = options.addressedAgent;
        if (options.runStatus !== undefined)
            notification.runStatus = options.runStatus;
        if (options.failureKind !== undefined)
            notification.failureKind = options.failureKind;
        if (options.contextMetadata !== undefined)
            notification.contextMetadata = options.contextMetadata;
        if (options.lifecycleState !== undefined)
            notification.lifecycleState = options.lifecycleState;
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
        // C5-1: a run dispatched directly by a steward message is a workflow ROOT
        // (lead at depth 0); each steward message starts a fresh workflow with
        // fresh budgets (§6.1/§6.4).
        run.c5 = { role: "root", rootEventId: input.stewardEventId, parentHandoffEventId: undefined, depth: 0 };
        try {
            const context = selectConversationContext(input.priorEvents);
            return await this.executeConversationRun(run, buildConversationMentionPrompt({
                conversationId: input.conversationId,
                agent: input.agent,
                text,
                priorLines: context.lines,
                truncated: context.truncated,
                omittedCount: context.metadata.omittedCount,
                // C5-3: a steward-dispatched ROOT lead may only REQUEST the initial
                // gate; it never gains dispatch authority.
                rootHandoffGateRequest: run.c5?.role === "root",
            }), context.metadata, done);
        }
        finally {
            this.activeRuns.delete(run.key);
            // C5-1 sequential defer-launch: the accepted handoff child launches only
            // after the source settled `completed`, never on any other terminal, and
            // only after the source key is freed (no two stage runs overlap).
            await this.maybeLaunchDeferredChild(run);
            run.resolveFinalized();
        }
    }
    /** C5-1 sequential defer-launch: launch a deferred handoff child only after a `completed` source terminal. */
    async maybeLaunchDeferredChild(run) {
        const deferred = run.deferredHandoff;
        if (deferred !== undefined && run.settleKind === "completed") {
            // Consume the edge BEFORE launching: the dispatch-time call and a late
            // accept-time recheck (the source settled while the accept was in
            // flight) can never launch the same child twice.
            run.deferredHandoff = undefined;
            await this.launchDeferredStageRun(run, deferred).catch(() => { });
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
            c5: undefined,
            deferredHandoff: undefined,
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
            // C5-3: the broker stamps ONLY its own isolated Conversation run spawn
            // targets with the exact handoff role. The role is part of the session
            // identity so a role change for the same conversation×agent spawns a
            // fresh client with the correct flag (never a stale reused env).
            const role = run.c5 !== undefined ? run.c5.role : undefined;
            const sessionKey = role !== undefined ? `${run.key}#${role}` : run.key;
            const envOverrides = role !== undefined ? { [CONVERSATION_HANDOFF_ENABLED_ENV_VAR]: role } : undefined;
            session = await this.sessions.getSession("conversation", sessionKey, run.agent, envOverrides);
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
                const role = run.c5 !== undefined ? run.c5.role : undefined;
                const sessionKey = role !== undefined ? `${run.key}#${role}` : run.key;
                this.sessions.forgetSession("conversation", sessionKey, session.client);
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
            // C5-3: a reserved conversation-handoff control request is consumed only
            // from this exact active run, BEFORE generic input approval forwarding.
            // It never enters the approval registry or notifications and is never
            // answerable through the public approval path (room R2 precedent).
            if (isConversationHandoffInputRequest(event)) {
                void this.handleConversationHandoffControlRequest(run, event);
                return;
            }
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
                gate: undefined,
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
    /**
     * C5-3: bridge one reserved conversation-handoff control request from the
     * flagged extension process to the broker's bounded core. Root mode may
     * ONLY request the initial C5-2 steward gate (answered promptly `pending`
     * with no side effect before confirmation); workflow mode may ONLY use the
     * existing C5-1 bounded acceptance path (`ok`). A malformed or stale
     * request gets exactly one bounded `rejected` response with no retry,
     * queue, reroute, fallback, or second UI attempt.
     */
    async handleConversationHandoffControlRequest(run, event) {
        const requestId = event.id;
        const parsed = parseConversationHandoffInputRequest(event);
        if (!parsed.ok) {
            this.respondToConversationHandoffInput(run, requestId, { status: "rejected", reason: parsed.reason });
            return;
        }
        const role = run.c5 !== undefined ? run.c5.role : undefined;
        if (role !== "root" && role !== "workflow") {
            // Defensive: the tool is registered only under the exact flag, so a
            // non-C5 run should never emit this envelope; fail closed.
            this.respondToConversationHandoffInput(run, requestId, {
                status: "rejected",
                reason: "conversation handoff is not available for this run",
            });
            return;
        }
        if (run.settled || this.activeRuns.get(run.key) !== run) {
            this.respondToConversationHandoffInput(run, requestId, { status: "rejected", reason: "no eligible conversation handoff run" });
            return;
        }
        const request = { to: parsed.to, text: parsed.text };
        if (role === "root") {
            const result = await this.requestInitialHandoffGate(run.conversationId, run.agent, request, requestId);
            // Keep the root tool's input request pending until the steward answers
            // the live gate. Returning `pending` here lets Pi complete the root run,
            // invalidating its run-scoped approval before it can be accepted.
            if (result.status === "rejected") {
                this.respondToConversationHandoffInput(run, requestId, { status: "rejected", reason: result.reason });
            }
            return;
        }
        const result = await this.requestConversationHandoff(run.conversationId, run.agent, request);
        this.respondToConversationHandoffInput(run, requestId, result.status === "accepted" ? { status: "ok" } : { status: "rejected", reason: result.reason });
    }
    /** Answer the source run's reserved input request id with a bounded structured value. */
    respondToConversationHandoffInput(run, requestId, result) {
        if (run.client === undefined)
            return;
        try {
            run.client.respondToUiRequest(requestId, { value: renderConversationHandoffResultValue(result) });
        }
        catch {
            // contained: a dead client cannot receive the response.
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
     * later slice). A generic Pi UI approval calls `respondToUiRequest` at
     * most once and cleans up the entry. A pending initial handoff gate
     * (C5-2) resolves through this same exact path: `confirmed: true` awaits
     * the shared C5-1 accept (M1 audience growth, durable handoff event,
     * deferred defer-launch edge), every rejection stays bounded with no side
     * effects, and the promise resolves only after the edge is durable so the
     * approving route can truthfully return 200. Never auto-approves, never
     * persists approval payloads, and never consults manifest lifecycle
     * status (controls are run-scoped).
     */
    async respondToConversationApproval(input) {
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
        if (pending.gate !== undefined) {
            // C5-2: claim the gate entry synchronously BEFORE the async accept so
            // a concurrent duplicate response observes the bounded stale rejection
            // (response-at-most-once). Every gate resolution path is terminal: the
            // claimed entry is never restored.
            this.pendingApprovals.delete(approvalKey);
            await this.resolveGateApproval(pending, response);
            return;
        }
        pending.run.client.respondToUiRequest(input.requestId, response);
        this.pendingApprovals.delete(approvalKey);
    }
    /**
     * C5-2: resolve a pending initial handoff gate through the exact approval
     * response path. `confirmed: true` accepts the stored root edge (shared
     * C5-1 accept: M1 audience growth, durable handoff event, deferred
     * defer-launch edge); `cancelled`/`confirmed:false` bounded-reject with
     * no side effects; a `value` response is a bounded 400-family rejection.
     * No durable approval evidence is ever written and no Pi request is ever
     * fabricated.
     */
    async resolveGateApproval(pending, response) {
        const run = pending.run;
        const gate = pending.gate;
        if (gate === undefined || run.c5 === undefined) {
            // Unreachable: a gate entry is only ever created on a C5 root run; the
            // caller has already claimed the entry.
            throw new Error("Unknown or stale approval request");
        }
        if ("value" in response) {
            throw new Error("a handoff gate approval accepts only confirmed or cancelled");
        }
        if (!("confirmed" in response) || response.confirmed === false) {
            // cancelled / confirmed:false — the steward declined: bounded
            // rejection with no event, no audience mutation, no budget, no child.
            this.respondGateHandoffInput(run, gate.handoffRequestId, { status: "rejected", reason: "steward declined the initial handoff" });
            return;
        }
        const result = await this.acceptHandoffEdge(run, gate.request, run.c5.rootEventId);
        if (result.status !== "accepted") {
            // A confirmed gate whose edge cannot be accepted now (state conflict:
            // target/budget/audience lock) is a bounded rejection, never a
            // fabricated accept and never a silent failure.
            this.respondGateHandoffInput(run, gate.handoffRequestId, { status: "rejected", reason: result.reason });
            throw new Error(`conversation handoff gate could not be accepted: ${result.reason}`);
        }
        this.respondGateHandoffInput(run, gate.handoffRequestId, { status: "ok" });
    }
    /** Settle the held root tool input only when this gate originated from it. */
    respondGateHandoffInput(run, handoffRequestId, result) {
        if (handoffRequestId !== undefined)
            this.respondToConversationHandoffInput(run, handoffRequestId, result);
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
    /**
     * C5-1: request one conversation handoff from an eligible active run. The
     * caller supplies ONLY `{to, text}`; identity, root correlation, budget,
     * and capability are derived from the broker's run state and the durable
     * event chain. An accepted edge appends one immutable handoff event and
     * grows the audience additively (M1) through the authoritative lock path;
     * the child launches later, sequentially, only after a `completed` source
     * terminal (§6.3). Failures are bounded non-secret rejections with no
     * event, no budget consumption, and no queue/retry/reroute.
     */
    async requestConversationHandoff(conversationId, agent, request) {
        const key = `${conversationId}:${agent}`;
        const run = this.activeRuns.get(key);
        if (run === undefined || run.c5 === undefined) {
            return { status: "rejected", reason: "no eligible conversation handoff run" };
        }
        // Sequential invariant: one accepted-but-not-yet-launched edge per run.
        // A second request would overwrite the pending edge (its child would
        // never launch) while still consuming budget and audience.
        if (run.deferredHandoff !== undefined) {
            return { status: "rejected", reason: "a conversation handoff is already accepted and pending launch" };
        }
        const parsed = parseConversationHandoffRequest(request);
        if (!parsed.ok) {
            return { status: "rejected", reason: parsed.reason };
        }
        return this.acceptHandoffEdge(run, parsed.request, run.c5.rootEventId);
    }
    /**
     * C5-2: request the initial lead→first-stage steward confirmation gate
     * from a broker-spawned C5 ROOT run (direct steward dispatch, depth 0, no
     * handoff parent). Validates ONLY enough to create a bounded pending live
     * `confirm` approval keyed exactly conversation×agent×requestId and
     * notifies live SSE subscribers; the frame is answered through the
     * existing approve route. Before explicit steward confirmation there is NO
     * handoff event, NO audience mutation/lock acquisition, NO budget
     * consumption, and NO child dispatch. Settlement (settle/abort/close/
     * timeout) clears the pending gate under the existing C3 run-scoped
     * semantics; a late response gets the bounded stale rejection.
     */
    async requestInitialHandoffGate(conversationId, agent, request, handoffRequestId) {
        const key = `${conversationId}:${agent}`;
        const run = this.activeRuns.get(key);
        if (run === undefined || run.c5 === undefined) {
            return { status: "rejected", reason: "no eligible conversation handoff run" };
        }
        // ONLY a steward-dispatched ROOT (depth 0, no handoff parent) may request
        // the initial gate; workflow-stage runs use the C5-1 acceptance path.
        if (run.c5.role !== "root") {
            return { status: "rejected", reason: "only a steward-dispatched root run may request the initial handoff gate" };
        }
        if (run.deferredHandoff !== undefined) {
            return { status: "rejected", reason: "a conversation handoff is already accepted and pending launch" };
        }
        if (run.settled || this.activeRuns.get(key) !== run) {
            return { status: "rejected", reason: "no eligible conversation handoff run" };
        }
        const parsed = parseConversationHandoffRequest(request);
        if (!parsed.ok) {
            return { status: "rejected", reason: parsed.reason };
        }
        for (const approval of this.pendingApprovals.values()) {
            if (approval.run === run && approval.gate !== undefined) {
                return { status: "rejected", reason: "an initial handoff gate is already pending" };
            }
        }
        const requestId = `gate-${this.nonce !== undefined ? this.nonce() : `r${++this.gateSeq}`}`;
        this.pendingApprovals.set(`${key}:${requestId}`, {
            conversationId,
            agent,
            requestId,
            run,
            gate: handoffRequestId === undefined ? { request: parsed.request } : { request: parsed.request, handoffRequestId },
        });
        const notification = {
            conversationId,
            agent,
            requestId,
            method: CONVERSATION_GATE_APPROVAL_METHOD,
            payload: buildConversationGateApprovalPayload(parsed.request),
        };
        const listeners = this.approvalListeners.get(conversationId);
        if (listeners) {
            for (const listener of [...listeners]) {
                // Same containment as the Pi-request path: a throwing observer never
                // affects the gate lifecycle or the run.
                try {
                    listener(notification);
                }
                catch {
                    // contained
                }
            }
        }
        return { status: "pending", requestId };
    }
    /**
     * C5-1/C5-2 shared accept: derive the durable workflow, plan the edge,
     * grow the audience additively (M1) through the authoritative no-clobber
     * lock path, append the exactly-one durable handoff event, and store the
     * deferred edge on the source run. Every failure is a bounded rejection
     * with no event, no audience mutation, no budget consumption, and no
     * dispatch.
     */
    async acceptHandoffEdge(run, request, rootEventId) {
        const conversationId = run.conversationId;
        let events;
        try {
            events = await readConversationEvents({ vaultRoot: this.vaultRoot, conversationId });
        }
        catch {
            return { status: "rejected", reason: "conversation handoff could not read the workflow history" };
        }
        const workflow = deriveConversationWorkflowState(events, rootEventId);
        const plan = planConversationHandoffEdge({
            conversationId,
            sourceAgent: run.agent,
            request,
            runnableAgents: this.runnableAgents,
            activeKeys: [...this.activeRuns.keys()],
            workflow,
        });
        if (!plan.ok) {
            return { status: "rejected", reason: plan.reason };
        }
        // M1: grow the durable audience additively through the authoritative
        // no-clobber lock path BEFORE the handoff event, so a busy lock can
        // never leave an orphan handoff edge.
        try {
            await updateConversationAudience({
                vaultRoot: this.vaultRoot,
                conversationId,
                additions: { __validatedRecipients: true, recipients: [request.to] },
                kind: "handoff",
                now: this.now,
            });
        }
        catch {
            return {
                status: "rejected",
                reason: "conversation handoff could not grow the audience (another update holds the lock); retry later",
            };
        }
        // Durable handoff edge: exactly one immutable agent_message with the
        // addressed agent, correlated to the workflow root.
        let handoff;
        try {
            handoff = await this.appendAndPublish(conversationId, {
                kind: "agent_message",
                authorKind: "agent",
                author: run.agent,
                body: request.text,
                addressedAgent: request.to,
                correlationId: rootEventId,
            });
        }
        catch {
            // Containment: an additive membership may already exist (inspectable),
            // but no deferred child is scheduled and the budget is not consumed.
            return { status: "rejected", reason: "conversation handoff could not be recorded" };
        }
        run.deferredHandoff = {
            handoffEventId: handoff.id,
            rootEventId,
            to: request.to,
            text: request.text,
            depth: plan.depth,
        };
        if (run.settled) {
            // The source settled while this accept was in flight (an external gate
            // confirm, or a timeout racing a stage's own handoff request): the
            // dispatch-time defer-launch check may already have run and missed this
            // edge. Await finalization — the source terminal is durable and that
            // check has completed — then run the idempotent defer-launch: an
            // accepted edge on a completed source still launches its child exactly
            // once; any other terminal stays fail-closed. The launch itself is NOT
            // awaited: the caller (e.g. the gate confirm route) must not block on
            // the child's run.
            await run.finalized;
            void this.maybeLaunchDeferredChild(run);
        }
        return { status: "accepted", to: request.to, handoffEventId: handoff.id };
    }
    /**
     * C5-1 sequential defer-launch: start the accepted handoff child ONLY on
     * the current durable state (open conversation, member, runnable, no
     * active run) and only after the source settled `completed`. Every launch
     * failure records exactly one `run_finished` failed `launch_failure`
     * correlated to the handoff event; the accepted handoff event stands as
     * the causality record. Non-throwing.
     */
    async launchDeferredStageRun(source, deferred) {
        const conversationId = source.conversationId;
        const recordLaunchFailure = async () => {
            try {
                await this.appendAndPublish(conversationId, {
                    kind: "run_finished",
                    authorKind: "system",
                    author: "system",
                    body: "The handoff child could not be started.",
                    runStatus: "failed",
                    failureKind: "launch_failure",
                    correlationId: deferred.handoffEventId,
                });
            }
            catch {
                // best-effort: the terminal could not be written; do not retry.
            }
        };
        let conversation;
        let events;
        try {
            conversation = await this.conversationReader({ vaultRoot: this.vaultRoot, conversationId });
            events = await readConversationEvents({ vaultRoot: this.vaultRoot, conversationId });
        }
        catch {
            await recordLaunchFailure();
            return;
        }
        if (conversation.status !== "open" ||
            !conversation.audience.includes(deferred.to) ||
            !this.runnableAgents.includes(deferred.to) ||
            this.activeRuns.has(`${conversationId}:${deferred.to}`)) {
            await recordLaunchFailure();
            return;
        }
        // C5 §6.3: the child's replayed durable transcript is the durable history
        // available BEFORE the child's own run_started is written — the accepted
        // handoff edge AND the completed source-stage terminal (which caused
        // defer-launch) are both included. The child's own run_started is written
        // after selection and never appears in its own prompt.
        const priorEvents = events;
        const context = selectConversationContext(priorEvents);
        let child;
        let childDone;
        try {
            const reserved = this.reserveRun(conversationId, deferred.to);
            child = reserved.run;
            childDone = reserved.done;
        }
        catch {
            await recordLaunchFailure();
            return;
        }
        child.stewardEventId = deferred.handoffEventId;
        child.c5 = {
            role: "workflow",
            rootEventId: deferred.rootEventId,
            parentHandoffEventId: deferred.handoffEventId,
            depth: deferred.depth,
        };
        try {
            await this.executeConversationRun(child, buildConversationStagePrompt({
                conversationId,
                agent: deferred.to,
                sourceAgent: source.agent,
                text: deferred.text,
                rootEventId: deferred.rootEventId,
                handoffEventId: deferred.handoffEventId,
                depth: deferred.depth,
                priorLines: context.lines,
                truncated: context.truncated,
                omittedCount: context.metadata.omittedCount,
            }), context.metadata, childDone);
        }
        finally {
            this.activeRuns.delete(child.key);
            // A workflow stage may hand off again within budget: the same
            // sequential defer-launch applies to the child's own accepted edge.
            await this.maybeLaunchDeferredChild(child);
            child.resolveFinalized();
        }
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