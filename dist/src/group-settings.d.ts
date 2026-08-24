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
export declare class GroupSettingsError extends Error {
    readonly code: GroupSettingsErrorCode;
    constructor(code: GroupSettingsErrorCode, message: string);
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
export declare function createNodeGroupSettingsDeps(): GroupSettingsDeps;
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
/** Deterministic bounded non-secret revision token for one config snapshot. */
export declare function revisionOf(raw: string): string;
export declare function validateGroupModel(data: GroupSettingsData): GroupValidationFinding[];
export declare function listGroups(deps: GroupSettingsDeps, groupsRoot: string): Promise<GroupSummary[]>;
export declare function readGroup(deps: GroupSettingsDeps, groupsRoot: string, group: string): Promise<GroupDetail | null>;
export interface GroupMutationIntent {
    group: string;
    expectedRevision: string;
    mutate: (data: GroupSettingsData) => GroupSettingsData;
    /** Creates the group when its config does not exist (never clobbers). */
    allowCreate?: boolean;
}
export declare function mutateGroup(deps: GroupSettingsDeps, groupsRoot: string, intent: GroupMutationIntent): Promise<GroupDetail>;
