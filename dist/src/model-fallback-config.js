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
export const MAX_FALLBACK_MODELS = 5;
/**
 * Conservative exact-id grammar for fallback model strings. Provider part is
 * lowercase `[a-z0-9][a-z0-9._-]*`; model part may contain colons (local ids
 * such as `ollama/llama3.1:8b`), so a trailing `:...` is part of the exact id
 * and is never rejected by a heuristic suffix parser.
 */
export const FALLBACK_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/;
function isMapping(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse the raw `model.fallback` value into a typed result. `undefined` is the
 * absent/inert case (`present: false`); any other present value must be a
 * mapping. Failures are deterministic and non-secret; they never echo the raw
 * YAML or model ids beyond the failing position.
 */
export function parseModelFallbackConfig(raw) {
    if (raw === undefined) {
        return { ok: true, present: false };
    }
    if (raw === null || !isMapping(raw)) {
        return { ok: false, reason: "model.fallback must be a mapping." };
    }
    const modelsRaw = raw.models;
    if (!Array.isArray(modelsRaw)) {
        return { ok: false, reason: "model.fallback.models must be an array." };
    }
    if (modelsRaw.length === 0) {
        return { ok: false, reason: "model.fallback.models must be a non-empty array." };
    }
    if (modelsRaw.length > MAX_FALLBACK_MODELS) {
        return {
            ok: false,
            reason: `model.fallback.models exceeds the maximum of ${MAX_FALLBACK_MODELS} entries.`,
        };
    }
    const models = [];
    for (const entry of modelsRaw) {
        if (typeof entry !== "string" || entry === "") {
            return { ok: false, reason: "model.fallback.models must contain only non-empty strings." };
        }
        if (!FALLBACK_MODEL_ID_PATTERN.test(entry)) {
            return { ok: false, reason: `model.fallback.models contains an invalid model id at position ${models.length}.` };
        }
        if (models.includes(entry)) {
            return { ok: false, reason: "model.fallback.models contains a duplicate id." };
        }
        models.push(entry);
    }
    let autoSwitch = true;
    if (raw.auto_switch !== undefined) {
        if (typeof raw.auto_switch !== "boolean") {
            return { ok: false, reason: "model.fallback.auto_switch must be a boolean." };
        }
        autoSwitch = raw.auto_switch;
    }
    return { ok: true, present: true, config: { autoSwitch, models } };
}
//# sourceMappingURL=model-fallback-config.js.map