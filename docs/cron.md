# Cron jobs

Piren cron jobs are Markdown files in the vault. They are inspectable, worker-mode only, device-priority aware, and coordinated through atomic filesystem operations.

## Locations

Shared jobs:

```text
cron/jobs/
cron/runs/
```

Agent-scoped jobs:

```text
team/<agent>/cron/jobs/
team/<agent>/cron/runs/
```

Shared jobs include an `agent` frontmatter field. Agent-scoped jobs inherit their agent from the path.

## Job file format

Agent-mode jobs are the default. They are surfaced to the worker agent, which must claim, execute, and record them explicitly:

```markdown
---
id: daily-briefing
agent: piren
schedule: 0 9 * * *
enabled: true
stale_after_seconds: 300
device_policy:
  allowed_devices:
    - pi4
---

# Prompt

Summarize new project activity and update the handoff if needed.
```

Script-mode jobs run a vault-referenced executable directly in worker mode, without sending a prompt to the agent or making an LLM call:

```markdown
---
id: disk-check
agent: piren
schedule: 30m
mode: script
script: scripts/disk-check.sh
enabled: true
stale_after_seconds: 120
---

# Disk check

Human-readable purpose. Optional in script mode.
```

`mode` defaults to `agent`. In `mode: script`, `script` is a vault-relative path. It must resolve inside the vault. Shared scripts conventionally live under `scripts/`; agent-scoped scripts conventionally live under `team/<agent>/scripts/`.

Supported schedules:

- Five-field cron strings, for example `0 9 * * *`.
- Intervals: `30m`, `6h`, `1d`.

Secrets do not belong in cron job files. Put credentials in local config or provider-native config.

## Device ownership

Worker mode lists active device records under `team/<agent>/devices/`, filters stale devices, and chooses the owner by active-device priority. Lower numeric priority wins.

A job can restrict eligible devices with `device_policy.allowed_devices`.

## Tools

List jobs:

```text
cron_list()
```

Claim a due job:

```text
cron_claim(job_path, device_id?, stale_after_ms?)
```

Record a run and restore the job:

```text
cron_record_run(job_path, status, result, started_at, finished_at)
```

List run records:

```text
cron_runs(job_id?)
```

`cron_claim` renames the job atomically to `.claimed.<device>.md`. `cron_record_run` writes a run record and restores the unclaimed job with `last_run` set.

## Worker mode

Cron is surfaced only in worker mode:

```bash
PIREN_WORKER=1 piren run
piren worker
```

Worker mode handles due jobs owned by this device:

- `mode: agent` jobs are surfaced to the worker agent. They are not auto-run. The agent must claim and record runs explicitly, so every run remains inspectable.
- `mode: script` jobs are claimed, executed directly as child processes, and recorded by the worker without an LLM call.

Default interactive sessions do not poll cron or inboxes automatically.

## Run records

Run records are Markdown files under `cron/runs/` or `team/<agent>/cron/runs/`, newest-first in `cron_runs()`. They record job id, status, started and finished timestamps, and result text.

## Failure and stale recovery

If a device claims a job and dies, another worker can recover the stale claim only after the claiming device heartbeat expires. Shared-job stale recovery needs an explicit agent context because device heartbeats are agent-scoped.
