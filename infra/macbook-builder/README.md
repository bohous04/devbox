# MacBook builder runbook — iOS builds on a MacBook in clamshell mode

A MacBook Pro M1 Pro (16 GB / 512 GB) takes over from the Mac mini (M1 / 8 GB) as the target
of the iOS build bridge: a session on the VPS goes through the `xcode` MCP → `mac-sync` (rsync +
xcodegen) → `xcodebuildmcp` on the Mac. The bridge design is described in the internal design notes.

**Why:** the mini has 8 GB and runs other long-lived workloads (a VS Code instance) at the same
time → Xcode + the simulator swap; on top of that it has only 16 GB of free disk left (the design
notes want ≥ 40). The mini keeps its other workloads and the HAOS VM, the MacBook only does builds.

**Named after the role, not the machine:** the MacBook's hostname and Tailscale name is
**`ios-builder`**, its key is the 1Password item **"SSH Key - iOS builder"** (vault DEV BOX).
Do not mix them up: "SSH Key - MacBook" is a different key (devbox → HAOS), "SSH Key - Mac mini"
stays for the mini. The iOS builder's public key is also in the mini's `authorized_keys`, so
going back to the mini is just a matter of switching the target.

**What changes:** `image/mac-sync` takes the key title as its 3rd argument (it used to be
hard-coded to "SSH Key - Mac mini") → **rebuild the image first** (new sessions get the new
`mac-sync`), then on the VPS rewrite `/etc/devd/mac-mcp/xcode/registration.json` (`target`,
`keyTitle`, `preflight`) and `known_hosts`. The catalog does not need to be re-captured, because
`xcodebuildmcp` is the same version (2.7.0).

**"Open it on my Mac" stays on the main Mac.** `open` in a session goes through devd `/api/open`
to the listener set by `DEVD_LISTENER_URL` in `devd.service` (currently
`http://<main-mac-tailnet-ip>:7777` = the main Mac). The iOS builder never uses that path — it
builds through the `xcode` MCP over SSH. That is why you must **not install the listener** on the
builder (`bun listener/install.ts`) and must **not perform step 5 of
[docs/mac-runbook.md](../../docs/mac-runbook.md)** (rewriting `DEVD_LISTENER_URL`) — that runbook
is for the main Mac, not for the runner.

## Clamshell and power — how it all holds together

| Situation | What happens |
|---|---|
| AlDente flips `disablesleep` to 0 | the LaunchDaemon `cz.devbox.ios-builder-nosleep` restores it within 15 s (without it the builder fell into "Clamshell Sleep" on 2026-11-01) |
| lid closed, on the adapter | a dummy HDMI plug = "external monitor" → classic clamshell; `pmset sleep 0` |
| power outage (short) | the MacBook keeps running on battery (`disablesleep 1` keeps it awake even closed and without the adapter); when power returns it just charges |
| outage longer than the battery | macOS shuts down when the battery runs out; when power returns, **an Apple Silicon MacBook boots by itself when power is connected** (default behaviour, unless `nvram BootPreference` is set) |
| boot with nobody around | FileVault **off** + auto-login as `ai` → Tailscale and SSH come up on their own |
| the MacBook freezes / someone turns it off | by hand; or a smart plug on the adapter (off → on = "power connected" = boot) |

**Why not Wake-on-LAN like the Windows PC:** a Mac cannot do WoL from the *powered off* state
(only wake from sleep), the MacBook has no Ethernet and WoL over a USB-C adapter does not work.
We also disable sleep, so there is nothing to wake. The "remote power-on" role is played by
auto-boot on power connect, or by a smart plug driven from Home Assistant.

## 1. Account and GUI (on the MacBook, ~15 min + the Xcode download)

1. Factory reset → setup assistant: **skip** Apple ID / iCloud, user **`ai`** (admin), do not
   enable FileVault; then **auto-login** as `ai` (System Settings → Users & Groups). Auto-login
   only works with FileVault off. `prepare-macbook.sh` sets the hostname to `ios-builder`.
2. **Turn FileVault off** (System Settings → Privacy & Security → FileVault).
3. Turn on **Remote Login** (System Settings → General → Sharing).
4. Homebrew, Tailscale as a **system service** (`brew install tailscale &&
   sudo brew services start tailscale && sudo tailscale up --hostname=ios-builder`,
   open the login URL and sign in as `<you>@`) — it comes up even with no user logged in.
5. **Xcode 27.0** (the mini has 27.0, build 27A266a) — without an Apple ID you can copy it from
   the mini: `ssh ai@<mac-mini-tailnet-ip> 'tar -C /Applications -cf - Xcode.app' | ssh ai@ios-builder 'sudo tar -C /Applications -xf -'`.
6. AlDente (`brew install --cask aldente`) → charge limit 80 %.
7. Xcode → Settings → Accounts → sign in with your Apple ID (team `<your-team-id>`), so the
   keychain has a development identity for signing.
8. Wi-Fi: set the network to "Auto-Join"; a USB-C Ethernet dongle, if you have one, is more
   stable.

**Passwordless sudo (permanent, on purpose):** `/etc/sudoers.d/ai-builder` =
`ai ALL=(ALL) NOPASSWD: ALL`, so the agent / remote administration over SSH does not wait for a
password. Whoever has SSH as `ai` has root — access is guarded by the "SSH Key - iOS builder" key
(approved in devd) and the main Mac's key. The machine is single-purpose, there is nothing
personal on it.

```sh
echo "ai ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/ai-builder
```

## 2. Preparation script (on the MacBook, as `ai`)

```sh
# from the main Mac (the repo is private, curl from GitHub does not work):
scp infra/macbook-builder/prepare-macbook.sh infra/macbook-builder/cz.devbox.ios-builder-nosleep.plist ai@<macbook>:/tmp/
# on the MacBook:
bash /tmp/prepare-macbook.sh
```

It configures `pmset` (+ the `disablesleep` watchdog, which is why the plist is copied next to
the script), checks FileVault/auto-login/BootPreference, installs `xcodegen`, `node`,
`xcodebuildmcp@2.7.0`, switches `xcode-select`, accepts the license and downloads the iOS
runtime. At the end it prints the remaining TODOs and the **host key fingerprint** — note it
down for step 4. Re-run it until only the battery reminder is left.

## 3. Key (from the main Mac)

```sh
MB=ai@<macbook-tailnet-ip>
op item get "SSH Key - iOS builder" --vault "DEV BOX" --fields "public key" | ssh $MB 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

## 4. Switching the VPS (from the main Mac)

Prerequisite: the branch with the parameterized `mac-sync` is in `main` and the image has been
rebuilt (`docker build -t devbox:latest image` on the VPS, see `infra/setup.sh`); try the build in
a **new** session.

```sh
ssh devbox 'bash -s -- ai@<macbook-tailnet-ip>' < infra/macbook-builder/switch-builder.sh
```

The argument has to be inside the quotes after `bash -s --` (after `<` it would go to the local
shell, not to the script). For reference, record the builder's addresses here:
`ios-builder` = `<builder-tailnet-ip>`, LAN `<builder-lan-ip>`. Compare the printed fingerprint
with step 2. Backups: `registration.json.bak-*`, `known_hosts.bak-*`. **Going back to the mini**
= the same command with `ai@<mac-mini-tailnet-ip>` (the iOS builder key works there too).

## 5. Verification

1. In a new devbox session (or after reconnecting the `xcode` MCP): `doctor` and `list_sims` →
   returns the MacBook (iOS 27.0 runtime). The first call asks for approval of the
   "SSH Key - iOS builder" key — `--why` refers to the session.
2. Build this repo's `ios/DevboxApp` (the bring-up subject from the design notes), then deliberately
   break a Swift file → the compiler error must come back as the tool result.
3. **Outage test** (once, lid closed, dummy HDMI plugged in):
   - unplug the adapter → the MacBook keeps answering `ping`/SSH;
   - `sudo shutdown -h now`, wait, unplug the adapter, plug it back in → the MacBook must boot by
     itself and be on the tailnet within ~2 min (`ssh $MB true`).
     If it does not come up with the lid closed, you need a smart plug or must leave the lid
     slightly open — write the result down here.
4. Then delete `~/builds/*` on the mini (16 GB of free space will help it) — optionally uninstall
   the simulator runtime; leave its other workloads alone.

## Physical iPhone

iPhone over USB to the MacBook (instead of the mini), once "Trust This Computer" and in Xcode
Devices & Simulators enable Developer Mode / pair.

## Home Assistant monitoring

In your Home Assistant config (HAOS runs as a VM on the mini, `autorestart 1` → it comes back
after an outage): a ping sensor for the MacBook + a push to the iPhone when it is offline for
> 10 min, and when it comes back. It needs a DHCP reservation for the MacBook's LAN IP (like
`<pc-lan-ip>` for the Windows PC). A smart plug on the adapter = an HA "power-cycle" script
(off 10 s → on) as remote power-on.
