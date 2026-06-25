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

Worker mode surfaces due jobs owned by this device. It does not auto-run them. The agent must claim and record runs explicitly, so every run remains inspectable.

Default interactive sessions do not poll cron or inboxes automatically.

## Run records

Run records are Markdown files under `cron/runs/` or `team/<agent>/cron/runs/`, newest-first in `cron_runs()`. They record job id, status, started and finished timestamps, and result text.

## Failure and stale recovery

If a device claims a job and dies, another worker can recover the stale claim only after the claiming device heartbeat expires. Shared-job stale recovery needs an explicit agent context because device heartbeats are agent-scoped.
