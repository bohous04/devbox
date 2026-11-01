#!/usr/bin/env bash
# Idempotently writes devd hooks for Antigravity CLI into the global
# ${AGY_CONFIG:-$HOME/.gemini/config}/hooks.json (shared antigravity-home volume).
#
# Shape per agy's built-in documentation and measurements (the Antigravity research notes,
# Question 6.5): top-level keys are NAMED hooks ({"devd": {...}, "lint": {...}}),
# SessionStart/PreInvocation/Stop are flat lists of handlers (no matcher envelope).
# The file may contain the user's hooks → we merge only the `devd` key, the rest stays.
# PreToolUse NEVER: agy reads a reply without `decision` as a tool denial.
set -uo pipefail

AGY_HOOK="${AGY_HOOK:-/opt/devd-hooks/agy-hook.sh}"
DIR="${AGY_CONFIG:-$HOME/.gemini/config}"
FILE="$DIR/hooks.json"

[ -x "$AGY_HOOK" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
if ! mkdir -p "$DIR" 2>/dev/null; then
  echo "seed-agy-hooks: cannot write to $DIR (permissions?) — the Antigravity session will run WITHOUT devd hooks." >&2
  exit 0
fi

# Guard: hooks.json is on a shared volume; a container from an older image does not have the adapter —
# even there the command must print valid JSON, otherwise agy would get an empty reply.
cmd() { printf "[ -x %s ] && %s %s || echo '{}'" "$AGY_HOOK" "$AGY_HOOK" "$1"; }
devd="$(jq -nc --arg s "$(cmd SessionStart)" --arg p "$(cmd PreInvocation)" --arg t "$(cmd Stop)" '{
  SessionStart:  [ { type: "command", command: $s } ],
  PreInvocation: [ { type: "command", command: $p } ],
  Stop:          [ { type: "command", command: $t, timeout: 300 } ]
}')" || exit 0

base='{}'
if [ -s "$FILE" ]; then
  if ! base="$(jq -c 'if type == "object" then . else error("not object") end' "$FILE" 2>/dev/null)"; then
    echo "seed-agy-hooks: $FILE (hooks.json) is not a valid JSON object — leaving it alone, Antigravity will run WITHOUT devd hooks." >&2
    exit 0
  fi
fi
tmp="$(mktemp "$FILE.XXXXXX")" || exit 0
if printf '%s' "$base" | jq --argjson d "$devd" '.devd = $d' > "$tmp" 2>/dev/null; then
  mv "$tmp" "$FILE"
else
  rm -f "$tmp"
fi
exit 0
