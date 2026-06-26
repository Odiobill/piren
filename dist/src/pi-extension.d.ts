import { type BootstrapOptions } from "./bootstrap.js";
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
}
export default function pirenExtension(pi: ExtensionAPI, testOptions?: BootstrapOptions): Promise<void>;
export {};
