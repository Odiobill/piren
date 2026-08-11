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
- static UI: the React/Vite workbench shell, built from `web/` and served from `dist/public`. A source `piren gateway` requires `npm run build` first so `dist/public` exists.

## Chat streaming protocol

The native web chat uses a POST-start plus GET-stream pattern:

1. `POST /api/chat/start` with `{ "message": "..." }` returns `{ "stream_id": "..." }` immediately.
2. `GET /api/chat/stream?stream_id=...` opens an SSE stream until a `done` or `error` event.

This avoids WebSocket server complexity. Heartbeats keep proxies from closing idle streams.

When the current agent declares a `model.fallback` block (see [Configuration](configuration.md)), the chat stream may also carry a structured `model_fallback` SSE event (`{kind, from, to, category, attempt, exhausted}`) before a same-client automatic continuation when a fully settled run ends as a zero-side-effect provider error. The event is evidence for external integrations and the transcript; the integrated UI adds no model controls. An explicit `POST /api/chat/model` steward selection disables automatic fallback for the session; `autoFallback: true` on the same route re-enables it.

JSON request bodies accepted by gateway API routes are capped at 1 MiB and
return HTTP 413 when oversized.

## Minimal integrated UI

Open:

```text
http://127.0.0.1:7317/
```

The UI provides:

- a responsive app shell: persistent desktop sidebar (the conversation switcher with the creation entry point, plus **Agents → About** pages) and a mobile/portrait hamburger drawer (focus trap, Escape closes, focus returns)
- public auth probe (`GET /api/auth/info`) with loading/error states
- in-memory Bearer token entry when auth is required (never written to storage); the first protected request validates the token, and a rejected token returns to the entry without persistence
- a Conversation navigator: list/create/select by first raw-text message, with a vault-agent roster where **online** means runnable on this installation (local installation policy only, not a live presence or provider probe); the gateway alone parses `@` mentions
- C1/runnable-roster-gated active attach: successful attach renders immutable history plus scoped live SSE and a Discord-like raw-text composer; rejected or archived conversations are visibly read-only inspection with history only, no composer, and no live stream
- broker-authoritative transient live activity (U4): the additive `conversation_activity` SSE frame carries an opaque per-run `runId`; the UI shows `<agent> is working…` only after the durable `run_started`, `<agent> is typing…` only after a real Pi text delta, and a clearly transient bounded partial reply reconciled to the correlated durable `agent_message` and cleared on terminal/malformed/stale frames, stream end/error, reconnect, or history reread — activity is never reconstructed from history, never durable, and read-only inspection never shows it
- a Discord-like composer (U3) shared by the active surface and the browser-local draft: auto-growing and anchored at the bottom of the full-height workspace (messages scroll above it); **Enter** submits, **Shift+Enter** inserts a newline, and IME composition never submits prematurely; a genuinely disabled labelled `+` button is a visual future-upload affordance with no file capability; typing `@` offers a keyboard-navigable convenience list of **locally runnable** agents (text-only insertion — the browser still sends exactly `{text}`, and the gateway alone parses/validates mentions)
- a focus-managed **Conversation details** modal (U2) opened from a composer-right information icon on the active surface (and from a minimal inspection action row on read-only inspection): it presents the current title (editable with bounded Save/Cancel/error/Retry), id, status, audience, created/updated times, and the relocated Archive/Reopen controls with their accepted confirmation + fresh re-gate semantics; a browser-local draft has no details surface
- stable `#conversation/<id>` deep links: initial load and Back/Forward re-read the manifest and re-run the stateless attach gate before a live surface opens; malformed/unknown hashes return to the new-conversation draft without a request
- a read-only **Agents** page (local-policy roster, non-interactive) and a read-only **About** page (connection/status only, no form controls)
- switching views keeps the Conversation navigator mounted: a view change never cancels a conversation run and never creates client-side delivery/approval/retry truth
- the Piren logo and responsive, keyboard-usable semantic layout

Conversation approval/abort controls are delivered: on the active surface the Workbench renders accessible non-modal approval cards from scoped live approval frames and a per-member Abort action (see below); broader persistent-navigation work remains separately gated, and read-only vault browser/graph navigation is deferred to a later phase. The gateway chat and room APIs remain available for external integrations.

The UI intentionally does not provide model selection, thinking controls, or configuration editing. Those belong in vault config and local config. API routes remain available for external integrations.

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

## Conversations

When the gateway is wired with a vault root, the local runnable-agent set, and an agent target builder, it also serves the Conversation API documented in [API reference](api.md): conversation list/read, first-message activation, raw-text send, durable event reads, a scoped per-conversation SSE stream, and the C1/runnable-roster-gated active attach (`POST /api/conversations/<id>/attach`, stateless). A conversation is activated by its first sent message (even with zero mentions); a steward adds members by `@`-mentioning locally runnable agents, which the gateway alone parses and validates. Durable conversation state lives under `collaboration/conversations/`, a sibling of the room tree, and run evidence is recorded as immutable events. The Workbench Conversation surface (C3-A): the sidebar is the conversation switcher and creation entry point, and the default main workspace is a local new-conversation draft template (browser-local and ephemeral — a draft is persisted only when its first message is sent and creates the conversation). Selecting a conversation attaches through the gate (a rejected conversation stays visibly read-only inspection with no composer or live stream), and live events stream only after a successful attach; the browser never scans or resolves `@text` — mentions are server-authoritative. Conversations have stable browser deep links (`#conversation/<id>`, C4-A): the initial hash and every `hashchange` (including Back/Forward) perform a fresh manifest read plus the stateless attach gate before opening the live surface, and malformed/unknown hashes fail truthfully back to the new-conversation draft without any request.

The Workbench also exposes Conversation lifecycle controls over the archive/reopen routes: **Archive** on a selected open conversation (including one open in read-only inspection because a member is not locally runnable) behind an explicit non-modal confirmation; **Reopen** only on an archived read-only inspection. Archiving never cancels an active run, and neither action starts or attaches a Pi session or stream. After a lifecycle action — and after a live scoped lifecycle event from another client — the Workbench fresh-reads the manifest and re-runs the attach gate before showing active or read-only: an archived conversation becomes history-only (composer and live SSE gone) only after that gate; a reopened conversation becomes active only if every durable audience member is locally runnable. Operator-visible lifecycle errors are bounded: 401 follows the existing token handling, 404 returns to the list with a bounded message, 409 offers a manual Retry only, and a 500 is fresh-inspected (the manifest may already have transitioned) and never rolled back or fabricated. No browser storage/cache, hidden retry/queue, model/config/secret UI, or WebSocket is added, and the browser never holds authoritative lifecycle state.

The Workbench also exposes Conversation approval/abort controls over the delivered routes. A scoped live `approval` SSE frame (bounded `{conversationId, agent, requestId, method, payload}` for exactly the `confirm`, `select`, and `input` Pi UI methods) on a selected active conversation renders a non-modal approval card with Confirm / Cancel (and a labeled input for select/input requests); submitting sends exactly one of `confirmed`, `value`, or `cancelled` with the request id to `POST /api/conversations/<id>/approve`, and a 200 is delivery acceptance only — the browser never fabricates an agent outcome. Each member of an active conversation has an **Abort** action that sends only the member name to `POST /api/conversations/<id>/abort` and reports the bounded `cancelled` or `no-active-run` outcome truthfully. Cards and Abort appear ONLY on the active surface: read-only/archived/gate-rejected inspection shows no approval card, no Abort, and no composer-equivalent control. Unknown/stale/already-settled approvals and bounded 400/404/409/500/network errors are shown with a manual Retry only — no hidden retry, queue, auto-approval, auto-abort, browser persistence, or client-side recipient/request-id derivation. Controls are run-scoped: a pending approval from an already-running run of an archived conversation remains answerable, while a fresh lifecycle re-gate clears any stale card. Approval frames are never durable conversation events and never appear in historic event reads.

The conversation broker also exposes the gated `conversation_handoff(to, text)` agent tool for steward-approved multi-agent workflows (C5). The tool is registered ONLY inside broker-spawned Conversation runs and is never available to ordinary gateway chat, OpenAI, transport, ask, worker/scheduler, room, or other non-broker processes (the broker stamps its own isolated run targets with the exact role flag). A steward-dispatched root lead may use it only to REQUEST the initial handoff gate: the broker raises a live `confirm` approval card through the same approval SSE + approve-route path above (live-only, never durable) and keeps that root tool request open until the steward confirms or rejects it. Before confirmation there is no handoff event, no audience change, no budget consumption, and no dispatch. Confirmation accepts the first edge (additive membership plus one immutable, replay-correlated handoff event), releases the root tool call, and the child stage launches only after the lead's run completes. Child stages of an approved workflow may hand off again within the finite per-workflow budget (depth 3 / edges 8 / rework 2) with no further per-handoff gate. There is no hidden task bridge, queue, retry, reroute, fallback, or auto-approval; abort remains exactly one direct active `conversation × agent` run, and aborting an active source fail-closed prevents its deferred child. The Workbench renders handoff-gate cards and live stage events on the active Conversation surface.

## Session management

Routes:

- `POST /api/chat/abort`
- `GET /api/chat/messages`
- `POST /api/chat/resume`
- `GET /api/chat/sessions`

Pi owns the live transcript. Vault session files are summaries and browseable history, not a second transcript authority.
