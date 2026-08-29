import { access, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { listCronJobs, listActiveDevices } from "./cron.js";
import { planSchedulerTick } from "./scheduler.js";
import { evaluateTaskDependencyEligibility, loadSchedulerInboxState, } from "./scheduler-dependencies.js";
import { evaluateRetryEligibility } from "./scheduler-retry.js";
import { resolveSchedulerConfig, } from "./scheduler-loop.js";
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "piren", "config.yml");
/**
 * Resolve the locally enabled agent set: allowed_agents minus excluded_agents.
 * Shared by dry-run and --once so both apply the same local policy before
 * planning (ADR-0029: local policy first).
 */
export function resolveEnabledAgents(config) {
    const allowed = config.allowed_agents ?? [];
    const excluded = new Set(config.excluded_agents ?? []);
    return allowed.filter((agent) => !excluded.has(agent));
}
export async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
export async function readYamlConfig(path) {
    if (!(await pathExists(path)))
        return {};
    const content = await readFile(path, "utf8");
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== "object")
        return {};
    return parsed;
}
export { DEFAULT_CONFIG_PATH };
/**
 * Execute a dry-run scheduler tick: load vault state, plan proposed claims,
 * and return a human-readable report. Does NOT execute any claims.
 */
export async function schedulerDryRun(options) {
    const deviceId = options.deviceId ?? hostname();
    const staleAfterMs = options.staleAfterMs ?? 300_000;
    const now = options.now ?? new Date();
    // Resolve local config
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const config = await readYamlConfig(configPath);
    const vaultRoot = config.vault_root;
    if (!vaultRoot) {
        return "SCHEDULER DRY-RUN\n\nNo vault root configured. Set vault_root in ~/.config/piren/config.yml.\n";
    }
    const allowedAgents = resolveEnabledAgents(config);
    const enabledAgents = allowedAgents;
    if (enabledAgents.length === 0) {
        return `SCHEDULER DRY-RUN (device: ${deviceId})\n\nNo enabled agents. Configure allowed_agents in local config.\n`;
    }
    // 0.2 Settings contract §4.3 (SGC-1/2): automation classes are the sole
    // execution gates; there is no master gate. The dry-run stays read-only
    // regardless of the gates, previews an honest tick (disabled classes are
    // never proposed), and is discovery-complete: unclaimed pending inbox
    // tasks are still listed with a bounded [DISABLED] status when inbox
    // automation is disabled.
    const schedulerConfig = resolveSchedulerConfig(config);
    const automation = schedulerConfig.automation;
    const legacyMasterGate = schedulerConfig.legacyMasterGate;
    // Load inbox state (pending candidates + dependency resolver) across all
    // enabled agents. The resolver includes claimed files so an atomic claim
    // never hides a prerequisite (ADR-0038 R1).
    const inboxState = await loadSchedulerInboxState({ vaultRoot, enabledAgents });
    const pendingTasks = inboxState.pendingTasks.map((t) => toPlannerTask(t));
    // Load due cron jobs for each enabled agent (cron jobs carry no deps).
    const dueCronJobs = [];
    for (const agentName of enabledAgents) {
        try {
            // Load cron jobs
            const cronResult = await listCronJobs({ vaultRoot, agentName });
            for (const job of cronResult.jobs) {
                dueCronJobs.push({
                    path: job.path,
                    agentName: job.agent,
                    devicePolicy: job.devicePolicy,
                    mode: job.mode,
                });
            }
        }
        catch {
            // Skip if cron jobs can't be loaded
        }
    }
    // Load active devices per agent
    const activeDevices = new Map();
    for (const agentName of enabledAgents) {
        try {
            const devicesResult = await listActiveDevices({ vaultRoot, agentName, staleAfterMs, now: () => now });
            activeDevices.set(agentName, devicesResult.devices.map((d) => ({ deviceId: d.deviceId, priority: d.priority })));
        }
        catch {
            activeDevices.set(agentName, []);
        }
    }
    // Plan claims. The planner excludes dependency-blocked tasks from claim
    // proposals using the resolver map (fail-closed), and excludes disabled
    // automation classes (0.2 Settings contract §4.3).
    const claims = planSchedulerTick({
        enabledAgents,
        pendingTasks,
        dueCronJobs,
        activeDevices,
        deviceId,
        staleAfterMs,
        now,
        dependencyNodes: inboxState.dependencyNodes,
        duplicateIds: inboxState.duplicateIds,
        automation,
        // S1a: the resolved class agent scope narrows planner candidates after
        // the enabled-agents gate; it never widens the runnable set.
        agentScope: schedulerConfig.agentScope,
    });
    // Separately classify pending candidates for the human-readable report so
    // the dry-run can distinguish runnable from dependency-blocked work without
    // mutating anything. This reuses the same pure evaluator the planner uses.
    // Skipped when the inbox class is disabled: those tasks are class-gated,
    // not dependency/retry-blocked. The class agent scope is checked first
    // (S1a): an excluded agent's pending task is reported with the exact
    // bounded exclusion reason and never proposed as a claim.
    const blocked = automation.inboxTasks
        ? classifyBlockedTasks(inboxState.pendingTasks, inboxState.dependencyNodes, inboxState.duplicateIds, now, schedulerConfig.agentScope.inboxTasks)
        : [];
    // Discovery-complete: when inbox automation is disabled (ordinary disabled
    // or legacy-gated), every unclaimed pending inbox task is still listed
    // with a bounded [DISABLED] status; no claim is proposed.
    const disabledInboxTasks = automation.inboxTasks ? [] : inboxState.pendingTasks;
    // Format output
    const gates = { automation, legacyMasterGate, agentScope: schedulerConfig.agentScope, warnings: schedulerConfig.warnings };
    return formatSchedulerDryRun(deviceId, enabledAgents, claims, blocked, disabledInboxTasks, gates);
}
/** Map a loaded inbox task to the planner's task shape, carrying dependency fields. */
function toPlannerTask(task) {
    const plannerTask = {
        path: task.path,
        agentName: task.agentName,
        status: "pending",
    };
    plannerTask.id = task.id;
    plannerTask.dependsOn = task.dependsOn;
    if (task.dependsOnError !== undefined)
        plannerTask.dependsOnError = task.dependsOnError;
    if (task.frontmatter !== undefined)
        plannerTask.frontmatter = task.frontmatter;
    return plannerTask;
}
/** Evaluate every pending candidate and return the blocked ones with reasons. */
function classifyBlockedTasks(pendingTasks, dependencyNodes, duplicateIds, now, inboxScopeAgents) {
    const blocked = [];
    const inboxScopeSet = inboxScopeAgents !== undefined ? new Set(inboxScopeAgents) : undefined;
    for (const task of pendingTasks) {
        // Class agent scope (S1a): an excluded agent's pending task is reported
        // with the exact bounded reason and never proposed as a claim.
        if (inboxScopeSet !== undefined && !inboxScopeSet.has(task.agentName)) {
            blocked.push({
                agentName: task.agentName,
                path: task.path,
                reason: "class agent excluded (no claim proposed)",
            });
            continue;
        }
        const candidate = {
            id: task.id,
            status: task.status,
            dependsOn: task.dependsOn,
            path: task.path,
        };
        if (task.dependsOnError !== undefined)
            candidate.dependsOnError = task.dependsOnError;
        if (task.claimedBy !== undefined)
            candidate.claimedBy = task.claimedBy;
        const verdict = evaluateTaskDependencyEligibility(candidate, dependencyNodes, duplicateIds);
        if (!verdict.eligible) {
            blocked.push({
                agentName: task.agentName,
                path: task.path,
                reason: verdict.reason ?? "dependency-blocked",
            });
            continue;
        }
        // Retry eligibility (ADR-0038 R3): report the exact accepted R2 reason
        // for invalid policy/state, exhausted attempts, or unexpired backoff.
        if (task.frontmatter !== undefined) {
            const retry = evaluateRetryEligibility(task.frontmatter, now);
            if (!retry.eligible) {
                blocked.push({
                    agentName: task.agentName,
                    path: task.path,
                    reason: retry.reason ?? "retry-blocked",
                });
            }
        }
    }
    return blocked;
}
function formatSchedulerDryRun(deviceId, enabledAgents, claims, blocked, disabledInboxTasks, gates) {
    const lines = [];
    lines.push(`SCHEDULER DRY-RUN (device: ${deviceId})`);
    // 0.2 Settings contract §4.3: bounded resolved automation state, then one
    // [SKIPPED] line per disabled cron class and per-task [DISABLED] lines for
    // disabled inbox automation (discovery-complete), so the output explains
    // why nothing is proposed for it.
    const onOff = (value) => (value ? "on" : "off");
    lines.push(`automation: inbox_tasks=${onOff(gates.automation.inboxTasks)} ` +
        `agent_cron=${onOff(gates.automation.agentCron)} ` +
        `script_cron=${onOff(gates.automation.scriptCron)}`);
    const classLines = [
        ["inboxTasks", "inbox_tasks"],
        ["agentCron", "agent_cron"],
        ["scriptCron", "script_cron"],
    ];
    for (const [key, label] of classLines) {
        if (!gates.automation[key] && key !== "inboxTasks") {
            lines.push(`[SKIPPED] ${label} - automation disabled`);
        }
    }
    if (gates.legacyMasterGate === "gated") {
        lines.push("legacy gate: retired scheduler.enabled key present with a disabled/malformed value; all automation classes resolve disabled (fail closed); operator-confirmed migration required (read-only notice, not persisted)");
    }
    else if (gates.legacyMasterGate === "ignored") {
        lines.push("legacy: retired scheduler.enabled key present with value true; inert-to-ignore (read-only notice, not persisted)");
    }
    // S1a: bounded effective agent-scope policy line (counts only, never
    // configured values) and deterministic non-secret config warnings.
    const scopePart = (label, agents) => agents === undefined ? `${label}=all` : `${label}=${agents.length} agent(s)`;
    lines.push(`agent scope: ${scopePart("inbox_tasks", gates.agentScope.inboxTasks)} ` +
        `${scopePart("agent_cron", gates.agentScope.agentCron)} ` +
        `${scopePart("script_cron", gates.agentScope.scriptCron)}`);
    if (gates.warnings.length > 0) {
        lines.push("config warnings:");
        for (const warning of gates.warnings)
            lines.push(`  - ${warning}`);
    }
    // Group claims by agent
    const agentClaims = new Map();
    for (const claim of claims) {
        const list = agentClaims.get(claim.agentName) ?? [];
        list.push(claim);
        agentClaims.set(claim.agentName, list);
    }
    // Group dependency-blocked tasks by agent
    const agentBlocked = new Map();
    for (const item of blocked) {
        const list = agentBlocked.get(item.agentName) ?? [];
        list.push(item);
        agentBlocked.set(item.agentName, list);
    }
    // Group discovery-only disabled inbox tasks by agent
    const agentDisabled = new Map();
    for (const task of disabledInboxTasks) {
        const list = agentDisabled.get(task.agentName) ?? [];
        list.push(task);
        agentDisabled.set(task.agentName, list);
    }
    // Report claims, blocked tasks, and discovery-only disabled inbox tasks per
    // agent
    for (const agentName of enabledAgents) {
        const agentClaimList = agentClaims.get(agentName) ?? [];
        const agentBlockedList = (agentBlocked.get(agentName) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
        const agentDisabledList = (agentDisabled.get(agentName) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
        lines.push(`  agent: ${agentName}`);
        if (agentClaimList.length === 0 && agentBlockedList.length === 0 && agentDisabledList.length === 0) {
            lines.push(`    (no claims)`);
        }
        else {
            for (const claim of agentClaimList) {
                const tag = "[CLAIM]";
                lines.push(`    ${tag} ${claim.itemType.padEnd(12)} ${claim.itemPath} (priority ${claim.priority}) - ${claim.rationale}`);
            }
            for (const item of agentBlockedList) {
                lines.push(`    [BLOCK] ${"inbox_task".padEnd(12)} ${item.path} - ${item.reason}`);
            }
            for (const item of agentDisabledList) {
                lines.push(`    [DISABLED] ${"inbox_task".padEnd(12)} ${item.path} - inbox automation disabled (no claim proposed)`);
            }
        }
    }
    return lines.join("\n") + "\n";
}
//# sourceMappingURL=scheduler-cli.js.map