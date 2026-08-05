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
- `piren telegram`
- `piren discord`
- `piren ask "message"`
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

OpenAI-compatible:

- `POST /api/v1/chat/completions`

Collaboration rooms (available when the gateway is wired with a vault root, runnable agents, and an agent target builder; otherwise all room routes return 404):

- `GET /api/room-agents` — the vault-agent roster for the workbench: `{agents: [{name, online}]}`, deterministically sorted by name. Names come from the vault-defined `team/<agent>/` roster supplied to the gateway at startup; `online` is local installation policy only — membership in this gateway's resolved runnable set — never Pi-process presence, provider reachability, transport state, or identity. An empty supplied roster returns `[]`. The route reveals no config, tokens, groups, or diagnostics and starts no Pi clients.
- `POST /api/rooms` — create a room. Body `{title, participants?}`; returns `201 {room}` with the safe manifest shape (vault-relative path only). Every explicitly supplied participant must be in the gateway's runnable set; offline/non-runnable participants are rejected with the non-secret 400 participant/runnable semantics, so the offline UI rule is not bypassable by a direct POST.
- `GET /api/rooms` — list room manifests.
- `GET /api/rooms/<roomId>` — read one room manifest; unknown room returns 404.
- `GET /api/rooms/<roomId>/events` — validated chronological immutable event records.
- `GET /api/rooms/<roomId>/events/stream` — scoped SSE for that one room only: live committed records as `event: room_event`, live pending approvals as `event: approval`, with heartbeat. Historic events come from the events route; there is no replay.
- `POST /api/rooms/<roomId>/messages` — structured steward-to-one-agent mention. Body `{agent, text}` (the agent comes only from the body, never from text parsing); awaits the bounded run and returns `200 {outcome}`. A second mention for an active room × agent pair returns 409.
- `POST /api/rooms/<roomId>/abort` — abort the active run for exactly this room × agent; returns `200 {outcome}` (`cancelled` or `no-active-run`).
- `POST /api/rooms/<roomId>/approve` — forward an approval response to the exact pending room-agent request. Body `{agent, request_id}` plus exactly one of `confirmed`, `value`, or `cancelled`. Unknown or stale requests reject without reaching any other client.

Room runs execute on isolated room × agent Pi RPC clients through the room broker, never the global chat client. Validation, conflict, and shutdown semantics are recorded as immutable room events under `collaboration/rooms/` (see [vault layout](vault-layout.md)).

Agent-to-agent handoff (`room_mention`): within a broker-spawned room run only, the lead agent may call the reserved `room_mention(to, text)` extension tool to ask one permitted room participant for bounded help. The tool exists only inside flagged broker-spawned room runs (root leads and handoff workers); it is never registered for ordinary gateway/transport/ask/worker processes and is never triggered by rendered `@text`. Limits are fixed: at most one accepted handoff per steward root, at most one depth level (a worker cannot hand off again), and no repeated source → target pair in a root. The accepted handoff appends an immutable `agent_message` handoff record (author: lead, `addressed_agent`: worker, correlated to the steward root) and the worker's run records correlate to that handoff event, never directly to the root. There is no queue, retry, catch-up, or fallback; a rejected or failed handoff returns a bounded non-secret tool error. The reserved internal handoff request is not an approval: it never appears as `event: approval` on the room SSE stream and cannot be answered through `POST /api/rooms/<roomId>/approve`. The PWA/room workbench remains a later slice (R3) and is not implemented yet.

Conversations (available when the gateway is wired with a vault root, runnable agents, and an agent target builder; otherwise all conversation routes return 404):

- `GET /api/conversations` — list conversation manifests, newest-first.
- `GET /api/conversations/<id>` — read one conversation manifest and its additive `audience` (the members who joined through validated `@`-mentions). Read-only; always allowed regardless of member runnability.
- `POST /api/conversations` — create and send the first message in one request. Body `{text}`; returns `201 {conversation, event, dispatch?}`. The first message activates and persists the conversation even with zero mentions (nothing is dispatched then). There is no standalone title-only create route: a conversation only exists after its first message. Mentions are parsed and validated by the gateway alone against the local runnable-agent set; an unknown, excluded, or non-runnable mention fails the whole request with 400 before anything is written.
- `POST /api/conversations/<id>/messages` — append a raw-text steward message to an open conversation; returns `200 {event, dispatch?}` with the same mention validation. An archived conversation rejects message append with 409.
- `GET /api/conversations/<id>/events` — the validated chronological immutable event records (durable history).
- `GET /api/conversations/<id>/events/stream` — scoped SSE for that one conversation only: live committed records as `event: conversation_event`, with heartbeat. Historic events come from the events route; there is no replay.

Conversation runs execute on isolated conversation × agent Pi RPC clients through the conversation broker, never the global chat client. A steward message is persisted before dispatch and is never rolled back because a later dispatch conflicts or fails: each recipient gets a bounded run outcome (`completed`, `failed`, `timed_out`, or `cancelled`), and a message dispatch that hits an already-active run for the same conversation × agent returns 409 with a non-secret conflict message. There is no queue, retry, fallback, or reroute. Conversation state is recorded under `collaboration/conversations/` as a sibling of the room tree; room data is never touched. A steward mention of a previously absent runnable agent grows the conversation's durable audience additively before dispatch; the growth is coordinated by a visible per-conversation lock (`.audience.lock`), and a contended audience update returns 409 before any event or dispatch. Before a run starts, the recipient agent receives a bounded replay of the prior conversation context (the 8 most recent durable messages up to 16 KB, in order) with an explicit truncation notice and inspectable selection metadata when the budget is hit; visible agent replies are recorded as immutable `agent_message` events.

Static UI:

- `GET /`
- `GET /<asset>`

All `/api/*` routes except `GET /api/auth/info` require Bearer auth when a gateway token is configured. JSON request bodies are capped at 1 MiB; oversized bodies return HTTP 413 before parsing.
