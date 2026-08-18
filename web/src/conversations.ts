/**
 * C3-A: Conversation surface data types and fail-closed parsers over the
 * accepted C2 `/api/conversations*` family (ADR-0042). Pure and
 * framework-free so the wire contract is directly unit-testable. The
 * browser never scans, resolves, or derives dispatch recipients from
 * `@text` — mentions are server-authoritative; these parsers only decode
 * the durable records the gateway already validated.
 */
export interface ConversationRecord {
  id: string;
  path: string;
  title: string;
  createdBy: string;
  /** Additive durable membership (grows only via validated steward mentions). */
  audience: string[];
  status: string;
  created: string;
  updated: string;
}

export interface ConversationListResponse {
  conversations: ConversationRecord[];
}

/**
 * P2 — sidebar audience summary fit bound (characters): title-cased names
 * render when the joined list fits one sidebar row; longer audiences use the
 * deterministic honest compact fallback.
 */
export const SIDEBAR_AUDIENCE_SUMMARY_FIT_CHARS = 28;

/** Lowercase-kebab agent name → Title Case (`piren-agent` → `Piren Agent`). */
export function conversationMemberTitle(name: string): string {
  return name
    .split("-")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * P2 — deterministic sidebar audience summary from the gateway-authoritative
 * audience (never a client membership derivation; it only formats the durable
 * list): title-cased names when they fit one row, otherwise `First +N`, and
 * only when even that would overflow, the plain member count (`3 members`).
 */
export function conversationAudienceSummary(audience: readonly string[], options?: { fitChars?: number }): string {
  const fitChars = options?.fitChars ?? SIDEBAR_AUDIENCE_SUMMARY_FIT_CHARS;
  if (audience.length === 0) return "No agents yet";
  const names = audience.map(conversationMemberTitle);
  if (audience.length === 1) return names[0] ?? "1 member";
  const joined = names.join(", ");
  if (joined.length <= fitChars) return joined;
  const first = names[0] ?? "";
  const compact = `${first} +${audience.length - 1}`;
  if (compact.length <= fitChars) return compact;
  return `${audience.length} members`;
}

/**
 * Origin-fact timestamp for the sidebar: the durable `created` value rendered
 * as a localized text plus a machine-readable `dateTime`. Returns null when
 * the value is not a valid date so the caller fails quiet — a malformed or
 * unavailable time is never turned into a fabricated date.
 */
export function formatConversationCreatedTimestamp(created: string): { text: string; dateTime: string } | null {
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return null;
  return { text: date.toLocaleString(), dateTime: date.toISOString() };
}

export interface ConversationEventRecord {
  id: string;
  conversationId: string;
  kind: string;
  authorKind: string;
  author: string;
  created: string;
  /** Monotonic durable append order (1-based). */
  sequence: number;
  mentions: string[];
  body: string;
  path: string;
  addressedAgent?: string;
  correlationId?: string;
  runStatus?: string;
  failureKind?: string;
  /** L2 lifecycle-transition target state (additive, optional; fail-closed). */
  lifecycleState?: "open" | "archived";
  /** U4 durable run-agent attribution for run events (additive, optional). */
  runAgent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Fail-closed validation of one conversation record (list/read/create). */
export function parseConversationRecord(json: unknown): ConversationRecord {
  if (!isRecord(json)) throw new Error("unexpected conversation record");
  const record = json as Partial<ConversationRecord>;
  if (
    !isNonEmptyString(record.id) ||
    typeof record.title !== "string" ||
    typeof record.status !== "string" ||
    !Array.isArray(record.audience) ||
    record.audience.some((member) => typeof member !== "string")
  ) {
    throw new Error("unexpected conversation record");
  }
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    audience: record.audience as string[],
    path: typeof record.path === "string" ? record.path : "",
    createdBy: typeof record.createdBy === "string" ? record.createdBy : "",
    created: typeof record.created === "string" ? record.created : "",
    updated: typeof record.updated === "string" ? record.updated : "",
  };
}

/** Fail-closed validation of GET /api/conversations. */
export function parseConversationList(json: unknown): ConversationListResponse {
  if (!isRecord(json) || !Array.isArray(json.conversations)) {
    throw new Error("unexpected /api/conversations response");
  }
  return { conversations: json.conversations.map((entry) => parseConversationRecord(entry)) };
}

/** Fail-closed validation of {conversation: ...} wrappers (read/attach/create). */
export function parseConversationEnvelope(json: unknown): ConversationRecord {
  if (!isRecord(json)) throw new Error("unexpected conversation response");
  return parseConversationRecord(json.conversation);
}

/** Fail-closed validation of GET /api/conversations/<id>/events. */
export function parseConversationEvents(json: unknown): ConversationEventRecord[] {
  if (!isRecord(json) || !Array.isArray(json.events)) {
    throw new Error("unexpected /api/conversations/<id>/events response");
  }
  return json.events.map((entry) => parseConversationEventRecord(entry));
}

export function parseConversationEventRecord(entry: unknown): ConversationEventRecord {
  if (!isRecord(entry)) throw new Error("unexpected conversation event record");
  for (const field of ["id", "conversationId", "kind", "authorKind", "author", "created", "body", "path"] as const) {
    if (!isNonEmptyString(entry[field])) {
      throw new Error(`unexpected conversation event record (${field})`);
    }
  }
  const sequence = entry.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
    throw new Error("unexpected conversation event record (sequence)");
  }
  const mentions = entry.mentions;
  if (mentions !== undefined && (!Array.isArray(mentions) || mentions.some((m) => typeof m !== "string"))) {
    throw new Error("unexpected conversation event record (mentions)");
  }
  const parsed: ConversationEventRecord = {
    id: entry.id as string,
    conversationId: entry.conversationId as string,
    kind: entry.kind as string,
    authorKind: entry.authorKind as string,
    author: entry.author as string,
    created: entry.created as string,
    sequence,
    mentions: mentions === undefined ? [] : (mentions as string[]),
    body: entry.body as string,
    path: entry.path as string,
  };
  // exactOptionalPropertyTypes: assign optional fields only when defined.
  if (typeof entry.addressedAgent === "string") parsed.addressedAgent = entry.addressedAgent;
  if (typeof entry.correlationId === "string") parsed.correlationId = entry.correlationId;
  if (typeof entry.runStatus === "string") parsed.runStatus = entry.runStatus;
  if (typeof entry.failureKind === "string") parsed.failureKind = entry.failureKind;
  // L2 lifecycle metadata: accepted ONLY as open|archived; a present-but-
  // invalid value fails closed (contradictory evidence is never tolerated).
  if (entry.lifecycleState === "open" || entry.lifecycleState === "archived") {
    parsed.lifecycleState = entry.lifecycleState;
  } else if (entry.lifecycleState !== undefined) {
    throw new Error("unexpected conversation event record (lifecycleState)");
  }
  // U4 run-agent attribution: present-but-invalid fails closed; absent stays
  // absent so every existing event keeps parsing.
  if (typeof entry.runAgent === "string" && entry.runAgent !== "") {
    parsed.runAgent = entry.runAgent;
  } else if (entry.runAgent !== undefined) {
    throw new Error("unexpected conversation event record (runAgent)");
  }
  return parsed;
}
