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
export function formatPostSetupWorkbenchSuggestion() {
    return [
        "Optional: to use the Workbench (including the Settings UI), start it yourself with:",
        "  piren gateway",
        "It binds to localhost (127.0.0.1) by default and is not running yet.",
    ].join("\n");
}
//# sourceMappingURL=setup-guidance.js.map