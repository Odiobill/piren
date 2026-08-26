# Getting started

This guide gets Piren running with a disposable vault.

## Requirements

- Linux or macOS.
- Node.js 22 or newer. Discord transport uses native `WebSocket`.
- npm.
- Pi Coding Agent installed as `pi` on PATH and configured with Pi-native credentials/model settings, or provide `--provider` plus `--api-key` to `piren setup --apply` for scripted provisioning.

## Install Piren

```bash
npm install -g @odiobill/piren
```

This installs the current stable release from the npm registry `latest` channel. The executable is `piren`.

To update an existing global install later:

```bash
piren update
```

`piren update` installs the latest `@odiobill/piren` release from the npm registry. It refuses a major-version jump unless you pass `--yes` (`piren update --yes`), never prompts interactively, and has no automatic rollback.

### Offline / emergency install

For offline or emergency installs from a local tarball:

```bash
npm install -g /path/to/odiobill-piren-<version>.tgz   # local packed tarball
```

This path is not the normal operator install; use the registry command above unless you need an offline or emergency install.

## Configure Pi

If `pi` is not installed yet:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Then restart your shell and run Pi's own setup flow:

```bash
pi
# inside Pi:
#   /login
#   /quit
```

## Create a vault

```bash
piren init --vault-root /tmp/piren-vault
```

This creates a `.piren-vault` marker, shared directories, and the default `team/piren/` agent.

Use another first agent name when needed:

```bash
piren init --vault-root /tmp/piren-vault --agent analyst
```

## Configure the local installation

A new installation needs local configuration before anything runs. The Workbench Settings page can only edit an existing configuration; it cannot bootstrap one, so create the configuration once from the command line, then manage ongoing changes from the browser.

### Interactive first-run setup

The guided path is to run `piren setup` with no flags. It requires `pi` on PATH and
Pi-native auth first, then:

1. Detects an existing vault and asks which agents to enable, or initializes a
   new one with a first agent name (default `piren`).
2. Copies Pi's `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`
   from `~/.pi/agent/settings.json` into the newly created agent config when
   available.
3. Writes the local installation config after showing the content and asking
   for confirmation.
4. Prints next commands plus optional service install commands for gateway,
   Telegram, Discord, and the scheduler. After a successful setup (interactive
   or `--apply`), Piren also prints an optional text-only suggestion that you
   can start the Workbench yourself with `piren gateway` (default bind
   localhost, `127.0.0.1`); the suggestion never starts the Workbench or any
   service and never implies it is running.

Bare `piren setup` does not configure provider keys, model selection, Telegram,
Discord, or services interactively. Use Pi's own setup flow for provider/model
auth, `piren setup --apply` for scripted model provisioning, and
`piren service install <gateway|telegram|discord|scheduler>` for always-on
service targets.

For the full live model list after setup, run `pi --list-models`.

### Scripted setup (`--apply`)

For non-interactive provisioning, scaffold the same configuration in one step:

```bash
piren setup --apply --vault-root /tmp/piren-vault --agent piren
```

To configure the first model and provider key at the same time:

```bash
piren setup --apply \
  --vault-root /tmp/piren-vault \
  --agent piren \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --thinking medium \
  --api-key sk-...
```

`setup --apply` does not overwrite existing local installation config values. When `--provider` and `--model` are supplied it writes the selected agent's model block; otherwise a fresh agent config is left without a model so Pi can use native defaults.

### Manual local config

Hand editing is the reference path, useful for scripted machines or fixing a broken install. Local installation config lives outside the vault at `~/.config/piren/config.yml`; prefer the flows above for everyday changes:

```yaml
vault_root: /tmp/piren-vault
allowed_agents:
  - piren
```

See [Configuration](configuration.md) for the full file format.

## Add an optional messaging transport

After `piren setup` has created local configuration, use an explicit guided command for each messaging bot you want to add:

```bash
piren telegram configure
# or
piren discord configure
```

Each command collects only machine-local bot settings, shows a redacted preview, and asks for confirmation before writing `~/.config/piren/config.yml`. It does not start a daemon or service. Check the configuration and make one foreground test before installing a long-running service:

```bash
piren doctor
piren telegram   # or: piren discord
```

See [Telegram and Discord transports](transports.md) for platform prerequisites, access control, and service setup.

## Check status

```bash
piren status
piren agents
piren doctor
```

If you do not want to touch local config, pass the vault and agent explicitly:

```bash
piren --vault-root /tmp/piren-vault --agent piren status
```

Print the installed version:

```bash
piren version
```

## Manage agents

Piren splits agent identity (vault `team/<agent>/` directories) from runtime
permission (local `allowed_agents` in `~/.config/piren/config.yml`). The
`piren agent` command manages both together so you never hand-edit two files.

```bash
piren agent list                  # show vault agents + permission status
piren agent add analyst            # scaffold team/analyst/ and permit it
piren agent clone piren writer      # copy team/piren/ to team/writer/ and permit writer
piren agent remove analyst          # drop permission; prompts before deleting the dir
piren agent remove analyst --yes    # non-interactive: also delete the vault dir
```

`add` scaffolds the agent directory (SOUL.md, MEMORY.md, config.yml, and the
inbox/outbox/devices/logs/sessions/skills subdirectories). When Pi native
defaults are present in `~/.pi/agent/settings.json`, the new agent config is
seeded with that default provider/model/thinking choice, matching the first-run
setup behavior. `clone` copies a source agent's directory verbatim, including
its identity, memory, and model preference. `remove` always drops the agent
from `allowed_agents`; it only deletes the vault directory after an explicit
confirmation (or `--yes`).

See [Vault Layout](vault-layout.md) for the directory structure.

## Run an agent

```bash
piren run
piren --vault-root /tmp/piren-vault --agent piren run
```

`piren chat` is an alias for `piren run`.

Forward extra Pi arguments after `--`:

```bash
piren run -- --print "hello"
```

If no model is configured in `team/<agent>/config.yml`, Pi falls back to its native settings under `~/.pi/agent/`.

## Start the web gateway

```bash
piren gateway
```

Open `http://127.0.0.1:7317/`. The Workbench offers the Dashboard, Conversations, the read-only Vault Explorer, and a typed Settings page; see [Gateway and web UI](gateway.md). Once the gateway is running, that Settings page is the easiest place for ongoing configuration such as transport tokens, scheduler automation classes, and per-agent preferences.

For LAN exposure, bind a non-localhost address and use a token:

```bash
piren gateway --host 0.0.0.0
```

Piren auto-generates and persists a gateway token when needed. See [Security](security.md).
