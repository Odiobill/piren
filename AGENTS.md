# Piren Agent Instructions

These instructions apply to agents working in this source repository:

```text
/home/davide/src/piren
```

They are stable project implementation rules. Keep phase-specific handoff details in the vault handoff prompt, not here.

## Required context before coding

Before non-trivial implementation work:

1. Load relevant skills:
   - `test-driven-development` for production behavior changes.
   - `pi-coding-agent-extensions` for Pi extension, CLI, tool, smoke, or package work.
2. Read the Piren vault project docs, at minimum:
   - `/mnt/nas/Documents/vault/Projects/Piren/index.md`
   - `/mnt/nas/Documents/vault/Projects/Piren/knowledge-lifecycle.md`
   - `/mnt/nas/Documents/vault/Projects/Piren/implementation-plan.md`
   - `/mnt/nas/Documents/vault/Projects/Piren/handoff-prompt.md`
3. For architecture or authority-boundary changes, also read:
   - `/mnt/nas/Documents/vault/Projects/Piren/architecture.md`
   - `/mnt/nas/Documents/vault/Projects/Piren/bootstrap-config.md`
   - `/mnt/nas/Documents/vault/Projects/Piren/vault-protocol.md`
   - `/mnt/nas/Documents/vault/Projects/Piren/runtime-placement.md`

## Product thesis to preserve

Piren is not only an agent launcher or task queue. It is a vault-backed team knowledge substrate for a stewarded team of agents, merging LLM-Wiki and Second Brain workflows with explicit multi-agent task execution.

Until the first release candidate, preserve the thesis in:

```text
/mnt/nas/Documents/vault/Projects/Piren/knowledge-lifecycle.md
/mnt/nas/Documents/vault/Projects/Piren/decisions/ADR-0010-vault-as-team-knowledge-substrate.md
```

Every non-trivial task should consider its knowledge delta. Update the minimum useful durable artifact, not everything.

Preferred artifact order:

```text
raw task/session evidence
  -> summary or result
  -> project log
  -> current project docs or handoff
  -> ADR, runbook, wiki page, or skill candidate
```

Raw task/session traces are evidence. Current project docs and ADRs are synthesized truth.

## Architecture boundaries

Keep Piren v1 boring:

- Explicit vault tools, not transparent shell/file interception.
- One file per task.
- Append-only logs where practical.
- External gateway later, through a separate RPC process.
- Pinned Pi compatibility.
- No hidden memory mutation.

Do not add default automatic inbox polling to interactive `piren run`. Polling belongs only to opt-in worker mode:

```text
piren worker
PIREN_WORKER=1
```

Worker polling must only run for agents explicitly allowed by local installation policy.

## Authority boundaries

Local installation authority lives outside the vault:

```text
~/.config/piren/config.yml
```

This is where these belong:

```yaml
vault_root: /path/to/vault
allowed_agents:
  - piren
excluded_agents:
  - other-agent
```

Agent-local preferences live in:

```text
team/<agent>/config.yml
```

Use agent-local config only for runtime preferences such as model and polling. Do not put `allowed_agents` there.

Piren-owned machine-local secrets or config belong under `~/.config/piren/`. Provider credentials and custom model definitions stay provider-native, for example Pi under:

```text
~/.pi/agent/auth.json
~/.pi/agent/settings.json
~/.pi/agent/models.json
```

Do not put `.env` under `team/<agent>/`.

Do not put `AGENTS.md` under `team/<agent>/`. Piren identity is `SOUL.md`. Project `AGENTS.md` files belong in source repositories like this one.

## Development workflow

Use strict TDD for production behavior changes:

1. Write one failing test for the next tracer bullet.
2. Run the specific test and confirm the expected failure.
3. Implement minimal production code.
4. Run the specific test and confirm it passes.
5. Run the full verification baseline.
6. Update README and relevant vault docs.
7. Search for stale baselines and stale next-step wording.

Keep core logic testable without live Pi auth. Use fake filesystem tests and the fake Pi harness for extension behavior.

Separate core logic from Pi adaptation:

- Core modules should be callable directly from tests.
- Pi extension code should mostly adapt registered tool params to core helpers.
- Avoid hiding important behavior in lifecycle hooks when it can be tested directly.

## Verification commands

From repository root:

```bash
cd /home/davide/src/piren
npm test -- tests/<specific>.test.ts
npm test
npm run typecheck
npm run build
npm run smoke
```

Current baseline after Phase 3 tracer bullet 2:

```text
Test Files  17 passed (17)
Tests       79 passed (79)
SMOKE PASSED
```

Smoke and tests must not depend on Davide's real `~/.config/piren/config.yml` unless explicitly testing local installation config.

## Current implementation surface

Phase 0, Phase 0.5, Phase 1, and Phase 2 are complete. Phase 3 is in progress: tracer bullet 1 (RPC client) and tracer bullet 2 (HTTP/SSE transport) are done.

Gateway RPC surface (Phase 3, `src/gateway-rpc.ts`):

- `buildPiRunCommand({ rpcMode: true })` in `src/run.ts` appends `--mode rpc` and sets `stdio: "pipe"`.
- `PiRpcClient` spawns Pi in RPC mode, speaks strict LF-only JSONL (`src/jsonl.ts`, no readline), pairs commands with ack responses by id, and drains streaming events until `agent_end`.
- `prompt(message)` sends a prompt and resolves after the ack; `onEvent`/`onExit` deliver live events and process exits. `extractAssistantText(events)` reads nested `message_update.assistantMessageEvent.text_delta`.
- Fake Pi process fixture: `tests/fixtures/fake-pi-rpc.cjs`.

Gateway HTTP/SSE surface (Phase 3, `src/gateway-http.ts` + `src/gateway-bridge.ts`):

- `piEventToSse(event)` in `src/gateway-bridge.ts` translates Pi events to SSE: `text_delta` -> `token`, `tool_execution_*` -> `tool`, `agent_end` -> `done`. Thinking/approval/queue are deferred.
- `GatewayServer` in `src/gateway-http.ts` owns one `PiRpcClient`, serves `POST /api/chat/start` (returns `{stream_id}`) and `GET /api/chat/stream?stream_id=...` (drains SSE until done/error, 30s heartbeat). stdlib `http`, no WebSocket.
- `piren gateway` (alias `piren web`) CLI command with `--port` (default 7317) and `--host` (default 127.0.0.1).

Implemented CLI:

- `piren init`
- `piren status`
- `piren agents`
- `piren doctor`
- `piren setup`
- `piren run`
- `piren worker`
- `piren gateway` (alias `piren web`)

Implemented extension command:

- `piren_status`

Implemented extension tools:

- `vault_read(path)`
- `vault_read_cached(path)`
- `vault_write(path, content)`
- `vault_list(path)`
- `vault_patch(path, old_text, new_text)`
- `vault_append_log(path, entry)`
- `session_write_summary(summary, title?)`
- `send_to_agent(to, title, body)`
- `task_update_status(task_path, status, result?)`
- `inbox_list()`
- `task_claim(task_path, device_id?, stale_after_ms?)`
- `flag_steward(title, body, severity?, notify?)`

## Common pitfalls

- This directory is a git repository. Remote: `https://github.com/Odiobill/piren.git`, default branch `main`. Prefer small, focused commits with clear messages. Do not force-push to `main` or rewrite shared history.
- `vault_write` with local outbox must not create a missing vault root as authoritative state.
- Path traversal outside the vault is a hard rejection, not an outbox proposal.
- `vault_read_cached` is explicit and non-authoritative. Keep `vault_read` authoritative by default.
- Avoid `loadPirenContext()` in doctor-style missing-file checks because context loading creates runtime directories.
- With TypeScript unions, prefer property checks such as `"path" in result`, `"outboxPath" in result`, or `"reason" in result` when narrowing is stubborn.
- With `exactOptionalPropertyTypes`, do not pass optional properties as explicit `undefined`. Build option objects with required fields first, then assign optional fields only when defined.
- When writing YAML or multi-line string content through patch/write tools, avoid TypeScript template literals with escaped newlines in test fixtures. Prefer string concatenation to avoid JSON escaping corruption.
- When updating docs, search both this repository and `/mnt/nas/Documents/vault/Projects/Piren/` for stale verification baselines and stale next-step wording.

## Phase-specific handoff location

The current next tracer bullet and transient setup notes live here:

```text
/mnt/nas/Documents/vault/Projects/Piren/handoff-prompt.md
```

Do not duplicate long phase histories in prompts. Put stable implementation rules here, current project truth in vault project docs, and only volatile next-session instructions in the handoff prompt.
