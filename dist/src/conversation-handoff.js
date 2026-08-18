/** Wire protocol version. Bump only on an incompatible control-shape change. */
export const CONVERSATION_HANDOFF_PROTOCOL_VERSION = 1;
/** C5-2: the exactly-one approval method for the initial steward gate (confirm-only). */
export const CONVERSATION_GATE_APPROVAL_METHOD = "confirm";
/**
 * C5-2: the bounded live-only notification payload for a pending gate
 * request. Display-only (the broker re-validates target/budget server-side
 * at confirmation); never durable, never authoritative.
 */
export function buildConversationGateApprovalPayload(request) {
    return { to: request.to, text: request.text };
}
/** Fixed maximum handoff request text length (characters). Deliberately tiny. */
export const CONVERSATION_HANDOFF_MAX_TEXT_LENGTH = 4000;
/** Longest handoff chain from the steward root (lead = 0). Steward-decided. */
export const CONVERSATION_HANDOFF_MAX_DEPTH = 3;
/** Total accepted handoff edges within one workflow. Steward-decided. */
export const CONVERSATION_HANDOFF_MAX_EDGES = 8;
/** How many times a specific source → target pair may repeat after the target's prior terminal. Steward-decided. */
export const CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS = 2;
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse and validate the reserved handoff request shape. Returns a
 * deterministic non-secret reason for every malformed/version/size case and
 * never throws. Unknown extra fields are ignored (tolerance convention);
 * the caller can never supply identity, root, budget, or capability.
 */
export function parseConversationHandoffRequest(value) {
    if (!isPlainObject(value)) {
        return { ok: false, reason: "conversation handoff request is not a JSON object" };
    }
    if (value.v !== undefined && value.v !== CONVERSATION_HANDOFF_PROTOCOL_VERSION) {
        return { ok: false, reason: `conversation handoff request version mismatch: expected ${CONVERSATION_HANDOFF_PROTOCOL_VERSION}` };
    }
    const to = value.to;
    if (typeof to !== "string" || to === "" || !/^[a-z][a-z0-9-]*$/.test(to)) {
        return { ok: false, reason: "conversation handoff target is not a valid agent name" };
    }
    const text = value.text;
    if (typeof text !== "string" || text.trim() === "") {
        return { ok: false, reason: "conversation handoff text is blank" };
    }
    if (text.length > CONVERSATION_HANDOFF_MAX_TEXT_LENGTH) {
        return { ok: false, reason: "conversation handoff text exceeds the maximum length" };
    }
    return { ok: true, request: { to, text } };
}
/**
 * Derive the workflow budget state from the durable event chain. A handoff
 * edge is an `agent_message` event with an `addressedAgent` correlated to the
 * workflow root; the lead is the first mention of the root steward_message.
 * Events of other workflows and ordinary replies are ignored.
 */
export function deriveConversationWorkflowState(events, rootEventId) {
    const root = events.find((event) => event.id === rootEventId && event.kind === "steward_message");
    const rootAgent = root !== undefined && root.mentions.length > 0 ? root.mentions[0] : undefined;
    const edges = [];
    for (const event of events) {
        if (event.kind === "agent_message" &&
            typeof event.addressedAgent === "string" &&
            event.addressedAgent !== "" &&
            event.correlationId === rootEventId) {
            edges.push({ source: event.author, target: event.addressedAgent, handoffEventId: event.id, sequence: event.sequence });
        }
    }
    edges.sort((a, b) => a.sequence - b.sequence);
    const depthByAgent = new Map();
    if (rootAgent !== undefined) {
        depthByAgent.set(rootAgent, 0);
    }
    const pairOccurrences = new Map();
    for (const edge of edges) {
        const sourceDepth = depthByAgent.get(edge.source);
        if (sourceDepth !== undefined && !depthByAgent.has(edge.target)) {
            // First-accept wins (like membership): a return-to-lead or rework edge
            // never overwrites an agent's existing chain depth.
            depthByAgent.set(edge.target, sourceDepth + 1);
        }
        const key = `${edge.source}->${edge.target}`;
        pairOccurrences.set(key, (pairOccurrences.get(key) ?? 0) + 1);
    }
    return { rootEventId, rootAgent, edges, depthByAgent, pairOccurrences };
}
/**
 * Deterministic server-side target planning. Every check has a bounded
 * non-secret reason; nothing is queued, retried, rerouted, or dispatched here.
 * A valid edge is accepted synchronously; the broker then appends the durable
 * handoff event and consumes one workflow edge.
 */
export function planConversationHandoffEdge(input) {
    const { to, text } = input.request;
    void text;
    if (to === input.sourceAgent) {
        return { ok: false, reason: "conversation handoff to self is not allowed" };
    }
    if (!input.runnableAgents.includes(to)) {
        return { ok: false, reason: `conversation handoff target '${to}' is not locally runnable` };
    }
    if (input.activeKeys.includes(`${input.conversationId}:${to}`)) {
        return { ok: false, reason: `conversation handoff target '${to}' has an active run` };
    }
    const sourceDepth = input.workflow.depthByAgent.get(input.sourceAgent);
    if (sourceDepth === undefined) {
        return { ok: false, reason: "source agent is not part of the conversation handoff workflow" };
    }
    if (input.workflow.edges.length >= CONVERSATION_HANDOFF_MAX_EDGES) {
        return { ok: false, reason: "conversation handoff workflow budget exhausted: edges" };
    }
    if (sourceDepth + 1 > CONVERSATION_HANDOFF_MAX_DEPTH) {
        return { ok: false, reason: "conversation handoff workflow budget exhausted: depth" };
    }
    const pairKey = `${input.sourceAgent}->${to}`;
    const occurrences = input.workflow.pairOccurrences.get(pairKey) ?? 0;
    if (occurrences >= 1 + CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS) {
        return { ok: false, reason: "conversation handoff workflow budget exhausted: rework" };
    }
    return { ok: true, depth: sourceDepth + 1 };
}
/**
 * T2/ADR-0045 — the conditional, role-aware C6 task-directed paragraph for
 * workflow stage runs. This is INSTRUCTION DISCIPLINE, not runtime
 * enforcement (contract §2.3): the broker does not parse, create, claim,
 * list, complete, or validate tasks, and the C5 wire stays `{to, text}`.
 */
export const CONVERSATION_TASK_DIRECTED_STAGE_PARAGRAPH = "C6 task-directed protocol (instruction discipline, not runtime enforcement): if the handoff request names one exact vault-relative inbox task path (team/<agent>/inbox/<task>.md), read and explicitly `task_claim` exactly that path; never use `inbox_list` to discover work and never claim any other task. Derive your lifecycle role from the claimed task's own `to`, `from`, and body, never from new wire metadata. Implementation shape (you are the Developer named in `to`; the Lead is named in `from`): execute the task, record `task_update_status(<path>, completed, result)` with the required evidence, create the Lead's review-request task referencing this exact task path, then hand back to that Lead naming the exact review-request path. Review shape (you are the Lead named in `to`; the Developer is named in `from`): inspect, claim, and review; only you record the accepted/blocked/correction/exceptional-Consultant verdict; never accept your own work and never create a review request for your own review. If the path is missing, ambiguous, unclaimable, or the task's roles match neither shape: visibly report the exact condition; do not improvise, substitute, retry, scan, or reroute; any return handoff is bounded to reporting that condition. If the handoff request names no task path, complete it as an ordinary handoff.";
/** Render the bounded prompt for one handoff stage run (C5-1). */
export function buildConversationStagePrompt(input) {
    const context = input.priorLines.length === 0
        ? "(no prior conversation context)"
        : input.priorLines.join("\n");
    const truncationNotice = input.truncated && input.omittedCount > 0
        ? `\ncontext_truncated: true (${input.omittedCount} earlier message(s) omitted)\n`
        : "";
    const lines = [
        `You are agent '${input.agent}' participating in an approved Piren conversation workflow (conversation '${input.conversationId}', workflow root '${input.rootEventId}', handoff '${input.handoffEventId}', stage depth ${input.depth}).`,
        `Agent '${input.sourceAgent}' has handed off a bounded request to you within the steward-approved workflow.`,
        "Complete the request, then report your outcome visibly. You may use `conversation_handoff(to, text)` to hand off to another locally runnable agent only when that is needed, within the finite workflow budget.",
    ];
    // T2: instruction text lives BEFORE the handoff request section so the
    // request itself stays clean; appended only when requested (the C5-only
    // rendering stays byte-for-byte).
    if (input.taskDirected === true) {
        lines.push("", CONVERSATION_TASK_DIRECTED_STAGE_PARAGRAPH);
    }
    lines.push("", "Prior conversation context (durable order):", context, truncationNotice, "Handoff request:", input.text);
    return lines.join("\n");
}
//# sourceMappingURL=conversation-handoff.js.map