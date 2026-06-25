# Operations

This page covers routine operator tasks and the pre-RC clean-install checklist.

## Verify a source checkout

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

Current expected baseline: 48 test files, 321 tests, typecheck/build/smoke passing.

## Clean install checklist

On a clean machine or container:

1. Install Node.js 22+ and npm.
2. Install Piren from git or a local checkout.
3. Build the package.
4. Initialize a disposable vault.
5. Scaffold local config.
6. Run `piren doctor`.
7. Run `piren status` and `piren agents`.
8. Start `piren gateway` on localhost and load the web UI.
9. If testing real model calls, verify Pi auth and run a short `piren ask`.
10. Run `piren clean --force` in a fake HOME or disposable environment to verify cleanup.

Example from source:

```bash
git clone https://github.com/Odiobill/piren.git
cd piren
npm install
npm run build
node dist/src/cli.js init --vault-root /tmp/piren-vault
node dist/src/cli.js setup --apply --vault-root /tmp/piren-vault --agent piren
node dist/src/cli.js doctor
node dist/src/cli.js status
```

## Global install smoke

```bash
npm install -g github:Odiobill/piren
piren --version || true
piren status
```

Piren's package has a `prepare` script so git installs build `dist/` before linking the `piren` binary.

## Running long-lived transports

Pre-RC, run transports under your own supervisor:

```bash
piren gateway
piren telegram
piren discord
```

For always-on devices, use systemd, tmux, or your preferred process supervisor. Service lifecycle generation is planned after core RC hardening.

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
npm uninstall -g piren
```

`piren clean` targets local Piren state, not the vault.

## Backups

The vault is the source of truth. Back it up like any other Obsidian vault or project repository. Keep local secrets outside the vault.
