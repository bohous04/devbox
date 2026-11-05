#!/bin/bash
# Mounts the devbox SMB share (tailnet) — a silent no-op when already mounted or the devbox is unreachable.
# NetAuthAgent takes the password from the login keychain (item "devbox SMB", account root, server = tailnet IP).
# The IP must match the keychain — NetAuthAgent would not pair the hostname "devbox" and would show a prompt.
# Zdroj: DEVBOX_SMB_HOST, jinak host z devdUrl v configu `dev` CLI.
#
# The mount goes through a small NetFS helper with UI disabled (smb-mount-noui.swift), never through
# "osascript mount volume": that one shows a modal error dialog on every failed attempt, which on a
# flaky connection means a dialog every few minutes. After a failure further attempts back off.
SERVER="${DEVBOX_SMB_HOST:-}"
[ -n "$SERVER" ] || SERVER=$(sed -n 's/.*"devdUrl"[^"]*"\([^"]*\)".*/\1/p' "$HOME/.config/devbox-cli/config.json" 2>/dev/null | sed -E 's#^[a-z]+://##; s#[:/].*$##')
[ -n "$SERVER" ] || exit 0
[[ "$SERVER" =~ ^[A-Za-z0-9.-]+$ ]] || exit 0
SHARE="dev"

STATE_DIR="$HOME/Library/Caches/devbox-smbmount"
HELPER="$STATE_DIR/smb-mount-noui"
SRC="$(cd "$(dirname "$0")" && pwd)/smb-mount-noui.swift"
FAILS_FILE="$STATE_DIR/fails"
mkdir -p "$STATE_DIR"

mount -t smbfs | grep -q "//root@${SERVER}/${SHARE} " && { rm -f "$FAILS_FILE"; exit 0; }

# Backoff after failed attempts: 2, 4, 8, max 15 minutes.
if [ -f "$FAILS_FILE" ]; then
  fails=$(cat "$FAILS_FILE" 2>/dev/null); [[ "$fails" =~ ^[0-9]+$ ]] || fails=1
  wait_min=$(( 1 << (fails < 4 ? fails : 4) )); [ "$wait_min" -gt 15 ] && wait_min=15
  age_min=$(( ( $(date +%s) - $(stat -f %m "$FAILS_FILE") ) / 60 ))
  [ "$age_min" -lt "$wait_min" ] && exit 0
fi

nc -z -G 3 "$SERVER" 445 >/dev/null 2>&1 || exit 0

# Build the helper on first use and whenever the source changes (auto-update of the repo).
if [ ! -x "$HELPER" ] || [ "$SRC" -nt "$HELPER" ]; then
  /usr/bin/swiftc -O "$SRC" -o "$HELPER.tmp" 2>&1 && mv -f "$HELPER.tmp" "$HELPER" || { echo "$(date '+%F %T') swiftc failed"; exit 0; }
fi

if "$HELPER" "smb://root@${SERVER}/${SHARE}"; then
  rm -f "$FAILS_FILE"
else
  echo "$(date '+%F %T') mount failed (attempt $(( ${fails:-0} + 1 )))"
  echo $(( ${fails:-0} + 1 )) > "$FAILS_FILE"
fi
