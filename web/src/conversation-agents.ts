/**
 * Decommission (ADR-0043 2026-08-14) — Conversation-neutral local-policy
 * roster types + parser for the Workbench. The web client reads the roster
 * ONLY from `GET /api/conversation-agents` (the retired `/api/room-agents`
 * route is gone, never aliased). `online` is local installation policy only
 * (membership in the gateway's resolved runnable set) — never Pi-process
 * presence, provider reachability, transport state, or identity.
 */
export interface ConversationAgentEntry {
  name: string;
  online: boolean;
  /**
   * D5: the gateway-projected configured model label (declared
   * `team/<agent>/config.yml` model preference in canonical Pi launch
   * formatting). Absent means unavailable; the browser never reads agent
   * configuration or infers a live session/provider value itself.
   */
  model?: string;
}

export interface ConversationAgentsResponse {
  agents: ConversationAgentEntry[];
}

/**
 * The bounded parts of the gateway-projected configured-model string
 * (`provider/model[:thinking]`), rendered as three compact card lines.
 */
export interface ConfiguredModelParts {
  provider: string;
  modelId: string;
  thinking: string | null;
}

/**
 * Parse the gateway-projected configured-model string into its presentation
 * parts. Returns null when the value is not `provider/model[:thinking]` — the
 * caller then shows the raw string truthfully (no browser-derived
 * interpretation of malformed data).
 */
export function parseConfiguredModelLabel(model: string): ConfiguredModelParts | null {
  const providerIndex = model.indexOf("/");
  if (providerIndex <= 0) return null;
  const provider = model.slice(0, providerIndex);
  // A colon may appear only as the single thinking separator after the model
  // id; a colon in the provider part is malformed (raw fallback).
  if (provider.includes(":")) return null;
  const rest = model.slice(providerIndex + 1);
  if (rest === "") return null;
  const colonIndex = rest.indexOf(":");
  if (colonIndex < 0) return { provider, modelId: rest, thinking: null };
  const modelId = rest.slice(0, colonIndex);
  const thinking = rest.slice(colonIndex + 1);
  if (modelId === "" || thinking === "" || thinking.includes(":")) return null;
  return { provider, modelId, thinking };
}

/** Fail-closed validation of GET /api/conversation-agents. */
export function parseConversationAgents(json: unknown): ConversationAgentsResponse {
  if (typeof json !== "object" || json === null || !("agents" in json)) {
    throw new Error("unexpected /api/conversation-agents response");
  }
  const agents = (json as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) throw new Error("unexpected /api/conversation-agents response");
  for (const entry of agents) {
    if (typeof entry !== "object" || entry === null) throw new Error("unexpected roster entry");
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name === "" || typeof record.online !== "boolean") {
      throw new Error("unexpected roster entry");
    }
    // D5: the optional configured-model field is validated strictly when
    // present; absent stays absent (rendered as unavailable).
    if (record.model !== undefined && (typeof record.model !== "string" || record.model === "")) {
      throw new Error("unexpected roster entry");
    }
  }
  return {
    agents: (agents as Array<Record<string, unknown>>).map((record) => {
      const entry: ConversationAgentEntry = { name: record.name as string, online: record.online as boolean };
      if (record.model !== undefined) entry.model = record.model as string;
      return entry;
    }),
  };
}
