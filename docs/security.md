# Security

Piren is local-first. Its security model is intentionally simple and inspectable.

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

The vault browser and graph API routes are read-only (the Workbench's Vault Explorer companion presents files read-only over the same bounded routes; Knowledge Graph presentation is not part of the current Workbench).

## Cron safety

Cron job prompts and script paths are vault-visible Markdown frontmatter. Do not put secrets in job files or vault scripts. Use local config or provider-native credential locations.

Cron runs only through opt-in worker mode. Default interactive sessions do not poll cron or inboxes automatically. Script-mode cron executes vault scripts with the worker process privileges, so only run scripts you trust and keep them inspectable in the vault.

## Install artifact policy

The normal operator install is the scoped npm registry package
`npm install -g @odiobill/piren`. Published versions are immutable, and a
version-pinned install (`npm install -g @odiobill/piren@<version>`) is
reproducible. npm signs published packages with provenance attestations; verify
a release artifact's integrity and provenance before trusting it in production.

For offline or emergency installs, a local tarball can be installed with
`npm install -g /path/to/odiobill-piren-<version>.tgz`.

## Current limitations

- No multi-user RBAC.
- No OAuth login for the integrated gateway.
- No TLS termination built in. Put Piren behind a trusted reverse proxy if exposing beyond a private network.
- No sandbox around arbitrary tool effects from the underlying Pi agent. Treat a configured agent as trusted local automation.
