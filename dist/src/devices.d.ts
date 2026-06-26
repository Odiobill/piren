export interface RegisterDeviceOptions {
    vaultRoot: string;
    agentName: string;
    deviceId: string;
    hostname: string;
    priority?: number;
    status?: "active" | "idle" | "offline";
    now?: () => Date;
}
export interface RegisterDeviceResult {
    agentName: string;
    deviceId: string;
    hostname: string;
    path: string;
    absolutePath: string;
    priority: number;
    status: "active" | "idle" | "offline";
    startedAt: string;
    lastSeen: string;
    bytes: number;
}
export declare function registerDevice(options: RegisterDeviceOptions): Promise<RegisterDeviceResult>;
