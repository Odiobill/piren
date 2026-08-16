export interface ConversationAgentEntry {
    name: string;
    online: boolean;
    /**
     * D5: the gateway-projected configured model label (canonical Pi launch
     * formatting). Present only when a usable declared value exists; absent
     * means unavailable (absent/malformed configuration), which the browser
     * visibly distinguishes instead of inventing a value.
     */
    model?: string;
}
export interface ConversationAgentsResponse {
    agents: ConversationAgentEntry[];
}
/**
 * Build the deterministic roster response. Names come from the supplied
 * vault roster (deduplicated, sorted by name); `online` is true exactly when
 * the name is in the gateway's runnable set. An empty supplied roster
 * returns an empty list; runnable agents absent from the roster are not
 * added (the roster, not the runnable set, drives membership).
 *
 * D5: `configuredModels` is the bounded startup-projected map from
 * `projectConfiguredAgentModels`; an entry carries `model` only when the
 * projected value is a non-empty string. Missing/null/empty values omit the
 * field (the browser renders that as unavailable).
 */
export declare function buildConversationAgentsResponse(vaultAgents: readonly string[], runnableAgents: readonly string[], configuredModels?: Readonly<Record<string, string | null | undefined>>): ConversationAgentsResponse;
export interface ProjectConfiguredAgentModelsDeps {
    readFile?: ((path: string) => Promise<string>) | undefined;
}
/**
 * D5 startup projection: read each vault agent's declared
 * `team/<agent>/config.yml` model preference ONCE (best-effort) and format
 * it with the same canonical `formatPiModel` used for Pi launch. Missing,
 * unreadable, or malformed configuration — and malformed/absent model
 * values — project to null (unavailable), never an invented or inferred
 * value. No live Pi session or provider is queried, and nothing is reread
 * per request: the gateway calls this once at startup and serves the
 * resulting map.
 */
export declare function projectConfiguredAgentModels(vaultRoot: string | undefined, vaultAgents: readonly string[], deps?: ProjectConfiguredAgentModelsDeps): Promise<Record<string, string | null>>;
