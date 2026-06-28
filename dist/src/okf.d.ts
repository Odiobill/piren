/**
 * OKF (Open Knowledge Format) v0.1 conformance for the Piren vault.
 *
 * Implemented against ADR-0022 and the OKF v0.1 spec (section 9). The only hard
 * conformance delta between Piren's existing conventions and OKF is a required,
 * non-empty `type` frontmatter field on every non-reserved Markdown concept
 * document. Reserved filenames (`index.md`, `log.md`) follow their own structure
 * and are not checked as concept documents.
 *
 * This module is a pure core: it takes strings and already-read file contents.
 * The vault tree walk (`checkVaultConformance`) takes an injected directory
 * reader so it is unit-testable without a real filesystem, mirroring the
 * testable-without-Pi principle applied elsewhere in Piren.
 */
/**
 * The documented Piren type taxonomy. Consumers MUST tolerate unknown types
 * (OKF section 4.1); this list is descriptive, never enforced as an allowlist.
 */
export declare const PIREN_OKF_TYPES: readonly string[];
/** OKF reserved filenames (SPEC section 3.1) with their own structure. */
export declare function isOkfReservedFilename(name: string): boolean;
/**
 * Piren-specific filenames that are intentionally EXCLUDED from OKF concept
 * conformance. These are identity/runtime files, not knowledge concepts:
 * `SOUL.md` (agent identity), `MEMORY.md` (transient memory), `AGENTS.md`
 * (project instructions), and `steward-directives.md` (steering). They are part
 * of the vault protocol (ADR-0008), not the knowledge substrate.
 */
export declare function isOkfSystemFilename(name: string): boolean;
/** Check whether a filename is a Markdown concept document subject to OKF rules. */
export declare function isOkfConceptFilename(name: string): boolean;
/** The result of splitting a Markdown file into frontmatter and body. */
export interface ParsedOkfDocument {
    hasFrontmatter: boolean;
    terminated: boolean;
    fields: Record<string, unknown>;
    body: string;
    parseError?: string;
}
/**
 * Split a Markdown source into a YAML frontmatter block and a body.
 *
 * The frontmatter block is delimited by `---` on its own line at the start of
 * the file and a closing `---`. An opening `---` with no closing delimiter is
 * "unterminated" and flagged separately from a missing block.
 */
export declare function parseOkfFrontmatter(src: string): ParsedOkfDocument;
/** The kind of conformance problem found in a single document. */
export type OkfProblemKind = "missing-frontmatter" | "unterminated-frontmatter" | "malformed-frontmatter" | "missing-type" | "unreadable";
/** A single conformance problem on a single document. */
export interface OkfProblem {
    path: string;
    kind: OkfProblemKind;
    detail?: string;
}
/** The result of checking one concept document. */
export interface OkfDocumentCheckResult {
    path: string;
    type: string | null;
    ok: boolean;
    problems: OkfProblem[];
}
/**
 * Check a single non-reserved Markdown document for OKF v0.1 conformance.
 *
 * Conformance rules (OKF section 9) applied here:
 * 1. The document has a parseable YAML frontmatter block.
 * 2. The frontmatter has a non-empty `type` field (string, non-empty after trim).
 *
 * Unknown `type` values are tolerated (OKF section 4.1). Optional fields
 * (title, description, tags, etc.) are never required.
 */
export declare function checkOkfConceptDocument(path: string, src: string): OkfDocumentCheckResult;
/**
 * A transient claimed file: `foo.claimed.<device>.md`, the atomic-claim rename
 * used by inbox and cron coordination. These are operational scratch state, not
 * knowledge concepts, so the walk skips them.
 */
export declare function isClaimedFilename(name: string): boolean;
/**
 * Injected filesystem reader for the vault tree walk. Taking this as a parameter
 * keeps `checkVaultConformance` unit-testable without a real filesystem, the
 * same testability-without-Pi principle used by the doctor and cron cores.
 *
 * `list(dir)` returns the immediate children of a directory (name + whether it
 * is a directory). `readFile(path)` returns UTF-8 content or throws on error.
 */
export interface VaultDirReader {
    list(dir: string): Promise<{
        name: string;
        isDirectory: boolean;
    }[]>;
    readFile(path: string): Promise<string>;
}
export interface CheckVaultConformanceOptions {
    root: string;
    reader: VaultDirReader;
    /** Directory names to skip entirely (case-sensitive match on the segment). */
    exclude?: string[];
    /** Maximum concept files to check; walks over this are marked truncated. Defaults to 10000. */
    maxFiles?: number;
}
export interface OkfTreeProblem extends OkfProblem {
    detail?: string;
}
export interface VaultConformanceResult {
    root: string;
    ok: boolean;
    checked: number;
    truncated: boolean;
    problems: OkfTreeProblem[];
}
/**
 * A real-filesystem `VaultDirReader`. Shared by `piren doctor` and the
 * `vault_conformance_check` extension tool so both walks behave identically.
 */
export declare function createRealVaultDirReader(): VaultDirReader;
/**
 * Walk the vault tree and check every OKF concept document for conformance.
 *
 * Skipped during the walk:
 * - dotfiles/dot-directories (`.git`, `.piren-vault`, ...)
 * - reserved filenames (`index.md`, `log.md`)
 * - Piren system filenames (`SOUL.md`, `MEMORY.md`, `AGENTS.md`, `steward-directives.md`)
 * - claimed coordination files (`*.claimed.<device>.md`)
 * - non-`.md` files
 * - directories in `exclude` plus the always-excluded set
 *
 * An unreadable file becomes a single `unreadable` problem rather than aborting
 * the whole walk, so a partial vault still yields a useful report.
 */
export declare function checkVaultConformance(options: CheckVaultConformanceOptions): Promise<VaultConformanceResult>;
/**
 * Render a `VaultConformanceResult` as a single human-readable string. Used by
 * `piren doctor` and the `vault_conformance_check` tool so the two surfaces
 * agree on output wording.
 */
export declare function formatVaultConformanceReport(result: VaultConformanceResult): string;
