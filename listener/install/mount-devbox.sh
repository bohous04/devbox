#!/bin/bash
# Mounts the devbox SMB share (tailnet) — a silent no-op when already mounted or the devbox is unreachable.
# NetAuthAgent takes the password from the login keychain (item "devbox SMB", account root, server = tailnet IP).
# The IP must match the keychain — NetAuthAgent would not pair the hostname "devbox" and would show a prompt.
# Zdroj: DEVBOX_SMB_HOST, jinak host z devdUrl v configu `dev` CLI.
SERVER="${DEVBOX_SMB_HOST:-}"
[ -n "$SERVER" ] || SERVER=$(sed -n 's/.*"devdUrl"[^"]*"\([^"]*\)".*/\1/p' "$HOME/.config/devbox-cli/config.json" 2>/dev/null | sed -E 's#^[a-z]+://##; s#[:/].*$##')
[ -n "$SERVER" ] || exit 0
# The host goes into an AppleScript string below — only hostname/IP characters, nothing that could terminate it.
[[ "$SERVER" =~ ^[A-Za-z0-9.-]+$ ]] || exit 0
SHARE="dev"

mount -t smbfs | grep -q "//root@${SERVER}/${SHARE} " && exit 0
nc -z -G 3 "$SERVER" 445 >/dev/null 2>&1 || exit 0
exec osascript -e "mount volume \"smb://root@${SERVER}/${SHARE}\""
