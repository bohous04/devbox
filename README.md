# devbox

A self-hosted remote development environment for AI coding agents. Claude Code, Codex
and Grok run in disposable Docker containers on your own VPS. You drive them from a Mac
(CLI, notifications, Finder mount), from a web dashboard, or from your phone.

> **Status:** devbox started as one person's daily setup and is opinionated: Ubuntu VPS,
> Tailscale, macOS client, Warp terminal. It works and is used every day, but expect sharp
> edges. Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## What it does

- **Sessions in containers.** `dev acme/web` starts (or attaches to) a container with the
  repo checked out in its own git worktree, the agent running in tmux, and its own port
  range. Several sessions can work on the same repo in parallel.
- **Multiple agents.** Claude Code, Codex CLI and Grok Build, plus proxy profiles that run
  Claude Code against other models.
- **Notifications that matter.** Hooks report when an agent is blocked on a question, needs
  a permission, finishes, or gets stuck. They arrive on the Mac (click → focuses the Warp
  tab) and on the phone (Pushover or the iOS app).
- **Dashboard.** Sessions with a live web terminal, usage statistics, schedules (cron
  prompts), unpushed work, approvals, settings and host health.
- **Secrets stay on the host.** An encrypted vault unlocked in the dashboard. SSH keys are
  brokered through a per-session ssh-agent socket after a human approves (`srv`). Production
  database access goes through a host proxy with separate write approval.
- **Mac integration.** `open` and `preview` inside a container open files and dev servers
  on your Mac; clipboard images paste into the agent; the workspace is mounted in Finder
  over SMB.
- **Sharing and overflow.** Share a live terminal and its dev-server previews with a guest for
  a limited time; spill sessions over to rented InstaBox VMs when the VPS is full.
- **Upkeep.** Nightly Claude Code updates with safe pane restarts, agent auto-updates,
  memory limits per session, borg backups and an external watchdog.

## Architecture

```
 Mac (or phone)                              VPS (Ubuntu)
 ┌──────────────────────┐   Tailscale   ┌──────────────────────────────────────────┐
 │ dev CLI ─────────────┼──────────────►│ devd  (Bun, systemd, :4300)              │
 │ listener (:7777) ◄───┼───────────────┤  ├─ REST + WebSocket API, SQLite         │
 │  notifications, open │               │  ├─ dashboard (React, served by devd)    │
 │ Finder ◄── SMB ──────┼───────────────┤  ├─ vault, SSH key broker, DB proxy      │
 │ browser ─ dashboard ─┼──────────────►│  └─ scheduler, upkeep, notifications     │
 └──────────────────────┘               │                                          │
                                        │ Docker: one container per session        │
                                        │  devbox image: claude · codex · grok     │
                                        │  tmux, hooks → devd, shims (srv, open…)  │
                                        └──────────────────────────────────────────┘
```

| Directory | What | Runs on |
|---|---|---|
| `devd/` | control plane: sessions, containers, config, notifications, brokers | VPS (systemd `devd`) |
| `dashboard/` | web UI, served by devd | browser |
| `image/` | Docker image for sessions (agents, MCP, Playwright, hooks, shims) | VPS |
| `infra/` | `bootstrap.sh`, `setup.sh`, systemd units, firewall, backup | VPS |
| `cli/` | the `dev` command | Mac |
| `listener/` | Mac agent: open, notifications, notifier app, SMB automount | Mac |
| `ios/` | iOS app: sessions, approvals, Live Activities | iPhone |
| `tools/` | agent-sync (plugins/MCP into sessions) and maintenance scripts | VPS / Mac |
| `shared/` | types shared between devd and the dashboard | — |

## Requirements

- A VPS with Ubuntu 24.04 (Debian works too). Plan on 4+ vCPU and 8+ GB RAM if you run
  several sessions at once.
- A [Tailscale](https://tailscale.com) tailnet. devd and the dashboard are only reachable
  over it.
- A Mac for the CLI and listener. The dashboard works from any browser on the tailnet.
- Accounts for the agents you want to use (Claude, ChatGPT/Codex, Grok).

Optional: Cloudflare Tunnel + Access (dashboard from outside the tailnet), a 1Password
service account (SSH key broker), Pushover (phone alerts), Beszel/Uptime Kuma (host
monitoring), borg target (backups).

## Quickstart

On a fresh VPS, as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bohous04/devbox/main/infra/bootstrap.sh)
tailscale up --ssh
bash /opt/vps-dev-infra/infra/setup.sh      # second run binds devd to the tailnet IP
gh auth login && gh auth setup-git
```

Optional components are opt-in, e.g. `DEVBOX_FEATURES="samba op" bash …/setup.sh`.

On the Mac:

```bash
git clone https://github.com/bohous04/devbox ~/devbox && cd ~/devbox && bun install
ln -s "$PWD/cli/src/main.ts" ~/.local/bin/dev
mkdir -p ~/.config/devbox-cli
echo '{ "devdUrl": "http://<vps-tailnet-ip>:4300", "sshHost": "<vps-ssh-host>" }' > ~/.config/devbox-cli/config.json
dev doctor
dev acme/web          # start a session
```

Full guides:

- [docs/install.md](docs/install.md) — server install, vault, firewall, backups, monitoring, upgrades
- [docs/mac.md](docs/mac.md) — Mac client: CLI, listener, notifications, SMB, Warp
- [docs/configuration.md](docs/configuration.md) — environment variables, files, `secrets.json`, `config.json`
- [SECURITY.md](SECURITY.md) — threat model; **read before giving agents real credentials**

## A note on the account pool

devd can rotate several Claude and Codex subscriptions per session (see
`docs/account-pool.md`). Spreading usage across multiple consumer subscriptions may break
the providers' terms of service and can get accounts suspended. The feature does nothing
until you add accounts. You are responsible for how you use it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

Copyright 2026 LNRT. [Apache License 2.0](LICENSE), see also [NOTICE](NOTICE). Third-party parts:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

devbox is an independent project and is not affiliated with Anthropic, OpenAI, xAI,
Tailscale or Warp.
