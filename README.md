# Piren

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/piren-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/piren-logo-light.svg">
    <img alt="Piren animated logo" src="public/piren-logo-light.svg" width="420">
  </picture>
</p>

Piren is a lightweight, local-first agent runtime on top of [Pi Coding Agent](https://pi.dev/). It keeps agent identity, operational state, logs, sessions, task exchange, skills, cron jobs, and cumulative project knowledge in an inspectable Markdown vault.

💡 **Philosophy:** Piren does not try to replace the core agent engine. It builds on the right foundation, Pi Coding Agent, then adds the missing local-first runtime layer: inspectable state, vault-native knowledge, explicit tools, gateways, and edge-device operations. For the seven discipline principles behind every feature, see [Piren discipline](docs/discipline.md).

Piren exists for stewarded teams of local agents: small enough for edge and homelab devices, explicit enough to debug from a terminal, and transparent enough that Obsidian can be the source of truth. It borrows self-improvement ideas from larger agent systems, but keeps them reviewable: agents write visible vault artifacts instead of hidden memory mutations.

Pi runtime policy: Piren requires a `pi` binary already available on `PATH`. If none is found, `piren setup` prints the official Pi installer command and exits without changing Piren files.

## Five-minute quickstart

```bash
npm install -g --install-links github:Odiobill/piren
curl -fsSL https://pi.dev/install.sh | sh   # if pi is not already installed
pi                                           # inside Pi: /login, then /quit
piren setup                                  # create the Piren vault + first agent
piren status
```

For one-command model provisioning, add `--provider`, `--model`, optional `--thinking`, and optional `--api-key` to `setup --apply`; the key is merged into Pi's native `~/.pi/agent/auth.json`.

Start an interactive Pi-backed Piren agent:

```bash
piren --vault-root /tmp/piren-vault --agent piren run
```

Start the minimal local web gateway:

```bash
piren --vault-root /tmp/piren-vault --agent piren gateway
# open http://127.0.0.1:7317/
```

For a global install from this repository:

```bash
npm install -g --install-links github:Odiobill/piren
piren status
```

## Feature overview

- Vault-native agent identity: `team/<agent>/SOUL.md`, `MEMORY.md`, config, inbox, sessions, logs, devices, skills, and cron.
- Explicit vault tools: read, write, list, patch, append-log, cached read, session summaries, alerts, task exchange, and knowledge artifacts.
- File-backed task inbox: one Markdown file per task, explicit claim/update operations, stale-claim recovery, and opt-in worker mode.
- Lazy vault skills: compact skill catalog at startup, full skill bodies loaded on demand with `skill_read(name)`.
- Agent groups and fallback: group-scoped skills (`shared < group < agent`), read-only fallback recommendation via `piren agents --fallback <agent>`, filtered by local runnable policy and same-group membership. No automatic rerouting.
- Pi package extensibility: install extra Pi extensions through npm packages declared in local Piren config.
- Gateway process isolation: web, Telegram, Discord, and OpenAI-compatible API surfaces drive Pi through RPC, not in-process embedding.
- Minimal web UI: agent selection, chat streaming with Markdown rendering, steering, approval gates, read-only vault browser, read-only knowledge graph, and read-only context usage indicator. No model or configuration controls.
- Vault-backed cron: Markdown cron job files with active-device ownership, atomic claiming, and inspectable run records.
- Scheduler: `piren scheduler --dry-run` plans inbox task and cron job claims with zero LLM calls; `piren scheduler --once` runs one bounded claim-first tick; `piren scheduler` runs the opt-in loop until SIGINT/SIGTERM. Uses device heartbeat priorities and active-device-priority ownership, with conservative one-at-a-time execution and no hidden state.
- Service lifecycle: systemd user units with tmux plus `@reboot` cron fallback for gateway, Telegram, Discord, and the scheduler. Inspectable, reversible files under `~/.config/piren/services/`.
- First-run setup: `piren setup` (no flags) checks Pi, creates or reuses a vault, writes local config, and suggests optional service commands; `--help` on every command.
- Inspectable self-improvement: agents can update handoffs, runbooks, ADRs, project logs, skill candidates, use `self_improvement_trigger_check` to classify correction moments, and opt in to visible-artifact auto-nudges/review loops without hidden memory mutation.
- Open Knowledge Format (OKF v0.1): the vault is a specified knowledge bundle. `wiki_update_concept`, `wiki_update_entity`, `piren doctor`, and the `vault_conformance_check` tool keep curated wiki documents OKF-conformant with a required non-empty `type` frontmatter field.

## Architecture sketch

```text
steward / client
  -> Piren CLI or gateway transport
  -> Pi Coding Agent process in normal or RPC mode
  -> Piren Pi extension
  -> Markdown vault as source of truth
```

Local installation authority lives outside the vault in `~/.config/piren/config.yml`. Agent identity and shared project knowledge live inside the vault. Provider credentials remain Pi-native under `~/.pi/agent/`.

Gateway transports are separate processes that spawn Pi in RPC mode. The integrated web UI uses HTTP/SSE plus POST, Telegram and Discord use their platform protocols, and OpenAI-compatible clients use `/api/v1/chat/completions`.

## Documentation

Online landing page: **https://piren.org/**

- [Getting started](docs/getting-started.md)
- [Piren discipline](docs/discipline.md)
- [Configuration](docs/configuration.md)
- [Vault layout](docs/vault-layout.md)
- [Fresh vault and OKF bundles](docs/fresh-vault.md)
- [Project bundles](docs/project-bundles.md)
- [Gateway and web UI](docs/gateway.md)
- [Telegram and Discord transports](docs/transports.md)
- [OpenAI-compatible API](docs/openai-api.md)
- [Skills](docs/skills.md)
- [Agent groups and fallback](docs/agent-groups.md)
- [Extension recipes](docs/extension-recipes.md)
- [Knowledge lifecycle](docs/knowledge-lifecycle.md)
- [Open Knowledge Format (OKF)](docs/okf.md)
- [Cron jobs](docs/cron.md)
- [Scheduler](docs/scheduler.md)
- [Token discipline](docs/token-discipline.md)
- [Migrating from Hermes](docs/migrating-from-hermes.md)
- [Operations](docs/operations.md)
- [Service management](docs/service-management.md)
- [Recovery](docs/recovery.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)
- [API reference](docs/api.md)

Project coding-agent instructions live in [AGENTS.md](AGENTS.md). Stable implementation rules belong there; phase-specific next-session context belongs in the Piren vault project handoff.

## Current release status

Piren 0.1.0 is the first non-prerelease official release. It contains the full official-release scope (O1–O7): agent groups with read-only fallback, a device-local scheduler service MVP (`--dry-run`/`--once`/loop/service lifecycle), a complete documentation pass, OKF vault conformance, inspectable self-improvement, and the rc.1–rc.3 core (gateway surfaces, vault skills, Pi packages, knowledge lifecycle, vault-backed cron, clean-install validation).

Current verification baseline: 92 test files, 1127 tests, `npm run typecheck`, `npm run build`, and `npm run smoke` passing. `npm run clean-install:check` should be run after pushing because it fetches the GitHub source.

Update an existing global install with:

```bash
piren update
```

Known limitations:

- Release candidate: not a stable 1.0. APIs and vault layouts may change before the first official release.
- Security model is bootstrap-token and local allowlist oriented, not multi-user RBAC.
- Memory-pack integration is post-RC unless pulled forward.

## Verify from source

```bash
npm test
npm run typecheck
npm run build
npm run smoke
npm run clean-install:check
```

## Landing page

The public landing page lives under `site/` and reuses the integrated web UI palette. It deploys to GitHub Pages via the `.github/workflows/pages.yml` workflow (Actions-deploy mode, since branch-deploy only serves `/` or `/docs`). The custom domain **piren.org** is configured via `site/CNAME` and the Pages API. The workflow is self-enabling: on first run it enables Pages and sets the source to "GitHub Actions" automatically, then publishes on every subsequent push to `main` that touches `site/`. Asset references are relative so the page renders correctly under both the custom domain root and the `*.github.io` subpath.

## License

Piren is released under the MIT License. See [LICENSE](LICENSE).
