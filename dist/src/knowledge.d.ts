export interface ProjectStatusOptions {
    vaultRoot: string;
    project: string;
}
export interface ProjectStatusResult {
    project: string;
    path: string;
    available: boolean;
    title: string;
    status: string;
    updated: string;
}
export declare function projectStatus(options: ProjectStatusOptions): Promise<ProjectStatusResult>;
export interface ProjectAppendLogOptions {
    vaultRoot: string;
    project: string;
    entry: string;
    agentName?: string;
    now?: () => Date;
}
export interface ProjectAppendLogResult {
    path: string;
    absolutePath: string;
    bytes: number;
    bytesAppended: number;
    timestamp: string;
    atomic: true;
}
export interface DecisionRecordOptions {
    vaultRoot: string;
    project: string;
    id: string;
    title: string;
    context: string;
    decision: string;
    consequences?: string;
    alternatives?: string;
    now?: () => Date;
}
export interface DecisionRecordResult {
    path: string;
    absolutePath: string;
    bytes: number;
    atomic: true;
    created: string;
}
export declare function projectAppendLog(options: ProjectAppendLogOptions): Promise<ProjectAppendLogResult>;
export declare function decisionRecord(options: DecisionRecordOptions): Promise<DecisionRecordResult>;
export interface ProjectUpdateHandoffOptions {
    vaultRoot: string;
    project: string;
    content: string;
    now?: () => Date;
}
export interface ArtifactWriteResult {
    path: string;
    absolutePath: string;
    bytes: number;
    atomic: true;
    created: string;
}
export interface ProjectUpdateHandoffResult {
    path: string;
    absolutePath: string;
    bytes: number;
    atomic: true;
}
export interface RunbookWriteOptions {
    vaultRoot: string;
    project: string;
    title: string;
    content: string;
    now?: () => Date;
}
export interface SkillCandidateWriteOptions {
    vaultRoot: string;
    name: string;
    description: string;
    body: string;
    scope?: string;
    now?: () => Date;
}
export declare function projectUpdateHandoff(options: ProjectUpdateHandoffOptions): Promise<ProjectUpdateHandoffResult>;
export declare function runbookWrite(options: RunbookWriteOptions): Promise<ArtifactWriteResult>;
export declare function skillCandidateWrite(options: SkillCandidateWriteOptions): Promise<ArtifactWriteResult>;
