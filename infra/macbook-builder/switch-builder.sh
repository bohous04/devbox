#!/usr/bin/env bash
# switch-builder.sh — switches the iOS build bridge to another Mac (MacBook ↔ Mac mini).
# Runs ON THE VPS HOST (root), from the Mac:
#   ssh devbox 'bash -s -- ai@<tailnet-ip> ["SSH Key - iOS builder"]' < infra/macbook-builder/switch-builder.sh
#
# Changes only /etc/devd/mac-mcp/xcode/{registration.json,known_hosts} (mounted read-only into
# the containers as /opt/mac-mcp, so sessions see it immediately; a new MCP instance of the
# bridge = a new session or an MCP reconnect). The original files are backed up next to them
# with a timestamp suffix. Back to the mini: the same script with ai@<mac-mini-tailnet-ip>
# (the mini also has the "SSH Key - iOS builder" pubkey in authorized_keys).
# The key title goes into `keyTitle` and into the preflight (mac-sync, 3rd argument).
set -euo pipefail

TARGET="${1:?usage: switch-builder.sh ai@<tailnet-ip> [1P key title]}"
KEY_TITLE="${2:-SSH Key - iOS builder}"
DIR=/etc/devd/mac-mcp/xcode
REG="$DIR/registration.json"
# Same shape as TARGET_RE in image/mac-mcp-bridge/registration.py.
[[ "$TARGET" =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "suspicious target: $TARGET" >&2; exit 1; }
HOST="${TARGET#*@}"

# Host key over the tailnet (WireGuard, authenticated peer) — still compare it
# with the fingerprint that prepare-macbook.sh printed on the MacBook.
KEY="$(ssh-keyscan -T 10 -t ed25519 "$HOST" 2>/dev/null)"
[ -n "$KEY" ] || { echo "ssh-keyscan $HOST returned nothing — is the MacBook online with Remote Login on?" >&2; exit 1; }
echo "host key fingerprint $HOST:"
ssh-keygen -lf <(echo "$KEY")

ts="$(date +%Y%m%d-%H%M%S)"
cp -p "$REG" "$REG.bak-$ts"
cp -p "$DIR/known_hosts" "$DIR/known_hosts.bak-$ts"

python3 - "$REG" "$TARGET" "$KEY_TITLE" <<'PY'
import json, sys
path, target, key_title = sys.argv[1:4]
reg = json.load(open(path))
reg['target'] = target
reg['keyTitle'] = key_title
# The user sees `why` when approving the key — it must not say "mac mini" when building elsewhere.
# Registrations written before the English translation say "na mac mini".
reg['why'] = reg.get('why', '').replace('na mac mini', 'na macu').replace('on the Mac mini', 'on the Mac')
# preflight = [["/usr/local/bin/mac-sync", "ios", "<target>"]] — the rsync target must
# be the same Mac, otherwise the build would run on a stale copy of the sources.
for step in reg.get('preflight', []):
    if step and step[0].endswith('/mac-sync') and len(step) >= 3:
        step[2:] = [target, key_title]
json.dump(reg, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
PY
echo "$KEY" > "$DIR/known_hosts"

echo "done: target=$TARGET (backup *.bak-$ts)"
grep -E '"target"|"keyTitle"' "$REG"; python3 -c "import json; print(json.load(open('$REG'))['preflight'])"
