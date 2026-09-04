import { classifyRunOutcome } from "./model-fallback-outcome.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function createInteractiveFallbackIncident() {
    return { events: [], malformed: false };
}
/**
 * Copy only the extension event's own structured fields and bind its type from
 * the registered lifecycle name; unstructured input taints the incident rather
 * than creating terminal evidence.
 */
export function recordInteractiveFallbackEvent(incident, type, event) {
    if (!isRecord(event)) {
        incident.malformed = true;
        return;
    }
    incident.events.push({ ...event, type });
}
/**
 * `agent_settled` alone is insufficient in the TUI: another extension may have
 * started a run first. Preserve the existing classifier's zero-side-effect gate
 * and make a non-idle or malformed adapter state unconditionally ambiguous.
 */
export function settleInteractiveFallbackIncident(incident, input) {
    if (!input.isIdle) {
        return { outcome: { category: "ambiguous", detail: "the interactive session was not idle at agent_settled." } };
    }
    if (incident.malformed) {
        return { outcome: { category: "ambiguous", detail: "the interactive lifecycle emitted malformed evidence." } };
    }
    return { outcome: classifyRunOutcome(incident.events) };
}
//# sourceMappingURL=interactive-model-fallback.js.map