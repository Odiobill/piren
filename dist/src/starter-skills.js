import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
const realDeps = {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: async (path, content, options) => {
        await writeFile(path, content, { encoding: "utf8", ...options });
    },
    mkdir: async (path, options) => {
        await mkdir(path, options ?? {});
    },
    exists: async (path) => {
        try {
            await stat(path);
            return true;
        }
        catch {
            return false;
        }
    },
    readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory(),
    })),
};
export function createRealStarterSkillsDeps() {
    return realDeps;
}
/**
 * Resolve the package-owned starter templates directory from a module
 * location. Source runtime (`src/` via tsx) resolves to `<repo>/templates`;
 * compiled runtime (`dist/src/`) resolves to `<repo>/dist/templates` — both
 * via the same `join(moduleDir, "..", "templates")`, so no discriminator or
 * filesystem probe is needed.
 */
export function resolveStarterTemplatesDir(moduleDir) {
    return join(moduleDir, "..", "templates");
}
/** List available starter-skill profile names under the templates dir. */
export async function listStarterProfiles(deps, templatesDir) {
    if (!(await deps.exists(templatesDir)))
        return [];
    const entries = await deps.readdir(templatesDir);
    const profiles = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".") || !entry.isDirectory())
            continue;
        if (await deps.exists(join(templatesDir, entry.name, "manifest.yml"))) {
            profiles.push(entry.name);
        }
    }
    return profiles.sort((a, b) => a.localeCompare(b));
}
/**
 * Parse the raw frontmatter YAML record of a skill document (or null when
 * there is no frontmatter, no closing fence, or the YAML is malformed). Used
 * by template validation to enforce `type: Skill` deterministically.
 */
export function parseSkillFrontmatter(content) {
    return parseFrontmatterYaml(content);
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function asString(value) {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
/**
 * Parse YAML frontmatter (between leading `---` fences) with exactly the same
 * semantics as `src/skills.ts`: name/description from frontmatter, body after
 * the closing fence with leading blank lines trimmed. Tolerant: no frontmatter
 * or malformed YAML yields null metadata, never a throw.
 */
export function parseSkillDocument(content) {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---") {
        return { name: null, description: null, body: content };
    }
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            end = i;
            break;
        }
    }
    if (end === -1) {
        return { name: null, description: null, body: content };
    }
    const yamlText = lines.slice(1, end).join("\n");
    const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
    let name = null;
    let description = null;
    try {
        const parsed = parseYaml(yamlText);
        if (isRecord(parsed)) {
            name = asString(parsed.name);
            description = asString(parsed.description);
        }
    }
    catch {
        // Malformed YAML frontmatter: null metadata, keep the body.
    }
    return { name, description, body };
}
/**
 * Canonical skill content digest: SHA-256 of the fixed-order JSON
 * serialization `{"name","description","body"}`. Independent of frontmatter
 * field order; the provenance block is excluded by construction (only the
 * parsed name/description/body are hashed). There is NO filename fallback.
 */
export function canonicalSkillDigest(name, description, body) {
    const canonical = JSON.stringify({ name, description, body });
    return createHash("sha256").update(canonical).digest("hex");
}
// ---------------------------------------------------------------------------
// Manifest parsing and validation (S3 §2)
// ---------------------------------------------------------------------------
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
function asStringField(record, field, context) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid ${context}: missing or empty '${field}'.`);
    }
    return value.trim();
}
function asEntryArray(value, context) {
    if (!Array.isArray(value))
        throw new Error(`Invalid ${context}: 'entries' must be an array.`);
    return value;
}
/**
 * Parse and structurally validate a starter profile manifest. Throws with a
 * clear message on any invalid field (missing profile/version, invalid
 * version/digest, missing/invalid entry fields, source traversal, duplicate
 * ids/names).
 */
export function parseStarterManifest(yaml) {
    let raw;
    try {
        raw = parseYaml(yaml);
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid starter-skill manifest YAML: ${detail}`);
    }
    if (!isRecord(raw))
        throw new Error("Invalid starter-skill manifest: must be a YAML object.");
    const profile = asStringField(raw, "profile", "starter-skill manifest");
    if (!NAME_PATTERN.test(profile)) {
        throw new Error(`Invalid starter-skill manifest: profile '${profile}' must be lowercase kebab-case.`);
    }
    const version = asStringField(raw, "version", "starter-skill manifest");
    if (!VERSION_PATTERN.test(version)) {
        throw new Error(`Invalid starter-skill manifest: version '${version}' must match <major>.<minor>.<patch>.`);
    }
    const entries = [];
    const ids = new Set();
    const names = new Set();
    for (const rawEntry of asEntryArray(raw.entries, `starter-skill manifest '${profile}'`)) {
        if (!isRecord(rawEntry)) {
            throw new Error(`Invalid starter-skill manifest '${profile}': entry must be an object.`);
        }
        const id = asStringField(rawEntry, "id", `manifest entry`);
        if (!NAME_PATTERN.test(id)) {
            throw new Error(`Invalid starter-skill manifest '${profile}': entry id '${id}' must be lowercase kebab-case.`);
        }
        const name = asStringField(rawEntry, "name", `manifest entry '${id}'`);
        if (!NAME_PATTERN.test(name)) {
            throw new Error(`Invalid starter-skill manifest '${profile}': entry name '${name}' must be lowercase kebab-case.`);
        }
        const scope = asStringField(rawEntry, "scope", `manifest entry '${id}'`);
        if (scope !== "shared" && scope !== "group" && scope !== "agent") {
            throw new Error(`Invalid starter-skill manifest '${profile}': entry '${id}' has unknown scope '${scope}'.`);
        }
        const source = asStringField(rawEntry, "source", `manifest entry '${id}'`);
        if (source.split("/").some((part) => part === ".." || part === ".") || source.includes("\\")) {
            throw new Error(`Invalid starter-skill manifest '${profile}': entry '${id}' source '${source}' escapes the profile tree.`);
        }
        const content_sha256 = asStringField(rawEntry, "content_sha256", `manifest entry '${id}'`);
        if (!DIGEST_PATTERN.test(content_sha256)) {
            throw new Error(`Invalid starter-skill manifest '${profile}': entry '${id}' content_sha256 must be 64 lowercase hex chars.`);
        }
        if (ids.has(id))
            throw new Error(`Invalid starter-skill manifest '${profile}': duplicate entry id '${id}'.`);
        if (names.has(name))
            throw new Error(`Invalid starter-skill manifest '${profile}': duplicate entry name '${name}'.`);
        ids.add(id);
        names.add(name);
        entries.push({ id, name, scope, source, content_sha256 });
    }
    return { profile, version, entries };
}
/**
 * Validate a parsed manifest against the accepted S3 contract. The initial
 * profile is shared-scope only: any non-shared entry is rejected fail-closed.
 */
export function validateStarterManifest(manifest) {
    for (const entry of manifest.entries) {
        if (entry.scope !== "shared") {
            throw new Error(`Unsupported scope '${entry.scope}' for entry '${entry.id}' in profile '${manifest.profile}': the initial profile is shared-scope only.`);
        }
        if (entry.source !== `shared/${entry.name}/SKILL.md`) {
            throw new Error(`Invalid starter-skill manifest '${manifest.profile}': entry '${entry.id}' source '${entry.source}' must match shared/<name>/SKILL.md.`);
        }
    }
}
/**
 * Load and validate every template of a profile: required non-empty
 * name/description, `type: Skill`, directory name == frontmatter name ==
 * manifest name, digest matches the committed manifest digest. Any failure
 * throws with the exact offending field (a package build error per S3 §2).
 */
export async function validateProfileTemplates(deps, templatesDir, manifest) {
    validateStarterManifest(manifest);
    const templates = [];
    for (const entry of manifest.entries) {
        const path = join(templatesDir, manifest.profile, entry.source);
        const content = await deps.readFile(path);
        const doc = parseSkillDocument(content);
        if (doc.name === null || doc.description === null) {
            throw new Error(`Template validation failed for '${manifest.profile}/${entry.id}': frontmatter must have non-empty 'name' and 'description'.`);
        }
        const raw = parseSkillFrontmatter(content);
        const type = raw === null || raw.type === undefined ? null : typeof raw.type === "string" ? raw.type : null;
        if (type !== "Skill") {
            throw new Error(`Template validation failed for '${manifest.profile}/${entry.id}': frontmatter 'type' must be 'Skill' (found ${JSON.stringify(type)}).`);
        }
        const frontmatterName = doc.name;
        const dirName = basename(dirname(path));
        if (frontmatterName !== entry.name || dirName !== entry.name) {
            throw new Error(`Template validation failed for '${manifest.profile}/${entry.id}': frontmatter name ('${frontmatterName}') and directory name ('${dirName}') must both equal the manifest name ('${entry.name}').`);
        }
        const digest = canonicalSkillDigest(doc.name, doc.description, doc.body);
        if (digest !== entry.content_sha256) {
            throw new Error(`Template validation failed for '${manifest.profile}/${entry.id}': committed content_sha256 does not match the canonical digest of the template file.`);
        }
        templates.push({ entry, path, name: doc.name, description: doc.description, body: doc.body, digest });
    }
    return { profile: manifest.profile, version: manifest.version, templates };
}
// ---------------------------------------------------------------------------
// Target paths and vault-boundary containment
// ---------------------------------------------------------------------------
function entryTargetPath(vaultRoot, name) {
    return join(vaultRoot, "skills", name, "SKILL.md");
}
/** Assert a resolved path stays inside the vault root; throws otherwise. */
function assertInsideVault(vaultRoot, path, label) {
    const rel = relative(resolve(vaultRoot), resolve(path));
    if (rel === "" || isAbsolute(rel) || rel.startsWith("..") || rel.split("/").includes("..")) {
        throw new Error(`${label} escapes the vault root.`);
    }
}
/**
 * Validate the target vault root: it must exist and carry the `.piren-vault`
 * marker. Never creates a missing root (a missing root is a hard rejection,
 * never authoritative state).
 */
export async function assertVaultRoot(deps, vaultRoot) {
    if (!(await deps.exists(vaultRoot))) {
        throw new Error(`Target vault root does not exist: ${vaultRoot}`);
    }
    if (!(await deps.exists(join(vaultRoot, ".piren-vault")))) {
        throw new Error(`Target root is not a Piren vault (missing .piren-vault): ${vaultRoot}`);
    }
}
function derivedNameFor(filePath, doc) {
    if (doc.name !== null)
        return doc.name;
    const fileName = basename(filePath);
    // Directory-based skills derive the name from the containing directory
    // (src/skills.ts uses `entry.name` for <dir>/SKILL.md); loose .md files use
    // the filename stem. This matches the loader's path-aware derivation.
    if (fileName === "SKILL.md")
        return basename(dirname(filePath));
    return fileName.endsWith(".md") ? fileName.slice(0, -3) : null;
}
/** Enumerate every skill file in one scope directory and its effective name. */
async function scanScopeFiles(deps, dir, scopeLabel) {
    if (!(await deps.exists(dir)))
        return [];
    const entries = await deps.readdir(dir);
    const found = [];
    for (const entry of entries) {
        if (entry.name.startsWith("."))
            continue;
        let candidate = null;
        if (entry.isDirectory()) {
            const skillMd = join(dir, entry.name, "SKILL.md");
            if (await deps.exists(skillMd))
                candidate = skillMd;
        }
        else if (entry.name.endsWith(".md")) {
            candidate = join(dir, entry.name);
        }
        if (candidate === null)
            continue;
        const content = await deps.readFile(candidate);
        const doc = parseSkillDocument(content);
        const raw = parseFrontmatterYaml(content);
        const template = raw?.template;
        const templateId = isRecord(template) && typeof template.id === "string" && template.id.trim() !== ""
            ? template.id.trim()
            : null;
        found.push({ path: candidate, scope: scopeLabel, effectiveName: derivedNameFor(candidate, doc), templateId });
    }
    return found;
}
async function scanAllSkillFiles(deps, vaultRoot) {
    const found = [];
    found.push(...(await scanScopeFiles(deps, join(vaultRoot, "skills"), "shared")));
    const groupsDir = join(vaultRoot, "agent-groups");
    if (await deps.exists(groupsDir)) {
        for (const group of await deps.readdir(groupsDir)) {
            if (!group.isDirectory() || group.name.startsWith("."))
                continue;
            found.push(...(await scanScopeFiles(deps, join(groupsDir, group.name, "skills"), `group:${group.name}`)));
        }
    }
    const teamDir = join(vaultRoot, "team");
    if (await deps.exists(teamDir)) {
        for (const agent of await deps.readdir(teamDir)) {
            if (!agent.isDirectory() || agent.name.startsWith("."))
                continue;
            found.push(...(await scanScopeFiles(deps, join(teamDir, agent.name, "skills"), `agent:${agent.name}`)));
        }
    }
    return found;
}
/**
 * Find every vault occurrence of a skill name across shared, group, and agent
 * scopes (the loader's precedence layers) without needing a runnable agent.
 */
export async function findSkillOccurrences(deps, vaultRoot, name) {
    const occurrences = await scanAllSkillFiles(deps, vaultRoot);
    return occurrences
        .filter((occurrence) => occurrence.effectiveName === name)
        .map(({ path, scope }) => ({ path, scope }));
}
function findTemplateIdOccurrences(occurrences, templateId) {
    return occurrences
        .filter((occurrence) => occurrence.templateId === templateId)
        .map(({ path, scope }) => ({ path, scope }));
}
/** Parse and identity-validate the `template` provenance block. */
function parseProvenance(manifest, entry, raw) {
    if (!isRecord(raw)) {
        throw new Error("template block is missing or malformed");
    }
    const required = ["id", "profile", "version", "content_sha256"];
    for (const field of required) {
        const value = raw[field];
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`template block is missing or invalid '${field}'`);
        }
    }
    const provenance = {
        id: raw.id.trim(),
        profile: raw.profile.trim(),
        version: raw.version.trim(),
        content_sha256: raw.content_sha256.trim(),
    };
    if (!DIGEST_PATTERN.test(provenance.content_sha256)) {
        throw new Error("template block 'content_sha256' is not a 64-char lowercase hex digest");
    }
    if (!VERSION_PATTERN.test(provenance.version)) {
        throw new Error(`template block 'version' is not a valid version ('${provenance.version}')`);
    }
    // Identity is bound to the manifest: id/profile must match the expected entry.
    if (provenance.id !== entry.id) {
        throw new Error(`template block 'id' mismatch: expected '${entry.id}', found '${provenance.id}'`);
    }
    if (provenance.profile !== manifest.profile) {
        throw new Error(`template block 'profile' mismatch: expected '${manifest.profile}', found '${provenance.profile}'`);
    }
    return provenance;
}
/**
 * Classify one expected template entry at its vault path per the total S3 §5
 * precedence. A duplicate name/template-id conflict is a BLOCKING OVERLAY:
 * the underlying integrity state (rules 3-4) is always computed and reported
 * alongside it, never replaced by it.
 */
export async function classifyStarterEntry(deps, vaultRoot, manifest, entry) {
    const targetPath = entryTargetPath(vaultRoot, entry.name);
    const allOccurrences = await scanAllSkillFiles(deps, vaultRoot);
    const occurrences = allOccurrences.filter((occ) => occ.effectiveName === entry.name);
    const targetPresent = occurrences.some((occ) => occ.path === targetPath);
    const otherNameOccurrences = occurrences.filter((occ) => occ.path !== targetPath);
    const idOccurrences = findTemplateIdOccurrences(allOccurrences, entry.id);
    const otherIdOccurrences = idOccurrences.filter((occ) => occ.path !== targetPath);
    const conflictPaths = [
        ...new Set([...otherNameOccurrences.map((o) => o.path), ...otherIdOccurrences.map((o) => o.path)]),
    ];
    const duplicateOverlay = conflictPaths.length > 0
        ? {
            reason: `name '${entry.name}' / template id '${entry.id}' is already active outside the target path (${conflictPaths.join(", ")})`,
            paths: conflictPaths,
        }
        : null;
    // Underlying integrity state, always computed fail-closed beneath the overlay.
    const state = targetPresent
        ? await classifyTargetFile(deps, manifest, entry, targetPath)
        : { kind: "absent" };
    return { entry, targetPath, state, duplicateOverlay };
}
/** Classify the file present at the exact target path (S3 §5 rules 3-4). */
async function classifyTargetFile(deps, manifest, entry, targetPath) {
    const content = await deps.readFile(targetPath);
    const doc = parseSkillDocument(content);
    const rawYaml = parseFrontmatterYaml(content);
    let provenance;
    try {
        provenance = parseProvenance(manifest, entry, rawYaml?.template);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { kind: "provenance-invalid", path: targetPath, reason };
    }
    if (doc.name === null || doc.description === null) {
        return {
            kind: "provenance-invalid",
            path: targetPath,
            reason: "frontmatter missing non-empty name/description",
        };
    }
    const fileDigest = canonicalSkillDigest(doc.name, doc.description, doc.body);
    const recorded = provenance.content_sha256;
    const manifestDigest = entry.content_sha256;
    if (fileDigest === recorded) {
        if (recorded === manifestDigest && provenance.version === manifest.version) {
            return { kind: "seeded-current", path: targetPath };
        }
        return { kind: "seeded-outdated-unmodified", path: targetPath, recordedVersion: provenance.version };
    }
    if (fileDigest === manifestDigest) {
        return {
            kind: "provenance-invalid",
            path: targetPath,
            reason: "content matches the current manifest digest but the recorded digest does not match the content (integrity-inconsistent provenance)",
        };
    }
    return { kind: "user-modified", path: targetPath };
}
/** Extract the raw frontmatter YAML object of a skill document (or null). */
function parseFrontmatterYaml(content) {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---")
        return null;
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            end = i;
            break;
        }
    }
    if (end === -1)
        return null;
    try {
        const parsed = parseYaml(lines.slice(1, end).join("\n"));
        return isRecord(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
/** Read-only doctor report: every entry, its state, and duplicate overlays. */
export async function runStarterDoctor(deps, vaultRoot, manifest) {
    await assertVaultRoot(deps, vaultRoot);
    const entries = [];
    for (const entry of manifest.entries) {
        entries.push(await classifyStarterEntry(deps, vaultRoot, manifest, entry));
    }
    return entries;
}
export async function planStarterSeed(deps, vaultRoot, manifest) {
    const doctor = await runStarterDoctor(deps, vaultRoot, manifest);
    const items = doctor.map((entry) => {
        let action;
        switch (entry.state.kind) {
            case "absent":
                action = "create";
                break;
            case "seeded-current":
                action = "unchanged";
                break;
            default:
                action = "conflict";
                break;
        }
        return { entry: entry.entry, targetPath: entry.targetPath, action, state: entry.state, duplicateOverlay: entry.duplicateOverlay };
    });
    const blockedByDuplicate = doctor.some((entry) => entry.duplicateOverlay !== null);
    const canApply = !blockedByDuplicate && items.some((item) => item.action === "create");
    return { items, blockedByDuplicate, canApply };
}
/** Build the seeded copy: template content plus the required template block. */
export function buildSeededContent(templateContent, provenance) {
    const lines = templateContent.split("\n");
    if (lines[0]?.trim() !== "---") {
        throw new Error("Cannot inject provenance: template has no frontmatter fence.");
    }
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            close = i;
            break;
        }
    }
    if (close === -1)
        throw new Error("Cannot inject provenance: template frontmatter has no closing fence.");
    const block = [
        "template:",
        `  id: ${provenance.id}`,
        `  profile: ${provenance.profile}`,
        `  version: ${provenance.version}`,
        `  content_sha256: ${provenance.content_sha256}`,
    ];
    return [...lines.slice(0, close), ...block, ...lines.slice(close)].join("\n");
}
/**
 * Apply the seed plan: create ONLY absent shared-scope target files. Refuses
 * entirely when a duplicate overlay blocks. Never touches conflict files.
 * Re-plans inside apply so the write set is freshly observed.
 */
export async function applyStarterSeed(deps, templatesDir, vaultRoot, manifest) {
    await assertVaultRoot(deps, vaultRoot);
    const plan = await planStarterSeed(deps, vaultRoot, manifest);
    if (plan.blockedByDuplicate) {
        const overlays = plan.items
            .map((item) => item.duplicateOverlay)
            .filter((overlay) => overlay !== null);
        throw new Error(`Seed blocked by duplicate active skill name/template id: ${overlays.map((o) => o.reason).join("; ")}`);
    }
    const validation = await validateProfileTemplates(deps, templatesDir, manifest);
    const created = [];
    const skippedConflicts = [];
    for (const item of plan.items) {
        if (item.action === "create") {
            const template = validation.templates.find((t) => t.entry.id === item.entry.id);
            if (template === undefined) {
                throw new Error(`Seed plan references unknown template entry '${item.entry.id}'.`);
            }
            assertInsideVault(vaultRoot, item.targetPath, "Seed target path");
            await deps.mkdir(join(vaultRoot, "skills", item.entry.name), { recursive: true });
            const seeded = buildSeededContent(await deps.readFile(template.path), {
                id: item.entry.id,
                profile: manifest.profile,
                version: manifest.version,
                content_sha256: item.entry.content_sha256,
            });
            await deps.writeFile(item.targetPath, seeded, { flag: "wx" });
            created.push({ path: item.targetPath, name: item.entry.name, id: item.entry.id });
        }
        else if (item.action === "conflict") {
            skippedConflicts.push({ path: item.targetPath, name: item.entry.name, state: item.state });
        }
    }
    return { created, skippedConflicts };
}
//# sourceMappingURL=starter-skills.js.map