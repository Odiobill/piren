# Skills

Piren vault skills are Markdown procedures. They are context, not executable code.

## Locations

Shared skills:

```text
skills/
```

Agent-specific skills:

```text
team/<agent>/skills/
```

Agent-specific skills override shared skills with the same name.

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
