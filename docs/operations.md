# Operations

This page covers routine operator tasks and the clean-install checklist.

## Verify a source checkout

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

Current expected baseline: 51 test files, 342 tests, typecheck/build/smoke passing.

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

## Automated clean-install validation

Piren ships a clean-install validation script that installs the package from
the real GitHub source into an isolated HOME and verifies the installed binary:

```bash
npm run clean-install:check
```

It performs a real `npm install github:Odiobill/piren` in a fresh prefix with
an isolated clean HOME, then checks:

- `dist/src/cli.js`, `dist/public/index.html`, and `dist/src/pi-extension.js`
  are present (catches a missing build).
- The installed `piren` binary actually runs.
- The Pi runtime policy resolves: a local `pi` on PATH is preferred, otherwise
  Piren falls back to `npx --yes -p @earendil-works/pi-coding-agent@latest pi`.

The script exits non-zero on any failure, so it is safe in CI. Options:

```bash
npm run clean-install:check -- github:Odiobill/piren   # explicit spec
npm run clean-install:check -- /path/to/piren-0.1.0.tgz
npm run clean-install:check -- --keep                  # keep the install for inspection
```

### GitHub installs and build artifacts

Piren builds TypeScript during `github:` installation through a small prepare
bootstrap (`scripts/prepare-build.cjs`). The bootstrap handles npm git-dependency
preparation on stripped-down machines: if npm did not install devDependencies
into the clone before running `prepare`, it runs a local `npm install
--include=dev --ignore-scripts` first, then builds `dist/`. `prepack` also
rebuilds `dist/` when creating npm tarballs via `npm pack`.

If a clean-install check reports missing `dist/` files, the prepare bootstrap or
build failed. Run the check with `--keep` and inspect the isolated npm logs.

## Global install smoke

```bash
npm install -g github:Odiobill/piren
piren --version || true
piren status
```

Piren's package runs a prepare bootstrap for git installs, so `npm install -g github:Odiobill/piren` can build `dist/` even when npm git preparation initially omits devDependencies. `npm run clean-install:check` automates the full verification described above.

## Running long-lived transports

Run transports under your own supervisor:

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
