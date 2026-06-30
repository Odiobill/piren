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
export declare const DEFAULT_UPDATE_SPEC = "github:Odiobill/piren";
export declare function buildUpdateCommand(spec?: string): UpdateCommand;
export declare function executePirenUpdate(deps: ExecuteUpdateDeps): Promise<UpdateReport>;
export declare function formatUpdateReport(report: UpdateReport): string;
