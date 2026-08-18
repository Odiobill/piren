# Operations

This page covers routine operator tasks for the installed product.

## Fresh machine setup

On a clean machine or container, install Node.js 22+ and npm first, then set up Piren from a global install:

```bash
npm install -g @odiobill/piren
piren init --vault-root /tmp/piren-vault
piren setup --apply --vault-root /tmp/piren-vault --agent piren
piren setup --apply --vault-root /tmp/piren-vault --agent piren --provider anthropic --model claude-sonnet-4-6 --thinking medium
piren doctor
piren status
```

Then start `piren gateway` on localhost and load the web UI. If you want to test real model calls, verify Pi auth first and run a short `piren ask`.

## Update a global install

```bash
piren update
```

`piren update` resolves the latest `@odiobill/piren` release from the npm registry and runs `npm install -g @odiobill/piren`. It refuses a major-version jump unless you pass `--yes` (`piren update --yes`), never prompts interactively, and has no automatic rollback. If `npm install` fails it reports the error and exits non-zero; npm global installation is not transactional, so state may already have changed.

## Running long-lived transports

Piren can generate and manage supervisor files for each transport:

```bash
piren service install gateway
piren service start gateway
piren service status gateway
```

Piren prefers systemd user units and falls back to tmux plus `@reboot` cron on
systems without a systemd user session (DietPi, stripped-down SBCs). All
generated files live under `~/.config/piren/services/` and are inspectable and
reversible. See [Service management](service-management.md) for full details,
including the `loginctl enable-linger` step for systemd user units.

For quick manual (foreground) runs:

```bash
piren gateway
piren telegram
piren discord
```

## Cleanup

Dry-run local state cleanup:

```bash
piren clean
```

Actually remove Piren local state:

```bash
piren clean --force
```

Then uninstall the package if installed globally:

```bash
npm uninstall -g @odiobill/piren
```

Legacy unscoped cleanup: if you installed Piren from GitHub before it became the scoped `@odiobill/piren` package, the orphaned unscoped global entry can be removed separately as a one-time manual migration step (never done automatically by `piren update`):

```bash
npm uninstall -g piren   # legacy migration only; only for old unscoped GitHub installs
```

`piren clean` targets local Piren state, not the vault.

## Backups

The vault is the source of truth. Back it up like any other Obsidian vault or project repository. Keep local secrets outside the vault.
