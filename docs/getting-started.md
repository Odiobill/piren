# Getting started

This guide gets Piren running from source with a disposable vault.

## Requirements

- Linux or macOS.
- Node.js 22 or newer. Discord transport uses native `WebSocket`.
- npm.
- Pi Coding Agent credentials configured separately if you want real model calls. Piren does not manage provider auth.

## Install from source

```bash
git clone https://github.com/Odiobill/piren.git
cd piren
npm install
npm run build
```

## Create a vault

```bash
node dist/src/cli.js init --vault-root /tmp/piren-vault
```

This creates a `.piren-vault` marker, shared directories, and the default `team/piren/` agent.

Use another first agent name when needed:

```bash
node dist/src/cli.js init --vault-root /tmp/piren-vault --agent thor
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
node dist/src/cli.js setup --apply --vault-root /tmp/piren-vault --agent piren
```

`setup --apply` does not overwrite existing config values. Dry-run setup is the default:

```bash
node dist/src/cli.js setup
```

## Check status

```bash
node dist/src/cli.js status
node dist/src/cli.js agents
node dist/src/cli.js doctor
```

If you do not want to touch local config, pass the vault and agent explicitly:

```bash
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren status
```

Print the installed version:

```bash
node dist/src/cli.js version
```

## Run an agent

```bash
node dist/src/cli.js run
node dist/src/cli.js --vault-root /tmp/piren-vault --agent piren run
```

`piren chat` is an alias for `piren run`.

Forward extra Pi arguments after `--`:

```bash
node dist/src/cli.js run -- --print "hello"
```

If no model is configured in `team/<agent>/config.yml`, Pi falls back to its native settings under `~/.pi/agent/`.

## Start the web gateway

```bash
node dist/src/cli.js gateway
```

Open `http://127.0.0.1:7317/`.

For LAN exposure, bind a non-localhost address and use a token:

```bash
node dist/src/cli.js gateway --host 0.0.0.0
```

Piren auto-generates and persists a gateway token when needed. See [Security](security.md).

## Verify the repository

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```
