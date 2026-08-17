function nonEmptyString(value) {
    return typeof value === "string" && value !== "" ? value : undefined;
}
/**
 * Map typed T1 session stats plus session state to bounded telemetry facts.
 * The inputs are already narrowed by `PiRpcClient.getSessionStats()` /
 * `getState()`; this mapper adds the browser-safety boundary (allowlist of
 * fields) and the truthful three-state context projection.
 */
export function mapSessionTelemetryFacts(stats, state) {
    const facts = { contextState: "no_window" };
    const usage = stats.contextUsage;
    if (usage !== undefined) {
        facts.context = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
        facts.contextState = usage.tokens === null || usage.percent === null ? "post_compaction_pending" : "ok";
    }
    const provider = nonEmptyString(state.model?.provider);
    const id = nonEmptyString(state.model?.id);
    if (provider !== undefined || id !== undefined) {
        const model = {};
        if (provider !== undefined)
            model.provider = provider;
        if (id !== undefined)
            model.id = id;
        facts.model = model;
    }
    const thinkingLevel = nonEmptyString(state.thinkingLevel);
    if (thinkingLevel !== undefined) {
        facts.thinkingLevel = thinkingLevel;
    }
    if (typeof state.autoCompactionEnabled === "boolean") {
        facts.autoCompactionEnabled = state.autoCompactionEnabled;
    }
    return facts;
}
//# sourceMappingURL=conversation-telemetry.js.map