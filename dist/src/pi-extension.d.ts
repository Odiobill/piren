import { type BootstrapOptions } from "./bootstrap.js";
import { type AlertMirrorSenders } from "./alert-mirror.js";
interface ExtensionAPI {
    registerFlag?: (name: string, options: {
        description?: string;
        type?: string;
    }) => void;
    getFlag?: (name: string) => unknown;
    registerTool: (tool: {
        name: string;
        label?: string;
        description?: string;
        parameters?: unknown;
        execute: (toolCallId: string, params: any) => Promise<unknown> | unknown;
    }) => void;
    registerCommand: (name: string, command: {
        description?: string;
        handler?: (args: any, ctx: {
            ui: {
                notify: (message: string, level?: string) => void;
            };
        }) => Promise<unknown> | unknown;
        execute?: () => Promise<string> | string;
    }) => void;
    on: (event: string, handler: (...args: any[]) => Promise<unknown> | unknown) => void;
    exec?: (command: string, args: string[], options?: {
        signal?: AbortSignal;
        timeout?: number;
    }) => Promise<{
        code: number;
        stdout?: string;
        stderr?: string;
    }>;
}
export interface PirenExtensionTestOptions extends BootstrapOptions {
    /**
     * Narrow test-only seam (ADR-0039 E1 M3): inject fake alert-mirror senders
     * so extension and smoke tests never touch the network. Production leaves
     * this undefined and the real HTTP adapters are constructed instead.
     */
    alertMirrorSenders?: AlertMirrorSenders;
}
export default function pirenExtension(pi: ExtensionAPI, testOptions?: PirenExtensionTestOptions): Promise<void>;
export {};
