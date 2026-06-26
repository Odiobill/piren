# Troubleshooting

## `piren status` cannot find an agent

Check local config:

```bash
cat ~/.config/piren/config.yml
```

Expected:

```yaml
vault_root: /path/to/vault
allowed_agents:
  - piren
```

Then check the vault has `team/<agent>/SOUL.md` and `MEMORY.md`:

```bash
piren agents
piren doctor
```

You can bypass local config for a disposable vault:

```bash
piren --vault-root /tmp/piren-vault --agent piren status
```

## `piren doctor` reports stale or missing agents

`allowed_agents` points at agents not present under `team/`, or an agent directory is missing required files. Fix local config or initialize the agent directory.

## Scoped package config fails to parse

Quote scoped packages in YAML:

```yaml
packages:
  - "@piren/web-search"
```

Unquoted `@piren/web-search` is invalid YAML.

## Declared packages are missing

`piren doctor` warns when packages declared under `packages:` cannot be resolved from `node_modules`. Install the package or remove it from config.

## Gateway works on localhost but not LAN

Non-localhost binds require Bearer auth. Start with:

```bash
piren gateway --host 0.0.0.0
```

Piren prints and persists an auto-generated token if none exists. Send requests with:

```text
Authorization: Bearer <token>
```

## The web UI shows a different model or thinking level than config

The context indicator reads Pi's live session state. Pi persisted session state can differ from `team/<agent>/config.yml`. Check Pi's native settings and current Pi session state before assuming Piren parsed config incorrectly.

## The agent checks inbox without being asked

Default interactive sessions do not enable worker polling. If an agent checks `inbox_list()` anyway, that is prompt behavior, not automatic polling. Worker mode is the only opt-in polling mode.

## Cron job does not run

Cron jobs are surfaced only in worker mode and are not auto-run. Check:

- Job file frontmatter has `enabled: true`.
- Schedule is due.
- A current device heartbeat exists under `team/<agent>/devices/`.
- This device wins active-device priority.
- The agent claims and records the job with `cron_claim` and `cron_record_run`.

## Tests pass but typecheck fails

Vitest uses esbuild and does not prove strict TypeScript correctness. Always run:

```bash
npm run typecheck
```

Common issues are `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and optional properties passed as explicit `undefined`.

## Global command cannot find files

For source checkouts, run:

```bash
npm run build
```

For git global installs, Piren expects committed `dist/` release artifacts. Use `npm install -g --install-links github:Odiobill/piren` on npm 11 so the global binary points at a copied package rather than npm's temporary git cache. If a packaged asset is missing, verify the installed source includes `dist/public/` and `dist/src/cli.js`.

## Clean-install check fails

`npm run clean-install:check` runs a real install into an isolated HOME. If it reports `[FAIL] dist-cli`, the installed GitHub source or tarball did not include the expected `dist/` artifacts.

Fix by rebuilding and committing `dist/`, then reinstalling from GitHub after the commit is pushed. For tarballs, create a fresh one with:

```bash
npm pack
```

If `[FAIL] pi-runtime` appears alongside a passing binary, the clean environment has neither `pi` nor `npx` on PATH. Install Pi, or ensure Node's `npx` is available so Piren can use the `npx --yes -p @earendil-works/pi-coding-agent@latest pi` fallback.
