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
The injected content and message shape are identical in both modes — only the timing changes. There is no Web UI setting for this preference; it lives only in `team/<agent>/config.yml`.

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

Telegram:

```yaml
telegram:
  bot_token: "123456:telegram-bot-token"
  allowed_chat_ids:
    - 123456789
  default_agent: piren
```

Discord:

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
