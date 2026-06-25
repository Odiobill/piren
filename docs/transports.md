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

Plain text messages are forwarded to the active agent. Long assistant replies are split to fit Telegram message limits.

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

Discord uses a platform-mandated WebSocket client connection to Discord's gateway. This does not add a WebSocket server to Piren's web UI.

## Access control

Messaging transports use platform bot tokens plus local allowlists. They do not use the HTTP Bearer token gate.

For Discord, `allowed_guild_ids` are server ids. `allowed_channel_ids` are channel ids. Optional `allowed_thread_ids` restricts threads.

## Doctor checks

`piren doctor` reports Telegram or Discord config checks only when the corresponding config block exists. An installation without messaging config is not penalized.
