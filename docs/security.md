# Security

Piren is local-first. As of 0.1.0-rc.1 its security model is intentionally simple and inspectable.

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
parsing. The cap is a denial-of-service guard for the gateway's chat,
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

Cron job prompts and script paths are vault-visible Markdown frontmatter. Do not put secrets in job files or vault scripts. Use local config or provider-native credential locations.

Cron runs only through opt-in worker mode. Default interactive sessions do not poll cron or inboxes automatically. Script-mode cron executes vault scripts with the worker process privileges, so only run scripts you trust and keep them inspectable in the vault.

## Install artifact policy

GitHub installs use the committed `dist/` release artifacts and do not compile
TypeScript on the target machine. On npm 11, install GitHub sources with
`--install-links` so the global bin points at a copied package instead of npm's
temporary git cache. `npm pack` runs the `prepack` build before creating a
tarball. If `dist/` is missing after install, the source or tarball being
installed is incomplete. Run `npm run clean-install:check` before release.

## Current limitations

- No multi-user RBAC.
- No OAuth login for the integrated gateway.
- No TLS termination built in. Put Piren behind a trusted reverse proxy if exposing beyond a private network.
- No sandbox around arbitrary tool effects from the underlying Pi agent. Treat a configured agent as trusted local automation.
