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
- A pending task blocked by `depends_on` or by retry eligibility (below) never gets a claim proposal. `--dry-run` reports it as a `[BLOCK]` line with the exact reason.

For cron jobs:
- The planner uses active-device-priority ownership (ADR-0019) to pick the owning device.
- Only the owning device gets a claim proposal.
- `device_policy.allowed_devices` restricts eligibility when set.

Proposed claims are sorted by device priority (lower number = higher precedence).

## Inbox task lifecycle: claim, execute, release

An executed inbox task passes through visible states, all plain files (ADR-0038):

1. **Claimed** — `<task>.claimed.<device>.md`: the tick claimed the task atomically and the bounded agent is working on it. A claimed task never satisfies another task's `depends_on`, even when its status reads `completed`.
2. **Released** — on validated success only (the bounded runner finished without error AND the claimed file re-reads with `status: completed`; completion is never inferred from the result body), the tick restores the file byte-for-byte to its ordinary name `<task>.md` through a fail-closed no-clobber protocol (temp file, hard link, then unlink the claimed file — never a blind rename). Only then does a completed prerequisite satisfy `depends_on`, letting dependent tasks become claimable on later ticks.
3. **Held** — cancelled, malformed, missing, or non-completed tasks, a release targeting another device's claim, a collision at the ordinary name, and any failure after process start all keep the task claimed for explicit steward/coordinator triage. The tick summary reports `release: held` with the exact reason.

A crash between the link and the unlink can leave both files visible (a duplicate visible task ID). That is intentional fail-closed state: dependency resolution treats duplicate IDs as invalid and blocks the affected tasks until triage.

## Task dependencies (`depends_on`)

A task may declare prerequisites in its frontmatter (ADR-0038):

```yaml
depends_on:
  - 20260721T120000000Z-implement-slice
```

- Entries are stable task IDs, never paths or titles. Each ID must match the generated task-ID shape `^[0-9]{8}T[0-9]{9}Z-[a-z0-9]+(?:-[a-z0-9]+)*$`.
- A dependency is satisfied only when the task with that exact `id` exists as an ordinary (unclaimed) inbox file with `status: completed`. A claimed file never satisfies it, even when its status field reads `completed` — this is why the completion release above exists.
- Resolution is fail-closed. Malformed IDs, duplicate task IDs, duplicate or self dependencies, cycles, and missing targets are all invalid, and invalid or unsatisfied dependencies are never claimable.
- `piren scheduler --dry-run` prints each blocked task as `[BLOCK] inbox_task <path> - <exact reason>` (for example `missing dependency: ...`, `unsatisfied dependency: ...`, `dependency cycle: ...`). The dry-run is read-only: it never claims, spawns, or mutates the vault.

## Opt-in automatic retry

Automatic retry is off by default. A task opts in with an explicit frontmatter policy, and the scheduler records visible attempt state alongside it:

```yaml
retry:
  safe_to_retry: true
  max_attempts: 2
  backoff_seconds: 300
retry_state:                # written by the scheduler, never by hand
  attempts: 1
  last_attempt_at: "2026-07-21T12:05:00.000Z"
  next_eligible_at: "2026-07-21T12:10:00.000Z"
  last_failure: launch_failure
```

- `safe_to_retry` must be `true`; `max_attempts` is a positive integer; `backoff_seconds` is a non-negative integer. An absent policy means no automatic retry. An invalid policy or malformed `retry_state` makes the task unclaimable, and the dry-run reports the exact reason.
- The only automatic retry trigger is a proven pre-handoff `launch_failure`: the scheduler could not construct the run target, or the agent process rejected `start()`. In both cases no prompt was ever handed to the agent, so no agent work can have begun. The prompt handoff is the point of no return — every failure at or after it (timeout, non-zero exit, provider error, disconnect, mid-stream crash) is ambiguous and is never automatically retried, even when `safe_to_retry` is `true`.
- A permitted launch-failure retry records `retry_state`, waits until `next_eligible_at`, then returns the task to its ordinary pending filename through the same fail-closed no-clobber protocol as the release. The tick summary prints `retry: requeued` (or `retry: exhausted` / `retry: held`) with the exact reason.
- Exhausted attempts keep the final state in the claimed file and are never requeued. A launch failure on a task without a valid retry policy stays claimed for triage.

## At-least-once risk and manual triage

Scheduler execution is at-most-once before the prompt handoff and at-least-once after it. Once the prompt has been handed to the agent, a failure the scheduler observes — a timeout, a disconnect, a non-zero exit — does **not** prove that no work happened. The agent may already have written vault files, sent messages, or completed the task entirely. Never rerun or requeue a post-handoff failure until you have inspected its side effects, or you risk duplicating them.

A currently claimed file means one thing only: the task requires manual triage. Task files do not persist an ambiguity classification — an ambiguous failure leaves no marker distinguishing it from a task whose agent is still running or whose scheduler crashed mid-execution. (`retry_state.last_failure: launch_failure` appears only on tasks that went through an automatic launch-failure transition.) The scheduler tick summary (`release: held`, `retry:` lines) and the scheduler's own output are the record of what the tick observed.

Triage workflow for a claimed task `team/<agent>/inbox/<task>.claimed.<device>.md`:

1. **Read the task.** `piren task show <id-or-path>` resolves both ordinary and claimed files; you can also read the claimed file directly.
2. **Check what the scheduler saw.** Review the tick output for `release: held` / `retry:` lines, and run `piren scheduler --dry-run` for a read-only view of current eligibility.
3. **Inspect side effects before deciding.** Check the vault (project logs, outbox, `git status` if the vault is versioned) for work the agent may have completed.
4. **Then choose exactly one outcome:**
   - *Work verified done* — `piren task complete <id-or-path>`, then rename the claimed file back to its ordinary name so completed `depends_on` prerequisites advance dependent tasks.
   - *Abandon the work* — `piren task cancel <id-or-path>`. Cancelled tasks are terminal: they are never claimed, released, or retried automatically.
   - *Verified no side effects and the task should run again* — rename `<task>.claimed.<device>.md` back to `<task>.md`. There is no requeue command; the rename is the manual requeue. If the task carries a valid `retry` policy, its existing `retry_state` still applies.
   - *Duplicate visible IDs* (a crash left both `<task>.md` and `<task>.claimed.<device>.md`) — both are blocked fail-closed. Read both files, reconcile the content, then delete or rename one. See [Recovery](recovery.md).

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
- **Automatic retry beyond typed launch failures.** Opt-in retry policy/state is wired (ADR-0038), but the only automatic trigger is a proven pre-handoff `launch_failure`. Every failure at or after prompt handoff stays claimed for manual triage. See "Opt-in automatic retry" and "At-least-once risk and manual triage".

## Relationship to agent fallback (ADR-0028)

The scheduler handles device failover for the same agent across devices (for example, moving `codex` background work from `thor` to `heimdall` when `thor` is stale). Agent fallback (ADR-0028) handles semantic fallback between different agents (for example, replacing `zai` with `dipu` when `zai`'s provider is down). These features remain distinct.

See [agent groups and fallback](agent-groups.md) for the semantic fallback story.

## Related

- ADR-0029 — device-local scheduler
- ADR-0038 — scheduler dependency and retry safety (incl. revision 2 completion release and revision 3 failure classification)
- [Recovery](recovery.md)
- [Cron jobs](cron.md)
- [Service management](service-management.md)
- [Agent groups and fallback](agent-groups.md)
- [Token discipline](token-discipline.md)
