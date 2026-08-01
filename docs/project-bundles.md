# Project bundles

A project bundle is the subset of vault knowledge that travels with a specific code repository. It lets a project carry its own decisions, logs, handoffs, and runbooks alongside the source, while the shared vault holds the full cross-project knowledge substrate.

The Piren repository itself is the reference example: its vault project bundle mirrors this structure.

## The Projects/ orientation

Every vault has a top-level `Projects/` directory. Each project gets one subdirectory:

```text
Projects/
  Piren/
    index.md
    log.md
    handoff-prompt.md
    decisions/
      build-on-pi.md
      ...
    runbooks/
    skill-candidates/
  GymSync/
    index.md
    log.md
    decisions/
    ...
```

`Projects/` is the deliberate title-case, steward-facing workspace exception in an otherwise lower-case vault protocol. It groups long-form human-facing project context.

## What belongs in a project bundle

- `index.md` - the project entry point: current status, links to decision records and reference docs, required skills, authority boundaries.
- `log.md` - append-only chronological project log. Raw evidence of what happened and when.
- `decisions/` - durable decision records. Each record is one Markdown file with non-empty OKF frontmatter.
- `handoff-prompt.md` - the current handoff state for continuing work across sessions.
- `runbooks/` - operational procedures specific to this project.
- `skill-candidates/` - procedures being refined before promotion to shared or group skills.

## What does NOT belong in a project bundle

- Source code. Code lives in the repository, not the vault.
- Machine-local config. `~/.config/piren/` and `~/.pi/` stay outside the vault.
- Session traces. Those live in `team/<agent>/sessions/`.
- Inbox tasks. Those live in `team/<agent>/inbox/`.
- Agent identity. That lives in `team/<agent>/SOUL.md`.

## Co-locating project docs with source

A project bundle can be checked into the same repository as the source code, or kept in the shared vault only. The Piren project keeps the authoritative project docs in its vault project bundle, and the repository carries `AGENTS.md` and `docs/` as the code-adjacent surface.

The split:

- `AGENTS.md` in the repo: stable implementation rules agents must follow when working in that source tree.
- `docs/` in the repo: operator-facing documentation shipped with the package.
- `Projects/<p>/` in the vault: synthesized project knowledge (decision records, logs, handoffs, runbooks).

This keeps the repository focused on code and shipped docs, while the vault accumulates the deeper project knowledge that agents and stewards consult over time.

## Keeping project docs in sync

The project bundle is the source of truth for project-level decisions. When a decision changes:

1. Update the decision record in `Projects/<p>/decisions/` first when direction changes.
2. Update `Projects/<p>/index.md` to link the new or updated record.
3. Append a `Projects/<p>/log.md` entry recording the change.
4. Update repository `docs/` when operator-facing behavior changes.

This keeps durable project context in the vault while repository documentation stays focused on using the product.

## The knowledge delta rule

Every non-trivial task should consider its knowledge delta. Update the minimum useful durable artifact, not everything. The artifact promotion ladder:

```text
raw task/session evidence
  -> summary or result
  -> project log entry
  -> current project docs or handoff
  -> decision record, runbook, wiki page, or skill candidate
```

Raw traces are evidence. Current project docs and decision records are synthesized truth. Promote deliberately, never through hidden automatic mutation. See [knowledge lifecycle](knowledge-lifecycle.md).

## Related

- [Vault layout](vault-layout.md)
- [Fresh vault](fresh-vault.md)
- [Knowledge lifecycle](knowledge-lifecycle.md)
- [OKF](okf.md)
