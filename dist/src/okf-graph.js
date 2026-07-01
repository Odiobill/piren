import { posix as pathPosix } from "node:path";
import { isClaimedFilename, isOkfConceptFilename, parseOkfFrontmatter, } from "./okf.js";
const DEFAULT_MAX_FILES = 10000;
const ALWAYS_EXCLUDED_DIRS = new Set([".git", "node_modules"]);
function buildExcludeSet(extra) {
    const set = new Set(ALWAYS_EXCLUDED_DIRS);
    if (extra !== undefined) {
        for (const name of extra)
            set.add(name);
    }
    return set;
}
function stringField(fields, name) {
    const value = fields[name];
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
}
function fallbackTitle(path) {
    const filename = pathPosix.basename(path, ".md");
    return filename
        .split(/[-_]+/g)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(" ");
}
async function collectDocuments(options) {
    const exclude = buildExcludeSet(options.exclude);
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const documents = [];
    const problems = [];
    let checked = 0;
    let truncated = false;
    async function walk(dir) {
        let entries;
        try {
            entries = await options.reader.list(dir);
        }
        catch {
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
                continue;
            }
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
            const parsed = parseOkfFrontmatter(content);
            const type = stringField(parsed.fields, "type") ?? null;
            const title = stringField(parsed.fields, "title") ?? fallbackTitle(childPath);
            const description = stringField(parsed.fields, "description");
            const doc = { path: childPath, type, title, body: parsed.body };
            if (description !== undefined)
                doc.description = description;
            documents.push(doc);
        }
    }
    await walk(options.root);
    return { documents, problems, truncated };
}
function stripTrailingUrlPunctuation(url) {
    return url.replace(/[),.;:!?]+$/g, "");
}
function extractLinks(markdown) {
    const found = [];
    for (const match of markdown.matchAll(/\[\[([^\]]+)\]\]/g)) {
        const inner = (match[1] ?? "").trim();
        const target = inner.split("|")[0]?.split("#")[0]?.trim();
        if (target !== undefined && target !== "") {
            found.push({ index: match.index ?? 0, link: { href: target, kind: "wikilink" } });
        }
    }
    for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const href = (match[1] ?? "").trim();
        if (href === "")
            continue;
        if (/^https?:\/\//i.test(href)) {
            found.push({ index: match.index ?? 0, link: { href: stripTrailingUrlPunctuation(href), kind: "external" } });
        }
        else if (href.startsWith("/")) {
            found.push({ index: match.index ?? 0, link: { href, kind: "bundle" } });
        }
        else if (href.startsWith("./") || href.startsWith("../")) {
            found.push({ index: match.index ?? 0, link: { href, kind: "relative" } });
        }
    }
    const linkRanges = [];
    for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const targetGroup = match[1] ?? "";
        const hrefStart = (match.index ?? 0) + (match[0] ?? "").indexOf(targetGroup);
        linkRanges.push({ start: hrefStart, end: hrefStart + targetGroup.length });
    }
    for (const match of markdown.matchAll(/(^|[\s(])((?:https?:\/\/)[^\s<>)]+)/g)) {
        const href = stripTrailingUrlPunctuation(match[2] ?? "");
        if (href === "")
            continue;
        const hrefStart = (match.index ?? 0) + (match[0] ?? "").indexOf(href);
        const insideLink = linkRanges.some((range) => hrefStart >= range.start && hrefStart < range.end);
        if (!insideLink) {
            found.push({ index: hrefStart, link: { href, kind: "external" } });
        }
    }
    for (const match of markdown.matchAll(/(^|[\s(])\/(?!\/)([^\s<>)]+\.md)(?=$|[\s),.;:!?])/g)) {
        const href = `/${match[2] ?? ""}`;
        if (href === "/")
            continue;
        const hrefStart = (match.index ?? 0) + (match[0] ?? "").indexOf(href);
        const insideLink = linkRanges.some((range) => hrefStart >= range.start && hrefStart < range.end);
        if (!insideLink) {
            found.push({ index: hrefStart, link: { href, kind: "bundle" } });
        }
    }
    found.sort((a, b) => a.index - b.index);
    return found.map((entry) => entry.link);
}
function normalizeVaultPath(path) {
    const normalized = pathPosix.normalize(path).replace(/^\/+/, "");
    if (normalized === "." || normalized === "" || normalized.startsWith("../"))
        return null;
    return normalized;
}
function withMarkdownExtension(path) {
    return path.endsWith(".md") ? path : `${path}.md`;
}
function buildLookup(documents) {
    const lookup = new Map();
    for (const doc of documents) {
        lookup.set(doc.path, doc.path);
        lookup.set(doc.path.replace(/\.md$/i, ""), doc.path);
        lookup.set(pathPosix.basename(doc.path, ".md"), doc.path);
        lookup.set(doc.title, doc.path);
        lookup.set(doc.title.toLowerCase(), doc.path);
    }
    return lookup;
}
function resolveTarget(link, sourcePath, lookup) {
    if (link.kind === "external")
        return link.href;
    if (link.kind === "relative") {
        const base = pathPosix.dirname(sourcePath);
        const normalized = normalizeVaultPath(pathPosix.join(base, link.href));
        return normalized === null ? null : withMarkdownExtension(normalized);
    }
    if (link.kind === "bundle") {
        const normalized = normalizeVaultPath(link.href);
        return normalized === null ? null : withMarkdownExtension(normalized);
    }
    const direct = normalizeVaultPath(link.href);
    if (direct !== null) {
        const directMarkdown = withMarkdownExtension(direct);
        const found = lookup.get(directMarkdown) ?? lookup.get(direct);
        if (found !== undefined)
            return found;
        if (direct.includes("/"))
            return directMarkdown;
    }
    const byExact = lookup.get(link.href) ?? lookup.get(link.href.toLowerCase());
    if (byExact !== undefined)
        return byExact;
    return withMarkdownExtension(link.href);
}
function edgeKey(edge) {
    return `${edge.source}\u0000${edge.target}\u0000${edge.href}\u0000${edge.kind}`;
}
export async function buildOkfGraph(options) {
    const { documents, problems, truncated } = await collectDocuments(options);
    const lookup = buildLookup(documents);
    const nodes = [];
    const edges = [];
    const seenEdges = new Set();
    for (const doc of documents) {
        if (doc.type === "Concept" || doc.type === "Entity") {
            const node = {
                id: doc.path,
                path: doc.path,
                type: doc.type,
                title: doc.title,
            };
            if (doc.description !== undefined)
                node.description = doc.description;
            nodes.push(node);
        }
    }
    for (const doc of documents) {
        if (doc.type !== "Concept" && doc.type !== "Entity")
            continue;
        for (const link of extractLinks(doc.body)) {
            const target = resolveTarget(link, doc.path, lookup);
            if (target === null)
                continue;
            const edge = {
                source: doc.path,
                target,
                href: link.href,
                kind: link.kind,
                external: link.kind === "external",
            };
            const key = edgeKey(edge);
            if (seenEdges.has(key))
                continue;
            seenEdges.add(key);
            edges.push(edge);
        }
    }
    return { nodes, edges, problems, truncated };
}
//# sourceMappingURL=okf-graph.js.map