import { useEffect, useRef, useState } from "react";
import { fetchConversationEvents, streamConversationEvents, UnauthorizedError } from "./api";
import {
  appendConversationLiveItem,
  conversationEventLabel,
  conversationFrameToItem,
  conversationHandoffEventLabel,
  initialReconnectBudget,
  isConversationHandoffEvent,
  replaceConversationHistoric,
  streamEnded,
  type ConversationTimelineItem,
  type ReconnectBudget,
} from "./conversation-timeline";
import { applyConversationActivityFrame, clearConversationActivity, emptyConversationActivity, parseConversationActivityFrame, reconcileConversationActivity, type ConversationActivityState } from "./conversation-activity";
import { captureConversationRunSummary, emptyConversationRunSummaries, type ConversationRunSummary } from "./conversation-summary";
import { ConversationRunSummaries } from "./conversation-summary-disclosure";
import { parseConversationApprovalFrame, type PendingApproval } from "./conversation-controls";
import type { ConversationReaction } from "./conversation-reactions";
import { StopIcon } from "./icons";
import {
  conversationAuthorInitial,
  conversationStatusSymbol,
  groupConversationTranscript,
  type ConversationStatusAttachment,
  type ConversationTranscriptRow,
} from "./conversation-transcript";
import { SafeMarkdownBody } from "./SafeMarkdown";
import type { ConversationEventRecord } from "./conversations";

/**
 * Immutable Conversation timeline (C3-A): durable whole-history reread, then
 * the scoped live SSE stream ONLY after a successful attach (`live=true`).
 * A read-only inspection surface (`live=false`) renders history without any
 * live subscription and without reconnects. Event content is never edited or
 * appended; malformed frames render as non-authoritative status markers; the
 * reconnect budget is one automatic whole-history reread + re-subscription,
 * then an explicit manual Reconnect. No render cache, no storage, no
 * client-side dispatch/approval/retry truth.
 */
type TimelinePhase =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      items: ConversationTimelineItem[];
      stream: "connecting" | "live" | "disconnected" | "inspection" | "draft";
      message: string | null;
    };

function announcementFor(item: ConversationTimelineItem): string {
  if (item.type === "event") return `New conversation event: ${conversationEventLabel(item.event)}`;
  return "Unreadable stream frame (non-authoritative)";
}

export function ConversationTimeline({
  conversationId,
  token,
  live,
  onUnauthorized,
  onLifecycleTransition,
  onApproval,
  onAbortRun,
  abortState,
  draft,
  onAppend,
  onHistoryLoaded,
}: {
  conversationId: string;
  token: string;
  live: boolean;
  onUnauthorized: () => void;
  /** L3: fresh navigator re-gate request, exactly once per received lifecycle event. */
  onLifecycleTransition?: (event: ConversationEventRecord) => void;
  /** C3-C3: forward a scoped live approval frame for the selected conversation. */
  onApproval?: (approval: PendingApproval) => void;
  /**
   * P5: transient-run abort — the existing abort request for the broker-
   * provided active agent ONLY (never an audience guess). Absent on
   * read-only inspection.
   */
  onAbortRun?: (agent: string) => void;
  /** P5: current abort control state (busy/error for the active agent). */
  abortState?:
    | { phase: "idle" }
    | { phase: "busy"; agent: string }
    | { phase: "error"; agent: string; error: { message: string } };
  /**
   * P6: the browser-local empty draft renders the SAME surface component
   * path with zero history: no fetch, no stream, no durable state until the
   * first accepted send creates the record.
   */
  draft?: boolean;
  /**
   * P6: called after a durable item or permissible transient activity
   * appended at the bottom (anchor decision is applied by the surface).
   */
  onAppend?: () => void;
  /**
   * P6: called once after the initial whole-history read renders (default
   * anchor at the bottom near the docked composer).
   */
  onHistoryLoaded?: () => void;
}) {
  const [phase, setPhase] = useState<TimelinePhase>({ phase: "loading" });
  const [announcement, setAnnouncement] = useState("");
  const [attemptKey, setAttemptKey] = useState(0);
  const budgetRef = useRef<ReconnectBudget>(initialReconnectBudget());
  /** U4: transient broker-authoritative activity (working/typing + partial). */
  const [activity, setActivity] = useState<ConversationActivityState>(emptyConversationActivity);
  /**
   * P8 (§4): collapsed bounded in-memory run summaries for the CURRENT
   * selected conversation only — captured at the durable terminal from
   * already-received U4 partial text + terminal truth; never durable,
   * stored, or reconstructed from history; cleared wherever activity clears.
   */
  const [runSummaries, setRunSummaries] = useState<ConversationRunSummary[]>(emptyConversationRunSummaries);

  // The reconnect budget is scoped to the selection lifecycle: selecting a
  // conversation (or a token change) starts a fresh lifecycle. Opening a
  // stream NEVER resets it, so open/end flapping cannot loop.
  useEffect(() => {
    budgetRef.current = initialReconnectBudget();
  }, [conversationId, token]);

  // P8 (§5): the retained run summary participates in the commit-time
  // content-version anchor behavior — updates and clears (and the initial
  // mount no-op) notify the surface so the anchored reader stays at the
  // newest content immediately above the dock.
  useEffect(() => {
    onAppend?.();
  }, [runSummaries]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const announce = (item: ConversationTimelineItem) => setAnnouncement(announcementFor(item));

    (async () => {
      // P6: the browser-local empty draft is the SAME surface component path
      // with zero history — no fetch, no stream, no durable state until the
      // first accepted send creates the record.
      if (draft) {
        setPhase({ phase: "ready", items: [], stream: "draft", message: null });
        return;
      }
      // U4: transient activity/partial replies are cleared before EVERY
      // whole-history reread (fresh attempt, reconnect, or selection change).
      // P8 (§4): the in-memory run summaries are session-scoped display state
      // and are discarded on the same lifecycle paths — never reconstructed.
      setActivity(emptyConversationActivity());
      setRunSummaries([]);
      setPhase((previous) => (previous.phase === "loading" ? previous : { phase: "loading" }));
      try {
        const events = await fetchConversationEvents(conversationId, token, controller.signal);
        if (cancelled) return;
        if (!live) {
          // Read-only inspection: whole-history reread with NO live stream.
          setPhase({
            phase: "ready",
            items: replaceConversationHistoric(events),
            stream: "inspection",
            message: "Read-only inspection — no live stream.",
          });
          onHistoryLoaded?.();
          return;
        }
        setPhase({ phase: "ready", items: replaceConversationHistoric(events), stream: "connecting", message: null });
        onHistoryLoaded?.();
        await streamConversationEvents(
          conversationId,
          token,
          {
            onOpen: () => {
              if (cancelled) return;
              setPhase((previous) =>
                previous.phase === "ready" ? { ...previous, stream: "live", message: null } : previous,
              );
            },
            onFrame: (frame) => {
              if (cancelled) return;
              // U4: a scoped broker-authoritative activity frame updates the
              // transient surface. FAIL CLOSED: malformed JSON, parser
              // rejection (including foreign conversations), or an in-state
              // contradiction CLEARS transient activity — it is never left
              // visible.
              if (frame.event === "conversation_activity") {
                let parsed: ReturnType<typeof parseConversationActivityFrame>;
                try {
                  parsed = parseConversationActivityFrame(JSON.parse(frame.data), conversationId);
                } catch {
                  parsed = { ok: false, reason: "malformed frame" };
                }
                setActivity((previous) =>
                  parsed.ok ? applyConversationActivityFrame(previous, parsed.frame) : clearConversationActivity(previous),
                );
                // P6: permissible transient activity appends participate in the
                // bottom-anchor decision like durable items.
                onAppend?.();
                return;
              }
              // C3-C3: a scoped live `approval` frame is forwarded to the
              // navigator's card surface and NEVER becomes a durable timeline
              // entry. A malformed frame is ignored (no card, no crash, no
              // fabricated approval state).
              if (frame.event === "approval") {
                try {
                  onApproval?.(parseConversationApprovalFrame(JSON.parse(frame.data)));
                } catch {
                  // non-authoritative; ignored
                }
                return;
              }
              const item = conversationFrameToItem(frame);
              if (item === null) return;
              // U4: reconcile transient activity with DURABLE evidence
              // (agent_message replaces the partial; runAgent terminals clear
              // it). History rereads already cleared activity.
              if (item.type === "event") {
                // P8 (§4): capture the bounded in-memory run summary at the
                // durable terminal BEFORE the reconcile clears the run — the
                // exact broker agent, the already-permitted U4 partial text
                // (if still displayed), and the truthful terminal state.
                if (
                  (item.event.kind === "run_finished" || item.event.kind === "run_cancelled") &&
                  typeof item.event.runAgent === "string" &&
                  item.event.runAgent !== ""
                ) {
                  setRunSummaries((previous) => captureConversationRunSummary(previous, activity, item.event));
                }
                setActivity((previous) => reconcileConversationActivity(previous, item.event));
              }
              // L3: a durable lifecycle_transition for this selected
              // conversation requests the navigator's fresh re-gate exactly
              // once per received event (archive from another client ends
              // inspection-only only after the fresh attach result; reopen
              // still relies on the attach gate). Read-only timelines never
              // subscribe, so this path only runs while live.
              if (item.type === "event" && item.event.kind === "lifecycle_transition") {
                onLifecycleTransition?.(item.event);
              }
              setPhase((previous) => {
                if (previous.phase !== "ready") return previous;
                const next = appendConversationLiveItem(previous.items, item);
                if (next !== previous.items) announce(item);
                return { ...previous, items: next };
              });
              // P6: a durable item appended at the bottom participates in the
              // bottom-anchor decision (no forced jump for an upward reader).
              onAppend?.();
            },
          },
          controller.signal,
        );
        if (cancelled) return;
        // The stream ended without an abort: disconnect and reconnect via a
        // fresh whole-history reread + re-subscription (no replay). Transient
        // activity is cleared on stream end; the P8 in-memory summaries are
        // discarded on the same path (never reconstructed).
        setActivity(emptyConversationActivity());
        setRunSummaries([]);
        setPhase((previous) =>
          previous.phase === "ready"
            ? { ...previous, stream: "disconnected", message: "Live stream ended. Showing last known history." }
            : previous,
        );
        scheduleReconnect();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        setActivity(emptyConversationActivity());
        setRunSummaries([]);
        setPhase((previous) => {
          if (previous.phase === "ready") {
            return { ...previous, stream: "disconnected", message: error instanceof Error ? error.message : String(error) };
          }
          return { phase: "error", message: error instanceof Error ? error.message : String(error) };
        });
        scheduleReconnect();
      }
    })();

    function scheduleReconnect() {
      if (cancelled || !live) return;
      const decision = streamEnded(budgetRef.current);
      budgetRef.current = decision.budget;
      if (decision.action === "auto-reconnect") {
        setAttemptKey((key) => key + 1);
      }
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationId, token, live, onUnauthorized, onLifecycleTransition, attemptKey]);

  function handleReconnect() {
    budgetRef.current = initialReconnectBudget();
    setPhase({ phase: "loading" });
    setAttemptKey((key) => key + 1);
  }

  return (
    <section className="timeline" aria-label="Conversation history">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {phase.phase === "loading" && (
        <p className="muted" role="status">
          Loading conversation history…
        </p>
      )}
      {phase.phase === "error" && (
        <div role="alert">
          <p className="error-message">
            Timeline unavailable: <code>{phase.message}</code>
          </p>
          <button type="button" className="button" onClick={handleReconnect}>
            Retry
          </button>
        </div>
      )}
      {phase.phase === "ready" && (
        <>
          {/* P1: the healthy live/connecting states render no routine status
              label; only truthful non-routine states stay visible. */}
          {phase.stream === "inspection" && (
            <p className="timeline-status timeline-status-inspection">Read-only inspection — history only</p>
          )}
          {phase.stream === "disconnected" && (
            <p className="timeline-status timeline-status-disconnected">
              Disconnected — showing last known history.{" "}
              <button type="button" className="button button-small" onClick={handleReconnect}>
                Reconnect
              </button>
            </p>
          )}
          {phase.message !== null && phase.stream === "disconnected" && <p className="muted">{phase.message}</p>}
          {phase.stream === "draft" && (
            <p className="timeline-status timeline-status-draft">
              Draft — your first message creates this conversation.
            </p>
          )}
          {/* P8 (§3): durable transcript items first (chronological), then the
              bounded in-memory run summaries, then the transient activity
              panel at the chronological bottom immediately above the dock. */}
          <ConversationTimelineItems items={phase.items} draft={draft === true} />
          <ConversationRunSummaries summaries={runSummaries} />
          <ConversationActivityDisplay
            activity={activity}
            {...(onAbortRun !== undefined ? { onAbortRun } : {})}
            {...(abortState !== undefined ? { abortState } : {})}
          />
        </>
      )}
    </section>
  );
}

/**
 * U4: truthful transient activity surface — `<agent> is working…` only after
 * a durable run_started-backed working frame, `<agent> is typing…` only after
 * a real text delta, and a clearly TRANSIENT bounded partial reply that is
 * replaced by the correlated durable agent_message. Never a read/seen/claim.
 */
/**
 * P5 — transient U4 activity-only temporary run panel (replaces the static
 * audience-derived Active run section: membership is not active-run
 * authority). It appears ONLY for a valid current broker `conversation_activity`
 * working/text_delta frame, identifies the exact broker-provided agent, shows
 * the real streamed partial text, and clears on the existing settled/
 * terminal/reconnect/history/selection/malformed-frame cleanup. Its abort
 * control is an accessible labelled inline SVG icon that sends the existing
 * abort request for the CURRENT transient agent only. Never an audience guess
 * or history reconstruction; no private reasoning.
 */
function ConversationActivityDisplay({
  activity,
  onAbortRun,
  abortState,
}: {
  activity: ConversationActivityState;
  onAbortRun?: (agent: string) => void;
  abortState?:
    | { phase: "idle" }
    | { phase: "busy"; agent: string }
    | { phase: "error"; agent: string; error: { message: string } };
}) {
  if (activity.runs.length === 0) return null;
  return (
    <div className="transient-run-panel" aria-live="polite" aria-label="Active run">
      {activity.runs.map((run) => {
        const aborting = abortState?.phase === "busy" && abortState.agent === run.agent;
        const failed = abortState?.phase === "error" && abortState.agent === run.agent;
        return (
          <div key={run.runId} className={`transient-run transient-${run.phase}`}>
            <span className="transient-run-agent">{run.agent}</span>
            <span className="transient-run-state">
              {run.phase === "working" ? "is working…" : "is typing…"}
            </span>
            {run.phase === "typing" && run.partial !== "" && (
              <span className="transient-run-partial">
                {run.partial}
                {run.truncated && <span className="transient-run-truncated"> …</span>}
              </span>
            )}
            {onAbortRun !== undefined && (
              <button
                type="button"
                className="transient-run-abort"
                aria-label={`Abort ${run.agent} run`}
                title={`Abort ${run.agent} run`}
                disabled={aborting}
                onClick={() => onAbortRun(run.agent)}
              >
                <StopIcon size={14} />
              </button>
            )}
            {failed && (
              <p className="transient-run-error" role="alert">
                {abortState?.phase === "error" ? abortState.error.message : ""}
              </p>
            )}
            <p className="transient-run-note">Transient — only durable events are saved.</p>
          </div>
        );
      })}
    </div>
  );
}

function ConversationTimelineItems({ items, draft }: { items: ConversationTimelineItem[]; draft?: boolean }) {
  // P3: the pure durable grouping decides message rows (with their fixed
  // requester status clusters) versus compact evidence/attention rows.
  const rows = groupConversationTranscript(items);
  const content = rows.filter((row) => row.type !== "error");
  if (content.length === 0) {
    // P6: the browser-local draft has zero history — it renders the same
    // component path with no placeholder claiming live appends will arrive.
    if (draft) {
      return null;
    }
    return (
      <>
        <p className="muted">No events yet. New conversation events appear here live after attach.</p>
        {rows.map((row) => (
          <ConversationTranscriptRow key={transcriptRowId(row)} row={row} />
        ))}
      </>
    );
  }
  return (
    <ol className="transcript-list">
      {rows.map((row) => (
        <ConversationTranscriptRow key={transcriptRowId(row)} row={row} />
      ))}
    </ol>
  );
}

function transcriptRowId(row: ConversationTranscriptRow): string {
  if (row.type === "error") return row.id;
  return row.event.id;
}

/**
 * P3 — one transcript row. Steward/ordinary agent messages are compact chat
 * rows; a C5 handoff agent_message stays an explicit labeled evidence/system
 * row (never an ordinary authored reply); ineligible run/system evidence
 * fails safe to a compact attention row; error frames stay non-authoritative
 * diagnostics. Bodies are literal text — no Markdown/HTML/link rendering.
 */
function ConversationTranscriptRow({ row }: { row: ConversationTranscriptRow }) {
  if (row.type === "error") {
    return (
      <li className="transcript-row transcript-error">
        <span className="transcript-kind">unreadable frame (non-authoritative)</span>
        <span className="transcript-note">{row.message}</span>
      </li>
    );
  }
  if (row.type === "evidence") {
    return (
      <li className={`transcript-row transcript-evidence transcript-${row.event.kind}`}>
        <span className="transcript-kind">{conversationEventLabel(row.event)}</span>
        {row.reaction !== null && <StatusClusterItem reaction={row.reaction} />}
        <time className="transcript-time" dateTime={row.event.created}>
          {row.event.created}
        </time>
        {row.event.body !== "" && <p className="transcript-body">{row.event.body}</p>}
      </li>
    );
  }
  const { event, statuses } = row;
  // C5 handoff: the durable handoff label is the evidence identity; the row
  // remains a compact system row but is still a requester for its own child
  // run when the child correlates to this durable handoff event.
  if (isConversationHandoffEvent(event)) {
    return (
      <li className="transcript-row transcript-handoff">
        <span className="transcript-kind">{conversationHandoffEventLabel(event)}</span>
        <time className="transcript-time" dateTime={event.created}>
          {event.created}
        </time>
        <p className="transcript-body">{event.body}</p>
        {statuses.length > 0 && <StatusCluster statuses={statuses} />}
      </li>
    );
  }
  const steward = event.kind === "steward_message";
  return (
    <li className={`transcript-row transcript-message ${steward ? "transcript-steward" : "transcript-agent"}`}>
      <div className="transcript-message-header">
        {!steward && (
          <span className="transcript-initial" aria-hidden="true">
            {conversationAuthorInitial(event.author)}
          </span>
        )}
        <span className="transcript-author">{steward ? "You" : event.author}</span>
        <time className="transcript-time" dateTime={event.created}>
          {event.created}
        </time>
      </div>
      {/* P4: ordinary agent bodies render the safe bounded Markdown subset;
          steward bodies stay literal (handoff evidence rows above are literal
          too, preserving their explicit evidence identity). */}
      {steward ? <p className="transcript-body">{event.body}</p> : <SafeMarkdownBody text={event.body} />}
      {statuses.length > 0 && <StatusCluster statuses={statuses} />}
    </li>
  );
}

/**
 * P3 — fixed non-interactive status cluster on a requester row. Each item
 * exposes the exact U5 durable label via aria-label/title; symbols are
 * presentation only (never buttons, pickers, or agent tools) and never a
 * read/seen/delivery claim.
 */
function StatusCluster({ statuses }: { statuses: ConversationStatusAttachment[] }) {
  return (
    <span className="status-cluster" role="group" aria-label="Run status">
      {statuses.map((attachment) => (
        <StatusClusterItem key={attachment.eventId} reaction={attachment.reaction} />
      ))}
    </span>
  );
}

function StatusClusterItem({ reaction }: { reaction: ConversationReaction }) {
  return (
    <span
      className={`status-cluster-item status-cluster-${reaction.kind}`}
      aria-label={reaction.label}
      title={reaction.label}
    >
      {conversationStatusSymbol(reaction.kind)}
    </span>
  );
}
