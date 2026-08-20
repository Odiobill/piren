/**
 * Context cards / telemetry details popup — pure view-model core
 * (workbench-context-cards-telemetry-details-popup-design §2, §5).
 *
 * Maps the EXISTING T6 parser/state core outputs plus the durable selected
 * Conversation audience to card and popup view models. No fetch, no DOM, no
 * React, no storage: presentation derivation only. Truthfulness rules:
 * every T6 state maps one-to-one (ok incl. truthful 0% /
 * post_compaction_pending / no_window / no_live_session / never-sampled);
 * unknown or unavailable usage NEVER becomes a fabricated zero or percent;
 * the bar is only ever labelled "Context" — never agent energy, health,
 * attention, availability, or progress.
 */

import type { ConversationTelemetryEntry, ConversationTelemetryState } from "./conversation-telemetry.js";

/** The exact truthful states a card/popup can present. */
export type ContextCardStateKey = "ok" | "post_compaction_pending" | "no_window" | "no_live_session" | "not_sampled";

/**
 * Bar model: a real measured percent (INCLUDING a truthful 0) renders a
 * determinate bar; every other state is a neutral indeterminate bar with no
 * numeric value. There is no fabricated zero.
 */
export type ContextCardBar = { kind: "percent"; percent: number } | { kind: "neutral" };

export interface ContextCardViewModel {
  agent: string;
  /** Decorative initial-circle content (first character, uppercased). */
  initial: string;
  stateKey: ContextCardStateKey;
  bar: ContextCardBar;
  /** Compact card-visible state text (for example "30%", "unavailable"). */
  shortText: string;
  /** Full truthful state phrase (progressbar aria-valuetext / state phrase). */
  stateText: string;
  /** The card button's accessible name: agent + state phrase + hint. */
  accessibleName: string;
}

export interface TelemetryPopupField {
  label: string;
  value: string;
}

export interface TelemetryPopupViewModel {
  /** Dialog accessible name source: "Context telemetry for <agent>". */
  title: string;
  closeLabel: string;
  refreshLabel: string;
  stateKey: ContextCardStateKey;
  stateText: string;
  bar: ContextCardBar;
  /** Bounded permitted detail fields only (contract §2.5, T6 §9 choice 10). */
  fields: TelemetryPopupField[];
}

function formatTokenCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * U3 (0.2.0 amendment §6.3): context percentages render with EXACTLY two
 * decimals ("8.74%"); a truthful 0 renders "0.00%". Unknown/unavailable
 * states never reach this formatter — they never fabricate a number.
 */
function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

interface StatePresentation {
  stateKey: ContextCardStateKey;
  bar: ContextCardBar;
  shortText: string;
  stateText: string;
}

/** One-to-one truthful mapping from the T6 entry union; never invents a number. */
function presentEntry(entry: ConversationTelemetryEntry | undefined): StatePresentation {
  if (entry === undefined) {
    return { stateKey: "not_sampled", bar: { kind: "neutral" }, shortText: "not sampled", stateText: "No context telemetry yet" };
  }
  if (entry.kind === "no-live") {
    return { stateKey: "no_live_session", bar: { kind: "neutral" }, shortText: "no live session", stateText: "No live session" };
  }
  const { facts } = entry;
  if (facts.contextState === "ok" && facts.context !== undefined && facts.context.percent !== null) {
    return {
      stateKey: "ok",
      bar: { kind: "percent", percent: facts.context.percent },
      shortText: formatPercent(facts.context.percent),
      stateText: `Context usage: ${formatPercent(facts.context.percent)} of ${formatTokenCount(facts.context.contextWindow)} window`,
    };
  }
  if (facts.contextState === "post_compaction_pending") {
    return {
      stateKey: "post_compaction_pending",
      bar: { kind: "neutral" },
      shortText: "unavailable",
      stateText: "Context usage temporarily unavailable after compaction",
    };
  }
  return {
    stateKey: "no_window",
    bar: { kind: "neutral" },
    shortText: "no window",
    stateText: "No context window information for this session",
  };
}

function contextCardViewModel(agent: string, entry: ConversationTelemetryEntry | undefined): ContextCardViewModel {
  const presentation = presentEntry(entry);
  const initial = agent.length > 0 ? agent.charAt(0).toUpperCase() : "?";
  return {
    agent,
    initial,
    stateKey: presentation.stateKey,
    bar: presentation.bar,
    shortText: presentation.shortText,
    stateText: presentation.stateText,
    accessibleName: `${agent}: ${presentation.stateText}; activate for details`,
  };
}

/**
 * Card membership and stable ordering (contract §2.2): the durable audience
 * in durable order first, then any agent with in-memory telemetry not in the
 * audience in deterministic insertion order. Active selections only —
 * read-only/archived and no-selection views render no cards.
 */
export function contextCardsForSelection(
  selection: { phase: "active"; audience: readonly string[] } | { phase: "read-only" } | { phase: "none" },
  telemetry: ConversationTelemetryState,
): ContextCardViewModel[] {
  if (selection.phase !== "active") return [];
  const agents = [...selection.audience, ...[...telemetry.keys()].filter((agent) => !selection.audience.includes(agent))];
  return agents.map((agent) => contextCardViewModel(agent, telemetry.get(agent)));
}

/**
 * Popup view model for one exact Conversation × agent pair (contract §2.5).
 * Permitted fields ONLY: context tokens/window/percent plus model
 * provider/id, thinking level, and auto-compaction. Session ids/paths, run
 * ids, token totals, cost, transcripts, raw errors/RPC are never present in
 * the bounded entry and never re-derived here.
 */
export function telemetryPopupViewModel(agent: string, entry: ConversationTelemetryEntry | undefined): TelemetryPopupViewModel {
  const presentation = presentEntry(entry);
  // U3 concise popup (amendment §6.3): the bounded field set renders as short
  // labelled lines — agent and truthful state first (always present), then
  // tokens/window/percent, model, thinking, and auto-compaction when present.
  const fields: TelemetryPopupField[] = [
    { label: "Agent", value: agent },
    { label: "State", value: presentation.stateText },
  ];
  if (entry !== undefined && entry.kind === "live") {
    const { facts } = entry;
    if (facts.context !== undefined) {
      if (facts.context.tokens !== null) fields.push({ label: "Context tokens", value: formatTokenCount(facts.context.tokens) });
      fields.push({ label: "Context window", value: formatTokenCount(facts.context.contextWindow) });
      if (facts.context.percent !== null) fields.push({ label: "Context usage", value: formatPercent(facts.context.percent) });
    }
    const provider = facts.model?.provider;
    const id = facts.model?.id;
    if (provider !== undefined || id !== undefined) {
      fields.push({ label: "Model", value: [provider, id].filter((part) => part !== undefined).join("/") });
    }
    if (facts.thinkingLevel !== undefined) fields.push({ label: "Thinking", value: facts.thinkingLevel });
    if (facts.autoCompactionEnabled !== undefined) fields.push({ label: "Auto-compaction", value: facts.autoCompactionEnabled ? "on" : "off" });
  }
  return {
    title: `Context telemetry for ${agent}`,
    closeLabel: `Close context telemetry for ${agent}`,
    refreshLabel: `Refresh context telemetry for ${agent}`,
    stateKey: presentation.stateKey,
    stateText: presentation.stateText,
    bar: presentation.bar,
    fields,
  };
}
