/**
 * Pure context-injection runtime-preference core (design:
 * Projects/Piren/context-injection-runtime-preference-design.md).
 *
 * The preference is agent-local (`team/<agent>/config.yml` ->
 * `context_injection.mode`) with an optional `PIREN_CONTEXT_INJECTION`
 * environment override for one-process measurement. This module never reads
 * files or YAML: callers pass the already-parsed agent config mapping (or
 * null) from the shared agent-config parsing boundary.
 *
 * Slice C1 note: this module is intentionally not wired into the extension
 * yet; C2 owns the before_agent_start/session_start wiring.
 */
export const CONTEXT_INJECTION_MODES = ["per_turn", "session_start_only"];
export const DEFAULT_CONTEXT_INJECTION_MODE = "per_turn";
function parseMode(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return CONTEXT_INJECTION_MODES.includes(trimmed) ? trimmed : null;
}
/**
 * Resolve the effective context-injection mode with deterministic fallbacks:
 * a valid `PIREN_CONTEXT_INJECTION` override wins; an invalid override warns
 * and falls back to the config value; an invalid/absent config block warns
 * (when present but invalid) and falls back to `per_turn`.
 */
export function resolveContextInjectionMode(options) {
    const warnings = [];
    let configMode = DEFAULT_CONTEXT_INJECTION_MODE;
    const block = options.config?.["context_injection"];
    if (block !== undefined) {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
            warnings.push(`Invalid context_injection block in agent config (expected a mapping with mode: per_turn | session_start_only); falling back to ${DEFAULT_CONTEXT_INJECTION_MODE}.`);
        }
        else {
            const parsed = parseMode(block["mode"]);
            if (parsed !== null) {
                configMode = parsed;
            }
            else {
                warnings.push(`Unknown context_injection.mode '${String(block["mode"])}' in agent config (expected per_turn | session_start_only); falling back to ${DEFAULT_CONTEXT_INJECTION_MODE}.`);
            }
        }
    }
    const envValue = options.env.PIREN_CONTEXT_INJECTION;
    if (envValue !== undefined && envValue.trim() !== "") {
        const parsed = parseMode(envValue);
        if (parsed !== null) {
            return { mode: parsed, warnings };
        }
        warnings.push(`Invalid PIREN_CONTEXT_INJECTION value '${envValue}' (expected per_turn | session_start_only); falling back to the agent config value.`);
    }
    return { mode: configMode, warnings };
}
/**
 * Injection decision for one before_agent_start turn. `per_turn` always
 * injects (current behavior). `session_start_only` injects only on the first
 * prompt after each session_start.
 */
export function shouldInjectContext(options) {
    if (options.mode === "per_turn")
        return true;
    return options.sessionStartedSinceLastInjection;
}
//# sourceMappingURL=context-injection.js.map