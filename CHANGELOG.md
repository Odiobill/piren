# Changelog

All notable changes to Piren are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - unreleased

Registry-first public/operator cutover (ADR-0033). This is a source-only `0.1.4` release candidate on `main`; it is **not yet published** to npm, has no provenance attestation, and is not verified on the registry. It is staged for a future OIDC publication.

### Changed

- **Registry-canonical install (P4b):** `npm install -g @odiobill/piren` is the primary stable install across README, docs/getting-started, docs/operations, and both site CTAs. GitHub/local/tarball installs are retained only as explicitly labelled contributor/emergency paths.
- **`piren update` registry migration (P4a):** default `piren update` now installs the scoped registry `latest` package (`npm install -g @odiobill/piren`) instead of GitHub `main`, with no `--install-links`. It resolves the target via `npm view @odiobill/piren version` and refuses a major-version jump unless the operator passes `--yes` (`piren update --yes`); same/minor/patch updates install normally; there is no interactive prompt and no automatic rollback (npm global install is not transactional).
- **No-silent-major safeguard:** the new strict no-dependency SemVer parser (`parseSemver`) compares major identifiers exactly via `bigint`, so valid SemVer majors beyond `Number.MAX_SAFE_INTEGER` cannot round together and bypass the safeguard.
- **Uninstall:** standardized to `npm uninstall -g @odiobill/piren`; the unscoped `npm uninstall -g piren` is documented only as a labelled legacy migration step for old GitHub installs.
- **Landing page:** both install CTAs use the registry command; the footer now links to the canonical npm package and uses version-neutral release wording.

## [0.1.3] - 2026-07-20

Scoped one-time manual npm bootstrap under ADR-0037 after the unscoped `piren` name was rejected by npm's similarity policy. The canonical npm identity is `@odiobill/piren` (the executable command stays `piren`). Published to npm `latest` via a single, interactive, 2FA-protected manual bootstrap; it may lack OIDC provenance (no provenance attestation is claimed for this version). All subsequent releases use the existing OIDC trusted-publishing workflow.

### Added

- **Staged skill import (CLI Slice E1):** `piren skill import <local-file.md> --staged`, `piren skill staged list`, and `piren skill staged show <name>` import a local Markdown skill into an inactive review area (`skill-candidates/imports/`) that no active skill-loading path scans. Imports normalize to OKF `type: Skill`, preserve the body, and record `source` / `imported_at` / SHA-256 `checksum` provenance. Local files only; no remote fetching.
- **Staged skill promotion (CLI Slice E2a):** `piren skill staged promote <name> --to shared|group:<group>|agent:<agent> [--force]` moves one staged artifact into an active scope. Promotion is transactional and rollback-safe: the original target is backed up, promoted content commits via a temp file plus an atomic rename, and staged-removal failure rolls the target back to its original state with no partial activation. Pre-existing `.promote.bak` / `.promote.tmp` recovery artifacts are refused and never overwritten, and incomplete cleanup is surfaced rather than concealed.
- **Registry publication workflow (ADR-0033 P1/P1b/P1c):** `.github/workflows/release-publish.yml` is the only npm-publishing workflow. It is tag-only (`v*`), split into an unprotected `verify` job (quality gates, tag/version agreement, one explicit `npm pack`, validate + install that exact tarball via the clean-install machinery) and a steward-approved `publish` job (`npm-production` Environment, `id-token: write`) that publishes only the verified artifact with provenance to the stable `latest` dist-tag. Both jobs pin Node 22.14.0; the publish job installs npm 11.5.1 and runs a fail-closed Node/npm version preflight. The publish job skips exactly v0.1.1, v0.1.2, and v0.1.3 (the unpublished candidates plus the sole scoped manual bootstrap); v0.1.4 and later use the normal OIDC path. `release-verify.yml` stays verification-only.
- **Prebuilt-tarball clean-install verifier:** `npm run clean-install:check -- <file.tgz>` validates a packed tarball's required surface (dist + docs) and installs that exact tarball in an isolated clean HOME/prefix (now targeting the scoped `node_modules/@odiobill/piren` path).
- **Scoped npm identity (ADR-0037 P3e):** canonical npm package name changed from `piren` to `@odiobill/piren` (the unscoped name was rejected by npm's similarity policy); the executable bin name stays `piren`. Canonical npm provenance `repository` metadata retained.
- **Release metadata:** package version set to 0.1.3.
- **Test hermeticity fix (ADR-0036):** doctor / doctor-OKF unit tests that are not exercising Pi discovery now inject a deterministic Pi runtime checker instead of relying on a host `pi` binary, so CI passes without Pi on PATH during unit tests. Added regression coverage reproducing the no-Pi condition.

### Changed

- **Documentation:** `docs/skills.md` documents staged import and promotion; `AGENTS.md` documents the publication workflow, clean-install paths, and the trusted-publishing toolchain floor.

### Fixed

- **Release-workflow CI ordering (ADR-0036 P3d):** both release workflows now install the CI-only fake Pi on PATH after unit tests but before smoke and packed-tarball verification, so smoke (`buildPiRunCommand`, which requires `pi`) and the clean-install check see Pi on PATH while unit tests stay hermetic with no runner Pi.

## [0.1.2] - 2026-07-20 (unpublished)

Tagged candidate whose exact unscoped `piren` tarball was rejected by npm with E403 before publication because the name is too similar to the existing package `porek`. The immutable tag at `dffc91f` was never published to npm, no GitHub release or dist-tag was created, and it must not be deleted, moved, reused, or published. See ADR-0037; the scoped replacement release is [0.1.3].

## [0.1.1] - 2026-07-19 (unpublished)

Tagged candidate whose release verification failed before registry publication: eight doctor / doctor-OKF unit tests relied on a local `pi` binary instead of an injected runtime checker and failed on the GitHub runner, which has no Pi during unit tests. The immutable tag at `3226cb1` was never published to npm, no GitHub release was created, and it must not be deleted, moved, reused, or published. See ADR-0036; the replacement release is [0.1.2].

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
