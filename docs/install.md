# Server install and operations

This guide sets up devbox on a fresh VPS and covers day-2 operations: the vault, the
firewall, backups, monitoring and upgrades. For the Mac side see [mac.md](mac.md); every
setting is listed in [configuration.md](configuration.md).

## 1. Install

Start from Ubuntu 24.04 (Debian works too) and log in as root.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bohous04/devbox/main/infra/bootstrap.sh)
```

`bootstrap.sh` clones the repo to `/opt/vps-dev-infra` (`REPO_URL`, `REPO_DIR` override
that) and runs `infra/setup.sh`. Setup is idempotent — run it again whenever you change
something below. It reads these environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DEVBOX_FEATURES` | *(empty = core only)* | optional components, space separated, or `all` (see below) |
| `CONFIG_REPO` | — | git URL of a private repo holding `config.json`; without it a default config is written and you edit it in the dashboard |
| `LISTENER_URL` | — | `http://<mac-tailnet-ip>:7777` for Mac notifications and `open`; can be added later |
| `DEVD_FOLDERS` | `apps websites` | top-level folders created under `/srv/dev` |

The core is always installed: Docker, Bun, git, jq, ufw, Tailscale, the GitHub CLI, devd
(systemd unit), the dashboard and the `devbox:latest` session image. Optional components:

| Feature | What it adds |
|---|---|
| `samba` | SMB share of `/srv/dev`, reachable only over the tailnet (Finder on the Mac) |
| `cloudflared` | the Cloudflare Tunnel binary, for reaching the dashboard from outside the tailnet. You connect the tunnel yourself: `cloudflared service install <token>` and put Cloudflare Access in front of it |
| `op` | 1Password CLI. devd uses a service account to broker SSH keys to sessions |
| `cliproxy` | local proxy for subscription-backed proxy profiles; generates its own random API key |
| `auto-update` | nightly deploy of `origin/main` once CI passed on it, with a health check and automatic rollback — see [Upgrades and deploys](#upgrades-and-deploys) |
| `storage-guard` | disk and per-session storage budgets, and cleanup that only deletes what is verified in an offsite borg archive — see [`infra/storage-guard/README.md`](../infra/storage-guard/README.md) |

Example: `DEVBOX_FEATURES="samba op" bash /opt/vps-dev-infra/infra/setup.sh`.

## 2. Tailscale

```bash
tailscale up --ssh
bash /opt/vps-dev-infra/infra/setup.sh       # rebinds devd from 127.0.0.1 to the tailnet IP
```

The first setup run happens before the tailnet exists, so devd listens on loopback until
you run setup again. Once Tailscale SSH works you can close public SSH:
`ufw delete allow <port>/tcp`.

## 3. GitHub

```bash
gh auth login && gh auth setup-git
chmod 644 /root/.config/gh/hosts.yml
```

The gh config is bind-mounted read-only into every session (uid 1000), so it must be
readable. devd checks for it per session, so no restart is needed.

## 4. Secrets and the vault

devd reads credentials from `/etc/devd/secrets.json` (mode 0600). The keys are listed in
[configuration.md](configuration.md#secretsjson). Start with an empty `{}` and add what
you use.

For a long-running box, seal the file into an encrypted vault:

```bash
printf '%s\n' '<passphrase>' | bun /opt/vps-dev-infra/tools/vault-migrate.ts \
  --in /etc/devd/secrets.json --out /etc/devd/vault.age
systemctl restart devd      # then unlock in the dashboard and delete secrets.json
```

When `/etc/devd/vault.age` exists, devd ignores `secrets.json` and starts **locked**. Secrets
live only in process memory after you unlock the vault in the dashboard.

> ⚠️ **Every restart of devd (deploy, reboot) locks the vault again.** Sessions keep running,
> but everything that needs a credential stops: notifications, clipboard paste, `open` and
> `preview`, private git hosts, the SSH broker, prod-db and the Hardware tab. Check with
> `curl -s localhost:4300/api/vault` and unlock in the dashboard. Nothing else needs a
> restart after unlocking.

devd reports a locked vault itself: if it is still locked 30 s after start, the iOS app gets
a "vault locked" notification (over APNs, which does not need the vault) that opens the unlock
screen. With `phoneChannel: "pushover"` the phone stays silent, because the Pushover token is
in the vault.

A few files stay in plaintext on purpose, because they are needed while the vault is
locked:

| File | Why it is not in the vault |
|---|---|
| `/etc/devd/borg-passphrase` | the nightly backup runs unattended |
| `/etc/devd/watch.env` | the watchdog reports that devd is down, so its credentials cannot live in the vault devd holds |
| `/etc/devd/instabox/*` | InstaBox VMs are paused and resumed even while the vault is locked |
| `/etc/devd/gitea-tokens.json` | read by containers (0644, mounted read-only) |
| `/etc/devd/cliproxy/api-key` | proxy profiles must survive a restart |

## 5. First session

```bash
dev acme/web       # from the Mac, or use "New session" in the dashboard
```

Log in to `claude` (and `codex`/`grok`) once inside the first session. The login lives in
shared volumes (`claude-home`, `codex-home`, `grok-home`), so every later session reuses it.
If plugins or MCP servers were provisioned before the login, run the sync again:

```bash
cd /opt/vps-dev-infra && DEVD_CONFIG_DIR=/etc/devd/config bun tools/agent-sync.ts
```

Check everything with `dev doctor` on the Mac.

## Firewall

`setup.sh` configures ufw: deny incoming by default, allow Tailscale and SSH, and let
containers reach devd (`:4300`) and the DB proxies (`:15432`, `:15433`) by source range,
with an explicit deny on `eth0` first.

ufw does **not** protect published container ports, because Docker writes its own NAT rules.
Anything an agent starts inside a session (`docker compose up` with Postgres, Redis, a mail
catcher…) would be reachable from the internet. `docker-user-firewall.service` closes this by
inserting a DROP for new connections from `eth0` into the `DOCKER-USER` chain (IPv4 and
IPv6), and re-applies it after every docker restart. Check it:

```bash
iptables -S DOCKER-USER && ip6tables -S DOCKER-USER     # must contain a DROP on eth0
nc -z -G 5 <public-ip> <some-published-port>             # from outside: must fail
```

If your public interface is not `eth0`, adjust `infra/docker-user-firewall.sh` and the ufw
rules in `setup.sh`.

A second layer is `"ip": "<tailnet-ip>"` in `/etc/docker/daemon.json`, so that `-p` binds
to the tailnet by default. It needs a docker restart, which stops every running session.

## Backups

`infra/devbox-backup.sh` makes an encrypted borg backup of what cannot be rebuilt from git:
the `claude-home` and `codex-home` volumes (logins, plugins, conversation history),
`devd.sqlite` (statistics), `/etc/devd`, `/root/.ssh` and `/srv/dev` (uncommitted work).
Build artefacts (`node_modules`, `dist`, `.venv`, …) are excluded. Retention is 7 daily,
4 weekly, 6 monthly. borg runs on the devbox, so data leaves the machine already encrypted.

Install it by hand:

```bash
install -m 755 infra/devbox-backup.sh /usr/local/bin/devbox-backup.sh
cp infra/devbox-backup.service infra/devbox-backup.timer /etc/systemd/system/
openssl rand -hex 32 > /etc/devd/borg-passphrase && chmod 600 /etc/devd/borg-passphrase
cat >> /etc/devd/devd.env <<'EOF'
DEVBOX_BORG_REPO=ssh://user@backup.example.com:22/var/backups/devbox-borg
DEVBOX_BORG_KEY=/root/.ssh/id_ed25519_backup
EOF
borg init --encryption=repokey-blake2 "$DEVBOX_BORG_REPO"     # once, with BORG_RSH/BORG_PASSPHRASE set
systemctl daemon-reload && systemctl enable --now devbox-backup.timer
```

Keep a copy of the passphrase outside the server: with `repokey` encryption the key sits in
the repo, so the passphrase is all you need to restore. The last run's status is in
`/var/lib/devd/backup-status.json` (shown in the Hardware tab), the log in
`/var/log/devbox-backup.log`.

Restore:

```bash
export BORG_PASSPHRASE="$(cat /etc/devd/borg-passphrase)" BORG_RSH="ssh -i /root/.ssh/id_ed25519_backup"
borg list "$DEVBOX_BORG_REPO"
borg extract "$DEVBOX_BORG_REPO::devbox-<date>" var/lib/devd
```

For a quick manual copy without borg, `dev backup [file]` on the Mac downloads the
`claude-home` and `codex-home` volumes, secrets, the vault and the database, and `dev restore <file>` puts
them back.

## Storage guard (optional)

With many agents cloning repos, building images and leaving worktrees behind, a disk fills up
quietly. The `storage-guard` feature adds:

- disk checks every 5 minutes and per-session accounting every hour (workspace, writable
  layer, nested Docker storage), with warn/block thresholds in `/etc/devbox-storage/config.json`
  (`session_warn_gib`, `session_block_gib`, per-session `session_limits`);
- an in-session wrapper for `git` and `docker` that refuses new clones, worktrees and builds
  over budget (devd enables it only on hosts where the guard is installed);
- `devbox-scratch create|release` for agents to register auxiliary worktrees, and cleanup that
  deletes only released copies after they are verified in an offsite borg archive;
- a host `docker` wrapper so that ending a session first preserves its data offsite.

It needs borg and an offsite repository (`borg_repo`, `borg_key`, `borg_passfile` in the config).
Details: [`infra/storage-guard/README.md`](../infra/storage-guard/README.md).

## Monitoring (optional)

The **Hardware** tab combines three optional sources. Without them devd works normally and
the tab says it is not configured.

- **Beszel** (CPU, memory, disk history): run a Beszel agent on the box and add
  `beszel: { url, email, password }` to secrets. The agent connects out to the hub, so no
  port is opened.
- **Uptime Kuma** monitors: `uptimeKuma: { url, apiKey }`.
- **Remote machines and backup repos**: list them in `/etc/devd/hardware.json` (example:
  `infra/hardware.example.json`). Machines with `"host": "remote"` are reached with the
  `remoteSsh` secret. devd sends one script per machine per tick, so an SSH rate limit
  (`ufw limit`) on the remote side is fine.

**External watchdog.** `devd-watch` (a systemd timer every 2 minutes) checks from outside
the devd process that devd is alive. It sends Pushover alerts directly ("devd is not
responding" / "devd is back") and reports the vault state in the Kuma heartbeat. Create `/etc/devd/watch.env` (0600) and run setup
again:

```bash
PUSHOVER_TOKEN=…
PUSHOVER_USER=…
KUMA_PUSH_URL=https://kuma.example.com/api/push/<token>   # optional heartbeat
```

The heartbeat matters because an outage of *outgoing* connectivity silences every alert that
the box sends itself. Add a Kuma **Push** monitor (interval 120 s, retries 1, so a single late
beat does not alert) and a **TCP port** monitor on SSH from outside. Together they tell you
which direction is broken. Give both a notification channel that does not go through the box.

## Memory limits

One runaway session (a `next dev` server, headless Chrome) must not take the whole box down.
`setup.sh` installs `infra/oom-guard`: every session container gets a RAM cap (devd sets it,
a timer re-applies it), `earlyoom` kills the biggest offender before the kernel OOM killer
stalls the machine, and ssh, Tailscale and devd are protected from the OOM killer.

## Terminal sharing (optional)

A session's terminal can be shared read-write with a guest for a limited time, together with
previews of its dev servers. It needs a Cloudflare tunnel **without** Access pointing at
`localhost:4302` for two kinds of hostnames:

- `share.<domain>` → the guest page (`DEVD_SHARE_HOST=share.<domain>`)
- `p0.<domain>` … `p9.<domain>` → previews of container ports 3000–3009
  (`DEVD_PREVIEW_DOMAIN=<domain>`)

Shared sessions are network-restricted with iptables (turn off with `DEVD_SHARE_FIREWALL=0`).

## InstaBox overflow (optional)

devd can start sessions on rented InstaBox VMs when the VPS is full. Setup (API key, Tailscale
auth key, `settings.instabox`, base image) is described in
[`infra/instabox/README.md`](../infra/instabox/README.md).

## Upgrades and deploys

With the `auto-update` feature, `devbox-update.timer` deploys every night at 05:15 (after
the Claude Code upkeep window), and `devbox-update` runs the same thing on demand. It:

- deploys **only `origin/main`**, and only once every CI check on that commit succeeded;
- refuses a checkout with local changes, another branch checked out or diverged history
  (it notifies instead), so the server never runs something that is not on main;
- rebuilds only what changed (dependencies, dashboard, session image — the previous image is
  kept as `devbox:previous`) and restarts devd only when devd itself changed;
- after a restart requires `/api/health` to report the new commit, otherwise rolls back to
  the previous commit and restarts again;
- reports changes under `infra/` (units, setup.sh) instead of applying them, and records the
  deployed commit in `/var/lib/devd/deployed.json`.

A restart locks the vault; the update notifies through Pushover (`/etc/devd/watch.env`) so
you know to unlock it.

Without `auto-update`, deploy by hand:

```bash
cd /opt/vps-dev-infra && git pull
docker build -t devbox:latest image/        # when image/ changed
bun install && bun run build:dashboard      # when dashboard/ changed
systemctl restart devd                      # then unlock the vault
```

Running containers keep their old image layer. Files baked into the image (hooks, shims)
reach running sessions only after a session is recreated (`dev end` + `dev <repo>`). Hook
configuration lives in the shared `claude-home` volume and is picked up live.

Automatic upkeep:

- **Claude Code** (`settings.ccUpkeep`, default 03:00–05:00): once a day devd checks for a
  new `@anthropic-ai/claude-code`, rebuilds the image with `--build-arg CC_VERSION=…`,
  installs it into idle containers, and restarts stale panes with `/exit` +
  `cc --resume <id>` so conversations continue. Only a failed build sends a notification.
  Disable it with `{ "ccUpkeep": { "enabled": false } }` in `config.json`.
- **Codex and Grok**: the `co` and `gr` launchers check for a stable release at most once
  an hour per container, with a 45 s limit. A failed update starts the installed version.
  Disable it for one run with `DEVD_AGENT_AUTO_UPDATE=0 co`.
- **Session image pinning**: setup keeps a tiny `devbox-image-keeper` container running, so
  that `docker image prune -a` (for example from Coolify) does not delete `devbox:latest`.

## Rebuilding a server

1. Reinstall the OS and run section 1 with the same `DEVBOX_FEATURES`, `CONFIG_REPO` and
   `LISTENER_URL`.
2. Restore `/etc/devd` (vault, `devd.env`, `hardware.json`, …) from borg, or upload a
   `dev backup` file with `dev restore`.
3. Tailscale, `gh auth login`, unlock the vault, `dev doctor`.

Rehearse this before you depend on it: `bash infra/rehearsal.sh --container` is a quick
smoke test (devd starts and answers `/api/health`). For a full run, point `bootstrap.sh` at
a throwaway VM.
