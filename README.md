# Piren

<p align="center">
  <img alt="Piren logo" src="web/src/assets/piren-logo.png" width="220">
</p>

Piren is a lightweight, local-first agent runtime on top of [Pi Coding Agent](https://pi.dev/). It keeps agent identity, operational state, logs, sessions, task exchange, skills, cron jobs, and cumulative project knowledge in an inspectable Markdown vault.

💡 **Philosophy:** Piren does not try to replace the core agent engine. It builds on the right foundation, Pi Coding Agent, then adds the missing local-first runtime layer: inspectable state, vault-native knowledge, explicit tools, gateways, and edge-device operations. For the seven discipline principles behind every feature, see [Piren discipline](docs/discipline.md).

Piren exists for stewarded teams of local agents: small enough for edge and homelab devices, explicit enough to debug from a terminal, and transparent enough that Obsidian can be the source of truth. It borrows self-improvement ideas from larger agent systems, but keeps them reviewable: agents write visible vault artifacts instead of hidden memory mutations.

Pi runtime policy: Piren requires a `pi` binary already available on `PATH`. If none is found, `piren setup` prints the official Pi installer command and exits without changing Piren files.

## Five-minute quickstart

```bash
npm install -g @odiobill/piren
curl -fsSL https://pi.dev/install.sh | sh   # if pi is not already installed
pi                                           # inside Pi: /login, then /quit
piren setup                                  # create or reuse a vault and local config
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

Install or update the stable registry release:

```bash
npm install -g @odiobill/piren
piren status
```

Offline or emergency installs from a local tarball are documented in [Getting started](docs/getting-started.md).

## Web workbench

The gateway serves a React/Vite web workbench. Start it with `piren gateway` and open **http://127.0.0.1:7317/**.

The **Dashboard** is the default page. It lists the vault's agents and marks which are runnable on this installation (local policy only, never a live provider probe). From it you can start a Conversation with one agent you select, or start a peer Conversation with two to eight agents.

Selecting a Conversation runs an attach gate: it opens as active (immutable whole-history timeline plus a scoped live stream and composer) only when every member is locally runnable; otherwise it stays read-only inspection with history only. Timeline entries are immutable (steward messages, agent messages, run and model-fallback events, and lifecycle transitions such as archived or reopened). You add or dispatch members by typing `@agent` mentions; the gateway alone parses mentions, so the browser never decides who receives a message.

On the active surface you can archive or reopen a Conversation (archiving makes it read-only and never cancels a running turn), answer approval requests with Confirm, Cancel, or a value, and abort one agent's active run. Each durable message card has a Copy control that puts the message's canonical stored text (including its Markdown source) on the clipboard — read-only, native-browser only, with no durable effect. Live activity cards are transient, come only from the live stream, and are never reconstructed from history. Per-agent workflow-status indicators on the context cards are session-only, built from explicit authenticated gateway status snapshots at defined read moments, with live activity keeping the interim busy truth current — no browser derivation, no polling, and in browser memory only. Open an agent's **Context telemetry popup** to explicitly raise that gateway-associated workflow-root budget with server-validated compare-and-set; it is not Context usage or a per-agent budget. Each context card can show a truthful workflow status (budget exhausted / low / running) with fixed precedence — see [Gateway and web UI](docs/gateway.md).

Beside a Conversation, a read-only **Vault Explorer** lets you browse vault files in a resizable split. A full-page **Settings** page edits configuration families through typed workflows: transport blocks with write-only bot tokens, scheduler gates, agent preferences, and agent groups. Per-agent **Context cards** show session-only context usage with an explicit Refresh. The bearer token stays in memory only and is never written to storage.

The Workbench intentionally has no live-session model or thinking controls, and it is not a generic editor: provider credentials, the gateway token, and the runnable-agent policy are never editable there. Knowledge Graph presentation is not yet implemented. See [Gateway and web UI](docs/gateway.md) for behavior and [API reference](docs/api.md) for the route contract.

Start the gateway from an installed package:

```bash
piren gateway
```

Then open **http://127.0.0.1:7317/** in a browser. If the gateway is bound to a non-localhost host, pass `--token <token>` or set `PIREN_TOKEN`; the token is kept in memory only and is never written to storage. See [Gateway and web UI](docs/gateway.md).

## Feature overview

- Vault-native agent identity: `team/<agent>/SOUL.md`, `MEMORY.md`, config, inbox, sessions, logs, devices, skills, and cron.
- Explicit vault tools: read, write, list, patch, append-log, cached read, session summaries, alerts, task exchange, and knowledge artifacts.
- File-backed task inbox: one Markdown file per task, explicit claim/update operations, stale-claim recovery, and opt-in worker mode.
- Lazy vault skills: compact skill catalog at startup, full skill bodies loaded on demand with `skill_read(name)`.
- Agent groups and fallback: group-scoped skills (`shared < group < agent`), read-only fallback recommendation via `piren agents --fallback <agent>`, filtered by local runnable policy and same-group membership. No automatic rerouting.
- Pi package extensibility: install extra Pi extensions through npm packages declared in local Piren config.
- Gateway process isolation: web, Telegram, Discord, and OpenAI-compatible API surfaces drive Pi through RPC, not in-process embedding.
- Web workbench: React/Vite app with a Dashboard default page (local-policy agent roster, single-agent and peer Conversation start), an immutable timeline with scoped live streaming, approval and abort controls, archive/reopen lifecycle, a read-only Vault Explorer, and a typed Settings page with write-only transport tokens. Bearer token in memory only, no live-session model or thinking controls, and no browser persistence.
- Conversation handoff: inside Conversation runs, the `conversation_handoff(to, text)` agent tool can request a bounded handoff to another agent. The request stays open on a live approval card until you confirm or reject it; nothing is dispatched or added to the audience before confirmation, and child stages can hand off again within the workflow's budget (base depth 3 / 8 edges / 2 rework rounds; the chain depth is fixed and a steward can explicitly raise the associated workflow-root's edges and rework-round budgets from that agent's Context telemetry popup, capped at 24 edges and 6 rework rounds). Handoff events are durable, approvals stay live-only, abort stays one direct active run, and there is no hidden queue, retry, reroute, fallback, or auto-approval. The Workbench renders handoff-gate cards and live stage events.
- Vault-backed cron: Markdown cron job files with active-device ownership, atomic claiming, and inspectable run records.
- Scheduler: `piren scheduler --dry-run` plans inbox task and cron job claims with zero LLM calls; `piren scheduler --once` runs one bounded claim-first tick; `piren scheduler` runs the opt-in loop until SIGINT/SIGTERM. Uses device heartbeat priorities and active-device-priority ownership, with conservative one-at-a-time execution and no hidden state.
- Service lifecycle: systemd user units with tmux plus `@reboot` cron fallback for gateway, Telegram, Discord, and the scheduler. Inspectable, reversible files under `~/.config/piren/services/`.
- First-run setup: `piren setup` (no flags) checks Pi, creates or reuses a vault, writes local config, and suggests optional service commands; `--help` on every command.
- Inspectable self-improvement: agents can update handoffs, decision records, runbooks, project logs, and skill candidates; use `self_improvement_trigger_check` to classify correction moments; and opt in to visible-artifact auto-nudges/review loops without hidden memory mutation.
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
- [Task coordination](docs/tasks.md)
- [Token discipline](docs/token-discipline.md)
- [Migrating from Hermes](docs/migrating-from-hermes.md)
- [Operations](docs/operations.md)
- [Service management](docs/service-management.md)
- [Recovery](docs/recovery.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)
- [API reference](docs/api.md)

## Releases and updates

Piren 0.2.4 is the current stable release on npm. Update an existing global install with:

```bash
piren update
```

`piren update` installs the latest `@odiobill/piren` release from the npm registry. It refuses a major-version jump unless you pass `--yes` (`piren update --yes`).

**Upgrading from 0.1.3?** Run `npm install -g @odiobill/piren` once. That older command used a retired GitHub install path; after this one-time registry install, `piren update` uses the registry.

## License

Piren is released under the MIT License. See [LICENSE](LICENSE).
