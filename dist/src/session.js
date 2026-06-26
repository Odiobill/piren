import { basename } from "node:path";
import { createVaultTools } from "./vault-tools.js";
function compactTimestamp(date) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function slugify(input) {
    const slug = input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "session-summary";
}
function normalizeTitle(title) {
    const trimmed = title?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : "Session Summary";
}
export async function writeSessionSummary(options) {
    const summary = options.summary.trim();
    if (!summary) {
        throw new Error("Session summary is required");
    }
    const now = options.now ?? (() => new Date());
    const timestamp = now().toISOString();
    const title = normalizeTitle(options.title);
    const filename = `${compactTimestamp(new Date(timestamp))}-${slugify(title)}.md`;
    const agentName = options.agentName || basename(options.agentDir);
    const path = `team/${agentName}/sessions/${filename}`;
    const content = [
        "---",
        "type: session-summary",
        `agent: ${agentName}`,
        `created: ${timestamp}`,
        "---",
        "",
        `# ${title}`,
        "",
        summary,
        "",
    ].join("\n");
    const tools = createVaultTools({ vaultRoot: options.vaultRoot });
    const result = await tools.vaultWrite(path, content);
    if (!("path" in result)) {
        throw new Error(`Session summary was queued instead of written authoritatively: ${result.reason}`);
    }
    return {
        path: result.path,
        absolutePath: result.absolutePath,
        bytes: result.bytes,
        timestamp,
        title,
        atomic: true,
    };
}
//# sourceMappingURL=session.js.map