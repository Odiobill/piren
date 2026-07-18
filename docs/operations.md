# Operations

This page covers routine operator tasks and the clean-install checklist.

## Verify a source checkout

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

Current expected baseline: 92 test files, 1132 tests, typecheck/build/smoke passing.

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

Example from a global install:

```bash
npm install -g --install-links github:Odiobill/piren
piren init --vault-root /tmp/piren-vault
piren setup --apply --vault-root /tmp/piren-vault --agent piren
piren setup --apply --vault-root /tmp/piren-vault --agent piren --provider anthropic --model claude-sonnet-4-6 --thinking medium
piren doctor
piren status
```

## Update a global install

```bash
piren update
```

`piren update` runs `npm install -g --install-links github:Odiobill/piren`, then prints the command output and exits non-zero if npm fails. Use it when a device already has a working global `piren` binary and should pull the latest `origin/main` release artifacts.

## Automated clean-install validation

Piren ships a clean-install validation script that installs the package from
the real GitHub source into an isolated HOME and verifies the installed binary:

```bash
npm run clean-install:check
```

It performs a real `npm install --install-links github:Odiobill/piren` in a fresh prefix with
an isolated clean HOME, then checks:

- `dist/src/cli.js`, `dist/public/index.html`, and `dist/src/pi-extension.js`
  are present (catches a missing build).
- The installed `piren` binary actually runs.
- The Pi runtime policy resolves: a local `pi` on PATH is required.

The script exits non-zero on any failure, so it is safe in CI. Options:

```bash
npm run clean-install:check -- github:Odiobill/piren   # explicit spec
npm run clean-install:check -- /path/to/piren-0.1.0.tgz
npm run clean-install:check -- --keep                  # keep the install for inspection
```

### GitHub installs and build artifacts

Piren does not build TypeScript on the target machine during `github:`
installation. The repository carries committed `dist/` release artifacts, so
`npm install -g --install-links github:Odiobill/piren` can link the existing binary without
requiring `typescript` or dev dependencies on the device. The package uses
`prepack` to rebuild `dist/` when creating npm tarballs via `npm pack`.

If a clean-install check reports missing `dist/` files, the GitHub source or
tarball being installed did not include the release artifacts. Rebuild and
commit `dist/`, or install from a freshly generated tarball.

## Global install smoke

```bash
npm install -g --install-links github:Odiobill/piren
piren --version || true
piren status
```

Piren's package uses committed `dist` artifacts for git installs, so `npm install -g --install-links github:Odiobill/piren` does not need to compile TypeScript on the target machine. `--install-links` avoids npm 11 leaving a global bin symlink that points into the temporary git cache. `npm run clean-install:check` automates the full verification described above.

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

For quick manual runs during development:

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
npm uninstall -g piren
```

`piren clean` targets local Piren state, not the vault.

## Backups

The vault is the source of truth. Back it up like any other Obsidian vault or project repository. Keep local secrets outside the vault.
