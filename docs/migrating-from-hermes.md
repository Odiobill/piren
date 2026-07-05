# Migrating from Hermes

Piren is not "Hermes but smaller." It is a lighter, more personal, vault-native agent harness for builders who want discipline, inspectability, and lower everyday overhead. Hermes remains the powerful general-purpose agent operating system. This page maps the concepts so a Hermes user can find their footing in Piren.

## Concept map

| Hermes | Piren | Notes |
|--------|-------|-------|
| Memory tool | Vault (`MEMORY.md`, `wiki/`, `Projects/`) | Memory is Markdown in the vault, always inspectable and editable. No opaque backend. |
| Profiles | Agents (`team/<agent>/`) | Each agent is a role with `SOUL.md`, config, inbox, skills. |
| Skills | Vault skills (`skills/`, group, agent-scoped) | Same idea, stored in the vault, lazy-loaded. |
| Cron jobs | Vault cron (`cron/jobs/`, agent-scoped) | One file per job, atomic claim-by-rename, script or agent mode. |
| Config.yaml (profile) | `~/.config/piren/config.yml` + `team/<agent>/config.yml` | Split: installation policy outside vault, runtime prefs inside. |
| Provider credentials | `~/.pi/agent/auth.json` | Provider-native, not re-implemented. Piren requires `pi` on PATH. |
| Gateway | `piren gateway` / `piren web` | Minimal local web UI + OpenAI-compatible API. |
| Telegram/Discord | `piren telegram` / `piren discord` | Same transports, vault-backed. |
| Kanban / tasks | Inbox task files (`team/<agent>/inbox/`) | One file per task, atomic claiming. Piren does not use Hermes Kanban. |
| Subagents / delegation | Not yet in Piren v1 | Defer to Hermes if you need this today. |
| Session search | Vault logs and summaries | `team/<agent>/sessions/` and `Projects/<p>/log.md`. |
| Browser automation | Not yet in Piren v1 | Defer to Hermes or add a Pi package extension. |

## What transfers

- **Skills:** Hermes skills are Markdown. They move into `skills/`, `agent-groups/<group>/skills/`, or `team/<agent>/skills/` with minimal reformatting. The lazy-load catalog and `skill_read` tool replace Hermes's skill injection.
- **Provider credentials:** Pi-native. Piren uses Pi directly, so `~/.pi/agent/auth.json` and `~/.pi/agent/settings.json` carry over unchanged.
- **Cron schedules:** Cron syntax is the same. Piren cron job files live in `cron/jobs/` (shared) or `team/<agent>/cron/jobs/` (agent-scoped) with YAML frontmatter. See [cron](cron.md).
- **Telegram/Discord config:** Bot tokens and allow-lists move from Hermes config to the `telegram:` / `discord:` blocks in `~/.config/piren/config.yml`.

## What does not transfer

- **Opaque memory backends:** Piren has no vector database. If a Hermes skill relied on hidden memory, refactor it to read and write explicit vault artifacts.
- **Large default tool surface:** Piren starts with a compact, explicit vault-tool surface. Additional capability comes from steward-selected Pi packages (ADR-0013), not a pre-installed bundle.
- **Automatic behaviors:** Piren automation is opt-in and visible. Cron, self-improvement triggers, the scheduler, and worker polling all start disabled. Anything in Hermes that ran silently in the background must be explicitly enabled in Piren.

## Migration steps

1. **Install Piren and Pi** (see [getting started](getting-started.md)).
2. **Create a vault** with `piren init`.
3. **Define your agents** by creating `team/<agent>/SOUL.md` files. Map each Hermes profile to a Piren agent.
4. **Move skills** into the vault under the right scope (shared, group, or agent-specific).
5. **Recreate cron jobs** as vault cron files with OKF frontmatter.
6. **Set up local config** at `~/.config/piren/config.yml` with `vault_root`, `allowed_agents`, and any transport blocks.
7. **Run `piren doctor`** to verify the vault is conformant.
8. **Run `piren status` and `piren agents`** to confirm the installation sees your team.

## When to stay on Hermes

Piren v1 does not yet target users who need maximum built-in capability breadth. If your daily work depends on:

- subagent delegation and parallel orchestration,
- native session search across long histories,
- rich browser automation,
- a large pre-installed tool ecosystem,
- managed media tools,

then Hermes is the better choice today. Piren and Hermes can coexist: different vaults, different installations, same provider credentials.

## Related

- [Piren discipline](discipline.md)
- [Configuration](configuration.md)
- [Vault layout](vault-layout.md)
- [Skills](skills.md)
- [Getting started](getting-started.md)
