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

## Package extensions

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
