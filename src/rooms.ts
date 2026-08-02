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
  "run_finished",
  "run_cancelled",
] as const;
export type RoomEventKind = (typeof ROOM_EVENT_KINDS)[number];

export const ROOM_AUTHOR_KINDS = ["steward", "agent", "system"] as const;
export type RoomAuthorKind = (typeof ROOM_AUTHOR_KINDS)[number];

export const ROOM_STATUSES = ["open", "closed"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

// Compact-UTC ids carry uppercase T/Z (e.g. 20260802T140000000Z-slug), so
// the kebab check is case-insensitive. Separators and dots stay rejected.
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertValidRoomId(roomId: string): void {
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new Error(`Invalid room id '${roomId}'. Use lowercase kebab-case without path separators.`);
  }
}

function assertValidAgentName(agentName: string): void {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error("Invalid agent name. Use lowercase kebab-case, for example 'piren' or 'research-agent'.");
  }
}

function assertInside(baseDir: string, target: string): void {
  const rel = relative(baseDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path resolves outside vault: ${target}`);
  }
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "room"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Injected final-target seam for the atomic no-clobber create protocol. The
 * production adapter uses a hard link (atomic create-or-fail on POSIX and
 * NFSv4); tests inject barriers/forced collisions to prove race safety.
 */
export interface RoomWriteIo {
  /** Hard-link temp to target; MUST reject when the target already exists. */
  linkNoClobber(tempPath: string, targetPath: string): Promise<void>;
  /** Remove a file, tolerating a missing path. */
  remove(absolutePath: string): Promise<void>;
}

function createNodeRoomWriteIo(): RoomWriteIo {
  return {
    linkNoClobber: (tempPath, targetPath) => link(tempPath, targetPath),
    remove: async (absolutePath) => {
      await rm(absolutePath, { force: true });
    },
  };
}

const NODE_ROOM_WRITE_IO = createNodeRoomWriteIo();

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

/**
 * Atomic final no-clobber create: same-directory unique temp file (wx,
 * 0o600, fsynced), then a hard link to the final target which REJECTS when
 * the target exists. POSIX rename would silently overwrite an existing
 * target; the link step is the fail-closed authority. Temp cleanup is
 * best-effort and never masks the original link error.
 */
async function atomicCreateNoClobber(target: string, content: string, io: RoomWriteIo): Promise<number> {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const bytes = Buffer.byteLength(content);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await io.linkNoClobber(tempPath, target);
  } catch (error) {
    await io.remove(tempPath).catch(() => {});
    throw error;
  }
  await io.remove(tempPath).catch(() => {});
  return bytes;
}

export interface CreateRoomOptions {
  vaultRoot: string;
  title: string;
  participants?: string[];
  now?: () => Date;
  /** Injected final-target seam for deterministic race/collision tests. */
  io?: RoomWriteIo | undefined;
}

export interface RoomRecord {
  id: string;
  path: string;
  title: string;
  createdBy: string;
  participants: string[];
  status: RoomStatus;
  created: string;
  updated: string;
}

export interface CreateRoomResult extends RoomRecord {
  absolutePath: string;
  bytes: number;
}

function renderRoomManifest(options: {
  id: string;
  title: string;
  participants: string[];
  timestamp: string;
}): string {
  const participantLines =
    options.participants.length === 0
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

function parseRoomManifest(content: string, path: string, expectedId: string): RoomRecord {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatterMatch) {
    throw new Error(`Room manifest is missing YAML frontmatter: ${path}`);
  }
  let fields: unknown;
  try {
    fields = parseYaml(frontmatterMatch[1] ?? "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Room manifest has malformed YAML frontmatter: ${path}: ${detail}`);
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Error(`Room manifest frontmatter is not a mapping: ${path}`);
  }
  const record = fields as Record<string, unknown>;

  const fail = (reason: string): never => {
    throw new Error(`Malformed room manifest ${path}: ${reason}`);
  };

  if (record.type !== "Room Manifest") fail(`type must be 'Room Manifest', got ${JSON.stringify(record.type)}`);
  if (typeof record.id !== "string" || !ROOM_ID_PATTERN.test(record.id)) fail("id is missing or invalid");
  if (record.id !== expectedId) {
    fail(`id '${record.id}' does not match the room directory '${expectedId}'`);
  }
  if (typeof record.title !== "string" || record.title.trim() === "") fail("title is missing or empty");
  if (record.created_by !== "steward") fail("created_by must be 'steward'");
  if (!Array.isArray(record.participants) || record.participants.some((p) => typeof p !== "string" || !AGENT_NAME_PATTERN.test(p))) {
    fail("participants must be a list of kebab-case agent names");
  }
  if (record.status !== "open" && record.status !== "closed") fail("status must be 'open' or 'closed'");
  if (typeof record.created !== "string" || record.created === "") fail("created is missing");
  if (typeof record.updated !== "string" || record.updated === "") fail("updated is missing");

  // The guards above prove these types; the never-returning fail() helper
  // does not narrow, so cast explicitly.
  const status = record.status as RoomStatus;
  const createdStamp = record.created as string;
  const updatedStamp = record.updated as string;
  const roomId = record.id as string;
  const title = record.title as string;

  return {
    id: roomId,
    path,
    title,
    createdBy: "steward",
    participants: record.participants as string[],
    status,
    created: createdStamp,
    updated: updatedStamp,
  };
}

export interface ReadRoomOptions {
  vaultRoot: string;
  roomId: string;
}

export async function readRoom(options: ReadRoomOptions): Promise<RoomRecord> {
  assertValidRoomId(options.roomId);
  const root = resolve(options.vaultRoot);
  const absolutePath = resolve(root, "collaboration", "rooms", options.roomId, "index.md");
  assertInside(root, absolutePath);
  const content = await readFile(absolutePath, "utf8");
  return parseRoomManifest(content, relative(root, absolutePath), options.roomId);
}

export interface ListRoomsOptions {
  vaultRoot: string;
}

/**
 * List room manifests under `collaboration/rooms/`, sorted by created then id.
 * A missing collaboration tree yields an empty list (tolerant loader). Only
 * room directories with an `index.md` are read; arbitrary vault paths are
 * never touched. A malformed manifest rejects naming its path.
 */
export async function listRooms(options: ListRoomsOptions): Promise<RoomRecord[]> {
  const root = resolve(options.vaultRoot);
  const roomsDir = resolve(root, "collaboration", "rooms");
  assertInside(root, roomsDir);

  let entries;
  try {
    entries = await readdir(roomsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const rooms: RoomRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const absolutePath = join(roomsDir, entry.name, "index.md");
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
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

function defaultNonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

function assertValidAuthor(authorKind: RoomAuthorKind, author: string): void {
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

/** ADR-0041 first-slice vocabulary: each event kind has exactly one valid author kind. */
const REQUIRED_AUTHOR_KIND: Record<RoomEventKind, RoomAuthorKind> = {
  steward_message: "steward",
  agent_message: "agent",
  run_started: "system",
  run_finished: "system",
  run_cancelled: "system",
};

export const ROOM_RUN_STATUSES = ["running", "completed", "failed", "timed_out", "cancelled"] as const;
export type RoomRunStatus = (typeof ROOM_RUN_STATUSES)[number];

export const ROOM_RUN_FAILURE_KINDS = ["launch_failure", "ambiguous"] as const;
export type RoomRunFailureKind = (typeof ROOM_RUN_FAILURE_KINDS)[number];

export interface AppendRoomEventOptions {
  vaultRoot: string;
  roomId: string;
  kind: RoomEventKind;
  authorKind: RoomAuthorKind;
  author: string;
  body: string;
  correlationId?: string | undefined;
  addressedAgent?: string | undefined;
  /** Bounded run outcome, only on system run_* events (see assertValidRunOutcome). */
  runStatus?: RoomRunStatus | undefined;
  /** Only on run_finished with run_status: failed. */
  failureKind?: RoomRunFailureKind | undefined;
  now?: () => Date;
  nonce?: () => string;
  /** Injected final-target seam for deterministic race/collision tests. */
  io?: RoomWriteIo | undefined;
}

export interface AppendRoomEventResult {
  id: string;
  path: string;
  absolutePath: string;
  roomId: string;
  kind: RoomEventKind;
  created: string;
  bytes: number;
}

function renderRoomEvent(options: {
  id: string;
  roomId: string;
  kind: RoomEventKind;
  authorKind: RoomAuthorKind;
  author: string;
  created: string;
  correlationId?: string | undefined;
  addressedAgent?: string | undefined;
  runStatus?: RoomRunStatus | undefined;
  failureKind?: RoomRunFailureKind | undefined;
  body: string;
}): string {
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
 * ADR-0041 R1b run-outcome contract:
 * - steward_message / agent_message carry no run outcome fields.
 * - run_started requires run_status: running.
 * - run_finished requires exactly one of completed / failed / timed_out;
 *   failure_kind is allowed only for failed and only launch_failure|ambiguous.
 * - run_cancelled requires run_status: cancelled and no failure_kind.
 */
function assertValidRunOutcome(options: AppendRoomEventOptions): void {
  const kind = options.kind;
  if (kind === "steward_message" || kind === "agent_message") {
    if (options.runStatus !== undefined || options.failureKind !== undefined) {
      throw new Error(`${kind} events must not carry run outcome fields.`);
    }
    return;
  }
  if (kind === "run_started") {
    if (options.runStatus !== "running") {
      throw new Error("run_started requires run_status: running.");
    }
    if (options.failureKind !== undefined) {
      throw new Error("run_started must not carry failure_kind.");
    }
    return;
  }
  if (kind === "run_finished") {
    if (options.runStatus !== "completed" && options.runStatus !== "failed" && options.runStatus !== "timed_out") {
      throw new Error("run_finished requires run_status: completed, failed, or timed_out.");
    }
    if (options.failureKind !== undefined) {
      if (options.runStatus !== "failed") {
        throw new Error("failure_kind is only valid when run_status is failed.");
      }
      if (!(ROOM_RUN_FAILURE_KINDS as readonly string[]).includes(options.failureKind)) {
        throw new Error(`Unknown failure_kind '${options.failureKind}'. Use launch_failure or ambiguous.`);
      }
    }
    return;
  }
  // run_cancelled
  if (options.runStatus !== "cancelled") {
    throw new Error("run_cancelled requires run_status: cancelled.");
  }
  if (options.failureKind !== undefined) {
    throw new Error("run_cancelled must not carry failure_kind.");
  }
}

/**
 * Append one immutable event file under `collaboration/rooms/<room-id>/events/`.
 * The room must already exist (its manifest is re-read and validated).
 * Duplicate event ids fail closed: the original evidence is never clobbered.
 * Events are never edited after append; corrections are new events.
 */
export async function appendRoomEvent(options: AppendRoomEventOptions): Promise<AppendRoomEventResult> {
  if (!(ROOM_EVENT_KINDS as readonly string[]).includes(options.kind)) {
    throw new Error(`Unknown room event kind '${options.kind}'. Use one of: ${ROOM_EVENT_KINDS.join(", ")}.`);
  }
  if (!(ROOM_AUTHOR_KINDS as readonly string[]).includes(options.authorKind)) {
    throw new Error(`Unknown room event author_kind '${options.authorKind}'.`);
  }
  const requiredAuthorKind = REQUIRED_AUTHOR_KIND[options.kind];
  if (options.authorKind !== requiredAuthorKind) {
    throw new Error(
      `Room event kind '${options.kind}' requires author_kind '${requiredAuthorKind}', got '${options.authorKind}'.`,
    );
  }
  assertValidAuthor(options.authorKind, options.author);
  assertValidRunOutcome(options);
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

  if (options.correlationId !== undefined) {
    if (options.correlationId === id) {
      throw new Error(`Room event ${id} cannot correlate to itself.`);
    }
    const correlationPath = resolve(root, "collaboration", "rooms", options.roomId, "events", `${options.correlationId}.md`);
    assertInside(root, correlationPath);
    if (!(await pathExists(correlationPath))) {
      throw new Error(
        `correlation_id '${options.correlationId}' does not name an existing event in room '${options.roomId}'.`,
      );
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
  let bytes: number;
  try {
    bytes = await atomicCreateNoClobber(absolutePath, content, options.io ?? NODE_ROOM_WRITE_IO);
  } catch (error) {
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

export async function createRoom(options: CreateRoomOptions): Promise<CreateRoomResult> {
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
  let bytes: number;
  try {
    bytes = await atomicCreateNoClobber(absolutePath, manifest, options.io ?? NODE_ROOM_WRITE_IO);
  } catch (error) {
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
