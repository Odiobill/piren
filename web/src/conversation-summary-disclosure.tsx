import { useState, type ReactElement } from "react";
import {
  conversationRunSummaryTerminalLabel,
  type ConversationRunSummary,
} from "./conversation-summary.js";

/**
 * P8 (§4) — collapsed disclosure surface for the bounded in-memory run
 * summaries. Collapsed by default; each button is a truthful disclosure
 * (aria-expanded/aria-controls) labeled "Run summary — <agent>". Expanding
 * reveals the exact agent, the truthful terminal label (derived from the
 * durable terminal), the already-permitted streamed text (if any), and an
 * explicit "Transient — not saved." note. Never private reasoning, provider
 * internals, or fabricated progress; never durable/storage.
 */
export function ConversationRunSummaries({ summaries }: { summaries: readonly ConversationRunSummary[] }): ReactElement | null {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  if (summaries.length === 0) return null;
  return (
    <div className="run-summaries" aria-label="Run summaries">
      {summaries.map((summary) => {
        const open = expandedAgent === summary.agent;
        const panelId = `run-summary-${summary.agent}`;
        return (
          <div key={summary.agent} className="run-summary">
            <button
              type="button"
              className="run-summary-toggle"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`Run summary — ${summary.agent}`}
              onClick={() => setExpandedAgent(open ? null : summary.agent)}
            >
              <span className="run-summary-agent">{summary.agent}</span>
              <span className="run-summary-state">{conversationRunSummaryTerminalLabel(summary)}</span>
            </button>
            {open && (
              <div id={panelId} className="run-summary-body">
                <p className="run-summary-agent-line">
                  <span className="run-summary-agent">{summary.agent}</span>{" "}
                  <span className="run-summary-state">{conversationRunSummaryTerminalLabel(summary)}</span>
                </p>
                {summary.partial !== "" && (
                  <p className="run-summary-partial">
                    {summary.partial}
                    {summary.truncated ? " …" : ""}
                  </p>
                )}
                <p className="run-summary-note">Transient — not saved. Durable events remain authoritative.</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
