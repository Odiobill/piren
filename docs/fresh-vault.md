# Fresh vault and OKF bundles

A Piren vault is a directory tree of Markdown files with YAML frontmatter. This page covers how to create a fresh vault, what gets scaffolded, and how to package a vault or a knowledge bundle for a new team member or a new device.

## Create a fresh vault

```bash
piren init --vault-root /path/to/vault
```

This creates:

- A `.piren-vault` marker file identifying the directory as a Piren vault.
- Shared directories: `skills/`, `agent-groups/`, `cron/jobs/`, `cron/runs/`, `Projects/`, `steward-inbox/`, `wiki/concepts/`, `wiki/entities/`.
- A default `team/piren/` agent with `SOUL.md`, `MEMORY.md`, `config.yml`, `inbox/`, `outbox/`, `logs/`, `sessions/`, `skills/`, `cron/jobs/`, `cron/runs/`, `devices/`.
- A `steward-directives.md` orienting the steward on the vault layout.

Use a different first agent name when needed:

```bash
piren init --vault-root /path/to/vault --agent thor
```

See [vault layout](vault-layout.md) for the full directory reference.

## The OKF starter graph

A fresh vault starts nearly empty. The Piren development vault seeds a small starter graph of concept documents under `wiki/concepts/` and `wiki/entities/` to orient new agents and stewards. The starter graph includes:

- `wiki/entities/piren.md` - what Piren is.
- `wiki/concepts/open-knowledge-format.md` - the OKF rule.
- `wiki/concepts/piren-vault.md` - the vault concept.
- `wiki/concepts/piren-agent-operating-model.md` - how agents work.
- `wiki/concepts/knowledge-lifecycle.md` - artifact promotion.
- `wiki/concepts/okf-knowledge-bundle.md` - the bundle format.

These six documents are the minimum useful orientation set. `piren doctor` checks that a fresh scaffold produces exactly these concept documents and no more.

## Point a device at an existing vault

A vault is independent of the machine it runs on. To point a second device at an existing vault:

1. Sync the vault directory to the new device (Syncthing, git, rsync, a network mount, anything that preserves the tree).
2. Install Piren on the new device.
3. Create `~/.config/piren/config.yml` on the new device:

```yaml
vault_root: /path/to/the/same/vault
allowed_agents:
  - piren
  - thor
```

4. Run `piren doctor` to verify.

The agent identity, memory, inbox, skills, and project knowledge travel with the vault. Local installation policy (which agents this device may run) stays outside the vault. See [ADR-0002](../decisions/ADR-0002-vault-as-source-of-truth.md).

## Packaging a vault for a new team

A vault is just a directory. To hand a vault to a new team member:

1. Create a fresh vault with `piren init`.
2. Seed the agents you want (`team/<agent>/` directories with `SOUL.md` files).
3. Optionally seed shared skills and the starter graph.
4. Package the directory (tarball, git repo, zip).
5. Hand it over with instructions to sync it locally and create their own `~/.config/piren/config.yml`.

Do not package `~/.config/piren/` or `~/.pi/`. Those are machine-local: installation policy and provider credentials respectively.

## OKF bundles

An OKF knowledge bundle is a portable subset of the vault focused on durable knowledge, not operational state. A bundle typically contains:

- `wiki/concepts/` - curated concept pages.
- `wiki/entities/` - entity descriptions.
- `Projects/<p>/decisions/` - ADRs.
- `Projects/<p>/index.md` and `log.md` - project context.
- Relevant `runbooks/`.

It excludes operational state that is machine- or session-specific: `team/<agent>/sessions/`, `team/<agent>/devices/`, `cron/runs/`, claimed task files.

Every document in a bundle must carry OKF frontmatter with a non-empty `type` field. See [OKF](okf.md) for the format and `piren doctor` for the conformance check.

## Related

- [Vault layout](vault-layout.md)
- [OKF](okf.md)
- [Configuration](configuration.md)
- [Getting started](getting-started.md)
- [Project bundles](project-bundles.md)
