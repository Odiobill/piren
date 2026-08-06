/**
 * TB4 — gateway-specific pure model-fallback helpers (filesystem/Pi-auth-free).
 *
 * See Projects/Piren/model-fallbacks-design.md §5.4, §6.2, §7. This module is
 * the thin gateway adaptation layer over the delivered pure cores: it resolves
 * the agent-local `model.fallback` policy (TB1 parser), splits exact Pi model
 * ids at the FIRST slash for `client.setModel(provider, modelId)` (colons
 * preserved — no suffix heuristics), and builds the six-key non-secret
 * `model_fallback` notice. The rotation decision itself lives in the delivered
 * `planFallbackAttempt` core; the runtime loop lives in the gateway server.
 *
 * Absent/malformed fallback declarations resolve to an INERT policy so the
 * runtime treats them exactly like today (no automatic continuation, no
 * events). The primary model id is normalized the same way `src/run.ts`
 * normalizes `model.id`/`model.provider`.
 */
import { type ModelFallbackParseOutcome } from "./model-fallback-config.js";
/** The resolved per-agent fallback policy used by one gateway run. */
export interface GatewayFallbackPolicy {
    /**
     * Normalized primary model id (`provider/id` when model.provider is set with
     * a bare model.id, otherwise model.id as-is), or null when undeclared. Used
     * for evidence and to keep rotation from re-selecting the current model.
     */
    primaryModelId: string | null;
    /** The TB1 parse outcome of `model.fallback` (absent/invalid => inert). */
    fallback: ModelFallbackParseOutcome;
}
/** The inert policy: no primary declared, no fallback block. */
export declare function inertFallbackPolicy(): GatewayFallbackPolicy;
/**
 * Normalize the raw `model` mapping into a primary model id, mirroring
 * `src/run.ts` `normalizeModelId`: a bare `id` combined with a `provider`
 * becomes `provider/id`; otherwise the (slash-bearing) `id` is kept as-is.
 * Null when there is no usable id.
 */
export declare function normalizePrimaryModelId(model: unknown): string | null;
/**
 * Parse a raw agent config mapping (or null) into a gateway fallback policy.
 * The TB1 parser is reused untouched; malformed blocks surface the exact
 * deterministic reason and are runtime-inert.
 */
export declare function parseAgentFallbackPolicy(rawConfig: Record<string, unknown> | null): GatewayFallbackPolicy;
export interface LoadAgentFallbackPolicyDeps {
    readFile?: ((path: string) => Promise<string>) | undefined;
}
/**
 * Production loader: read `team/<agent>/config.yml` under the vault root
 * best-effort (missing/malformed files => inert) and parse the policy.
 * With no vaultRoot, no agent, or an invalid agent name the policy is inert
 * and no file is touched.
 */
export declare function loadAgentFallbackPolicy(vaultRoot: string | undefined, agent: string | null, deps?: LoadAgentFallbackPolicyDeps): Promise<GatewayFallbackPolicy>;
/**
 * Split an exact Pi model id at the FIRST slash into provider and modelId for
 * `client.setModel`. Colons in the model part are preserved (exact local ids
 * such as `ollama/llama3.1:8b`); the slash is the only structural separator.
 */
export declare function splitFallbackModelId(modelId: string): {
    provider: string;
    modelId: string;
};
/**
 * The six-key non-secret `model_fallback` notice (design §6.2). `from`/`to`
 * are exact model ids; null inputs render as empty strings (a terminal
 * exhaustion notice has no next model). `category` is one of the two eligible
 * provider-error categories; `attempt` is the 1-based attempt number (or the
 * number of attempts made for terminal exhaustion); `exhausted` distinguishes
 * a live attempt from terminal exhaustion.
 */
export interface ModelFallbackNotice {
    kind: "model_fallback";
    from: string;
    to: string;
    category: "provider_error_other" | "provider_error_transient_exhausted";
    attempt: number;
    exhausted: boolean;
}
export declare function buildModelFallbackNotice(input: {
    from: string | null;
    to: string | null;
    category: "provider_error_other" | "provider_error_transient_exhausted";
    attempt: number;
    exhausted: boolean;
}): ModelFallbackNotice;
