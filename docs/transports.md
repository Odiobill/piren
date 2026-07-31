# Telegram and Discord transports

Messaging transports are separate gateway processes that reuse the Pi RPC client and local runnable-agent policy.

## Shared routing model

Piren distinguishes platform identity from Piren agent identity. One bot identity can route to multiple local Piren agents. Each conversation has one active Piren agent selected from the local runnable set.

The reusable session manager owns one `PiRpcClient` per transport conversation and active agent.

## Telegram

Config:

```yaml
telegram:
  bot_token: "123456:telegram-bot-token"
  allowed_chat_ids:
    - 123456789
  feedback:
    reaction_on_receive: "👀"
    reaction_on_complete: "👍"
    typing_while_working: true
  default_agent: piren
```

Run:

```bash
piren telegram
```

Commands:

- `/start`: readiness and help.
- `/agents`: list runnable agents and current active agent.
- `/agent <name>`: switch active Piren agent for this chat.
- `/whoami`: show active agent.
- `/abort`: abort the active Pi turn for this chat.
- `/new`: start a fresh Pi session for this chat, keeping the active Piren agent.
- `/compact`: compact this chat's Pi session through Pi's native manual compaction.

Plain text messages are forwarded to the active agent. Long assistant replies are split to fit Telegram message limits. By default, Piren acknowledges incoming prompts with a receipt reaction, sends a typing indicator while the agent works, and swaps to a completion reaction when the turn finishes. Set `feedback.enabled: false` to disable all transport feedback.

### Forum topics

A Telegram forum (topics) message carries a numeric `message_thread_id` identifying its topic. Piren treats each topic as a separate live transport conversation: every topic gets its own Pi session and active agent, and replies and typing indicators go back to the originating topic through the same `message_thread_id`. Every command — agent selection, `/whoami`, `/abort`, `/new`, and `/compact` — is scoped to the topic it was sent in, so one topic's controls never affect another topic in the same forum.

Authorization is unchanged: `telegram.allowed_chat_ids` remains the only gate. Allowing a forum's chat id permits its topics; there is no topic allowlist and no user allowlist. A chat whose messages carry no `message_thread_id` behaves exactly as before.

### Group delivery and BotFather Privacy Mode

BotFather Privacy Mode is a Telegram platform delivery setting, not Piren authorization. While it is enabled (the BotFather default), a bot in a group receives only commands, mentions, and replies to its own messages — not ordinary group messages. If Piren answers `/start` in a group but stays silent on ordinary messages, Privacy Mode is the likely cause. An operator who wants ordinary group-message routing must explicitly disable Privacy Mode in BotFather for the bot. Changing it alters what Telegram delivers to the bot; Piren's `allowed_chat_ids` allowlist remains the final inbound gate either way.

A Telegram private chat or group is enabled only by its explicit chat id in the machine-local `telegram.allowed_chat_ids`. Bot tokens stay in local configuration, never in the vault.

## Discord

Config:

```yaml
discord:
  bot_token: "your-discord-bot-token"
  application_id: "123456789012345678"
  install_url: "https://discord.com/oauth2/authorize?client_id=..."
  allowed_guild_ids:
    - "111"
  allowed_channel_ids:
    - "222"
  allowed_thread_ids:
    - "333"
  feedback:
    reaction_on_receive: "👀"
    reaction_on_complete: "✅"
    typing_while_working: true
  default_agent: piren
```

Run:

```bash
piren discord
```

Commands mirror Telegram:

- `/start`
- `/agents`
- `/agent <name>`
- `/whoami`
- `/abort`
- `/new`
- `/compact`

Discord uses a platform-mandated WebSocket client connection to Discord's gateway. This does not add a WebSocket server to Piren's web UI. Feedback uses Discord REST: `POST /channels/{id}/typing` and `PUT /channels/{id}/messages/{message_id}/reactions/{emoji}/@me`. Reaction failures are best-effort and never abort the assistant response.

Discord direct messages, native Discord application commands, and interactive `piren discord configure` onboarding are accepted future work (ADR-0040) and are not available in the current build.

## Session controls

`/new` and `/compact` are conversation-scoped controls over Pi's native session operations:

- `/new` starts a fresh Pi session for the current live conversation only, keeping its active Piren agent. If a Pi extension cancels the switch, Piren reports the cancellation and the current session is left unchanged.
- `/compact` asks Pi to compact the current live conversation's session through Pi's native manual compaction. It does not change automatic compaction policy.
- Neither command accepts arguments or custom instructions; an argument-bearing form such as `/compact focus on code` is treated as an unknown command.
- When no live session exists for the conversation, Piren replies that there is no active session and does not create one. Failures return a generic acknowledgement; internal error details, local paths, token figures, and transcript contents are never sent to the conversation.

Intentional boundary: there is no transport `/resume`, no exposure of session file paths or transcripts, and no persistent mapping between a platform conversation and a Pi session across a transport-process restart. After a restart, the next ordinary message simply starts a fresh session.

## Transport feedback

The `feedback` block is optional and default-on for both Telegram and Discord. Missing values use:

```yaml
feedback:
  enabled: true
  reaction_on_receive: "👀"
  reaction_on_complete: "👍"   # Telegram default
  # reaction_on_complete: "✅" # Discord default
  typing_while_working: true
```

The default completion reaction is transport-specific: Telegram defaults to `👍` because `✅` is not a Telegram-valid reaction emoji, while Discord defaults to `✅`. Custom reaction emoji availability is platform- and chat-dependent (for example, Telegram restricts which emoji bots may use as reactions), so an explicitly configured emoji is passed through unchanged and used best-effort — Piren does not validate it against the platform.

Set `feedback.enabled: false` to disable every feedback call for that transport, or override individual fields. Feedback failures are swallowed so platform reaction or typing problems never prevent Piren from sending the assistant response.

## Access control

Messaging transports use platform bot tokens plus local allowlists. They do not use the HTTP Bearer token gate.

For Discord, `allowed_guild_ids` are server ids. `allowed_channel_ids` are channel ids. Threaded messages require explicit `allowed_thread_ids`; without a matching thread id, Piren ignores the message even when the guild and parent channel appear configured. This keeps thread access fail-closed because Discord gateway message payloads are not a reliable source of parent-channel authorization context. A real gateway `MESSAGE_CREATE` sent inside a thread carries the thread's own id in `channel_id` with no `thread_id` property; that shape is accepted only when the `channel_id` value matches `allowed_thread_ids`.

## Doctor checks

`piren doctor` reports Telegram or Discord config checks only when the corresponding config block exists. An installation without messaging config is not penalized.
