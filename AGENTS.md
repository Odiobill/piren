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
- Pi runtime compatibility detection, with local `pi` preferred and explicit latest npx fallback.
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
npm run clean-install:check
```

Current baseline:

```text
Test Files  61 passed (61)
Tests       440 passed (440)
SMOKE PASSED
```

Smoke and tests must not depend on Davide's real `~/.config/piren/config.yml` unless explicitly testing local installation config.

## Current implementation surface

Phase 0, Phase 0.5, Phase 1, and Phase 2 are complete. Phase 3 tracer bullets 1-11 are done (RPC client, HTTP/SSE transport, read-only vault browser, model/thinking control + agent switching, steering + approval gates, auth token gate, web UI frontend, session resume + abort, Telegram, Discord, OpenAI-compatible API). `piren ask`, `piren chat` (alias for run), and `piren clean` are also implemented. Vault skills with lazy loading (ADR-0014 + ADR-0017), Pi package extensibility (ADR-0013), Phase 4 knowledge lifecycle tools (ADR-0015), ADR-0019 vault-backed cron, and the ADR-0020 README/docs split are implemented. The gateway-web-ui.md "Sequencing" section has the per-tracer-bullet detail; this section summarizes the stable surface.

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
- OpenAI-compatible route: `POST /api/v1/chat/completions` accepts `messages`, optional `model`, and optional `stream`; non-streaming responses return a `chat.completion` object, while streaming responses emit OpenAI-style `chat.completion.chunk` SSE frames and terminate with `data: [DONE]`. It reuses the same `PiRpcClient` and `/api/*` Bearer auth gate. Tests: `tests/gateway-http.test.ts`.
- Model/thinking/state routes: `GET /api/chat/models`, `GET /api/chat/state`, `POST /api/chat/model`, `POST /api/chat/thinking`.
- Agent switching routes: `GET /api/chat/agents` (returns `{agents, current}`), `POST /api/chat/switch` (validates runnable set, swaps the PiRpcClient, closes old streams). Enforces the local runnable-agent policy.
- Steering/approval routes: `POST /api/chat/approve` (responds to extension_ui_request via `client.respondToUiRequest`).
- Session resume/abort routes (tracer bullet 8): `POST /api/chat/abort` (aborts the active turn), `GET /api/chat/messages` (current transcript), `POST /api/chat/resume` (resumes a past session, returns `{cancelled}`), `GET /api/chat/sessions` (lists vault session summaries from `src/session-browser.ts` `listAgentSessions`, newest-first, for the current agent).
- Auth token gate (tracer bullet 6): `src/gateway-auth.ts` provides `isLocalhostBind`, `isBearerAuthorized` (constant-time), `assertAuthGate` (fail-closed on non-localhost without token), `generateToken`, and `resolveGatewayToken` (CLI `--token` > `PIREN_TOKEN` env > `~/.config/piren/gateway-token` file > auto-generate). `GatewayServer` gained an optional `authToken` option: `GET /api/auth/info` is public and reports `{authRequired}`; all other `/api/*` routes require `Authorization: Bearer *** or return 401. The CLI auto-generates and prints a token on first non-localhost run. Tests: `tests/gateway-auth.test.ts`, `tests/gateway-auth-routes.test.ts`.
- Static file serving + web UI (frontend): `GatewayServer` gained an optional `publicDir` option. `GET /` serves `index.html`; other GET requests serve static files by relative path with MIME detection. API routes always take priority. Path traversal rejected via `relative()` check (defense-in-depth). The `public/` directory contains `index.html`, `style.css`, `app.js` (vanilla JS, no framework, no build step). The build script copies `public/` to `dist/public/`. The CLI resolves `publicDir` via `import.meta.url` (same pattern as the extension path). Tests: `tests/gateway-static.test.ts`.
- `piren gateway` (alias `piren web`) CLI command with `--port` (default 7317), `--host` (default 127.0.0.1), and `--token`; wires `runnableAgents`, `initialAgent`, `targetBuilder`, `authToken`, and `publicDir` from `listPirenAgents`, `buildPiRunCommand`, `resolveGatewayToken`, and `resolvePublicDir`.

Telegram transport surface (Phase 3 bullet 9 first slice, `src/transport-session-manager.ts` + `src/telegram-transport.ts`):

- `TransportSessionManager` owns one `PiRpcClient` lifecycle per transport conversation and active runnable Piren agent. `getSession(transport, conversationId, agent?)` starts or reuses the session; `switchAgent(...)` enforces runnable-agent policy and swaps the client; `abort(...)`, `closeIdleSessions(...)`, and `closeAll()` manage lifecycle.
- `TelegramTransport` authorizes Telegram `chat.id` against local `telegram.allowed_chat_ids`, exposes `/start`, `/agents`, `/agent <name>`, `/whoami`, and `/abort`, and forwards plain text prompts to the active chat session's `PiRpcClient.promptAndWait()`. Long assistant responses are split into multiple messages via `chunkTelegramMessage` (`TELEGRAM_MESSAGE_LIMIT = 4000`) so each fits Telegram's sendMessage length limit.
- `TelegramBotApiHttpClient` is a minimal Telegram Bot API adapter using long polling (`getUpdates`) and `sendMessage`. `runTelegramPolling` advances the getUpdates offset to `update_id + 1` and calls `onError` (or rethrows) on recoverable failures. `piren telegram` reads `telegram.bot_token`, `telegram.allowed_chat_ids`, and optional `telegram.default_agent` from `~/.config/piren/config.yml`, then routes chats to the local runnable-agent set. HTTP bearer auth is not used for Telegram.
- `piren doctor` reports a `telegram` check (status warn/ok) only when a `telegram:` block is present in local config, via the pure `checkTelegramConfig(config, runnableAgents)` exported from `src/doctor.ts`. An installation without Telegram config produces no telegram check, so normal doctor never depends on Telegram being configured.

Discord transport surface (Phase 3 bullet 10, `src/discord-transport.ts`):

- `DiscordTransport` authorizes messages by `guild_id` against `discord.allowed_guild_ids` and non-thread messages by `channel_id` against `discord.allowed_channel_ids`. Threaded messages require an explicit `discord.allowed_thread_ids` match so thread access fails closed. It exposes `/start`, `/agents`, `/agent <name>`, `/whoami`, and `/abort`, and forwards plain text prompts to the active conversation session's `PiRpcClient.promptAndWait()`. The conversation key is `guild_id:channel_id` plus optional `:thread_id`. Long assistant responses are split via `chunkDiscordMessage` (`DISCORD_MESSAGE_LIMIT = 2000`, reusing the Telegram chunker algorithm). Leading bot mentions (`<@id>`) are stripped before command parsing.
- `DiscordBotApiHttpClient` is a minimal Discord REST adapter for creating messages (`POST /channels/{id}/messages`) authenticated with a Bot token header. `runDiscordGateway` drives the Discord WebSocket gateway: it sends `Identify` (op 2) on `Hello` (op 10), dispatches `MESSAGE_CREATE` (op 0) to the transport, tracks the last sequence number, and sends `Heartbeat` (op 1) at the negotiated interval and on demand. `createNativeDiscordGatewaySocket` wraps the native `WebSocket` (Node >= 22) into the `DiscordGatewaySocket` interface; tests inject a fake socket via `socketFactory`. The gateway loop is generic over the client type for testability.
- `piren discord` reads `discord.bot_token`, `discord.allowed_guild_ids`, `discord.allowed_channel_ids`, optional `discord.allowed_thread_ids`, optional `discord.application_id`/`discord.install_url`, and optional `discord.default_agent` from `~/.config/piren/config.yml`, then routes conversations to the local runnable-agent set. The WebSocket gateway client is a platform-mandated dial-out connection, not a WebSocket server added to Piren; the web UI remains SSE plus POST per ADR-0012.
- `piren doctor` reports a `discord` check (status warn/ok) only when a `discord:` block is present in local config, via the pure `checkDiscordConfig(config, runnableAgents)` exported from `src/doctor.ts`. An installation without Discord config produces no discord check, so normal doctor never depends on Discord being configured.
- Discord diagnosis note: `discord.allowed_guild_ids` means server IDs, not user IDs. To diagnose no-reply reports, compare the configured channel metadata from Discord REST (`GET /channels/{channel_id}`) to the local guild/channel allowlists. Bot-authored `MESSAGE_CREATE` events are ignored to avoid self-loops.

Implemented CLI:

- `piren init`
- `piren status`
- `piren agents`
- `piren doctor`
- `piren setup` (interactive wizard when run bare in a TTY; batch with `--apply`)
- `piren run`
- `piren chat` (alias for run)
- `piren worker`
- `piren gateway` (alias `piren web`)
- `piren telegram`
- `piren discord`
- `piren ask "message"`
- `piren service <install|remove|start|stop|restart|status> <gateway|telegram|discord>`
- `piren clean`
- `piren version`
- `piren -h|--help` and `piren <command> --help`

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
- `skill_list()`
- `skill_read(name)`
- `project_status(project)`
- `project_append_log(project, entry)`
- `decision_record(project, id, title, context, decision, consequences?, alternatives?)`
- `project_update_handoff(project, content)`
- `runbook_write(project, title, content)`
- `skill_candidate_write(name, description, body, scope?)`
- `cron_list()`
- `cron_claim(job_path, device_id?, stale_after_ms?)`
- `cron_record_run(job_path, status, result, started_at, finished_at)`
- `cron_runs(job_id?)`

Vault skills (ADR-0014 + ADR-0017, implemented):
- `src/skills.ts` exports `loadVaultSkills(vaultRoot, agentName)` and `formatSkillCatalogForContext(skills)`. Skills are loaded from `vault/skills/` (shared) and `team/<agent>/skills/` (agent-specific, overrides shared on name collision). Both loose `.md` files and directory-based `SKILL.md` skills are supported. Frontmatter (`name`, `description`) is parsed; the name falls back to the filename stem. The loader is tolerant: missing directories return an empty list, malformed frontmatter does not crash.
- The startup context prompt now injects a compact "Available Skills" catalog only: name, source, description, and vault-relative path. Full skill bodies are not injected at startup.
- `skill_list()` returns the same compact catalog. `skill_read(name)` returns the selected full skill body and rejects unknown names with a clear error. Agent-specific overrides are resolved at startup by the loader, so the tools use the same precedence as the prompt.
- `piren_status` reports `skills_loaded: <count>`.
- Tests: `tests/skills.test.ts` (10 tests), `tests/pi-extension.test.ts` (lazy context catalog, `skill_list`, `skill_read`, and status count).

Pi package extensibility (ADR-0013, implemented):
- `src/packages.ts` exports `resolvePackages(packages, resolver)` (pure core: takes a list of package names and an injected resolver, returns resolved entry points plus missing packages) and `defaultPackageResolver(name)` (production resolver using `require.resolve`). The resolver is injected so tests use a fake without a live node_modules tree. Declaration order is preserved; missing packages are collected rather than crashing resolution.
- `LocalPirenConfig` in `src/bootstrap.ts` gained `packages?: string[]`. `PirenContext` gained `packages: string[]`, populated by `loadPirenContext` from the config's `packages` field.
- `buildPiRunCommand` in `src/run.ts` resolves each declared package to its entry point and appends `--extension` flags after the core extension in declaration order. Missing packages are skipped (doctor reports them separately). The `packageResolver` option on `BuildPiRunCommandOptions` lets tests inject a fake resolver.
- `piren doctor` validates that all declared packages are installed via `checkPackages` (status `warn` for missing, `ok` when all installed, omitted when no packages declared). `DoctorPirenOptions` gained `packageResolver` for test injection. `DoctorReport` gained `packages: string[]`. `formatDoctorReport` prints the declared packages.
- `piren_status` reports declared packages as `packages: <list>` (or `packages: <none>`). The `PirenStatusReport` and `BuildPirenStatusReportOptions` gained `packages`; the status builder falls back to `context.packages`.
- Tests: `tests/packages.test.ts` (5 tests), `tests/run.test.ts` (3 new for package extension flags), `tests/doctor.test.ts` (3 new for package validation), `tests/pi-extension.test.ts` (2 new for status reporting).

Phase 4 knowledge lifecycle tools (ADR-0015 + ADR-0018, implemented):
- `src/knowledge.ts` exports `projectStatus(options)` (read `Projects/<project>/index.md` frontmatter, returns `{project, path, available, title, status, updated}`), `projectAppendLog(options)` (append to `Projects/<project>/log.md` with agent attribution, uses the existing `vaultAppendLog` core), and `decisionRecord(options)` (write `ADR-<id>-<slug>.md` under `Projects/<project>/decisions/` with standard ADR structure). Project names are validated to reject `/`, `\`, and `..`. ADR id must match `^\d{4}$`. Optional `consequences` and `alternatives` sections are included only when provided (built with conditional assignment for `exactOptionalPropertyTypes`).
- ADR-0018 inspectable self-improvement tools are also implemented in `src/knowledge.ts`: `projectUpdateHandoff(options)` writes `Projects/<project>/handoff-prompt.md`, `runbookWrite(options)` writes `Projects/<project>/runbooks/<slug>.md` with runbook frontmatter, and `skillCandidateWrite(options)` writes reviewable drafts under `skill-candidates/<name>.md` or `Projects/<scope>/skill-candidates/<name>.md`. Skill candidates are not active skills until promoted.
- Registered as `project_status`, `project_append_log`, `decision_record`, `project_update_handoff`, `runbook_write`, and `skill_candidate_write` extension tools. The context prompt gains a "Knowledge Lifecycle" section guiding agents to leave durable artifacts after non-trivial work.
- Tests: `tests/knowledge.test.ts` (14 tests), `tests/pi-extension.test.ts` (extension coverage for all knowledge tools, context prompt assertions). Smoke covers all six knowledge/self-improvement tools.

Vault-backed cron (ADR-0019, implemented):
- `src/cron.ts` is the pure scheduling + coordination core, callable directly from tests without Pi auth. It exports `parseSchedule` (five-field cron strings and interval syntax `30m`/`6h`/`1d`), `isScheduleDue` (interval elapsed-time logic and cron field matching with once-per-minute dedup), `readCronJob`/`listCronJobs` (frontmatter parsing of `id`, `agent`, `schedule`, `enabled`, `device_policy`, `stale_after_seconds`, `last_run`, `last_claimed_by` plus the `# Prompt` body; shared `cron/jobs/` and agent-scoped `team/<agent>/cron/jobs/`), `selectOwningDevice` (highest-priority, lowest-number selection among eligible active devices, restricted by `device_policy.allowed_devices`), `listActiveDevices` (reads `team/<agent>/devices/*.json` heartbeats, filters stale), `claimCronJob` (atomic rename to `.claimed.<device>.md` with `last_claimed_by` injected and stale recovery via device heartbeats), `recordCronRun` (writes inspectable run records under `cron/runs/` or `team/<agent>/cron/runs/`, restores the unclaimed job with `last_run` set and the stale claim line removed), and `listCronRuns` (run history newest-first, optional `job_id` filter).
- Registered as `cron_list`, `cron_claim`, `cron_record_run`, and `cron_runs` extension tools. `cron_record_run` trusts the device id encoded in the claimed path rather than the runtime hostname. The context prompt gains a \"Vault-Backed Cron\" section. Secrets never belong in cron job files.
- Worker mode (`PIREN_WORKER=1`, locally-allowed agent only) surfaces due jobs owned by this device via active-device-priority, but does NOT auto-run them: it notifies the agent, which claims and records runs via the tools so every run is inspectable. Default cron device staleness is 5 minutes, overridable via `PIREN_CRON_STALE_MS`. No UI, no leases, no central DB in RC.
- Tests: `tests/cron.test.ts` (26 tests covering scheduling, due detection, job I/O, device ownership, active-device discovery, atomic claiming with stale recovery, run records, and run history), `tests/pi-extension.test.ts` (3 cron extension tests: full lifecycle, worker surfacing does-not-auto-run, context prompt). Smoke covers cron_list/claim/record_run/runs.

Clean-install validation (RC hardening, implemented):
- `src/clean-install.ts` exports `assessCleanInstall(probe)` (pure, unit-tested: given the observed state of a fresh install, returns a structured pass/fail report with checks for `dist-cli`, `dist-public`, `dist-extension`, `binary-runs`, and `pi-runtime`), `formatCleanInstallReport`, and `runCleanInstallCheck(options)` / `defaultCleanInstallCheck(spec, opts)` which orchestrate a real `npm install` into an isolated clean HOME and prefix, then feed the observed probe to the pure core. The Pi runtime policy is parsed from `piren doctor` output run in the clean env: `path` when `pi` is on PATH, `npx-latest` when only `npx` is available, `unavailable` otherwise.
- Clean-install validation now also guards the install lifecycle: `package.json` does not define `prepare`, so `npm install -g --install-links github:Odiobill/piren` does not compile TypeScript on the target machine. GitHub installs use the committed `dist/` release artifacts. `prepack` still rebuilds `dist/` for tarball creation.
- `scripts/clean-install-check.ts` wires `defaultCleanInstallCheck` to a CLI: `npm run clean-install:check [-- spec] [--allow-scripts] [--keep]`. Exits non-zero on failure so it is CI-safe.
- Tests: `tests/clean-install.test.ts` (7 tests). The full real github install is exercised manually via `npm run clean-install:check`, not in the unit suite (network).

Service lifecycle management (ADR-0021, implemented):
- `src/service-lifecycle.ts` exports the pure core: `SERVICE_TRANSPORTS` (gateway/telegram/discord), `SERVICE_ACTIONS` (install/remove/start/stop/restart/status), `detectServiceManager(probe)` (returns `systemd` > `tmux-cron` > `none` via an injected availability probe), `generateSystemdUnit()` (user unit: Type=simple, Restart=on-failure, WantedBy=default.target), `generateTmuxLaunchScript()` (idempotent detached tmux session), `generateCronEntry()` (`@reboot` line), `installPlan()`/`removePlan()` (exact file paths + commands + instructions), `controlCommands()` (start/stop/restart/status), `executeServiceAction()` orchestration with injected `ServiceExecDeps` (writeFile/removeFile/runCommand/log), `resolvePirenCommand()`, and `updateServiceStatusYaml()` (merges `services.transports.<name>` status into config.yml). All generated files live under `~/.config/piren/services/`. `ServiceTransport` and `ServiceAction` types are exported.
- `src/help.ts` exports `formatHelp()`, `formatCommandHelp(command)`, `isHelpRequest(argv)`, and `HELP_TOPICS`. The parser (`src/parse-args.ts`) sets `parsed.help=true` for `-h`/`--help` anywhere before the `--` passthrough; the CLI routes help before command dispatch.
- `src/wizard.ts` exports the interactive setup wizard: pure helpers (`isExistingVault`, `PI_PROVIDERS`, `formatProviderMenu`, `MODEL_CATALOG` + `formatModelMenu`/`resolveModelChoice`/`buildAgentModelConfig`, `buildAgentConfigYaml`, `mergeTransportConfigYaml`, `buildAuthJsonEntry`, `serializeAuthJson`, `buildLocalConfigPatch`, `parseCommaList`) plus `runWizard(prompt, deps)` which drives the Hermes-style flow: existing vault detection + agent enable/disable, or new vault init; Pi provider selection + `~/.pi/agent/auth.json` write at mode 0600; model selection from a curated flagship catalog (or custom id) with optional thinking level, written to the agent-local `config.yml`; local config write with confirmation; optional Telegram/Discord gateway config merge. `src/prompt.ts` provides the `ReadlinePrompt` adapter (text/secret/confirm/select/list); the `WizardPrompt` interface is injected so the step logic is pure and unit-tested.
- `src/doctor.ts` gained an opt-in `checkServiceConfig(config)` that reports a `services` check only when a `services.transports` block is present, warning on declared-but-not-installed or installed-but-not-running transports. `ServicesLocalConfig` and `ServiceStatusEntry` added to `src/bootstrap.ts`.
- The CLI wires: `piren -h|--help` and `piren <cmd> --help`; `piren setup` interactive when bare in a TTY (explicit `process.exit(0)` after the wizard to avoid an unsettled top-level await from the readline interface); `piren service <action> <transport>` with real `systemctl --user`/`tmux`/`crontab` detection probes, best-effort service-status writeback to config.yml after install/remove (only when files were generated, i.e. manager is not `none`).
- Tests: `tests/service-lifecycle.test.ts` (22), `tests/service-lifecycle-exec.test.ts` (7), `tests/service-status-yaml.test.ts` (5), `tests/help.test.ts` (12), `tests/wizard.test.ts` (16), `tests/wizard-models.test.ts` (10), `tests/wizard-agent-config.test.ts` (4), `tests/wizard-transport-config.test.ts` (5), `tests/wizard-run.test.ts` (7), `tests/doctor-service.test.ts` (7), plus parser help tests.

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
