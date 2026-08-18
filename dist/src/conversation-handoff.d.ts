/**
 * C5-1 — pure Conversation-scoped agent-handoff protocol core.
 *
 * Bounded, async, sequential, finite-budget handoff semantics (C5 decision
 * package §6, steward-decided §10): a reserved `{to, text}` control shape
 * (callers can never supply ids, source identity, root correlation, budget,
 * or capability — those are derived by the broker from its active run), the
 * finite per-workflow budgets (depth 3 / edges 8 / rework rounds 2), and the
 * deterministic server-side target planner. Workflow budget state is derived
 * from the durable immutable Conversation event chain, so a reload
 * reconstructs it exactly (§6.9).
 *
 * This module is pure: no filesystem, no network, no Pi auth, no broker.
 * The ConversationBroker applies these decisions inside its sequential
 * lifecycle; the C5-3 slice wires the gated `conversation_handoff` tool.
 */
import type { ConversationEventRecord } from "./conversations.js";
/** Wire protocol version. Bump only on an incompatible control-shape change. */
export declare const CONVERSATION_HANDOFF_PROTOCOL_VERSION: 1;
/** C5-2: the exactly-one approval method for the initial steward gate (confirm-only). */
export declare const CONVERSATION_GATE_APPROVAL_METHOD: "confirm";
/**
 * C5-2: the bounded live-only notification payload for a pending gate
 * request. Display-only (the broker re-validates target/budget server-side
 * at confirmation); never durable, never authoritative.
 */
export declare function buildConversationGateApprovalPayload(request: ConversationHandoffRequest): {
    to: string;
    text: string;
};
/** Fixed maximum handoff request text length (characters). Deliberately tiny. */
export declare const CONVERSATION_HANDOFF_MAX_TEXT_LENGTH = 4000;
/** Longest handoff chain from the steward root (lead = 0). Steward-decided. */
export declare const CONVERSATION_HANDOFF_MAX_DEPTH = 3;
/** Total accepted handoff edges within one workflow. Steward-decided. */
export declare const CONVERSATION_HANDOFF_MAX_EDGES = 8;
/** How many times a specific source → target pair may repeat after the target's prior terminal. Steward-decided. */
export declare const CONVERSATION_HANDOFF_MAX_REWORK_ROUNDS = 2;
/** The bounded request the agent can supply; everything else is broker-derived. */
export interface ConversationHandoffRequest {
    to: string;
    text: string;
}
/** Parse outcome for a versioned `{v, to, text}` (or plain `{to, text}`) request. */
export type ConversationHandoffRequestParse = {
    ok: true;
    request: ConversationHandoffRequest;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse and validate the reserved handoff request shape. Returns a
 * deterministic non-secret reason for every malformed/version/size case and
 * never throws. Unknown extra fields are ignored (tolerance convention);
 * the caller can never supply identity, root, budget, or capability.
 */
export declare function parseConversationHandoffRequest(value: unknown): ConversationHandoffRequestParse;
/** One accepted handoff edge, derived from the durable event chain. */
export interface ConversationHandoffEdge {
    source: string;
    target: string;
    handoffEventId: string;
    sequence: number;
}
/**
 * Workflow budget state derived from the durable Conversation events for one
 * workflow root. Reload-surviving and inspectable: the event chain is the
 * authority, never in-memory bookkeeping.
 */
export interface ConversationWorkflowState {
    rootEventId: string;
    /** First mention of the root steward_message (the lead). Undefined when the root is absent. */
    rootAgent: string | undefined;
    /** Accepted handoff edges in durable sequence order. */
    edges: ConversationHandoffEdge[];
    /** agent -> chain depth from the root (lead = 0). */
    depthByAgent: ReadonlyMap<string, number>;
    /** "source->target" -> occurrence count (rework rounds). */
    pairOccurrences: ReadonlyMap<string, number>;
}
/**
 * Derive the workflow budget state from the durable event chain. A handoff
 * edge is an `agent_message` event with an `addressedAgent` correlated to the
 * workflow root; the lead is the first mention of the root steward_message.
 * Events of other workflows and ordinary replies are ignored.
 */
export declare function deriveConversationWorkflowState(events: readonly ConversationEventRecord[], rootEventId: string): ConversationWorkflowState;
/** Inputs for the deterministic server-side handoff edge planner. */
export interface PlanConversationHandoffEdgeInput {
    conversationId: string;
    sourceAgent: string;
    request: ConversationHandoffRequest;
    /** Local runnable set (allowed minus excluded) on this gateway instance. */
    runnableAgents: readonly string[];
    /** `conversationId:agent` keys currently holding an active run. */
    activeKeys: readonly string[];
    workflow: ConversationWorkflowState;
}
export type PlanConversationHandoffEdgeResult = {
    ok: true;
    depth: number;
} | {
    ok: false;
    reason: string;
};
/**
 * Deterministic server-side target planning. Every check has a bounded
 * non-secret reason; nothing is queued, retried, rerouted, or dispatched here.
 * A valid edge is accepted synchronously; the broker then appends the durable
 * handoff event and consumes one workflow edge.
 */
export declare function planConversationHandoffEdge(input: PlanConversationHandoffEdgeInput): PlanConversationHandoffEdgeResult;
/**
 * T2/ADR-0045 — the conditional, role-aware C6 task-directed paragraph for
 * workflow stage runs. This is INSTRUCTION DISCIPLINE, not runtime
 * enforcement (contract §2.3): the broker does not parse, create, claim,
 * list, complete, or validate tasks, and the C5 wire stays `{to, text}`.
 */
export declare const CONVERSATION_TASK_DIRECTED_STAGE_PARAGRAPH = "C6 task-directed protocol (instruction discipline, not runtime enforcement): if the handoff request names one exact vault-relative inbox task path (team/<agent>/inbox/<task>.md), read and explicitly `task_claim` exactly that path; never use `inbox_list` to discover work and never claim any other task. Derive your lifecycle role from the claimed task's own `to`, `from`, and body, never from new wire metadata. Implementation shape (you are the Developer named in `to`; the Lead is named in `from`): execute the task, record `task_update_status(<path>, completed, result)` with the required evidence, create the Lead's review-request task referencing this exact task path, then hand back to that Lead naming the exact review-request path. Review shape (you are the Lead named in `to`; the Developer is named in `from`): inspect, claim, and review; only you record the accepted/blocked/correction/exceptional-Consultant verdict; never accept your own work and never create a review request for your own review. If the path is missing, ambiguous, unclaimable, or the task's roles match neither shape: visibly report the exact condition; do not improvise, substitute, retry, scan, or reroute; any return handoff is bounded to reporting that condition. If the handoff request names no task path, complete it as an ordinary handoff.";
/** Render the bounded prompt for one handoff stage run (C5-1). */
export declare function buildConversationStagePrompt(input: {
    conversationId: string;
    agent: string;
    sourceAgent: string;
    text: string;
    rootEventId: string;
    handoffEventId: string;
    depth: number;
    priorLines: readonly string[];
    truncated: boolean;
    omittedCount: number;
    /**
     * T2/ADR-0045: when true, append the C6 task-directed paragraph. Absent or
     * false renders the C5-only prompt byte-for-byte.
     */
    taskDirected?: boolean;
}): string;
