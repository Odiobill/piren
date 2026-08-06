import { mkdir, link, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
/**
 * Vault-backed room record core (ADR-0041 R1a).
 *
 * A room lives under `collaboration/rooms/<room-id>/` with a mutable
 * `index.md` manifest, immutable one-file-per-record `events/<event-id>.md`
 * raw evidence, and an explicitly curated `summary.md` (written by later
 * slices, never generated automatically). This module owns only safe record
 * operations: create room, list/read room manifests, and append immutable
 * events. It performs no dispatch, no Pi/session interaction, and no
 * delivery-state mutation.
 *
 * Writes follow the proven Piren convention: same-directory unique temp
 * file (no-clobber "wx"), fsync, then a hard link to the final target that
 * rejects when the target exists — never a rename, which would silently
 * overwrite existing evidence. All paths are validated inside the vault
 * root. Clock, nonce, and the final-target I/O seam are injectable for
 * deterministic tests.
 */
export const ROOM_EVENT_KINDS = [
    "steward_message",
    "run_started",
    "agent_message",
    "model_fallback",
    "run_finished",
    "run_cancelled",
];
export const ROOM_AUTHOR_KINDS = ["steward", "agent", "system"];
export const ROOM_STATUSES = ["open", "closed"];
// Compact-UTC ids carry uppercase T/Z (e.g. 20260802T140000000Z-slug), so
// the kebab check is case-insensitive. Separators and dots stay rejected.
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Single source of truth for a valid lowercase kebab-case agent name. */
export function isValidAgentName(name) {
    return AGENT_NAME_PATTERN.test(name);
}
function assertValidRoomId(roomId) {
    if (!ROOM_ID_PATTERN.test(roomId)) {
        throw new Error(`Invalid room id '${roomId}'. Use lowercase kebab-case without path separators.`);
    }
}
function assertValidAgentName(agentName) {
    if (!AGENT_NAME_PATTERN.test(agentName)) {
        throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
    }
}
function assertInside(baseDir, target) {
    const rel = relative(baseDir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path resolves outside vault: ${target}`);
    }
}
function compactTimestamp(date) {
    return date.toISOString().replace(/[-:.]/g, "");
}
function slug(text) {
    return (text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "room");
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
function createNodeRoomWriteIo() {
    return {
        linkNoClobber: (tempPath, targetPath) => link(tempPath, targetPath),
        remove: async (absolutePath) => {
            await rm(absolutePath, { force: true });
        },
    };
}
const NODE_ROOM_WRITE_IO = createNodeRoomWriteIo();
function isEexist(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
/**
 * Atomic final no-clobber create: same-directory unique temp file (wx,
 * 0o600, fsynced), then a hard link to the final target which REJECTS when
 * the target exists. POSIX rename would silently overwrite an existing
 * target; the link step is the fail-closed authority. Temp cleanup is
 * best-effort and never masks the original link error.
 */
async function atomicCreateNoClobber(target, content, io) {
    const directory = dirname(target);
    await mkdir(directory, { recursive: true });
    const tempPath = resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
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
        await io.linkNoClobber(tempPath, target);
    }
    catch (error) {
        await io.remove(tempPath).catch(() => { });
        throw error;
    }
    await io.remove(tempPath).catch(() => { });
    return bytes;
}
function renderRoomManifest(options) {
    const participantLines = options.participants.length === 0
        ? "participants: []"
        : ["participants:", ...options.participants.map((name) => `  - ${name}`)].join("\n");
    return [
        "---",
        "type: Room Manifest",
        `id: ${options.id}`,
        `title: ${JSON.stringify(options.title)}`,
        "created_by: steward",
        participantLines,
        "status: open",
        `created: ${options.timestamp}`,
        `updated: ${options.timestamp}`,
        "---",
        "",
        `# ${options.title}`,
        "",
        "Room manifest. Events are immutable raw evidence under `events/`;",
        "`summary.md` is a curated promotion artifact written explicitly.",
        "",
    ].join("\n");
}
function parseRoomManifest(content, path, expectedId) {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatterMatch) {
        throw new Error(`Room manifest is missing YAML frontmatter: ${path}`);
    }
    let fields;
    try {
        fields = parseYaml(frontmatterMatch[1] ?? "");
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Room manifest has malformed YAML frontmatter: ${path}: ${detail}`);
    }
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
        throw new Error(`Room manifest frontmatter is not a mapping: ${path}`);
    }
    const record = fields;
    const fail = (reason) => {
        throw new Error(`Malformed room manifest ${path}: ${reason}`);
    };
    if (record.type !== "Room Manifest")
        fail(`type must be 'Room Manifest', got ${JSON.stringify(record.type)}`);
    if (typeof record.id !== "string" || !ROOM_ID_PATTERN.test(record.id))
        fail("id is missing or invalid");
    if (record.id !== expectedId) {
        fail(`id '${record.id}' does not match the room directory '${expectedId}'`);
    }
    if (typeof record.title !== "string" || record.title.trim() === "")
        fail("title is missing or empty");
    if (record.created_by !== "steward")
        fail("created_by must be 'steward'");
    if (!Array.isArray(record.participants) || record.participants.some((p) => typeof p !== "string" || !AGENT_NAME_PATTERN.test(p))) {
        fail("participants must be a list of kebab-case agent names");
    }
    if (record.status !== "open" && record.status !== "closed")
        fail("status must be 'open' or 'closed'");
    if (typeof record.created !== "string" || record.created === "")
        fail("created is missing");
    if (typeof record.updated !== "string" || record.updated === "")
        fail("updated is missing");
    // The guards above prove these types; the never-returning fail() helper
    // does not narrow, so cast explicitly.
    const status = record.status;
    const createdStamp = record.created;
    const updatedStamp = record.updated;
    const roomId = record.id;
    const title = record.title;
    return {
        id: roomId,
        path,
        title,
        createdBy: "steward",
        participants: record.participants,
        status,
        created: createdStamp,
        updated: updatedStamp,
    };
}
export async function readRoom(options) {
    assertValidRoomId(options.roomId);
    const root = resolve(options.vaultRoot);
    const absolutePath = resolve(root, "collaboration", "rooms", options.roomId, "index.md");
    assertInside(root, absolutePath);
    const content = await readFile(absolutePath, "utf8");
    return parseRoomManifest(content, relative(root, absolutePath), options.roomId);
}
/**
 * List room manifests under `collaboration/rooms/`, sorted by created then id.
 * A missing collaboration tree yields an empty list (tolerant loader). Only
 * room directories with an `index.md` are read; arbitrary vault paths are
 * never touched. A malformed manifest rejects naming its path.
 */
export async function listRooms(options) {
    const root = resolve(options.vaultRoot);
    const roomsDir = resolve(root, "collaboration", "rooms");
    assertInside(root, roomsDir);
    let entries;
    try {
        entries = await readdir(roomsDir, { withFileTypes: true });
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const rooms = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("."))
            continue;
        const absolutePath = join(roomsDir, entry.name, "index.md");
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
        rooms.push(parseRoomManifest(content, relative(root, absolutePath), entry.name));
    }
    rooms.sort((left, right) => left.created.localeCompare(right.created) || left.id.localeCompare(right.id));
    return rooms;
}
function defaultNonce() {
    return Math.random().toString(36).slice(2, 10);
}
function assertValidAuthor(authorKind, author) {
    if (authorKind === "steward" && author !== "steward") {
        throw new Error("Room event author must be 'steward' when author_kind is 'steward'.");
    }
    if (authorKind === "system" && author !== "system") {
        throw new Error("Room event author must be 'system' when author_kind is 'system'.");
    }
    if (authorKind === "agent") {
        assertValidAgentName(author);
    }
}
/**
 * Shared addressed_agent grammar (ADR-0041 R2a): permitted on a
 * steward_message (always implicitly non-self) and on a structured
 * agent_message handoff, where it MUST name a valid agent distinct from the
 * author. Every other kind rejects. Returns the validated value.
 */
function validateAddressedAgent(kind, author, addressedAgent) {
    if (kind !== "steward_message" && kind !== "agent_message") {
        throw new Error("addressed_agent is only valid on steward_message or agent_message events.");
    }
    assertValidAgentName(addressedAgent);
    if (kind === "agent_message" && addressedAgent === author) {
        throw new Error("agent_message addressed_agent must differ from the author (no self-handoff).");
    }
    return addressedAgent;
}
/** ADR-0041 first-slice vocabulary: each event kind has exactly one valid author kind. */
const REQUIRED_AUTHOR_KIND = {
    steward_message: "steward",
    agent_message: "agent",
    run_started: "system",
    model_fallback: "system",
    run_finished: "system",
    run_cancelled: "system",
};
export const ROOM_RUN_STATUSES = ["running", "completed", "failed", "timed_out", "cancelled"];
export const ROOM_RUN_FAILURE_KINDS = ["launch_failure", "ambiguous", "provider_error"];
function renderRoomEvent(options) {
    const lines = [
        "---",
        "type: Room Event",
        `id: ${options.id}`,
        `room: ${options.roomId}`,
        `created: ${options.created}`,
        `author_kind: ${options.authorKind}`,
        `author: ${options.author}`,
        `kind: ${options.kind}`,
    ];
    // Optional fields are emitted only when defined; null is never a placeholder.
    if (options.addressedAgent !== undefined) {
        lines.push(`addressed_agent: ${options.addressedAgent}`);
    }
    if (options.correlationId !== undefined) {
        lines.push(`correlation_id: ${options.correlationId}`);
    }
    if (options.runStatus !== undefined) {
        lines.push(`run_status: ${options.runStatus}`);
    }
    if (options.failureKind !== undefined) {
        lines.push(`failure_kind: ${options.failureKind}`);
    }
    lines.push("---", "", options.body, "");
    return lines.join("\n");
}
/**
/**
 * Shared run-outcome grammar (ADR-0041 R1b): message kinds carry no run
 * fields; run_started requires running; run_finished requires
 * completed|failed|timed_out with failure_kind only for failed;
 * run_cancelled requires cancelled and no failure_kind. Returns the
 * narrowed values for record construction.
 */
function validateRunOutcomeFields(kind, runStatus, failureKind) {
    if (kind === "steward_message" || kind === "agent_message" || kind === "model_fallback") {
        if (runStatus !== undefined || failureKind !== undefined) {
            throw new Error(`${kind} events must not carry run outcome fields.`);
        }
        return {};
    }
    if (kind === "run_started") {
        if (runStatus !== "running") {
            throw new Error("run_started requires run_status: running.");
        }
        if (failureKind !== undefined) {
            throw new Error("run_started must not carry failure_kind.");
        }
        return { runStatus: "running" };
    }
    if (kind === "run_finished") {
        if (runStatus !== "completed" && runStatus !== "failed" && runStatus !== "timed_out") {
            throw new Error("run_finished requires run_status: completed, failed, or timed_out.");
        }
        const result = { runStatus };
        if (failureKind !== undefined) {
            if (runStatus !== "failed") {
                throw new Error("failure_kind is only valid when run_status is failed.");
            }
            if (!ROOM_RUN_FAILURE_KINDS.includes(failureKind)) {
                throw new Error(`Unknown failure_kind '${String(failureKind)}'. Use launch_failure, ambiguous, or provider_error.`);
            }
            result.failureKind = failureKind;
        }
        return result;
    }
    // run_cancelled
    if (runStatus !== "cancelled") {
        throw new Error("run_cancelled requires run_status: cancelled.");
    }
    if (failureKind !== undefined) {
        throw new Error("run_cancelled must not carry failure_kind.");
    }
    return { runStatus: "cancelled" };
}
function assertValidRunOutcome(options) {
    validateRunOutcomeFields(options.kind, options.runStatus, options.failureKind);
}
/**
 * Append one immutable event file under `collaboration/rooms/<room-id>/events/`.
 * The room must already exist (its manifest is re-read and validated).
 * Duplicate event ids fail closed: the original evidence is never clobbered.
 * Events are never edited after append; corrections are new events.
 */
export async function appendRoomEvent(options) {
    if (!ROOM_EVENT_KINDS.includes(options.kind)) {
        throw new Error(`Unknown room event kind '${options.kind}'. Use one of: ${ROOM_EVENT_KINDS.join(", ")}.`);
    }
    if (!ROOM_AUTHOR_KINDS.includes(options.authorKind)) {
        throw new Error(`Unknown room event author_kind '${options.authorKind}'.`);
    }
    const requiredAuthorKind = REQUIRED_AUTHOR_KIND[options.kind];
    if (options.authorKind !== requiredAuthorKind) {
        throw new Error(`Room event kind '${options.kind}' requires author_kind '${requiredAuthorKind}', got '${options.authorKind}'.`);
    }
    assertValidAuthor(options.authorKind, options.author);
    assertValidRunOutcome(options);
    if (typeof options.body !== "string" || options.body.trim() === "") {
        throw new Error("Room event body is required.");
    }
    if (options.addressedAgent !== undefined) {
        validateAddressedAgent(options.kind, options.author, options.addressedAgent);
    }
    if (options.correlationId !== undefined && !ROOM_ID_PATTERN.test(options.correlationId)) {
        throw new Error(`Invalid correlation_id '${options.correlationId}'.`);
    }
    // Room must exist with a valid manifest; events never create rooms.
    await readRoom({ vaultRoot: options.vaultRoot, roomId: options.roomId });
    const root = resolve(options.vaultRoot);
    const created = (options.now ?? (() => new Date()))().toISOString();
    const nonce = (options.nonce ?? defaultNonce)();
    const kindSlug = options.kind.replace(/_/g, "-");
    const id = `${compactTimestamp(new Date(created))}-${kindSlug}-${slug(nonce)}`;
    if (!ROOM_ID_PATTERN.test(id)) {
        throw new Error(`Generated room event id is invalid: ${id}`);
    }
    if (options.correlationId !== undefined) {
        if (options.correlationId === id) {
            throw new Error(`Room event ${id} cannot correlate to itself.`);
        }
        const correlationPath = resolve(root, "collaboration", "rooms", options.roomId, "events", `${options.correlationId}.md`);
        assertInside(root, correlationPath);
        if (!(await pathExists(correlationPath))) {
            throw new Error(`correlation_id '${options.correlationId}' does not name an existing event in room '${options.roomId}'.`);
        }
    }
    const absolutePath = resolve(root, "collaboration", "rooms", options.roomId, "events", `${id}.md`);
    assertInside(root, absolutePath);
    const content = renderRoomEvent({
        id,
        roomId: options.roomId,
        kind: options.kind,
        authorKind: options.authorKind,
        author: options.author,
        created,
        correlationId: options.correlationId,
        addressedAgent: options.addressedAgent,
        runStatus: options.runStatus,
        failureKind: options.failureKind,
        body: options.body,
    });
    let bytes;
    try {
        bytes = await atomicCreateNoClobber(absolutePath, content, options.io ?? NODE_ROOM_WRITE_IO);
    }
    catch (error) {
        if (isEexist(error)) {
            throw new Error(`Room event already exists: ${id}. Refusing to clobber existing evidence.`);
        }
        throw error;
    }
    return {
        id,
        path: relative(root, absolutePath),
        absolutePath,
        roomId: options.roomId,
        kind: options.kind,
        created,
        bytes,
    };
}
export async function createRoom(options) {
    const title = typeof options.title === "string" ? options.title.trim() : "";
    if (title === "") {
        throw new Error("Room title is required.");
    }
    const participants = options.participants ?? [];
    for (const participant of participants) {
        assertValidAgentName(participant);
    }
    if (new Set(participants).size !== participants.length) {
        throw new Error("Duplicate room participant.");
    }
    const root = resolve(options.vaultRoot);
    const created = (options.now ?? (() => new Date()))().toISOString();
    const id = `${compactTimestamp(new Date(created))}-${slug(title)}`;
    assertValidRoomId(id);
    const roomDir = resolve(root, "collaboration", "rooms", id);
    assertInside(root, roomDir);
    // Defense-in-depth fast path only: the no-clobber link on index.md below
    // is the fail-closed authority against concurrent creation.
    if (await pathExists(roomDir)) {
        throw new Error(`Room already exists: ${id}. Refusing to overwrite existing room evidence.`);
    }
    await mkdir(join(roomDir, "events"), { recursive: true });
    const manifest = renderRoomManifest({ id, title, participants, timestamp: created });
    const absolutePath = join(roomDir, "index.md");
    let bytes;
    try {
        bytes = await atomicCreateNoClobber(absolutePath, manifest, options.io ?? NODE_ROOM_WRITE_IO);
    }
    catch (error) {
        if (isEexist(error)) {
            throw new Error(`Room already exists: ${id}. Refusing to overwrite existing room evidence.`);
        }
        throw error;
    }
    return {
        id,
        path: relative(root, absolutePath),
        absolutePath,
        title,
        createdBy: "steward",
        participants,
        status: "open",
        created,
        updated: created,
        bytes,
    };
}
/**
 * Parse and validate one immutable room event document against the full
 * R1a/R1b grammar, its own filename identity, and its room. Fail-closed:
 * any malformed or tampered field rejects naming the vault-relative path.
 */
export function parseRoomEvent(content, path, expectedRoomId) {
    const fail = (reason) => {
        throw new Error(`Malformed room event ${path}: ${reason}`);
    };
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch === null) {
        throw new Error(`Malformed room event ${path}: missing YAML frontmatter`);
    }
    let fields;
    try {
        fields = parseYaml(frontmatterMatch[1] ?? "");
    }
    catch (error) {
        fail(`malformed YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
        fail("frontmatter is not a mapping");
    }
    const record = fields;
    if (record.type !== "Room Event")
        fail(`type must be 'Room Event', got ${JSON.stringify(record.type)}`);
    if (typeof record.id !== "string" || !ROOM_ID_PATTERN.test(record.id))
        fail("id is missing or invalid");
    const fileStem = path.replace(/\.md$/, "").split("/").pop() ?? "";
    if (record.id !== fileStem)
        fail(`id '${record.id}' does not match the event filename '${fileStem}'`);
    if (record.room !== expectedRoomId)
        fail(`room must be '${expectedRoomId}'`);
    if (typeof record.created !== "string" || record.created === "")
        fail("created is missing");
    if (typeof record.author_kind !== "string" || !ROOM_AUTHOR_KINDS.includes(record.author_kind)) {
        fail("author_kind is missing or unknown");
    }
    if (typeof record.kind !== "string" || !ROOM_EVENT_KINDS.includes(record.kind)) {
        fail("kind is missing or unknown");
    }
    const kind = record.kind;
    const authorKind = record.author_kind;
    if (REQUIRED_AUTHOR_KIND[kind] !== authorKind) {
        fail(`kind '${kind}' requires author_kind '${REQUIRED_AUTHOR_KIND[kind]}'`);
    }
    if (typeof record.author !== "string")
        fail("author is missing");
    const author = record.author;
    try {
        assertValidAuthor(authorKind, author);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
    let addressedAgent;
    if (record.addressed_agent !== undefined) {
        if (typeof record.addressed_agent !== "string")
            fail("addressed_agent is not a valid agent name");
        try {
            addressedAgent = validateAddressedAgent(kind, author, record.addressed_agent);
        }
        catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
    }
    let correlationId;
    if (record.correlation_id !== undefined) {
        if (typeof record.correlation_id !== "string" || !ROOM_ID_PATTERN.test(record.correlation_id)) {
            fail("correlation_id is invalid");
        }
        correlationId = record.correlation_id;
    }
    let outcome;
    try {
        outcome = validateRunOutcomeFields(kind, record.run_status, record.failure_kind);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        throw error;
    }
    const body = content.slice(frontmatterMatch[0].length).trim();
    if (body === "")
        fail("body is empty");
    const event = {
        id: record.id,
        roomId: expectedRoomId,
        created: record.created,
        authorKind,
        author,
        kind,
        body,
        path,
    };
    // exactOptionalPropertyTypes: assign optional fields only when defined.
    if (addressedAgent !== undefined)
        event.addressedAgent = addressedAgent;
    if (correlationId !== undefined)
        event.correlationId = correlationId;
    if (outcome.runStatus !== undefined)
        event.runStatus = outcome.runStatus;
    if (outcome.failureKind !== undefined)
        event.failureKind = outcome.failureKind;
    return event;
}
/**
 * List validated immutable events for one room in deterministic
 * chronological (created, id) order. The room manifest is re-read and
 * validated first; only `collaboration/rooms/<room-id>/events/*.md` is
 * enumerated (dotfiles and non-Markdown files skipped); every record is
 * validated fail-closed against the event grammar, its filename, and its
 * room. No mutation, no polling, vault-relative paths only.
 */
export async function listRoomEvents(options) {
    // Validates the room id pattern and the manifest before any event access.
    await readRoom({ vaultRoot: options.vaultRoot, roomId: options.roomId });
    const root = resolve(options.vaultRoot);
    const eventsDir = resolve(root, "collaboration", "rooms", options.roomId, "events");
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
        if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md"))
            continue;
        const absolutePath = join(eventsDir, entry.name);
        const content = await readFile(absolutePath, "utf8");
        events.push(parseRoomEvent(content, relative(root, absolutePath), options.roomId));
    }
    // Correlation integrity (same grammar as append): every correlation target
    // must name an existing event in this room, and no event may correlate to
    // itself. Fail closed on the tampered record, naming its path.
    const eventIds = new Set(events.map((event) => event.id));
    for (const event of events) {
        if (event.correlationId === undefined)
            continue;
        if (event.correlationId === event.id) {
            throw new Error(`Malformed room event ${event.path}: event cannot correlate to itself`);
        }
        if (!eventIds.has(event.correlationId)) {
            throw new Error(`Malformed room event ${event.path}: correlation_id '${event.correlationId}' does not name an existing event in this room`);
        }
    }
    events.sort((left, right) => left.created.localeCompare(right.created) || left.id.localeCompare(right.id));
    return events;
}
//# sourceMappingURL=rooms.js.map