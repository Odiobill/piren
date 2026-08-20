# API reference

This reference lists Piren's user-facing CLI, Pi extension tools, and HTTP routes.

## CLI

- `piren init --vault-root <path> [--agent <name>]`
- `piren status`
- `piren agents`
- `piren doctor`
- `piren setup [--apply] [--vault-root <path>] [--agent <name>] [--provider <id>] [--model <id>] [--thinking <level>] [--api-key <key>]`
- `piren run`
- `piren chat`, alias for `run`
- `piren worker`
- `piren gateway`, alias `piren web`
- `piren telegram` (`piren telegram configure` for the guided local setup flow)
- `piren discord` (`piren discord configure` for the guided local setup flow)
- `piren ask "message"`
- `piren service <install|remove|start|stop|restart|status> <gateway|telegram|discord|scheduler>`
- `piren agent <add|remove|clone|list> [name]`
- `piren scheduler [--dry-run|--report|--once [--force]|configure]` (disabled by default; see [Scheduler](scheduler.md))
- `piren task <list|send|show|claim|complete|cancel>`
- `piren cron <list|show|create|create-script|enable|disable|runs|validate>`
- `piren skill <list|show|explain|create|move|promote|demote|conflicts|validate|...>` and `piren skills <seed|doctor>`
- `piren package <list|explain|doctor>`
- `piren group <list|show|create|add-agent|remove-agent|fallback set|validate>`
- `piren clean [--force]`
- `piren version`
- `piren update`

Global options include `--vault-root`, `--agent`, `-a`, and `--agent-dir`. Long options accept either `--flag value` or `--flag=value`.

## Extension command

- `piren_status`

## Extension tools

Vault tools:

- `vault_read(path)`
- `vault_read_cached(path)`
- `vault_write(path, content)`
- `vault_list(path)`
- `vault_patch(path, old_text, new_text)`
- `vault_append_log(path, entry)`

Session and task tools:

- `session_write_summary(summary, title?)`
- `send_to_agent(to, title, body)`
- `task_update_status(task_path, status, result?)`
- `inbox_list()`
- `task_claim(task_path, device_id?, stale_after_ms?)`
- `flag_steward(title, body, severity?, notify?)`

Skills:

- `skill_list()`
- `skill_read(name)`

Knowledge lifecycle:

- `project_status(project)`
- `project_append_log(project, entry)`
- `decision_record(project, id, title, context, decision, consequences?, alternatives?)`
- `project_update_handoff(project, content)`
- `runbook_write(project, title, content)`
- `skill_candidate_write(name, description, body, scope?)`
- `wiki_update_concept(title, content, description?, tags?, links?)`
- `wiki_update_entity(title, content, description?, tags?, links?)`
- `self_improvement_trigger_check(message)`

Cron:

- `cron_list()`
- `cron_claim(job_path, device_id?, stale_after_ms?)`
- `cron_record_run(job_path, status, result, started_at, finished_at)`
- `cron_runs(job_id?)`

OKF conformance (see [OKF](okf.md)):

- `vault_conformance_check()`

## HTTP routes

Auth:

- `GET /api/auth/info`

Chat streaming:

- `POST /api/chat/start`
- `GET /api/chat/stream?stream_id=...`
- `POST /api/chat/abort`
- `GET /api/chat/messages`
- `POST /api/chat/resume`
- `GET /api/chat/sessions`

Model, thinking, and agent state API for external integrations:

- `GET /api/chat/models`
- `GET /api/chat/state`
- `POST /api/chat/model`
- `POST /api/chat/thinking`
- `GET /api/chat/agents`
- `POST /api/chat/switch`

Approval:

- `POST /api/chat/approve`

Vault browser and graph:

- `GET /api/vault/list?path=...`
- `GET /api/vault/read?path=...`
- `GET /api/vault/graph`

Managed service observation:

- `GET /api/services/status` — one fresh, read-only snapshot of the fixed Piren service targets `telegram`, `discord`, and `scheduler` (always in that order), sampled locally by the gateway at request time. Success is `200` with exactly `{observedAt, manager, targets}`: `observedAt` is the server-generated ISO sample time, `manager` is `systemd-user`, `tmux-cron`, or `unavailable`, and each target's `state` is one of `active`, `inactive`, `not-installed`, `unavailable`, or `unknown`. A target the gateway cannot classify safely is reported as `unknown` for that target only — never as inactive, and never as a whole-snapshot failure. The route accepts no target, manager, command, path, or timeout selection; it never probes the gateway service itself (a successful authenticated read already establishes the gateway-connection fact) and returns no command text, paths, logs, process identifiers, or other diagnostics. When no observation can be produced, the response is a bounded `503 {"error": "service observation unavailable"}`, never a fabricated snapshot. The read changes nothing: no service control, install, removal, config write, polling, caching, or history.

Settings (typed local/agent configuration workflows; the local routes require the gateway's local config path and the agent routes a vault root — otherwise a bounded `404 {"error": "settings unavailable"}`):

- `GET /api/settings/telegram` and `GET /api/settings/discord` — the fully redacted transport projection: `200 {available: true, telegram|discord: {...}}` with a token `configured` boolean, allowlist counts, default agent, and feedback state (never a token, fingerprint, raw config, or unknown field), or `200 {available: false, reason}` with a bounded non-secret reason when the config is missing or malformed.
- `GET /api/settings/scheduler` — the redacted scheduler projection: master gate, the three closed automation classes, and the editable poll/stale/concurrency/device values. Read-only: no tick, claim, or spawn.
- `GET /api/settings/agents/<agent>` — the redacted vault-owned agent-preference projection (model id/thinking, model-fallback declaration, context-injection mode, self-improvement toggles). A non-runnable agent is a bounded `403`.
- `POST` on the same paths applies one closed intent envelope. Local routes take `{surface: "local", family: "telegram"|"discord"|"scheduler", block}`; agent routes take `{surface: "agent", agent, family: "model"|"model-fallback"|"context-injection"|"self-improvement", ...}` with the family's block or mode fields. The inventory is closed: unknown envelope or block fields are a bounded `400`, and the family/agent must match the route. A successful write returns exactly `200 {wrote: true}` through an atomic temp-file-plus-rename writer with a source-revision check — a file changed since the read is a `409`, and every validation or I/O failure leaves the prior file byte-for-byte intact with a bounded non-secret error (`400`/`403`/`404`/`409`/`500`). Bot-token fields are write-only: accepted on writes, never returned by any route. A model-fallback save that leaves auto-switch enabled requires `confirmAutoSwitch: true` (absent auto-switch defaults to enabled). Writes never contact a platform or provider, never perform a service action, and never change a live Pi session.

OpenAI-compatible:

- `POST /api/v1/chat/completions`

Local runnable-agent roster (replacement for the retired `/api/room-agents` route, which is removed without an alias):

- `GET /api/conversation-agents` — the vault-agent roster for the workbench: `{agents: [{name, online}]}`, deterministically sorted by name. Names come from the vault-defined `team/<agent>/` roster supplied to the gateway at startup; `online` is local installation policy only — membership in this gateway's resolved runnable set — never Pi-process presence, provider reachability, transport state, or identity. An empty supplied roster returns `[]`. The route reveals no config, tokens, groups, or diagnostics and starts no Pi clients.

Piren no longer ships the Rooms collaboration feature (room routes, room broker, `room_mention` tool, room web surface).

Conversations (available when the gateway is wired with a vault root, runnable agents, and an agent target builder; otherwise all conversation routes return 404):

- `GET /api/conversations` — list conversation manifests, newest-first.
- `GET /api/conversations/<id>` — read one conversation manifest and its additive `audience` (the members who joined through validated `@`-mentions). Read-only; always allowed regardless of member runnability.
- `POST /api/conversations` — create and send the first message in one request. Body `{text}`; returns `201 {conversation, event, dispatch?}`. The first message activates and persists the conversation even with zero mentions (nothing is dispatched then). There is no standalone title-only create route: a conversation only exists after its first message. Mentions are parsed and validated by the gateway alone against the local runnable-agent set; an unknown, excluded, or non-runnable mention fails the whole request with 400 before anything is written. The server generates the immutable conversation id as a neutral `<compact-UTC>-c-<12-lowercase-hex>` value: no first-message text, title, mention, or browser input ever appears in the id, and the browser never proposes one. Older ids remain valid forever with no migration.
- `POST /api/conversations/start` — agent-first Conversation start. Body is exactly `{agent}` — a missing, non-string, blank, extra-key, or malformed body is a bounded 400; an unknown, excluded, or non-runnable name is a bounded 400 validated against the gateway-resolved local runnable set before any vault persistence or broker dispatch. On success the gateway creates an open conversation with `audience: [agent]` and the deterministic title `Conversation with <agent>` (never LLM- or text-derived), persists one additive system-authored `conversation_start_requested` origin event after the manifest and before dispatch, publishes that exact committed record to the scoped SSE stream before any run evidence, and dispatches the separately typed broker start run whose bounded prompt asks only for one brief greeting and to stop (no steward text is synthesized; the run is never a handoff root and gains no handoff authority). Returns `201 {conversation, event, dispatch}`; an active-run conflict is a 409. `run_started`, the agent greeting, and every typed terminal correlate to the origin event id; startup/post-dispatch failures keep the existing typed `launch_failure`/`ambiguous`/`provider_error` terminals.
- `POST /api/conversations/<id>/messages` — append a raw-text steward message to an open conversation; returns `200 {event, dispatch?}` with the same mention validation. An archived conversation rejects message append with 409.
- `POST /api/conversations/<id>/attach` — the runnable-roster-gated active attach. Reads the durable manifest and applies the accepted runnable-roster active gate against the gateway's resolved runnable set. Returns `200 {conversation, attached: true, gate: {ok: true, missing: [], malformed: []}}` only for an open conversation whose every durable audience member is locally runnable (including an empty audience). It returns a non-secret `409 {error, attached: false, gate}` when the conversation is archived or a durable member is missing/malformed; in either case the conversation stays visibly read-only inspection. The route is **stateless**: no vault write, membership update, broker dispatch, Pi client/session creation, live subscription, queue, retry, or persistent active-conversation state. An absent conversation is 404; unauthenticated requests are 401.
- `POST /api/conversations/<id>/archive` — explicit durable archive of an open conversation (`open → archived`).
- `POST /api/conversations/<id>/reopen` — explicit durable reopen of an archived conversation (`archived → open`).
- `POST /api/conversations/<id>/rename` — bounded steward-facing title change. Body `{title}`; the trim-normalized value must be a single line of 1–120 Unicode code units (empty, control/newline-containing, or overlength values are a non-secret 400). A completed rename returns `200 {conversation, renamed: true, event}` where the safe event carries both bounded titles (`previousTitle`, `title`) as inspectable evidence; a request whose normalized title already equals the durable title returns `200 {conversation, renamed: false}` with no write and no event. The route rewrites only `title` and `updated` in the manifest under the same per-conversation transition lock as audience updates and archive/reopen; `id`, `audience`, `status`, `created_by`, and `created` are preserved byte-for-byte, and exactly one immutable `conversation_renamed` event (author steward) is appended per actual rename. Archived conversations remain renameable. Contention is the exact 409 busy vocabulary; absence is 404; an event-append failure after a successful manifest rename returns a bounded `500 {error:"internal error"}` with the renamed manifest authoritative (no rollback/retry/repair, no raw error/path/lock leakage). The browser re-reads/re-gates after success and never fabricates a title; no live SSE frame is added for renames.

The two lifecycle routes share one contract:

- Same normal Bearer gate and Conversation-capability gate as the family: unauthenticated requests are 401; an unwired capability or an absent conversation is 404 with no mutation. Malformed ids keep the family's existing 404 behavior.
- **No lifecycle input fields:** an empty object body is accepted; clients must not submit or derive status, audience, lock, agent, model, or session state. The browser sends only the selected conversation id and the fixed action.
- An actual transition returns `200 {conversation, transitioned: true, event}` where `event` is the immutable `lifecycle_transition` record and exists only then. A same-target repeat returns `200 {conversation, transitioned: false}` with no event and no manifest write.
- Genuine `.audience.lock` contention returns `409` with no lifecycle write or event; the client may retry manually. There is no automatic retry and no stale-lock recovery is added (the existing per-conversation lock semantics apply).
- An event-append failure returns a bounded `500` after the manifest may already have changed: the transitioned manifest remains authoritative; there is no rollback, auto-repair, fabricated event, or raw internals in the response. Operator action is a fresh manifest/history inspection; Piren never retries, and a later target-state request cannot repair a missing lifecycle event.
- Archive/reopen do not dispatch, retry, reroute, abort, attach, start Pi/broker/session work, change membership, or modify local config. Existing active runs are not cancelled; message append to an archived conversation stays fail-closed with `409`.
- Lifecycle events are immutable durable timeline evidence: an additive `lifecycle_transition` kind with `lifecycleState: open|archived` when present.
- `GET /api/conversations/<id>/events` — the validated chronological immutable event records (durable history).
- `POST /api/conversations/<id>/approve` — forward one approval response to the exact pending conversation × agent request. Body `{agent, request_id}` plus exactly one of `confirmed` (boolean), `value` (string), or `cancelled` (true); a malformed/missing body or a non-exactly-one response is a bounded 400. Only Pi UI requests with method `confirm`, `select`, or `input` are ever approvable; other Pi UI requests are never registered. Success returns `200 {ok:true}` once the pending entry accepts delivery — the agent outcome is never fabricated or awaited. Unknown, stale, or already-settled requests reject with a bounded `409` (`Unknown or stale approval request ...`); an absent conversation or unwired capability is 404; unauthenticated requests are 401. Approve never writes a durable record and never consults manifest lifecycle status: a pending approval from an already-running run of an archived conversation stays answerable.
- `POST /api/conversations/<id>/abort` — abort the active run for exactly one conversation × agent key. Body `{agent}` (missing agent is a bounded 400); returns `200 {outcome}` with `status: "cancelled"` (exactly one durable `run_cancelled` is appended) or `"no-active-run"` (no run, or a duplicate abort). Abort never creates, attaches, dispatches, or switches a client and never consults manifest lifecycle status: an already-running run of an archived conversation remains abortable.
- `GET /api/conversations/<id>/events/stream` — scoped SSE for that one conversation only: live committed records as `event: conversation_event`, live pending approvals as `event: approval` (bounded `{conversationId, agent, requestId, method, payload}`), broker-authoritative transient run activity as `event: conversation_activity` (bounded `{conversationId, runId, agent, kind}` with `kind` one of `working`/`text_delta`/`settled`; `text_delta` carries a bounded `delta`, `settled` the terminal `outcome`), and live-only settle telemetry as `event: conversation_telemetry` (bounded `{conversationId, agent, runId}` plus the allowlisted facts described on the telemetry read route below), with heartbeat. Approval, activity, and telemetry frames are live-only: they are never durable conversation events, never appear in the historic events route, and are never replayed to a stream that subscribes after the frame was emitted. Historic events come from the events route; there is no replay.
- `GET /api/conversations/<id>/agents/<agent>/telemetry` — the explicit, read-only, on-demand telemetry read for one exact conversation × agent pair: `200` with `sessionState: "live"` plus bounded facts (`contextState` one of `ok`/`post_compaction_pending`/`no_window`, optional `context` `{tokens, contextWindow, percent}`, optional `model` `{provider, id}`, optional `thinkingLevel`, optional `autoCompactionEnabled`), or `200 {sessionState: "no_live_session"}` for every unavailable case. It never spawns or resumes a client, never reconstructs from history, never writes durable evidence, and never publishes SSE. The fact set is an exact allowlist: session ids/paths, token/cost totals, transcript content, and raw error payloads are never included.

Conversation runs execute on isolated conversation × agent Pi RPC clients through the conversation broker, never the global chat client. A steward message is persisted before dispatch and is never rolled back because a later dispatch conflicts or fails: each recipient gets a bounded run outcome (`completed`, `failed`, `timed_out`, or `cancelled`), and a message dispatch that hits an already-active run for the same conversation × agent returns 409 with a non-secret conflict message. Single-member default: in a conversation with exactly one durable audience member, a zero-mention steward message dispatches that sole member (first activation with no audience and no mention stays context-only; once the audience has two or more members, zero-mention messages are context-only and an explicit valid mention is required to dispatch). Automatic steer: a message targeting exactly one agent (one explicit validated mention, or the sole member via the single-member default) whose exact conversation × agent run is already active steers that live client via the existing Pi RPC `steer` capability and waits only the delivery ack — it creates no new run/queue/terminal/status/membership event, returns a truthful dispatch entry `steered` (or bounded `steer-failed` when Pi rejects after the message is durable), and falls back to normal dispatch when the run is not active; multi-recipient messages keep normal dispatch/conflict behavior and never guess which run to steer. There is no queue, retry, fallback, or reroute. Conversation state is recorded under `collaboration/conversations/`. A steward mention of a previously absent runnable agent grows the conversation's durable audience additively before dispatch; the growth is coordinated by a visible per-conversation lock (`.audience.lock`), and a contended audience update returns 409 before any event or dispatch. Before a run starts, the recipient agent receives a bounded replay of the prior conversation context (the 8 most recent durable messages up to 16 KB, in order) with an explicit truncation notice and inspectable selection metadata when the budget is hit; visible agent replies are recorded as immutable `agent_message` events.

Static UI:

- `GET /`
- `GET /<asset>`

All `/api/*` routes except `GET /api/auth/info` require Bearer auth when a gateway token is configured. JSON request bodies are capped at 1 MiB; oversized bodies return HTTP 413 before parsing.
