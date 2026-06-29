# Getting started

This guide gets Piren running from source with a disposable vault.

## Requirements

- Linux or macOS.
- Node.js 22 or newer. Discord transport uses native `WebSocket`.
- npm.
- Pi Coding Agent credentials configured separately if you want real model calls, or provide `--provider` plus `--api-key` to `piren setup --apply`.

## Install Piren

```bash
npm install -g --install-links github:Odiobill/piren
```

`--install-links` is required for reliable npm 11 GitHub installs: it makes npm
copy the package into the global prefix instead of leaving the `piren` command
pointing into npm's temporary Git cache.

## Create a vault

```bash
piren init --vault-root /tmp/piren-vault
```

This creates a `.piren-vault` marker, shared directories, and the default `team/piren/` agent.

Use another first agent name when needed:

```bash
piren init --vault-root /tmp/piren-vault --agent thor
```

## Configure the local installation

The preferred local config is `~/.config/piren/config.yml`:

```yaml
vault_root: /tmp/piren-vault
allowed_agents:
  - piren
```

You can scaffold it safely:

```bash
piren setup --apply --vault-root /tmp/piren-vault --agent piren
```

To configure the first model and provider key in the same non-interactive step:

```bash
piren setup --apply \
  --vault-root /tmp/piren-vault \
  --agent piren \
  --provider anthropic \
  --model claude-sonnet-4-6 \
  --thinking medium \
  --api-key sk-...
```

`setup --apply` does not overwrite existing local installation config values. When `--provider` and `--model` are supplied it writes the selected agent's model block; otherwise a fresh agent config is left without a model so Pi can use native defaults. Running `piren setup`
with no flags is a dry-run health check, or, when connected to a terminal,
launches an interactive wizard. The wizard:

1. Detects an existing vault and asks which agents to enable, or initializes a
   new one with a first agent name (default `piren`).
2. Configures a Pi LLM provider and API key, then offers a model selection
   (from a curated flagship catalog, or a custom id) and an optional thinking
   level, writing the choice to the agent-local `config.yml`.
3. Writes the local installation config, then optionally configures a Telegram
   or Discord gateway.

For the full live model list after setup, run `pi --list-models`.

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
piren agent add thor              # scaffold team/thor/ and permit it
piren agent clone piren sage      # copy team/piren/ to team/sage/ and permit sage
piren agent remove thor           # drop permission; prompts before deleting the dir
piren agent remove thor --yes     # non-interactive: also delete the vault dir
```

`add` scaffolds the agent directory (SOUL.md, MEMORY.md, config.yml, and the
inbox/outbox/devices/logs/sessions/skills subdirectories). `clone` copies a
source agent's directory verbatim, including its identity and memory. `remove`
always drops the agent from `allowed_agents`; it only deletes the vault
directory after an explicit confirmation (or `--yes`).

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

Open `http://127.0.0.1:7317/`.

For LAN exposure, bind a non-localhost address and use a token:

```bash
piren gateway --host 0.0.0.0
```

Piren auto-generates and persists a gateway token when needed. See [Security](security.md).

## Verify the repository

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```
