import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
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
 * file (no-clobber "wx"), fsync, atomic rename. All paths are validated
 * inside the vault root. Clock and nonce are injectable for deterministic
 * tests.
 */
export const ROOM_EVENT_KINDS = [
    "steward_message",
    "run_started",
    "agent_message",
    "run_finished",
    "run_cancelled",
];
export const ROOM_AUTHOR_KINDS = ["steward", "agent", "system"];
export const ROOM_STATUSES = ["open", "closed"];
// Compact-UTC ids carry uppercase T/Z (e.g. 20260802T140000000Z-slug), so
// the kebab check is case-insensitive. Separators and dots stay rejected.
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
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
async function atomicWriteFile(target, content) {
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
    await rename(tempPath, target);
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
function parseRoomManifest(content, path) {
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
    return parseRoomManifest(content, relative(root, absolutePath));
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
        rooms.push(parseRoomManifest(content, relative(root, absolutePath)));
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
    lines.push("---", "", options.body, "");
    return lines.join("\n");
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
    assertValidAuthor(options.authorKind, options.author);
    if (typeof options.body !== "string" || options.body.trim() === "") {
        throw new Error("Room event body is required.");
    }
    if (options.addressedAgent !== undefined) {
        if (options.kind !== "steward_message") {
            throw new Error("addressed_agent is only valid on steward_message events.");
        }
        assertValidAgentName(options.addressedAgent);
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
    const absolutePath = resolve(root, "collaboration", "rooms", options.roomId, "events", `${id}.md`);
    assertInside(root, absolutePath);
    if (await pathExists(absolutePath)) {
        throw new Error(`Room event already exists: ${id}. Refusing to clobber existing evidence.`);
    }
    const content = renderRoomEvent({
        id,
        roomId: options.roomId,
        kind: options.kind,
        authorKind: options.authorKind,
        author: options.author,
        created,
        correlationId: options.correlationId,
        addressedAgent: options.addressedAgent,
        body: options.body,
    });
    const bytes = await atomicWriteFile(absolutePath, content);
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
    if (await pathExists(roomDir)) {
        throw new Error(`Room already exists: ${id}. Refusing to overwrite existing room evidence.`);
    }
    await mkdir(join(roomDir, "events"), { recursive: true });
    const manifest = renderRoomManifest({ id, title, participants, timestamp: created });
    const absolutePath = join(roomDir, "index.md");
    const bytes = await atomicWriteFile(absolutePath, manifest);
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
//# sourceMappingURL=rooms.js.map