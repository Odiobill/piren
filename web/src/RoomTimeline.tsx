import { useEffect, useRef, useState } from "react";
import { fetchRoomEvents, streamRoomEvents, UnauthorizedError } from "./api";
import {
  appendLiveItem,
  frameToTimelineItem,
  initialReconnectBudget,
  replaceHistoricWithEvents,
  streamEnded,
  type ReconnectBudget,
  type RoomEventRecord,
  type TimelineItem,
} from "./timeline";

/**
 * Inspectable immutable room timeline (ADR-0041 R3b-3). Renders the durable
 * historic event sequence, then the live scoped SSE stream, as one immutable
 * chronological display. On room selection and after an unexpected
 * disconnect the whole history is re-read (no replay) and a fresh
 * subscription opens; one automatic reconnect, then an explicit manual
 * Reconnect button. Event content is never edited or appended; malformed
 * frames render as non-authoritative status markers. No render cache, no
 * storage, no client-side delivery/approval/retry truth.
 */
type TimelinePhase =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; items: TimelineItem[]; stream: "connecting" | "live" | "disconnected"; message: string | null };

function eventLabel(event: RoomEventRecord): string {
  switch (event.kind) {
    case "steward_message":
      return `steward${event.addressedAgent !== undefined ? ` → ${event.addressedAgent}` : ""}`;
    case "agent_message":
      return `${event.author}${event.addressedAgent !== undefined ? ` → ${event.addressedAgent}` : ""}`;
    case "run_started":
      return `run started (${event.runStatus ?? "running"})`;
    case "run_finished":
      return `run finished (${event.runStatus ?? "completed"}${event.failureKind !== undefined ? `, ${event.failureKind}` : ""})`;
    case "run_cancelled":
      return "run cancelled";
    default:
      return event.kind;
  }
}

function announcementFor(item: TimelineItem): string {
  if (item.type === "event") return `New room event: ${eventLabel(item.event)}`;
  if (item.type === "approval") return "Approval requested";
  return "Unreadable stream frame (non-authoritative)";
}

export function RoomTimeline({
  roomId,
  token,
  onUnauthorized,
}: {
  roomId: string;
  token: string;
  onUnauthorized: () => void;
}) {
  const [phase, setPhase] = useState<TimelinePhase>({ phase: "loading" });
  const [announcement, setAnnouncement] = useState("");
  const [attemptKey, setAttemptKey] = useState(0);
  const budgetRef = useRef<ReconnectBudget>(initialReconnectBudget());

  // The reconnect budget is scoped to the room-selection/manual-reconnect
  // lifecycle: selecting a room (or a token change) starts a fresh lifecycle.
  // Opening a stream NEVER resets it, so open/end flapping cannot loop.
  useEffect(() => {
    budgetRef.current = initialReconnectBudget();
  }, [roomId, token]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const announce = (item: TimelineItem) => setAnnouncement(announcementFor(item));

    (async () => {
      setPhase((previous) => (previous.phase === "loading" ? previous : { phase: "loading" }));
      try {
        const events = await fetchRoomEvents(roomId, token, controller.signal);
        if (cancelled) return;
        setPhase({ phase: "ready", items: replaceHistoricWithEvents(events), stream: "connecting", message: null });
        await streamRoomEvents(
          roomId,
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
              const item = frameToTimelineItem(frame);
              if (item === null) return;
              setPhase((previous) => {
                if (previous.phase !== "ready") return previous;
                const next = appendLiveItem(previous.items, item);
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
      if (cancelled) return;
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
  }, [roomId, token, onUnauthorized, attemptKey]);

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
          Loading room history…
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
          <TimelineItems items={phase.items} />
        </>
      )}
    </section>
  );
}

function TimelineItems({ items }: { items: TimelineItem[] }) {
  const content = items.filter((item) => item.type !== "error");
  if (content.length === 0) {
    return (
      <>
        <p className="muted">No events yet. This is the empty timeline state: new room events appear here live.</p>
        {items.map((item) => (
          <TimelineEntry key={item.id} item={item} />
        ))}
      </>
    );
  }
  return (
    <ol className="timeline-list">
      {items.map((item) => (
        <TimelineEntry key={item.id} item={item} />
      ))}
    </ol>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  if (item.type === "error") {
    return (
      <li className="timeline-entry timeline-error">
        <span className="timeline-kind">unreadable frame (non-authoritative)</span>
        <span className="timeline-note">{item.message}</span>
      </li>
    );
  }
  if (item.type === "approval") {
    return (
      <li className="timeline-entry timeline-approval">
        <span className="timeline-kind">Approval requested — {item.approval.method}</span>
        <span className="timeline-note">
          {item.approval.agent} · answering arrives in a later gated slice
        </span>
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
