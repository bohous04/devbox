# InstaBox overflow — runbook

InstaBox: a cloud VM as an overflow host for devbox sessions (via `/api/sessions` with `host:
"instabox"`), plus a desktop for the agent's browser. A session on InstaBox runs on
a single third-party cloud machine (not on the VPS), but the VPS must reach it over Tailscale for
hooks, OTel and the git proxy.

## 1. InstaBox API key

In the InstaBox dashboard, create an API key with the scopes `machines` + `images` (read/write/delete).

On the VPS, as root (the file is created directly with mode 0600, readable only by root):

```bash
install -m 600 /dev/stdin /etc/devd/instabox/api-key
# paste the key, Ctrl-D
```

The path can be overridden with the env `DEVD_INSTABOX_KEY_FILE` (devd/src/index.ts, default
`/etc/devd/instabox/api-key`).

## 2. Tailscale auth key

Create a reusable, ephemeral Tailscale auth key with the tag `tag:devbox-instabox` — **only**
with this tag (tag-only, no user identity) and with the shortest expiry you
are willing to rotate (e.g. 7–30 days; after expiry, create/resume fails at the
"Joining tailnet" step with a clear error). On the VPS, again as root, the same way (0600):

```bash
install -m 600 /dev/stdin /etc/devd/instabox/tailscale-auth-key
# paste the key, Ctrl-D
```

The path can be overridden with the env `DEVD_INSTABOX_TS_KEY_FILE` (default
`/etc/devd/instabox/tailscale-auth-key`).

ACL snippet (replace `<vps-tailscale-host>` with the actual name/IP of the VPS in the tailnet):

```json
{ "tagOwners": { "tag:devbox-instabox": ["autogroup:admin"] },
  "acls": [ { "action": "accept", "src": ["tag:devbox-instabox"], "dst": ["<vps-tailscale-host>:4301"] } ] }
```

**Port 4301, not 4300.** The VM talks to devd only through a separate VM listener
(`DEVD_VM_PORT` / `settings.instabox.vmPort`, default 4301, `devd/src/vmListener.ts`),
which lets through only hooks (`/api/agent-event`), OTel (`/v1/metrics`), the git proxy (`/git/…`),
`/api/health` and `/api/accounts/lease` — everything else is a 404. The main port 4300 (dashboard,
approval of prod-db writes, operations and SSH grants) must not be reachable from the tag
`tag:devbox-instabox`: the tailnet (100.64.0.0/10) is in the allowlist of the approval gates.

If the ACL policy uses `grants` instead of `acls`, convert this snippet into an equivalent
grant with the same meaning. No other traffic may go from the tag `tag:devbox-instabox` to the rest of the tailnet
— this rule is the substitute for the missing authentication on
`/api/agent-event` (otherwise the VM could call any endpoint on the VPS, even outside devd).

A second layer independent of the ACL: on `tailscale up` of every machine, devd records its
tailnet IPv4 (`tailscale ip -4`, column `sessions.instabox_ts_ip`) and the approval gates
let nothing through from such an address, even if the ACL broke. devd keeps the addresses of ended sessions
in memory until restart; it forgets them only for machines that reconcile reports as lost.

ufw: `infra/setup.sh` allows 4301 only on `tailscale0` (deny from `eth0`).

### Residual risk of the auth key

The key is reusable (minting a key per machine would require a Tailscale API token — outside
v1). During `tailscale up` the VM receives it in an env variable; anything running as root in the VM
(the agent has `sudo -n`) can read it at that moment and join another
device with the tag `tag:devbox-instabox` to the tailnet. Thanks to the ACL, however, such a device reaches only
VPS:4301 (the allowlist above), not approvals nor the rest of the tailnet. Hence: a tag-only
key, short expiry, rotation on suspicion. devd never writes the key into job errors or
into the log (the value is scrubbed from the error text).

## 3. devd config

In `config.json` (the one devd reads on the VPS):

```json
{ "settings": { "instabox": { "devdUrl": "http://<vps-tailnet-ip>:4300" } } }
```

`<vps-tailnet-ip>` is the Tailscale IP of the VPS — the same value as `devdUrl` in
`~/.config/devbox-cli/config.json` on the mac. Containers in the VM get `DEVD_URL`,
the OTel endpoint and the git proxy on the **same host with the VM listener port** (`vmPort`, default
4301; overridden by env `DEVD_VM_PORT`), not on 4300. After editing, restart devd
(`systemctl restart devd`).

After a devd restart you need to **unlock the vault** — for InstaBox itself this is not necessary
(the InstaBox keys live outside the vault, see below), but the rest of devd (other VPS sessions,
proxy profiles, …) does not come up without an unlocked vault.

## 4. Keys outside the vault (why)

The InstaBox API key and the Tailscale auth key are in files
(`/etc/devd/instabox/api-key`, `/etc/devd/instabox/tailscale-auth-key`, both 0600),
**not** in `/etc/devd/secrets.json` nor in the vault. devd reads them from disk on every
call. Reason: pause/resume of an InstaBox session must work even with a locked vault,
otherwise waking/pausing a machine after a restart or reboot would require a
manual unlock before anything on InstaBox could be managed.

## 5. Base image

Dashboard → Sessions → InstaBox panel → "Rebuild base", or from the mac:

```bash
dev instabox rebuild-base
```

It takes roughly 10–20 minutes — the image (≈5.8 GB) is transferred via
`docker save | docker -H ssh://… load`. After every rebuild of the local `devbox:latest`
image (on the VPS), the dashboard shows the message "base is out of date" for InstaBox until the base
goes through a rebuild again.

Order when updating the image: first rebuild the image on the VPS (`image/Dockerfile` + the new
`playwright-mcp-devbox` wrapper) and re-run `agent-sync`, only then `dev instabox
rebuild-base` — the Playwright MCP command has a fallback for the old image, so this order
is safe even if the base temporarily stays old.

## 6. What an InstaBox session cannot do in v1

- critic
- prod-db
- "Open in Finder"
- file inbox from the clipboard
- preview ports
- `solo` (`claudeSolo`) — the API returns 400
- proxy agents (`claude-gpt`, `claude-grok`, `claude-gemini`, `claude-openrouter`) —
  proxy profiles go through CLIProxyAPI on the VPS and are not reachable from the VM in v1
- scheduled runs (scheduler) — those always go to the VPS
- recreate — the API returns 409
- reopening a VPS session on InstaBox

A pool account added to config.json **after** the session was created is not mounted into its running
container (the credentials themselves, however, keep syncing into all
volumes the container has). For a new account, end the session (`dev end <id>`) and create it again.

## 7. Cleanup

Orphaned machines (a devbox machine without a session, typically after devd crashed in the middle of create/end) are
deleted in the dashboard, InstaBox panel.

```bash
dev instabox status
```

prints account usage (`usage().machines` / `maxMachines` — **all** machines of the account,
including foreign ones such as `<other-machine>`, not just `devbox=1`), the base image state, orphaned machines and lost
sessions (a session in the DB whose machine no longer exists). End a lost session:

```bash
dev end <id>
```

## 8. Troubleshooting

```bash
# does cert/SSH to the session's machine work?
ssh ibx-<machine id> true

# docker on the machine via the resolver (CLI attach takes the same path)
docker -H ssh://ibx-<machine id> ps

# devd logs for InstaBox
journalctl -u devd | grep instabox
```

If `ssh ibx-<m>` fails: check `/var/lib/devd/instabox/hosts/<m>.conf` (the host
block), `/var/lib/devd/instabox/<m>-cert.pub` (the certificate, TTL 86400 s, renewed when
less than 2 h remain) and that `/etc/ssh/ssh_config.d/devd-instabox.conf` with
`Include /var/lib/devd/instabox/hosts/*.conf` exists (ensured by
`prepare_instabox_dirs` in `infra/setup.sh`).

A paused session has no alias in the resolver (only `running`) — SSH via the InstaBox gateway
would needlessly wake the machine.

## Smoke test

Manual E2E against the real InstaBox: [`smoke.sh`](./smoke.sh). It is run from the mac
with `dev` installed and tailnet access.
