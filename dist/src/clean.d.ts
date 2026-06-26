export interface CleanPirenOptions {
    force: boolean;
    configDir: string;
    stateDir: string;
}
export interface CleanPirenReport {
    dryRun: boolean;
    wouldRemove: string[];
    removed: string[];
    errors: string[];
}
export declare function cleanPiren(options: CleanPirenOptions): Promise<CleanPirenReport>;
export declare function formatCleanReport(report: CleanPirenReport): string;
