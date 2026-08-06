import { useEffect, useRef, useState } from "react";
import { fetchConversationEvents, streamConversationEvents, UnauthorizedError } from "./api";
import {
  appendConversationLiveItem,
  conversationFrameToItem,
  initialReconnectBudget,
  replaceConversationHistoric,
  streamEnded,
  type ConversationTimelineItem,
  type ReconnectBudget,
} from "./conversation-timeline";
import { lifecycleTransitionLabel } from "./conversation-lifecycle";
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
  | { phase: "ready"; items: ConversationTimelineItem[]; stream: "connecting" | "live" | "disconnected" | "inspection"; message: string | null };

function eventLabel(event: ConversationEventRecord): string {
  switch (event.kind) {
    case "steward_message":
      return "steward message";
    case "agent_message":
      return `${event.author} replied`;
    case "run_started":
      return `run started (${event.runStatus ?? "running"})`;
    case "run_finished":
      return `run finished (${event.runStatus ?? "completed"}${event.failureKind !== undefined ? `, ${event.failureKind}` : ""})`;
    case "run_cancelled":
      return "run cancelled";
    case "model_fallback":
      return "model fallback";
    case "lifecycle_transition":
      return lifecycleTransitionLabel(event.lifecycleState);
    default:
      return event.kind;
  }
}

function announcementFor(item: ConversationTimelineItem): string {
  if (item.type === "event") return `New conversation event: ${eventLabel(item.event)}`;
  return "Unreadable stream frame (non-authoritative)";
}

export function ConversationTimeline({
  conversationId,
  token,
  live,
  onUnauthorized,
  onLifecycleTransition,
}: {
  conversationId: string;
  token: string;
  live: boolean;
  onUnauthorized: () => void;
  /** L3: fresh navigator re-gate request, exactly once per received lifecycle event. */
  onLifecycleTransition?: (event: ConversationEventRecord) => void;
}) {
  const [phase, setPhase] = useState<TimelinePhase>({ phase: "loading" });
  const [announcement, setAnnouncement] = useState("");
  const [attemptKey, setAttemptKey] = useState(0);
  const budgetRef = useRef<ReconnectBudget>(initialReconnectBudget());

  // The reconnect budget is scoped to the selection lifecycle: selecting a
  // conversation (or a token change) starts a fresh lifecycle. Opening a
  // stream NEVER resets it, so open/end flapping cannot loop.
  useEffect(() => {
    budgetRef.current = initialReconnectBudget();
  }, [conversationId, token]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const announce = (item: ConversationTimelineItem) => setAnnouncement(announcementFor(item));

    (async () => {
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
          return;
        }
        setPhase({ phase: "ready", items: replaceConversationHistoric(events), stream: "connecting", message: null });
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
              const item = conversationFrameToItem(frame);
              if (item === null) return;
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
            },
          },
          controller.signal,
        );
        if (cancelled) return;
        // The stream ended without an abort: disconnect and reconnect via a
        // fresh whole-history reread + re-subscription (no replay).
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
    <section className="timeline" aria-labelledby="timeline-heading">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <h3 id="timeline-heading">Timeline</h3>
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
          <p className={`timeline-status timeline-status-${phase.stream}`}>
            {phase.stream === "connecting" && "Connecting to live stream…"}
            {phase.stream === "live" && "Live"}
            {phase.stream === "inspection" && "Read-only inspection — history only"}
            {phase.stream === "disconnected" && (
              <>
                Disconnected — showing last known history.{" "}
                <button type="button" className="button button-small" onClick={handleReconnect}>
                  Reconnect
                </button>
              </>
            )}
          </p>
          {phase.message !== null && phase.stream === "disconnected" && <p className="muted">{phase.message}</p>}
          <ConversationTimelineItems items={phase.items} />
        </>
      )}
    </section>
  );
}

function ConversationTimelineItems({ items }: { items: ConversationTimelineItem[] }) {
  const content = items.filter((item) => item.type !== "error");
  if (content.length === 0) {
    return (
      <>
        <p className="muted">No events yet. New conversation events appear here live after attach.</p>
        {items.map((item) => (
          <ConversationTimelineEntry key={item.id} item={item} />
        ))}
      </>
    );
  }
  return (
    <ol className="timeline-list">
      {items.map((item) => (
        <ConversationTimelineEntry key={item.id} item={item} />
      ))}
    </ol>
  );
}

function ConversationTimelineEntry({ item }: { item: ConversationTimelineItem }) {
  if (item.type === "error") {
    return (
      <li className="timeline-entry timeline-error">
        <span className="timeline-kind">unreadable frame (non-authoritative)</span>
        <span className="timeline-note">{item.message}</span>
      </li>
    );
  }
  const { event } = item;
  return (
    <li className={`timeline-entry timeline-${event.kind}`}>
      <span className="timeline-kind">{eventLabel(event)}</span>
      <time className="timeline-time" dateTime={event.created}>
        {event.created}
      </time>
      <p className="timeline-body">{event.body}</p>
    </li>
  );
}
