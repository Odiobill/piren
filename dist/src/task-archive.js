const AGENT = /^[a-z][a-z0-9-]*$/;
const DIRECT_TASK = /^team\/([a-z][a-z0-9-]*)\/inbox\/([^/]+\.md)$/;
const TERMINAL = new Set(["completed", "cancelled"]);
function destination(path, archiveAt) {
    const date = archiveAt.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (date === null || Number.isNaN(Date.parse(archiveAt)))
        throw new Error("Archive operation time must be a canonical ISO instant.");
    const match = path.match(DIRECT_TASK);
    if (match === null)
        throw new Error("Task archive source must be a direct inbox Markdown file.");
    return `team/${match[1]}/inbox/archive/${date[1]}/${date[2]}/${date[3]}/${match[2]}`;
}
/** Pure, bounded selection for one agent's explicitly requested terminal cleanup. */
export function planTerminalTaskArchive(options) {
    if (!AGENT.test(options.agentName))
        throw new Error("Invalid archive agent name.");
    // Validate the time even if the selected inbox has no terminal tasks.
    destination(`team/${options.agentName}/inbox/.archive-time-check.md`, options.archiveAt);
    const liveDependents = new Map();
    for (const task of options.tasks) {
        if (!TERMINAL.has(task.status)) {
            for (const dependency of task.dependsOn)
                liveDependents.set(dependency, task.id);
        }
    }
    const eligible = [];
    const skipped = [];
    for (const task of [...options.tasks].sort((left, right) => left.path.localeCompare(right.path))) {
        if (task.agentName !== options.agentName || !TERMINAL.has(task.status))
            continue;
        const sourcePath = task.path;
        const dependent = liveDependents.get(task.id);
        if (dependent !== undefined) {
            skipped.push({ sourcePath, reason: `required by live task: ${dependent}` });
            continue;
        }
        eligible.push({ sourcePath, destinationPath: destination(sourcePath, options.archiveAt) });
    }
    return { eligible, skipped };
}
//# sourceMappingURL=task-archive.js.map