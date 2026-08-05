/**
 * C2 — Conversation durable record core (ADR-0042, accepted C2 contract §1).
 *
 * Owns the Conversation Manifest and immutable event records under the
 * DISTINCT additive namespace `collaboration/conversations/<id>/`. This is a
 * sibling tree: it never writes, scans, renames, or deletes
 * `collaboration/rooms/**`, and no room code is generalized or changed. The
 * semantics deliberately mirror the proven room record conventions (atomic
 * no-clobber writes, deterministic compact-UTC ids, tolerant list, strict
 * manifest/event validation naming their path) without importing or altering
 * room types.
 *
 * A Conversation exists only after activation (first message); a draft has no
 * record. The manifest carries the additive `audience` membership, which grows
 * only through validated steward mentions (C1 `applyMembershipChange`).
 *
 * This module is a pure core over an injected write seam: every behavior is
 * unit-testable without Pi auth or a real filesystem beyond the caller's io.
 */
import { link, mkdir, open, readdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { applyMembershipChange } from "./conversation-contract.js";
export const CONVERSATION_STATUSES = ["open", "archived"];
export const CONVERSATION_EVENT_KINDS = [
    "steward_message",
    "run_started",
    "agent_message",
    "run_finished",
    "run_cancelled",
];
export const CONVERSATION_AUTHOR_KINDS = ["steward", "agent", "system"];
export const CONVERSATION_RUN_STATUSES = ["running", "completed", "failed", "timed_out", "cancelled"];
export const CONVERSATION_RUN_FAILURE_KINDS = ["launch_failure", "ambiguous"];
const CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CONVERSATION_TITLE_PREFIX_MAX = 48;
const CONVERSATION_SLUG_MAX = 48;
/** Deterministic compact-UTC timestamp: `20260805T131530000Z`. */
export function compactConversationTimestamp(date) {
    return date.toISOString().replace(/[-:.]/g, "");
}
function plainPrefix(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.slice(0, CONVERSATION_TITLE_PREFIX_MAX);
}
function slug(text) {
    const slugged = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, CONVERSATION_SLUG_MAX)
        .replace(/-+$/g, "");
    return slugged || "conversation";
}
/** Deterministic conversation id from the first message (no LLM). */
export function conversationIdFromText(text, now) {
    return `${compactConversationTimestamp(now)}-${slug(text)}`;
}
/** Deterministic display title from the first message (no LLM). */
export function conversationTitleFromText(text, now) {
    const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const prefix = plainPrefix(text);
    return prefix === "" ? `Conversation ${stamp}` : `Conversation ${stamp} - ${prefix}`;
}
function assertValidConversationId(conversationId) {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
        throw new Error("Invalid conversation id. Use the deterministic compact-UTC id.");
    }
}
function assertInside(baseDir, target) {
    const rel = relative(resolve(baseDir), resolve(target));
    if (rel === "" || isAbsolute(rel) || rel.startsWith("..") || rel.split("/").includes("..")) {
        throw new Error("Conversation path escapes the vault root.");
    }
}
function createNodeConversationWriteIo() {
    return {
        linkNoClobber: (tempPath, targetPath) => link(tempPath, targetPath),
        remove: async (absolutePath) => {
            await rm(absolutePath, { force: true });
        },
    };
}
const NODE_CONVERSATION_WRITE_IO = createNodeConversationWriteIo();
function isEexist(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
/**
 * Atomic no-clobber write: temp file in the same directory, fsync, then a
 * hard-link rename that fails when the target already exists (POSIX/NFSv4).
 */
async function atomicCreateNoClobber(target, content, io, now, nonce) {
    const directory = dirname(target);
    const random = nonce === undefined ? `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}` : nonce();
    const tempPath = resolve(directory, `.${random}.tmp`);
    const bytes = Buffer.byteLength(content);
    const handle = await open(tempPath, "wx", 0o600);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await io.linkNoClobber(tempPath, resolve(target));
    }
    finally {
        await io.remove(tempPath);
    }
    return bytes;
}
function renderConversationManifest(options) {
    const audienceYaml = options.audience.length === 0
        ? "audience: []"
        : ["audience:", ...options.audience.map((name) => `  - ${name}`)].join("\n");
    return [
        "---",
        "type: Conversation Manifest",
        `id: ${options.id}`,
        `title: "${options.title}"`,
        audienceYaml,
        "status: open",
        "created_by: steward",
        `created: ${options.created ?? options.timestamp}`,
        `updated: ${options.timestamp}`,
        "---",
        "",
    ].join("\n");
}
function parseConversationManifest(content, path, expectedId, root) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch === null) {
        throw new Error(`Invalid conversation manifest at ${path}: missing frontmatter.`);
    }
    let fields;
    try {
        fields = parseYaml(frontmatterMatch[1]);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid conversation manifest at ${path}: ${detail}`);
    }
    if (fields.type !== "Conversation Manifest") {
        throw new Error(`Invalid conversation manifest at ${path}: type must be 'Conversation Manifest'`);
    }
    const idValue = fields.id;
    if (typeof idValue !== "string") {
        throw new Error(`Invalid conversation manifest at ${path}: id is required`);
    }
    if (idValue !== expectedId) {
        throw new Error(`Invalid conversation manifest at ${path}: id mismatch (expected '${expectedId}')`);
    }
    const id = idValue;
    const titleValue = fields.title;
    if (typeof titleValue !== "string" || titleValue.trim() === "") {
        throw new Error(`Invalid conversation manifest at ${path}: title is required`);
    }
    const title = titleValue.trim();
    const statusValue = fields.status;
    if (statusValue !== "open" && statusValue !== "archived") {
        throw new Error(`Invalid conversation manifest at ${path}: status must be open or archived`);
    }
    const status = statusValue;
    const createdByValue = fields.created_by;
    if (createdByValue !== "steward") {
        throw new Error(`Invalid conversation manifest at ${path}: created_by must be 'steward'`);
    }
    const createdBy = createdByValue;
    const createdValue = fields.created;
    const updatedValue = fields.updated;
    if (typeof createdValue !== "string" || typeof updatedValue !== "string") {
        throw new Error(`Invalid conversation manifest at ${path}: created/updated timestamps are required`);
    }
    const created = createdValue;
    const updated = updatedValue;
    const audienceRaw = fields.audience;
    if (!Array.isArray(audienceRaw) || audienceRaw.some((entry) => typeof entry !== "string" || !AGENT_NAME_PATTERN.test(entry))) {
        throw new Error(`Invalid conversation manifest at ${path}: audience must be an array of lowercase-kebab agent names`);
    }
    return {
        id,
        title: title.trim(),
        audience: audienceRaw,
        status: status,
        createdBy,
        created,
        updated,
        path,
        absolutePath: resolve(root, path),
    };
}
/** Create + activate a Conversation from its first message (atomic no-clobber). */
export async function createConversation(options) {
    const text = typeof options.text === "string" ? options.text : "";
    if (text.trim() === "") {
        throw new Error("Conversation first message text is required.");
    }
    const audience = [...options.audience];
    for (const name of audience) {
        if (!AGENT_NAME_PATTERN.test(name)) {
            throw new Error(`Invalid conversation audience agent name: '${name}'.`);
        }
    }
    if (new Set(audience).size !== audience.length) {
        throw new Error("Duplicate conversation audience member.");
    }
    const root = resolve(options.vaultRoot);
    const created = (options.now ?? (() => new Date()))().toISOString();
    const id = conversationIdFromText(text, new Date(created));
    assertValidConversationId(id);
    const conversationDir = resolve(root, "collaboration", "conversations", id);
    assertInside(root, conversationDir);
    await mkdir(join(conversationDir, "events"), { recursive: true });
    const manifest = renderConversationManifest({ id, title: conversationTitleFromText(text, new Date(created)), audience, timestamp: created });
    const absolutePath = join(conversationDir, "index.md");
    let bytes;
    try {
        bytes = await atomicCreateNoClobber(absolutePath, manifest, options.io ?? NODE_CONVERSATION_WRITE_IO, options.now ?? (() => new Date()), options.nonce);
    }
    catch (error) {
        if (isEexist(error)) {
            throw new Error(`Conversation already exists: ${id}. Refusing to overwrite existing conversation evidence.`);
        }
        throw error;
    }
    return {
        id,
        title: conversationTitleFromText(text, new Date(created)),
        audience,
        status: "open",
        createdBy: "steward",
        created,
        updated: created,
        path: relative(root, absolutePath),
        absolutePath,
        bytes,
    };
}
/**
 * C2 additive later-mention membership seam: grow the durable manifest
 * `audience` with validated steward recipients only, preserving existing
 * first-mention order with no removals/reordering (C1 `applyMembershipChange`
 * steward path), preserve the original `created` byte-for-byte, and bump only
 * `updated`. The write is an atomic temp + rename replace of the manifest;
 * invalid mentions are never passed here (the gateway resolves ALL mentions
 * before any durable effect).
 *
 * Coordination limitation (explicit, not silently claimed as atomic): the
 * audience update is a read-modify-write over the manifest. Within one
 * process the gateway serializes updates; concurrent CROSS-PROCESS updates
 * to the same conversation's audience are last-writer-wins on the whole
 * `audience` array (no merge), consistent with C2's no-hidden-state and no
 * cross-process lock boundary. Membership is only ever additive, so a lost
 * update can never remove a member; a re-reading steward sees the latest
 * persisted audience.
 */
export async function updateConversationAudience(options) {
    assertValidConversationId(options.conversationId);
    const root = resolve(options.vaultRoot);
    const conversationDir = resolve(root, "collaboration", "conversations", options.conversationId);
    const absolutePath = join(conversationDir, "index.md");
    assertInside(root, conversationDir);
    const current = await readConversation({ vaultRoot: root, conversationId: options.conversationId });
    const audience = applyMembershipChange(current.audience, { kind: "steward", recipients: options.additions });
    const updatedStamp = (options.now ?? (() => new Date()))().toISOString();
    const content = renderConversationManifest({
        id: current.id,
        title: current.title,
        audience,
        timestamp: updatedStamp,
        created: current.created,
    });
    // Atomic replace: temp file in the same directory, then rename over the
    // existing manifest (POSIX rename replaces atomically). Never a partial
    // manifest; the file stays inspectable at every step.
    const tempPath = resolve(conversationDir, `.audience-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, absolutePath);
    return readConversation({ vaultRoot: root, conversationId: options.conversationId });
}
function renderConversationEvent(options) {
    const fields = [
        "---",
        "type: Conversation Event",
        `id: ${options.id}`,
        `conversationId: ${options.conversationId}`,
        `kind: ${options.kind}`,
        `authorKind: ${options.authorKind}`,
        `author: ${options.author}`,
        `created: ${options.created}`,
        `sequence: ${options.sequence}`,
    ];
    if (options.mentions !== undefined && options.mentions.length > 0) {
        fields.push("mentions:");
        for (const name of options.mentions)
            fields.push(`  - ${name}`);
    }
    if (options.correlationId !== undefined)
        fields.push(`correlationId: ${options.correlationId}`);
    if (options.addressedAgent !== undefined)
        fields.push(`addressedAgent: ${options.addressedAgent}`);
    if (options.runStatus !== undefined)
        fields.push(`runStatus: ${options.runStatus}`);
    if (options.failureKind !== undefined)
        fields.push(`failureKind: ${options.failureKind}`);
    if (options.contextMetadata !== undefined)
        fields.push(`contextMetadata: '${JSON.stringify(options.contextMetadata)}'`);
    fields.push("---", "", options.body, "");
    return fields.join("\n");
}
function assertValidRunOutcome(kind, runStatus, failureKind) {
    const isRunEvent = kind === "run_started" || kind === "run_finished" || kind === "run_cancelled";
    if (!isRunEvent)
        return;
    if (runStatus === undefined) {
        throw new Error(`Conversation run event '${kind}' requires runStatus.`);
    }
    if (runStatus === "failed" && failureKind === undefined) {
        throw new Error(`Conversation run_finished with runStatus 'failed' requires failureKind.`);
    }
    if (runStatus !== "failed" && failureKind !== undefined) {
        throw new Error(`Conversation runStatus '${runStatus}' must not carry failureKind.`);
    }
    if (kind === "run_finished" && (runStatus === "running" || runStatus === "cancelled")) {
        throw new Error(`Conversation run_finished must not carry runStatus '${runStatus}'.`);
    }
    if (kind === "run_started" && runStatus !== "running") {
        throw new Error(`Conversation run_started requires runStatus 'running'.`);
    }
    if (kind === "run_cancelled" && runStatus !== "cancelled") {
        throw new Error(`Conversation run_cancelled requires runStatus 'cancelled'.`);
    }
}
/** Zero-padded event-sequence filename width: `00000001.md` ... `99999999.md`. */
const EVENT_SEQUENCE_WIDTH = 8;
const EVENT_SEQUENCE_FILENAME = /^(\d+)\.md$/;
/**
 * Next strictly-increasing positive event sequence: the maximum existing
 * zero-padded sequence filename + 1 (1 when the directory is empty). The
 * allocation is NOT atomic by itself — the append loop pairs it with the
 * no-clobber (`wx`) event write and retries on EEXIST, so the sequence slot
 * and the event file are allocated at the SAME boundary. Files that do not
 * match the sequence pattern (legacy/hand-written) are skipped defensively;
 * an unexpected read error fails closed (the caller surfaces it).
 */
async function nextEventSequence(eventsDir) {
    let entries;
    try {
        entries = await readdir(eventsDir, { withFileTypes: true });
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return 1;
        }
        throw error;
    }
    let max = 0;
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const match = EVENT_SEQUENCE_FILENAME.exec(entry.name);
        if (match === null)
            continue;
        const value = Number(match[1]);
        if (Number.isSafeInteger(value) && value > max)
            max = value;
    }
    return max + 1;
}
/** Append one immutable Conversation event (no-clobber). */
export async function appendConversationEvent(options) {
    assertValidConversationId(options.conversationId);
    if (!CONVERSATION_EVENT_KINDS.includes(options.kind)) {
        throw new Error(`Invalid conversation event kind: ${options.kind}`);
    }
    if (!CONVERSATION_AUTHOR_KINDS.includes(options.authorKind)) {
        throw new Error(`Invalid conversation author kind: ${options.authorKind}`);
    }
    assertValidRunOutcome(options.kind, options.runStatus, options.failureKind);
    const root = resolve(options.vaultRoot);
    const created = (options.now ?? (() => new Date()))().toISOString();
    const id = `${compactConversationTimestamp(new Date(created))}${options.nonce !== undefined ? `-${options.nonce()}` : ""}`;
    const conversationDir = resolve(root, "collaboration", "conversations", options.conversationId);
    const eventsDir = join(conversationDir, "events");
    assertInside(root, conversationDir);
    // Race-safe sequence allocation: the zero-padded `<seq>.md` filename is
    // created with the same no-clobber boundary as the event write, and a
    // concurrent appender that loses the EEXIST race re-allocates the next
    // free sequence. Sequence is the authoritative durable append order; the
    // compact-nonce `id` remains the correlation key.
    let sequence = options.sequence;
    let absolutePath = "";
    let bytes = 0;
    for (;;) {
        if (sequence === undefined) {
            sequence = await nextEventSequence(eventsDir);
        }
        const filename = `${String(sequence).padStart(EVENT_SEQUENCE_WIDTH, "0")}.md`;
        const candidate = join(eventsDir, filename);
        assertInside(root, candidate);
        const content = renderConversationEvent({
            id,
            conversationId: options.conversationId,
            kind: options.kind,
            authorKind: options.authorKind,
            author: options.author,
            created,
            sequence,
            ...(options.mentions !== undefined ? { mentions: options.mentions } : {}),
            ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
            ...(options.addressedAgent !== undefined ? { addressedAgent: options.addressedAgent } : {}),
            ...(options.runStatus !== undefined ? { runStatus: options.runStatus } : {}),
            ...(options.failureKind !== undefined ? { failureKind: options.failureKind } : {}),
            ...(options.contextMetadata !== undefined ? { contextMetadata: options.contextMetadata } : {}),
            body: options.body,
        });
        try {
            bytes = await atomicCreateNoClobber(candidate, content, options.io ?? NODE_CONVERSATION_WRITE_IO, options.now ?? (() => new Date()), undefined);
            absolutePath = candidate;
            break;
        }
        catch (error) {
            if (isEexist(error) && options.sequence === undefined) {
                // Another appender won this sequence slot: re-allocate and retry.
                // Bounded by the event file count; every successful write is
                // no-clobber and never overwrites/deletes event evidence.
                sequence = undefined;
                continue;
            }
            if (isEexist(error)) {
                throw new Error(`Conversation event sequence ${String(sequence)} already exists (${id}). Refusing to overwrite immutable evidence.`);
            }
            throw error;
        }
    }
    return {
        id,
        path: relative(root, absolutePath),
        absolutePath,
        conversationId: options.conversationId,
        kind: options.kind,
        created,
        sequence,
        bytes,
    };
}
export async function readConversation(options) {
    assertValidConversationId(options.conversationId);
    const root = resolve(options.vaultRoot);
    const absolutePath = resolve(root, "collaboration", "conversations", options.conversationId, "index.md");
    assertInside(root, absolutePath);
    const content = await readFile(absolutePath, "utf8");
    return parseConversationManifest(content, relative(root, absolutePath), options.conversationId, root);
}
/** List Conversation manifests, newest-first (created desc, id asc tiebreak). */
export async function listConversations(options) {
    const root = resolve(options.vaultRoot);
    const conversationsDir = resolve(root, "collaboration", "conversations");
    assertInside(root, conversationsDir);
    let entries;
    try {
        entries = await readdir(conversationsDir, { withFileTypes: true });
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const conversations = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("."))
            continue;
        const absolutePath = join(conversationsDir, entry.name, "index.md");
        let content;
        try {
            content = await readFile(absolutePath, "utf8");
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                continue;
            }
            throw error;
        }
        conversations.push(parseConversationManifest(content, relative(root, absolutePath), entry.name, root));
    }
    return conversations.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Read durable Conversation events in strict append order (sequence primary, created/id defensive tiebreak). */
export async function readConversationEvents(options) {
    assertValidConversationId(options.conversationId);
    const root = resolve(options.vaultRoot);
    const eventsDir = resolve(root, "collaboration", "conversations", options.conversationId, "events");
    assertInside(root, eventsDir);
    let entries;
    try {
        entries = await readdir(eventsDir, { withFileTypes: true });
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const events = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md"))
            continue;
        const absolutePath = join(eventsDir, entry.name);
        const content = await readFile(absolutePath, "utf8");
        events.push(parseConversationEvent(content, relative(root, absolutePath), options.conversationId));
    }
    // Sequence is the authoritative durable append order; (created, id) is only
    // a defensive tiebreak for corrupt/hand-written records, never directory
    // enumeration, nonce, or wall-clock order.
    return events.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function requireString(fields, key, path) {
    const value = fields[key];
    if (typeof value !== "string") {
        throw new Error(`Invalid conversation event at ${path}: ${key} is required`);
    }
    return value;
}
function parseConversationEvent(content, path, expectedConversationId) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch === null) {
        throw new Error(`Invalid conversation event at ${path}: missing frontmatter.`);
    }
    let fields;
    try {
        fields = parseYaml(frontmatterMatch[1]);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid conversation event at ${path}: ${detail}`);
    }
    if (fields.type !== "Conversation Event") {
        throw new Error(`Invalid conversation event at ${path}: type must be 'Conversation Event'`);
    }
    if (fields.conversationId !== expectedConversationId) {
        throw new Error(`Invalid conversation event at ${path}: conversationId mismatch`);
    }
    const id = requireString(fields, "id", path);
    const kindValue = fields.kind;
    if (typeof kindValue !== "string" || !CONVERSATION_EVENT_KINDS.includes(kindValue)) {
        throw new Error(`Invalid conversation event at ${path}: invalid kind`);
    }
    const kind = kindValue;
    const authorKindValue = fields.authorKind;
    if (typeof authorKindValue !== "string" || !CONVERSATION_AUTHOR_KINDS.includes(authorKindValue)) {
        throw new Error(`Invalid conversation event at ${path}: invalid authorKind`);
    }
    const authorKind = authorKindValue;
    const author = requireString(fields, "author", path);
    const created = requireString(fields, "created", path);
    const sequenceRaw = fields.sequence;
    if (typeof sequenceRaw !== "number" || !Number.isInteger(sequenceRaw) || sequenceRaw < 1) {
        throw new Error(`Invalid conversation event at ${path}: sequence must be a positive integer`);
    }
    const sequence = sequenceRaw;
    const mentionsRaw = fields.mentions;
    if (mentionsRaw !== undefined && (!Array.isArray(mentionsRaw) || mentionsRaw.some((m) => typeof m !== "string"))) {
        throw new Error(`Invalid conversation event at ${path}: mentions must be an array of strings`);
    }
    const body = content.slice(frontmatterMatch[0].length).replace(/^\n+/, "").replace(/\n+$/, "");
    const record = {
        id,
        conversationId: expectedConversationId,
        kind,
        authorKind,
        author,
        created,
        sequence,
        mentions: mentionsRaw === undefined ? [] : mentionsRaw,
        body,
        path,
    };
    const correlationId = fields.correlationId;
    if (typeof correlationId === "string")
        record.correlationId = correlationId;
    const addressedAgent = fields.addressedAgent;
    if (typeof addressedAgent === "string")
        record.addressedAgent = addressedAgent;
    const runStatus = fields.runStatus;
    if (typeof runStatus === "string" && CONVERSATION_RUN_STATUSES.includes(runStatus)) {
        record.runStatus = runStatus;
    }
    const failureKind = fields.failureKind;
    if (typeof failureKind === "string" && CONVERSATION_RUN_FAILURE_KINDS.includes(failureKind)) {
        record.failureKind = failureKind;
    }
    const contextMetadata = fields.contextMetadata;
    if (typeof contextMetadata === "string") {
        try {
            const parsed = JSON.parse(contextMetadata);
            if (typeof parsed === "object" && parsed !== null) {
                record.contextMetadata = parsed;
            }
        }
        catch {
            // Malformed stored metadata is tolerated as absent; the body stays authoritative.
        }
    }
    return record;
}
// The yaml package is a runtime dependency used by both record parsers above.
//# sourceMappingURL=conversations.js.map