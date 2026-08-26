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

## The Workbench

Open:

```text
http://127.0.0.1:7317/
```

The Workbench is Piren's steward-facing, Conversation-native workspace. It provides:

- a responsive app shell: the **Dashboard** default page (local-policy agent roster plus explicit single-agent and peer Conversation start), a persistent desktop sidebar for switching Conversations, and a mobile/portrait hamburger drawer
- public auth probe and an in-memory Bearer token entry when the gateway requires one; a rejected token returns to the entry without being persisted
- the Conversation surface: an immutable whole-history timeline plus a scoped live stream, with a Discord-like raw-text composer on the active surface (Enter submits, Shift+Enter newline, IME-safe, and a `@` mention convenience list that inserts text only)
- runnable-roster-gated attach: a Conversation opens active only when every durable member is locally runnable; otherwise it stays visibly read-only inspection with history only, no composer, and no live stream
- broker-authoritative transient live activity: `<agent> is working…` only after the durable `run_started`, `<agent> is typing…` only after a real Pi text delta, with a bounded plain-text streamed tail and sanitized tool lines; activity cards clear on terminal/error/reconnect/history reread and are never reconstructed from history or shown in read-only inspection
- composer interlock: while a Conversation has live agent work or a pending approval, the composer is read-only with a visible reason and preserves any unsent draft until the work settles
- a read-only **Vault Explorer** companion beside the selected Conversation (or full-page with no selection) over the existing vault list/read routes; no writes, no cache authority, and no Knowledge Graph presentation
- a full-page typed **Settings** module (see [Settings](#settings))
- a focus-managed **Conversation details** modal with the editable title, metadata, and the Archive/Reopen controls
- stable `#conversation/<id>` deep links that re-read the manifest and re-run the attach gate on load and Back/Forward
- a per-agent run deadline: 60 minutes by default, configurable per vault via `workbench.yml` `conversation.run_timeout_seconds`; see [Configuration](configuration.md#workbench-config-workbenchyml)

The Workbench intentionally has no live-session model or thinking controls; those API routes stay available for external integrations, and durable model preferences belong to vault agent config.

## Auth

Localhost can run without auth for friction-free local use. Non-localhost binds require a Bearer token. If none is supplied, Piren auto-generates one and persists it to `~/.config/piren/gateway-token` with mode `0600`.

See [Security](security.md).

## Vault browser and graph

Routes:

- `GET /api/vault/list?path=...`
- `GET /api/vault/read?path=...`
- `GET /api/vault/graph`

The browser is read-only, hides dotfiles, caps listings and reads, and enforces vault path boundaries. The graph route is also read-only: it indexes OKF-typed Markdown documents across the vault from the root, including project indexes, decision records, runbooks, concepts, and entities, then extracts directed links and returns JSON for external integrations. The Workbench's Vault Explorer companion uses only the list/read routes; Knowledge Graph presentation is not part of the current Workbench.

## Local runnable-agent roster

The gateway serves the shared local-policy roster at `GET /api/conversation-agents` (documented in [API reference](api.md)): the vault-defined `team/<agent>/` names with `online` set exactly for members of the locally resolved runnable set.

Piren does not ship a Rooms feature; the Workbench is Conversation-only.

## Conversations

When the gateway is wired with a vault root, the local runnable-agent set, and an agent target builder, it serves the Conversation API documented in [API reference](api.md). A Conversation is activated by its first sent message (even with zero mentions); durable state lives under `collaboration/conversations/`, and run evidence is recorded as immutable events.

The **Dashboard** is the default surface: it reads the local-policy roster, shows agent cards, and starts a Conversation with one agent you select (via `POST /api/conversations/start`). Its service-information card reports only facts from accepted authenticated reads: a successful roster read may say the gateway is connected, and a separate managed-service observation shows one fresh read-only snapshot with truthful Active/Inactive/Not installed labels and a manual retry only. Recorded configuration state is never presented as live process status.

The Dashboard also offers a distinct peer-audience start beside the ordinary single-agent start. In peer mode you explicitly select two to eight locally runnable agents and submit one creation request over the authenticated `POST /api/conversations/start-peer` route. The gateway persists that initial audience as one durable Conversation with its system-authored `conversation_start_requested` origin evidence, but it dispatches no agent: there is no greeting, no chosen lead or speaking order, and no bulk or fan-out messaging. The ordering of the initial audience is canonical display stability only, never a rank or turn order. A peer in the initial audience begins working only when an explicit steward message mentions it: the gateway alone parses and validates the `@`-mention and dispatches an existing audience member without adding anyone new. If the steward mentions a previously absent locally runnable agent, Piren first adds that agent to the audience before dispatching it. The browser never derives recipients from text. If the result of a start request is unclear (for example a network failure), the Workbench permits only an explicit durable list refresh, never an automatic retry.

Lifecycle controls: **Archive** on a selected open Conversation (with an explicit confirmation) and **Reopen** on an archived read-only inspection. Archiving makes it read-only and never cancels a running turn; neither action starts or attaches a Pi session or stream. After a lifecycle action or event, the Workbench fresh-reads the manifest and re-runs the attach gate before showing active or read-only. Errors are bounded: 401 follows token handling, 404 returns to the list, 409 offers a manual Retry only, and a 500 is fresh-inspected (the manifest may already have transitioned) and never rolled back or fabricated. The browser never holds authoritative lifecycle state.

Approval and abort controls: a live approval request renders a non-modal card with Confirm, Cancel, or a labeled input; submitting sends exactly one of `confirmed`, `value`, or `cancelled`, and success is delivery acceptance only (the browser never fabricates an agent outcome). Each member's transient activity card carries an **Abort** action for that exact conversation × agent run. Approval cards and Abort appear only on the active surface, show a manual Retry only on unknown/stale/error responses, and approvals are never durable events.

Multi-agent handoff: inside Conversation runs, the `conversation_handoff(to, text)` agent tool can request a bounded handoff to another agent. The request stays open on a live approval card until you confirm or reject it; nothing is dispatched or added to the audience before confirmation, and child stages can hand off again within a finite budget (depth 3 / edges 8 / rework 2). Handoff events are durable, approvals stay live-only, abort stays one direct active run, and there is no hidden queue, retry, reroute, fallback, or auto-approval. The Workbench renders handoff-gate cards and live stage events.

## Settings

The Workbench includes a full-page **Settings** module of typed, validated configuration workflows organized as three tabs in fixed order: **This installation**, **Agent settings**, and **Agent groups**. Tab selection is in-memory only; nothing persists to browser storage. It is not a generic YAML or filesystem editor.

**This installation** (machine-local `~/.config/piren/config.yml`):

- **Telegram** and **Discord** transport blocks: the bot token is write-only (never returned by any route and never rendered after save), non-secret allowlist identifier values are prefilled from the redacted read and replaced only on an explicit save, plus default agent and feedback preference. The default-agent select offers the locally runnable roster and the server validates a saved value against it. A static bot-setup help control shows fixed setup steps without contacting the platform.
- **Scheduler**: the three closed automation classes (inbox tasks, agent cron, script cron), the sole ordinary execution gates, plus poll/stale intervals, concurrency, and device id. A retired-key legacy gate state renders read-only and refuses saves with guidance to `piren scheduler configure`, the only migration writer. Saving never installs, starts, stops, or ticks the scheduler or any service.

**Agent settings** (vault-owned `team/<agent>/config.yml`): cards select one locally runnable agent; saving edits only durable future-launch preferences and never changes a live Pi session. The model-fallback declaration uses an ordered editor (move-up/down/remove) and saving one that leaves auto-switch enabled requires an explicit confirmation modal. The context-injection option label is truthful (`Default (session_start_only)`: selecting Default writes nothing); explicit `per_turn` and the `PIREN_CONTEXT_INJECTION` override still win.

**Agent groups** (vault-owned `agent-groups/<group>/config.yml`): typed workflows for list, show, create, add member, remove member, per-member ordered fallback set, and a read-only cross-group validation report. Writes are revision-checked and atomic: a config changed since it was read is refused with 409, and unknown top-level fields are preserved. Create, remove-member, and fallback-set require explicit confirmation modals. Membership comes from the vault-defined `team/<agent>/` roster only; members that are not locally runnable are visibly marked and never actionable here. No group action mutates the runnable policy (`allowed_agents`/`excluded_agents`), assigns work, or reroutes.

Reads are redacted projections: tokens report only whether one is configured and are never returned by any route; non-secret allowlist identifiers come back as redacted editable values for prefill. Writes are atomic with a source-revision check; any failure leaves the prior file byte-for-byte intact. Settings routes follow the gateway's authentication policy on every bind. Saving never contacts a platform or provider, never performs a service action, and never restarts anything. Provider credentials (`~/.pi/agent/`), the gateway token, and the runnable-agent policy are never readable or editable here. See [API reference](api.md) for the route contract and [Configuration](configuration.md) for the underlying files.

## Session management

Routes:

- `POST /api/chat/abort`
- `GET /api/chat/messages`
- `POST /api/chat/resume`
- `GET /api/chat/sessions`

Pi owns the live transcript. Vault session files are summaries and browseable history, not a second transcript authority.
