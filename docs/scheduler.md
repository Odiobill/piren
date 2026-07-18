# Scheduler

The Piren scheduler is a device-local supervisor that watches the shared vault for work belonging to agents enabled on this device, and demand-starts bounded agent executions only when visible vault work is due. It is off by default. Installing or starting it is an explicit steward choice.

The scheduler ships as four layers (ADR-0029 / O7): a read-only dry-run planner, a one-shot `--once` execution tick, an always-on `piren scheduler` loop, and service lifecycle integration (`piren service install scheduler`). All four preserve the same boundaries: local allowed-agent policy first, claim-first execution, at most one executed item per tick, conservative one-at-a-time concurrency, no hidden state, and no automatic cross-agent fallback.

## What shipped

```bash
piren scheduler --dry-run   # LLM-free, claim-free: preview proposed claims for one tick
piren scheduler --once      # one live tick: refresh, plan, claim, execute at most one item, stop
piren scheduler             # opt-in loop: repeats --once every poll interval until SIGINT/SIGTERM
```

The dry-run loads vault state for every agent in local `allowed_agents`, plans proposed claim attempts for one tick, and prints them grouped by agent. It does not claim, does not spawn, and does not invoke any LLM.

`--once` and the loop call the same one-shot primitive: each tick refreshes this device's heartbeats, plans eligible work from `allowed_agents` minus `excluded_agents`, attempts atomic claims in priority order, and executes **at most one** successfully claimed work item (an inbox task, an agent-mode cron job, or a script-mode cron job). A failed claim is skipped without crashing the tick. The loop sleeps between ticks and stops cleanly on `SIGINT`/`SIGTERM` without starting a new tick or leaving a dangling timer.

Example output from the live Piren development vault:

```text
SCHEDULER DRY-RUN (device: Ironman)
  agent: piren
    (no claims)
  agent: dipu
    (no claims)
  agent: zai
    (no claims)
  agent: sam
    [CLAIM] inbox_task   team/sam/inbox/20260704T184506845Z-review-o3-slice-3a-group-config-parser-and-membership-resolution.md (priority 10) - unclaimed pending task for agent sam
    [CLAIM] inbox_task   team/sam/inbox/20260704T205619891Z-review-o3-slice-3d-read-only-fallback-recommendation.md (priority 10) - unclaimed pending task for agent sam
  agent: dario
    (no claims)
  agent: nora
    [CLAIM] inbox_task   team/nora/inbox/20260704T134837062Z-o2-slice-2e-review-accepted-fallback-check-for-sam.md (priority 10) - unclaimed pending task for agent nora
```

Each `[CLAIM]` line shows the item type (`inbox_task` or `cron_job`), the vault-relative path, the device priority, and a short rationale.

## How the planner decides

A scheduler tick is LLM-free. For each locally enabled agent, the planner:

1. Refreshes this device's heartbeat for the agent.
2. Inspects pending inbox tasks.
3. Inspects due cron jobs.
4. Loads active, non-stale device records.
5. Decides whether this device owns each work item.
6. Proposes a claim attempt.

For inbox tasks:
- An unclaimed `pending` task gets a proposed claim.
- A task already claimed by a stale device (heartbeat older than `stale_after_seconds`) gets a reclaim proposal.
- A task claimed by an active device is skipped.

For cron jobs:
- The planner uses active-device-priority ownership (ADR-0019) to pick the owning device.
- Only the owning device gets a claim proposal.
- `device_policy.allowed_devices` restricts eligibility when set.

Proposed claims are sorted by device priority (lower number = higher precedence).

## Local scheduler config

Scheduler runtime config is local installation authority and lives in `~/.config/piren/config.yml` under `scheduler:`. It is never placed in the vault, agent `SOUL.md`, Web UI, gateway state, or `.env` files.

```yaml
vault_root: /mnt/nas/Piren
allowed_agents:
  - zai
  - sam
excluded_agents: []

scheduler:
  poll_interval_seconds: 30    # seconds between loop ticks (default 30)
  stale_after_seconds: 300      # device heartbeat staleness threshold (default 300)
  max_concurrent_agents: 1      # parsed and reported; effective concurrency is 1 (one-at-a-time)
  device_id: thor               # optional explicit override; absent -> sanitized hostname
```

Defaults are conservative: 30s poll interval, 300s stale-after, effective concurrency 1. Invalid/non-positive values fall back to the defaults deterministically and are surfaced as warnings in the loop's startup summary. An explicit `device_id` is passed verbatim (not sanitized); when absent, the loop delegates to the S4 sanitized-hostname fallback so hosts like `Ironman` or `Ironman.local` work out of the box.

The loop reads this config once at startup; each tick re-reads local config for `vault_root` and `allowed_agents`, so agent-set changes take effect without restarting the scheduler.

## Device ownership model

The scheduler composes with existing local authority:

- Local `~/.config/piren/config.yml` defines `vault_root`, `allowed_agents`, and `excluded_agents`.
- The scheduler only considers agents enabled on the local installation.
- Device records live in the vault under each agent: `team/<agent>/devices/<device>.json`.
- The steward may manually edit device priorities, and the next heartbeat refresh preserves them (ADR-0029).

Example device records for one agent:

```text
team/codex/devices/ironman.json
team/codex/devices/thor.json
team/codex/devices/heimdall.json
```

If `thor` has priority `1` and is active, it owns suitable background work. If `thor` stops refreshing its heartbeat and becomes stale, `heimdall` with priority `2` becomes eligible. If `ironman` is off, it is simply stale and ignored.

## Priority preservation on heartbeat refresh

A key fix shipped with the dry-run: refreshing a device heartbeat now preserves a manually-edited priority. Stewards can edit `team/<agent>/devices/<device>.json` to change `priority` from the default `10` to `1`, and the next heartbeat refresh keeps it. An explicit priority passed at registration time still overrides.

## Service lifecycle

The scheduler loop can be installed as a user service exactly like the transports:

```bash
piren service install scheduler
piren service start scheduler
piren service status scheduler
piren service stop scheduler
piren service restart scheduler
piren service remove scheduler
```

The generated systemd user unit is `piren-scheduler.service`; the tmux + `@reboot` cron fallback uses a `piren-scheduler` tmux session with launch script `piren-scheduler.tmux.sh` and cron fragment `piren-scheduler.cron`. The generated command is `<resolved piren command> scheduler` with **no `--vault-root`/`--agent`** binding — the scheduler reads local config on each tick and is not bound to one agent. See [Service management](service-management.md).

## What is explicitly NOT shipped

- **Web UI scheduler status.** The gateway may later display scheduler status read-only, but it does not own scheduler lifecycle and adds no scheduler controls to the Web UI.
- **Broad concurrency.** `max_concurrent_agents` is parsed and reported but effective concurrency is 1 (one-at-a-time); no parallel tick execution is implemented.
- **Automatic cross-agent fallback.** Device failover (same agent, different device) is supported; semantic fallback between different agents is a separate feature (ADR-0028) and is never automatic.
- **Hidden state.** No database, queue, lock file, or lease; the only coordination artifacts are the existing claimed task/job files and run records.

## Relationship to agent fallback (ADR-0028)

The scheduler handles device failover for the same agent across devices (for example, moving `codex` background work from `thor` to `heimdall` when `thor` is stale). Agent fallback (ADR-0028) handles semantic fallback between different agents (for example, replacing `zai` with `dipu` when `zai`'s provider is down). These features remain distinct.

See [agent groups and fallback](agent-groups.md) for the semantic fallback story.

## Related

- ADR-0029 — device-local scheduler
- [Cron jobs](cron.md)
- [Service management](service-management.md)
- [Agent groups and fallback](agent-groups.md)
- [Token discipline](token-discipline.md)
