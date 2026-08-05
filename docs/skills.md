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

Precedence is: shared skills, then group-scoped skills, then agent-specific skills. Agent-specific skills override lower scopes with the same name. Fresh scaffolds create the `agent-groups/` parent so vaults are ready for group-scoped skills.

## Bundled starter skills (`piren skills`)

Piren ships a small package-owned starter profile, `okf`, with three shared starter procedures (`okf-authoring`, `piren-vault-operations`, `piren-knowledge-lifecycle`). Starter skills are **templates copied deliberately into a vault**: once seeded, they are ordinary steward-owned vault skills with normal precedence. They are never hidden prompt text and never loaded at runtime from the package.

Fresh `piren init` places exactly one skill automatically: the shared `piren-inbox-task-lifecycle` procedure (the fresh-vault inbox-lifecycle baseline), plus a mandatory `## Inbox task lifecycle (mandatory)` rule in the generated `steward-directives.md`. Both are created only for genuinely new vaults; a recognized existing vault never gains or overwrites them, even with `--force`. All other starter skills (the `okf` profile) stay explicit opt-in:

```bash
# Plan only (never writes)
piren skills seed --profile okf --dry-run --vault-root /path/to/vault
# Apply (creates only absent files)
piren skills seed --profile okf --yes --vault-root /path/to/vault
# Read-only drift/conflict report
piren skills doctor --profile okf --vault-root /path/to/vault
```

Limits:

- Seed creates **only absent** files; it never overwrites, deletes, or renames anything. There is no force flag.
- Package install, upgrade, `piren skills doctor`, and unchanged `piren init` never automatically add or change starter-skill content in an existing vault.
- A duplicate active skill name (shared/group/agent) blocks seeding entirely.
- Seeded copies carry a `template` provenance block (`id`, `profile`, `version`, `content_sha256`) bound to the package manifest; `doctor` classifies each copy as `absent`, `seeded-current`, `seeded-outdated-unmodified`, `user-modified`, `provenance-invalid`, or a blocking `duplicate` overlay.

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

## Staged imports (inactive)

External skills can be imported for review without making them active:

```bash
piren skill import ./external-skill.md --staged [--name <slug>] [--force]
piren skill staged list
piren skill staged show <name>
```

Staged imports land in a dedicated inactive review area:

```text
skill-candidates/imports/<name>.md
```

This area is **never** scanned by the active skill loader or `piren skill list`/`validate`. A staged skill is therefore not injected into agent context, not executed, and not discovered until it is explicitly promoted into an active scope (see below).

On import, Piren:

- requires a local `.md` source file (no URL or remote fetching),
- derives the staged name from the source filename stem, or uses an explicit `--name <slug>` (lowercase letters, numbers, dashes, underscores),
- normalizes the document to OKF `type: Skill` frontmatter while preserving the body,
- records provenance in the frontmatter: `source` (the local path given), `imported_at` (ISO timestamp), and `checksum` (SHA-256 of the original source content),
- refuses to overwrite an existing staged skill of the same name unless `--force` is passed.

Active-skill precedence is unchanged: shared, then group, then agent-specific. Staged imports do not participate in that precedence at all.

### Promoting a staged skill (activates it)

Promotion is explicit and is the only way a staged import becomes active:

```bash
piren skill staged promote <name> --to shared|group:<group>|agent:<agent> [--force]
```

Promotion moves exactly one staged Markdown artifact from `skill-candidates/imports/<name>.md` into an existing active scope (`skills/`, `agent-groups/<group>/skills/`, or `team/<agent>/skills/`). On success the staged source is removed and the destination is a normal active skill, discovered by the loader and subject to the usual precedence.

The promoted document keeps `type: Skill`, the original body, and the imported provenance (`source`, `imported_at`, `checksum`), and drops the lifecycle-only `staged: true` marker so an active skill is not falsely labelled staged. The staged name is validated before any filesystem access, the target scope must already exist, and a target collision is refused unless `--force` is given. Promotion is transactional and rollback-safe: the original target (when present) is backed up, the promoted content is committed via a temp file plus an atomic rename, and the staged source is removed only after the commit. If staged removal fails, the target is rolled back to its original state, so a failed promotion leaves no partial activation and preserves both the staged artifact and the original target; if rollback itself cannot complete, the error names the surviving files for manual recovery rather than concealing the partial state. A pre-existing transaction artifact (`.<name>.promote.bak` or `.<name>.promote.tmp`, recovery evidence from a previous interrupted promotion) is refused before any change and is never overwritten — inspect and remove it manually before retrying. Remove a staged skill only after checking that it is no longer needed.
