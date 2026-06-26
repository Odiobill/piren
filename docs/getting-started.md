# Getting started

This guide gets Piren running from source with a disposable vault.

## Requirements

- Linux or macOS.
- Node.js 22 or newer. Discord transport uses native `WebSocket`.
- npm.
- Pi Coding Agent credentials configured separately if you want real model calls. Piren does not manage provider auth.

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

`setup --apply` does not overwrite existing config values. Running `piren setup`
with no flags is a dry-run health check, or, when connected to a terminal,
launches an interactive wizard that guides you through vault, LLM provider key,
and local config. The wizard detects an existing vault and asks which agents to
enable, or initializes a new one with a first agent name (default `piren`).

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
