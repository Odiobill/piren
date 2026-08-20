/**
 * G1 — bounded post-setup Workbench suggestion (0.2.0 scope amendment §7).
 *
 * After a SUCCESSFUL `piren setup` (interactive wizard or `--apply`), the
 * operator may be told they can start the Workbench themselves. The message
 * is TEXT ONLY: it never starts the gateway or any service, never writes
 * configuration beyond what setup already confirmed, and never implies the
 * Workbench is running. Callers own the success-only gating; this pure
 * formatter owns only the wording.
 */
export declare function formatPostSetupWorkbenchSuggestion(): string;
