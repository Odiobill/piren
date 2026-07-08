# Token discipline

Piren is designed to keep everyday LLM cost low. This page explains the mechanisms. It does not promise exact savings, because usage varies, but the design choices that produce lower overhead are concrete and inspectable.

## Idle LLM cost is zero

Nothing in Piren invokes an LLM unless you explicitly ask it to:

- `piren run` starts an interactive session that calls the LLM only when you send a message.
- `piren worker` polls for inbox and cron work, but only for agents you explicitly allow, and only when work is due.
- `piren scheduler --dry-run` plans claims with zero LLM calls. It is a pure planner over vault state.
- `piren scheduler` runs the opt-in loop; every tick is LLM-free. Only the bounded execution of a claimed task or agent-mode cron job invokes an LLM.

There is no default always-on polling in interactive `piren run`. Automation is opt-in.

## Script-mode cron runs without an LLM

Cron jobs have two modes (ADR-0019, ADR-0023):

- **agent mode:** runs a prompt through the LLM.
- **script mode:** runs an executable script directly, no LLM.

Script-mode cron is the mechanism for routine background work that does not need reasoning: log rotation, health checks, data sync, report generation from templates. A script-mode job records its run in the vault and never spends a token.

## Lazy skill loading

Skills are loaded lazily (ADR-0017). At startup, Piren injects only the skill catalog (names and one-line descriptions), not full skill bodies. An agent calls `skill_read(name)` to load one full body on demand.

This keeps startup prompts small. A vault with fifty skills does not pay for fifty skill bodies on every session start, only for the ones the agent actually reads.

## Compact startup context

Piren injects a compact context at session start: agent `SOUL.md`, `MEMORY.md`, the steward directives, the skill catalog, and the project status. It does not dump raw session transcripts or the full vault into the prompt.

Project docs (ADRs, handoffs, logs) are synthesized context. An agent reads the current project state, not a pile of historical traces. This is cheaper and more accurate than feeding the LLM raw history and hoping it synthesizes on the fly.

## Explicit vault tools, not a large always-on surface

Piren's default tool surface is compact and explicit: `vault_read`, `vault_write`, `vault_list`, `send_to_agent`, `task_claim`, `cron_claim`, and the knowledge-lifecycle tools. Additional capability comes from steward-selected Pi packages (ADR-0013), not a pre-installed bundle.

A smaller tool surface means fewer tokens spent describing tools the agent will not use, and less ambiguity in tool selection.

## Cached vault reads

`vault_read_cached` reads a vault file once and caches it for the session. Repeated reads of the same file (common when an agent checks project state repeatedly) do not re-read from disk or re-inject the content. This reduces redundant tool I/O.

## Claim-scoped bounded execution

Bounded execution (ADR-0029, O7 S2-S3) is claim-scoped: the agent receives one claimed task or one claimed cron job, executes it, records the result, and stops. It does not poll for other work. This prevents a single background run from spiraling into an open-ended LLM session.

## Self-improvement review loops default off

Self-improvement triggers (ADR-0018, ADR-0024) are inspectable and opt-in. The review loop that promotes raw traces into durable artifacts does not run unless enabled. When enabled, its state and decisions live in the vault for inspection.

## The mechanism, not the promise

Token discipline in Piren is not a magic optimization. It is the cumulative effect of:

- no default automation,
- script-mode cron for routine work,
- lazy skill loading,
- compact synthesized context instead of raw transcripts,
- a small explicit tool surface,
- cached reads,
- claim-scoped bounded execution,
- opt-in self-improvement.

Each of these is inspectable. You can read the vault, read the config, and read the code to verify exactly what will and will not invoke an LLM.

## Related

- [Piren discipline](discipline.md)
- [Scheduler](scheduler.md)
- [Cron jobs](cron.md)
- [Skills](skills.md)
- [ADR-0017: Lazy skill loading](../decisions/ADR-0017-lazy-skill-loading.md)
- [ADR-0023: Script-only cron](../decisions/ADR-0023-script-only-cron.md)
