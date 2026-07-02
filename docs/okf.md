# Open Knowledge Format (OKF)

Piren's vault follows the [Open Knowledge Format (OKF) v0.1](https://github.com/google/knowledge-catalog): a directory tree of Markdown files with YAML frontmatter. OKF is intentionally close to what Piren already does. The full design decision is [ADR-0022](../README.md); this page is the operator reference.

## The one rule that matters

Every concept document in the vault has YAML frontmatter with a **non-empty `type` field**:

```markdown
---
type: Concept
title: Fleet Profiles
description: One-line summary.
tags: [piren, ops]
updated: 2026-06-28
---

# Fleet Profiles

Body text.
```

That is the only hard conformance delta between Piren's existing conventions and OKF v0.1 (spec section 9). Everything else (title, description, resource, tags, timestamp, citations, cross-links) is optional and additive.

## Piren type taxonomy

Type values are not centrally registered and consumers tolerate unknown types. The documented Piren types are:

| Type | Used for | Location |
| --- | --- | --- |
| `Concept` | Reusable cross-project knowledge | `wiki/concepts/` |
| `Entity` | A described person, system, service, or product | `wiki/entities/` |
| `Runbook` | Operational procedure | `wiki/runbooks/`, `Projects/<p>/runbooks/` |
| `ADR` | Architecture decision record | `Projects/<p>/decisions/` |
| `Skill` | Reusable agent procedure | `vault/skills/`, `team/<agent>/skills/` |
| `Project Index` | A project's `index.md` | `Projects/<p>/index.md` |
| `Project Log` | A project's `log.md` | `Projects/<p>/log.md` |
| `Session Summary` | A session trace summary | `team/<agent>/sessions/` |
| `Task` | An inbox task file | `team/<agent>/inbox/`, `steward-inbox/alerts/` |
| `Cron Job` | A scheduled job definition | `cron/jobs/`, `team/<agent>/cron/jobs/` |
| `Cron Run` | A scheduled run record | `cron/runs/`, `team/<agent>/cron/runs/` |

Unknown types are fine. The taxonomy is descriptive, not an allowlist.

## What is NOT a concept document

The conformance check skips these filenames so it never nags identity, runtime, or coordination files:

- Reserved filenames with their own structure: `index.md`, `log.md`.
- Piren system files: `SOUL.md`, `MEMORY.md`, `AGENTS.md`, `steward-directives.md`, `README.md`.
- Dotfiles and dot-directories (`.git`, `.piren-vault`, ...).
- Claimed coordination files: `*.claimed.<device>.md` (the atomic-claim rename used by inbox and cron).
- Non-`.md` files.
- Excluded directories: `.git`, `node_modules`, plus any extras passed to the checker.

## Checking conformance

### piren doctor

`piren doctor` runs an OKF conformance check over the vault and reports it as a `vault-okf-conformance` line. Conformance problems are a **warning, never a hard fail**: a vault with entropy is drifting from the specified format, not broken.

```text
[WARN] vault-okf-conformance: OKF conformance problems in 2 of 5 concept document(s): missing-type: wiki/concepts/foo.md; missing-frontmatter: notes/bar.md. Run 'piren doctor' or the vault_conformance_check tool for the full list.
```

### vault_conformance_check tool

Agents can self-audit their own writes at any time:

```text
vault_conformance_check()
```

Returns a human-readable report plus a structured `details` object (`ok`, `checked`, `truncated`, and a `problems` list). Each problem has a `path`, a `kind` (`missing-frontmatter`, `unterminated-frontmatter`, `malformed-frontmatter`, `missing-type`, or `unreadable`), and an optional `detail`.

Agents should run `vault_conformance_check()` after writing wiki concepts to catch a missing `type` immediately.

## Wiki authoring tools

Agents should use the explicit wiki tools instead of raw `vault_write` for curated concepts and entities:

```text
wiki_update_concept(title, content, description?, tags?, links?)
wiki_update_entity(title, content, description?, tags?, links?)
```

`wiki_update_concept` writes `wiki/concepts/<slug>.md` with `type: Concept`. `wiki_update_entity` writes `wiki/entities/<slug>.md` with `type: Entity`. Both include `title`, optional `description`, optional `tags`, `created`, `updated`, the Markdown body, and optional bundle-relative links.

Example link values:

```text
/Projects/Piren/knowledge-lifecycle.md
/Projects/Piren/decisions/ADR-0024-inspectable-self-improvement-triggers.md
```

## Link semantics

OKF supports three link forms that coexist in a Piren vault:

- **Bundle-relative absolute links** (`/tables/orders.md`) - preferred for machine and agent-authored content.
- **Relative links** (`./other.md`) - standard Markdown.
- **Obsidian wikilinks** (`[[Concept]]`) - preferred for human authoring in Obsidian.

A link from concept A to concept B asserts a directed relationship (OKF 5.3). The kind of relationship is conveyed by surrounding prose, not the link itself. Broken links are not malformed; they may represent not-yet-written knowledge.

## Knowledge graph

The gateway exposes a read-only graph route for the integrated Web UI:

```text
GET /api/vault/graph
```

It returns JSON with `nodes`, `edges`, `problems`, and `truncated`. Nodes are all OKF-typed Markdown documents found from the vault root, including `Concept`, `Entity`, `Project Index`, `ADR`, `Runbook`, and other typed documents. Edges are directed links extracted from wikilinks, bundle-relative links, relative Markdown links, and external URLs. The Web UI renders this as a minimal SVG Knowledge Graph; selecting a node opens the corresponding vault document in the existing read-only browser.

If the graph is empty, the vault has no readable Markdown files with a non-empty `type` frontmatter field. For imports, keep working project material under `Projects/<Project>/`, but promote reusable knowledge and named systems into `wiki/concepts/` and `wiki/entities/` with the explicit wiki tools so they become durable, linked graph nodes.

## Exchange

Because the vault is a plain OKF bundle, it can be `git clone`d and consumed by any OKF-aware tool. Piren treats the vault as the single source of truth: no hidden database, no opaque memory store. The format is the contract.
