<p align="center">
  <img src="docs/assets/logo.svg" width="96" height="96" alt="devbox logo">
</p>

<h1 align="center">devbox</h1>

<p align="center">
  <b>Your own remote dev environment for AI coding agents.</b><br>
  Claude Code, Codex and Grok in disposable containers on your VPS —<br>
  driven from your Mac, a web dashboard or your iPhone.
</p>

<p align="center">
  <a href="https://github.com/bohous04/devbox/actions/workflows/ci.yml"><img src="https://github.com/bohous04/devbox/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black" alt="Bun">
  <img src="https://img.shields.io/badge/server-Ubuntu-E95420?logo=ubuntu&logoColor=white" alt="Ubuntu">
  <img src="https://img.shields.io/badge/client-macOS%20%C2%B7%20iOS-000?logo=apple" alt="macOS and iOS">
</p>

<p align="center">
  <img src="docs/assets/dashboard-sessions.png" width="860" alt="devbox dashboard: sessions running Claude Code, Codex and Grok">
</p>

> **Status:** devbox started as one person's daily setup and is opinionated: Ubuntu VPS,
> Tailscale, macOS client, Warp terminal. It works and is used every day, but expect sharp
> edges. Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Why

Coding agents are best when they can run for hours: long refactors, test loops, a dozen
tasks in parallel. Your laptop is the wrong place for that — it sleeps, it overheats, and
every agent fights over the same checkout. devbox moves the agents to a server you own and
keeps you in the loop from wherever you are.

## A session in one command

`dev acme/web` gives the agent its own container, its own git worktree and branch, and a
port range for dev servers — then drops you into its tmux. Close the lid; it keeps going.

<p align="center">
  <img src="docs/assets/cli-open.gif" width="760" alt="dev acme/web opens a new session with a progress bar">
</p>

<p align="center">
  <img src="docs/assets/cli-ls.gif" width="760" alt="dev ls lists running sessions">
</p>

## What it does

- **Sessions in containers.** One Docker container per session with the repo checked out in
  its own git worktree, the agent in tmux and a private Docker daemon (dind). Several
  sessions can work on the same repo in parallel.
- **Multiple agents.** Claude Code, Codex CLI and Grok Build, plus proxy profiles that run
  Claude Code against other models. Switch a running session to another agent or account.
- **Notifications that matter.** Hooks report when an agent is blocked on a question, needs
  a permission, finishes, or gets stuck. They arrive on the Mac (click → focuses the Warp
  tab) and on the phone (Pushover or the iOS app with a Live Activity).
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
- **Upkeep.** Nightly agent updates with safe pane restarts that resume the same
  conversation, auto-deploys of `main` after CI, memory limits per session, offsite-verified
  storage cleanup, borg backups and an external watchdog.

## Dashboard

<table>
  <tr>
    <td width="50%"><img src="docs/assets/dashboard-terminal.png" alt="Live web terminal of a session"><br><sub><b>Live terminal</b> — watch or take over any session from the browser.</sub></td>
    <td width="50%"><img src="docs/assets/dashboard-overview.png" alt="Overview with plan usage per account"><br><sub><b>Overview</b> — today's work and plan usage per account.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/dashboard-stats.png" alt="Usage statistics over 30 days"><br><sub><b>Statistics</b> — cost, tokens and active time per project.</sub></td>
    <td><img src="docs/assets/dashboard-ssh-approvals.png" alt="SSH key approval request"><br><sub><b>Approvals</b> — an agent asks for an SSH key; you approve, scoped and time-limited.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/dashboard-prod-writes.png" alt="Pending production database write"><br><sub><b>Production writes</b> — SQL against production runs only after a human says yes.</sub></td>
    <td><img src="docs/assets/dashboard-hardware.png" alt="Host health and hardware"><br><sub><b>Host health</b> — machines, storage and resource history.</sub></td>
  </tr>
</table>

## On your phone

The iOS app shows every session, lets you answer approvals, and keeps a Live Activity on
the Lock Screen and in the Dynamic Island with what is waiting for you.

<p align="center">
  <img src="docs/assets/ios-overview.png" width="200" alt="iOS app: overview">
  <img src="docs/assets/ios-sessions.png" width="200" alt="iOS app: sessions">
  <img src="docs/assets/ios-ssh-approval.png" width="200" alt="iOS app: SSH key approval">
  <img src="docs/assets/ios-prod-writes.png" width="200" alt="iOS app: production write approval">
</p>

<p align="center">
  <img src="docs/assets/ios-live-activity.png" width="480" alt="Live Activity on the Lock Screen: 1 waiting, 2 working, 1 done">
</p>

## Architecture

```mermaid
flowchart LR
  subgraph you["You"]
    cli["dev CLI<br/>(Mac)"]
    listener["listener<br/>notifications · open · clipboard"]
    browser["dashboard<br/>(any browser)"]
    phone["iOS app<br/>Live Activity"]
  end

  subgraph vps["Your VPS (Ubuntu)"]
    devd["devd<br/>Bun · REST + WebSocket · SQLite"]
    vault[("vault · SSH broker<br/>prod-DB proxy")]
    subgraph sessions["one container per session"]
      s1["claude · codex · grok<br/>tmux · own worktree"]
      d1["dind sidecar"]
    end
  end

  cli -- "Tailscale" --> devd
  browser -- "Tailscale" --> devd
  phone -- "Tailscale / CF Access" --> devd
  devd -- "notifications" --> listener
  devd --- vault
  devd -- "docker" --> sessions
  s1 -- "hooks" --> devd
  s1 --- d1
```

| Directory | What | Runs on |
|---|---|---|
| `devd/` | control plane: sessions, containers, config, notifications, brokers | VPS (systemd `devd`) |
| `dashboard/` | web UI, served by devd | browser |
| `image/` | Docker image for sessions (agents, MCP, Playwright, hooks, shims) | VPS |
| `infra/` | `bootstrap.sh`, `setup.sh`, systemd units, firewall, backup, auto-update | VPS |
| `cli/` | the `dev` command | Mac |
| `listener/` | Mac agent: open, notifications, notifier app, SMB automount | Mac |
| `ios/` | iOS app: sessions, approvals, Live Activities | iPhone |
| `tools/` | agent-sync, maintenance scripts, and the [demo devd](tools/demo/) behind these screenshots | VPS / Mac |
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
- [docs/browser.md](docs/browser.md) — Windows/Linux browser: terminal, Claude login, text/images/files and clipboard
- [docs/ios.md](docs/ios.md) — building the iOS app, connecting it, push and Live Activities
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
