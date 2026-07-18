# Piren discipline

Piren's value comes as much from what it refuses to do as from what it enables. This page is the operator-facing summary of the seven discipline principles that shape every feature. The formal decision records (ADRs) live in the Piren project vault, not in this repository; each principle cites its ADR by number below.

## 1. The vault is the single source of truth

Every piece of durable state lives in an inspectable Markdown vault: agent identity (`SOUL.md`), memory (`MEMORY.md`), config, inbox, outbox, logs, sessions, skills, cron jobs, and project knowledge. There is no parallel database, no hidden state file, no opaque vector store.

If it is not in the vault, it is not authoritative. The steward can open the vault in Obsidian or any text editor and see exactly what every agent knows, what it is working on, and what it has decided.

Machine-local authority (which agents this installation may run, provider credentials) lives outside the vault under `~/.config/piren/`. This split is deliberate: the vault carries the team, the installation decides which office it runs in today.

See: ADR-0002, ADR-0010.

## 2. Explicit tools, not transparent interception

Piren exposes vault-native tools (`vault_read`, `vault_write`, `send_to_agent`, `flag_steward`, `project_append_log`, and so on). Every mutation is a visible tool call. There is no transparent shell interception, no silent file rewriting after model responses, no hidden memory mutation.

This makes agent behavior debuggable. When something changes in the vault, you can trace it to a specific tool call in a specific session. You never have to wonder "did the agent edit that file on its own?"

See: ADR-0003.

## 3. One file per task

Inbox tasks are one Markdown file each, dropped into `team/<agent>/inbox/`. Each task carries frontmatter (id, status, from, to, created, updated) and a body describing the work. Tasks are claimed atomically by rename, so two devices never silently pick up the same task.

This is the coordination primitive for the whole team. Nora, the release coordinator, assigns work by writing one task file. Developers claim it by renaming it. Reviewers see the result in the vault. The steward sees the full trail in Obsidian.

See: ADR-0004, ADR-0031.

## 4. Opt-in, visible automation

Automation is never on by default. Cron jobs, self-improvement triggers, the scheduler, and worker polling all start disabled. When you enable them, their state lives in the vault where anyone can inspect it.

There is no default automatic inbox polling in interactive `piren run`. Polling belongs only to opt-in worker mode (`piren worker` or `PIREN_WORKER=1`), and only for agents explicitly allowed by local installation policy.

See: ADR-0019, ADR-0024, [scheduler](scheduler.md).

## 5. Inspectable self-improvement

When an agent learns something durable, it writes a visible vault artifact: a project log entry, a wiki concept page, a runbook, an ADR, or a skill candidate. Nothing is promoted silently.

The artifact promotion ladder keeps knowledge layers honest:

```
raw event / task / session
  -> task file or session summary
  -> project log entry
  -> project status / handoff update
  -> concept, entity, runbook, or ADR
  -> reusable skill candidate
```

Raw traces are evidence. Project docs and ADRs are synthesized truth. Skills are procedural memory. Agents promote knowledge deliberately, never through hidden automatic memory mutation.

See: ADR-0015, ADR-0018, [knowledge lifecycle](knowledge-lifecycle.md).

## 6. The steward model

The human is the **steward** of the agent team. Not a CEO, not a master. The steward owns the shared space, sets direction, grants trust, reviews important changes, and can inspect or edit agent state directly at any time.

Piren emphasizes controlled autonomy: agents can act, but their state and work queues remain visible and editable by the steward. The vault is the steward's workspace as much as the agents'.

Authority follows a clear hierarchy when agents read the vault:

1. Steward direct instruction (highest).
2. Local installation policy.
3. Current project ADRs and implementation plan.
4. Agent `SOUL.md`.
5. Inbox task files (task scope, not global policy).
6. Wiki pages and project references.
7. Session summaries, logs, and historical traces (lowest).

This ordering prevents stale historical artifacts from overriding current steward intent or current architectural decisions.

See: ADR-0007.

## 7. Boring, local-first engineering

Piren v1 is deliberately boring: explicit vault tools, append-only logs where practical, one file per task, atomic rename-based claiming, no central database, no distributed consensus beyond best-effort claim-first. Everything runs locally. The vault is yours. Credentials stay outside it.

The runtime requirement is a local `pi` binary on `PATH`. There is no `npx` runtime fallback. This keeps the foundation honest and the failure modes debuggable.

See: ADR-0001, ADR-0006, ADR-0009.

## What this discipline buys you

- **Trustworthiness:** every action is traceable, every state is editable, every decision is recorded.
- **Fault tolerance:** the work lives in the shared substrate, not in a process on a single machine. If a device dies, the next eligible device picks up.
- **Low idle cost:** the scheduler tick is LLM-free, script-mode cron runs without an LLM, and nothing polls by default. Idle LLM cost is zero.
- **Debuggability:** there is no hidden state to reverse-engineer. The vault is the system.

## Related

- [Vault layout](vault-layout.md)
- [Token discipline](token-discipline.md)
- [Troubleshooting](troubleshooting.md)
