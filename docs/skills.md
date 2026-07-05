# Skills

Piren vault skills are Markdown procedures. They are context, not executable code.

## Locations

Shared skills:

```text
skills/
```

Group-scoped skills, for role procedures shared by several agents:

```text
agent-groups/<group>/skills/
```

Agent-specific skills:

```text
team/<agent>/skills/
```

Precedence is: shared skills, then group-scoped skills, then agent-specific skills. Agent-specific skills override lower scopes with the same name. Group loading is introduced by ADR-0028; fresh scaffolds already create the `agent-groups/` parent so vaults are compatible with that feature.

## File formats

A skill can be a loose Markdown file:

```text
skills/debugging.md
```

or a directory with `SKILL.md`:

```text
skills/debugging/SKILL.md
```

Optional frontmatter:

```yaml
---
name: debugging
description: Systematic debugging workflow
---
```

If `name` is absent, Piren falls back to the filename stem.

## Lazy loading

At startup, Piren injects only a compact catalog:

- name
- source, shared or agent-specific
- description
- vault-relative path

Full bodies are not injected at startup. Agents call:

- `skill_list()` to inspect the catalog.
- `skill_read(name)` to load one full skill body.

This keeps startup prompts small while preserving reusable procedure access.

## Status

`piren_status` reports `skills_loaded: <count>`.

## Boundaries

Skills are durable procedures. They should not contain secrets, one-off task progress, or raw session logs. Promote procedures to skills only when they are reusable.

## Group-scoped skills

Agents can belong to groups that share a skill set. Skills load in this precedence order:

1. **Shared** (`skills/`) - loaded by every agent.
2. **Group** (`agent-groups/<group>/skills/`) - loaded for agents in the group, later groups override earlier.
3. **Agent-specific** (`team/<agent>/skills/`) - overrides everything by name.

This lets a `developers` group share a TDD workflow skill pack without duplicating it under every developer agent. See [agent groups and fallback](agent-groups.md) for group configuration and fallback policy.
