/**
 * Agent identity + permission management (`piren agent` command).
 *
 * Piren splits agent identity (vault `team/<agent>/` dirs) from runtime
 * permission (local `allowed_agents` in ~/.config/piren/config.yml). This
 * module manages BOTH sides together so the operator never has to hand-edit
 * two places to add, remove, or clone an agent.
 *
 * Pure core + injected deps, mirroring the service-lifecycle pattern. The
 * pure `plan*` functions describe what would happen; the `execute*` functions
 * take injected filesystem deps so tests drive them against a tmpdir.
 *
 * Design decisions (confirmed with the steward):
 *   - add: scaffold team/<name>/ AND add to allowed_agents.
 *   - remove: ALWAYS drop from allowed_agents; the vault dir is deleted only
 *     after an explicit confirm at the CLI layer.
 *   - clone: copy the source team dir verbatim (identity files carry over) and
 *     permit the new name.
 *   - Config edits preserve all unrelated keys (discord, telegram, vault_root)
 *     by parse -> mutate -> stringify, exactly like updateServiceStatusYaml.
 */
export declare const AGENT_NAME_PATTERN: RegExp;
export type AgentSubcommand = "add" | "remove" | "clone" | "list";
export interface AgentNameValidation {
    ok: boolean;
    message?: string;
}
export declare function validateAgentName(name: string): AgentNameValidation;
export declare function addAllowedAgent(existing: string[], agent: string): string[];
export declare function removeAllowedAgent(existing: string[], agent: string): string[];
export declare function agentDirPath(vaultRoot: string, agentName: string): string;
/**
 * Rewrite config.yml content with an updated allowed_agents list. Unrelated
 * keys (vault_root, discord, telegram, packages, ...) are preserved verbatim
 * by re-serializing the parsed document.
 */
export declare function updateAllowedAgentsInConfig(existingConfig: string, nextAllowed: string[]): string;
export interface AddAgentPlan {
    shouldScaffold: boolean;
    shouldUpdateConfig: boolean;
    updatedConfig: string;
    dirPath: string;
    error?: string;
}
export interface AddAgentPlanOptions {
    vaultRoot: string;
    agentName: string;
    existingConfig: string;
    force: boolean;
}
export declare function planAddAgent(opts: AddAgentPlanOptions): AddAgentPlan;
export interface RemoveAgentPlan {
    shouldRemoveDir: boolean;
    shouldUpdateConfig: boolean;
    updatedConfig: string;
    dirPath: string;
}
export interface RemoveAgentPlanOptions {
    vaultRoot: string;
    agentName: string;
    existingConfig: string;
}
export declare function planRemoveAgent(opts: RemoveAgentPlanOptions): RemoveAgentPlan;
export interface CloneAgentPlan {
    shouldCopy: boolean;
    shouldUpdateConfig: boolean;
    updatedConfig: string;
    sourceDir: string;
    targetDir: string;
    error?: string;
}
export interface CloneAgentPlanOptions {
    vaultRoot: string;
    sourceAgent: string;
    targetAgent: string;
    existingConfig: string;
}
export declare function planCloneAgent(opts: CloneAgentPlanOptions): CloneAgentPlan;
export interface AgentManageDeps {
    exists: (path: string) => Promise<boolean>;
    scaffoldAgentDir: (vaultRoot: string, agentName: string) => Promise<string>;
    copyDir: (source: string, target: string) => Promise<void>;
    removeDir: (path: string) => Promise<void>;
    log: (message: string) => void;
}
export interface AddAgentResult {
    agentName: string;
    scaffoldedDir: string;
    updatedConfig: string;
    configUpdated: boolean;
    error?: string;
}
export interface AddAgentExecOptions {
    vaultRoot: string;
    agentName: string;
    existingConfig: string;
    force: boolean;
    deps: AgentManageDeps;
}
export declare function executeAddAgent(opts: AddAgentExecOptions): Promise<AddAgentResult>;
export interface CloneAgentResult {
    sourceAgent: string;
    targetAgent: string;
    targetDir: string;
    updatedConfig: string;
    configUpdated: boolean;
    error?: string;
}
export interface CloneAgentExecOptions {
    vaultRoot: string;
    sourceAgent: string;
    targetAgent: string;
    existingConfig: string;
    deps: AgentManageDeps;
}
export declare function executeCloneAgent(opts: CloneAgentExecOptions): Promise<CloneAgentResult>;
export interface RemoveAgentResult {
    agentName: string;
    dirPath: string;
    dirRemoved: boolean;
    updatedConfig: string;
    configUpdated: boolean;
    error?: string;
}
export interface RemoveAgentExecOptions {
    vaultRoot: string;
    agentName: string;
    existingConfig: string;
    /** Whether the operator confirmed deleting the vault directory. */
    confirmedDeleteDir: boolean;
    deps: AgentManageDeps;
}
export declare function executeRemoveAgent(opts: RemoveAgentExecOptions): Promise<RemoveAgentResult>;
