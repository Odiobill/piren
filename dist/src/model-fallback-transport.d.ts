/**
 * TB7 — pure transport model-fallback core (filesystem/Pi-auth-free).
 *
 * See Projects/Piren/model-fallbacks-design.md §4.2/§4.3, §5, §6.4, §7, TB7.
 * This module decides same-live-client rotation over an injected seam (the
 * transport owns the platform adaptation: clients, APIs, chunking). The
 * transport passes its conversation-specific client's `promptAndWait`/`setModel`
 * and streams bounded non-secret notices for platform advisory rendering.
 *
 * Continuation happens ONLY for a fully-settled zero-side-effect eligible
 * provider error (`classifyRunOutcome` + `isFallbackEligibleOutcome`) on the
 * SAME live client/session: `set_model(next)` then a handoff re-prompt wrapping
 * the ORIGINAL inbound prompt verbatim. Declaration-order at-most-once through
 * `planFallbackAttempt`; a rejected `set_model` is an attempted unavailable
 * skip that keeps the settled outcome pending (never re-runs the request on
 * the just-failed model); exhaustion is a distinct terminal result with safe
 * category/model/count evidence only. Absent/malformed/disabled/no-primary
 * policy is inert (single run, no notices). Abort authority (`isAborted`)
 * checked at every await boundary prevents any handoff re-prompt.
 */
import type { RpcEvent } from "./gateway-rpc.js";
import { type GatewayFallbackPolicy } from "./model-fallback-gateway.js";
/** Bounded non-secret notice streamed to the transport during rotation. */
export type TransportFallbackNotice = {
    kind: "attempt";
    from: string;
    to: string;
    category: "provider_error_other" | "provider_error_transient_exhausted";
    attempt: number;
} | {
    kind: "unavailable";
    modelId: string;
    attempt: number;
} | {
    kind: "exhausted";
    lastModelId: string;
    category: "provider_error_other" | "provider_error_transient_exhausted";
    attemptedCount: number;
};
export interface TransportFallbackRunInput {
    /** The ORIGINAL inbound prompt; every handoff wraps it verbatim. */
    originalPrompt: string;
    /** Resolved agent-local fallback policy (absent/malformed/disabled/no-primary => inert). */
    policy: GatewayFallbackPolicy;
    /** Run one logical attempt and resolve with its events once it settles. */
    run: (prompt: string) => Promise<RpcEvent[]>;
    /** set_model on the SAME live client; rejects when the model is unavailable. */
    setModel: (provider: string, modelId: string) => Promise<unknown>;
    /** Bounded notice stream; the transport renders each into advisory text. */
    onNotice: (notice: TransportFallbackNotice) => void | Promise<void>;
    /** Abort authority: when true the runner stops and never issues a handoff re-prompt. */
    isAborted?: (() => boolean) | undefined;
}
export type TransportFallbackResult = {
    status: "completed";
    events: RpcEvent[];
} | {
    status: "exhausted";
    events: RpcEvent[];
    lastModelId: string;
    category: "provider_error_other" | "provider_error_transient_exhausted";
    attemptedCount: number;
};
/**
 * Run one inbound transport prompt with bounded same-live-client fallback.
 * Returns the terminal attempt's events (the transport extracts the text) and
 * streams bounded notices. A run rejection (prompt rejection / timeout /
 * client exit) propagates — the transport keeps its existing conservative
 * response behavior. `isAborted` is checked before every side effect so an
 * abort landing at any point (including during `set_model`) prevents the
 * handoff re-prompt.
 */
export declare function runTransportFallback(input: TransportFallbackRunInput): Promise<TransportFallbackResult>;
/**
 * Render one bounded non-secret notice as platform advisory text (design
 * §6.4). Never carries raw provider error text, status codes, credentials,
 * session paths, or config paths.
 */
export declare function renderTransportFallbackNotice(notice: TransportFallbackNotice): string;
