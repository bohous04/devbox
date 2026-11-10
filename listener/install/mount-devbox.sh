#!/bin/bash
# Mounts the devbox SMB share (tailnet) — a silent no-op when already mounted or the devbox is unreachable.
# NetAuthAgent takes the password from the login keychain (item "devbox SMB", account root, server = tailnet IP).
# The IP must match the keychain — NetAuthAgent would not pair the hostname "devbox" and would show a prompt.
# Zdroj: DEVBOX_SMB_HOST, jinak host z devdUrl v configu `dev` CLI.
#
# Two ways to mount, both under a hard deadline (see with_deadline):
#  - /Volumes/dev already exists (left behind after a network drop — the usual case): mount_smbfs -N
#    fills it; a CLI tool never shows a dialog, the password comes from the login keychain.
#  - no mountpoint (after a clean unmount / reboot): only the system may create one in /Volumes, so
#    "osascript mount volume". That can show an error dialog, so it runs only when port 445 answers
#    and failed attempts back off.
# Both osascript and NetFS go through the system NetAuthSysAgent; on 5 Nov 2026 it wedged during an
# outage and every such mount blocked forever (fix: `sudo killall NetAuthSysAgent`). mount_smbfs does
# not use it, which is why it is preferred whenever the mountpoint exists.
SERVER="${DEVBOX_SMB_HOST:-}"
[ -n "$SERVER" ] || SERVER=$(sed -n 's/.*"devdUrl"[^"]*"\([^"]*\)".*/\1/p' "$HOME/.config/devbox-cli/config.json" 2>/dev/null | sed -E 's#^[a-z]+://##; s#[:/].*$##')
[ -n "$SERVER" ] || exit 0
[[ "$SERVER" =~ ^[A-Za-z0-9.-]+$ ]] || exit 0
SHARE="dev"

STATE_DIR="$HOME/Library/Caches/devbox-smbmount"
FAILS_FILE="$STATE_DIR/fails"
mkdir -p "$STATE_DIR"

MOUNTPOINT="/Volumes/${SHARE}"
# Mounted where the listener mapping expects it → done. Mounted somewhere else (/Volumes/dev-1: a
# stuck attempt had already claimed /Volumes/dev, seen 5 and 10 Nov 2026) → the listener cannot see
# the files, so unmount it and mount again at the right place below.
current=$(mount -t smbfs | sed -n "s#^//root@${SERVER}/${SHARE} on \(.*\) (smbfs.*#\1#p" | head -1)
if [ "$current" = "$MOUNTPOINT" ]; then rm -f "$FAILS_FILE"; exit 0; fi
if [ -n "$current" ]; then
  echo "$(date '+%F %T') share mounted at $current instead of $MOUNTPOINT — remounting"
  /usr/sbin/diskutil unmount force "$current" >/dev/null 2>&1 || exit 0
fi

# Backoff after failed attempts: 2, 4, 8, max 15 minutes.
if [ -f "$FAILS_FILE" ]; then
  fails=$(cat "$FAILS_FILE" 2>/dev/null); [[ "$fails" =~ ^[0-9]+$ ]] || fails=1
  wait_min=$(( 1 << (fails < 4 ? fails : 4) )); [ "$wait_min" -gt 15 ] && wait_min=15
  age_min=$(( ( $(date +%s) - $(stat -f %m "$FAILS_FILE") ) / 60 ))
  [ "$age_min" -lt "$wait_min" ] && exit 0
fi

nc -z -G 3 "$SERVER" 445 >/dev/null 2>&1 || exit 0

# Runs a mount command with a hard deadline. A mount can block forever: on 5 Nov 2026 the NetFS helper
# hung and, because launchd never starts a second copy
# of a running job, the share stayed unmounted for five days (every `open` from a session failed).
with_deadline() {
  local secs=$1; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -9 "$pid" 2>/dev/null ) & local watchdog=$!
  wait "$pid"; local rc=$?
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  return $rc
}

mounted=1
if [ -d "$MOUNTPOINT" ] && [ -O "$MOUNTPOINT" ]; then
  # A mountpoint left behind by an earlier mount: mount_smbfs fills it directly. -N = never prompt,
  # the password comes from the login keychain; a CLI tool shows no dialog on failure.
  chmod 755 "$MOUNTPOINT" 2>/dev/null
  with_deadline 30 /sbin/mount_smbfs -N "//root@${SERVER}/${SHARE}" "$MOUNTPOINT" && mounted=0
else
  with_deadline 45 /usr/bin/osascript -e "mount volume \"smb://root@${SERVER}/${SHARE}\"" >/dev/null && mounted=0
fi

if [ "$mounted" -eq 0 ]; then
  rm -f "$FAILS_FILE"
else
  echo "$(date '+%F %T') mount failed (attempt $(( ${fails:-0} + 1 )))"
  echo $(( ${fails:-0} + 1 )) > "$FAILS_FILE"
fi
