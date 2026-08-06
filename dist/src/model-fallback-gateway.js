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
import { join } from "node:path";
import { readAgentConfigFileBestEffort } from "./agent-config.js";
import { parseModelFallbackConfig, } from "./model-fallback-config.js";
/** The inert policy: no primary declared, no fallback block. */
export function inertFallbackPolicy() {
    return { primaryModelId: null, fallback: { ok: true, present: false } };
}
/**
 * Normalize the raw `model` mapping into a primary model id, mirroring
 * `src/run.ts` `normalizeModelId`: a bare `id` combined with a `provider`
 * becomes `provider/id`; otherwise the (slash-bearing) `id` is kept as-is.
 * Null when there is no usable id.
 */
export function normalizePrimaryModelId(model) {
    if (typeof model !== "object" || model === null)
        return null;
    const record = model;
    if (typeof record.id !== "string" || record.id.trim() === "")
        return null;
    const id = record.id.trim();
    if (typeof record.provider === "string" && record.provider.trim() !== "" && !id.includes("/")) {
        return `${record.provider.trim()}/${id}`;
    }
    return id;
}
/**
 * Parse a raw agent config mapping (or null) into a gateway fallback policy.
 * The TB1 parser is reused untouched; malformed blocks surface the exact
 * deterministic reason and are runtime-inert.
 */
export function parseAgentFallbackPolicy(rawConfig) {
    if (rawConfig === null)
        return inertFallbackPolicy();
    const model = rawConfig.model;
    const fallbackRaw = typeof model === "object" && model !== null && !Array.isArray(model)
        ? model.fallback
        : undefined;
    return {
        primaryModelId: normalizePrimaryModelId(model),
        fallback: parseModelFallbackConfig(fallbackRaw),
    };
}
/**
 * Agent-name guard mirroring the inbox agent-name rule: lowercase kebab-case.
 * Used before joining the agent into a vault path so an unexpected name can
 * never escape the vault (fail-closed inert).
 */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * Production loader: read `team/<agent>/config.yml` under the vault root
 * best-effort (missing/malformed files => inert) and parse the policy.
 * With no vaultRoot, no agent, or an invalid agent name the policy is inert
 * and no file is touched.
 */
export async function loadAgentFallbackPolicy(vaultRoot, agent, deps = {}) {
    if (vaultRoot === undefined || agent === null || !AGENT_NAME_PATTERN.test(agent))
        return inertFallbackPolicy();
    const raw = await readAgentConfigFileBestEffort(join(vaultRoot, "team", agent, "config.yml"), deps);
    return parseAgentFallbackPolicy(raw);
}
/**
 * Split an exact Pi model id at the FIRST slash into provider and modelId for
 * `client.setModel`. Colons in the model part are preserved (exact local ids
 * such as `ollama/llama3.1:8b`); the slash is the only structural separator.
 */
export function splitFallbackModelId(modelId) {
    const slash = modelId.indexOf("/");
    if (slash === -1)
        return { provider: modelId, modelId: "" };
    return { provider: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
}
export function buildModelFallbackNotice(input) {
    return {
        kind: "model_fallback",
        from: input.from ?? "",
        to: input.to ?? "",
        category: input.category,
        attempt: input.attempt,
        exhausted: input.exhausted,
    };
}
//# sourceMappingURL=model-fallback-gateway.js.map