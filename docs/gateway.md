# Gateway and web UI

The gateway lets external clients talk to a Piren agent without embedding Pi in-process.

## Process model

```text
client
  -> Piren gateway process
  -> Pi process launched with --mode rpc
  -> Piren extension
  -> vault
```

The gateway always spawns Pi as a separate RPC process. A gateway restart should not corrupt the vault or agent session state.

## Start the gateway

```bash
piren gateway
piren web
piren --agent piren gateway --port 7317 --host 127.0.0.1
```

Defaults:

- host: `127.0.0.1`
- port: `7317`
- static UI: served from Piren's packaged `public/` directory

## Chat streaming protocol

The native web chat uses a POST-start plus GET-stream pattern:

1. `POST /api/chat/start` with `{ "message": "..." }` returns `{ "stream_id": "..." }` immediately.
2. `GET /api/chat/stream?stream_id=...` opens an SSE stream until a `done` or `error` event.

This avoids WebSocket server complexity. Heartbeats keep proxies from closing idle streams.

JSON request bodies accepted by gateway API routes are capped at 1 MiB and
return HTTP 413 when oversized.

## Minimal integrated UI

Open:

```text
http://127.0.0.1:7317/
```

The UI provides:

- agent selection from the locally runnable set
- chat with token streaming
- steering and follow-up
- approval gates
- read-only vault browser
- read-only OKF knowledge graph
- session list and resume support
- abort button for runaway turns
- read-only context usage indicator
- in-memory Bearer token entry when auth is required

The UI intentionally does not provide model selection, thinking controls, or configuration editing. Those belong in vault config and local config. The model badge shows the live model plus best-effort context-window usage percentage when Pi exposes token telemetry. API routes remain available for external integrations.

## Auth

Localhost can run without auth for friction-free local use. Non-localhost binds require a Bearer token. If none is supplied, Piren auto-generates one and persists it to `~/.config/piren/gateway-token` with mode `0600`.

See [Security](security.md).

## Vault browser and graph

Routes:

- `GET /api/vault/list?path=...`
- `GET /api/vault/read?path=...`
- `GET /api/vault/graph`

The browser is read-only, hides dotfiles, caps listings and reads, and enforces vault path boundaries. The graph route is also read-only: it indexes OKF-typed Markdown documents across the vault from the root, including project indexes, decision records, runbooks, concepts, and entities, then extracts directed links and returns JSON for the Web UI Knowledge Graph panel. Side panels share the same width and are horizontally resizable so the chat stretches with the available space.

## Collaboration rooms

When the gateway is wired with a vault root, the local runnable-agent set, and an agent target builder (the normal `piren gateway` path), it also serves the room API documented in [API reference](api.md): room create/list/read, durable event reads, a scoped per-room SSE stream, structured steward-to-one-agent messages, room-scoped abort, and room-scoped approvals.

Room runs execute through the room broker on isolated room × agent Pi RPC clients — never the global chat client. One explicit mention starts one bounded run; a concurrent mention for the same room × agent is rejected with 409. Immutable correlated events (steward message, run started, agent reply, terminal outcome) are appended under `collaboration/rooms/<room-id>/events/` and are the response timeline. Approvals round-trip only to the exact room-agent client that raised them. Closing the gateway closes the broker first, so active room runs end with durable cancellation evidence.

A broker-spawned room run may also use the gated `room_mention(to, text)` extension tool to ask one permitted room participant for bounded help (room handoff, slice R2). The tool is registered only inside broker-spawned flagged room runs (leads and workers) — ordinary gateway/transport/ask/worker/review processes never expose it — and dispatch is driven by the reserved Pi RPC input envelope, never by rendered `@text`. Limits are fixed: one accepted handoff per steward root, depth one, no repeated source → target pair. The lead→worker chain is immutable: the handoff `agent_message` correlates to the steward root, and the worker's start/reply/terminal records correlate to the handoff, never directly to the root. There is no queue, retry, or fallback. The internal handoff request is not an approval: it never appears on the room SSE stream as `approval` and is not answerable through `POST /api/rooms/<roomId>/approve`. A room workbench UI remains a later slice (R3).

## Session management

Routes:

- `POST /api/chat/abort`
- `GET /api/chat/messages`
- `POST /api/chat/resume`
- `GET /api/chat/sessions`

Pi owns the live transcript. Vault session files are summaries and browseable history, not a second transcript authority.
