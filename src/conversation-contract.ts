/**
 * C1 — pure Conversation/mention contract core (ADR-0042, Conversation-Native
 * Workbench Architecture Design §4-§8/§11-§13).
 *
 * This module is a pure, directly unit-testable contract core. It has NO
 * filesystem, network, Pi, gateway, browser, config, or vault dependency:
 * every input is injected by the caller (mention text, the local runnable-agent
 * set, durable membership, transcript items, budget policy). It never reads
 * room/vault records and never assembles Pi prompts.
 *
 * Implemented surface:
 *  - `scanStewardMentions`: deterministic `@<lowercase-kebab-agent>` scanner.
 *  - `resolveRecipients` / `resolveStewardMentions`: atomic resolution of
 *    recognized mentions against an injected local runnable-agent set.
 *  - `applyMembershipChange`: additive membership; steward-only growth with
 *    explicit provenance; agent-originated addresses are a byte-for-byte no-op.
 *  - `transitionLifecycle`: draft -> open -> archived lifecycle transitions.
 *  - `validateTranscriptBudget` / `selectDurableTranscript`: injected-only
 *    whole-item bounded durable-transcript replay with explicit truncation
 *    metadata. No default budget exists anywhere in this module.
 *  - `checkActiveGate` / `canOpenActive` / `isActionPermitted` and friends:
 *    open/switch/attach-as-active gate (every durable member locally runnable)
 *    versus always-read-only inspect/read-history.
 *
 * Grammar (canonical, server-authoritative; deliberately minimal, no Markdown
 * renderer): a steward mention is `@` followed by a lowercase-kebab agent name
 * (`^[a-z][a-z0-9-]*$`, the existing Piren agent-name pattern), recognized ONLY
 * at a token boundary (start of text, or preceded by a character that is not a
 * Unicode letter or number). Mentions inside inline code spans, fenced code blocks,
 * and quoted (blockquote) lines are never recognized. A doubled `@@` is an
 * escaped literal `@` at any position and never a mention. After a boundary
 * `@`, the scanner consumes the maximal run of `[A-Za-z0-9_-]`; if the full
 * token does not match the agent-name pattern, the `@` is ordinary text.
 *
 * Documented deterministic scanner regions:
 *  - Inline code spans are backtick runs; a run of length L opens a span, and
 *    only a later run of exactly L closes it (a run of a different length
 *    inside an open span is content). An unterminated span makes the rest of
 *    the text code (fail-safe). An open span takes precedence over quote/fence
 *    line classification.
 *  - Fenced code blocks open on a line with at most 3 leading spaces followed
 *    by a run of >=3 backticks or >=3 tildes (optional info string ignored),
 *    and close on a line with at most 3 leading spaces, the same fence
 *    character repeated at least the opening run length, then only whitespace.
 *    Indented-code blocks (4-space) are NOT a code region in this grammar.
 *  - Blockquote lines start with at most 3 leading spaces then `>`; the whole
 *    line is quoted text and never opens/closes fences (documented
 *    simplification: fence markers inside quote lines are not interpreted).
 *  - CRLF and legacy CR line endings are normalized to LF before region
 *    recognition, so line-oriented fence and quote behavior is deterministic.
 */

/** The lowercase-kebab agent-name pattern (mirrors the Piren agent pattern). */
export const CONVERSATION_AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Characters the scanner consumes after a boundary `@` before validating. */
const NAME_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Deterministic name-syntax predicate for the mention grammar. */
export function isValidConversationAgentName(name: string): boolean {
  return CONVERSATION_AGENT_NAME_PATTERN.test(name);
}

/** Result of scanning one steward message for mentions. */
export interface MentionScan {
  /** Recognized agent names in first textual mention order (duplicates preserved). */
  readonly mentions: readonly string[];
}

interface FenceState {
  readonly char: string;
  readonly length: number;
}

interface ScanState {
  codeSpanLength: number | null;
}

function isQuoteLine(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function parseFenceOpener(line: string): FenceState | null {
  const stripped = line.replace(/^ {0,3}/, "");
  const match = /^(`{3,}|~{3,})/.exec(stripped);
  if (match === null) return null;
  const run = match[1];
  if (run === undefined) return null;
  return { char: run[0] as string, length: run.length };
}

function isClosingFenceLine(line: string, fence: FenceState): boolean {
  const stripped = line.replace(/^ {0,3}/, "");
  let i = 0;
  while (stripped[i] === fence.char) i += 1;
  if (i < fence.length) return false;
  return /^[ \t]*$/.test(stripped.slice(i));
}

interface AgentToken {
  readonly name: string;
  readonly end: number;
}

/** Consume the maximal run of name-ish chars at `start`; null when invalid. */
function scanAgentToken(line: string, start: number): AgentToken | null {
  let end = start;
  while (end < line.length && NAME_TOKEN_PATTERN.test(line[end] as string)) end += 1;
  const token = line.slice(start, end);
  if (token === "" || !isValidConversationAgentName(token)) return null;
  return { name: token, end };
}

const UNICODE_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/** True when `at` is at the start or follows a non-word Unicode code point. */
function hasMentionBoundary(line: string, at: number): boolean {
  if (at === 0) return true;
  const previous = Array.from(line.slice(0, at)).at(-1);
  return previous === undefined || !UNICODE_LETTER_OR_NUMBER.test(previous);
}

/**
 * Scan one line in text/code-span region. Toggles `state.codeSpanLength` for
 * backtick runs and collects mentions only while not inside a code span.
 * A token boundary is start of text (newline-adjacent) or follows a character
 * that is not a Unicode letter or number.
 */
function scanLine(line: string, state: ScanState, mentions: string[]): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === "`") {
      let run = 1;
      while (line[i + run] === "`") run += 1;
      if (state.codeSpanLength === null) {
        state.codeSpanLength = run;
      } else if (run === state.codeSpanLength) {
        state.codeSpanLength = null;
      }
      i += run;
      continue;
    }
    if (state.codeSpanLength !== null) {
      i += 1;
      continue;
    }
    if (ch === "@") {
      if (line[i + 1] === "@") {
        // Doubled @@ is an escaped literal @ at any position; never a mention.
        i += 2;
        continue;
      }
      if (hasMentionBoundary(line, i)) {
        const token = scanAgentToken(line, i + 1);
        if (token !== null) {
          mentions.push(token.name);
          i = token.end;
          continue;
        }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * Deterministic steward `@<lowercase-kebab-agent>` recognition. See the module
 * header for the exact documented scanner semantics.
 */
export function scanStewardMentions(text: string): MentionScan {
  const mentions: string[] = [];
  const state: ScanState = { codeSpanLength: null };
  let fence: FenceState | null = null;
  const normalizedText = text.replace(/\r\n?/g, "\n");
  for (const line of normalizedText.split("\n")) {
    if (fence !== null) {
      if (isClosingFenceLine(line, fence)) fence = null;
      continue;
    }
    if (state.codeSpanLength !== null) {
      // Open inline span takes precedence over quote/fence line classification.
      scanLine(line, state, mentions);
      continue;
    }
    if (isQuoteLine(line)) continue;
    const opener = parseFenceOpener(line);
    if (opener !== null) {
      fence = opener;
      continue;
    }
    scanLine(line, state, mentions);
  }
  return { mentions };
}

/**
 * Opaque validated steward recipient set. Produced ONLY by the
 * `resolveRecipients`/`resolveStewardMentions` success path; the brand makes
 * provenance explicit so arbitrary string lists cannot masquerade as validated
 * recipients.
 */
export interface ValidatedRecipients {
  /** Brand: only resolution success produces this. */
  readonly __validatedRecipients: true;
  /** Deduplicated recipients in first textual mention order. */
  readonly recipients: readonly string[];
}

/** Deterministic, non-secret result of resolving recognized mentions. */
export type RecipientResolution =
  | { ok: true; validated: ValidatedRecipients }
  | {
      ok: false;
      reason: "unknown-recipient";
      /** Unknown/non-runnable recipients, deduped, first mention order. */
      unknown: readonly string[];
      /** The injected local runnable set (echoed as passed). */
      runnableAgents: readonly string[];
      /** Deterministic non-secret human-readable message. */
      message: string;
    };

/**
 * Resolve recognized steward mentions against the injected local runnable-agent
 * set (already `allowed_agents` minus `excluded_agents`). Any syntactically
 * recognized unknown/non-runnable recipient invalidates the WHOLE result
 * atomically: no partial recipient list is ever exposed. Valid recipients are
 * deduplicated and preserve first textual mention order.
 */
export function resolveRecipients(
  scan: MentionScan,
  runnableAgents: readonly string[],
): RecipientResolution {
  const runnable = new Set(runnableAgents);
  const recipients: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const seenUnknown = new Set<string>();
  for (const name of scan.mentions) {
    if (runnable.has(name)) {
      if (!seen.has(name)) {
        seen.add(name);
        recipients.push(name);
      }
    } else if (!seenUnknown.has(name)) {
      seenUnknown.add(name);
      unknown.push(name);
    }
  }
  if (unknown.length > 0) {
    const runnableList = [...new Set(runnableAgents)].sort();
    const list = runnableList.length > 0 ? runnableList.join(", ") : "none";
    return {
      ok: false,
      reason: "unknown-recipient",
      unknown,
      runnableAgents,
      message: `Unrecognized agent(s): ${unknown.join(", ")}. Local runnable agents: ${list}.`,
    };
  }
  return { ok: true, validated: { __validatedRecipients: true, recipients } };
}

/** One-shot convenience: scan then resolve steward mentions. */
export function resolveStewardMentions(
  text: string,
  runnableAgents: readonly string[],
): RecipientResolution {
  return resolveRecipients(scanStewardMentions(text), runnableAgents);
}

/**
 * Membership change with explicit provenance.
 *  - `steward`: validated steward recipients (from resolution success) — the
 *    only membership-growing act (additive).
 *  - `handoff`: a validated agent-handoff target within an explicitly
 *    steward-approved Conversation workflow (C5, ADR-0042 amendment
 *    2026-08-07) — additive-only, finite, steward-sanctioned exception to
 *    the agent-address neutrality rule.
 *  - `agent`: an agent-originated address — asks a named agent to read/react
 *    within the current run and NEVER alters durable membership.
 */
export type MembershipChange =
  | { kind: "steward"; recipients: ValidatedRecipients }
  | { kind: "handoff"; recipients: ValidatedRecipients }
  | { kind: "agent"; to: string };

/**
 * Additive membership application. Steward and C5-handoff recipients are
 * added after existing members (never removing or reordering them;
 * already-present names are skipped). Agent-originated addresses return the
 * caller's membership array unchanged (same reference, byte-for-byte) and can
 * never grow membership.
 */
export function applyMembershipChange(
  existing: readonly string[],
  change: MembershipChange,
): readonly string[] {
  if (change.kind === "agent") {
    return existing;
  }
  const seen = new Set(existing);
  const next = [...existing];
  for (const name of change.recipients.recipients) {
    if (!seen.has(name)) {
      seen.add(name);
      next.push(name);
    }
  }
  return next;
}

/** Durable conversation lifecycle states (C1: draft has no persistence). */
export type ConversationLifecycleState = "draft" | "open" | "archived";
/** Explicit durable lifecycle transitions. */
export type ConversationLifecycleTransition = "activate" | "archive" | "reopen";

export type LifecycleResult =
  | { ok: true; next: ConversationLifecycleState }
  | { ok: false; reason: string };

const LIFECYCLE_TABLE: Record<
  ConversationLifecycleTransition,
  Partial<Record<ConversationLifecycleState, ConversationLifecycleState>>
> = {
  activate: { draft: "open" },
  archive: { open: "archived" },
  reopen: { archived: "open" },
};

/**
 * Pure lifecycle transition: draft -> open (activation), open -> archived
 * (archive), archived -> open (reopen). Everything else is rejected with a
 * deterministic reason. A draft has no persistence implication in C1.
 */
export function transitionLifecycle(
  current: ConversationLifecycleState,
  transition: ConversationLifecycleTransition,
): LifecycleResult {
  const table = LIFECYCLE_TABLE[transition];
  const next = table === undefined ? undefined : table[current];
  if (next === undefined) {
    return { ok: false, reason: `${transition} is not allowed from ${current}` };
  }
  return { ok: true, next };
}

/** One durable transcript item, supplied by the caller in durable order. */
export interface DurableTranscriptItem {
  id: string;
  text: string;
}

/** Caller-injected budget policy. Both caps are always required; no default. */
export interface TranscriptBudget {
  maxItems: number;
  maxChars: number;
}

/** Validated budget; produced only by `validateTranscriptBudget` success. */
export interface ValidatedTranscriptBudget {
  readonly __validatedBudget: true;
  readonly maxItems: number;
  readonly maxChars: number;
}

export type BudgetValidation =
  | { ok: true; budget: ValidatedTranscriptBudget }
  | { ok: false; reason: string };

/** Fail-closed budget validation: both caps must be positive integers. */
export function validateTranscriptBudget(budget: TranscriptBudget): BudgetValidation {
  if (!Number.isInteger(budget.maxItems) || budget.maxItems < 1) {
    return { ok: false, reason: "maxItems must be a positive integer" };
  }
  if (!Number.isInteger(budget.maxChars) || budget.maxChars < 1) {
    return { ok: false, reason: "maxChars must be a positive integer" };
  }
  return {
    ok: true,
    budget: {
      __validatedBudget: true,
      maxItems: budget.maxItems,
      maxChars: budget.maxChars,
    },
  };
}

/** Explicit truncation/selection metadata, always returned with an ok result. */
export interface TranscriptSelectionMetadata {
  /** True whenever any durable item was excluded (budget hit). */
  truncated: boolean;
  selectedCount: number;
  omittedCount: number;
  /** Total characters of the selected items' text (whole bodies only). */
  selectedChars: number;
  /** Selected item ids in durable chronological order. */
  selectedIds: readonly string[];
  /** Omitted item ids in durable chronological order. */
  omittedIds: readonly string[];
  maxItems: number;
  maxChars: number;
}

export type TranscriptSelection =
  | { ok: true; selected: readonly DurableTranscriptItem[]; metadata: TranscriptSelectionMetadata }
  | { ok: false; reason: "invalid-budget" };

/**
 * Bounded durable-transcript selector.
 *
 * Inputs are caller-supplied durable transcript items in durable chronological
 * order plus an injected budget policy (validated fail-closed here — there is
 * no undocumented/default message or character budget). The selection is the
 * maximal newest contiguous suffix of WHOLE items that fits within both caps,
 * returned in durable chronological order. An item is never skipped to make
 * room for older items, and a body is never sliced: an item that alone exceeds
 * `maxChars` selects nothing, with explicit truncation metadata.
 */
export function selectDurableTranscript(
  items: readonly DurableTranscriptItem[],
  budget: TranscriptBudget,
): TranscriptSelection {
  const validation = validateTranscriptBudget(budget);
  if (!validation.ok) {
    return { ok: false, reason: "invalid-budget" };
  }
  const { maxItems, maxChars } = validation.budget;
  const selected: DurableTranscriptItem[] = [];
  let chars = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as DurableTranscriptItem;
    if (selected.length >= maxItems) break;
    if (chars + item.text.length > maxChars) break;
    selected.push(item);
    chars += item.text.length;
  }
  selected.reverse();
  return {
    ok: true,
    selected,
    metadata: {
      truncated: selected.length < items.length,
      selectedCount: selected.length,
      omittedCount: items.length - selected.length,
      selectedChars: chars,
      selectedIds: selected.map((item) => item.id),
      omittedIds: items.slice(0, items.length - selected.length).map((item) => item.id),
      maxItems,
      maxChars,
    },
  };
}

/** Result of the locally-runnable active-switch gate check. */
export interface ActiveGateResult {
  ok: boolean;
  /** Durable members absent from the injected local runnable set (deduped, durable order). */
  missing: readonly string[];
  /** Durable members that do not match the agent-name pattern (fail closed). */
  malformed: readonly string[];
}

/**
 * Deterministic non-secret rejection message for a failed active attach gate
 * (C3-A). Names the conversation and the durable member problem categories;
 * never echoes local config paths, tokens, or machine details.
 */
export function formatActiveGateRejection(conversationId: string, gate: ActiveGateResult): string {
  const reasons: string[] = [];
  if (gate.missing.length > 0) {
    reasons.push(`durable audience member${gate.missing.length === 1 ? "" : "s"} not locally runnable: ${gate.missing.join(", ")}`);
  }
  if (gate.malformed.length > 0) {
    reasons.push(`malformed durable audience member${gate.malformed.length === 1 ? "" : "s"}: ${gate.malformed.join(", ")}`);
  }
  return `Conversation '${conversationId}' cannot be attached as active (${reasons.join("; ")}). Inspection stays read-only.`;
}

/**
 * Open/switch/attach gate result for the active surface.
 *
 * Active open/switch/attach gate: allowed ONLY when every durable member is in
 * the injected local runnable set. A malformed member fails closed. Empty
 * durable membership is deterministic and openable (a draft has no members).
 *
 * `checkActiveGate`/`canOpenActive` and the exact UI/API action terms
 * (`inspect` vs `open as active`/`attach`/`switch`) follow below.
 */
export function checkActiveGate(
  durableMembers: readonly string[],
  runnableAgents: readonly string[],
): ActiveGateResult {
  const runnable = new Set(runnableAgents);
  const missing: string[] = [];
  const malformed: string[] = [];
  const seenMissing = new Set<string>();
  const seenMalformed = new Set<string>();
  for (const member of durableMembers) {
    if (!isValidConversationAgentName(member)) {
      if (!seenMalformed.has(member)) {
        seenMalformed.add(member);
        malformed.push(member);
      }
    } else if (!runnable.has(member)) {
      if (!seenMissing.has(member)) {
        seenMissing.add(member);
        missing.push(member);
      }
    }
  }
  return { ok: missing.length === 0 && malformed.length === 0, missing, malformed };
}

/** Convenience predicate for the active switch/attach gate. */
export function canOpenActive(
  durableMembers: readonly string[],
  runnableAgents: readonly string[],
): boolean {
  return checkActiveGate(durableMembers, runnableAgents).ok;
}

/** Exact UI/API action terms from the architecture design (§8/§9). */
export type ConversationAction = "inspect" | "read-history" | "open-as-active" | "attach" | "switch";

const ACTIVATING_ACTIONS: ReadonlySet<ConversationAction> = new Set([
  "open-as-active",
  "attach",
  "switch",
]);
const READ_ONLY_ACTIONS: ReadonlySet<ConversationAction> = new Set(["inspect", "read-history"]);

/** `open as active` / `attach` / `switch` — the gated, activating actions. */
export function isActivatingAction(action: ConversationAction): boolean {
  return ACTIVATING_ACTIONS.has(action);
}

/** `inspect` / `read history` — always read-only, never activating. */
export function isReadOnlyInspectionAction(action: ConversationAction): boolean {
  return READ_ONLY_ACTIONS.has(action);
}

/**
 * Deterministic action predicate: read-only inspection is ALWAYS permitted
 * (it never activates the conversation and is never an authorization bypass);
 * activating actions are permitted only when the active gate passes.
 */
export function isActionPermitted(
  action: ConversationAction,
  durableMembers: readonly string[],
  runnableAgents: readonly string[],
): boolean {
  if (isReadOnlyInspectionAction(action)) return true;
  return checkActiveGate(durableMembers, runnableAgents).ok;
}

/** Deterministic first-occurrence dedupe preserving order. */
export function dedupePreservingOrder(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
