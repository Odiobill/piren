# Agent groups and fallback

Agent groups (ADR-0028) let you share a skill set and a fallback policy between agents without duplicating configuration under every agent. A group is a role overlay, not an identity replacement. Each agent keeps its own `SOUL.md`, config, and individual identity. The group provides shared procedures and a fallback recommendation policy.

The first shipped slice is read-only and diagnostic: it reports and recommends, it does not reassign work automatically. Approval is always required before a task changes hands.

## Group configuration

A group lives under `agent-groups/<group>/`. Group membership and fallback order are declared in `agent-groups/<group>/config.yml`:

```yaml
agents:
  - dipu
  - zai
  - sam
  - dario
fallback_order:
  zai:
    - dipu
    - sam
  dipu:
    - zai
  sam:
    - zai
```

- `agents` lists the members of the group.
- `fallback_order` maps an agent to the ordered list of fallback candidates used when that agent cannot pick up a task.

Group-scoped skills live under `agent-groups/<group>/skills/`. A group directory without a `config.yml` is skipped, not an error.

## Skill precedence

When an agent belongs to one or more groups, skills load in this order:

```
skills/                           # shared, loaded by every agent
agent-groups/<group>/skills/      # group skills, later groups override earlier
team/<agent>/skills/              # agent-specific, overrides everything by name
```

Agent-local skills always win. Group skills override shared skills of the same name. This lets a `developers` group share a TDD workflow skill pack without forcing it into every agent's local skills directory.

See [skills](skills.md) for the skill format and [vault layout](vault-layout.md) for the directory structure.

## Read-only fallback recommendation

```bash
piren agents --fallback <agent>
```

Prints the ordered fallback candidates for an agent, filtered by local runnable policy (`allowed_agents` / `excluded_agents`) and same-group membership. This is read-only diagnostic output. It does not reassign any task.

Example (using the Piren development team configuration):

```bash
$ piren agents --fallback zai
Fallback candidates for 'zai' (group: developers):
  [runnable] dipu - priority 1
  [runnable] sam  - priority 2
```

Candidates are filtered through two checks:

1. **Runnable set:** the candidate must be healthy in the vault (have a `team/<candidate>/` directory) and allowed by local installation policy.
2. **Same-group membership:** the candidate must belong to the same group as the failed agent.

## What fallback does NOT do

The first implementation is deliberately conservative:

- **No automatic rerouting.** Nothing changes hands silently. The steward or a coordinator agent must explicitly act on the recommendation.
- **No runtime fallback during an active task.** Fallback is evaluated on demand, not mid-execution.
- **No fallback across unrelated groups.** Candidates come from the failed agent's own group(s).

## Doctor visibility

`piren doctor` reports group membership for each agent and warns on two conditions:

- **Stale group agent:** a group config references an agent that has no `team/<agent>/` directory.
- **Skill conflict:** two groups declare the same skill name with different bodies, but only when the agent is in both groups.

`piren agents` shows each agent's group memberships.

## A real example: the Piren development crew

The Piren team uses one group, `developers`, with this fallback order:

| Agent | Falls back to |
|-------|---------------|
| Zai   | Dipu          |
| Sam   | Zai           |
| Dipu  | Zai           |
| Dario | (none, consultant-only) |

When Zai's provider quota is exhausted, the system recommends Dipu. Nora (the release coordinator) or the steward approves the reassignment, the task file gets a visible routing note, and the trail is never hidden. See the [operating model](https://github.com/Odiobill/piren/tree/main/Projects/Piren/piren-agent-operating-model.md) for the full crew description.

## Related

- [ADR-0028: Agent groups and fallback agents](../decisions/ADR-0028-agent-groups-and-fallback-agents.md)
- [Skills](skills.md)
- [Vault layout](vault-layout.md)
- [Scheduler](scheduler.md) (device failover for the same agent, the complementary feature)
