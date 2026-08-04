---
type: Skill
name: piren-knowledge-lifecycle
description: "Leave the minimum durable knowledge artifact after non-trivial work: promote raw evidence to curated docs."
version: 1.0.0
tags: [piren, knowledge, lifecycle]
---

# Piren Knowledge Lifecycle

Leave a durable knowledge delta after non-trivial work so future sessions do not rediscover it.

## Artifact promotion

Promote raw evidence upward only when it becomes durable:

```text
raw task/session evidence
  -> task result or session summary
  -> project log
  -> current project docs or handoff
  -> ADR, runbook, wiki page, or skill candidate
```

## Knowledge delta rule

- Update the minimum useful artifact, not everything.
- Raw traces are evidence; project docs and ADRs are synthesized truth.
- Skill candidates are drafts, not active skills until promoted.

## Artifact tools

Use the visible project and wiki tools for the artifact layer that fits:

- project status and project log for project truth;
- decision records for architecture decisions;
- handoff updates for fresh-session continuity;
- runbook writes for repeated operations;
- skill candidates for reviewable reusable procedures;
- concept and entity wiki updates for reusable cross-project knowledge.

## No hidden memory

Never mutate hidden memory or write silently; every durable artifact is a visible vault file.
