export const DEFAULT_UPDATE_SPEC = "github:Odiobill/piren";
export function buildUpdateCommand(spec = DEFAULT_UPDATE_SPEC) {
    return {
        command: "npm",
        args: ["install", "-g", "--install-links", spec],
    };
}
export async function executePirenUpdate(deps) {
    const update = buildUpdateCommand();
    const result = await deps.runCommand(update.command, update.args);
    return {
        ...update,
        ...result,
        ok: result.exitCode === 0,
    };
}
export function formatUpdateReport(report) {
    const lines = [
        `Piren update: ${report.ok ? "ok" : "failed"}`,
        `command: ${[report.command, ...report.args].join(" ")}`,
        `exit_code: ${report.exitCode}`,
    ];
    const stdout = report.stdout.trim();
    const stderr = report.stderr.trim();
    if (stdout) {
        lines.push("", "stdout:", stdout);
    }
    if (stderr) {
        lines.push("", "stderr:", stderr);
    }
    return lines.join("\n");
}
//# sourceMappingURL=update.js.map