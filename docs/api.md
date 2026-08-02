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

- `POST /api/rooms` — create a room. Body `{title, participants?}`; returns `201 {room}` with the safe manifest shape (vault-relative path only).
- `GET /api/rooms` — list room manifests.
- `GET /api/rooms/<roomId>` — read one room manifest; unknown room returns 404.
- `GET /api/rooms/<roomId>/events` — validated chronological immutable event records.
- `GET /api/rooms/<roomId>/events/stream` — scoped SSE for that one room only: live committed records as `event: room_event`, live pending approvals as `event: approval`, with heartbeat. Historic events come from the events route; there is no replay.
- `POST /api/rooms/<roomId>/messages` — structured steward-to-one-agent mention. Body `{agent, text}` (the agent comes only from the body, never from text parsing); awaits the bounded run and returns `200 {outcome}`. A second mention for an active room × agent pair returns 409.
- `POST /api/rooms/<roomId>/abort` — abort the active run for exactly this room × agent; returns `200 {outcome}` (`cancelled` or `no-active-run`).
- `POST /api/rooms/<roomId>/approve` — forward an approval response to the exact pending room-agent request. Body `{agent, request_id}` plus exactly one of `confirmed`, `value`, or `cancelled`. Unknown or stale requests reject without reaching any other client.

Room runs execute on isolated room × agent Pi RPC clients through the room broker, never the global chat client. Validation, conflict, and shutdown semantics are recorded as immutable room events under `collaboration/rooms/` (see [vault layout](vault-layout.md)).

Static UI:

- `GET /`
- `GET /<asset>`

All `/api/*` routes except `GET /api/auth/info` require Bearer auth when a gateway token is configured. JSON request bodies are capped at 1 MiB; oversized bodies return HTTP 413 before parsing.
