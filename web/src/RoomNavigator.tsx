import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoom, fetchRoom, fetchRoomAgents, fetchRooms, UnauthorizedError } from "./api";
import type { RoomAgentEntry, RoomRecord } from "./rooms";
import { ParticipantPicker } from "./ParticipantPicker";
import { RoomTimeline } from "./RoomTimeline";
import { RoomComposer } from "./RoomComposer";

/**
 * Room navigator (ADR-0041 R3b-2): room list/create/select with the
 * local-policy agent roster. No timeline, composer, dispatch, approval,
 * abort, vault browser, graph, model controls, cache, or service worker.
 * The first protected request with a supplied token validates it; a 401 is
 * surfaced truthfully via onUnauthorized (back to token entry).
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; agents: RoomAgentEntry[]; rooms: RoomRecord[] };

export function RoomNavigator({
  token,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [selectedRoom, setSelectedRoom] = useState<RoomRecord | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const newRoomRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRoomId = useRef<string | null>(null);

  const loadData = useCallback(
    async (signal: AbortSignal) => {
      const [agents, rooms] = await Promise.all([fetchRoomAgents(token, signal), fetchRooms(token, signal)]);
      return { agents: agents.agents, rooms: rooms.rooms };
    },
    [token],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const data = await loadData(controller.signal);
        if (cancelled) return;
        setLoad({ phase: "ready", agents: data.agents, rooms: data.rooms });
        onValidated();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoad({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadData, onUnauthorized, onValidated, retryKey]);

  useEffect(() => {
    if (selectedRoom) {
      detailHeadingRef.current?.focus();
      setAnnouncement(`Room selected: ${selectedRoom.title}`);
    }
  }, [selectedRoom]);

  useEffect(() => {
    if (pendingFocusRoomId.current && newRoomRef.current) {
      newRoomRef.current.focus();
      pendingFocusRoomId.current = null;
    }
  }, [load]);

  function handleRetry() {
    setLoad({ phase: "loading" });
    setRetryKey((k) => k + 1);
  }

  async function handleSelect(roomId: string) {
    try {
      const room = await fetchRoom(roomId, token);
      setSelectedRoom(room);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setAnnouncement(error instanceof Error ? error.message : String(error));
    }
  }

  function handleBack() {
    setSelectedRoom(null);
    setAnnouncement("Back to the room list.");
    listHeadingRef.current?.focus();
  }

  async function handleCreated(room: RoomRecord) {
    setLoad((previous) => {
      if (previous.phase !== "ready") return previous;
      const rooms = [...previous.rooms, room];
      return { phase: "ready", agents: previous.agents, rooms };
    });
    pendingFocusRoomId.current = room.id;
    setAnnouncement(`Room created: ${room.title}`);
  }

  async function handleCreateError(message: string) {
    setAnnouncement(message);
  }

  if (load.phase === "loading") {
    return (
      <section className="card" aria-live="polite">
        <h2>Loading rooms and agents…</h2>
      </section>
    );
  }

  if (load.phase === "error") {
    return (
      <section className="card card-error" role="alert">
        <h2>Could not load rooms</h2>
        <p className="error-message">
          <code>{load.message}</code>
        </p>
        <button type="button" className="button button-primary" onClick={handleRetry}>
          Retry
        </button>
      </section>
    );
  }

  if (selectedRoom) {
    return (
      <section className="card" aria-labelledby="room-detail-heading">
        <button type="button" className="button" onClick={handleBack}>
          ← All rooms
        </button>
        <h2 id="room-detail-heading" tabIndex={-1} ref={detailHeadingRef}>
          {selectedRoom.title}
        </h2>
        <p className="muted">
          <code>{selectedRoom.id}</code> — {selectedRoom.status}
        </p>
        <h3>Participants</h3>
        {selectedRoom.participants.length === 0 ? (
          <p className="muted">No participants.</p>
        ) : (
          <ul className="participant-list">
            {selectedRoom.participants.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        )}
        <p className="muted">Participants are immutable after creation.</p>
        <RoomTimeline roomId={selectedRoom.id} token={token} onUnauthorized={onUnauthorized} />
        <RoomComposer
          roomId={selectedRoom.id}
          participants={selectedRoom.participants}
          token={token}
          onUnauthorized={onUnauthorized}
          onAnnounce={setAnnouncement}
        />
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="rooms-heading">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2 id="rooms-heading" tabIndex={-1} ref={listHeadingRef}>
        Rooms
      </h2>
      {load.rooms.length === 0 ? (
        <p className="muted">No rooms yet. Create the first room below.</p>
      ) : (
        <ul className="room-list">
          {load.rooms.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                className="room-entry"
                ref={pendingFocusRoomId.current === room.id ? newRoomRef : undefined}
                onClick={() => void handleSelect(room.id)}
              >
                <span className="room-title">{room.title}</span>
                <span className="room-meta">
                  {room.status} · {room.participants.length} participant
                  {room.participants.length === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <RoomCreateForm
        agents={load.agents}
        token={token}
        onCreated={(room) => void handleCreated(room)}
        onError={(message) => void handleCreateError(message)}
        onUnauthorized={onUnauthorized}
      />
    </section>
  );
}

function RoomCreateForm({
  agents,
  token,
  onCreated,
  onError,
  onUnauthorized,
}: {
  agents: RoomAgentEntry[];
  token: string;
  onCreated: (room: RoomRecord) => void;
  onError: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  function handleToggle(name: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "") {
      setError("Enter a room title.");
      titleRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const room = await createRoom(token, trimmed, [...selected]);
      setTitle("");
      setSelected(new Set());
      onCreated(room);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="room-create" onSubmit={handleSubmit}>
      <h3>Create a room</h3>
      <label htmlFor="room-title-input">Room title</label>
      <input
        id="room-title-input"
        ref={titleRef}
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Name the room"
        disabled={busy}
      />
      <ParticipantPicker agents={agents} selected={selected} onToggle={handleToggle} disabled={busy} />
      {error && (
        <p className="error-message" role="status">
          {error}
        </p>
      )}
      <button type="submit" className="button button-primary" disabled={busy}>
        Create room
      </button>
    </form>
  );
}
