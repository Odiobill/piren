export interface AgentSessionEntry {
    /** Filename, e.g. `20260623T090000Z-add-tests.md`. */
    name: string;
    /** Vault-relative path, e.g. `team/piren/sessions/20260623T090000Z-add-tests.md`. */
    path: string;
    /** Title extracted from the first `# Heading`, or the filename stem. */
    title: string;
    /** `created` frontmatter value if present, ISO string. */
    created: string | null;
    bytes: number;
    mtimeMs: number;
}
export interface ListAgentSessionsResult {
    agent: string;
    sessions: AgentSessionEntry[];
}
/**
 * List session-summary files under `team/<agent>/sessions/` for a vault.
 *
 * Session summaries are the vault-durable records written by
 * `session_write_summary`. This is the "past conversations" surface for the
 * web UI's session list. Files are sorted newest-first by filename (the
 * timestamp-prefixed naming from session_write_summary sorts chronologically).
 *
 * Reuses resolveVaultPath for path-boundary enforcement: the resolved
 * directory must be inside the vault.
 */
export declare function listAgentSessions(vaultRoot: string, agentName: string): Promise<ListAgentSessionsResult>;
