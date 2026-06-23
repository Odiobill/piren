# Piren

Piren is a lightweight, local-first agent layer on top of Pi Coding Agent. It keeps agent identity, memory, logs, sessions, task exchange, and cumulative project knowledge in an inspectable Markdown vault.

Core thesis: Piren is not only an agent launcher or task queue. It is a knowledge-maintenance harness for a stewarded team of agents, merging LLM-Wiki and Second Brain workflows with explicit multi-agent task execution. Agents should leave structured artifacts that improve future work, while the steward can inspect current project status, decisions, runbooks, concepts, logs, and handoffs directly in the vault.

Current state: Phase 0, Phase 0.5, and Phase 1 single-agent hardening are complete. Phase 2 file-based task inbox is complete with device registration, one-file-per-task creation, `send_to_agent`, task status updates, explicit non-mutating inbox listing, explicit atomic task claiming, stale claim recovery from expired device heartbeats, opt-in worker-mode inbox polling, and `flag_steward` alert creation. Phase 3 has started with tracer bullet 1: a gateway RPC client that spawns Pi in `--mode rpc` and streams a response over strict LF-only JSONL, proven against a fake Pi process (no HTTP yet).

Pinned Pi package: `@earendil-works/pi-coding-agent@0.79.9`.

Project coding-agent instructions live in `AGENTS.md`. Stable implementation rules belong there; phase-specific next-session context belongs in `/mnt/nas/Documents/vault/Projects/Piren/handoff-prompt.md`.

## What is implemented

CLI:

- `piren init`, via `node dist/src/cli.js init --vault-root <path>`
- `piren status`
- `piren agents`
- `piren doctor`
- `piren setup`
- `piren run`
- `piren worker`, opt-in worker mode that starts Pi with Piren inbox polling enabled

Pi extension commands:

- `piren_status`: reports selected agent, agent directory, vault root, runnable-agent policy, vault availability, registered Piren tools, local outbox path, local cache path, cache availability, cache files, and current write mode.

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
Test Files  15 passed (15)
Tests       67 passed (67)
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

## Design boundaries

Piren v1 intentionally stays small:

- One agent first
- Explicit vault tools, not transparent shell or file interception
- Local installation authority in `~/.config/piren/config.yml`
- Agent-local runtime preferences in `team/<agent>/config.yml`
- Pi remains responsible for model/provider auth and settings
- Phase 1 single-agent hardening is complete: diagnostics, policy checks, setup scaffolding, and stale-agent detection
- Phase 2 (file-based inbox) is complete: device registration writes heartbeat JSON under `team/<agent>/devices/`, `send_to_agent` creates one pending Markdown task file in the target agent inbox, `task_update_status` updates task status and optional result text, `inbox_list` lists the selected agent's unclaimed inbox tasks, `task_claim` claims a task by filesystem rename, stale claim recovery reclaims `.claimed.<device>.md` files only after the previous device heartbeat expires, `piren worker` enables opt-in worker-mode inbox polling for explicitly allowed local agents, and `flag_steward` creates authoritative steward alert files
- Phase 3 (external gateway) has started with the RPC spike: `buildPiRunCommand({ rpcMode: true })` activates `--mode rpc` with piped stdio, and `PiRpcClient` in `src/gateway-rpc.ts` spawns Pi as a separate process, speaks strict LF-only JSONL, and drains streaming events until `agent_end`. No HTTP yet
- No automatic inbox polling in default interactive sessions
- No in-process Pi embedding: the gateway always spawns Pi in RPC mode
- No memory automation yet
