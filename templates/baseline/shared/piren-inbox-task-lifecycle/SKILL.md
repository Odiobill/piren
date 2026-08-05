---
type: Skill
name: piren-inbox-task-lifecycle
description: "Inbox task lifecycle: claim-before-work, status discipline, and claim/release boundaries for Piren agents."
version: 1.0.0
tags: [piren, inbox, tasks, claims, lifecycle]
---

# Inbox Task Lifecycle

How a Piren agent handles inbox tasks. The mandatory policy rule lives in
`steward-directives.md` under "Inbox task lifecycle"; this skill is the detailed
procedure. A lazy-loaded skill alone is never a technical enforcement boundary. The
directive makes the rule the default visible startup policy; the atomic task claim
remains the concurrency boundary.

## Rules

- **Never auto-poll.** A direct steward session never polls an inbox. Only the
  opt-in scheduler service (or worker mode) polls, and only for the local
  effective runnable-agent set and due cron work.
- **Claim before work.** When the steward explicitly assigns an inbox task,
  identify the exact task file, atomically claim it with `task_claim` BEFORE
  starting work, then mark it `in_progress` with `task_update_status`.
- **Execute only the claimed task.** Do not pick up other tasks in the same
  session.
- **Record the Result.** Write the delivery evidence under `## Result` (the
  `result` parameter of `task_update_status`).
- **Reach a terminal status.** `completed` at delivery under the
  delivery/review procedure; `cancelled` only when explicitly cancelled.
  Accepted work is never left `pending` or `in_progress`.
- **Claim vs status are orthogonal.** A claim is a filename rename
  (`<task>.claimed.<device>.md`) — the concurrency boundary. Status is the
  frontmatter field (`pending | in_progress | completed | cancelled`). Neither
  is ever inferred from the other.
- **Direct work stays claimed.** Directly completed work remains
  `.claimed.<device>.md`. Scheduler R3 completion release is scheduler-only and
  is never used for direct work.
- **Scheduler claims are the scheduler's.** The scheduler claims, executes, and
  R3-releases only its own scheduler-executed successful tasks. An agent never
  re-claims or releases a scheduler claim. Local device priority is placement
  policy, never claim authority.

## Triage

- A stuck claim is recovered manually: triage first, then edit the frontmatter
  status back to `pending` and rename the claimed file to its ordinary name.
  The scheduler plans only unclaimed `pending` tasks.
- Scheduler terminology and the at-least-once triage workflow live in the Piren
  scheduler and recovery documentation (`docs/scheduler.md`, `docs/recovery.md`).
