import { selectOwningDevice } from "./cron.js";
// ---------------------------------------------------------------------------
// Pure scheduler planner
// ---------------------------------------------------------------------------
/**
 * Plan proposed claims for one scheduler tick. Pure function: takes
 * pre-loaded vault state and returns proposed claim attempts. No filesystem
 * access, no spawning, no side effects.
 *
 * The caller is responsible for loading the vault state (inbox tasks, cron
 * jobs, active devices) and executing or displaying the proposed claims.
 */
export function planSchedulerTick(options) {
    const { enabledAgents, pendingTasks, dueCronJobs, activeDevices, deviceId, staleAfterMs, now } = options;
    const claims = [];
    const enabledSet = new Set(enabledAgents);
    // Process inbox tasks
    for (const task of pendingTasks) {
        if (!enabledSet.has(task.agentName))
            continue;
        if (task.status === "pending") {
            // Unclaimed task: propose a claim
            const priority = devicePriorityForAgent(activeDevices, task.agentName, deviceId);
            claims.push({
                agentName: task.agentName,
                itemType: "inbox_task",
                itemPath: task.path,
                deviceId,
                priority,
                rationale: `unclaimed pending task for agent ${task.agentName}`,
            });
        }
        else if (task.status === "claimed" && task.claimedBy) {
            // Claimed task: propose reclaim only if claiming device is stale
            if (!isDeviceActive(activeDevices, task.agentName, task.claimedBy)) {
                const priority = devicePriorityForAgent(activeDevices, task.agentName, deviceId);
                claims.push({
                    agentName: task.agentName,
                    itemType: "inbox_task",
                    itemPath: task.path,
                    deviceId,
                    priority,
                    rationale: `stale claim by ${task.claimedBy} for agent ${task.agentName}`,
                });
            }
        }
    }
    // Process cron jobs
    for (const job of dueCronJobs) {
        if (!enabledSet.has(job.agentName))
            continue;
        const agentDevices = activeDevices.get(job.agentName) ?? [];
        const activeList = agentDevices.map((d) => ({
            deviceId: d.deviceId,
            priority: d.priority,
        }));
        const ownership = selectOwningDevice({
            devicePolicy: job.devicePolicy,
            activeDevices: activeList,
            deviceId,
        });
        if (ownership.owns) {
            const priority = devicePriorityForAgent(activeDevices, job.agentName, deviceId);
            claims.push({
                agentName: job.agentName,
                itemType: "cron_job",
                itemPath: job.path,
                deviceId,
                priority,
                rationale: `this device owns the job for agent ${job.agentName}`,
            });
        }
    }
    // Sort by priority (lower = higher precedence), then by agent name for stability
    claims.sort((a, b) => {
        if (a.priority !== b.priority)
            return a.priority - b.priority;
        return a.agentName.localeCompare(b.agentName);
    });
    return claims;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function devicePriorityForAgent(activeDevices, agentName, deviceId) {
    const devices = activeDevices.get(agentName) ?? [];
    const match = devices.find((d) => d.deviceId === deviceId);
    return match?.priority ?? 10;
}
function isDeviceActive(activeDevices, agentName, deviceId) {
    const devices = activeDevices.get(agentName) ?? [];
    return devices.some((d) => d.deviceId === deviceId);
}
//# sourceMappingURL=scheduler.js.map