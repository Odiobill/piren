# Scheduler

The Piren scheduler is a device-local supervisor that watches the shared vault for work belonging to agents enabled on this device, and demand-starts bounded agent executions only when visible vault work is due. Every execution gate defaults to off on a fresh install, so a freshly installed scheduler executes nothing until you explicitly enable an automation class. Installing or starting it is an explicit steward choice.

The scheduler provides four explicit ways to operate: a read-only dry-run planner, a one-shot `--once` execution tick, an always-on `piren scheduler` loop, and service lifecycle integration (`piren service install scheduler`). All four preserve the same boundaries: local allowed-agent policy first, claim-first execution, at most one executed item per tick, conservative one-at-a-time concurrency, no hidden state, and no automatic cross-agent fallback.

## What shipped

```bash
piren scheduler --dry-run   # LLM-free, claim-free: preview proposed claims for one tick
piren scheduler --report    # read-only operator report: effective policy, cycles, retry metadata, claimed-task triage items
piren scheduler --once      # one live tick: refresh, plan, claim, execute at most one item, stop
piren scheduler --once --force  # non-persistent override of only a disabled inbox automation class
piren scheduler             # opt-in loop: repeats --once every poll interval until SIGINT/SIGTERM
piren scheduler configure   # guided interactive local-config writer (preview + confirmation, atomic)
```

The three closed automation classes (`automation.inbox_tasks`, `automation.agent_cron`, `automation.script_cron`) are the **sole ordinary execution gates**; no other key authorizes or blocks execution. Each class defaults to **off**, and a disabled class is never proposed, claimed, or executed.

Supervision is distinct from execution: installing or starting the service, or running the loop, is supervision only. A running scheduler with every class disabled is an inert supervisor (no heartbeat refresh, planning, claim, spawn, or sleep; it still exits cleanly on SIGINT/SIGTERM). Class resolution is fail-closed: an absent class key resolves off, and a present-but-malformed value disables that class with a deterministic non-secret warning.

A retired `scheduler.enabled` key is never a gate:

- `enabled: true` is **inert-to-ignore**: it never adds execution. Surfaces that show scheduler state print `legacy: retired scheduler.enabled key present with value true; inert-to-ignore (read-only notice, not persisted)`.
- `enabled: false` or a malformed value is the ambiguous legacy shape: such installations were previously fully inert, so they must never silently begin executing. Every class resolves **disabled** (fail closed) until an operator-confirmed `piren scheduler configure` migration removes the stale key. The affected surfaces show `legacy gate: retired scheduler.enabled key present with a disabled/malformed value; all automation classes resolve disabled (fail closed); operator-confirmed migration required`. Settings and doctor never migrate this state; they surface it read-only, and configure is the only migration writer.

`piren scheduler --once --force` is the only override: it turns on **only a disabled inbox automation class** for that one tick, non-persistently (`force: inbox automation override (this tick only; not persisted)`). It never enables either cron class, never bypasses the legacy gate, never bypasses a class's agent scope (below), never writes config, and never starts a service.

## Class agent scope (`agent_scope`)

Each automation class can independently narrow **which locally enabled agents** its items may be claimed for. This is installation-local policy in `~/.config/piren/config.yml` under `scheduler.agent_scope`; it never belongs in the vault, agent config, task frontmatter, browser storage, or an environment override.

```yaml
scheduler:
  automation:
    inbox_tasks: true
    agent_cron: false
    script_cron: false
  agent_scope:
    inbox_tasks:
      allow: [agent-a]    # optional; a present empty list deliberately allows none
      exclude: [agent-b]  # optional; exclusion wins over allow
    agent_cron: {}        # empty mapping = no narrowing
    script_cron: {}
```

Semantics:

- A scope omitted for a class (absent key, `null`, or an empty `{}` mapping) leaves **all** locally enabled agents eligible for that class.
- `allow` narrows only that class to the intersection with locally enabled agents; `exclude` removes names from that class's candidates; when both are set, **exclusion wins**.
- The scope applies **after** the global runnable policy (`allowed_agents` minus `excluded_agents`). It never makes a globally non-runnable agent runnable.
- Configured names that are not locally enabled agents produce a bounded count-only warning and are ignored: they never widen eligibility.
- A malformed present `agent_scope`, class scope, or allow/exclude list fails **closed** for the affected class (no candidates for that class) with a deterministic non-secret warning. Unknown class keys and unknown keys inside a class scope are warned-and-ignored.
- An excluded agent's work is never proposed, claimed, spawned, retried, or completion-released through any scheduler path. In `--dry-run`, an enabled inbox class whose pending task belongs to an excluded agent is printed as `[BLOCK] inbox_task <path> - class agent excluded (no claim proposed)`, never as a `[CLAIM]`.
- The dry-run, one-shot summary, loop startup summary, and `--report` render the effective policy as a bounded count-only line (`agent scope: inbox_tasks=1 agent(s) agent_cron=all script_cron=all`) plus any non-secret config warnings. This output never exposes configured allow/exclude names.

A typical use: keep `inbox_tasks` automation enabled while excluding agents reserved for interactive Workbench Conversations (for example `exclude: [agent-a, agent-b]`), so the scheduler never claims their inbox tasks while those agents remain fully available for explicit work.

The dry-run loads vault state for every agent in local `allowed_agents`, plans proposed claim attempts for one tick, and prints them grouped by agent. It does not claim, does not spawn, and does not invoke any LLM.

`--once` and the loop call the same one-shot primitive: each tick refreshes this device's heartbeats, plans eligible work from `allowed_agents` minus `excluded_agents`, attempts atomic claims in priority order, and executes **at most one** successfully claimed work item (an inbox task, an agent-mode cron job, or a script-mode cron job). A failed claim is skipped without crashing the tick. The loop sleeps between ticks and stops cleanly on `SIGINT`/`SIGTERM` without starting a new tick or leaving a dangling timer.

Example output:

```text
SCHEDULER DRY-RUN (device: workstation)
  agent: analyst
    (no claims)
  agent: builder
    [CLAIM] inbox_task   team/builder/inbox/20260801T120000000Z-review-documentation.md (priority 10) - unclaimed pending task for agent builder
```

Each `[CLAIM]` line shows the item type (`inbox_task` or `cron_job`), the vault-relative path, the device priority, and a short rationale.

The dry-run is read-only and discovery-complete. It always prints the resolved automation line (`automation: inbox_tasks=on agent_cron=off script_cron=off`). When inbox automation is off, every unclaimed pending inbox task is still listed under its agent with a bounded disabled status and **no claim is proposed**:

```text
SCHEDULER DRY-RUN (device: workstation)
  automation: inbox_tasks=off agent_cron=off script_cron=off
  agent: analyst
    [DISABLED] inbox_task team/analyst/inbox/20260801T120000000Z-review-documentation.md - inbox automation disabled (no claim proposed)
  [SKIPPED] agent_cron - automation disabled
  [SKIPPED] script_cron - automation disabled
```

When applicable, a bounded legacy notice describes the retired-key state; notices are read-only and never persisted.

## How the planner decides

A scheduler tick is LLM-free. For each locally enabled agent, the planner:

1. Refreshes this device's heartbeat for the agent.
2. Inspects pending inbox tasks.
3. Inspects due cron jobs.
4. Loads active, non-stale device records.
5. Decides whether this device owns each work item.
6. Proposes a claim attempt.

For inbox tasks:
- An unclaimed `pending` task gets a proposed claim, unless the class agent scope excludes its agent (`agent_scope`, above).
- A claimed task is never a claim candidate: the scheduler loads only unclaimed `pending` tasks, so a task claimed by any device — stale or not — stays claimed for manual triage (see [Recovery](recovery.md)).
- A pending task blocked by `depends_on`, retry eligibility, or the class agent scope (below) never gets a claim proposal. `--dry-run` reports it as a `[BLOCK]` line with the exact reason.

For cron jobs:
- The planner uses active-device-priority ownership to pick the owning device.
- Only the owning device gets a claim proposal.
- `device_policy.allowed_devices` restricts eligibility when set.

Proposed claims are sorted by device priority (lower number = higher precedence).

## Inbox task lifecycle: claim, execute, release

An executed inbox task passes through visible states, all plain files:

1. **Claimed** — `<task>.claimed.<device>.md`: the tick claimed the task atomically and the bounded agent is working on it. A claimed task never satisfies another task's `depends_on`, even when its status reads `completed`.
2. **Released** — on validated success only (the bounded runner finished without error AND the claimed file re-reads with `status: completed`; completion is never inferred from the result body), the tick restores the file byte-for-byte to its ordinary name `<task>.md` through a fail-closed no-clobber protocol (temp file, hard link, then unlink the claimed file — never a blind rename). Only then does a completed prerequisite satisfy `depends_on`, letting dependent tasks become claimable on later ticks.
3. **Held** — cancelled, malformed, missing, or non-completed tasks, a release targeting another device's claim, a collision at the ordinary name, and any failure after process start all keep the task claimed for explicit steward/coordinator triage. The tick summary reports `release: held` with the exact reason.

A crash between the link and the unlink can leave both files visible (a duplicate visible task ID). That is intentional fail-closed state: dependency resolution treats duplicate IDs as invalid and blocks the affected tasks until triage.

## Task dependencies (`depends_on`)

A task may declare prerequisites in its frontmatter:

```yaml
depends_on:
  - 20260721T120000000Z-implement-feature
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

Before the prompt handoff no agent work can have begun, which is exactly why a pre-handoff `launch_failure` may be requeued safely under an opt-in policy. After the handoff, execution is at-least-once: a failure the scheduler observes — a timeout, a disconnect, a non-zero exit — does **not** prove that no work happened. The agent may already have written vault files, sent messages, or completed the task entirely. Never rerun or requeue a post-handoff failure until you have inspected its side effects, or you risk duplicating them.

A currently claimed file means one thing only: the task requires manual triage. Task files do not persist an ambiguity classification — an ambiguous failure leaves no marker distinguishing it from a task whose agent is still running or whose scheduler crashed mid-execution. (`retry_state.last_failure: launch_failure` appears only on tasks that went through an automatic launch-failure transition.) The scheduler tick summary (`release: held`, `retry:` lines) and the scheduler's own output are the record of what the tick observed.

Triage workflow for a claimed task `team/<agent>/inbox/<task>.claimed.<device>.md`:

1. **Read the task.** `piren task show <id-or-path>` resolves both ordinary and claimed files; you can also read the claimed file directly.
2. **Check what the scheduler saw.** Review the tick output for `release: held` / `retry:` lines, and run `piren scheduler --dry-run` for a read-only view of current eligibility.
3. **Inspect side effects before deciding.** Check the vault (project logs, outbox, `git status` if the vault is versioned) for work the agent may have completed.
4. **Then choose exactly one outcome:**
   - *Work verified done* — `piren task complete <id-or-path>`, then rename the claimed file back to its ordinary name so completed `depends_on` prerequisites advance dependent tasks.
   - *Abandon the work* — `piren task cancel <id-or-path>`. Cancelled tasks are terminal: they are never claimed, released, or retried automatically.
   - *Verified no side effects and the task should run again* — make sure the frontmatter reads `status: pending` (a bounded agent may have left it at `in_progress`; edit the file if needed), then rename `<task>.claimed.<device>.md` back to `<task>.md`. There is no requeue command; the status edit plus the rename is the manual requeue, and the scheduler plans only unclaimed `pending` tasks. If the task carries a valid `retry` policy, its existing `retry_state` still applies.
   - *Duplicate visible IDs* (a crash left both `<task>.md` and `<task>.claimed.<device>.md`) — both are blocked fail-closed. Read both files, reconcile the content, then delete or rename one. See [Recovery](recovery.md).

## Operator report (`--report`)

`piren scheduler --report` prints a read-only diagnostic for the locally enabled agent set (`allowed_agents` minus `excluded_agents`, same scope as `--dry-run`). It reads only the vault and local config: it never claims, spawns, refreshes heartbeats, writes files, or calls an LLM, and it persists nothing. Before findings, it renders the existing resolved effective policy: automation state, any legacy-gate notice, a count-only `agent scope:` line for each class (`all` or a count, including zero), and existing non-secret resolver warnings. It never prints configured allow/exclude names or raw local config.

It surfaces exactly four actionable conditions, grouped per agent in deterministic order. Each finding renders three aligned parts: the condition/evidence (reason), a non-action `authority:` boundary stating what Piren cannot infer or will not change, and exactly one inspection `next:` action (`piren task show <path>`). The authority text is never an instruction and never prescribes a mutation; the triage/dependency/retry references stay in this document, not in the displayed next line.

- `[CYCLE]` — dependency cycles involving pending tasks, with the exact evaluator reason.
- `[RETRY]` — invalid `retry` policy or malformed `retry_state` (exact parser reasons), and exhausted retry attempts (`retry attempts exhausted (n/m)`). Unexpired backoff and other blocked-work reasons stay `--dry-run` diagnostics.
- `[TRIAGE]` — claimed inbox task files. Each is a manual-triage item: it may be active, interrupted, or an ambiguous failure, and the report cannot identify which, because task files do not persist an ambiguity classification. See [At-least-once risk and manual triage](#at-least-once-risk-and-manual-triage) for the triage procedure.

Example output:

```text
SCHEDULER REPORT

  agent: analyst
    [TRIAGE] team/analyst/inbox/20260725T120000000Z-stuck.claimed.device-b.md - claimed by device-b; requires manual triage: may be active, interrupted, or ambiguous — vault state alone cannot tell
             authority: Piren cannot tell from vault state whether the claim is active, interrupted, or an ambiguous failure (no ambiguity classification is persisted).
             next: piren task show team/analyst/inbox/20260725T120000000Z-stuck.claimed.device-b.md
  agent: builder
    (no findings)

1 findings (0 cycle, 0 retry, 1 manual-triage)

This report is read-only: it does not claim, spawn, write, or call any LLM.
A claimed task requires manual triage: it may be active, interrupted, or ambiguous; vault state alone cannot tell (no ambiguity classification is persisted).
```

The `authority:` line for each category is fixed and non-action: triage states the vault-state uncertainty; invalid retry metadata states Piren will not infer it (the task stays unclaimable); exhausted attempts state Piren will not automatically requeue them; and cycles state Piren leaves affected tasks fail-closed rather than infer a dependency repair. The `next:` line is always the single read command `piren task show <path>`; follow the relevant section below for the governing procedure. An empty report (no findings) prints no `authority:`/`next:` lines and the same footer.

## Guided configuration (`piren scheduler configure`)

If the Workbench is running, the easiest path is the Scheduler tab of the Settings module: the same closed inventory of fields over the same atomic, fail-closed write discipline, and saving never installs, starts, stops, or ticks anything (a retired-key legacy gate state renders read-only there and refuses saves until migrated). From the command line, `piren scheduler configure` is an interactive, guided writer for the `scheduler:` block (the same pattern as `piren telegram configure`) and the **only** writer that can clear a gated retired key:

1. It displays the **current effective state** resolved from your existing config (all classes off on fresh installs; a retired-key legacy block shows its bounded inert/gated notice).
2. It prompts for exactly the closed inventory: the three automation classes, poll/stale/concurrency values, and an optional device id (blank keeps the sanitized-hostname fallback); the retired `scheduler.enabled` key is never prompted for.
3. It shows a bounded **preview** of the exact scheduler block, then requires an explicit **confirmation**.
4. Only then does it write **atomically** (temp file plus rename), preserving every unrelated block (`telegram:`, `discord:`, `allowed_agents`, and so on) and any unknown scheduler fields. Confirming over a gated legacy block removes the stale `scheduler.enabled` key and writes your explicit class choices; the migration never turns a disabled class on by itself.

Cancellation, a malformed existing config, invalid input, or a write failure leaves the old config **byte-for-byte intact**. The flow never starts or installs a service, never runs or ticks the scheduler, never contacts a platform, and never writes the vault. Installing/starting the service remains a separate explicit action (`piren service install scheduler`).

## Local scheduler config

Scheduler runtime config is local installation authority and lives in `~/.config/piren/config.yml` under `scheduler:`. It is never placed in the vault, agent `SOUL.md`, Web UI, gateway state, or `.env` files. This section is the raw file reference; prefer the guided paths above for everyday changes.

```yaml
vault_root: /path/to/vault
allowed_agents:
  - analyst
  - builder
excluded_agents: []

scheduler:
  automation:
    inbox_tasks: true         # sole inbox gate (default false)
    agent_cron: true          # sole agent-cron gate (default false)
    script_cron: true         # execute due script-mode cron jobs directly (default false)
  agent_scope:                # optional per-class agent narrowing (all eligible when omitted)
    inbox_tasks:
      allow: [agent-a]        # optional; present empty list allows none
      exclude: [agent-b]      # optional; exclusion wins over allow
    agent_cron: {}
    script_cron: {}
  poll_interval_seconds: 30    # seconds between loop ticks (default 30)
  stale_after_seconds: 300      # device heartbeat staleness threshold (default 300)
  max_concurrent_agents: 1      # parsed and reported; effective concurrency is 1 (one-at-a-time)
  device_id: workstation        # optional explicit override; absent -> sanitized hostname
```

Defaults are fail-closed: absent `automation` keys resolve **off**, and present-but-malformed values fail closed with deterministic non-secret warnings. A retired `scheduler.enabled` key has no meaning as a gate: `true` is inert-to-ignore, and `false` or a malformed value gates every class off (fail closed) until the operator-confirmed `piren scheduler configure` migration removes the stale key. Settings and doctor surface that state read-only; neither migrates it. Interval values default to 30s poll, 300s stale-after, effective concurrency 1; invalid/non-positive values fall back deterministically with warnings in the loop's startup summary. An explicit `device_id` is passed verbatim (not sanitized); when absent, the loop uses a sanitized-hostname fallback so hosts like `workstation` or `workstation.local` work out of the box.

The loop reads this config once at startup; each tick re-reads local config for `vault_root` and `allowed_agents`, so agent-set changes take effect without restarting the scheduler.

## Device ownership model

The scheduler composes with existing local authority:

- Local `~/.config/piren/config.yml` defines `vault_root`, `allowed_agents`, and `excluded_agents`.
- The scheduler only considers agents enabled on the local installation.
- Device records live in the vault under each agent: `team/<agent>/devices/<device>.json`.
- The steward may manually edit device priorities, and the next heartbeat refresh preserves them.

Example device records for one agent:

```text
team/analyst/devices/device-a.json
team/analyst/devices/device-b.json
team/analyst/devices/device-c.json
```

If `device-b` has priority `1` and is active, it owns suitable background work. If `device-b` stops refreshing its heartbeat and becomes stale, `device-c` with priority `2` becomes eligible. If `device-a` is off, it is simply stale and ignored.

## Priority preservation on heartbeat refresh

Heartbeat refresh preserves a manually-edited priority. Stewards can edit `team/<agent>/devices/<device>.json` to change `priority` from the default `10` to `1`, and the next heartbeat refresh keeps it. An explicit priority passed at registration time still overrides.

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

- **Web UI scheduler lifecycle.** The Workbench Settings page includes a typed scheduler *configuration* workflow (the same gates, classes, and intervals as `piren scheduler configure`, written atomically and never starting anything), and the Dashboard service card reports read-only observed service status; nothing in the Workbench owns scheduler lifecycle, ticks, claims, or spawns, and there are no scheduler runtime controls.
- **Broad concurrency.** `max_concurrent_agents` is parsed and reported but effective concurrency is 1 (one-at-a-time); no parallel tick execution is implemented.
- **Automatic cross-agent fallback.** Device failover (same agent, different device) is supported; semantic fallback between different agents is separate and is never automatic.
- **Hidden state.** No database, queue, lock file, or lease; the only coordination artifacts are the existing claimed task/job files and run records.
- **Automatic retry beyond typed launch failures.** Opt-in retry policy/state is available, but the only automatic trigger is a proven pre-handoff `launch_failure`. Every failure at or after prompt handoff stays claimed for manual triage. See "Opt-in automatic retry" and "At-least-once risk and manual triage".

## Relationship to agent fallback

The scheduler handles device failover for the same agent across devices (for example, moving background work from `device-b` to `device-c` when `device-b` is stale). Agent fallback handles semantic fallback between different agents (for example, selecting an eligible teammate when a provider is down). These features remain distinct.

See [agent groups and fallback](agent-groups.md) for the semantic fallback story.

## Related

- [Recovery](recovery.md)
- [Cron jobs](cron.md)
- [Service management](service-management.md)
- [Agent groups and fallback](agent-groups.md)
- [Token discipline](token-discipline.md)
