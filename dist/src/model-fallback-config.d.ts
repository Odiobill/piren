/**
 * TB1 — pure agent-local model-fallback config parsing (filesystem/Pi-auth-free).
 *
 * See Projects/Piren/model-fallbacks-design.md §2. Absent fallback is an inert
 * valid absence; a present `model.fallback` mapping must carry a non-empty
 * ordered array of exact Pi `provider/modelId` strings (colon-bearing ids such
 * as `ollama/llama3.1:8b` are preserved — NO suffix heuristics), an optional
 * boolean `auto_switch` defaulting to true, at most MAX_FALLBACK_MODELS entries,
 * and no duplicates. This module has no runtime consumer in TB1: it only feeds
 * the doctor check. It never touches Pi RPC, the catalog, credentials, or
 * provider availability.
 */
/**
 * Bounded fallback list length so exhaustion cannot grow unbounded
 * (design §2.2).
 */
export declare const MAX_FALLBACK_MODELS = 5;
/**
 * Conservative exact-id grammar for fallback model strings. Provider part is
 * lowercase `[a-z0-9][a-z0-9._-]*`; model part may contain colons (local ids
 * such as `ollama/llama3.1:8b`), so a trailing `:...` is part of the exact id
 * and is never rejected by a heuristic suffix parser.
 */
export declare const FALLBACK_MODEL_ID_PATTERN: RegExp;
/** Valid parsed fallback configuration (design §2.1). */
export interface ModelFallbackConfig {
    autoSwitch: boolean;
    /** Ordered exact Pi provider/modelId strings, length 1..MAX_FALLBACK_MODELS. */
    models: string[];
}
export type ModelFallbackParseOutcome = {
    ok: true;
    present: false;
} | {
    ok: true;
    present: true;
    config: ModelFallbackConfig;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse the raw `model.fallback` value into a typed result. `undefined` is the
 * absent/inert case (`present: false`); any other present value must be a
 * mapping. Failures are deterministic and non-secret; they never echo the raw
 * YAML or model ids beyond the failing position.
 */
export declare function parseModelFallbackConfig(raw: unknown): ModelFallbackParseOutcome;
