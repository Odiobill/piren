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

The gateway serves a React/Vite web workbench. The shell probes the public auth endpoint, offers an in-memory-only bearer-token entry when the gateway requires one, and provides the **Conversation** surface over the gateway Conversation API. The **Dashboard** is the default surface: it reads the local-policy agent roster from the existing authenticated read, presents the roster as agent cards (bounded avatar/accent/description presentation slots, no presentation schema or browser persistence), and starts a new Conversation with one explicitly steward-selected runnable agent through the gateway-authoritative `POST /api/conversations/start` route (exactly `{agent}` — the browser never derives a recipient or synthesizes steward text; the selected agent replies with one brief bounded greeting). While a start request is pending, the Dashboard shows a truthful local busy line describing the submitted browser/gateway operation (never an invented agent state) with reduced-motion-safe animated dots. Its service-information card reports only facts from accepted authenticated reads: a successful roster read may say the gateway is connected, and a clearly separate managed-service-observation group presents one fresh, read-only snapshot from the gateway's service-status route (fixed Telegram/Discord/Scheduler order, truthful Active/Inactive/Not installed/Manager unavailable/Unknown labels, source and sampled time, caution styling for unknown/unavailable, and a bounded manual-retry-only failure presentation); configured/recorded service state is never presented as live process status. The sidebar is the sole conversation switcher (the Dashboard has no duplicate conversation list). A conversation can also still be activated by its first raw-text message through the Conversation API (even with zero mentions); `@`-mentioning a locally runnable agent adds it as a durable member, and the gateway alone parses and validates mentions (the browser never derives recipients from text). Selecting a conversation runs the runnable-roster-gated attach: when every durable member is locally runnable it opens as the active surface (immutable whole-history timeline plus the scoped live SSE stream and a raw-text composer); a rejected conversation stays visibly **read-only inspection** — history only, no composer, no live stream. Every vault-defined agent appears in the roster; **online** means runnable on this installation (local policy only, never a live presence or provider probe), and **offline** members are visibly labelled. A selected conversation can be **archived** (with an explicit confirmation) or, when archived, **reopened**: archiving makes it read-only, never cancels an in-flight run, and neither action starts a session or stream on its own — after a lifecycle action or a lifecycle event from another client, the Workbench re-reads the manifest and re-runs the attach gate before showing the active or read-only surface. Conversations have stable deep links (`#conversation/<id>`): loading or revisiting one performs a fresh manifest read plus the attach gate before opening the live surface, and browser Back/Forward re-runs that fresh gate. Reconnects re-read the whole history (no replay) and there is no render cache. When an active run raises an approval request (`confirm`, `select`, or `input`), the Workbench shows an accessible non-modal approval card with Confirm / Cancel (and a labeled input for select/input requests); submitting sends exactly one of `confirmed`, `value`, or `cancelled` to the Conversation approve route, and a successful submission is delivery acceptance only — the browser never fabricates an agent outcome. Each member of an active conversation also has an **Abort** action that stops exactly that conversation × agent run and reports `cancelled` or `no-active-run` truthfully. Approval cards and Abort appear only on the active surface: read-only/archived inspection shows neither, and no approval/abort control ever activates or attaches a conversation by itself. Unknown, stale, or already-settled approval responses and bounded server errors are shown with a manual Retry only. Live run activity is broker-authoritative and transient: the scoped stream carries additive `conversation_activity` frames, and the Workbench shows `<agent> is working…` only after the durable `run_started` and `<agent> is typing…` only after a real Pi text delta; activity clears on terminal/malformed/stale frames, stream end/error, reconnect, or history reread, is never reconstructed from history, and is never durable. Compact bounded lifecycle/status reaction chips are derived ONLY from durable broker evidence (`received` after `run_started`, `completed`/`failed`/`cancelled` from the actual durable terminal status, using the durable `runAgent` attribution); they never claim an agent read anything, never use arbitrary emoji, and old/unknown evidence is absent safely. The composer is Discord-like: one auto-growing raw-text composer anchored at the bottom of the full-height active workspace (messages scroll above it); a plain **Enter** submits, **Shift+Enter** inserts a newline, and IME composition never submits prematurely. A genuinely disabled, labelled `+` button sits left of the composer as a visual future-upload affordance with no file capability, and typing `@` offers a keyboard-navigable convenience list of **locally runnable** agents that inserts text only — the browser still sends exactly `{text}` and the gateway remains the sole mention parser/recipient authority. A focus-managed **Conversation details** modal (opened from a composer-right information icon on the active surface, and from a minimal inspection action row on read-only inspection) presents the current title, id, status, audience, created/updated times, and the relocated Archive/Reopen controls; the title is editable with bounded Save/Cancel/error/Retry over the authenticated `POST /api/conversations/<id>/rename` route (trim-normalized single-line 1–120 code-unit title, one immutable `conversation_renamed` evidence event, no-op `renamed:false`, manifest-first bounded residual). The no-selection surface has no details control. Timeline entries are immutable (steward message, agent message, run started/finished/cancelled, model fallback, lifecycle transitions such as "Conversation archived"/"Conversation reopened") and never editable; unreadable stream frames show as clearly non-authoritative markers. A read-only **Vault Explorer** companion opens beside the selected conversation in a resizable split (or full-page when no conversation is selected) over the existing bounded vault list/read routes. A full-page typed **Settings** module edits the inventoried local and agent configuration families — transport blocks with write-only bot tokens, scheduler gates and intervals, and agent model/fallback/context-injection/self-improvement preferences — through atomic, fail-closed writes under the gateway's existing authentication; it is not a generic editor and never touches live sessions, provider credentials, the gateway token, or runnable-agent policy. Compact per-agent **Context cards** below the composer show truthful session-only context usage (two-decimal percent; unknown states never render a number) with a focus-managed details popup whose explicit Refresh is the only telemetry read, and while an agent is working or an approval is pending the composer is interlocked read-only with a visible reason that preserves any unsent draft. Knowledge Graph presentation and persistent navigation beyond the conversation deep links are not yet implemented.

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
- Web workbench: React/Vite workbench with a responsive app shell (Dashboard default page with the local-policy roster and explicit agent-first Conversation start, sidebar conversation switcher, mobile hamburger drawer), public auth probe, in-memory bearer-token entry, and the Conversation surface over the gateway Conversation API: runnable-roster-gated attach (all members locally runnable), a Discord-like auto-growing raw-text composer on the active surface (Enter submits, Shift+Enter newline, IME-safe, disabled labelled `+` upload affordance with no file capability, `@` mention autocomplete from the locally runnable roster with keyboard navigation — text-only insertion, raw `{text}` bodies only), an immutable whole-history timeline plus scoped live SSE only after a successful attach, broker-authoritative transient live activity (`<agent> is working…` after durable `run_started` and `<agent> is typing…` after a real text delta, cleared on terminal/error/reconnect/reread and never reconstructed from history), lifecycle controls (Archive with an explicit confirmation, Reopen on archived inspection) relocated into a focus-managed **Conversation details** modal together with the metadata and the bounded steward-facing rename action, and a fresh manifest/attach re-gate after any lifecycle action or event or successful rename. On the active surface, live approval requests render as accessible non-modal cards (Confirm / Cancel, or a labeled input for select/input) submitting exactly-one responses, and each member has an Abort action for that conversation × agent run; read-only/archived inspection shows neither. Rejected conversations stay visibly read-only inspection with no composer or live stream. The browser never scans or resolves `@text` — mentions are server-authoritative. The workbench also includes the read-only Vault Explorer companion (resizable split beside the selected conversation, full-page with no selection) and the typed Settings page (write-only transport tokens, scheduler and agent-preference workflows, atomic fail-closed writes, no live-session changes). Knowledge Graph presentation and persistent navigation beyond the conversation deep links are not implemented. No live-session model or thinking controls.
- Conversation handoff loop: the gated `conversation_handoff(to, text)` agent tool, available only inside broker-spawned Conversation runs, lets a steward-dispatched root lead request the initial handoff gate. Its root tool request stays open while the live `confirm` approval card awaits the steward through the existing Conversation approve route; nothing is dispatched, no audience changes, and no budget is consumed before confirmation. Child stages of an approved workflow may hand off again within the finite per-workflow budget (depth 3 / edges 8 / rework 2) with no further per-handoff gate. Accepted edges are durable, replay-correlated handoff events; approvals stay live-only, abort stays one direct active conversation × agent run, and there is no hidden task bridge, queue, retry, reroute, fallback, or auto-approval. The active Workbench renders handoff-gate cards and live stage events.
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
- [Token discipline](docs/token-discipline.md)
- [Migrating from Hermes](docs/migrating-from-hermes.md)
- [Operations](docs/operations.md)
- [Service management](docs/service-management.md)
- [Recovery](docs/recovery.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)
- [API reference](docs/api.md)

## Releases and updates

Piren 0.1.7 is the current stable release on npm. Update an existing global install with:

```bash
piren update
```

`piren update` installs the latest `@odiobill/piren` release from the npm registry. It refuses a major-version jump unless you pass `--yes` (`piren update --yes`).

**Upgrading from 0.1.3?** Run `npm install -g @odiobill/piren` once. That older command used a retired GitHub install path; after this one-time registry install, `piren update` uses the registry.

## License

Piren is released under the MIT License. See [LICENSE](LICENSE).
