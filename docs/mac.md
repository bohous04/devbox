# Mac client

The Mac side has three parts: the `dev` CLI, the **listener** (runs `open`, `preview` and
notifications coming from devd), and optional extras: a Finder mount over SMB, clipboard
paste and Warp integration. The server must already be running ([install.md](install.md)).

## 1. Prerequisites

```sh
brew install bun gh jq
brew install --cask tailscale
xcode-select --install        # swiftc builds the notifier app; without it notifications fall back to osascript
brew install --cask warp      # optional: notification click focuses the right Warp tab
```

Log in to Tailscale with the same tailnet as the server and check that it is online:
`tailscale status`.

## 2. The `dev` CLI

```sh
git clone https://github.com/bohous04/devbox ~/devbox && cd ~/devbox && bun install
mkdir -p ~/.local/bin && ln -s "$PWD/cli/src/main.ts" ~/.local/bin/dev    # ~/.local/bin must be on PATH
mkdir -p ~/.config/devbox-cli
cat > ~/.config/devbox-cli/config.json <<'EOF'
{ "devdUrl": "http://<vps-tailnet-ip>:4300", "sshHost": "<vps-ssh-host>" }
EOF
```

`sshHost` is an entry from `~/.ssh/config`. Attaching to a session goes over SSH + `docker
exec` + tmux. Without `sshHost` the CLI runs in local mode (`docker exec` on this machine).
Over the tailnet, Tailscale SSH works without a key (`ssh root@<vps-tailnet-ip>`).

Zsh completions:

```sh
fpath=(~/devbox/cli/completions $fpath)
autoload -Uz compinit && compinit
```

Common commands (`dev --help` lists all of them):

| Command | What it does |
|---|---|
| `dev` | pick a running session (preview, attach, stop) or start a new one |
| `dev <project>/<repo>` | attach to a running session, or start another one on the same repo |
| `dev --agent codex <target>` | start with a given agent (`claude`, `claude-gpt`, `claude-grok`, `codex`, `grok`) |
| `dev ls` / `dev ports [target]` | overview / port mapping |
| `dev stop <target>` / `dev end <target>` | stop the container / end the session |
| `dev important <target> on` | loud phone alert for this session |
| `dev switch <target>` | move the session to a fresher account and resume the same conversation |
| `dev doctor` | check the whole setup |
| `dev backup [file]` / `dev restore <file>` | download / restore volumes, secrets and the database |

## 3. Listener and notifications

The listener is a small HTTP server on the Mac. It is reachable only over the tailnet and
authenticated with a shared token.

1. Generate a token and put it in the server secrets as `listenerToken`
   (`/etc/devd/secrets.json`, or the vault).
2. Write the listener config (`host` is **this Mac's** tailnet IP):

   ```sh
   mkdir -p ~/.config/devbox-listener
   cat > ~/.config/devbox-listener/config.json <<EOF
   { "token": "<listenerToken>", "host": "$(tailscale ip -4)",
     "dashboardUrl": "https://dev.example.com",
     "mappings": [{ "from": "/srv/dev", "to": "/Volumes/dev" }] }
   EOF
   chmod 600 ~/.config/devbox-listener/config.json
   ```

   `mappings` translate server paths to the SMB mount, so `open <file>` in a container opens
   the right file on the Mac. `dashboardUrl` is optional and is used for links in
   notifications.
3. Install and load the LaunchAgents. This also builds and authorizes
   `~/Applications/Devbox Notifier.app`:

   ```sh
   bun listener/install.ts
   launchctl load ~/Library/LaunchAgents/cz.devbox.listener.plist
   ```

4. Point devd at the listener: set `LISTENER_URL=http://<mac-tailnet-ip>:7777` and re-run
   `setup.sh`, or edit `DEVD_LISTENER_URL` in `/etc/systemd/system/devd.service`, then
   `systemctl daemon-reload && systemctl restart devd`. `daemon-reload` is required — a plain
   restart keeps the old environment. When the Mac's tailnet IP changes, repeat this step.

Check: `curl http://$(tailscale ip -4):7777/health`. Log: `/tmp/devbox-listener.log`.

The listener trusts whoever holds the token, i.e. devd. `open` can launch workspace content
(`.command`, `.app`), so treat workspaces as trusted code.

## 4. Finder mount (SMB, optional)

Needs the `samba` feature on the server and `smbpasswd -a root` there. Store the password in
the login keychain under the server's **IP**. NetAuthAgent does not match a hostname, and
would prompt every time:

```sh
security add-internet-password -a root -s <vps-tailnet-ip> -r "smb " -l "devbox SMB" \
  -D "network password" -w '<smb-password>' -T /System/Library/CoreServices/NetAuthAgent.app -U
launchctl load ~/Library/LaunchAgents/cz.devbox.smbmount.plist
```

The agent mounts `smb://root@<ip>/dev` at `/Volumes/dev` at login, every 5 minutes and on
network changes. It takes the IP from `DEVBOX_SMB_HOST` or from `devdUrl` in the CLI config.
Force a mount with `launchctl kickstart "gui/$(id -u)/cz.devbox.smbmount"`. Log:
`/tmp/devbox-smbmount.log`.

## 5. Clipboard paste (optional)

Ctrl+V in Claude Code pastes images from the Mac clipboard out of the box: the `xclip` shim
in the image asks devd, and devd asks the listener. For ⌘V and files, install Hammerspoon
and load the bundled config:

```sh
brew install --cask hammerspoon
echo 'dofile(os.getenv("HOME") .. "/devbox/infra/hammerspoon-devbox.lua")' >> ~/.hammerspoon/init.lua
```

Grant Accessibility and enable Launch at login. ⌘⇧V stages the file in the shared `/inbox`
and types its container path.

## 6. Warp integration (optional)

Hooks in the image send Warp's `cli-agent` status sequences, so each tab shows the agent's
state (working, waiting, done) even though the agent runs remotely in tmux. If Warp keeps
jumping to a tab when its agent finishes, turn off the "focus tab when agent finishes"
option in Warp's settings. The badge stays.

**Restoring panes after a Warp or macOS update.** With Warp's own session restoration turned
on (Settings → Features → *Restore windows, tabs, and panes on startup*), devbox can reconnect
each restored pane to its exact session:

```sh
bun cli/install-recovery.ts     # adds one zsh hook, keeps your .zshrc
dev recover --snapshot          # record the panes that are open right now
```

After the next Warp start, recorded panes reconnect by themselves; new tabs stay plain shells.
`dev resume` reconnects the current pane, `dev recover` lists the records and
`dev recover --tabs` reopens missing ones in a new window. Records live in
`~/.config/devbox-cli/terminals/` (0600) and hold only connection metadata.

## 7. SSH approvals

Agents never receive private keys. An agent runs `srv "<key title>" --why "<reason>"
user@host`, and you approve it on the Mac (dialog), in the iOS app or in the dashboard
(`/ssh-approvals`). devd then loads the key into a per-session ssh-agent on the host and
exposes only its socket to the container. A request expires after 90 s. An approval can carry
a 60-minute grant, which you can revoke in the dashboard.

The approve/deny routes accept requests only from loopback and the tailnet, so a container
cannot approve its own request. If your dashboard comes through a Cloudflare tunnel from
another address and gets 403, add that address to `DEVD_APPROVAL_ALLOW` (see
[configuration.md](configuration.md)). `DEVD_SSH_APPROVAL=off` disables the gate as a
break-glass. The dashboard then shows a red banner.

## Where things live on the Mac

| Thing | In the repo | On the Mac |
|---|---|---|
| `dev` CLI | `cli/` | `~/.local/bin/dev`, `~/.config/devbox-cli/config.json` |
| listener | `listener/src/` | LaunchAgent `cz.devbox.listener`, `/tmp/devbox-listener.log` |
| notifier app | `listener/notifier/` | `~/Applications/Devbox Notifier.app` |
| SMB automount | `listener/install/mount-devbox.sh` | LaunchAgent `cz.devbox.smbmount`, `/tmp/devbox-smbmount.log` |
| Warp recovery | `cli/install-recovery.ts` | `~/.config/devbox-cli/terminals/` |
