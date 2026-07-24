import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseClaimedInboxTaskPath } from "./scheduler-executor.js";
import { atomicCreateNoClobber, createNodeRetryTransitionIo, } from "./scheduler-retry.js";
function parseTaskFrontmatterFields(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match)
        return undefined;
    let parsed;
    try {
        parsed = parseYaml(match[1] ?? "");
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return undefined;
    return parsed;
}
/**
 * Decide whether a claimed task's content may be released. Pure and
 * deterministic. Eligible ONLY when the frontmatter parses and the `status`
 * field is exactly `completed`; every malformed, missing, or non-completed
 * state fails closed with an exact reason. The result body is never
 * machine-validated (ADR-0038 revision 2).
 */
export function evaluateReleaseEligibility(options) {
    const fields = parseTaskFrontmatterFields(options.content);
    if (fields === undefined) {
        return {
            eligible: false,
            reason: "cannot parse task frontmatter; task remains claimed for triage",
        };
    }
    const status = fields["status"];
    if (typeof status !== "string" || status === "") {
        return {
            eligible: false,
            reason: "task frontmatter is missing a valid status field; task remains claimed for triage",
        };
    }
    if (status !== "completed") {
        return {
            eligible: false,
            reason: `task status is '${status}', not completed; task remains claimed for triage`,
        };
    }
    return { eligible: true };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Release a successfully scheduler-completed claimed inbox task back to its
 * ordinary filename, byte-for-byte, through the R2 two-step no-clobber
 * protocol. Throws only on an invalid claimed path (programming error);
 * every expected validation or I/O failure returns `held` with an exact
 * reason and preserves the claimed file for triage.
 */
export async function releaseCompletedClaimedTask(options) {
    const info = parseClaimedInboxTaskPath({
        vaultRoot: options.vaultRoot,
        agentName: options.agentName,
        claimedTaskPath: options.claimedTaskPath,
    });
    // Gate 1: device ownership. A release never touches another device's claim.
    if (info.deviceId !== options.expectedDeviceId) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `claimed by device '${info.deviceId}', not this scheduler device '${options.expectedDeviceId}'; ` +
                "refusing to release another device's claim",
        };
    }
    const root = resolve(options.vaultRoot);
    const claimedAbsolutePath = resolve(root, info.claimedTaskPath);
    const io = options.io ?? createNodeRetryTransitionIo();
    let content;
    try {
        content = await io.readFile(claimedAbsolutePath);
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            // A concurrent transition already handled this claimed file.
            return {
                action: "held",
                claimedTaskPath: info.claimedTaskPath,
                reason: "claimed task file not found; another transition may already have handled it",
            };
        }
        // Any other read failure (EACCES, EIO, ...) is reported with the actual
        // error; it is never misreported as a concurrent transition.
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `claimed task read failed (${errorMessage(error)}); task remains claimed for triage`,
        };
    }
    // Gate 2: validated completion from the task frontmatter.
    const eligibility = evaluateReleaseEligibility({ content });
    if (!eligibility.eligible) {
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: eligibility.reason ?? "task is not release-eligible; task remains claimed for triage",
        };
    }
    // Release: restore the ordinary filename byte-for-byte through the
    // fail-closed no-clobber two-step protocol, then unlink the claimed file.
    const restoredPath = join("team", info.agentName, "inbox", info.fileName);
    const restoredAbsolutePath = resolve(root, restoredPath);
    try {
        await atomicCreateNoClobber(io, restoredAbsolutePath, content);
    }
    catch (error) {
        const code = error.code;
        const reason = code === "EEXIST"
            ? `release target already exists (${restoredPath}); concurrent claim or duplicate, task remains claimed for triage`
            : `release restore failed (${errorMessage(error)}); task remains claimed for triage`;
        return { action: "held", claimedTaskPath: info.claimedTaskPath, reason };
    }
    try {
        await io.remove(claimedAbsolutePath);
    }
    catch (error) {
        // The ordinary file was already restored and may already be observed or
        // claimed — never delete it. Retain BOTH files: a duplicate visible task
        // id is intentional fail-closed state that R1 duplicate handling blocks
        // for both candidates and dependency targets until triage.
        return {
            action: "held",
            claimedTaskPath: info.claimedTaskPath,
            reason: `claimed unlink failed after release restore (${errorMessage(error)}); ` +
                `duplicate visible task id at ${restoredPath} and ${info.claimedTaskPath}; ` +
                "both files retained for fail-closed R1/R3 triage",
        };
    }
    return {
        action: "released",
        claimedTaskPath: info.claimedTaskPath,
        restoredPath,
        restoredAbsolutePath,
    };
}
//# sourceMappingURL=scheduler-release.js.map