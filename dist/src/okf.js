import { readFile, readdir } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
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
export const PIREN_OKF_TYPES = [
    "Concept",
    "Entity",
    "Runbook",
    "ADR",
    "Skill",
    "Project Index",
    "Project Log",
    "Session Summary",
    "Task",
    "Cron Job",
    "Cron Run",
];
/** OKF reserved filenames (SPEC section 3.1) with their own structure. */
export function isOkfReservedFilename(name) {
    return name === "index.md" || name === "log.md";
}
/**
 * Piren-specific filenames that are intentionally EXCLUDED from OKF concept
 * conformance. These are identity/runtime files, not knowledge concepts:
 * `SOUL.md` (agent identity), `MEMORY.md` (transient memory), `AGENTS.md`
 * (project instructions), and `steward-directives.md` (steering). They are part
 * of the vault protocol (ADR-0008), not the knowledge substrate.
 */
export function isOkfSystemFilename(name) {
    return (name === "SOUL.md" ||
        name === "MEMORY.md" ||
        name === "AGENTS.md" ||
        name === "steward-directives.md" ||
        name === "README.md");
}
/** Check whether a filename is a Markdown concept document subject to OKF rules. */
export function isOkfConceptFilename(name) {
    if (!name.endsWith(".md"))
        return false;
    if (isOkfReservedFilename(name))
        return false;
    if (isOkfSystemFilename(name))
        return false;
    return true;
}
/**
 * Split a Markdown source into a YAML frontmatter block and a body.
 *
 * The frontmatter block is delimited by `---` on its own line at the start of
 * the file and a closing `---`. An opening `---` with no closing delimiter is
 * "unterminated" and flagged separately from a missing block.
 */
export function parseOkfFrontmatter(src) {
    const match = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?([\s\S]*)$/);
    if (match) {
        const rawFields = match[1] ?? "";
        const body = match[2] ?? "";
        try {
            const parsed = parseYaml(rawFields);
            const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed
                : {};
            return { hasFrontmatter: true, terminated: true, fields, body };
        }
        catch (error) {
            const parseError = error instanceof Error ? error.message : String(error);
            return { hasFrontmatter: true, terminated: true, fields: {}, body, parseError };
        }
    }
    // Opening fence present but never closed.
    if (/^---[ \t]*\r?\n/.test(src)) {
        return { hasFrontmatter: true, terminated: false, fields: {}, body: src };
    }
    return { hasFrontmatter: false, terminated: true, fields: {}, body: src };
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
export function checkOkfConceptDocument(path, src) {
    const parsed = parseOkfFrontmatter(src);
    const problems = [];
    if (parsed.parseError !== undefined) {
        problems.push({ path, kind: "malformed-frontmatter", detail: parsed.parseError });
    }
    else if (!parsed.hasFrontmatter) {
        problems.push({ path, kind: "missing-frontmatter" });
    }
    else if (!parsed.terminated) {
        problems.push({ path, kind: "unterminated-frontmatter" });
    }
    else {
        const typeValue = parsed.fields["type"];
        const typeString = typeof typeValue === "string" ? typeValue.trim() : "";
        if (typeString === "") {
            problems.push({ path, kind: "missing-type" });
        }
    }
    const typeValue = parsed.fields["type"];
    const type = typeof typeValue === "string" && typeValue.trim() !== "" ? typeValue.trim() : null;
    return {
        path,
        type,
        ok: problems.length === 0,
        problems,
    };
}
/**
 * A transient claimed file: `foo.claimed.<device>.md`, the atomic-claim rename
 * used by inbox and cron coordination. These are operational scratch state, not
 * knowledge concepts, so the walk skips them.
 */
export function isClaimedFilename(name) {
    return /\.claimed\.[a-z][a-z0-9-]*\.md$/i.test(name);
}
const DEFAULT_MAX_FILES = 10000;
/** Directories that never hold OKF concepts and are always skipped. */
const ALWAYS_EXCLUDED_DIRS = new Set([".git", "node_modules"]);
/**
 * A real-filesystem `VaultDirReader`. Shared by `piren doctor` and the
 * `vault_conformance_check` extension tool so both walks behave identically.
 */
export function createRealVaultDirReader() {
    return {
        async list(dir) {
            const entries = await readdir(dir, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory() || entry.isFile())
                .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
        },
        async readFile(path) {
            return readFile(path, "utf8");
        },
    };
}
/** Expand `exclude` (a copy of ALWAYS_EXCLUDED plus caller-provided names). */
function buildExcludeSet(extra) {
    const set = new Set(ALWAYS_EXCLUDED_DIRS);
    if (extra !== undefined) {
        for (const name of extra)
            set.add(name);
    }
    return set;
}
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
export async function checkVaultConformance(options) {
    const exclude = buildExcludeSet(options.exclude);
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const problems = [];
    let checked = 0;
    let truncated = false;
    async function walk(dir) {
        let entries;
        try {
            entries = await options.reader.list(dir);
        }
        catch {
            // An unreadable directory is best-effort skipped.
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith("."))
                continue;
            const childPath = dir === "" ? entry.name : `${dir}/${entry.name}`;
            if (entry.isDirectory) {
                if (exclude.has(entry.name))
                    continue;
                await walk(childPath);
                if (truncated)
                    return;
            }
            else {
                if (!isOkfConceptFilename(entry.name))
                    continue;
                if (isClaimedFilename(entry.name))
                    continue;
                if (checked >= maxFiles) {
                    truncated = true;
                    return;
                }
                checked += 1;
                let content;
                try {
                    content = await options.reader.readFile(childPath);
                }
                catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    problems.push({ path: childPath, kind: "unreadable", detail });
                    continue;
                }
                const doc = checkOkfConceptDocument(childPath, content);
                for (const problem of doc.problems) {
                    problems.push(problem);
                }
            }
        }
    }
    await walk(options.root);
    return {
        root: options.root,
        ok: problems.length === 0,
        checked,
        truncated,
        problems,
    };
}
/**
 * Render a `VaultConformanceResult` as a single human-readable string. Used by
 * `piren doctor` and the `vault_conformance_check` tool so the two surfaces
 * agree on output wording.
 */
export function formatVaultConformanceReport(result) {
    const headline = result.ok
        ? `Vault OKF v0.1 conformant: checked ${result.checked} concept document(s).`
        : `Vault NOT conformant with OKF v0.1: checked ${result.checked}, ${result.problems.length} problem(s).`;
    const truncation = result.truncated
        ? `\n(walk truncated at ${result.checked} files; raise the cap for a full check)`
        : "";
    if (result.problems.length === 0) {
        return `${headline}${truncation}`;
    }
    const lines = result.problems.map((p) => {
        const detail = p.detail !== undefined ? ` (${p.detail})` : "";
        return `${p.kind}\t${p.path}${detail}`;
    });
    return [headline + truncation, "", ...lines].join("\n");
}
//# sourceMappingURL=okf.js.map