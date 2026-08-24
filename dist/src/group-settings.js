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
export function createNodeGroupSettingsDeps() {
    return {
        async readFile(path) {
            try {
                return await readFile(path, "utf8");
            }
            catch {
                return null;
            }
        },
        async writeFileAtomic(path, content, expectedSource) {
            const current = await readFile(path, "utf8").catch(() => null);
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
            catch {
                return [];
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
function extractModel(raw) {
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
    const data = extractModel(raw);
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
    const data = intent.mutate(extractModel(raw));
    const rendered = mergeIntoDocument(raw, data);
    await deps.writeFileAtomic(path, rendered, raw);
    return { name: intent.group, revision: revisionOf(rendered), agents: data.agents, fallbackOrder: data.fallbackOrder, findings: validateGroupModel(data) };
}
//# sourceMappingURL=group-settings.js.map