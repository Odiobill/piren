---
type: Skill
name: piren-vault-operations
description: "Operate a Piren vault: inbox tasks, claims, cron, alerts, and explicit vault tool usage."
version: 1.0.0
tags: [piren, vault, operations]
---

# Piren Vault Operations

Operate a Piren vault explicitly and inspectably.

## Vault access

- Use the explicit vault tools for reads and writes; traversal outside the vault is rejected.
- Keep actions explicit, inspectable, and boring.

## Task lifecycle

- Tasks are one Markdown file per task under `team/<agent>/inbox/`.
- Claim a task before working on it; update its status and result when finished.
- Never poll inboxes automatically in an interactive session; use explicit inspection or opt-in worker mode.

## Scheduled work

- Vault-backed cron jobs are file-backed and inspectable: list due jobs, claim one for this device, run it, and record an inspectable run record.
- Secrets never belong in cron job files or scripts.

## Alerts

- Escalate through steward alerts when the vault or a workflow is unavailable.
- Alerts are authoritative files; any delivery is advisory.

## Boundaries

- Local installation policy and credentials stay outside the vault.
- The vault is the inspectable memory; no hidden memory mutation.
