#!/usr/bin/env bash
# Tests codex-plugin-keeper against a fake plugin cache in a temporary directory.
set -euo pipefail
cd "$(dirname "$0")"
bash -n codex-plugin-keeper.sh && echo "syntax OK"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export CODEX_PLUGIN_CACHE="$T/cache" CODEX_PLUGIN_KEEPER_STATE="$T/state/seen"
P="$CODEX_PLUGIN_CACHE/mkt/warp"
fail() { echo "FAIL: $*"; exit 1; }

# 1) the first run only records existing versions, creates nothing
mkdir -p "$P/0.4.0/scripts"; echo old > "$P/0.4.0/scripts/hook.sh"
bash codex-plugin-keeper.sh
[ -d "$P/0.4.0" ] && [ ! -L "$P/0.4.0" ] || fail "the first run must not touch an existing version"
grep -qx "mkt/warp/0.4.0" "$CODEX_PLUGIN_KEEPER_STATE" || fail "the version was not recorded"
echo "record OK"

# 2) a plugin update deletes the old version → the keeper points it at the new one
rm -rf "$P/0.4.0"; mkdir -p "$P/0.4.1/scripts"; echo new > "$P/0.4.1/scripts/hook.sh"
bash codex-plugin-keeper.sh
[ "$(readlink "$P/0.4.0")" = "0.4.1" ] || fail "0.4.0 does not point to 0.4.1"
[ "$(cat "$P/0.4.0/scripts/hook.sh")" = new ] || fail "the hook cannot be read through the old path"
echo "relink OK"

# 3) another update deletes 0.4.1 too → both old paths point to the newest 0.10.0 (sort -V)
rm -rf "$P/0.4.1"; mkdir -p "$P/0.10.0/scripts"; echo newer > "$P/0.10.0/scripts/hook.sh"
mkdir -p "$P/0.9.0"
bash codex-plugin-keeper.sh
[ "$(readlink "$P/0.4.0")" = "0.10.0" ] || fail "the broken 0.4.0 symlink was not redirected"
[ "$(readlink "$P/0.4.1")" = "0.10.0" ] || fail "0.4.1 does not point to the newest version"
echo "chain OK"

# 4) an update deletes the whole plugin directory including our symlinks → they are recreated
rm -rf "$P"; mkdir -p "$P/0.11.0"
bash codex-plugin-keeper.sh
for v in 0.4.0 0.4.1 0.9.0 0.10.0; do
  [ "$(readlink "$P/$v")" = "0.11.0" ] || fail "$v was not restored after the plugin directory was deleted"
done
echo "wiped dir OK"

# 5) a repeated run changes nothing; an uninstalled plugin (no real version) is left alone
bash codex-plugin-keeper.sh
[ "$(readlink "$P/0.4.0")" = "0.11.0" ] || fail "the second run changed something"
rm -rf "$P"
bash codex-plugin-keeper.sh
[ ! -e "$P" ] || fail "nothing may be created for an uninstalled plugin"
echo "idempotent OK"

# 6) a missing cache is not an error
CODEX_PLUGIN_CACHE="$T/nothing" bash codex-plugin-keeper.sh || fail "a missing cache must pass"
echo "all OK"
