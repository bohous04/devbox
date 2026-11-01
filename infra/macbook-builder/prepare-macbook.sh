#!/usr/bin/env bash
# prepare-macbook.sh — prepares a MacBook Pro (M1 Pro) as an always-on iOS build runner
# in clamshell mode. Runs ON THE MACBOOK as the user `ai` (sudo asks for the password).
# Idempotent: whatever is already done is only verified. GUI-only steps are printed as TODOs.
# Context: README.md next to this file and the internal design notes of the iOS build bridge.
set -uo pipefail

# Versions are kept identical to the Mac mini: the same xcodebuildmcp = the same discovery
# catalog on the VPS (/etc/devd/mac-mcp/xcode/catalog.json), so it does not need re-capturing.
XCODEBUILDMCP_VERSION="2.7.0"
XCODE_APP="/Applications/Xcode.app"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
todo() { printf '  \033[33m✗ TODO:\033[0m %s\n' "$*"; TODOS=$((TODOS + 1)); }
TODOS=0

[ "$(whoami)" = "ai" ] || todo "running as '$(whoami)', not 'ai' — the runner should have its own account (see README step 1)"

echo "▸ Machine name"
# Named after the role, not the hardware — the runner can be swapped, and "MacBook" gets confused
# with the main Mac and with the 1Password key "SSH Key - MacBook" (devbox → HAOS).
NAME="ios-builder"
for k in ComputerName HostName LocalHostName; do
  [ "$(scutil --get "$k" 2>/dev/null)" = "$NAME" ] || sudo scutil --set "$k" "$NAME"
done
ok "scutil: $NAME (Tailscale picks it up after an app restart)"

echo "▸ Power and sleep"
# -a: applies on battery too. During a power outage the MacBook should keep running on battery
# (it acts as a UPS), not fall asleep. disablesleep 1 also keeps the machine awake with the
# lid closed and no power — clamshell with a dummy HDMI otherwise requires the adapter.
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 powernap 0 womp 1 tcpkeepalive 1 ttyskeepawake 1
sudo pmset -a disablesleep 1
# The AlDente helper resets disablesleep to 0 (and puts the machine to sleep itself) → the builder
# fell asleep with the lid closed (2026-11-01). A watchdog restores the setting every 15 s.
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST=cz.devbox.ios-builder-nosleep.plist
if [ -f "$DIR/$PLIST" ]; then
  sudo install -o root -g wheel -m 644 "$DIR/$PLIST" /Library/LaunchDaemons/
  sudo launchctl bootout system/cz.devbox.ios-builder-nosleep 2>/dev/null || true
  sudo launchctl bootstrap system "/Library/LaunchDaemons/$PLIST"
fi
if sudo launchctl print system/cz.devbox.ios-builder-nosleep >/dev/null 2>&1; then ok "disablesleep watchdog is running"
else todo "disablesleep watchdog: copy $PLIST next to the script and run it again"; fi
ok "pmset: $(pmset -g | grep -E '^ (sleep|SleepDisabled)[[:space:]]' | tr -s ' \t' ' ' | tr '\n' ';')"

# An Apple Silicon MacBook boots by itself when power is connected — that is our "restart
# after an outage" (a Mac cannot do WoL from the powered-off state). BootPreference can disable it:
# %00 = boot neither on lid open nor on power, %02 = do not boot on power.
if bp="$(nvram BootPreference 2>/dev/null)"; then
  todo "nvram BootPreference is set ($bp) — auto-boot when power returns may be disabled; remove it: sudo nvram -d BootPreference"
else
  ok "BootPreference not set → boot on power connect is enabled (default)"
fi

echo "▸ FileVault a auto-login"
# With FileVault on, the machine waits for a password on the unlock screen after boot:
# no SSH, no Tailscale, no builds. Auto-login does not work with FileVault either.
if fdesetup status | grep -q "FileVault is Off"; then
  ok "FileVault is off"
else
  todo "FileVault is on — turn it off (System Settings → Privacy & Security → FileVault), otherwise the machine will not come back after an outage"
fi
auto="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
[ "$auto" = "ai" ] && ok "auto-login: ai" || todo "auto-login as 'ai' (System Settings → Users & Groups → Automatically log in as)"

echo "▸ SSH a Tailscale"
if sudo systemsetup -getremotelogin 2>/dev/null | grep -q "On"; then ok "Remote Login is on"
else todo "Remote Login (System Settings → General → Sharing → Remote Login)"; fi
grep -q "ssh-ed25519" ~/.ssh/authorized_keys 2>/dev/null && ok "authorized_keys contains a key" \
  || todo "add the 'SSH Key - iOS builder' pubkey to ~/.ssh/authorized_keys (README step 3)"
# The brew formula (system tailscaled, runs even with no user logged in) takes
# precedence over the GUI app, which only starts after login.
TS=/opt/homebrew/bin/tailscale
[ -x "$TS" ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [ -x "$TS" ] && ip="$("$TS" ip -4 2>/dev/null)"; then ok "Tailscale IP: $ip"
else todo "Tailscale: brew install tailscale && sudo brew services start tailscale && sudo tailscale up --hostname=ios-builder"; fi
printf '  host key (compare with switch-builder.sh): %s\n' "$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)"

# The listener belongs only to the main Mac (devd → DEVD_LISTENER_URL → "open on my Mac").
if [ -f "$HOME/Library/LaunchAgents/cz.devbox.listener.plist" ]; then
  todo "the devbox listener is installed on the builder — uninstall it, \"open on my Mac\" must go to the main Mac"
else
  ok "no devbox listener (open goes to the main Mac)"
fi

echo "▸ Tools"
# ssh without a login shell does not load ~/.zprofile → brew would not be on PATH.
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
command -v brew >/dev/null || { todo "Homebrew: https://brew.sh — then run the script again"; echo; echo "${TODOS}× TODO"; exit 1; }
brew list xcodegen >/dev/null 2>&1 || brew install xcodegen
brew list node >/dev/null 2>&1 || brew install node
ok "xcodegen $(/opt/homebrew/bin/xcodegen --version 2>/dev/null | tail -1)"
if [ "$(/opt/homebrew/bin/xcodebuildmcp --version 2>/dev/null)" != "$XCODEBUILDMCP_VERSION" ]; then
  npm install -g "xcodebuildmcp@$XCODEBUILDMCP_VERSION"
fi
ok "xcodebuildmcp $(/opt/homebrew/bin/xcodebuildmcp --version 2>/dev/null)"
mkdir -p "$HOME/builds" && ok "$HOME/builds exists"

echo "▸ Xcode"
if [ -d "$XCODE_APP" ]; then
  [ "$(xcode-select -p)" = "$XCODE_APP/Contents/Developer" ] || sudo xcode-select -s "$XCODE_APP"
  sudo xcodebuild -license accept && xcodebuild -runFirstLaunch >/dev/null
  ok "$(xcodebuild -version | head -1), xcode-select → $(xcode-select -p)"
  if xcrun simctl list runtimes | grep -q "iOS"; then
    ok "runtime: $(xcrun simctl list runtimes | grep iOS | tail -1 | cut -c1-40)"
  else
    echo "  downloading the iOS simulator runtime (~8 GB)…"; xcodebuild -downloadPlatform iOS
  fi
  # Without the GUI you cannot one-off "trust" SPM plugins/macros (SwiftTerm has a build
  # plugin) — the mini is set up the same way, otherwise the build fails on "Validate plug-in".
  defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES
  defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES
  # SwiftTerm compiles Metal shaders; the toolchain is not part of Xcode.app.
  if xcrun -f metal >/dev/null 2>&1 && xcrun metal --version >/dev/null 2>&1; then ok "Metal toolchain"
  else xcodebuild -downloadComponent MetalToolchain >/dev/null && ok "Metal toolchain downloaded"; fi
else
  todo "Xcode 27.0 from the App Store (same version as on the mini), then run the script again"
fi

echo "▸ Display (dummy HDMI)"
n="$(system_profiler SPDisplaysDataType 2>/dev/null | grep -cE '^ {8}[A-Za-z].*:$')"
[ "$n" -ge 2 ] && ok "external display detected ($n displays)" \
  || todo "dummy HDMI not detected — with the lid closed and no external display, Clamshell Sleep kicks in"

echo "▸ Disk space"
avail_gb="$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')"
[ "$avail_gb" -ge 40 ] && ok "${avail_gb} GB free" || todo "only ${avail_gb} GB free — the spec wants ≥ 40 GB"

echo "▸ Battery"
todo "check the charge limit is ~80 % (AlDente: brew install --cask aldente) — staying at 100 % swells the battery"

echo
[ "$TODOS" -eq 0 ] && echo "Done, the MacBook is ready." || echo "${TODOS}× TODO above (the battery one is always shown — just a reminder)."
