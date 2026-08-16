/**
 * Decommission (ADR-0043 2026-08-14) — Conversation-neutral local-policy
 * roster core (replaces the retired room-agent roster; served only at
 * `GET /api/conversation-agents`, never aliased).
 *
 * `online` is local installation policy only: membership in this gateway
 * machine's already-resolved `runnableAgents` set. It is NOT Pi-process
 * presence, provider reachability, transport state, remote availability, or
 * identity. The roster is explicitly supplied by the caller (the CLI passes
 * the vault-defined `team/<agent>/` names it has already resolved with local
 * policy); there is no config reread, no directory creation, no probing, and
 * no polling here.
 *
 * D5: each entry additively carries the agent's gateway-projected
 * configured model when one was supplied at gateway startup. The projection
 * (`projectConfiguredAgentModels`) reads the declared
 * `team/<agent>/config.yml` model preference ONCE at startup, best-effort,
 * and formats it with the same canonical `formatPiModel` used for Pi
 * launch. Absent/malformed configuration projects to null and the field is
 * omitted from the entry — never an inferred, live-session, or invented
 * value.
 */
import { join } from "node:path";
import { readAgentConfigFileBestEffort } from "./agent-config.js";
import { formatPiModel } from "./run.js";
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
export function buildConversationAgentsResponse(vaultAgents, runnableAgents, configuredModels) {
    const runnable = new Set(runnableAgents);
    const names = [...new Set(vaultAgents)].sort((a, b) => a.localeCompare(b));
    return {
        agents: names.map((name) => {
            const entry = { name, online: runnable.has(name) };
            const model = configuredModels?.[name];
            if (typeof model === "string" && model !== "")
                entry.model = model;
            return entry;
        }),
    };
}
/**
 * Agent-name guard mirroring the inbox agent-name rule (lowercase
 * kebab-case), applied before joining the agent into a vault path so an
 * unexpected name can never escape the vault (fail-closed null).
 */
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
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
export async function projectConfiguredAgentModels(vaultRoot, vaultAgents, deps = {}) {
    const projected = {};
    for (const agent of [...new Set(vaultAgents)]) {
        if (vaultRoot === undefined || !AGENT_NAME_PATTERN.test(agent)) {
            projected[agent] = null;
            continue;
        }
        const raw = await readAgentConfigFileBestEffort(join(vaultRoot, "team", agent, "config.yml"), deps);
        projected[agent] = raw === null ? null : (formatPiModel(raw.model) ?? null);
    }
    return projected;
}
//# sourceMappingURL=conversation-agents.js.map