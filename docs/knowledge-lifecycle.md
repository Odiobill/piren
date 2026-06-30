# Knowledge lifecycle

Piren's vault is a team knowledge substrate, not only shared storage.

Agents should leave visible artifacts that help future work. The steward should be able to inspect the vault in Obsidian and understand current status, decisions, runbooks, logs, handoffs, skills, and task history.

## Artifact promotion ladder

```text
raw event / task / session
  -> task file or session summary
  -> project log entry
  -> project status / implementation plan / handoff update
  -> concept, entity, runbook, or ADR
  -> reusable skill candidate
```

Do not promote everything. Update the smallest durable artifact that prevents future rediscovery.

## Implemented tools

Read project status:

```text
project_status(project)
```

Append a project log entry:

```text
project_append_log(project, entry)
```

Write an ADR:

```text
decision_record(project, id, title, context, decision, consequences?, alternatives?)
```

Update a handoff prompt:

```text
project_update_handoff(project, content)
```

Write a runbook:

```text
runbook_write(project, title, content)
```

Draft a reviewable skill candidate:

```text
skill_candidate_write(name, description, body, scope?)
```

Promote curated wiki knowledge as OKF documents:

```text
wiki_update_concept(title, content, description?, tags?, links?)
wiki_update_entity(title, content, description?, tags?, links?)
```

These write `type: Concept` documents under `wiki/concepts/` and `type: Entity` documents under `wiki/entities/`. Use bundle-relative links such as `/Projects/Piren/knowledge-lifecycle.md` for agent-authored relationships.

Detect correction moments without writing hidden memory:

```text
self_improvement_trigger_check(message)
```

This read-only ADR-0024 tool ports Hermes-style correction heuristics and suggests the minimum visible vault artifact to use next. It only advises. It does not mutate hidden memory, create SQLite state, or run silent background writes.

Opt-in auto-nudge wiring is also available. Set `self_improvement.auto_nudge: true` in `team/<agent>/config.yml`, or set `PIREN_AUTO_NUDGE=1` in the environment, and Piren installs a `message_end` listener that emits an advisory `ctx.ui.notify` whenever a user message looks like a correction. The notification names the same visible vault tools (`project_append_log`, `skill_candidate_write`, `decision_record`, `wiki_update_concept`, `wiki_update_entity`); it never writes on its own. Default is OFF.

## Inspectability rule

Piren v1 avoids hidden memory mutation and unreviewed self-modification. Knowledge changes should be visible in Markdown and reviewable by the steward.

## Authority order

Recommended reading order for agents:

1. Steward direct instruction.
2. Local installation policy under `~/.config/piren/`.
3. Current project ADRs and implementation plan.
4. `SOUL.md` for vault-defined identity.
5. Inbox task files for task scope.
6. Wiki pages and project references.
7. Session summaries, logs, and historical traces.

Current docs and ADRs have higher authority than old raw traces.
