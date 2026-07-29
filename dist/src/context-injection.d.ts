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
export type ContextInjectionMode = "per_turn" | "session_start_only";
export declare const CONTEXT_INJECTION_MODES: readonly ContextInjectionMode[];
export declare const DEFAULT_CONTEXT_INJECTION_MODE: ContextInjectionMode;
export interface ResolveContextInjectionModeOptions {
    env: Record<string, string | undefined>;
    config: Record<string, unknown> | null;
}
export interface ResolvedContextInjectionMode {
    mode: ContextInjectionMode;
    warnings: string[];
}
/**
 * Resolve the effective context-injection mode with deterministic fallbacks:
 * a valid `PIREN_CONTEXT_INJECTION` override wins; an invalid override warns
 * and falls back to the config value; an invalid/absent config block warns
 * (when present but invalid) and falls back to `per_turn`.
 */
export declare function resolveContextInjectionMode(options: ResolveContextInjectionModeOptions): ResolvedContextInjectionMode;
export interface ShouldInjectContextOptions {
    mode: ContextInjectionMode;
    /** True when a new session started since the last injection (or none happened yet). */
    sessionStartedSinceLastInjection: boolean;
}
/**
 * Injection decision for one before_agent_start turn. `per_turn` always
 * injects (current behavior). `session_start_only` injects only on the first
 * prompt after each session_start.
 */
export declare function shouldInjectContext(options: ShouldInjectContextOptions): boolean;
