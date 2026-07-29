import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
/**
 * Low-level raw parse. Propagates read-file and YAML-parse errors. Returns
 * `null` only when the parsed YAML is empty or not a top-level mapping.
 */
export async function readAgentConfigFileRaw(configPath, deps = {}) {
    const reader = deps.readFile ?? ((path) => readFile(path, "utf8"));
    const parsed = parseYaml(await reader(configPath));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    return parsed;
}
/**
 * Best-effort adapter: exactly the extension's catch/null contract, relocated.
 * Returns `null` on missing, unreadable, malformed, or non-mapping content.
 */
export async function readAgentConfigFileBestEffort(configPath, deps = {}) {
    try {
        return await readAgentConfigFileRaw(configPath, deps);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=agent-config.js.map