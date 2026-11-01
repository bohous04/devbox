# Configuration reference

devd is configured in four places:

| Where | What | Edited by |
|---|---|---|
| environment (`devd.service`, `/etc/devd/devd.env`) | paths, ports, install-specific values | you, then `systemctl daemon-reload && systemctl restart devd` |
| `/etc/devd/config/config.json` | folders, projects, repos, settings | the dashboard (or a git repo, see `CONFIG_REPO`) |
| `/etc/devd/secrets.json` or the vault | credentials | you (vault: `tools/vault-migrate.ts`) |
| `/etc/devd/hardware.json` | machines and backup repos for the Hardware tab | you |

`/etc/devd/devd.env` is optional and is read by `devd.service` and `devbox-backup.service`.
Template: [`infra/devd.env.example`](../infra/devd.env.example).

## Environment variables

### Core

| Variable | Default | Meaning |
|---|---|---|
| `DEVD_HOST` / `DEVD_PORT` | `127.0.0.1` / `4300` | listen address (the unit sets `0.0.0.0`; ufw limits access) |
| `DEVD_BIND_IP` | — | tailnet IP that session ports and previews bind to (set by `setup.sh`) |
| `DEVD_ROOT` | `/srv/dev` | workspace root, `<folder>/<project>/<repo>` |
| `DEVD_CONFIG_DIR` | `/etc/devd/config` | directory with `config.json` |
| `DEVD_SECRETS` | `/etc/devd/secrets.json` | plaintext secrets (ignored when the vault exists) |
| `DEVD_VAULT` | — | path of the encrypted vault, e.g. `/etc/devd/vault.age` |
| `DEVD_DB` | `/var/lib/devd/devd.sqlite` | database (events, stats, schedules, approvals) |
| `DEVD_IMAGE` | `devbox:latest` | session image |
| `DEVD_DIND` | off | `1` = every session gets its own Docker-in-Docker sidecar and network instead of the host socket |
| `DEVD_URL` | `http://host.docker.internal:4300` | how containers reach devd |
| `DEVD_CONTROL_ROOT` | `/var/lib/devd/sessions` | per-session control files |
| `DEVD_DASHBOARD_DIR` | `dashboard/dist` | built dashboard |
| `DEVD_DISK_TOTAL` | `2000000000000` | disk size used for the disk usage warning |
| `DEVD_END_SYNC_WAIT_MS` | `20000` | how long ending a session waits for its final sync |
| `DEVD_SLOW_WARN_MS` | `5000` | log a warning for subprocesses slower than this |

### Install-specific (`devd.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DEVD_DASHBOARD_URL` | — | public dashboard URL for links in notifications; without it notifications carry no link |
| `DEVD_TZ` | host timezone | timezone of session containers |
| `DEVD_HARDWARE` | `/etc/devd/hardware.json` | machine registry for the Hardware tab |
| `DEVD_RESTART_PROJECTS` | — | comma-separated projects whose app agents may restart (`restart-app`); empty = never |
| `DEVD_SHARE_HOST` | `share.example.com` (placeholder) | public host of the terminal-sharing page, behind a Cloudflare tunnel without Access |
| `DEVD_PREVIEW_DOMAIN` | `example.com` (placeholder) | previews of a shared session are served at `p0…p9.<domain>`; the sharing page must live at `share.<domain>` |
| `DEVD_EGRESS_IP` | — | public IPv4 of the host; needed when prod-db onboarding creates DB accounts bound to it |
| `DEVBOX_BORG_REPO` | — | borg repo for `devbox-backup.sh` (required by the backup) |
| `DEVBOX_BORG_KEY` | `/root/.ssh/id_ed25519_backup` | SSH key for the borg repo |
| `DEVBOX_BORG_PASSFILE` | `/etc/devd/borg-passphrase` | borg passphrase file |
| `DEVBOX_BORG_REMOTE_PATH` | — | borg binary on the remote side (e.g. `borg-1.4` on a Hetzner Storage Box) |

### Integrations

| Variable | Default | Meaning |
|---|---|---|
| `DEVD_LISTENER_URL` | — | Mac listener, `http://<mac-tailnet-ip>:7777`; empty disables Mac notifications and `open` |
| `DEVD_GH_CONFIG_DIR` | `/root/.config/gh` | gh config mounted read-only into sessions |
| `DEVD_GITEA_TOKENS` | `/etc/devd/gitea-tokens.json` | Gitea tokens materialized for containers |
| `DEVD_TOOLS_DIR` | `/opt/devbox-tools` | host directory mounted read-only into every session at `/opt/devbox-tools` (private MCP servers, helper scripts); only if it exists when devd starts |
| `DEVD_AGENT_SECRETS` | `/etc/devd/agent-secrets.json` | MCP server definitions with secrets, synced into sessions |
| `DEVD_CLIPROXY_KEY_FILE` | `/etc/devd/cliproxy/api-key` | API key of the local cliproxy |
| `DEVD_OPENROUTER_KEY_FILE` | `/etc/devd/openrouter/api-key` | OpenRouter key for proxy profiles |
| `DEVBOX_MCP_ONLY_PLUGINS` | — | (Mac, `tools/generate-claude-setup.ts`) comma-separated plugins that provide MCP servers on the Mac but must not be installed in containers |

### Terminal sharing and InstaBox

| Variable | Default | Meaning |
|---|---|---|
| `DEVD_SHARE_PORT` | `4302` | loopback port of the sharing listener (cloudflared points here) |
| `DEVD_SHARE_STATIC_DIR` | `dashboard/dist/share` | built guest page (`vite build --mode share`) |
| `DEVD_SHARE_FIREWALL` | on | `0` disables the network restriction of shared sessions (Linux iptables) |
| `DEVD_VM_PORT` | from `settings.instabox` (4301) | devd listener for InstaBox VMs (tailnet only) |
| `DEVD_INSTABOX_KEY_FILE` | `/etc/devd/instabox/api-key` | InstaBox API key (outside the vault on purpose) |
| `DEVD_INSTABOX_TS_KEY_FILE` | `/etc/devd/instabox/tailscale-auth-key` | Tailscale auth key for InstaBox VMs |

### Security

| Variable | Default | Meaning |
|---|---|---|
| `DEVD_SSH_APPROVAL` | `on` | `off` disables the SSH approval gate (break-glass; the UI shows a banner) |
| `DEVD_APPROVAL_ALLOW` | — | extra comma-separated addresses/CIDRs allowed to approve, besides loopback and the tailnet |
| `DEVD_DASHBOARD_ORIGINS` | — | extra browser origins allowed to change data through the API (CSRF guard). `localhost:4300`, the origin of `DEVD_DASHBOARD_URL` and `http://<DEVD_BIND_IP>:<DEVD_PORT>` are always allowed |

### Production databases

| Variable | Default | Meaning |
|---|---|---|
| `PROD_DB_CATALOG` | `/srv/prod-db/catalog.json` | database catalog (servers, databases, 1Password items) |
| `PROD_DB_ACCESS` | `access.json` next to the catalog | which session may read/write which database |
| `DEVD_DB_PROXY_PORT` | off | port of the Postgres proxy for sessions (e.g. `15432`); unset = prod-db disabled |
| `DEVD_MYSQL_PROXY_PORT` | proxy port + 1 | MariaDB/MySQL proxy |
| `DEVD_DB_PROXY_BIND` | `172.17.0.1` | address the DB proxies bind to |

### Setup (`setup.sh` / `bootstrap.sh`)

`DEVBOX_FEATURES`, `CONFIG_REPO`, `LISTENER_URL`, `DEVD_FOLDERS`, `REPO_URL`, `REPO_DIR` —
see [install.md](install.md#1-install).

## secrets.json

All keys are optional; features without credentials turn themselves off.

```jsonc
{
  "listenerToken": "…",                         // shared with the Mac listener
  "pushover": { "token": "…", "user": "…" },    // phone notifications
  "giteaTokens": { "<instance name>": "…" },    // private Gitea hosts (see giteaInstances)
  "opServiceAccountToken": "…",                 // 1Password service account for the SSH broker
  "mcpServers": { "<name>": { … } },            // MCP servers provisioned into sessions
  "coolify": { "url": "…", "token": "…", "apps": { "<project>": "<app uuid>" } },
  "beszel": { "url": "…", "email": "…", "password": "…" },
  "uptimeKuma": { "url": "…", "apiKey": "…" },
  "remoteSsh": { "host": "…", "port": 22, "user": "root", "key": "/root/.ssh/id_ed25519" }
}
```

## config.json

```jsonc
{
  "version": 1,
  "settings": {
    "autoStopHours": 4,            // stop idle containers after N hours
    "portRangeStart": 40100,       // first published port
    "portsPerSession": 5,
    "diskWarnPercent": 80,
    "ccUpkeep": { "enabled": true, "windowStartHour": 3, "windowEndHour": 5 },
    "critic": { … },               // optional reviewer agent on Stop
    "accountPool": { … },          // see docs/account-pool.md
    "phoneChannel": "pushover"     // or "apns" for the iOS app
  },
  "folders": {
    "apps": {
      "sources": [{ "provider": "github", "org": "acme", "visibility": "private" }],
      "repos": [{ "name": "web", "provider": "github", "repo": "acme/web" }]
    },
    "clients": {
      "projects": { "shop": { "repos": [{ "name": "cms", "provider": "gitea", "repo": "alice/cms" }] } }
    }
  },
  "giteaInstances": [{ "name": "my-gitea", "url": "https://git.example.com/" }]
}
```

A folder holds repos directly or projects with repos. `sources` let the dashboard offer every
repo of a GitHub org/user or a Gitea instance. Sessions are addressed as `<project>/<repo>`.

## hardware.json

A list of machines for the Hardware tab. Without the file only the local machine is shown,
without a backup. Example: [`infra/hardware.example.json`](../infra/hardware.example.json).

| Field | Meaning |
|---|---|
| `id`, `label` | identifier and display name |
| `beszelName` | system name in Beszel, or `null` |
| `host` | `local` (the devd machine) or `remote` (over SSH with the `remoteSsh` secret) |
| `backup.repo`, `backup.passFile`, `backup.rsh`, `backup.remotePath` | borg repo to report on, run on `host` |
| `backup.unit`, `backup.statusFile` | systemd unit of the backup and its optional status file |
| `backup.pull` | copy-paste commands shown in the dashboard for fetching the repo |
| `backup.quotaBytes` | quota of the storage the repo lives on; shown as the storage gauge (one machine) |

All commands for one machine run on one host in one SSH connection per refresh.
