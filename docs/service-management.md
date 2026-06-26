# Service management

Piren transports (gateway, Telegram, Discord) are long-running processes. This
page describes how to keep them running on homelab and edge devices using
Piren's built-in service lifecycle management.

See [ADR-0021](https://github.com/Odiobill/piren) for the design decisions.

## Overview

`piren service` generates and manages supervisor files for each transport:

- **systemd user units** (preferred) on machines with a systemd user session.
- **tmux + `@reboot` cron** fallback for DietPi and stripped-down systems
  without a full systemd user session.
- **none** (manual) when neither is available: Piren prints the exact command
  to run and writes no files.

All generated files are plain text under `~/.config/piren/services/` and are
fully inspectable and reversible. Piren never requires root.

## Detecting the service manager

Piren probes for `systemctl --user`, `tmux`, and `crontab` at runtime. You do
not need to install anything ahead of time. The detected manager is reported by
every `piren service` command in its output, for example `(systemd)` or
`(tmux-cron)` or `(none)`.

## Installing a transport as a service

```bash
piren service install gateway
```

This resolves the configured vault and agent, generates the supervisor files,
and starts the transport. For systemd it writes a user unit, enables it, and
starts it. For tmux-cron it writes a launch script, makes it executable, starts
a detached tmux session, and merges an `@reboot` crontab line.

Generated files:

```text
~/.config/piren/services/
  piren-gateway.service      (systemd unit)
  piren-gateway.tmux.sh      (tmux launch script, when applicable)
  piren-gateway.cron         (crontab fragment, when applicable)
```

After a successful install, Piren records the status in
`~/.config/piren/config.yml` so `piren doctor` can report it:

```yaml
services:
  transports:
    gateway:
      installed: true
      running: true
```

### systemd: enable lingering

systemd user units stop when you log out unless lingering is enabled. Enable it
once so the gateway survives logout and starts at boot:

```bash
loginctl enable-linger $USER
```

Inspect logs with:

```bash
journalctl --user -u piren-gateway.service -f
```

### tmux + cron fallback

The tmux session is named `piren-<transport>`. Attach to it to watch output
directly:

```bash
tmux attach -t piren-gateway
```

Detach with `Ctrl+b` then `d`. The session keeps running after you detach.

## Removing a service

```bash
piren service remove gateway
```

This stops the transport, disables and deletes the generated files, and removes
the `@reboot` crontab line. The full reverse of install.

## Controlling a service

```bash
piren service start gateway
piren service stop gateway
piren service restart gateway
piren service status gateway
```

For systemd these map to `systemctl --user start|stop|restart|status`. For
tmux-cron, start runs the launch script, stop kills the tmux session, and
status reports whether the session exists.

## Interactive setup wizard

Running `piren setup` with no flags launches an interactive wizard that guides
you through vault configuration, LLM provider setup, and writes the local
config. This is the easiest path from a fresh install to a working Piren:

```bash
piren setup
```

The wizard:

1. **Vault**: point at an existing vault (it detects agents and asks which to
   enable) or initializes a new one (asks for the location and first agent name,
   default `piren`).
2. **LLM**: choose a Pi provider (Anthropic, OpenAI, Google, DeepSeek, and
   others), enter the API key, and write it to `~/.pi/agent/auth.json` at mode
   `0600`.
3. **Local config**: writes `~/.config/piren/config.yml` with the resolved
   vault root and allowed agents, after showing you the content and asking for
   confirmation.

Batch mode is unchanged for automation:

```bash
piren setup --apply --vault-root /tmp/piren-vault --agent piren
```

## Transports

The `<transport>` argument is one of:

- `gateway` - the web UI and OpenAI-compatible API.
- `telegram` - the Telegram bot transport.
- `discord` - the Discord bot transport.

Telegram and Discord require their config blocks (`telegram:` / `discord:`) to
be present in `~/.config/piren/config.yml` before the service can run. See
[Transports](transports.md).

## Security notes

- Piren uses **user** systemd units, never system units. No root, no sudo.
- Service files live under your home directory, not `/etc/systemd/`.
- Transport tokens and API keys stay in `~/.config/piren/config.yml` and
  `~/.pi/agent/auth.json` respectively, never in the vault or the repository.
- The `running` status recorded in config is advisory (set at install time).
  `piren service status` checks the live state for an accurate report.
