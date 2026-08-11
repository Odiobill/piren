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
import { applyMembershipChange, transitionLifecycle } from "./conversation-contract.js";
export const CONVERSATION_STATUSES = ["open", "archived"];
export const CONVERSATION_EVENT_KINDS = [
    "steward_message",
    "run_started",
    "agent_message",
    "model_fallback",
    "run_finished",
    "run_cancelled",
    // L1: additive lifecycle kind (accepted archive/reopen contract §4.5). The
    // kind is additive and backwards-compatible: old events keep parsing, the
    // strict parser recognizes it only on servers that ship it, and the web
    // timeline renders it via its default branch.
    "lifecycle_transition",
    // U2: additive steward-facing rename kind (accepted details/rename
    // contract §Rename input): one immutable event per actual rename carrying
    // previous/new bounded titles. Additive and backwards-compatible like the
    // lifecycle kind.
    "conversation_renamed",
];
export const CONVERSATION_AUTHOR_KINDS = ["steward", "agent", "system"];
export const CONVERSATION_RUN_STATUSES = ["running", "completed", "failed", "timed_out", "cancelled"];
export const CONVERSATION_RUN_FAILURE_KINDS = ["launch_failure", "ambiguous", "provider_error"];
const CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CONVERSATION_TITLE_PREFIX_MAX = 48;
const CONVERSATION_SLUG_MAX = 48;
/** U2: bounded rename title length in UTF-16 code units (contract §Rename input). */
export const CONVERSATION_TITLE_MAX = 120;
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
export function normalizeConversationTitle(raw) {
    const title = raw.trim();
    if (title === "")
        return { ok: false, reason: "empty" };
    for (let index = 0; index < title.length; index += 1) {
        const code = title.charCodeAt(index);
        if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
            return { ok: false, reason: "control-or-newline" };
        }
    }
    if (title.length > CONVERSATION_TITLE_MAX)
        return { ok: false, reason: "too-long" };
    return { ok: true, title };
}
/** Non-secret deterministic message for a rejected rename title (gateway 400). */
export function conversationTitleErrorMessage(reason) {
    if (reason === "empty")
        return "conversation title is required";
    if (reason === "control-or-newline")
        return "conversation title must be a single line without control characters";
    return "conversation title must be at most 120 characters";
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
    // JSON.stringify produces a valid YAML double-quoted scalar and is
    // byte-identical to the historic `title: "..."` rendering for ordinary
    // titles; it keeps quote/backslash titles round-trippable (U2 rename).
    return [
        "---",
        "type: Conversation Manifest",
        `id: ${options.id}`,
        `title: ${JSON.stringify(options.title)}`,
        audienceYaml,
        `status: ${options.status}`,
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
    const manifest = renderConversationManifest({ id, title: conversationTitleFromText(text, new Date(created)), audience, status: "open", timestamp: created });
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
 * Atomic manifest replace shared by every manifest mutation (audience update
 * and lifecycle transitions): a same-directory temp file (no-clobber `wx`),
 * then a POSIX rename over the existing manifest. Never a partial manifest;
 * the file stays inspectable at every step.
 */
async function atomicReplaceManifest(conversationDir, absolutePath, content) {
    const tempPath = resolve(conversationDir, `.manifest-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, absolutePath);
}
/** Vault-visible per-conversation audience coordination lock file. */
const AUDIENCE_LOCK_FILENAME = ".audience.lock";
/**
 * Acquire the per-conversation audience-update lock (vault-visible,
 * no-clobber, cross-process safe): an atomic no-clobber create of
 * `collaboration/conversations/<id>/.audience.lock`. A held/contended lock
 * rejects with a deterministic non-secret conflict — the CALLER surfaces it
 * as 409 BEFORE creating any steward event or dispatch (no false delivery
 * claim). There is NO automatic stale recovery; a crashed holder's lock is
 * recovered manually (see the C2 contract): inspect the lock content, then
 * remove the file after triage. The release removes ONLY our own lock
 * (token-verified) so a manually replaced lock is never deleted by a stale
 * holder. No hidden DB, queue, retry, or fallback.
 *
 * Exported as a test seam (C5-1 lock-failure containment): tests hold the
 * lock to prove a busy audience append is contained.
 */
export async function acquireAudienceLock(options) {
    const root = resolve(options.vaultRoot);
    const conversationDir = resolve(root, "collaboration", "conversations", options.conversationId);
    const lockPath = join(conversationDir, AUDIENCE_LOCK_FILENAME);
    assertInside(root, conversationDir);
    const token = options.token !== undefined
        ? options.token()
        : `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
    const content = JSON.stringify({ token, pid: process.pid, conversationId: options.conversationId, acquiredAt });
    try {
        await atomicCreateNoClobber(lockPath, content, NODE_CONVERSATION_WRITE_IO, options.now ?? (() => new Date()), undefined);
    }
    catch (error) {
        if (isEexist(error)) {
            throw new Error(`Conversation '${options.conversationId}' audience update is busy (another update holds the lock); retry after it completes.`);
        }
        throw error;
    }
    let released = false;
    return {
        release: async () => {
            if (released)
                return;
            released = true;
            try {
                const current = await readFile(lockPath, "utf8");
                // Exact token-verified ownership: parse the lock JSON fail-closed and
                // release ONLY when BOTH the parsed token equals the held token AND
                // the conversationId equals the held conversation id. A malformed,
                // unreadable, replaced, substring-containing, or wrong-conversation
                // lock remains untouched for manual triage.
                let parsed;
                try {
                    parsed = JSON.parse(current);
                }
                catch {
                    return; // malformed lock: left for manual triage
                }
                if (typeof parsed !== "object" || parsed === null)
                    return;
                const record = parsed;
                if (record.token !== token || record.conversationId !== options.conversationId)
                    return;
                await rm(lockPath, { force: true });
            }
            catch {
                // Unreadable/missing lock is left for manual triage; never delete
                // another writer's state.
            }
        },
    };
}
/**
 * C2 additive later-mention membership seam: grow the durable manifest
 * `audience` with validated steward recipients only, preserving existing
 * first-mention order with no removals/reordering (C1 `applyMembershipChange`
 * steward path), preserve the original `created` byte-for-byte, and bump only
 * `updated`.
 *
 * Concurrency safety: the read -> C1 union -> atomic manifest replacement is
 * guarded by the per-conversation vault-visible `.audience.lock` (acquired
 * before any read; released in a `finally`, token-verified). A contended lock
 * rejects with a deterministic non-secret conflict that the gateway surfaces
 * as 409 BEFORE creating the steward event or dispatching, so concurrent
 * additions can never silently lose a member. There is no automatic stale
 * recovery (manual recovery of a crashed holder is documented in the C2
 * contract); no hidden DB, queue, retry, or fallback.
 */
export async function updateConversationAudience(options) {
    assertValidConversationId(options.conversationId);
    const root = resolve(options.vaultRoot);
    const conversationDir = resolve(root, "collaboration", "conversations", options.conversationId);
    const absolutePath = join(conversationDir, "index.md");
    assertInside(root, conversationDir);
    // Cross-process-safe coordination: acquire the vault-visible lock BEFORE any
    // read, hold it through the read -> C1 union -> atomic manifest replacement,
    // and release it in a finally (token-verified). A contended lock rejects
    // with a deterministic non-secret conflict surfaced as 409 by the gateway
    // before any steward event or dispatch.
    const lockOptions = {
        vaultRoot: root,
        conversationId: options.conversationId,
    };
    if (options.now !== undefined)
        lockOptions.now = options.now;
    if (options.lockToken !== undefined)
        lockOptions.token = options.lockToken;
    const lock = await acquireAudienceLock(lockOptions);
    try {
        if (options.holdBarrier !== undefined) {
            await options.holdBarrier;
        }
        const current = await readConversation({ vaultRoot: root, conversationId: options.conversationId });
        const kind = options.kind ?? "steward";
        const membershipChange = kind === "handoff" ? { kind: "handoff", recipients: options.additions } : { kind: "steward", recipients: options.additions };
        const audience = applyMembershipChange(current.audience, membershipChange);
        const updatedStamp = (options.now ?? (() => new Date()))().toISOString();
        const content = renderConversationManifest({
            id: current.id,
            title: current.title,
            audience,
            // L1 status-safe rewrite: every manifest mutation preserves the parsed
            // status, so an audience update never silently reopens an archived
            // conversation (accepted archive/reopen contract §5.2).
            status: current.status,
            timestamp: updatedStamp,
            created: current.created,
        });
        await atomicReplaceManifest(conversationDir, absolutePath, content);
        return readConversation({ vaultRoot: root, conversationId: options.conversationId });
    }
    finally {
        await lock.release();
    }
}
const LIFECYCLE_EVENT_BODY = {
    archive: "Archived by steward.",
    reopen: "Reopened by steward.",
};
export async function transitionConversationLifecycle(options) {
    assertValidConversationId(options.conversationId);
    const root = resolve(options.vaultRoot);
    const conversationDir = resolve(root, "collaboration", "conversations", options.conversationId);
    const absolutePath = join(conversationDir, "index.md");
    assertInside(root, conversationDir);
    // Same per-conversation no-clobber lock as audience updates: every manifest
    // mutation in this slice serializes on it (contract §5.1). A held lock fails
    // closed with a typed lock-busy result before ANY manifest write or event.
    const lockOptions = {
        vaultRoot: root,
        conversationId: options.conversationId,
    };
    if (options.now !== undefined)
        lockOptions.now = options.now;
    if (options.lockToken !== undefined)
        lockOptions.token = options.lockToken;
    let lock;
    try {
        lock = await acquireAudienceLock(lockOptions);
    }
    catch (error) {
        // Only genuine lock CONTENTION is the typed lock-busy boundary. Any other
        // acquisition failure (an absent conversation's ENOENT, permissions, I/O)
        // propagates honestly so the caller can map it (the gateway's
        // conversationError maps ENOENT-coded errors to the contract's 404);
        // misreporting absence as contention would be a false delivery claim.
        if (error instanceof Error && error.message.includes("audience update is busy")) {
            return { ok: false, kind: "lock-busy", conversationId: options.conversationId };
        }
        throw error;
    }
    try {
        if (options.holdBarrier !== undefined) {
            await options.holdBarrier;
        }
        const current = await readConversation({ vaultRoot: root, conversationId: options.conversationId });
        // C1 is the single state machine: with only the two durable states, the
        // only possible rejections for archive/reopen ARE the already-in-target-
        // state repeats (archive from archived, reopen from open), which the
        // selected default turns into the typed idempotent no-op (no write, no
        // event). Any other rejection would be a programming error surfaced as a
        // thrown error (never silently swallowed).
        const result = transitionLifecycle(current.status, options.transition);
        if (!result.ok) {
            const inTargetState = (options.transition === "archive" && current.status === "archived") ||
                (options.transition === "reopen" && current.status === "open");
            if (!inTargetState) {
                throw new Error(`Unexpected conversation lifecycle rejection: ${result.reason}`);
            }
            return { ok: true, transitioned: false, conversation: current };
        }
        // C1's durable outcomes for archive/reopen are exactly archived/open;
        // anything else is a programming error (fail closed, never silently cast).
        if (result.next !== "archived" && result.next !== "open") {
            throw new Error(`Unexpected conversation lifecycle next state: ${result.next}`);
        }
        const newStatus = result.next;
        // Manifest-first: the authoritative state is written before the lifecycle
        // event (contract §4.2); created and audience are preserved byte-for-byte.
        const updatedStamp = (options.now ?? (() => new Date()))().toISOString();
        const content = renderConversationManifest({
            id: current.id,
            title: current.title,
            audience: current.audience,
            status: newStatus,
            timestamp: updatedStamp,
            created: current.created,
        });
        await atomicReplaceManifest(conversationDir, absolutePath, content);
        const transitionedManifest = {
            id: current.id,
            title: current.title,
            audience: current.audience,
            status: newStatus,
            createdBy: current.createdBy,
            created: current.created,
            updated: updatedStamp,
            path: current.path,
            absolutePath: current.absolutePath,
        };
        // Exactly one immutable lifecycle event per actual transition. A failure
        // here NEVER rolls back or auto-repairs the authoritative manifest; it is
        // surfaced as the typed event-append-failed result with the transitioned
        // manifest (contract §4.2/§5).
        try {
            const event = await appendConversationEvent({
                vaultRoot: root,
                conversationId: options.conversationId,
                kind: "lifecycle_transition",
                authorKind: "steward",
                author: "steward",
                body: LIFECYCLE_EVENT_BODY[options.transition],
                lifecycleState: newStatus,
                ...(options.now !== undefined ? { now: options.now } : {}),
                ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
                ...(options.io !== undefined ? { io: options.io } : {}),
            });
            return { ok: true, transitioned: true, conversation: transitionedManifest, event };
        }
        catch {
            return { ok: false, kind: "event-append-failed", conversationId: options.conversationId, conversation: transitionedManifest };
        }
    }
    finally {
        await lock.release();
    }
}
export async function renameConversation(options) {
    assertValidConversationId(options.conversationId);
    const validation = normalizeConversationTitle(options.title);
    if (!validation.ok) {
        return {
            ok: false,
            kind: "invalid-title",
            conversationId: options.conversationId,
            message: conversationTitleErrorMessage(validation.reason),
        };
    }
    const normalizedTitle = validation.title;
    const root = resolve(options.vaultRoot);
    const conversationDir = resolve(root, "collaboration", "conversations", options.conversationId);
    const absolutePath = join(conversationDir, "index.md");
    assertInside(root, conversationDir);
    // Same per-conversation no-clobber transition lock as audience updates and
    // lifecycle transitions: every manifest mutation serializes on it. A held
    // lock fails closed as lock-busy before ANY manifest write or event.
    const lockOptions = {
        vaultRoot: root,
        conversationId: options.conversationId,
    };
    if (options.now !== undefined)
        lockOptions.now = options.now;
    if (options.lockToken !== undefined)
        lockOptions.token = options.lockToken;
    let lock;
    try {
        lock = await acquireAudienceLock(lockOptions);
    }
    catch (error) {
        if (error instanceof Error && error.message.includes("audience update is busy")) {
            return { ok: false, kind: "lock-busy", conversationId: options.conversationId };
        }
        throw error;
    }
    try {
        if (options.holdBarrier !== undefined) {
            await options.holdBarrier;
        }
        const current = await readConversation({ vaultRoot: root, conversationId: options.conversationId });
        // Idempotent no-op: same normalized title -> no write, no timestamp
        // change, no event (a duplicate Save is truthful, never manufactured
        // history).
        if (current.title === normalizedTitle) {
            return { ok: true, renamed: false, conversation: current };
        }
        // Manifest-first: the authoritative title (and updated timestamp) is
        // written before the rename evidence event; every other manifest field
        // is preserved byte-for-byte.
        const updatedStamp = (options.now ?? (() => new Date()))().toISOString();
        const content = renderConversationManifest({
            id: current.id,
            title: normalizedTitle,
            audience: current.audience,
            status: current.status,
            timestamp: updatedStamp,
            created: current.created,
        });
        await atomicReplaceManifest(conversationDir, absolutePath, content);
        const renamedManifest = {
            id: current.id,
            title: normalizedTitle,
            audience: current.audience,
            status: current.status,
            createdBy: current.createdBy,
            created: current.created,
            updated: updatedStamp,
            path: current.path,
            absolutePath: current.absolutePath,
        };
        // Exactly one immutable rename event per actual rename. A failure here
        // NEVER rolls back or auto-repairs the authoritative manifest; it is
        // surfaced as the typed event-append-failed result with the renamed
        // manifest (contract §Rename input 6).
        try {
            const event = await appendConversationEvent({
                vaultRoot: root,
                conversationId: options.conversationId,
                kind: "conversation_renamed",
                authorKind: "steward",
                author: "steward",
                body: `Renamed to: ${normalizedTitle}`,
                previousTitle: current.title,
                title: normalizedTitle,
                ...(options.now !== undefined ? { now: options.now } : {}),
                ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
                ...(options.io !== undefined ? { io: options.io } : {}),
            });
            return {
                ok: true,
                renamed: true,
                conversation: renamedManifest,
                event,
                previousTitle: current.title,
                title: normalizedTitle,
            };
        }
        catch {
            return { ok: false, kind: "event-append-failed", conversationId: options.conversationId, conversation: renamedManifest };
        }
    }
    finally {
        await lock.release();
    }
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
    if (options.lifecycleState !== undefined)
        fields.push(`lifecycleState: ${options.lifecycleState}`);
    // U2 rename evidence: both bounded titles render as YAML-safe quoted
    // scalars so quotes/backslashes in titles round-trip exactly.
    if (options.previousTitle !== undefined)
        fields.push(`previousTitle: ${JSON.stringify(options.previousTitle)}`);
    if (options.title !== undefined)
        fields.push(`title: ${JSON.stringify(options.title)}`);
    // U4 run-agent attribution (plain agent-name scalar).
    if (options.runAgent !== undefined)
        fields.push(`runAgent: ${options.runAgent}`);
    fields.push("---", "", options.body, "");
    return fields.join("\n");
}
function assertValidLifecycleMetadata(lifecycleState) {
    if (lifecycleState !== undefined && lifecycleState !== "open" && lifecycleState !== "archived") {
        throw new Error(`Invalid conversation lifecycleState: '${String(lifecycleState)}'.`);
    }
}
/** U2: rename evidence metadata must be bounded non-empty strings when present. */
function assertValidRenameMetadata(previousTitle, title) {
    if (previousTitle !== undefined && previousTitle.trim() === "") {
        throw new Error("Invalid conversation rename previousTitle: must be a non-empty string.");
    }
    if (title !== undefined && title.trim() === "") {
        throw new Error("Invalid conversation rename title: must be a non-empty string.");
    }
}
/** U4: runAgent must be a non-empty string when present (fail-closed). */
function assertValidRunAgentMetadata(runAgent) {
    if (runAgent !== undefined && runAgent.trim() === "") {
        throw new Error("Invalid conversation runAgent: must be a non-empty string.");
    }
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
    assertValidLifecycleMetadata(options.lifecycleState);
    assertValidRenameMetadata(options.previousTitle, options.title);
    assertValidRunAgentMetadata(options.runAgent);
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
            ...(options.lifecycleState !== undefined ? { lifecycleState: options.lifecycleState } : {}),
            ...(options.previousTitle !== undefined ? { previousTitle: options.previousTitle } : {}),
            ...(options.title !== undefined ? { title: options.title } : {}),
            ...(options.runAgent !== undefined ? { runAgent: options.runAgent } : {}),
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
    // L1 lifecycle metadata: fail-closed on a present-but-invalid value (a
    // lifecycle event carrying an impossible state is contradictory evidence);
    // absent stays absent so every existing event keeps parsing.
    const lifecycleState = fields.lifecycleState;
    if (lifecycleState === "open" || lifecycleState === "archived") {
        record.lifecycleState = lifecycleState;
    }
    else if (lifecycleState !== undefined) {
        throw new Error(`Invalid conversation event at ${path}: lifecycleState must be open or archived`);
    }
    // U2 rename evidence: both bounded titles are optional on the record but
    // fail closed when present-but-invalid (non-string/empty); absent stays
    // absent so every existing event keeps parsing.
    const previousTitle = fields.previousTitle;
    if (typeof previousTitle === "string") {
        if (previousTitle.trim() === "") {
            throw new Error(`Invalid conversation event at ${path}: previousTitle must be a non-empty string`);
        }
        record.previousTitle = previousTitle;
    }
    else if (previousTitle !== undefined) {
        throw new Error(`Invalid conversation event at ${path}: previousTitle must be a string`);
    }
    const eventTitle = fields.title;
    if (typeof eventTitle === "string") {
        if (eventTitle.trim() === "") {
            throw new Error(`Invalid conversation event at ${path}: title must be a non-empty string`);
        }
        record.title = eventTitle;
    }
    else if (eventTitle !== undefined) {
        throw new Error(`Invalid conversation event at ${path}: title must be a string`);
    }
    // U4 run-agent attribution: present-but-invalid fails closed; absent stays
    // absent so every existing event keeps parsing.
    const runAgent = fields.runAgent;
    if (typeof runAgent === "string") {
        if (runAgent.trim() === "") {
            throw new Error(`Invalid conversation event at ${path}: runAgent must be a non-empty string`);
        }
        record.runAgent = runAgent;
    }
    else if (runAgent !== undefined) {
        throw new Error(`Invalid conversation event at ${path}: runAgent must be a string`);
    }
    return record;
}
// The yaml package is a runtime dependency used by both record parsers above.
//# sourceMappingURL=conversations.js.map