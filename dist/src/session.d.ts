export interface WriteSessionSummaryOptions {
    vaultRoot: string;
    agentName: string;
    agentDir: string;
    summary: string;
    title?: string | undefined;
    now?: (() => Date) | undefined;
}
export interface WriteSessionSummaryResult {
    path: string;
    absolutePath: string;
    bytes: number;
    timestamp: string;
    title: string;
    atomic: true;
}
export declare function writeSessionSummary(options: WriteSessionSummaryOptions): Promise<WriteSessionSummaryResult>;
