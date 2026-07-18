# Service management

Piren service targets (gateway, Telegram, Discord, and the scheduler) are
long-running processes. This page describes how to keep them running on
homelab and edge devices using Piren's built-in service lifecycle management.

The design decisions are recorded as ADR-0021 in the Piren project vault.

## Overview

`piren service` generates and manages supervisor files for each service target:

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

The probe is tolerant of real-world homelab states:

- **systemd user session:** `systemctl --user is-system-running` exits 1 with
  `degraded`, `starting`, or `maintenance` on many machines. These states still
  run user services fine, so Piren treats them as available. A missing user bus
  (for example DietPi output mentioning `DBUS_SESSION_BUS_ADDRESS` or
  `XDG_RUNTIME_DIR`), exit >= 2, bus error, or command-not-found is unavailable.
- **crontab:** `crontab -l` exits 1 when the user has no crontab yet (common on
  DietPi and stripped-down systems). Piren treats exit 0 and 1 as available.

You can override detection explicitly when you know which supervisor you want:

```bash
piren service install telegram --method tmux-cron
piren service status telegram --method tmux-cron
```

`--method` accepts `auto` (default), `systemd`, or `tmux-cron`.

## Installing a service target

```bash
piren service install gateway
```

This resolves the configured vault and agent, generates the supervisor files,
and starts the target. Pass `--vault-root` and `--agent` explicitly when not
running through a fully bootstrapped config:

```bash
piren --vault-root /path/to/vault --agent piren service install gateway
```

For systemd it writes a user unit, copies it into `~/.config/systemd/user/`,
runs `daemon-reload`, enables it, and starts it. Real example output:

```text
Wrote /home/you/.config/piren/services/piren-gateway.service
$ mkdir -p ~/.config/systemd/user
$ cp /home/you/.config/piren/services/piren-gateway.service ~/.config/systemd/user/piren-gateway.service
$ systemctl --user daemon-reload
$ systemctl --user enable piren-gateway.service
$ systemctl --user start piren-gateway.service
Piren service install gateway (systemd)
```

When Piren is run from source or dist (`node dist/src/cli.js`), the generated
unit's `ExecStart` automatically prepends `node` so systemd can execute it:

```text
ExecStart=node /home/you/src/piren/dist/src/cli.js gateway --vault-root /path/to/vault --agent piren
```

When run through the globally installed `piren` binary, `ExecStart` is the
binary path directly.

For tmux-cron it writes a launch script, makes it executable, starts a detached
tmux session, and merges an `@reboot` crontab line.

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

The tmux session is named `piren-<target>`. Attach to it to watch output
directly:

```bash
tmux attach -t piren-gateway
```

Detach with `Ctrl+b` then `d`. The session keeps running after you detach.

## Removing a service

```bash
piren service remove gateway
```

This stops the target, disables and deletes the generated files, and removes
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

## First-run setup

Running `piren setup` with no flags launches the minimal first-run flow. It
requires a local `pi` binary on PATH and existing Pi-native auth first, then
guides you through vault/local-agent configuration and writes the local Piren
config:

```bash
piren setup
```

The setup flow:

1. **Vault**: point at an existing vault (it detects agents and asks which to
   enable) or initializes a new one (asks for the location and first agent name,
   default `piren`).
2. **Agent model**: copies Pi's default provider/model/thinking settings from
   `~/.pi/agent/settings.json` into the newly created agent config when
   available, so the agent is ready to run immediately.
3. **Local config**: writes `~/.config/piren/config.yml` with the resolved
   vault root and allowed agents, after showing you the content and asking for
   confirmation.
4. **Next commands**: prints `piren status`, `piren run`, and optional
   `piren service install gateway|telegram|discord` commands.

Bare setup does not configure provider keys, model choices, Telegram, Discord,
or services interactively. Pi owns provider/model setup; Piren service commands
own always-on transport setup.

Batch mode is unchanged for automation:

```bash
piren setup --apply --vault-root /tmp/piren-vault --agent piren
```

## Service targets

The `<target>` argument is one of:

- `gateway` - the web UI and OpenAI-compatible API.
- `telegram` - the Telegram bot transport.
- `discord` - the Discord bot transport.
- `scheduler` - the device-local scheduler loop (ADR-0029).

Telegram and Discord require their config blocks (`telegram:` / `discord:`) to
be present in `~/.config/piren/config.yml` before the service can run. See
[Transports](transports.md).

The scheduler is different from the transports: its generated command is just
`piren scheduler` with **no `--vault-root`/`--agent`** binding. The scheduler
loop reads local config (`allowed_agents` minus `excluded_agents`, plus the
`scheduler:` block) on each tick, so it is not bound to a single initial agent.
See [Scheduler](scheduler.md).

## Security notes

- Piren uses **user** systemd units, never system units. No root, no sudo.
- Service files live under your home directory, not `/etc/systemd/`.
- Transport tokens and API keys stay in `~/.config/piren/config.yml` and
  `~/.pi/agent/auth.json` respectively, never in the vault or the repository.
- The `running` status recorded in config is advisory (set at install time).
  `piren service status` checks the live state for an accurate report.

## Scheduler

The device-local scheduler (ADR-0029) is a background supervisor that
demand-starts bounded agent executions when vault work is due. The dry-run
planner, the one-shot `--once` tick, the always-on `piren scheduler` loop, and
service lifecycle integration are all shipped.

Install the scheduler as a user service just like the transports:

```bash
piren service install scheduler
piren service start scheduler
piren service status scheduler
piren service stop scheduler
piren service restart scheduler
piren service remove scheduler
```

The generated systemd unit is `piren-scheduler.service`; the tmux fallback
session is `piren-scheduler` with launch script `piren-scheduler.tmux.sh` and
cron fragment `piren-scheduler.cron`. The `ExecStart`/tmux command is
`<resolved piren command> scheduler` with no agent binding.

For the scheduler loop, local `scheduler:` config, device ownership model, and
bounded execution semantics, see [Scheduler](scheduler.md).
