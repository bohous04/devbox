#!/usr/bin/env bash
# Anthropic account pool — shim in front of the real `claude` on the mac.
#
# Install: ~/.claude-pool/bin/claude, directory prepended in PATH; the real binary
# stays in ~/.local/bin/claude. See docs/account-pool.md.
#
# This script stands in the way of EVERY claude launch on the mac, so a bug in it
# breaks everything, not just the pool. Hence: no dependencies (curl only), a hard timeout,
# no `set -e` (a failed curl must not take the script down) and `exec` at the end.
set -u

# `set -u` would also fail the defaults below if the $HOME they reference were not
# set at all (practically impossible on a mac, but handling it this way is free).
HOME="${HOME:-$PWD}"

# devd address: env → devdUrl from the `dev` CLI config → localhost.
[ -n "${DEVD_URL:-}" ] || DEVD_URL=$(sed -n 's/.*"devdUrl"[^"]*"\([^"]*\)".*/\1/p' "$HOME/.config/devbox-cli/config.json" 2>/dev/null)
DEVD_URL="${DEVD_URL:-http://127.0.0.1:4300}"
REAL_CLAUDE="${CLAUDE_POOL_REAL:-$HOME/.local/bin/claude}"
POOL_DIR="${CLAUDE_POOL_DIR:-$HOME/.claude-pool/accounts}"

# `project` is missing from mac stats per the stats-from-mac spec: OTEL_RESOURCE_ATTRIBUTES
# in ~/.claude/settings.json is global, so mac work would not show up in the project
# leaderboard. Here it is derived from the git root (outside a repo, from cwd).
project=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
attrs="devbox.host=mac,project=${project}"

# `$POOL_DIR` does not exist at all until at least one account is set up (same trap
# as in image/account-lease.sh): without this check EVERY claude launch on a
# fresh mac (no account in the pool) would call devd for nothing — the profile has
# nowhere to mount anyway, it would only stretch the start by a network call and devd would create a lease
# for a session that never uses it.
if [ -d "$POOL_DIR" ]; then
  # Timeout 1.5 s: launching claude must not wait for the network. A curl failure is a normal
  # state (off the tailnet, devd restarting) — we continue without injection.
  lease=$(curl -fsS --max-time 1.5 -G \
    --data-urlencode "client=mac" \
    --data-urlencode "label=${project}" \
    "$DEVD_URL/api/accounts/lease" 2>/dev/null)

  # No jq (the mac may not have it) — accountId and label are extracted with sed.
  acct=$(printf '%s' "$lease" | sed -n 's/.*"accountId":"\([^"]*\)".*/\1/p')
  label=$(printf '%s' "$lease" | sed -n 's/.*"label":"\([^"]*\)".*/\1/p')

  # The profile must exist on disk: CLAUDE_CONFIG_DIR pointing to an empty directory would
  # mean a LOGGED-OUT claude (verified — a custom config dir does not fall back to the
  # Keychain), which is worse than the current state.
  if [ -n "$acct" ] && [ -d "$POOL_DIR/$acct" ]; then
    export CLAUDE_CONFIG_DIR="$POOL_DIR/$acct"
    # The label is often the auto "email (org)" and is not validated for commas — unescaped it would
    # split the k=v,k=v format for everyone who reads OTEL_RESOURCE_ATTRIBUTES.
    safe_label="${label//,/ }"
    attrs="${attrs},devbox.account=${safe_label:-$acct}"
  fi
fi

export OTEL_RESOURCE_ATTRIBUTES="$attrs"

# The script stands in the way of EVERY `claude` on the mac — a missing/non-executable
# REAL_CLAUDE must not stop it. When the configured/default path cannot be
# executed, `claude` is looked up on PATH WITHOUT the directory this shim lives in (otherwise
# the lookup could find only itself again and loop). When nothing is found
# even then, the last resort is a bare `exec claude` with the same filtered PATH —
# in the worst case "claude is not installed", no worse a state than
# if this shim did not exist at all.
if [ ! -x "$REAL_CLAUDE" ]; then
  shim_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  filtered_path=""
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] && [ "$dir" != "$shim_dir" ] || continue
    filtered_path="${filtered_path:+$filtered_path:}$dir"
  done
  unset IFS
  found=$(PATH="$filtered_path" command -v claude 2>/dev/null)
  if [ -n "$found" ]; then
    REAL_CLAUDE="$found"
  else
    PATH="$filtered_path" exec claude "$@"
  fi
fi

exec "$REAL_CLAUDE" "$@"
