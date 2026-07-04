export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";
export interface CreateInboxTaskOptions {
    vaultRoot: string;
    from: string;
    to: string;
    title: string;
    body: string;
    type?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    requiresApproval?: boolean;
    now?: () => Date;
}
export interface InboxTaskResult {
    taskId: string;
    path: string;
    absolutePath: string;
    from: string;
    to: string;
    status: TaskStatus;
    bytes: number;
    created: string;
}
export interface UpdateInboxTaskStatusOptions {
    vaultRoot: string;
    taskPath: string;
    status: TaskStatus;
    result?: string;
    now?: () => Date;
}
export interface UpdateInboxTaskStatusResult {
    path: string;
    absolutePath: string;
    status: TaskStatus;
    bytes: number;
    updated: string;
}
export interface ListInboxTasksOptions {
    vaultRoot: string;
    agentName: string;
}
export interface InboxTaskSummary {
    id: string;
    path: string;
    title: string;
    from: string;
    to: string;
    status: TaskStatus;
    created: string;
    updated: string;
}
export interface ListInboxTasksResult {
    agentName: string;
    path: string;
    absolutePath: string;
    tasks: InboxTaskSummary[];
}
export interface ClaimInboxTaskOptions {
    vaultRoot: string;
    agentName: string;
    taskPath: string;
    deviceId: string;
    staleAfterMs?: number;
    now?: () => Date;
}
export interface ClaimInboxTaskResult {
    agentName: string;
    deviceId: string;
    originalPath: string;
    path: string;
    absolutePath: string;
}
export declare function createInboxTask(options: CreateInboxTaskOptions): Promise<InboxTaskResult>;
export declare function listInboxTasks(options: ListInboxTasksOptions): Promise<ListInboxTasksResult>;
export declare function claimInboxTask(options: ClaimInboxTaskOptions): Promise<ClaimInboxTaskResult>;
export declare function updateInboxTaskStatus(options: UpdateInboxTaskStatusOptions): Promise<UpdateInboxTaskStatusResult>;
