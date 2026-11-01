# devbox listener (Mac)

Receives `open`, `preview`, clipboard requests and notifications from devd over Tailscale and
performs them on the Mac. Setup: [docs/mac.md](../docs/mac.md#3-listener-and-notifications).

## Install

1. `~/.config/devbox-listener/config.json`:

       { "token": "<same as listenerToken in the devd secrets>",
         "host": "<this Mac's tailnet IP>",
         "mappings": [{ "from": "/srv/dev", "to": "/Volumes/dev" }] }

   Local development (devd on the Mac): host `127.0.0.1` and mapping
   `{ "from": "<DEVD_ROOT>", "to": "<DEVD_ROOT>" }`.
2. `bun listener/install.ts` and run the printed `launchctl` commands.
3. On the server: `DEVD_LISTENER_URL=http://<mac-tailnet-ip>:7777` in devd's environment and
   `listenerToken` in the secrets.

Log: `/tmp/devbox-listener.log` · Health: `curl http://<host>:7777/health`

## SMB automount

`install.ts` also installs the LaunchAgent `cz.devbox.smbmount` (`install/mount-devbox.sh`).
It mounts `smb://root@<tailnet-ip>/dev` at `/Volumes/dev` at login, every 5 minutes and on
network changes. It needs the password in the login keychain — see
[docs/mac.md](../docs/mac.md#4-finder-mount-smb-optional). Log: `/tmp/devbox-smbmount.log`.

## Trust

The listener fully trusts whoever holds the token (devd). `open` can launch workspace content
(`.command`, `.app`), so workspaces are treated as trusted. Access is limited to the tailnet.
