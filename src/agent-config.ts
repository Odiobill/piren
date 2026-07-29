import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/**
 * Shared agent-local config (`team/<agent>/config.yml`) parsing boundary.
 *
 * Two adapters over one raw parse, preserving the DISTINCT pre-existing
 * consumer contracts:
 *
 * - `readAgentConfigFileRaw` propagates read-file and YAML-parse errors. This
 *   is the `src/run.ts` contract: a missing/unreadable/malformed agent config
 *   rejects Pi command construction and surfaces as a startup error.
 * - `readAgentConfigFileBestEffort` converts any failure to `null`. This is
 *   the Pi extension contract: boot tolerates missing/malformed config and
 *   falls back to defaults.
 *
 * Neither adapter validates individual keys; consumers resolve their own
 * preferences from the raw mapping (or null).
 */

export interface AgentConfigReadDeps {
  readFile?: ((path: string) => Promise<string>) | undefined;
}

/**
 * Low-level raw parse. Propagates read-file and YAML-parse errors. Returns
 * `null` only when the parsed YAML is empty or not a top-level mapping.
 */
export async function readAgentConfigFileRaw(configPath: string, deps: AgentConfigReadDeps = {}): Promise<Record<string, unknown> | null> {
  const reader = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const parsed = parseYaml(await reader(configPath)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Best-effort adapter: exactly the extension's catch/null contract, relocated.
 * Returns `null` on missing, unreadable, malformed, or non-mapping content.
 */
export async function readAgentConfigFileBestEffort(configPath: string, deps: AgentConfigReadDeps = {}): Promise<Record<string, unknown> | null> {
  try {
    return await readAgentConfigFileRaw(configPath, deps);
  } catch {
    return null;
  }
}
