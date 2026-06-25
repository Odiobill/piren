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
- session list and resume support
- abort button for runaway turns
- read-only context indicator
- in-memory Bearer token entry when auth is required

The UI intentionally does not provide model selection, thinking controls, or configuration editing. Those belong in vault config and local config. API routes remain available for external integrations.

## Auth

Localhost can run without auth for friction-free local use. Non-localhost binds require a Bearer token. If none is supplied, Piren auto-generates one and persists it to `~/.config/piren/gateway-token` with mode `0600`.

See [Security](security.md).

## Vault browser

Routes:

- `GET /api/vault/list?path=...`
- `GET /api/vault/read?path=...`

The browser is read-only, hides dotfiles, caps listings and reads, and enforces vault path boundaries.

## Session management

Routes:

- `POST /api/chat/abort`
- `GET /api/chat/messages`
- `POST /api/chat/resume`
- `GET /api/chat/sessions`

Pi owns the live transcript. Vault session files are summaries and browseable history, not a second transcript authority.
