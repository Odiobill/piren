import { evaluateTaskDependencyEligibility, loadSchedulerInboxState } from "./scheduler-dependencies.js";
import { parseRetryPolicy, parseRetryState } from "./scheduler-retry.js";
import { readYamlConfig, resolveEnabledAgents, DEFAULT_CONFIG_PATH } from "./scheduler-cli.js";
/**
 * Deterministic, non-action authority boundaries per category (ADR-0039 E2-S1).
 * Each states what Piren cannot infer or will not change; none instructs a
 * mutation and none is an action.
 */
const AUTHORITY_TRIAGE = "Piren cannot tell from vault state whether the claim is active, interrupted, or an ambiguous failure (no ambiguity classification is persisted).";
const AUTHORITY_RETRY_INVALID = "Piren will not infer invalid retry policy or retry_state; task remains unclaimable while metadata is invalid.";
const AUTHORITY_RETRY_EXHAUSTED = "Piren will not automatically requeue exhausted attempts.";
const AUTHORITY_CYCLE = "Piren leaves affected tasks fail-closed rather than infer a dependency repair.";
/** The sole next-step action for every finding: one read-only view of the task file. */
function nextStepFor(path) {
    return `piren task show ${path}`;
}
const CATEGORY_ORDER = {
    cycle: 0,
    retry: 1,
    triage: 2,
};
/**
 * Retry-metadata finding for one task, reusing the existing R2 parsers and
 * the existing exact exhaustion wording (ADR-0038). Invalid policy, malformed
 * state, and exhausted attempts are reported; unexpired backoff is not (it
 * stays a --dry-run diagnostic). Returns undefined when nothing is reportable.
 */
function classifyRetryMetadata(task) {
    if (task.frontmatter === undefined)
        return undefined;
    const policyParse = parseRetryPolicy(task.frontmatter);
    if (policyParse.error !== undefined)
        return policyParse.error;
    const stateParse = parseRetryState(task.frontmatter);
    if (stateParse.error !== undefined)
        return stateParse.error;
    const policy = policyParse.policy;
    const state = stateParse.state;
    if (policy !== undefined && state !== undefined && state.attempts >= policy.maxAttempts) {
        return `retry attempts exhausted (${state.attempts}/${policy.maxAttempts})`;
    }
    return undefined;
}
/**
 * Classify report findings from loaded inbox state. Pure and deterministic:
 * findings are sorted by agent name, then category, then path, and identical
 * findings are deduplicated.
 */
export function classifySchedulerReportFindings(input) {
    const findings = [];
    // Dependency cycles involving pending candidates. Other dependency blocks
    // (missing/unsatisfied/malformed) stay --dry-run diagnostics (task scope).
    for (const task of input.pendingTasks) {
        const verdict = evaluateTaskDependencyEligibility(task, input.dependencyNodes, input.duplicateIds);
        if (!verdict.eligible && verdict.reason !== undefined && verdict.reason.startsWith("dependency cycle:")) {
            findings.push({
                category: "cycle",
                agentName: task.agentName,
                path: task.path,
                reason: verdict.reason,
                authority: AUTHORITY_CYCLE,
                nextStep: nextStepFor(task.path),
            });
        }
    }
    for (const task of input.allTasks) {
        const retryReason = classifyRetryMetadata(task);
        if (retryReason !== undefined) {
            const authority = retryReason.startsWith("retry attempts exhausted") ? AUTHORITY_RETRY_EXHAUSTED : AUTHORITY_RETRY_INVALID;
            findings.push({
                category: "retry",
                agentName: task.agentName,
                path: task.path,
                reason: retryReason,
                authority,
                nextStep: nextStepFor(task.path),
            });
        }
        if (task.claimedBy !== undefined) {
            findings.push({
                category: "triage",
                agentName: task.agentName,
                path: task.path,
                reason: `claimed by ${task.claimedBy}; requires manual triage: may be active, interrupted, or ambiguous` +
                    " — vault state alone cannot tell",
                authority: AUTHORITY_TRIAGE,
                nextStep: nextStepFor(task.path),
            });
        }
    }
    findings.sort((a, b) => a.agentName.localeCompare(b.agentName) ||
        CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
        a.path.localeCompare(b.path));
    const seen = new Set();
    return findings.filter((f) => {
        const key = `${f.agentName}${f.category}${f.path}${f.reason}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
const CATEGORY_TAG = {
    cycle: "[CYCLE]",
    retry: "[RETRY]",
    triage: "[TRIAGE]",
};
/** Indent aligning authority/next continuation lines under the finding path. */
const CONTINUATION_INDENT = " ".repeat(4 /*indent*/ + 8 /*tag field*/ + 1 /*space*/);
/**
 * Format the operator report. Pure and deterministic: agents appear in
 * enabled-agent order, findings are pre-sorted by the classifier, and a
 * summary line counts findings by category. The footer states the read-only
 * guarantee and the ambiguity limitation (ADR-0038 R3): a claimed task
 * requires manual triage and may be active, interrupted, or ambiguous — the
 * report cannot identify which from vault state alone.
 */
export function formatSchedulerReport(enabledAgents, findings) {
    const lines = [];
    lines.push("SCHEDULER REPORT");
    lines.push("");
    const byAgent = new Map();
    for (const finding of findings) {
        const list = byAgent.get(finding.agentName) ?? [];
        list.push(finding);
        byAgent.set(finding.agentName, list);
    }
    for (const agentName of enabledAgents) {
        lines.push(`  agent: ${agentName}`);
        const agentFindings = byAgent.get(agentName) ?? [];
        if (agentFindings.length === 0) {
            lines.push("    (no findings)");
        }
        else {
            for (const finding of agentFindings) {
                lines.push(`    ${CATEGORY_TAG[finding.category].padEnd(8)} ${finding.path} - ${finding.reason}`);
                // ADR-0039 E2-S1: non-action authority boundary, then exactly one
                // inspection action, as aligned continuation lines.
                lines.push(`${CONTINUATION_INDENT}authority: ${finding.authority}`);
                lines.push(`${CONTINUATION_INDENT}next: ${finding.nextStep}`);
            }
        }
    }
    const cycles = findings.filter((f) => f.category === "cycle").length;
    const retries = findings.filter((f) => f.category === "retry").length;
    const triages = findings.filter((f) => f.category === "triage").length;
    lines.push("");
    lines.push(`${findings.length} findings (${cycles} cycle, ${retries} retry, ${triages} manual-triage)`);
    lines.push("");
    lines.push("This report is read-only: it does not claim, spawn, write, or call any LLM.");
    lines.push("A claimed task requires manual triage: it may be active, interrupted, or ambiguous;" +
        " vault state alone cannot tell (no ambiguity classification is persisted).");
    return lines.join("\n") + "\n";
}
/**
 * Build the read-only scheduler operator report for the locally enabled
 * agent set. Reads only the vault and local config: no claims, no spawns,
 * no heartbeat refreshes, no writes, no Pi/LLM calls.
 */
export async function schedulerReport(options) {
    const now = options.now ?? new Date();
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const config = await readYamlConfig(configPath);
    const vaultRoot = config.vault_root;
    if (!vaultRoot) {
        return "SCHEDULER REPORT\n\nNo vault root configured. Set vault_root in ~/.config/piren/config.yml.\n";
    }
    const enabledAgents = resolveEnabledAgents(config);
    if (enabledAgents.length === 0) {
        return "SCHEDULER REPORT\n\nNo enabled agents. Configure allowed_agents in local config.\n";
    }
    const inboxState = await loadSchedulerInboxState({ vaultRoot, enabledAgents });
    const findings = classifySchedulerReportFindings({
        pendingTasks: inboxState.pendingTasks,
        allTasks: inboxState.allTasks,
        dependencyNodes: inboxState.dependencyNodes,
        duplicateIds: inboxState.duplicateIds,
        now,
    });
    return formatSchedulerReport(enabledAgents, findings);
}
//# sourceMappingURL=scheduler-report.js.map