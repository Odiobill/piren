# Recovery

Piren is designed so that operational failures are recoverable from the vault itself. This page covers the common recovery scenarios and the commands that fix them. Most recovery is "edit or rename a Markdown file," because the filesystem is the coordination primitive.

## General principle: the vault is the recovery source

Because every piece of durable state lives in the vault as Markdown, recovery usually means:

1. Look at the vault to see the current state.
2. Edit or rename the offending file.
3. Run `piren doctor` to verify.

Keep the vault in git (or any versioned backup) so you can always revert to a known-good state.

## Stuck inbox task claim

A task is claimed by renaming `team/<agent>/inbox/<task>.md` to `team/<agent>/inbox/<task>.claimed.<device>.md`. If the claiming device crashed mid-execution, the task stays claimed and no other device picks it up.

Recovery options:

- **Let the scheduler handle it.** When the full scheduler loop ships, a stale-claimed task (claiming device heartbeat older than `stale_after_seconds`) becomes reclaimable automatically. Today, the dry-run shows these as reclaim candidates.
- **Manual reclaim.** If you know the claiming device is gone, rename the file back to the unclaimed name or to a `.claimed.<this-device>.md` for this device:

```bash
cd /path/to/vault
mv team/codex/inbox/task-1.claimed.thor.md team/codex/inbox/task-1.claimed.heimdall.md
```

Then claim and execute it normally.

- **Manual reset.** To return a task to pending and let any device pick it up:

```bash
mv team/codex/inbox/task-1.claimed.thor.md team/codex/inbox/task-1.md
```

## Stuck cron job claim

Cron jobs use the same atomic-rename pattern. A stuck claim looks like `cron/jobs/<job>.claimed.<device>.md`.

Recovery:

- **Stale-claim recovery.** `cron_claim` accepts `stale_after_ms`. If the claiming device heartbeat is older than that, the claim succeeds automatically.
- **Manual reclaim.** Rename the file to `.claimed.<this-device>.md` or back to `.md`.

## Stale device heartbeat

A device that is offline keeps its heartbeat file in the vault with an old `last_seen`. Other devices treat it as stale and ignore it after `stale_after_seconds`.

If a device record is permanently stale (device decommissioned), either:

- Delete the heartbeat file: `team/<agent>/devices/<device>.json`.
- Or leave it. Stale records are ignored; they do not cause problems.

To bring a device back: run any Piren command on it, or run `piren worker`. The heartbeat refreshes automatically.

## Failed or corrupted vault

If the vault directory is corrupted (bad sync, accidental edit, disk error):

1. **Restore from backup.** If the vault is in git: `git checkout -- .` or `git reset --hard <known-good-sha>`.
2. **Rebuild agent directories.** If only agent directories are damaged, recreate them from `SOUL.md` files. The required structure is in [vault layout](vault-layout.md).
3. **Run `piren doctor`.** It checks vault layout, OKF conformance, agent files, and Pi runtime. Fix anything it flags.

The vault does not hold secrets (those live in `~/.config/piren/` and `~/.pi/`), so restoring it never exposes credentials.

## Crashed session

Session traces live in `team/<agent>/sessions/`. A crashed session leaves a partial trace file. Recovery:

- The partial trace is evidence. You can read it to see what happened.
- It does not block future sessions. Start a new session normally.
- If you want to clean it up, delete the partial file.

The gateway supports session resume (`switchSession`) for sessions that ended cleanly. A crashed session may not resume cleanly; start fresh.

## Scheduler dry-run shows unexpected claims

If `piren scheduler --dry-run` shows claims you did not expect:

1. **Check the task or job file.** Read the frontmatter to confirm `status` and ownership.
2. **Check device records.** Read `team/<agent>/devices/*.json` to see which devices are active and their priorities.
3. **Check local config.** `allowed_agents` in `~/.config/piren/config.yml` determines which agents the scheduler considers.

The dry-run is read-only. It cannot change vault state. If its output looks wrong, the vault state is the thing to inspect, not the dry-run.

## Provider or credential failure

If an agent cannot reach its provider:

- Check `~/.pi/agent/auth.json` for valid credentials.
- Check `team/<agent>/config.yml` for the configured provider and model.
- Run `pi` directly to verify Pi-native auth works.
- If the provider is down, use agent fallback (ADR-0028): `piren agents --fallback <agent>` to see candidates, then manually reassign the task.

See [troubleshooting](troubleshooting.md) for common error messages.

## Lost local config

If `~/.config/piren/config.yml` is lost or corrupted:

1. Recreate it with `vault_root`, `allowed_agents`, and any transport blocks.
2. Or run `piren setup` to scaffold it interactively.

Local config is machine-specific. It is safe to recreate from memory or from a colleague's config (minus secrets). Provider credentials live in `~/.pi/`, not in Piren config.

## Related

- [Troubleshooting](troubleshooting.md)
- [Scheduler](scheduler.md)
- [Vault layout](vault-layout.md)
- [Cron jobs](cron.md)
- [Agent groups and fallback](agent-groups.md)
