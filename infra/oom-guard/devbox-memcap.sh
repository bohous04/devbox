#!/usr/bin/env bash
# Safeguard for the RAM cap devd gives sessions at creation (SESSION_MEMORY_LIMIT
# in devd/src/docker.ts). Adds it to session containers and dind sidecars created
# without it — older sessions, manually created ones, or when devd runs without that change.
# A container that already has a (different) limit is left alone.
set -euo pipefail
LIMIT="${DEVBOX_SESSION_MEMORY:-15g}"
SWAP_LIMIT="${DEVBOX_SESSION_MEMORY_SWAP:-35g}"   # RAM + swap, see SESSION_MEMORY_SWAP_LIMIT

docker ps -a --format '{{.Names}}' | grep -E '^(dev-|dind-dev-)' | while read -r name; do
  mem="$(docker inspect -f '{{.HostConfig.Memory}}' "$name" 2>/dev/null)" || continue
  [ "$mem" = "0" ] || continue
  if docker update --memory "$LIMIT" --memory-swap "$SWAP_LIMIT" "$name" >/dev/null; then
    echo "cap $LIMIT: $name"
  else
    echo "⚠️ failed to set the cap: $name" >&2
  fi
done
