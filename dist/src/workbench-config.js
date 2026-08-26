import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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
export const DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS = 3600;
/** Inclusive closed valid range for `conversation.run_timeout_seconds`. */
const MIN_RUN_TIMEOUT_SECONDS = 1;
export const MAX_WORKBENCH_RUN_TIMEOUT_SECONDS = DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS;
const RUN_TIMEOUT_KEY_PATH = "conversation.run_timeout_seconds";
function defaultResolution() {
    return { conversationRunTimeoutSeconds: DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS, warnings: [] };
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse optional `workbench.yml` text into the resolved run-timeout seconds
 * plus bounded warnings. `null` means the file is absent/unreadable; that is
 * the ordinary absent case and resolves to the default silently.
 */
export function parseWorkbenchConfig(source) {
    if (source === null)
        return defaultResolution();
    let document;
    try {
        document = parseYaml(source);
    }
    catch {
        return { ...defaultResolution(), warnings: [{ key: null, category: "malformed-yaml" }] };
    }
    // An empty/blank document defines nothing: ordinary absent case.
    if (document === null || document === undefined)
        return defaultResolution();
    if (!isPlainObject(document)) {
        return { ...defaultResolution(), warnings: [{ key: null, category: "malformed-yaml" }] };
    }
    const conversation = document["conversation"];
    if (conversation === undefined)
        return defaultResolution();
    if (!isPlainObject(conversation)) {
        // The mapping itself is not a mapping: the defined key cannot exist in a
        // readable form, so treat it as a wrong-type defect on its key path.
        return {
            ...defaultResolution(),
            warnings: [{ key: RUN_TIMEOUT_KEY_PATH, category: "wrong-type" }],
        };
    }
    const raw = conversation["run_timeout_seconds"];
    if (raw === undefined)
        return defaultResolution();
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { ...defaultResolution(), warnings: [{ key: RUN_TIMEOUT_KEY_PATH, category: "wrong-type" }] };
    }
    if (raw < MIN_RUN_TIMEOUT_SECONDS || raw > MAX_WORKBENCH_RUN_TIMEOUT_SECONDS) {
        return { ...defaultResolution(), warnings: [{ key: RUN_TIMEOUT_KEY_PATH, category: "out-of-range" }] };
    }
    return { conversationRunTimeoutSeconds: raw, warnings: [] };
}
/** The broker deadline in milliseconds for a resolved configuration. */
export function workbenchRunDeadlineMs(resolution) {
    return resolution.conversationRunTimeoutSeconds * 1000;
}
/**
 * Bounded non-secret startup diagnostic: names only the managed file, the
 * key path where applicable, the category, and the safe default outcome.
 * Never echoes raw YAML, values, absolute paths, or exception text.
 */
export function formatWorkbenchConfigWarning(warning) {
    const reason = warning.category === "malformed-yaml"
        ? "could not be parsed"
        : warning.category === "wrong-type"
            ? "has an invalid value type"
            : "is outside the valid range";
    const keyPart = warning.key === null ? "" : `${warning.key} `;
    return (`workbench.yml: ${keyPart}${reason} (${warning.category}); ` +
        `using the default ${DEFAULT_WORKBENCH_RUN_TIMEOUT_SECONDS}s conversation run deadline`);
}
/**
 * Production startup reader for optional vault-root `workbench.yml`.
 * Absent OR unreadable resolves to null (the ordinary absent case — fail
 * safe to the default); no error content is ever surfaced.
 */
export function createNodeWorkbenchConfigReader(vaultRoot) {
    return () => {
        try {
            return readFileSync(join(vaultRoot, "workbench.yml"), "utf8");
        }
        catch {
            return null;
        }
    };
}
//# sourceMappingURL=workbench-config.js.map