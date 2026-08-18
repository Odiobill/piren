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
- static UI: the packaged React/Vite web workbench served by the gateway.

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

- a responsive app shell: the **Dashboard** default page (local-policy roster + explicit agent-first Conversation start), a persistent desktop sidebar (the conversation switcher), and a mobile/portrait hamburger drawer (focus trap, Escape closes, focus returns)
- public auth probe (`GET /api/auth/info`) with loading/error states
- in-memory Bearer token entry when auth is required (never written to storage); the first protected request validates the token, and a rejected token returns to the entry without persistence
- a Conversation navigator: select existing conversations by durable record; the Dashboard owns explicit agent-first starts, while the gateway alone parses `@` mentions in follow-up raw-text messages
- runnable-roster-gated active attach: successful attach renders immutable history plus scoped live SSE and a Discord-like raw-text composer; rejected or archived conversations are visibly read-only inspection with history only, no composer, and no live stream
- broker-authoritative transient live activity: the additive `conversation_activity` SSE frame carries an opaque per-run `runId`; the UI shows `<agent> is working…` only after the durable `run_started` and `<agent> is typing…` only after a real Pi text delta; activity clears on terminal/malformed/stale frames, stream end/error, reconnect, or history reread and is never reconstructed from history, never durable, and read-only inspection never shows it; the message-first transcript renders durable steward/agent messages as compact chat rows and attaches fixed non-interactive status clusters (`⏳ received`, `✅ completed`, `⚠️ failed`/`timed out`, `⏹ cancelled`) to the durable requester row only through the existing `correlationId`/`runAgent`/terminal-status evidence with the exact status labels, never a read/seen/delivery claim, and ineligible/uncorrelated/malformed run or system evidence fails safe to compact visible attention rows; ordinary durable `agent_message` bodies render the safe bounded Markdown subset (paragraphs, `#`/`##`/`###` headings mapped to h4–h6, one-level quotes, `1.`/`-` lists with three two-space-indent nesting levels, fenced ``` code with a text-only label, inline code/strong/emphasis and safe `http`/`https` links with `target="_blank"` + `rel="noopener noreferrer"`; steward and handoff evidence bodies stay literal) — a dependency-free pure parser with hard bounds (32768 UTF-16 input / 2048 blocks / 8192 inline nodes) that renders any overflow body entirely as literal text with the exact notice, and never creates HTML strings, executable nodes, or Markdown-derived authority
- a Discord-like composer on the active surface: auto-growing and docked as a clean one-line bar at the bottom of the full-width workspace (messages scroll above it) with a disabled labelled `+` upload affordance left, the textarea middle, the details icon right, and a compact page-local submit-shortcut toggle adjacent to it; the toggle switches only the local Enter-to-send (Shift+Enter newline) versus Ctrl+Enter-to-send (Enter newline; Ctrl+Enter sends) policy, discloses the current mode through its accessible name/pressed state/tooltip, and never sends, persists, changes the URL, the gateway, the agent, the Conversation, or browser storage; IME composition never submits prematurely under either policy; typing `@` offers a keyboard-navigable convenience list of **locally runnable** agents (text-only insertion — the browser still sends exactly `{text}`, and the gateway alone parses/validates mentions)
- a focus-managed **Conversation details** modal opened from a composer-right information icon on the active surface (and from a minimal inspection action row on read-only inspection): it presents the current title (editable with bounded Save/Cancel/error/Retry), id, status, audience, created/updated times, and the relocated Archive/Reopen controls with their accepted confirmation + fresh re-gate semantics; the no-selection surface has no details control
- stable `#conversation/<id>` deep links: initial load and Back/Forward re-read the manifest and re-run the stateless attach gate before a live surface opens; malformed/unknown hashes return to the no-selection surface without a request
- switching views keeps the Conversation navigator mounted: a view change never cancels a conversation run and never creates client-side delivery/approval/retry truth
- the Piren logo and responsive, keyboard-usable semantic layout

Conversation approval/abort controls are delivered: on the active surface the Workbench renders accessible non-modal approval cards from scoped live approval frames and a transient activity-only abort (see below); broader persistent-navigation work is not yet implemented, and read-only vault browser/graph navigation is planned for a later release. The gateway chat and Conversation APIs remain available for external integrations.

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

## Local runnable-agent roster

The gateway serves the shared local-policy roster at `GET /api/conversation-agents` (documented in [API reference](api.md)): the vault-defined `team/<agent>/` names with `online` set exactly for members of the locally resolved runnable set. This replaces the retired `/api/room-agents` route, which is removed without an alias.

Piren no longer ships the Rooms collaboration feature (room routes, room broker, `room_mention` tool, room web surface). The Workbench is Conversation-only.

## Conversations

When the gateway is wired with a vault root, the local runnable-agent set, and an agent target builder, it also serves the Conversation API documented in [API reference](api.md): conversation list/read, first-message activation, raw-text send, durable event reads, a scoped per-conversation SSE stream, and the runnable-roster-gated active attach (`POST /api/conversations/<id>/attach`, stateless). A conversation is activated by its first sent message (even with zero mentions); a steward adds members by `@`-mentioning locally runnable agents, which the gateway alone parses and validates. Durable conversation state lives under `collaboration/conversations/`, and run evidence is recorded as immutable events. The Workbench Conversation surface: the **Dashboard** is the default surface — it reads the local-policy roster from the existing authenticated read, presents it as agent cards with bounded presentation slots (no presentation schema or browser persistence), and starts a new Conversation with one explicitly steward-selected runnable agent via `POST /api/conversations/start` (exactly `{agent}`; the browser never derives a recipient or synthesizes text). A pending start shows a truthful local busy line describing the submitted browser/gateway operation (never an invented agent state) with reduced-motion-safe animated dots. The Dashboard's service-information card reports only facts from accepted authenticated reads: a successful roster read may say the gateway is connected, and a clearly separate managed-service-observation group presents one fresh, read-only snapshot from `GET /api/services/status` — the fixed Telegram/Discord/Scheduler targets in order with truthful Active/Inactive/Not installed/Manager unavailable/Unknown labels, the source manager and sampled time named, caution styling for unknown/unavailable, and a bounded "Service observation unavailable" presentation with an explicit manual retry only (no polling, storage, stale-snapshot reuse, or silent retry). Recorded configuration state is never presented as live process status. The sidebar is the sole conversation switcher; the Dashboard has no duplicate conversation list. Selecting a conversation attaches through the gate (a rejected conversation stays visibly read-only inspection with no composer or live stream), and live events stream only after a successful attach; the browser never scans or resolves `@text` — mentions are server-authoritative. Conversations have stable browser deep links (`#conversation/<id>`): the initial hash and every `hashchange` (including Back/Forward) perform a fresh manifest read plus the stateless attach gate before opening the live surface, and malformed/unknown hashes fail truthfully to the no-selection surface without any request.

The Workbench also exposes Conversation lifecycle controls over the archive/reopen routes: **Archive** on a selected open conversation (including one open in read-only inspection because a member is not locally runnable) behind an explicit non-modal confirmation; **Reopen** only on an archived read-only inspection. Archiving never cancels an active run, and neither action starts or attaches a Pi session or stream. After a lifecycle action — and after a live scoped lifecycle event from another client — the Workbench fresh-reads the manifest and re-runs the attach gate before showing active or read-only: an archived conversation becomes history-only (composer and live SSE gone) only after that gate; a reopened conversation becomes active only if every durable audience member is locally runnable. Operator-visible lifecycle errors are bounded: 401 follows the existing token handling, 404 returns to the list with a bounded message, 409 offers a manual Retry only, and a 500 is fresh-inspected (the manifest may already have transitioned) and never rolled back or fabricated. No browser storage/cache, hidden retry/queue, model/config/secret UI, or WebSocket is added, and the browser never holds authoritative lifecycle state.

The Workbench also exposes Conversation approval/abort controls over the delivered routes. A scoped live `approval` SSE frame (bounded `{conversationId, agent, requestId, method, payload}` for exactly the `confirm`, `select`, and `input` Pi UI methods) on a selected active conversation renders a non-modal approval card with Confirm / Cancel (and a labeled input for select/input requests); submitting sends exactly one of `confirmed`, `value`, or `cancelled` with the request id to `POST /api/conversations/<id>/approve`, and a 200 is delivery acceptance only — the browser never fabricates an agent outcome. Abort is a compact source-truthful live run state in the stable bottom dock: it appears ONLY while a valid broker `conversation_activity` working/text_delta frame is current, identifies that exact broker-provided agent with its `working`/`typing` phase (never partial streamed text), and its accessible labelled inline-SVG control sends the existing abort request (`POST /api/conversations/<id>/abort {agent}`) for that agent only — membership is never treated as active-run authority and no audience guess/history reconstruction/private reasoning occurs; the dock state clears on the existing settled/durable terminal/reconnect/history/selection/malformed-frame cleanup. Cards and the transient panel appear ONLY on the active surface: read-only/archived/gate-rejected inspection shows no approval card, no abort, and no composer-equivalent control. Unknown/stale/already-settled approvals and bounded 400/404/409/500/network errors are shown with a manual Retry only — no hidden retry, queue, auto-approval, auto-abort, browser persistence, or client-side recipient/request-id derivation. Controls are run-scoped: a pending approval from an already-running run of an archived conversation remains answerable, while a fresh lifecycle re-gate clears any stale card. Approval frames are never durable conversation events and never appear in historic event reads.

The conversation broker also exposes the gated `conversation_handoff(to, text)` agent tool for steward-approved multi-agent workflows. The tool is registered ONLY inside broker-spawned Conversation runs and is never available to ordinary gateway chat, OpenAI, transport, ask, worker/scheduler, or other non-broker processes (the broker stamps its own isolated run targets with the exact role flag). A steward-dispatched root lead may use it only to REQUEST the initial handoff gate: the broker raises a live `confirm` approval card through the same approval SSE + approve-route path above (live-only, never durable) and keeps that root tool request open until the steward confirms or rejects it. Before confirmation there is no handoff event, no audience change, no budget consumption, and no dispatch. Confirmation accepts the first edge (additive membership plus one immutable, replay-correlated handoff event), releases the root tool call, and the child stage launches only after the lead's run completes. Child stages of an approved workflow may hand off again within the finite per-workflow budget (depth 3 / edges 8 / rework 2) with no further per-handoff gate. There is no hidden task bridge, queue, retry, reroute, fallback, or auto-approval; abort remains exactly one direct active `conversation × agent` run, and aborting an active source fail-closed prevents its deferred child. The Workbench renders handoff-gate cards and live stage events on the active Conversation surface.

## Session management

Routes:

- `POST /api/chat/abort`
- `GET /api/chat/messages`
- `POST /api/chat/resume`
- `GET /api/chat/sessions`

Pi owns the live transcript. Vault session files are summaries and browseable history, not a second transcript authority.
