# Vault layout

The vault is Piren's inspectable source of truth. It is Markdown-first and Obsidian-friendly.

## Initialized shape

```text
vault/
├── .piren-vault
├── steward-directives.md
├── Projects/
├── steward-inbox/
│   └── alerts/
├── wiki/
│   ├── concepts/
│   ├── entities/
│   ├── runbooks/
│   └── inbox/
├── skills/
├── templates/
├── cron/
│   ├── jobs/
│   └── runs/
└── team/
    └── piren/
        ├── SOUL.md
        ├── MEMORY.md
        ├── config.yml
        ├── inbox/
        ├── outbox/
        ├── devices/
        ├── logs/
        ├── sessions/
        ├── skills/
        └── cron/
            ├── jobs/
            └── runs/
```

## Agent directory

`team/<agent>/` defines a vault agent.

Required identity files:

- `SOUL.md`: identity and role.
- `MEMORY.md`: visible long-lived notes.

Operational directories:

- `inbox/`: one Markdown task file per task.
- `outbox/`: agent-authored outbound notes or future delivery staging.
- `devices/`: local device heartbeat JSON files.
- `logs/`: append-only operational logs.
- `sessions/`: summaries written by `session_write_summary`.
- `skills/`: agent-specific Markdown skills.
- `cron/jobs/` and `cron/runs/`: agent-scoped scheduled work and run history.

Do not put `.env` or `AGENTS.md` under `team/<agent>/`. Secrets live outside the vault, and Piren identity is `SOUL.md`.

## Shared directories

- `Projects/`: project-specific working knowledge, decisions, logs, handoffs, runbooks, and imported source material. Project files should use OKF frontmatter such as `type: Project Index`, `type: Project Log`, `type: ADR`, or `type: Runbook` when durable.
- `skills/`: shared vault skills available to all agents.
- `cron/jobs/`: shared scheduled jobs.
- `cron/runs/`: shared scheduled run records.
- `steward-inbox/alerts/`: alert files created by `flag_steward`.
- `wiki/concepts/` and `wiki/entities/`: curated reference knowledge.
- `wiki/runbooks/`: reusable operational procedures.

For imports from an older vault or project folder, do not only copy the source tree. Preserve project-specific material under `Projects/<Project>/`, then promote reusable concepts into `wiki/concepts/` and named people, products, services, or systems into `wiki/entities/`. The Knowledge Graph indexes OKF-typed Markdown from the vault root and is most useful when project docs link to those curated wiki nodes.

## Task files

Inbox tasks are Markdown files with frontmatter and body. Agents claim tasks by atomic rename to a `.claimed.<device>.md` path. Status updates mutate explicit frontmatter fields and optional result sections.

Default interactive sessions do not poll inboxes. Worker mode is opt-in and only allowed for locally runnable agents.

## Device records

When the Piren extension starts, it writes a heartbeat JSON file under `team/<agent>/devices/<device>.json`. Device records include device id, hostname, priority, status, started time, and last seen time.

Cron and inbox stale recovery use these heartbeat files.

## Path safety

Piren path-scoped tools resolve all vault paths against the configured vault root and reject traversal outside the vault. Name-scoped tools also validate name components before constructing paths.
