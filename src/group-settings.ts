import { mkdir, readFile, rename, readdir as nodeReaddir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isValidGroupName } from "./group-config.js";

/**
 * ST-4 (Settings contract §2.5/§4.5): the typed vault-owned Agent Groups
 * Settings write core over the existing `piren group` semantics.
 *
 * Modelled surface is exactly `agents` + `fallback_order`. Mutations are
 * revision-checked, atomic (temp+fsync+rename), never clobber a concurrent
 * change (stale revision fails as conflict), and structurally PRESERVE
 * unknown top-level YAML fields. Create never overwrites an existing group
 * config and still creates the `skills/` directory per existing CLI
 * semantics. Local runnable policy is never read or written here.
 */

export type GroupSettingsErrorCode = "conflict" | "not-found" | "exists" | "invalid";

export class GroupSettingsError extends Error {
  constructor(readonly code: GroupSettingsErrorCode, message: string) {
    super(message);
  }
}

export interface GroupSettingsDeps {
  /** Raw file text, or null when absent. */
  readFile(path: string): Promise<string | null>;
  /** Atomic revision-checked replace: fails as conflict when the current
   * content differs from expectedSource; creates parent directories. */
  writeFileAtomic(path: string, content: string, expectedSource: string | null): Promise<void>;
  /** Subdirectory names; empty when the directory is absent. */
  readdirSubdirs(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
}

export function createNodeGroupSettingsDeps(): GroupSettingsDeps {
  return {
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
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
      } catch {
        return [];
      }
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
  };
}

export interface GroupSettingsData {
  agents: string[];
  fallbackOrder: Record<string, string[]>;
}

export interface GroupSummary {
  name: string;
  revision: string;
}

export interface GroupValidationFinding {
  severity: "error" | "info";
  kind: string;
  detail: string;
}

export interface GroupDetail extends GroupSettingsData {
  name: string;
  revision: string;
  findings: GroupValidationFinding[];
}

function configPath(groupsRoot: string, group: string): string {
  return join(groupsRoot, group, "config.yml");
}

/** Deterministic bounded non-secret revision token for one config snapshot. */
export function revisionOf(raw: string): string {
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  return `rev-${hash.toString(16)}-${raw.length.toString(16)}`;
}

/** Tolerant model extraction; malformed files yield an empty model (findings surface problems instead). */
function extractModel(raw: string): GroupSettingsData {
  const data: GroupSettingsData = { agents: [], fallbackOrder: {} };
  if (raw.trim() === "") return data;
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return data;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return data;
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.agents)) data.agents = record.agents.filter((a): a is string => typeof a === "string");
  const order = record.fallback_order;
  if (order !== null && typeof order === "object" && !Array.isArray(order)) {
    for (const [member, candidates] of Object.entries(order as Record<string, unknown>)) {
      if (Array.isArray(candidates)) {
        data.fallbackOrder[member] = candidates.filter((c): c is string => typeof c === "string");
      }
    }
  }
  return data;
}

/** Overlay the modelled keys onto the existing document so unknown top-level YAML fields survive. */
function mergeIntoDocument(raw: string, data: GroupSettingsData): string {
  let root: Record<string, unknown> = {};
  if (raw.trim() !== "") {
    try {
      const parsed = parseYaml(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable source: refuse to merge; caller already failed closed on read.
      throw new GroupSettingsError("invalid", "The group config is not parseable YAML; fix it manually.");
    }
  }
  root.agents = [...data.agents];
  root.fallback_order = { ...data.fallbackOrder };
  return stringifyYaml(root, { sortMapEntries: false });
}

export function validateGroupModel(data: GroupSettingsData): GroupValidationFinding[] {
  const findings: GroupValidationFinding[] = [];
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

export async function listGroups(deps: GroupSettingsDeps, groupsRoot: string): Promise<GroupSummary[]> {
  const names = (await deps.readdirSubdirs(groupsRoot)).filter((name) => isValidGroupName(name)).sort();
  const summaries: GroupSummary[] = [];
  for (const name of names) {
    const raw = await deps.readFile(configPath(groupsRoot, name));
    if (raw === null) continue;
    summaries.push({ name, revision: revisionOf(raw) });
  }
  return summaries;
}

export async function readGroup(deps: GroupSettingsDeps, groupsRoot: string, group: string): Promise<GroupDetail | null> {
  if (!isValidGroupName(group)) throw new GroupSettingsError("invalid", "Invalid agent group name.");
  const raw = await deps.readFile(configPath(groupsRoot, group));
  if (raw === null) return null;
  const data = extractModel(raw);
  return { name: group, revision: revisionOf(raw), agents: data.agents, fallbackOrder: data.fallbackOrder, findings: validateGroupModel(data) };
}

export interface GroupMutationIntent {
  group: string;
  expectedRevision: string;
  mutate: (data: GroupSettingsData) => GroupSettingsData;
  /** Creates the group when its config does not exist (never clobbers). */
  allowCreate?: boolean;
}

export async function mutateGroup(deps: GroupSettingsDeps, groupsRoot: string, intent: GroupMutationIntent): Promise<GroupDetail> {
  if (!isValidGroupName(intent.group)) throw new GroupSettingsError("invalid", "Invalid agent group name.");
  const path = configPath(groupsRoot, intent.group);
  const raw = await deps.readFile(path);
  if (raw === null) {
    if (!intent.allowCreate) throw new GroupSettingsError("not-found", "Agent group was not found.");
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
