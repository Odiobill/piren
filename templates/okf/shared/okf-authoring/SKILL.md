---
type: Skill
name: okf-authoring
description: "Author compact OKF documents with frontmatter, wikilinks, and a clear project/wiki boundary."
version: 1.0.0
tags: [okf, docs, knowledge]
---

# OKF Authoring

Author compact Open Knowledge Format (OKF) documents in a Piren vault.

## Required frontmatter

Every durable knowledge document carries YAML frontmatter with a non-empty `type` field:

```yaml
---
type: Concept
title: "Example"
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [piren]
status: draft
---
```

## Project vs wiki boundary

- Use `Projects/<Project>/` for project-local docs, decisions, plans, logs, and runbooks.
- Use `wiki/concepts/` and `wiki/entities/` for reusable knowledge that applies across projects or appears as shared graph nodes.
- Do not dump full project history into the shared wiki; promote only reusable concepts.

## Link discipline

- Use wikilinks for internal concepts and project docs when helpful.
- Keep pages compact.
- Prefer a few meaningful links over link spam.
- Update indexes or handoffs when discoverability would otherwise suffer.

## Self-audit

After writing concept documents, run the vault conformance check and fix any document missing a parseable non-empty `type` field.
