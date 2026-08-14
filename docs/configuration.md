# Configuration

Piren separates local installation authority from vault-defined agent identity.

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

Low-level overrides remain for smoke tests and debugging:

```bash
PIREN_AGENT_DIR=/path/to/vault/team/piren piren status
piren --agent-dir /path/to/vault/team/piren status
```

## Vault root override

For disposable vaults or CI, pass the vault root directly:

```bash
piren --vault-root /tmp/piren-vault --agent piren status
```

## Agent-local config

Agent-local preferences live inside the vault:

```text
team/<agent>/config.yml
```

Use it for runtime preferences such as model and polling. Do not put `allowed_agents` here.

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

Model fallback declarations configure the bounded gateway automatic-continuation policy:

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

An absent `model.fallback` block is inert and does nothing. A present block must be a mapping with a non-empty ordered `models` array of exact lowercase `provider/modelId` strings (colon-bearing ids such as `ollama/llama3.1:8b` are preserved), at most five entries, no duplicates, and an optional boolean `auto_switch` (default true). `piren doctor` validates the declared block per agent: a valid block reports a count-only `model-fallback` ok check, `auto_switch: false` stays valid and inspectable, a malformed block or one duplicating the configured `model.id` reports a `model-fallback` warning with guidance, and no model IDs or secrets ever appear in doctor output.

Runtime scope (model fallback TB4): the gateway chat flow (`POST /api/chat/start` + `GET /api/chat/stream`) and the OpenAI-compatible route (`POST /api/v1/chat/completions`, streaming and non-streaming) rotate to the declared fallback models on the **same live Pi client/session** when a run fully settles (`agent_settled`) as a zero-side-effect provider error (`provider_error_other` or `provider_error_transient_exhausted`). Rotation is bounded: declaration-order at-most-once per incident, an unavailable `set_model` is skipped with evidence, and exhaustion is terminal. A `model_fallback` SSE event (`{kind, from, to, category, attempt, exhausted}`) precedes each attempt on the gateway chat stream only; the OpenAI response stays assistant-content-only with no Piren event. An explicit `POST /api/chat/model` steward selection disables automatic fallback for the session; `autoFallback: true` on the same route re-enables it explicitly. The active fallback model remains session affinity after success; a fresh session (new conversation or agent switch) starts on the configured primary again. Absent, malformed, `auto_switch: false`, prompt-rejected, aborted, non-settled, contaminated, and `launch_failure` cases keep existing behavior with no fallback. `piren ask` (model fallback TB5) wires the same bounded same-live-client rotation at the CLI: after a settled zero-side-effect eligible provider error it switches model and re-prompts with the verbatim handoff, prints a bounded `[model fallback: <from> failed (<category>) → <to>]` stdout advisory before the fallback reply, and surfaces typed non-ok exhaustion (category/model/count evidence only, never raw provider error text). The scheduler `createAskRunner` now wires the same fallback in its own gated bullet (model fallback TB8). The conversation broker (model fallback TB6) rotates inside its already-active isolated `conversation×agent` client with the same gate: durable `model_fallback` events (system-authored, correlated to the steward root, bounded non-secret from/to/category/attempt or an explicit unavailable skip) are appended before each handoff re-prompt, and terminal exhaustion writes exactly one `run_finished` failed `provider_error`, distinct from `ambiguous`/`launch_failure`. Abort/close/timeout/exit (including during `set_model`) cancels remaining attempts; conversation approvals stay exact conversation×agent×request-id and never auto-approve; the conversation broker's agent handoff is the separately delivered C5 gated `conversation_handoff(to, text)` tool (steward-approved initial gate, finite per-workflow budget, broker-derived identity only — see [gateway.md](gateway.md)), while its approval/abort controls are Conversation-scoped and delivered separately (see [API reference](api.md)) — model fallback never auto-approves, retries, or reroutes them. Telegram and Discord transports (model fallback TB7) run the same bounded same-live-conversation-client rotation and send bounded non-secret advisory text in the ordinary platform reply flow: `[model fallback: <from> failed (<category>) → <to>]` before the fallback reply, a bounded unavailable-skip line, and a bounded terminal notice when exhausted; every advisory+reply payload stays within the existing `chunkTelegramMessage`/`chunkDiscordMessage` limits; no durable transport vault record is introduced; topic routing and guild/channel/thread/DM authorization are unchanged; receipt/typing/completion feedback stays best-effort and never suppresses the advisory/reply. The scheduler (model fallback TB8) wires the same bounded same-live-client rotation into already-claimed inbox and agent-mode cron executions through the shared `createAskRunner` (policy resolved at the production runtime adapter boundary; absent/malformed/disabled/no-primary inert): normal completion keeps the existing success + completion-release path; terminal exhaustion stays claimed for explicit coordinator/steward triage with a typed `exhausted` failure and a bounded attempt/unavailable/exhaustion summary visible in `piren scheduler --once`; only a typed `launch_failure` reaches the unchanged retry seam; script-mode cron stays LLM-free with no fallback. `piren run` and Pi native `models:` cycling are not wired to this policy yet. Provider credentials and availability remain Pi-native under `~/.pi/agent/`; this vault configuration only names model IDs.

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

`auto_nudge` emits an advisory notification when a steward correction is detected. `review_loop` runs an opt-in child Pi prompt after the configured turn interval to decide whether a visible vault artifact should be updated. Both features avoid hidden memory stores and never write outside the vault.

Context injection is configured per agent:

```yaml
context_injection:
  mode: per_turn            # default; inject the Piren context on every prompt
  # mode: session_start_only # inject once per session instead
```

The Piren context (agent identity, steward directives, SOUL.md, tool catalog, skills catalog) is injected as a visible `piren-context` message that persists in the session transcript.
With the default `per_turn`, it is injected on every prompt and each copy accumulates in the transcript.
With `session_start_only`, it is injected only on the first prompt after session startup, `/new`, `/resume`, `/fork`, or reload, and not on later prompts in that session; directive or SOUL.md edits take effect after the next session restart or resume.
The injected content and message shape are identical in both modes — only the timing changes. `session_start_only` bounds only the repeated Piren-context copies; the ordinary conversation history of the session still accumulates normally. The default remains `per_turn`; controlled measurements for any future default change are not complete. There is no Web UI setting for this preference; it lives only in `team/<agent>/config.yml`.

An absent `context_injection` block means `per_turn` with no warning. An unknown mode or a non-map block falls back to `per_turn` with a visible startup warning, and `piren doctor` reports a `context-injection` warning for the affected agent (doctor assesses agent config only, never the environment override). `piren_status` reports the resolved mode as `context_injection: <mode>`.

For one-process measurement, `PIREN_CONTEXT_INJECTION=per_turn|session_start_only` overrides the agent-local value; an invalid override value falls back to the configured value with a warning.

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

Telegram (`piren telegram configure` authors this block interactively):

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

Discord (`piren discord configure` authors this block interactively):

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
