# Troubleshooting

## Start here: the read-only inspection loop

When something needs attention, run these three read-only checks in order before changing anything. Each points you at what to inspect; none of them changes vault state.

1. **`piren doctor`** inspects local configuration and environment. It reports the configured vault root, runnable agent policy, declared packages, transport blocks, optional `alert_mirror` block, and the Pi runtime. Fix configuration by editing `~/.config/piren/config.yml` (and `team/<agent>/config.yml` for agent-local settings) — never copy tokens, bot tokens, or destination IDs into the vault. See [Configuration](configuration.md) for the schema and [Service management](service-management.md) for transport/service setup.
2. **`piren scheduler --report`** is a read-only triage of vault work for the locally enabled agent set. It does not claim, spawn, write, refresh heartbeats, or call any LLM. Each finding prints a reason, a non-action `authority:` boundary stating what Piren cannot infer or will not change, and one `next: piren task show <path>` line that opens the task file. Follow that line, then the triage workflow in [At-least-once risk and manual triage](scheduler.md#at-least-once-risk-and-manual-triage).
3. **Read `steward-inbox/alerts/`** for authoritative alert records. If the optional `alert_mirror` is configured, a Telegram or Discord message about an alert is advisory only: it may be lost, duplicated, delayed, or refused, and it never changes the alert file or any task state. The Markdown file under `steward-inbox/alerts/` is the record of truth.

Recovery is a separate, manual step. See [Recovery](recovery.md) for file-level recovery (stuck claims, stale heartbeats, corrupted vault) and [At-least-once risk and manual triage](scheduler.md#at-least-once-risk-and-manual-triage) for claimed-task triage. The inspection loop above only inspects; it does not prescribe a requeue, reset, completion, cancellation, or any mutation.

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

Cron behavior depends on job mode:

- `mode: agent` jobs are surfaced only in worker mode and are not auto-run. Check:
  - Job file frontmatter has `enabled: true`.
  - Schedule is due.
  - A current device heartbeat exists under `team/<agent>/devices/`.
  - This device wins active-device priority.
  - The agent claims and records the job with `cron_claim` and `cron_record_run`.
- `mode: script` jobs are executed directly by worker mode. Check:
  - `script:` is set and resolves inside the vault.
  - The script file exists and is executable by the worker user.
  - The run record under `cron/runs/` or `team/<agent>/cron/runs/` contains stdout, stderr, exit code, and timeout status.

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

If `[FAIL] pi-runtime` appears alongside a passing binary, the clean environment does not have `pi` on PATH. Install Pi with `curl -fsSL https://pi.dev/install.sh | sh`, restart the shell, and rerun the check.
