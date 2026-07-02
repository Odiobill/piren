import { type OkfTreeProblem, type VaultDirReader } from "./okf.js";
export type OkfGraphNodeType = string;
export interface OkfGraphNode {
    id: string;
    path: string;
    type: OkfGraphNodeType;
    title: string;
    description?: string;
}
export type OkfGraphEdgeKind = "wikilink" | "bundle" | "relative" | "external";
export interface OkfGraphEdge {
    source: string;
    target: string;
    href: string;
    kind: OkfGraphEdgeKind;
    external: boolean;
}
export interface BuildOkfGraphOptions {
    root: string;
    reader: VaultDirReader;
    exclude?: string[];
    maxFiles?: number;
}
export interface OkfGraph {
    nodes: OkfGraphNode[];
    edges: OkfGraphEdge[];
    problems: OkfTreeProblem[];
    truncated: boolean;
}
export declare function buildOkfGraph(options: BuildOkfGraphOptions): Promise<OkfGraph>;
