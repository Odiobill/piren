# Configuration

Piren separates local installation authority from vault-defined agent identity.

## Where do I change X?

This table is the quick way to pick the right authority and preferred path. Use the Workbench Settings page when a workflow exists for the family; where it does not, use the named command or file. Each row links to detailed guidance.

| What you want to change | Preferred path | Authority and location |
| --- | --- | --- |
| [First local installation](getting-started.md#configure-the-local-installation) (vault root, runnable agents) | `piren setup` (interactive) or `piren setup --apply`; then `piren agent add/remove` | `~/.config/piren/config.yml` (machine-local). The runnable-agent policy is not editable from Workbench Settings. |
| [Transport configuration](#transport-config) and write-only bot tokens | Workbench Settings **This installation** tab, then `piren telegram configure` / `piren discord configure` | `~/.config/piren/config.yml`; tokens stay machine-local and write-only |
| [Scheduler automation](#scheduler-config) and settings | Workbench Settings **This installation** tab, then `piren scheduler configure` | `~/.config/piren/config.yml` `scheduler:` block (the guided writer is the only migration path for a retired key) |
| [Agent preferences](#agent-local-config) (model fallback, context injection, self-improvement) | Workbench Settings **Agent settings** tab, then edit the file | `team/<agent>/config.yml` (vault-owned) |
| [Agent groups](agent-groups.md) and group-scoped fallback | Workbench Settings **Agent groups** tab, then `piren group` | `agent-groups/<group>/config.yml` (vault-owned) |
| [Services](service-management.md) (install, start, stop, status) | CLI only: `piren service <action> <target>` | `~/.config/piren/services/`; the Workbench shows a read-only inventory and never acts on services |
| [Provider credentials](getting-started.md#configure-pi) and custom providers | Pi-native: `/login` and `~/.pi/agent/` files; `piren setup --apply --api-key` merges keys | There is no Workbench Settings workflow for provider credentials |
| [`workbench.yml`](#workbench-config-workbenchyml) Conversation timeout | Manual edit of the vault-root file | `workbench.yml` is steward-managed: Piren reads it and never writes it, and the browser never reads or edits it |

## Local installation config

Local config lives outside the vault:

```text
~/.config/piren/config.yml
```

Typical config:

```yaml
vault_root: /path/to/vault
allowed_agents:
  - piren
excluded_agents:
  - other-agent
packages:
  - "@piren/web-search"
```

This file answers: which vault can this machine use, and which agents may it run?

`allowed_agents` is an allowlist. If it is empty or absent, Piren warns because the installation can run any vault-defined agent.

`excluded_agents` removes agents from the effective runnable set.

Scoped npm packages must be quoted in YAML. Use `"@piren/web-search"`, not `@piren/web-search`.

## Runtime agent selection

Preferred selection methods:

```bash
piren --agent piren status
piren -a piren status
piren --agent=piren status
PIREN_AGENT=piren piren status
```

If exactly one effective allowed agent exists, Piren can infer it.

Low-level overrides:

```bash
PIREN_AGENT_DIR=/path/to/vault/team/piren piren status
piren --agent-dir /path/to/vault/team/piren status
```

## Vault root override

For explicit vault selection, pass the vault root directly:

```bash
piren --vault-root /tmp/piren-vault --agent piren status
```

## Agent-local config

Agent-local preferences live inside the vault:

```text
team/<agent>/config.yml
```

Use it for runtime preferences such as model and polling. Do not put `allowed_agents` here.

With the gateway running, the Workbench Settings **Agent settings** tab is the easiest way to edit these preferences (model and fallback, context injection, self-improvement); it writes this same file through typed, atomic workflows and never changes a live session. This section documents the file format.

Model examples:

```yaml
model:
  id: anthropic/claude-sonnet-4-20250514
  thinking: medium
```

or:

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-20250514
  thinking: medium
models:
  - provider: anthropic
    id: claude-sonnet-4-20250514
    thinking: medium
  - provider: openai
    id: gpt-4.1
    thinking: off
```

Piren translates this to Pi-native `--model` and `--models` flags. Provider credentials and custom providers remain in Pi's native config under `~/.pi/agent/`.

Freshly scaffolded agent configs created by `piren setup` or `piren agent add` use Pi's native defaults from `~/.pi/agent/settings.json` when `defaultProvider` and `defaultModel` are present, plus `defaultThinkingLevel` when available. If Pi defaults are unavailable, Piren writes only the worker polling defaults and does not include an empty `model: {}` block. If no model block is present, Piren does not pass `--model` and Pi falls back to its native defaults.

### Model fallback

An agent can declare an optional ordered list of fallback models. When a run fully settles as an eligible zero-side-effect provider error on the same live Pi client/session, Piren switches to the next declared model and re-prompts, in declaration order, at most once per entry per incident. An absent or malformed declaration is inert, and `auto_switch: false` keeps the block valid but disabled:

```yaml
model:
  id: kimi-coding/k3
  thinking: high
  fallback:
    auto_switch: true   # optional boolean, default true
    models:             # ordered list of exact Pi provider/modelId strings
      - opencode-go/kimi-k3
      - openrouter/kimi-k3
```

A present block must be a mapping with a non-empty ordered `models` array of exact lowercase `provider/modelId` strings (colon-bearing ids such as `ollama/llama3.1:8b` are preserved), at most five entries, no duplicates, and an optional boolean `auto_switch` (default true). You can also edit the declaration from the Workbench Settings **Agent settings** tab, where saving one that leaves auto-switch enabled requires an explicit extra confirmation. `piren doctor` validates the declared block per agent with a count-only check: a malformed block or one duplicating the configured `model.id` warns with guidance, and no model IDs or secrets ever appear in doctor output.

What triggers fallback:

- Only a run that fully settles (`agent_settled`) as a zero-side-effect provider error (`provider_error_other` or `provider_error_transient_exhausted`) is eligible. Prompt rejections, aborts, non-settled or contaminated runs, and launch failures keep existing behavior with no fallback.
- Rotation stays on the same live client/session of the same agent. After a success the fallback model remains for that session's affinity; a fresh session starts on the configured primary again.
- An explicit steward model selection via `POST /api/chat/model` disables automatic fallback for that session; `autoFallback: true` on the same route re-enables it explicitly.
- Fallback never auto-approves, retries, reroutes, re-claims, or re-dispatches anything, and it never changes provider credentials: credentials stay Pi-native under `~/.pi/agent/`; this vault configuration only names model IDs.

Where it applies:

| Surface | Behavior |
| --- | --- |
| Gateway chat (`POST /api/chat/start`) | Wired. A structured `model_fallback` SSE event precedes each attempt; an unavailable switch is skipped with evidence; exhaustion is terminal. |
| OpenAI-compatible API (`POST /api/v1/chat/completions`) | Wired, streaming and non-streaming. Same rotation gate; the response stays assistant-content-only with no Piren event. |
| Conversations | The conversation broker rotates inside its already-active isolated `conversation×agent` client. Bounded durable `model_fallback` events precede each attempt's re-prompt; terminal exhaustion settles the run as exactly one failed `provider_error`. Abort/close/timeout cancels remaining attempts; conversation approvals stay exact and are never auto-approved. |
| Telegram and Discord transports | Wired. A bounded non-secret advisory line precedes the fallback reply, with unavailable-skip and exhaustion notices; message-size limits, topic routing, access control, and best-effort feedback are unchanged. |
| `piren ask` | Wired. Switches model and re-prompts with the verbatim handoff, printing a bounded `[model fallback: <from> failed (<category>) → <to>]` advisory before the fallback reply; exhaustion surfaces typed evidence only, never raw provider errors. |
| Scheduler claimed inbox tasks and agent cron | Wired through the same ask runner. Normal completion keeps the existing success and completion-release path; terminal exhaustion stays claimed for manual triage with typed evidence visible in `piren scheduler --once`; only a typed launch failure reaches the unchanged retry policy. |
| Script-mode cron | Not wired: script-mode jobs stay LLM-free with no fallback. |
| `piren run` and Pi native `models:` cycling | Not wired to this policy. |

Inspectable self-improvement is configured per agent and defaults to off:

```yaml
self_improvement:
  auto_nudge: true
  review_loop:
    enabled: true
    interval_turns: 10
    recent_messages: 20
    timeout_ms: 120000
```

`auto_nudge` emits an advisory notification when a steward correction is detected. `review_loop` runs an opt-in child Pi prompt after the configured turn interval to decide whether a visible vault artifact should be updated. Both features avoid hidden memory stores and never write outside the vault. Both can also be toggled from the Workbench Settings page.

Context injection is configured per agent:

```yaml
context_injection:
  mode: session_start_only # core default; inject once per session start
  # mode: per_turn         # inject on every prompt instead (explicit declaration required)
```

The Piren context (agent identity, steward directives, SOUL.md, tool catalog, skills catalog) is injected as a visible `piren-context` message that persists in the session transcript.
With the core default `session_start_only`, it is injected only on the first prompt after session startup, `/new`, `/resume`, `/fork`, or reload, and not on later prompts in that session; directive or SOUL.md edits take effect after the next session restart or resume.
With explicit `per_turn`, it is injected on every prompt and each copy accumulates in the transcript.
The injected content and message shape are identical in both modes; only the timing changes. `session_start_only` bounds only the repeated Piren-context copies; the ordinary conversation history of the session still accumulates normally. The preference lives in `team/<agent>/config.yml`; the Workbench Settings page offers a typed workflow that edits the same file through the existing parse contract, with an empty option labelled truthfully `Default (session_start_only)` that writes nothing.

An absent `context_injection` block means the core default `session_start_only` with no warning; agents that need every-turn injection must declare `mode: per_turn` explicitly. An unknown mode or a non-map block falls back to `session_start_only` with a visible startup warning, and `piren doctor` reports a `context-injection` warning for the affected agent (doctor assesses agent config only, never the environment override). `piren_status` reports the resolved mode as `context_injection: <mode>`.

For a single-process override, `PIREN_CONTEXT_INJECTION=per_turn|session_start_only` overrides the agent-local value; an invalid override value falls back to the configured value with a warning.

For non-interactive provisioning, `setup --apply` can write both Pi-native auth and the agent-local model preference:

```bash
piren setup --apply \
  --vault-root /tmp/piren-vault \
  --agent piren \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --thinking medium \
  --api-key sk-...
```

`--api-key` merges into `~/.pi/agent/auth.json` and preserves existing provider entries. If `--provider` and `--model` are supplied, Piren writes `team/<agent>/config.yml` with a concrete `model:` block. Omit `--api-key` when credentials are already available through Pi-native auth or provider environment variables.

## Package extensions

Piren itself does not pin Pi as a package dependency. At runtime it requires `pi` on `PATH`; if missing, `piren setup` tells the operator to install Pi with `curl -fsSL https://pi.dev/install.sh | sh` and exits without mutating Piren files. `piren doctor` reports the missing runtime as a failure.

Additional Pi extensions are declared in local config:

```yaml
packages:
  - "@piren/web-search"
  - "@piren/git-tools"
```

Piren loads its core extension first, then each resolved package as an additional `--extension` in declaration order. Missing packages are skipped at runtime and surfaced by `piren doctor`.

## Transport config

Telegram (`piren telegram configure` authors this block interactively; the Workbench Settings page offers the same typed fields with a write-only bot token):

```yaml
telegram:
  bot_token: "123456:telegram-bot-token"
  allowed_chat_ids:
    - 123456789
  default_agent: piren
```

Telegram operator notes:

- The bot token stays in this machine-local file, never in the vault. A private chat or group is enabled only by adding its explicit chat id to `allowed_chat_ids`.
- BotFather Privacy Mode caveat: while Privacy Mode is enabled (the BotFather default), a bot in a group receives commands, mentions, and replies rather than ordinary group messages. An operator who wants ordinary group-message routing must explicitly disable it in BotFather. Either way, `allowed_chat_ids` remains the final inbound gate.
- In a forum (topics) group, each topic is an isolated live conversation: replies and typing stay in the originating topic and every command is topic-scoped. This is routing only — it adds no configuration and does not widen authorization beyond the chat id.
- `/new` starts a fresh Pi session for the current live conversation and keeps its active agent; `/compact` invokes Pi's native manual compaction for it. Neither accepts arguments or custom instructions, neither creates a session when none is active, and there is no transport `/resume`: no conversation-to-session mapping survives a transport-process restart.

Discord (`piren discord configure` authors this block interactively; the Workbench Settings page offers the same typed fields with a write-only bot token):

```yaml
discord:
  bot_token: "your-discord-bot-token"
  application_id: "123456789012345678"
  install_url: "https://discord.com/oauth2/authorize?client_id=..."
  allowed_guild_ids:
    - "111"
  allowed_channel_ids:
    - "222"
  allowed_thread_ids:
    - "333"
  # Optional: enable one-to-one DMs only from these explicit user IDs
  # (fail-closed when omitted; group DMs are always rejected).
  # allowed_dm_user_ids:
  #   - "444"
  default_agent: piren
```

Discord thread access is fail-closed: a message sent inside a thread is accepted only when that exact thread id appears in `allowed_thread_ids`. A real Discord Gateway `MESSAGE_CREATE` inside a thread carries the thread's own id in `channel_id` with no `thread_id` property; both shapes are recognized, and `allowed_thread_ids` never widens `allowed_channel_ids`.

### Steward alert mirror (opt-in)

`flag_steward` always writes the authoritative alert file under `steward-inbox/alerts/` first. Optionally, Piren can then send a minimal best-effort advisory notification to configured Telegram and/or Discord destinations:

```yaml
alert_mirror:
  enabled: true                 # absent or false -> fully inert (default)
  min_severity: high            # optional; low < normal < high < urgent; inclusive floor, default low
  include_body: false           # optional; default false
  telegram:
    chat_id: 123456789          # destination only; token reused from telegram.bot_token
  discord:
    channel_id: "1234567890"    # destination only; token reused from discord.bot_token
```

- Disabled by default. Nothing is sent unless `enabled: true` and at least one destination has both an id and its matching existing bot token.
- The vault alert file remains the only authoritative record. Delivery is best-effort and never guaranteed: there is no retry, queue, or durable delivery state, and a delivery failure never changes the alert.
- Default payload is two lines: `[severity] title` and the vault-relative alert path. The alert body is omitted unless `include_body: true` — enable that only if alert bodies may leave the vault for your destinations.
- `min_severity` is an inclusive floor: alerts at or above it are mirrored.
- An alert flagged with `notify: false` is never mirrored.
- A fixed process-local 5-second per-destination rate limit drops (never queues) bursts; the window starts only after a successful send.
- Destination ids stay local-only and do not interact with inbound allowlists; no inbound authorization is widened. There is no Web UI configuration for the mirror.
- `piren doctor` validates the block when present (disabled/ok, invalid severity, missing tokens, no usable destination). `piren_status` reports only `alert_mirror: disabled` or `alert_mirror: enabled (<n> destinations)` — never ids, tokens, or delivery state.

Gateway token can be passed through `--token`, `PIREN_TOKEN`, or `~/.config/piren/gateway-token`.

## Scheduler config

The device-local scheduler is **disabled by default** and configured under `scheduler:` in the same local file. Preferred paths first: the Workbench Settings **Scheduler** tab or `piren scheduler configure` (guided, and the only writer that can clear a gated retired key). The block below is the file reference:

```yaml
scheduler:
  automation:
    inbox_tasks: true         # sole inbox gate (default false)
    agent_cron: true          # sole agent-cron gate (default false)
    script_cron: true         # sole script-cron gate (default false)
  agent_scope:              # optional per-class agent narrowing (all eligible when omitted)
    inbox_tasks:
      allow: [agent-a]      # optional; present empty list allows none
      exclude: [agent-b]    # optional; exclusion wins over allow
    agent_cron: {}
    script_cron: {}
  poll_interval_seconds: 30
  stale_after_seconds: 300
  max_concurrent_agents: 1
  device_id: workstation      # optional; absent -> sanitized hostname
```

Absent or malformed class values resolve disabled (fail closed). Optional `agent_scope` narrows, per class, which locally enabled agents' work that class may claim: an omitted/empty scope leaves every locally enabled agent eligible, `allow` narrows to the runnable intersection, `exclude` wins over `allow`, configured non-runnable names are warned-and-ignored (never widening), and any malformed present scope fails closed for the affected class. A retired `scheduler.enabled` key is never a gate: `true` is inert-to-ignore, and `false` or a malformed value gates every class off until an operator-confirmed `piren scheduler configure` migration removes the stale key; Settings and doctor report that state read-only and never migrate it. Supervision stays separate: a running scheduler with every class disabled is an inert supervisor. `piren scheduler configure` is the guided interactive writer (current-state display, preview, confirmation, atomic write; never starts anything) and preserves any `agent_scope` block you manage by hand. The Workbench Settings page offers the same typed fields over the same atomic, fail-closed write discipline; saving never installs, starts, or ticks anything. See [scheduler.md](scheduler.md) for the full semantics, including class agent scope and the non-persistent `piren scheduler --once --force` override (a disabled inbox automation class only, one tick, never cron, never the legacy gate, never the class agent scope).

## Workbench config (workbench.yml)

The optional vault-root `workbench.yml` file is steward-managed: Piren reads it and never writes it, so any unrelated keys you keep there are preserved. It currently defines exactly one key:

```yaml
conversation:
  run_timeout_seconds: 3600
```

`run_timeout_seconds` is the hard deadline for one Workbench Conversation agent run (the exact `conversation × agent` run is settled as `timed_out`; abort stays available; there is no retry, fallback, reroute, or re-dispatch). Valid values are whole numbers from `1` to `3600`. When the file, the `conversation` block, or the key is absent, the default is `3600` seconds (60 minutes).

The value is read once when the gateway process starts and applies to runs started after that; restart the gateway (`piren gateway`) to apply a change. If the YAML is malformed, the value has the wrong type, or it is out of range, the gateway logs one bounded warning naming only the key path and a reason category, then uses the default — raw file content and values are never echoed. The browser never reads or edits this file.

## Environment variables

Common overrides:

- `PIREN_AGENT`: selected runtime agent.
- `PIREN_AGENT_DIR`: low-level direct agent directory override.
- `PIREN_WORKER=1`: enable worker-mode behavior inside the Pi extension.
- `PIREN_DEVICE_ID`: override device id for tests or supervised deployments.
- `PIREN_HOSTNAME`: override hostname in device records.
- `PIREN_LOCAL_OUTBOX_DIR`: override degraded-write local outbox.
- `PIREN_LOCAL_CACHE_DIR`: override non-authoritative cache directory.
- `PIREN_TOKEN`: gateway Bearer token.
- `PIREN_CRON_STALE_MS`: cron active-device staleness threshold.
- `PIREN_AUTO_NUDGE`: override `self_improvement.auto_nudge` (`1/true/on` or `0/false/off`).
- `PIREN_CONTEXT_INJECTION`: override `context_injection.mode` for one process (`per_turn` or `session_start_only`).
- `PIREN_REVIEW_LOOP`: override `self_improvement.review_loop.enabled` (`1/true/on` or `0/false/off`).
- `PIREN_REVIEW_INTERVAL_TURNS`: override review loop turn interval.
- `PIREN_REVIEW_RECENT_MESSAGES`: override how many recent user/assistant messages the review prompt sees.
- `PIREN_REVIEW_TIMEOUT_MS`: override the child Pi review timeout.
