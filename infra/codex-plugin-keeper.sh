#!/usr/bin/env bash
# codex-plugin-keeper — keeps old plugin paths in the shared Codex cache working.
#
# All devboxes share one long-running Codex app-server (codex-remote-control.service).
# At startup it loads plugins including versioned paths (…/cache/<mkt>/<plugin>/<version>/)
# and keeps them in memory. When a plugin is updated, Codex deletes the old version from the cache —
# the app-server then runs hooks from a deleted path ("Hook failed … exit 127") and offers
# agents skills that do not exist. Restarting the app-server would fix it, but would end
# all running sessions.
#
# So the keeper remembers every version it has ever seen in the cache, and when one disappears,
# replaces it with a relative symlink to the newest existing version of the same plugin. A symlink
# pointing at a version that is itself a symlink is just redirected (update chain). An uninstalled plugin
# (no real version) is left alone. Idempotent; runs from a timer on the HOST.
set -euo pipefail

CACHE="${CODEX_PLUGIN_CACHE:-/var/lib/docker/volumes/codex-home/_data/plugins/cache}"
STATE="${CODEX_PLUGIN_KEEPER_STATE:-/var/lib/codex-plugin-keeper/seen}"

[ -d "$CACHE" ] || exit 0
mkdir -p "$(dirname "$STATE")"
touch "$STATE"

# Record all versions currently in the cache — including our symlinks: a plugin update
# deletes its whole directory, so we must be able to recreate them afterwards.
current="$(cd "$CACHE" && for d in */*/*/; do
  [ -d "$d" ] && printf '%s\n' "${d%/}"
done || true)"
printf '%s\n%s\n' "$(cat "$STATE")" "$current" | grep -v '^$' | sort -u > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"

while IFS= read -r entry; do
  path="$CACHE/$entry"
  [ -e "$path" ] && continue            # exists (for real, or a valid symlink)
  plugin_dir="$(dirname "$path")"
  [ -d "$plugin_dir" ] || continue      # plugin uninstalled
  newest="$(cd "$plugin_dir" && for d in */; do
    d="${d%/}"
    [ -d "$d" ] && [ ! -L "$d" ] && printf '%s\n' "$d"
  done | sort -V | tail -n 1 || true)"
  [ -n "$newest" ] || continue
  # Owner taken from the plugin directory, so Codex (running as a different user) can keep working with the cache.
  ln -sfn "$newest" "$path"
  [ "$(id -u)" -eq 0 ] && chown -h "$(stat -c %u:%g "$plugin_dir")" "$path"
  echo "codex-plugin-keeper: $entry -> $newest"
done < "$STATE"
