# Scheduler

The Piren scheduler is a device-local supervisor that watches the shared vault for work belonging to agents enabled on this device, and demand-starts bounded agent executions only when visible vault work is due. It is off by default. Installing or starting it is an explicit steward choice.

The first shipped slice (ADR-0029) covers the dry-run: a read-only planner that prints what the scheduler would claim or run, without executing anything. The full loop, bounded execution, and service lifecycle integration are deferred to a later release.

## What shipped: `piren scheduler --dry-run`

```bash
piren scheduler --dry-run
```

The dry-run loads vault state for every agent in local `allowed_agents`, plans proposed claim attempts for one tick, and prints them grouped by agent. It does not claim, does not spawn, and does not invoke any LLM.

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

## What is explicitly NOT shipped yet

The dry-run is read-only and diagnostic. The following are deferred to a later release:

- **The scheduler loop** (`piren scheduler` without `--dry-run`). The always-on background process that performs the claims and starts bounded executions is not yet implemented.
- **Bounded execution.** Claim-scoped agent runs that execute one task or one cron job and then stop.
- **Service lifecycle integration.** `piren service install scheduler` is not yet wired.
- **Web UI scheduler status.** The gateway may later display scheduler status, but it does not own scheduler lifecycle.

## Relationship to agent fallback (ADR-0028)

The scheduler handles device failover for the same agent across devices (for example, moving `codex` background work from `thor` to `heimdall` when `thor` is stale). Agent fallback (ADR-0028) handles semantic fallback between different agents (for example, replacing `zai` with `dipu` when `zai`'s provider is down). These features remain distinct.

See [agent groups and fallback](agent-groups.md) for the semantic fallback story.

## Related

- [ADR-0029: Device-local scheduler](../decisions/ADR-0029-device-local-scheduler.md)
- [Cron jobs](cron.md)
- [Service management](service-management.md)
- [Agent groups and fallback](agent-groups.md)
- [Token discipline](token-discipline.md)
