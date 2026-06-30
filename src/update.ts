export interface UpdateCommand {
  command: string;
  args: string[];
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UpdateReport extends UpdateCommand, CommandResult {
  ok: boolean;
}

export interface ExecuteUpdateDeps {
  runCommand: (command: string, args: string[]) => Promise<CommandResult>;
}

export const DEFAULT_UPDATE_SPEC = "github:Odiobill/piren";

export function buildUpdateCommand(spec = DEFAULT_UPDATE_SPEC): UpdateCommand {
  return {
    command: "npm",
    args: ["install", "-g", "--install-links", spec],
  };
}

export async function executePirenUpdate(deps: ExecuteUpdateDeps): Promise<UpdateReport> {
  const update = buildUpdateCommand();
  const result = await deps.runCommand(update.command, update.args);
  return {
    ...update,
    ...result,
    ok: result.exitCode === 0,
  };
}

export function formatUpdateReport(report: UpdateReport): string {
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
