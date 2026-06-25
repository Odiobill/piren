# Piren

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/piren-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/piren-logo-light.svg">
    <img alt="Piren animated logo" src="public/piren-logo-light.svg" width="420">
  </picture>
</p>

Piren is a lightweight, local-first agent runtime on top of [Pi Coding Agent](https://pi.dev/). It keeps agent identity, operational state, logs, sessions, task exchange, skills, cron jobs, and cumulative project knowledge in an inspectable Markdown vault.

💡 **Philosophy:** Piren does not try to replace the core agent engine. It builds on the right foundation, Pi Coding Agent, then adds the missing local-first runtime layer: inspectable state, vault-native knowledge, explicit tools, gateways, and edge-device operations.

Piren exists for stewarded teams of local agents: small enough for edge and homelab devices, explicit enough to debug from a terminal, and transparent enough that Obsidian can be the source of truth. It borrows self-improvement ideas from larger agent systems, but keeps them reviewable: agents write visible vault artifacts instead of hidden memory mutations.

Pi runtime policy: Piren prefers a `pi` binary already available on `PATH`. If none is found, it falls back to `npx --yes -p @earendil-works/pi-coding-agent@latest pi`.

## Five-minute quickstart

```bash
git clone https://github.com/Odiobill/piren.git
cd piren
npm install
npm run build
node dist/src/cli.js init --vault-root /tmp/piren-vault
node dist/src/cli.js setup --apply --vault-root /tmp/piren-vault --agent piren
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren status
```

Start an interactive Pi-backed Piren agent:

```bash
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren run
```

Start the minimal local web gateway:

```bash
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren gateway
# open http://127.0.0.1:7317/
```

For a global install from this repository:

```bash
npm install -g github:Odiobill/piren
piren status
```

## Feature overview

- Vault-native agent identity: `team/<agent>/SOUL.md`, `MEMORY.md`, config, inbox, sessions, logs, devices, skills, and cron.
- Explicit vault tools: read, write, list, patch, append-log, cached read, session summaries, alerts, task exchange, and knowledge artifacts.
- File-backed task inbox: one Markdown file per task, explicit claim/update operations, stale-claim recovery, and opt-in worker mode.
- Lazy vault skills: compact skill catalog at startup, full skill bodies loaded on demand with `skill_read(name)`.
- Pi package extensibility: install extra Pi extensions through npm packages declared in local Piren config.
- Gateway process isolation: web, Telegram, Discord, and OpenAI-compatible API surfaces drive Pi through RPC, not in-process embedding.
- Minimal web UI: agent selection, chat streaming, steering, approval gates, read-only vault browser, and read-only context indicator. No model or configuration controls.
- Vault-backed cron: Markdown cron job files with active-device ownership, atomic claiming, and inspectable run records.
- Inspectable self-improvement: agents can update handoffs, runbooks, ADRs, project logs, and skill candidates as visible vault artifacts.

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

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Vault layout](docs/vault-layout.md)
- [Gateway and web UI](docs/gateway.md)
- [Telegram and Discord transports](docs/transports.md)
- [OpenAI-compatible API](docs/openai-api.md)
- [Skills](docs/skills.md)
- [Knowledge lifecycle](docs/knowledge-lifecycle.md)
- [Cron jobs](docs/cron.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)
- [API reference](docs/api.md)

Project coding-agent instructions live in [AGENTS.md](AGENTS.md). Stable implementation rules belong there; phase-specific next-session context belongs in the Piren vault project handoff.

## Current release status

Piren is pre-RC. Phase 3 gateway surfaces are implemented: minimal web UI, Telegram, Discord, and OpenAI-compatible chat completions. Phase 4 RC features implemented so far include Pi package extensibility, lazy vault skills, knowledge lifecycle tools, inspectable self-improvement tools, and vault-backed cron.

Current verification baseline: 48 test files, 325 tests, `npm run typecheck`, `npm run build`, and `npm run smoke` passing.

Known limitations before RC:

- Clean-install and global-install validation still need hardening.
- Security model is bootstrap-token and local allowlist oriented, not multi-user RBAC.
- Service lifecycle helpers are not yet first-class. Run gateway, Telegram, and Discord transports under your own supervisor for now.
- Wiki concept/entity update tools and memory-pack integration are post-RC unless pulled forward.

## Verify from source

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

## License

Piren is released under the MIT License. See [LICENSE](LICENSE).
