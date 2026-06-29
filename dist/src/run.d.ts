import { type BootstrapOptions } from "./bootstrap.js";
import { type PackageEntryResolver } from "./packages.js";
export interface BuildPiRunCommandOptions extends BootstrapOptions {
    extraArgs?: string[] | undefined;
    extensionPath?: string | undefined;
    workerMode?: boolean | undefined;
    rpcMode?: boolean | undefined;
    packageResolver?: PackageEntryResolver | undefined;
    piCommandResolver?: PiCommandResolver | undefined;
}
export interface PiCommandTarget {
    command: string;
    argsPrefix: string[];
    source: "path";
}
export type PiCommandResolver = (env?: NodeJS.ProcessEnv | Record<string, string | undefined>) => Promise<PiCommandTarget>;
export interface PiRunCommand {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit" | "pipe";
}
export declare function formatPiModel(model: unknown): string | undefined;
export declare function defaultPiCommandResolver(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): Promise<PiCommandTarget>;
export declare function buildPiRunCommand(options?: BuildPiRunCommandOptions): Promise<PiRunCommand>;
export declare function spawnPiRun(options?: BuildPiRunCommandOptions): Promise<number>;
