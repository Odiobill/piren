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

## Integrated web UI scope

The integrated web UI is intentionally minimal per ADR-0012. It is an emergency interface, not a primary workspace. It provides agent selection, chat, steering, approval gates, a read-only vault browser, and a read-only context indicator. It does NOT provide model or thinking controls: those belong in `team/<agent>/config.yml`, the single source of truth. The model/thinking/agent-switch API routes remain available for external integrations. Rich external solutions (Open WebUI-compatible, purpose-built dashboards) can be built on the HTTP API.

## Extensibility

Piren core is minimal. Additional capabilities come from Pi packages (ADR-0013), declared in `~/.config/piren/config.yml` and loaded as additional `--extension` flags. Vault skills (ADR-0014) provide reusable procedures stored in `vault/skills/` and `team/<agent>/skills/`, injected into agent context at startup.

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

Current baseline:

```text
Test Files  34 passed (34)
Tests       226 passed (226)
SMOKE PASSED
```

Smoke and tests must not depend on Davide's real `~/.config/piren/config.yml` unless explicitly testing local installation config.

## Current implementation surface

Phase 0, Phase 0.5, Phase 1, and Phase 2 are complete. Phase 3 tracer bullets 1-8 are done (RPC client, HTTP/SSE transport, read-only vault browser, model/thinking control + agent switching, steering + approval gates, auth token gate, web UI frontend, session resume + abort). `piren ask`, `piren chat` (alias for run), and `piren clean` are also implemented. Vault skills (ADR-0014) and Pi package extensibility (ADR-0013) are implemented. The gateway-web-ui.md "Sequencing" section has the per-tracer-bullet detail; this section summarizes the stable surface.

Gateway RPC surface (Phase 3, `src/gateway-rpc.ts`):

- `buildPiRunCommand({ rpcMode: true })` in `src/run.ts` appends `--mode rpc` and sets `stdio: "pipe"`.
- `PiRpcClient` spawns Pi in RPC mode, speaks strict LF-only JSONL (`src/jsonl.ts`, no readline), pairs commands with ack responses by id, and drains streaming events until `agent_end`.
- `prompt(message)` sends a prompt and resolves after the ack; `onEvent`/`onExit` deliver live events and process exits. `extractAssistantText(events)` reads nested `message_update.assistantMessageEvent.text_delta`.
- `getState()`, `getAvailableModels()`, `setModel(provider, modelId)`, `setThinkingLevel(level)` reach through to Pi's native RPC capabilities. Exported types: `RpcSessionState`, `RpcAvailableModels`, `RpcModel`.
- `steer(message)` and `followUp(message)` interrupt or queue after the current run. `respondToUiRequest(id, response)` writes an `extension_ui_response` to stdin via `writeRaw()` (no ack is sent back). Exported type: `ExtensionUiResponse`.
- `abort()` stops the active turn mid-stream (emits `agent_end`, draining active streams). `getMessages()` returns the full transcript of the current session (`RpcMessages`). `switchSession(sessionPath)` resumes a past session and returns `{cancelled}` (`RpcSessionSwitch`). Exported types: `RpcMessages`, `RpcSessionSwitch`.
- Fake Pi process fixture: `tests/fixtures/fake-pi-rpc.cjs` (handles prompt, get_state, get_available_models, set_model, set_thinking_level, steer, follow_up, extension_ui_response, abort, get_messages, switch_session; emits queue_update after prompt and extension_ui_request on "approve").

Gateway HTTP/SSE surface (Phase 3, `src/gateway-http.ts` + `src/gateway-bridge.ts`):

- `piEventToSse(event)` in `src/gateway-bridge.ts` translates Pi events to SSE: `text_delta` -> `token`, `tool_execution_*` -> `tool`, `agent_end` -> `done`, `model_changed` -> `model_changed`, `thinking_level_changed` -> `thinking_changed`, `queue_update` -> `queue`, `extension_ui_request` (confirm/select/input) -> `approval`.
- `GatewayServer` in `src/gateway-http.ts` owns one `PiRpcClient`, serves `POST /api/chat/start` (returns `{stream_id}`, optional `mode` for steer/follow_up) and `GET /api/chat/stream?stream_id=...` (drains SSE until done/error, 30s heartbeat). stdlib `http`, no WebSocket.
- Model/thinking/state routes: `GET /api/chat/models`, `GET /api/chat/state`, `POST /api/chat/model`, `POST /api/chat/thinking`.
- Agent switching routes: `GET /api/chat/agents` (returns `{agents, current}`), `POST /api/chat/switch` (validates runnable set, swaps the PiRpcClient, closes old streams). Enforces the local runnable-agent policy.
- Steering/approval routes: `POST /api/chat/approve` (responds to extension_ui_request via `client.respondToUiRequest`).
- Session resume/abort routes (tracer bullet 8): `POST /api/chat/abort` (aborts the active turn), `GET /api/chat/messages` (current transcript), `POST /api/chat/resume` (resumes a past session, returns `{cancelled}`), `GET /api/chat/sessions` (lists vault session summaries from `src/session-browser.ts` `listAgentSessions`, newest-first, for the current agent).
- Auth token gate (tracer bullet 6): `src/gateway-auth.ts` provides `isLocalhostBind`, `isBearerAuthorized` (constant-time), `assertAuthGate` (fail-closed on non-localhost without token), `generateToken`, and `resolveGatewayToken` (CLI `--token` > `PIREN_TOKEN` env > `~/.config/piren/gateway-token` file > auto-generate). `GatewayServer` gained an optional `authToken` option: `GET /api/auth/info` is public and reports `{authRequired}`; all other `/api/*` routes require `Authorization: Bearer *** or return 401. The CLI auto-generates and prints a token on first non-localhost run. Tests: `tests/gateway-auth.test.ts`, `tests/gateway-auth-routes.test.ts`.
- Static file serving + web UI (frontend): `GatewayServer` gained an optional `publicDir` option. `GET /` serves `index.html`; other GET requests serve static files by relative path with MIME detection. API routes always take priority. Path traversal rejected via `relative()` check (defense-in-depth). The `public/` directory contains `index.html`, `style.css`, `app.js` (vanilla JS, no framework, no build step). The build script copies `public/` to `dist/public/`. The CLI resolves `publicDir` via `import.meta.url` (same pattern as the extension path). Tests: `tests/gateway-static.test.ts`.
- `piren gateway` (alias `piren web`) CLI command with `--port` (default 7317), `--host` (default 127.0.0.1), and `--token`; wires `runnableAgents`, `initialAgent`, `targetBuilder`, `authToken`, and `publicDir` from `listPirenAgents`, `buildPiRunCommand`, `resolveGatewayToken`, and `resolvePublicDir`.

Implemented CLI:

- `piren init`
- `piren status`
- `piren agents`
- `piren doctor`
- `piren setup`
- `piren run`
- `piren chat` (alias for run)
- `piren worker`
- `piren gateway` (alias `piren web`)
- `piren ask "message"`
- `piren clean`

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

Vault skills (ADR-0014, implemented):
- `src/skills.ts` exports `loadVaultSkills(vaultRoot, agentName)` and `formatSkillsForContext(skills)`. Skills are loaded from `vault/skills/` (shared) and `team/<agent>/skills/` (agent-specific, overrides shared on name collision). Both loose `.md` files and directory-based `SKILL.md` skills are supported. Frontmatter (`name`, `description`) is parsed; the name falls back to the filename stem. The loader is tolerant: missing directories return an empty list, malformed frontmatter does not crash.
- The loaded skills are injected into `contextPrompt` as an "Available Skills" section (name, source, description, full body) so the agent knows the procedures exist and can follow them when the steward asks or when a task matches.
- `piren_status` reports `skills_loaded: <count>`.
- Tests: `tests/skills.test.ts` (9 tests), `tests/pi-extension.test.ts` (2 new tests for context injection + 2 for status count).

Pi package extensibility (ADR-0013, implemented):
- `src/packages.ts` exports `resolvePackages(packages, resolver)` (pure core: takes a list of package names and an injected resolver, returns resolved entry points plus missing packages) and `defaultPackageResolver(name)` (production resolver using `require.resolve`). The resolver is injected so tests use a fake without a live node_modules tree. Declaration order is preserved; missing packages are collected rather than crashing resolution.
- `LocalPirenConfig` in `src/bootstrap.ts` gained `packages?: string[]`. `PirenContext` gained `packages: string[]`, populated by `loadPirenContext` from the config's `packages` field.
- `buildPiRunCommand` in `src/run.ts` resolves each declared package to its entry point and appends `--extension` flags after the core extension in declaration order. Missing packages are skipped (doctor reports them separately). The `packageResolver` option on `BuildPiRunCommandOptions` lets tests inject a fake resolver.
- `piren doctor` validates that all declared packages are installed via `checkPackages` (status `warn` for missing, `ok` when all installed, omitted when no packages declared). `DoctorPirenOptions` gained `packageResolver` for test injection. `DoctorReport` gained `packages: string[]`. `formatDoctorReport` prints the declared packages.
- `piren_status` reports declared packages as `packages: <list>` (or `packages: <none>`). The `PirenStatusReport` and `BuildPirenStatusReportOptions` gained `packages`; the status builder falls back to `context.packages`.
- Tests: `tests/packages.test.ts` (5 tests), `tests/run.test.ts` (3 new for package extension flags), `tests/doctor.test.ts` (3 new for package validation), `tests/pi-extension.test.ts` (2 new for status reporting).

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
