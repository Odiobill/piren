# Task coordination

Piren coordinates work through ordinary Markdown files. A task is one file in an agent's inbox: you can read it, edit it, and understand it in any text editor or in Obsidian. There is no hidden queue and no database; the files are the record.

This page is the human-facing guide to creating and managing task records with the `piren task` command. For how the scheduler claims and executes tasks automatically, see [Scheduler](scheduler.md).

## Where tasks live

Each task is one Markdown file under `team/<agent>/inbox/`:

```text
team/analyst/inbox/20260826T120000000Z-summarize-q3-logs.md
```

The frontmatter carries the record's fields; the body describes the work:

```yaml
---
type: Task
id: 20260826T120000000Z-summarize-q3-logs
from: steward
to: analyst
status: pending
priority: high
created: 2026-08-26T12:00:00.000Z
updated: 2026-08-26T12:00:00.000Z
---
```

- `status` is one of `pending`, `in_progress`, `completed`, or `cancelled`.
- `from` records who issued the task; tasks you create with the CLI are attributed to `steward`.
- `priority` orders planning when a scheduler considers the task (`normal`, `high`, or `urgent`; default `normal`).
- You can also just write a task file by hand. Keep the frontmatter shape above, and the tooling will treat it like any other task.

## The `piren task` command

```bash
piren task list                              # list one agent's inbox (pass --agent or set PIREN_AGENT)
piren task send <agent> <title> [options]    # create a task for an agent
piren task show <path-or-id>                 # print one task's fields and body
piren task claim <path> [--device <id>]      # claim a task for a device
piren task complete <path-or-id> [--result <vault-file>]
piren task cancel <path-or-id>               # terminal: never claimed or retried again
```

Notes:

- `send` accepts `--body <vault-file>` for the instructions and `--priority normal|high|urgent`. The body file must live inside the vault.
- `show`, `complete`, and `cancel` accept either the vault-relative path or the bare task id. Ids are matched across claimed and unclaimed files; if the same id exists under more than one agent, pass `--agent <agent>` to disambiguate.
- `claim` renames the file atomically to `<task>.claimed.<device>.md`, so two devices can never silently take the same task. Without `--device`, a sanitized hostname is used.
- `complete` sets `status: completed` and, with `--result <vault-file>`, writes the file's content into the task's `## Result` section, replacing any previous result content (the file is also vault-scoped). `cancel` marks the task `cancelled`.

## A typical operator workflow

```bash
# 1. Write the instructions somewhere in the vault.
$EDITOR notes/q3-brief.md

# 2. Create the task.
piren task send analyst "Summarize the Q3 logs" --body notes/q3-brief.md --priority high

# 3. Watch the inbox.
piren task list --agent analyst

# 4. Inspect the record at any time.
piren task show 20260826T120000000Z-summarize-q3-logs

# 5. When the work is done, close it out with an optional result file.
piren task complete 20260826T120000000Z-summarize-q3-logs --result notes/q3-summary.md
```

An agent can run the same lifecycle through its visible vault tools (`inbox_list()`, `task_claim()`, `task_update_status()`), so both sides of the exchange stay inspectable in the same files.

## Claimed files and completion semantics

A claimed task keeps its `.claimed.<device>.md` name until something explicitly releases it:

- If a scheduler claimed and finished the task, it restores the ordinary filename itself as part of its bounded completion release.
- If you claimed a task by hand and completed it, rename the claimed file back to `<task>.md` yourself when you are done. Renaming matters if other tasks declare this task as a dependency: completed prerequisites advance dependents only once the claimed marker is gone.
- If a claiming device disappeared mid-work, see [Recovery](recovery.md#stuck-inbox-task-claim) for the manual reset procedure.

## Boundaries

- Tasks are explicit records. Nothing dispatches itself: a human creates or manages them through the CLI, direct file edits, or an agent acting through its visible tools. Interactive agent sessions do not poll inboxes.
- The Workbench's Dashboard includes a delivered **Assign task** action that creates exactly one task record for one selected agent. That is all it does: the Workbench has no task list and no task-management controls.
- There is no automatic reassignment between agents and no automatic resume of interrupted work. When the scheduler executes tasks, retrying only happens when a task declares an explicit opt-in retry policy, and only for a narrow launch-failure case; see [Scheduler](scheduler.md) for dependencies, retries, release, and triage.

## Related

- [Scheduler](scheduler.md): automated claiming, execution gates, dependency ordering, opt-in retry, and manual triage.
- [Recovery](recovery.md#stuck-inbox-task-claim): releasing a claim whose device went away.
- [Troubleshooting](troubleshooting.md): the read-only inspection loop for stuck or ambiguous work.
