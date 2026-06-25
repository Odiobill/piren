# Piren

Piren is a lightweight, local-first agent layer on top of Pi Coding Agent. It keeps agent identity, memory, logs, sessions, task exchange, and cumulative project knowledge in an inspectable Markdown vault.

Core thesis: Piren is not only an agent launcher or task queue. It is a knowledge-maintenance harness for a stewarded team of agents, merging LLM-Wiki and Second Brain workflows with explicit multi-agent task execution. Agents should leave structured artifacts that improve future work, while the steward can inspect current project status, decisions, runbooks, concepts, logs, and handoffs directly in the vault.

Current state: Phase 0, Phase 0.5, and Phase 1 single-agent hardening are complete. Phase 2 file-based task inbox is complete with device registration, one-file-per-task creation, `send_to_agent`, task status updates, explicit non-mutating inbox listing, explicit atomic task claiming, stale claim recovery from expired device heartbeats, opt-in worker-mode inbox polling, and `flag_steward` alert creation. Phase 3 is complete through tracer bullet 8 (session resume and abort). The web UI is minimal per ADR-0012 (no model/thinking controls in the UI, API routes kept for external integrations). Vault skills (ADR-0014) load shared and agent-specific procedures into the context prompt. Pi package extensibility (ADR-0013) lets installations declare npm packages that export Pi extensions, loaded as additional `--extension` flags. All proven against a fake Pi process.

Pinned Pi package: `@earendil-works/pi-coding-agent@0.79.9`.

Project coding-agent instructions live in `AGENTS.md`. Stable implementation rules belong there; phase-specific next-session context belongs in `/mnt/nas/Documents/vault/Projects/Piren/handoff-prompt.md`.

## What is implemented

CLI:

- `piren init`, via `node dist/src/cli.js init --vault-root <path>`
- `piren status`
- `piren agents`
- `piren doctor`
- `piren setup`
- `piren run` (alias `piren chat`), interactive Pi session
- `piren worker`, opt-in worker mode that starts Pi with Piren inbox polling enabled
- `piren gateway` (alias `piren web`), HTTP/SSE gateway that spawns Pi in RPC mode
- `piren ask "message"`, one-shot CLI prompt over the RPC client with live token streaming
- `piren clean`, dry-run removal of local Piren state; `--force` to actually delete

Pi extension commands:

- `piren_status`: reports selected agent, agent directory, vault root, runnable-agent policy, declared packages, vault availability, registered Piren tools, local outbox path, local cache path, cache availability, cache files, skills loaded, and current write mode.

Bootstrap:

- Preferred local installation config: `~/.config/piren/config.yml`
- Preferred config uses `vault_root` plus `allowed_agents`
- Runtime agent selection supports `--agent`, `-a`, and `PIREN_AGENT`
- If exactly one effective allowed agent exists, Piren can infer it
- Compatibility overrides remain: `--agent-dir`, `PIREN_AGENT_DIR`, and legacy `agent_dir`

Device registration:

- Starting the Piren Pi extension registers the selected local device under `team/<agent>/devices/<device>.json`.
- Device records include `device_id`, `hostname`, `priority`, `status`, `started_at`, and `last_seen`.
- `PIREN_DEVICE_ID` and `PIREN_HOSTNAME` can override the default sanitized hostname values in tests or supervised deployments.

Extension tools:

- `vault_read(path)`: reads UTF-8 files authoritatively from inside the vault boundary
- `vault_read_cached(path)`: explicitly reads UTF-8 files from the non-authoritative local cache
- `vault_write(path, content)`: atomically writes UTF-8 files inside the vault boundary
- `vault_list(path)`: lists files and directories with metadata, accepts `.` for vault root
- `vault_patch(path, old_text, new_text)`: replaces exactly one occurrence and rejects missing or ambiguous matches
- `vault_append_log(path, entry)`: appends timestamped Markdown log entries atomically
- `session_write_summary(summary, title?)`: writes timestamped Markdown summaries under `team/<agent>/sessions/`
- `send_to_agent(to, title, body)`: creates one pending Markdown task file under `team/<agent>/inbox/`
- `task_update_status(task_path, status, result?)`: updates a task file status (`pending`, `in_progress`, `completed`, or `cancelled`) and optionally replaces its `## Result` section
- `task_claim(task_path, device_id?, stale_after_ms?)`: claims a selected-agent inbox task by renaming it to `.claimed.<device>.md`; `device_id` defaults to the sanitized hostname. If `task_path` is already claimed, `stale_after_ms` enables recovery only when the previous claiming device record under `team/<agent>/devices/<device>.json` has an expired `last_seen` heartbeat
- `inbox_list()`: lists the selected local agent's unclaimed inbox tasks without claiming or mutating them
- `flag_steward(title, body, severity?, notify?)`: creates one authoritative Markdown alert file under `steward-inbox/alerts/` for steward attention
- `project_status(project)`: reads a project's current title, status, and updated date from `Projects/<project>/index.md` frontmatter (read-only)
- `project_append_log(project, entry)`: appends a timestamped Markdown entry to `Projects/<project>/log.md`, attributed to the current agent
- `decision_record(project, id, title, context, decision, consequences?, alternatives?)`: writes one ADR under `Projects/<project>/decisions/ADR-<id>-<slug>.md` (id must be a 4-digit number)

Knowledge lifecycle tools (Phase 4) let agents leave durable artifacts after non-trivial work, per the ADR-0010 thesis: `project_status` reads current project state, `project_append_log` records chronological project history, and `decision_record` captures architecture decisions.

Degraded write handling:

- `vault_write` checks that the vault root is available before writing.
- A vault root is recognized by `.piren-vault`, or by fallback shape `steward-directives.md` plus `team/`.
- If the vault is unavailable or the authoritative write fails, Piren queues a proposed write into a local outbox instead of silently creating authoritative state elsewhere.
- The Pi extension default local outbox is `~/.local/state/piren/outbox/<agent>`.
- Tests and local launches can override it with `PIREN_LOCAL_OUTBOX_DIR`.
- Path traversal outside the vault is still rejected, not queued.

Explicit cached reads:

- `piren_status` reports the local cache directory and whether cache files are available.
- The default local cache directory is `~/.local/state/piren/cache/<agent>`.
- Tests and local launches can override it with `PIREN_LOCAL_CACHE_DIR`.
- `vault_read_cached(path)` reads only from that non-authoritative cache and returns `cached: true` plus `authoritative: false` details.
- `vault_read(path)` remains authoritative by default.
- Piren does not automatically populate the cache and does not perform sync-later conflict resolution.

## Verify

```bash
npm install
npm test
npm run typecheck
npm run build
npm run smoke
```

Expected current baseline:

```text
Test Files  35 passed (35)
Tests       236 passed (236)
SMOKE PASSED
```

## Initialize a test vault

After `npm run build`, create a disposable Piren vault in any directory:

```bash
node dist/src/cli.js init --vault-root /tmp/piren-vault
```

The default first agent is `piren`. Specify a different first agent explicitly when needed:

```bash
node dist/src/cli.js init --vault-root /tmp/piren-vault --agent thor
```

This creates:

```text
/tmp/piren-vault/
├── .piren-vault
├── steward-directives.md
├── steward-inbox/alerts/
├── wiki/{concepts,entities,runbooks,inbox}/
├── skills/
├── templates/
└── team/piren/
    ├── SOUL.md
    ├── MEMORY.md
    ├── config.yml
    ├── inbox/
    ├── outbox/
    ├── devices/
    ├── logs/
    ├── sessions/
    └── skills/
```

## Preferred local installation config

Create `~/.config/piren/config.yml`:

```yaml
vault_root: /tmp/piren-vault
allowed_agents:
  - piren
```

Local installation authority belongs here:

```yaml
vault_root: /path/to/vault
allowed_agents:
  - piren
excluded_agents:
  - other-agent
packages:
  - "@piren/web-search"
  - "@piren/git-tools"
```

Do not put `allowed_agents` in `team/<agent>/config.yml`. Agent-local config is for runtime preferences such as model and polling.

With exactly one effective allowed agent, the CLI can infer the agent:

```bash
node dist/src/cli.js status
```

Or select it explicitly:

```bash
PIREN_AGENT=piren node dist/src/cli.js status
node dist/src/cli.js --agent piren status
node dist/src/cli.js -a piren status
```

You can also pass the vault root directly, useful for disposable test vaults without touching `~/.config/piren/config.yml`:

```bash
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren status
```

Low-level compatibility override, mostly for smoke tests and debugging:

```bash
PIREN_AGENT_DIR=/tmp/piren-vault/team/piren node dist/src/cli.js status
node dist/src/cli.js --agent-dir /tmp/piren-vault/team/piren status
```

## List agents

`piren agents` lists vault-defined agents and marks which ones are runnable on this local installation:

```bash
node dist/src/cli.js agents
node dist/src/cli.js --vault-root /tmp/piren-vault agents
```

Output labels:

- `[runnable]`: defined in the vault and allowed by local policy.
- `[vault-only]`: defined in the vault but not runnable here under the current allow/exclude policy.
- `[stale]`: directory exists under `team/` but is missing `SOUL.md` or `MEMORY.md`.
- `[missing]`: listed in local `allowed_agents`, but no matching `team/<agent>/` directory exists in the vault.

The command reads local installation policy from `~/.config/piren/config.yml`. It does not select or start an agent and does not mutate the vault. When `allowed_agents` is empty, it prints a warning that any vault agent can run.

## Run a Piren agent through Pi

```bash
node dist/src/cli.js run
PIREN_AGENT=piren node dist/src/cli.js run
node dist/src/cli.js --agent piren run
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren run
```

`piren chat` is an alias for `piren run`: same interactive Pi session, same behavior.

For opt-in worker mode, use `worker` instead of `run`:

```bash
node dist/src/cli.js worker
PIREN_AGENT=piren node dist/src/cli.js worker
node dist/src/cli.js --agent piren worker
```

Worker mode sets `PIREN_WORKER=1` for the Pi extension. The extension polls the selected agent inbox once at session start and then at the configured active interval. Polling is disabled unless the selected agent is explicitly listed in local `allowed_agents`, and default interactive `run` does not poll.

`run` reads `team/<agent>/config.yml` and translates agent-local model preferences to Pi-native flags:

```yaml
model:
  id: anthropic/claude-sonnet-4-20250514
  thinking: medium
```

becomes:

```bash
npx pi --extension ./src/pi-extension.ts --vault-root /tmp/piren-vault --agent piren --model anthropic/claude-sonnet-4-20250514:medium
```

Expanded model config is also supported:

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-20250514
  thinking: medium
```

Model cycling config is supported through Pi `--models`:

```yaml
models:
  - provider: anthropic
    id: claude-sonnet-4-20250514
    thinking: medium
  - provider: openai
    id: gpt-4.1
    thinking: off
```

Forward extra Pi args after `--`:

```bash
node dist/src/cli.js run -- --print "hello"
```

If Piren does not pass `--model`, Pi falls back to `~/.pi/agent/settings.json` and `~/.pi/agent/auth.json`. Custom providers and model definitions remain Pi-native under `~/.pi/agent/models.json`.

## Setup

`piren setup` inspects onboarding readiness without changing any files (dry-run default):

```bash
node dist/src/cli.js setup
node dist/src/cli.js --agent piren setup
```

It checks local installation config, runnable-agent policy, selected agent-local config, and Pi settings/auth presence. It does not repair or create config files by default.

To scaffold a missing `~/.config/piren/config.yml`, use `--apply` with `--vault-root` and `--agent`:

```bash
node dist/src/cli.js setup --apply --vault-root /tmp/piren-vault --agent piren
```

Apply writes `vault_root` and `allowed_agents` into the config file only when it is absent or missing both keys.

When apply is requested, it also scaffolds a missing `team/<agent>/config.yml` with default model preferences (Claude Sonnet 4, medium thinking). Existing agent-local config is never overwritten.

`--apply` does not touch the vault. Dry-run inspection remains the default.

## Doctor

`piren doctor` inspects without repairing:

```bash
node dist/src/cli.js doctor
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren doctor
```

It reports:

- Runnable-agent policy
- Vault layout
- Required agent files
- Pi package compatibility
- Package validation: warns when declared packages are not installed (missing packages are listed by name)
- Policy-gap warning when `allowed_agents` is empty with a configured vault_root (effectively allow-all)
- Stale-allowed warning when `allowed_agents` lists agents not found as vault `team/` directories
- Policy-overlap warning when agents appear in both `allowed_agents` and `excluded_agents`
- Invalid-agent-name warning when `allowed_agents` entries don't match the required lowercase-kebab pattern

It exits non-zero when any check fails.

## Gateway RPC client (Phase 3 tracer bullet 1)

The gateway is a separate process that drives Pi over RPC. It never imports Pi in-process. Tracer bullet 1 proves the RPC path end to end with no HTTP yet.

`buildPiRunCommand({ rpcMode: true })` constructs the Pi launch command with `--mode rpc` appended and `stdio: "pipe"` instead of `inherit`:

```text
npx pi --extension ./src/pi-extension.ts --vault-root <vault> --agent <agent> --model <model> --mode rpc
```

`PiRpcClient` (in `src/gateway-rpc.ts`) takes a spawn target, starts Pi with piped stdio, and speaks strict LF-only JSONL:

- Framing splits on `\n` only, never readline (readline wrongly splits on U+2028/U+2029 that are valid inside JSON strings). See `src/jsonl.ts`.
- Commands are paired with their ack `response` lines by an assigned `id`.
- `promptAndWait(message)` subscribes for events before sending the prompt, then drains the stream until `agent_end`.
- Token deltas are nested inside `message_update.assistantMessageEvent.text_delta`. `extractAssistantText(events)` assembles assistant text from those nested deltas. There is no flat token event.

The client is exercised against a fake Pi process (`tests/fixtures/fake-pi-rpc.cjs`) so the prompt-to-`agent_end` round trip needs no live model auth. The smoke script runs the same round trip plus the `--mode rpc` command construction.

The HTTP/SSE transport, read-only vault browser, model/thinking control, steering, approval gates, and non-localhost token auth are later tracer bullets that build on this client. See `gateway-web-ui.md` for the sequencing and the verified protocol.

## Gateway web server (Phase 3 tracer bullet 2)

`piren gateway` (alias `piren web`) starts the HTTP/SSE server on the proven RPC client. It spawns Pi in `--mode rpc` as a separate process, never importing Pi in-process. Default bind is localhost.

```bash
node dist/src/cli.js gateway
PIREN_AGENT=piren node dist/src/cli.js gateway
node dist/src/cli.js --agent piren gateway --port 7317 --host 127.0.0.1
```

Two endpoints, the POST-start plus GET-stream split:

- `POST /api/chat/start` with JSON `{ "message": "..." }` starts the RPC prompt and returns `{ "stream_id": "..." }` immediately. A missing or empty message returns 400.
- `GET /api/chat/stream?stream_id=...` opens a long-lived `text/event-stream` and drains bridge-translated events until `done` or `error`. A heartbeat comment is sent every 30 seconds. An unknown stream id returns 404.

SSE event taxonomy for v1: `token` (assistant text deltas, nested inside Pi `message_update.assistantMessageEvent.text_delta`), `tool` (start/end phases), `done` (turn complete), `error` (RPC failure or agent crash). `reasoning`, `approval`, and `queue` are later bullets.

The bridge lives in `src/gateway-bridge.ts` (`piEventToSse`); the server lives in `src/gateway-http.ts` (`GatewayServer`). Both are tested against the fake Pi process so the round trip needs no live model auth. The smoke script runs the same HTTP/SSE round trip.

The default bind is `127.0.0.1`. On localhost, auth is optional for friction-free local development. Binding to a non-localhost host (LAN exposure) requires a shared bootstrap token; if none is found, the gateway auto-generates one, persists it to `~/.config/piren/gateway-token`, and prints it to the console once. See the Auth section below.

## Gateway auth token gate (Phase 3 tracer bullet 6)

A shared bootstrap token gates the gateway. On localhost (the default bind), auth is optional for friction-free local development. On any non-localhost bind, the token is required and the gateway refuses to start without one.

Token resolution priority: `--token` CLI flag > `PIREN_TOKEN` env var > `~/.config/piren/gateway-token` file > auto-generate (non-localhost only). If auto-generated on first run, the token is printed to the console once and persisted to `~/.config/piren/gateway-token` (mode 0o600).

```bash
# Localhost, no token needed (friction-free dev):
node dist/src/cli.js gateway

# LAN exposure: auto-generates and prints a token:
node dist/src/cli.js gateway --host 0.0.0.0

# Provide a token explicitly:
node dist/src/cli.js gateway --host 0.0.0.0 --token my-secret
PIREN_TOKEN=my-secret node dist/src/cli.js gateway --host 0.0.0.0
```

Transport is plain `Authorization: Bearer *** on API requests. When a token is configured, all `/api/*` routes except `GET /api/auth/info` require a matching Bearer header or return 401. The token comparison is constant-time (XOR accumulator) to prevent timing attacks. `GET /api/auth/info` is always public and returns `{authRequired: boolean}` so the frontend knows whether to prompt.

The static frontend stores the token in memory and attaches it to fetch calls. Finer per-user identity, login pages, and passkeys are deferred.

## Web UI (Phase 3 frontend, minimal per ADR-0012)

The gateway serves a vanilla JS web UI (no framework, no build step) from the `public/` directory. When you start `piren gateway`, point a browser at `http://127.0.0.1:7317/` (or your `--port`).

The integrated UI is intentionally minimal. It is an emergency interface for when there is no SSH or other gateway available, not a primary workspace. Rich external solutions can be built on the HTTP API.

The UI provides:

- **Agent selection**: switch between runnable agents (enforced by local installation policy).
- **Chat with streaming**: send messages, see tokens stream live via SSE, tool execution cards, and error display.
- **Steering and follow-up**: interrupt a running turn with Steer, or queue a follow-up message.
- **Approval gates**: when the agent requests confirmation, an approval panel appears with Confirm/Cancel buttons.
- **Vault browser**: browse vault directories and read files read-only, with path-boundary enforcement.
- **Read-only context indicator**: shows current model, thinking level, streaming status, and message count as static text sourced from `get_state`. Not editable from the UI.
- **Auth**: when a token is configured, an auth overlay prompts for the token on load. The token is stored in memory and attached to all API requests.

The UI does **not** provide model selection, thinking level control, or any configuration that belongs in `team/<agent>/config.yml`. The vault is the single source of truth. The model/thinking/agent-switch API routes remain available for external integrations.

Static file serving is built into `GatewayServer` via the `publicDir` option. API routes always take priority over static files. The build step copies `public/` to `dist/public/` so the path resolves correctly whether running from source (tsx) or compiled (dist).

## Session resume and abort (Phase 3 tracer bullet 8)

The gateway exposes four session-management routes built on Pi's native RPC capabilities (`abort`, `get_messages`, `switch_session`):

- `POST /api/chat/abort` aborts the active turn mid-stream. The abort RPC command emits `agent_end`, which drains any active SSE stream so it closes cleanly. Returns `{ok: true}`. There is no dedicated abort stream: the outcome is observed on the existing stream bound to the active turn.
- `GET /api/chat/messages` returns the full transcript of the current Pi session as `{messages: [...]}`. Used to repopulate the chat view after a browser refresh so the steward reattaches to prior context. Message shapes are provider-specific.
- `POST /api/chat/resume` with JSON `{sessionPath: "..."}` resumes a past Pi session by its on-disk path. Returns `{cancelled: boolean}` so the frontend can fall back gracefully when Pi could not resume the requested session. A missing or empty `sessionPath` returns 400.
- `GET /api/chat/sessions` lists past session summaries from the vault under `team/<currentAgent>/sessions/` as `{agent, sessions: [{name, path, title, created, bytes, mtimeMs}]}`. These are the agent's recorded conversations (written by `session_write_summary`), newest-first. Requires both `vaultRoot` and a current agent; returns 404 otherwise.

The frontend uses these three ways: on load it calls `GET /api/chat/messages` to repopulate the transcript (so a browser refresh reattaches to context) and `GET /api/chat/sessions` to fill the sidebar session list; the composer has an Abort button that calls `POST /api/chat/abort` to stop a runaway turn.

The transcript model stays hybrid per ADR-0011: Pi owns the live transcript and supports resume; the agent writes summaries to `team/<agent>/sessions/` via the existing `session_write_summary` tool. There is no duplicate authority.

Core session-listing logic lives in `src/session-browser.ts` (`listAgentSessions`), which parses session-summary frontmatter (title from the first `# Heading`, `created` from YAML frontmatter) and reuses `resolveVaultPath` for path-boundary enforcement. Tests: `tests/session-browser.test.ts` (5 tests), `tests/gateway-rpc-session.test.ts` (4 tests), `tests/gateway-session-routes.test.ts` (9 tests).

## Vault skills (ADR-0014)

The Piren extension loads reusable procedures (skills) from the vault at startup and injects them into the agent's context prompt. Skills are Markdown files with optional YAML frontmatter, not executable code. The agent follows a skill's steps when the steward asks or when a task matches.

Two skill locations:

- `vault/skills/` - shared skills, available to all agents.
- `team/<agent>/skills/` - agent-specific skills, available only to that agent. Agent-specific skills override shared skills with the same name.

Each skill is either a loose `.md` file or a directory containing `SKILL.md`. Frontmatter fields: `name` (falls back to filename stem), `description` (one-line summary). The loader is tolerant: missing directories return an empty list, malformed frontmatter does not crash.

The loaded skills appear in the context prompt as an "Available Skills" section with each skill's name, source (shared/agent), description, and full body. `piren_status` reports `skills_loaded: <count>`.

Core logic lives in `src/skills.ts` (`loadVaultSkills`, `formatSkillsForContext`). Tests: `tests/skills.test.ts` (9 tests). The extension wiring is tested in `tests/pi-extension.test.ts` (context injection + status count).

## Pi package extensibility (ADR-0013)

Piren core stays minimal. Additional capabilities come from npm packages that export Pi extensions, declared in `~/.config/piren/config.yml` under the `packages` field. `buildPiRunCommand` resolves each declared package to its installed entry point via `require.resolve` and appends it as an additional `--extension` flag to the Pi command. Piren's core extension loads first; package extensions load after, in declaration order.

```yaml
# ~/.config/piren/config.yml
vault_root: /path/to/vault
allowed_agents:
  - piren
packages:
  - "@piren/web-search"
  - "@piren/git-tools"
```

This produces:

```text
npx pi \
  --extension ./src/pi-extension.ts \
  --extension @piren/web-search \
  --extension @piren/git-tools \
  --vault-root /path/to/vault \
  --agent piren
```

`piren doctor` validates that all declared packages are installed and reports missing ones (status `warn`, not fail). `piren_status` reports declared packages. Missing packages are skipped at run time rather than crashing: `buildPiRunCommand` only appends `--extension` flags for packages that resolve successfully, while `piren doctor` surfaces the gaps for the steward to fix.

Package code lives in `node_modules/` (installed by npm), not in the vault. The vault does not store package code, but the installation config records which packages are used, so any installation with the same `packages` list and `npm install` can reproduce the same toolset.

Core logic lives in `src/packages.ts` (`resolvePackages`, `defaultPackageResolver`). Tests: `tests/packages.test.ts` (5 tests). The `buildPiRunCommand` wiring is tested in `tests/run.test.ts`, the doctor validation in `tests/doctor.test.ts`, and the status reporting in `tests/pi-extension.test.ts`.

## Read-only vault browser (Phase 3 tracer bullet 3)

The gateway serves a read-only vault browser at two endpoints:

- `GET /api/vault/list?path=...` returns the children of a vault directory as JSON. Dirs first, alpha-sorted, capped at 100 entries, dotfiles hidden. `path` defaults to the vault root when empty or omitted.
- `GET /api/vault/read?path=...` returns file content as JSON, size-capped at 500 KB. Files over the cap return the first 500 KB plus a truncation notice.

Both routes reuse `resolveVaultPath` from `src/vault-tools.ts` for hard path-boundary enforcement. Path traversal outside the vault root returns 403. No writes, renames, or deletes in v1.

The navigation model: for curated subtrees (Projects, wiki/concepts, wiki/entities, decisions, runbooks), the browser surface prefers rendering `index.md`; for operational directories (inbox, sessions, devices, logs, alerts, outbox) and whenever `index.md` is missing, it falls back to directory listing. Both are served keyed on directory content; the server does not auto-generate index.md.

`vaultRoot` is wired in from the CLI: `piren gateway` loads the Piren context via `loadPirenContext`, then passes `context.vaultRoot` to `GatewayServer` alongside the RPC target. The core logic lives in `src/vault-browser.ts` (`vaultBrowserList`, `vaultBrowserRead`) and the routes are added to `GatewayServer` in `src/gateway-http.ts`.

Tests: `tests/vault-browser.test.ts` exercises list, read, path traversal rejection, and entry capping against a fake fixture vault.

## CLI ask over RPC

`piren ask` sends a single message to a Pi agent over the RPC client and streams tokens live to the terminal. It uses the same `PiRpcClient` as the gateway.

```bash
node dist/src/cli.js ask "Hello, how are you?"
PIREN_AGENT=piren node dist/src/cli.js ask "What files are in the vault root?"
node dist/src/cli.js --agent piren --vault-root /tmp/piren-vault ask "List my inbox tasks"
```

`ask` is a one-shot: it spawns Pi in `--mode rpc`, streams `text_delta` tokens to stdout as they arrive, and exits after the turn completes. For interactive sessions, use `piren run`. The core logic lives in `src/ask.ts` (`askAgent`) and is wired into the CLI. Tests: `tests/ask.test.ts` against the fake Pi process.

## Clean and uninstall

`piren clean` removes Piren's local state (`~/.config/piren/` and `~/.local/state/piren/`). Dry-run by default:

```bash
piren clean          # preview what would be removed
piren clean --force  # actually delete
```

To fully uninstall:

```bash
piren clean --force
npm uninstall -g piren
```

## Design boundaries

Piren v1 intentionally stays small:

- One agent first
- Explicit vault tools, not transparent shell or file interception
- Local installation authority in `~/.config/piren/config.yml`
- Agent-local runtime preferences in `team/<agent>/config.yml`
- Pi remains responsible for model/provider auth and settings
- Phase 1 single-agent hardening is complete: diagnostics, policy checks, setup scaffolding, and stale-agent detection
- Phase 2 (file-based inbox) is complete: device registration writes heartbeat JSON under `team/<agent>/devices/`, `send_to_agent` creates one pending Markdown task file in the target agent inbox, `task_update_status` updates task status and optional result text, `inbox_list` lists the selected agent's unclaimed inbox tasks, `task_claim` claims a task by filesystem rename, stale claim recovery reclaims `.claimed.<device>.md` files only after the previous device heartbeat expires, `piren worker` enables opt-in worker-mode inbox polling for explicitly allowed local agents, and `flag_steward` creates authoritative steward alert files
- Phase 3 (external gateway) is in progress: tracer bullet 1 added `buildPiRunCommand({ rpcMode: true })` activating `--mode rpc` with piped stdio plus `PiRpcClient` in `src/gateway-rpc.ts` (separate process, strict LF-only JSONL, drains events until `agent_end`); tracer bullet 2 added the HTTP/SSE transport `piren gateway` (`src/gateway-http.ts` `GatewayServer`, `src/gateway-bridge.ts` `piEventToSse`) with POST-start/GET-stream; tracer bullet 3 added the read-only vault browser (`GET /api/vault/list`, `GET /api/vault/read`, core logic in `src/vault-browser.ts`) reusing `resolveVaultPath` for path-boundary enforcement; tracer bullets 4 and 5 added model/thinking control, agent switching, steering, and approval gates; tracer bullet 6 added the auth token gate (`src/gateway-auth.ts`) for non-localhost binds with constant-time Bearer token matching. No WebSocket, no frontend framework.
- No automatic inbox polling in default interactive sessions
- No in-process Pi embedding: the gateway always spawns Pi in RPC mode
- No memory automation yet
