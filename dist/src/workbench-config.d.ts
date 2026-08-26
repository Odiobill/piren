/**
 * VR-2 — closed vault-root `workbench.yml` resolver (accepted
 * Projects/Piren/workbench-video-capture-readiness-contract.md §6).
 *
 * `workbench.yml` is an OPTIONAL steward-managed file with exactly ONE
 * defined key in this sequence:
 *
 *   conversation:
 *     run_timeout_seconds: 3600   # positive integer, 1..3600 inclusive
 *
 * Resolution is total (never throws on content problems):
 *   - absent/empty document, absent `conversation` mapping, or absent key ->
 *     the 3600-second internal default with no warning;
 *   - valid integer 1..3600 -> that value with no warning;
 *   - malformed YAML / non-mapping document / wrong value type /
 *     out-of-range integer -> the default plus exactly one bounded,
 *     non-secret warning naming only the key path (when applicable) and a
 *     category (`malformed-yaml`, `wrong-type`, `out-of-range`). Raw YAML,
 *     values, absolute paths, tokens, and exception text are NEVER echoed.
 *
 * Unknown keys are ignored. Piren adds NO writer for this file: by never
 * rewriting it, unknown steward keys are preserved by construction.
 */
export declare const DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS = 3600;
export declare const MAX_WORKBENCH_RUN_TIMEOUT_SECONDS = 3600;
export type WorkbenchConfigWarningCategory = "malformed-yaml" | "wrong-type" | "out-of-range";
export interface WorkbenchConfigWarning {
    /** Key path when the defect is about the one defined key; null for whole-document defects. */
    key: string | null;
    category: WorkbenchConfigWarningCategory;
}
export interface WorkbenchConfigResolution {
    conversationRunTimeoutSeconds: number;
    warnings: WorkbenchConfigWarning[];
}
/**
 * Parse optional `workbench.yml` text into the resolved run-timeout seconds
 * plus bounded warnings. `null` means the file is absent/unreadable; that is
 * the ordinary absent case and resolves to the default silently.
 */
export declare function parseWorkbenchConfig(source: string | null): WorkbenchConfigResolution;
/** The broker deadline in milliseconds for a resolved configuration. */
export declare function workbenchRunDeadlineMs(resolution: WorkbenchConfigResolution): number;
/**
 * Bounded non-secret startup diagnostic: names only the managed file, the
 * key path where applicable, the category, and the safe default outcome.
 * Never echoes raw YAML, values, absolute paths, or exception text.
 */
export declare function formatWorkbenchConfigWarning(warning: WorkbenchConfigWarning): string;
/**
 * Production startup reader for optional vault-root `workbench.yml`.
 * Absent OR unreadable resolves to null (the ordinary absent case — fail
 * safe to the default); no error content is ever surfaced.
 */
export declare function createNodeWorkbenchConfigReader(vaultRoot: string): () => string | null;
