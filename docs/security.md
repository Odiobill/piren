# Security

Piren is local-first and pre-RC. Its security model is intentionally simple and inspectable.

## Boundaries

- Local installation authority lives in `~/.config/piren/config.yml`.
- Provider credentials stay provider-native, for example under `~/.pi/agent/`.
- Piren-owned local secrets, such as the gateway token, live under `~/.config/piren/`.
- The vault should not contain `.env`, provider tokens, bot tokens, or API keys.
- `team/<agent>/` should not contain `AGENTS.md`; Piren identity is `SOUL.md`.

## Gateway auth

Localhost binds can run without auth. Non-localhost binds require a shared bootstrap token.

Token resolution priority:

1. `--token` CLI flag.
2. `PIREN_TOKEN` environment variable.
3. `~/.config/piren/gateway-token` file.
4. Auto-generate on non-localhost bind.

The auto-generated token is persisted with mode `0600` and printed once.

All `/api/*` routes require `Authorization: Bearer *** when auth is enabled, except `GET /api/auth/info`, which is public so the frontend can discover whether auth is required.

Token comparison uses constant-time logic.

JSON API request bodies are capped at 1 MiB and rejected with HTTP 413 before
parsing. The cap is a pre-RC denial-of-service guard for the gateway's chat,
approval, model, session, and OpenAI-compatible endpoints.

## Messaging transports

Telegram and Discord use platform bot tokens plus local allowlists. They do not use the HTTP Bearer token gate.

Keep bot tokens in local config or another local secret store, not in the vault or repository.

Discord threaded messages require an explicit `discord.allowed_thread_ids`
entry. This avoids treating every thread in an allowlisted guild as authorized
when the gateway payload does not carry enough parent-channel context to prove
the thread belongs under an allowlisted channel.

## Vault path safety

Piren resolves path-scoped tool paths against the vault root and rejects traversal outside it. Name-scoped tools validate path components before constructing vault paths.

The web vault browser is read-only.

## Cron safety

Cron job prompts are vault-visible Markdown files. Do not put secrets in job files. Use local config or provider-native credential locations.

Cron runs only through opt-in worker mode. Default interactive sessions do not poll cron or inboxes automatically.

## Install-script policy

Piren's `prepare` build script runs on install. npm 10.5+ surfaces install-time
scripts through its `allow-scripts` policy. By default the policy is advisory
(the script runs with a warning). If your environment sets
`strict-allow-scripts=true`, the build is blocked and the `piren` binary will be
missing `dist/`. The `npm run clean-install:check` script detects this failure.
Approve the build explicitly with `npm install --allow-scripts` when needed.

## Current limitations

- No multi-user RBAC.
- No OAuth login for the integrated gateway.
- No TLS termination built in. Put Piren behind a trusted reverse proxy if exposing beyond a private network.
- No sandbox around arbitrary tool effects from the underlying Pi agent. Treat a configured agent as trusted local automation.
