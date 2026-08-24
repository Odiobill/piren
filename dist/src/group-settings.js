import { mkdir, readFile, rename, readdir as nodeReaddir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isValidGroupName } from "./group-config.js";
export class GroupSettingsError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** True when a filesystem error means the path is genuinely absent. */
function isEnoent(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT");
}
/** Bounded non-secret I/O failure; never treated as absence (fail closed). */
function ioError() {
    return new GroupSettingsError("io", "The agent groups state could not be read.");
}
export function createNodeGroupSettingsDeps() {
    return {
        async readFile(path) {
            try {
                return await readFile(path, "utf8");
            }
            catch (error) {
                if (isEnoent(error))
                    return null;
                throw ioError();
            }
        },
        async writeFileAtomic(path, content, expectedSource) {
            let current;
            try {
                current = await readFile(path, "utf8");
            }
            catch (error) {
                if (isEnoent(error))
                    current = null;
                else
                    throw ioError();
            }
            if (current !== expectedSource) {
                throw new GroupSettingsError("conflict", "The group config changed since it was read; nothing was written.");
            }
            await mkdir(dirname(path), { recursive: true });
            const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
            await writeFile(temp, content, "utf8");
            const handle = await import("node:fs/promises").then((fs) => fs.open(temp, "r+"));
            await handle.sync();
            await handle.close();
            await rename(temp, path);
        },
        async readdirSubdirs(path) {
            try {
                const entries = await nodeReaddir(path, { withFileTypes: true });
                return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
            }
            catch (error) {
                if (isEnoent(error))
                    return [];
                throw ioError();
            }
        },
        async mkdir(path) {
            await mkdir(path, { recursive: true });
        },
    };
}
function configPath(groupsRoot, group) {
    return join(groupsRoot, group, "config.yml");
}
/** Deterministic bounded non-secret revision token for one config snapshot. */
export function revisionOf(raw) {
    let hash = 5381;
    for (let i = 0; i < raw.length; i += 1)
        hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
    return `rev-${hash.toString(16)}-${raw.length.toString(16)}`;
}
/** Tolerant model extraction; malformed files yield an empty model (findings surface problems instead). */
export function parseGroupModel(raw) {
    const data = { agents: [], fallbackOrder: {} };
    if (raw.trim() === "")
        return data;
    let parsed;
    try {
        parsed = parseYaml(raw);
    }
    catch {
        return data;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return data;
    const record = parsed;
    if (Array.isArray(record.agents))
        data.agents = record.agents.filter((a) => typeof a === "string");
    const order = record.fallback_order;
    if (order !== null && typeof order === "object" && !Array.isArray(order)) {
        for (const [member, candidates] of Object.entries(order)) {
            if (Array.isArray(candidates)) {
                data.fallbackOrder[member] = candidates.filter((c) => typeof c === "string");
            }
        }
    }
    return data;
}
/** Overlay the modelled keys onto the existing document so unknown top-level YAML fields survive. */
function mergeIntoDocument(raw, data) {
    let root = {};
    if (raw.trim() !== "") {
        try {
            const parsed = parseYaml(raw);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                root = parsed;
            }
        }
        catch {
            // Unparseable source: refuse to merge; caller already failed closed on read.
            throw new GroupSettingsError("invalid", "The group config is not parseable YAML; fix it manually.");
        }
    }
    root.agents = [...data.agents];
    root.fallback_order = { ...data.fallbackOrder };
    return stringifyYaml(root, { sortMapEntries: false });
}
export function validateGroupModel(data) {
    const findings = [];
    for (const [member, candidates] of Object.entries(data.fallbackOrder)) {
        if (!data.agents.includes(member)) {
            findings.push({ severity: "error", kind: "dangling-fallback", detail: `fallback entry references non-member ${member}` });
        }
        for (const candidate of candidates) {
            if (!data.agents.includes(candidate)) {
                findings.push({ severity: "error", kind: "dangling-candidate", detail: `fallback candidate ${candidate} is not a member` });
            }
            if (candidate === member) {
                findings.push({ severity: "error", kind: "self-fallback", detail: `${member} lists itself as a fallback candidate` });
            }
        }
    }
    return findings;
}
export async function listGroups(deps, groupsRoot) {
    const names = (await deps.readdirSubdirs(groupsRoot)).filter((name) => isValidGroupName(name)).sort();
    const summaries = [];
    for (const name of names) {
        const raw = await deps.readFile(configPath(groupsRoot, name));
        if (raw === null)
            continue;
        summaries.push({ name, revision: revisionOf(raw) });
    }
    return summaries;
}
export async function readGroup(deps, groupsRoot, group) {
    if (!isValidGroupName(group))
        throw new GroupSettingsError("invalid", "Invalid agent group name.");
    const raw = await deps.readFile(configPath(groupsRoot, group));
    if (raw === null)
        return null;
    const data = parseGroupModel(raw);
    return { name: group, revision: revisionOf(raw), agents: data.agents, fallbackOrder: data.fallbackOrder, findings: validateGroupModel(data) };
}
export async function mutateGroup(deps, groupsRoot, intent) {
    if (!isValidGroupName(intent.group))
        throw new GroupSettingsError("invalid", "Invalid agent group name.");
    const path = configPath(groupsRoot, intent.group);
    const raw = await deps.readFile(path);
    if (raw === null) {
        if (!intent.allowCreate)
            throw new GroupSettingsError("not-found", "Agent group was not found.");
        if (intent.expectedRevision !== "absent") {
            throw new GroupSettingsError("conflict", "The group config changed since it was read; nothing was written.");
        }
        const data = intent.mutate({ agents: [], fallbackOrder: {} });
        const skillsDir = join(groupsRoot, intent.group, "skills");
        await deps.mkdir(skillsDir);
        await deps.writeFileAtomic(path, mergeIntoDocument("", data), null);
        return { name: intent.group, revision: revisionOf(mergeIntoDocument("", data)), agents: data.agents, fallbackOrder: data.fallbackOrder, findings: validateGroupModel(data) };
    }
    if (intent.expectedRevision !== revisionOf(raw)) {
        throw new GroupSettingsError("conflict", "The group config changed since it was read; nothing was written.");
    }
    const data = intent.mutate(parseGroupModel(raw));
    const rendered = mergeIntoDocument(raw, data);
    await deps.writeFileAtomic(path, rendered, raw);
    return { name: intent.group, revision: revisionOf(rendered), agents: data.agents, fallbackOrder: data.fallbackOrder, findings: validateGroupModel(data) };
}
// ---------------------------------------------------------------------------
// Vault roster + cross-group validation (ST-4 correction)
// ---------------------------------------------------------------------------
/** Every vault-defined `team/<agent>/` identity, sorted; absent team dir is empty. */
export async function listVaultAgents(deps, vaultRoot) {
    const names = await deps.readdirSubdirs(join(vaultRoot, "team"));
    return names.filter((name) => isValidGroupName(name)).sort();
}
/**
 * Read-only validation across ALL group configs, aligned with the CLI/core
 * categories rather than only per-detail fallback findings. I/O failures
 * propagate fail-closed as GroupSettingsError("io").
 */
export async function validateAllGroups(deps, groupsRoot, teamAgentsRoot) {
    const issues = [];
    const names = (await deps.readdirSubdirs(groupsRoot)).filter((name) => isValidGroupName(name)).sort();
    const teamAgents = new Set(await listVaultAgents(deps, join(teamAgentsRoot, "..")));
    const memberGroups = new Map();
    for (const group of names) {
        const raw = await deps.readFile(configPath(groupsRoot, group));
        if (raw === null) {
            issues.push({
                group,
                kind: "missing-config",
                severity: "error",
                message: `Group directory 'agent-groups/${group}/' has no config.yml.`,
            });
            continue;
        }
        const data = parseGroupModel(raw);
        for (const agent of data.agents) {
            const groups = memberGroups.get(agent) ?? [];
            groups.push(group);
            memberGroups.set(agent, groups);
            if (!teamAgents.has(agent)) {
                issues.push({
                    group,
                    kind: "missing-agent-dir",
                    severity: "error",
                    message: `Agent '${agent}' in group '${group}' has no team/${agent}/ directory.`,
                });
            }
        }
        for (const [member, candidates] of Object.entries(data.fallbackOrder)) {
            for (const candidate of candidates) {
                if (!data.agents.includes(candidate)) {
                    issues.push({
                        group,
                        kind: "dangling-fallback",
                        severity: "error",
                        message: `fallback_order for '${member}' references '${candidate}' which is not a member of group '${group}'.`,
                    });
                }
            }
        }
    }
    for (const [agent, groups] of memberGroups) {
        const unique = [...new Set(groups)];
        if (unique.length > 1) {
            for (const group of unique) {
                issues.push({
                    group,
                    kind: "duplicate-across-groups",
                    severity: "info",
                    message: `Agent '${agent}' is declared in ${unique.length} groups: ${unique.join(", ")}.`,
                });
            }
        }
    }
    return issues;
}
//# sourceMappingURL=group-settings.js.map