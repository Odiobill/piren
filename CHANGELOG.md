# Changelog

All notable changes to Piren are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

The first non-prerelease official release. Adds the device-local scheduler service MVP (`--dry-run`/`--once`/loop/service lifecycle) on top of the rc.3 core.

### Added

- **Scheduler service MVP (ADR-0029, O7):** `piren scheduler --once` runs one bounded claim-first tick; `piren scheduler` runs the opt-in loop until SIGINT/SIGTERM. Claim-scoped bounded execution for inbox tasks (S2) and agent-mode cron jobs (S3), one-shot tick execution (S4), explicit loop with local config (S5), and service lifecycle integration (`piren service install scheduler`, S6). All layers preserve the same boundaries: off by default, local allowed-agent policy, claim-first execution, at most one executed item per tick, conservative one-at-a-time concurrency, no hidden state, and no automatic cross-agent fallback. 78 new tests (832 total).
- **Seventh scheduler-service plan:** decomposes the scheduler MVP into seven reviewable slices (S1–S7).

### Changed

- **Changelog rc.3 section:** removed the stale "full loop and bounded execution are deferred" line that predates the O7 scheduler MVP.

## [0.1.0-rc.3] - 2026-07-05

The official-release scope prerelease. Adds agent groups with read-only
fallback, the device-local scheduler dry-run, a full documentation pass,
two service lifecycle bug fixes, WebUI refinements, and a lean npm package.

### Added

- **Agent groups and fallback (ADR-0028):** group config parser, group-scoped skill loading (`shared < group < agent` precedence), doctor and agents visibility for group membership, and a read-only `piren agents --fallback <agent>` recommendation filtered by local runnable policy and same-group membership. No automatic rerouting.
- **Scheduler dry-run (ADR-0029):** `piren scheduler --dry-run` plans inbox task and cron job claims with zero LLM calls, using device heartbeat priorities and active-device-priority ownership. Device heartbeat refresh now preserves a manually-edited priority.
- **Nine new operator docs:** discipline, scheduler, agent-groups, fresh-vault, project-bundles, migrating-from-hermes, extension-recipes, token-discipline, recovery. All linked from the README.
- **WebUI:** favicon imported from the landing page.

### Changed

- **WebUI sidebar:** Vault Explorer moved up to the steward controls section alongside Steward Alerts; "+ Inbox Task" moved to the conversation-adjacent section above New Conversation.
- **WebUI Files tab:** horizontal draggable divider between the file list and the document viewer, mirroring the vertical chat/vault divider. Driven by a `--files-list-height` CSS variable, shown only when a file is open.
- **Knowledge Graph:** skills (`type: Skill`) are now excluded from the graph. Skills are procedural memory, not graph concepts. Verified live: the development vault graph dropped to 69 nodes with zero skills.
- **Knowledge Graph labels:** node labels are smaller by default (0.58rem) and grow to full size with a brighter fill on hover/focus.
- **npm package:** added an explicit `files` allowlist (`dist/`, `docs/`). Package shrank from 327 files / 618 kB to 181 files / 295 kB (52% reduction). The npm `.npmignore` fallback warning is gone.

### Fixed

- **systemd service detection on degraded sessions:** `systemctl --user is-system-running` exits 1 when the user session is "degraded" but still functional. The probe now treats exit 0 and 1 as available (mirroring the existing crontab fix). Previously, degraded homelab machines reported "No service manager detected" and could not install services.
- **systemd ExecStart from source runs:** `resolvePirenCommand` now prepends `node` when the resolved command is a `.js` or `.mjs` file. Previously, running `piren service install` from a source checkout produced an unrunnable `ExecStart` that failed with systemd error 203/EXEC.

### Verification

76 test files, 687 tests. `npm run typecheck`, `npm run build`, `npm run smoke`, and `npm run clean-install:check` pass. `piren update` verified end-to-end.

[0.1.0]: https://github.com/Odiobill/piren/releases/tag/v0.1.0

## [0.1.0-rc.2] - 2026-07-02

Post-RC closeout polish before the next public release candidate.

### Added

- Knowledge Graph now indexes all OKF-typed Markdown documents from the vault root, not only `wiki/concepts/` and `wiki/entities/`. Project indexes, ADRs, runbooks, and other typed documents can appear as graph nodes and can emit directed links.
- Fresh vault scaffolds now create `Projects/` and include import guidance in `steward-directives.md` and agent `SOUL.md`, so agents preserve project material while promoting reusable knowledge into `wiki/concepts/` and `wiki/entities/`.

### Changed

- Web UI side panels for Vault Browser and Knowledge Graph now use the same width and can be horizontally resized, letting the chat area stretch with the remaining viewport.
- Web UI model badge now shows model plus best-effort context usage percentage when Pi exposes telemetry, and no longer shows thinking level.
- Live chat turns are finalized through the same Markdown renderer used by reloaded transcripts, so formatting is consistent before and after refresh.
- Tool execution SSE translation now extracts names from nested Pi tool payloads, avoiding `[tool] unknown` for newer event shapes.

### Verification

73 test files, 583 tests. `npm run typecheck`, `npm run build`, and `npm run smoke` pass locally. Run `npm run clean-install:check` after pushing so it verifies the GitHub source install.

## [0.1.0-rc.1] - 2026-06-26

The first release candidate. Piren is a lightweight, local-first agent runtime
built on top of Pi Coding Agent. It keeps agent identity, operational state,
logs, sessions, task exchange, skills, cron jobs, and cumulative project
knowledge in an inspectable Markdown vault.

This RC proves the end-to-end product thesis: a vault-backed team knowledge
substrate accessible through a minimal web UI, Telegram, Discord, and an
OpenAI-compatible API, with inspectable self-improvement, vault-backed cron,
and a verified clean-install path.

### Added

- **Gateway surfaces (Phase 3).** A minimal web UI (agent selection, chat
  streaming, steering, approval gates, read-only vault browser, read-only
  context indicator), Telegram transport, Discord transport, and an
  OpenAI-compatible `/api/v1/chat/completions` endpoint. All surfaces drive
  Pi through a separate RPC process, never in-process embedding.
- **Gateway controls.** Model/thinking control, agent switching, session
  resume and abort, steering and follow-up, and a fail-closed Bearer auth
  token gate for non-localhost binds with constant-time comparison.
- **Vault skills (ADR-0014 + ADR-0017).** Reusable procedures stored in
  `vault/skills/` and `team/<agent>/skills/`, injected as a compact catalog
  at startup and loaded on demand with `skill_read(name)`.
- **Pi package extensibility (ADR-0013).** Install extra Pi extensions
  through npm packages declared in local Piren config, loaded as additional
  `--extension` flags.
- **Knowledge lifecycle tools (ADR-0015 + ADR-0018).** `project_status`,
  `project_append_log`, `decision_record`, `project_update_handoff`,
  `runbook_write`, and `skill_candidate_write` let agents leave durable,
  inspectable artifacts instead of hidden memory mutations.
- **Vault-backed cron (ADR-0019).** Markdown cron job files with
  active-device ownership, atomic claiming, stale recovery, inspectable run
  records, and worker-mode surfacing that does not auto-run jobs.
- **Clean-install validation.** `npm run clean-install:check` installs from
  the real GitHub source into an isolated clean HOME and verifies the dist
  build, the installed binary, and the Pi runtime policy (`pi` required on
  PATH).
- **`piren version` command.** A released binary self-reports its version,
  resolved from package.json so it never drifts.
- **CLI commands.** `init`, `status`, `agents`, `doctor`, `setup` (with
  `--apply`), `run`, `chat` (alias for run), `worker`, `gateway` (alias
  `web`), `telegram`, `discord`, `ask`, `clean`, and `version`.
- **Operator documentation.** README is a concise entry point; detailed docs
  live under `docs/`: getting started, configuration, vault layout, gateway,
  transports, OpenAI API, skills, knowledge lifecycle, cron, operations,
  troubleshooting, security, and API reference.

### Changed

- **Pi runtime policy (ADR-0027).** Piren now requires a `pi` binary already
  on `PATH` and no longer falls back to npx. `piren setup` prints the official
  Pi install command and exits without changes when Pi is missing.

### Security

- Gateway JSON API request bodies are capped at 1 MiB and rejected with
  HTTP 413 before parsing, a denial-of-service guard for the chat, approval,
  model, session, and OpenAI-compatible endpoints.
- Discord threaded messages require an explicit `allowed_thread_ids` match
  and fail closed when absent.
- Gateway auth gate remains fail-closed for non-localhost binds; transport
  tokens stay local-config only; cron job files are non-secret vault prompts.

### Known limitations

- Release candidate: not a stable 1.0. APIs and vault layouts may change
  before the first official release.
- Security model is bootstrap-token and local allowlist oriented, not
  multi-user RBAC.
- Service lifecycle helpers (systemd units, supervised transports) are not
  yet first-class. Run gateway, Telegram, and Discord under your own
  supervisor for now.
- Wiki concept/entity update tools and memory-pack integration are post-RC
  unless explicitly pulled forward.

### Verification

51 test files, 342 tests. `npm run typecheck`, `npm run build`,
`npm run smoke`, and `npm run clean-install:check` all pass against the real
GitHub source install.

[0.1.0-rc.2]: https://github.com/Odiobill/piren/releases/tag/v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/Odiobill/piren/releases/tag/v0.1.0-rc.1
