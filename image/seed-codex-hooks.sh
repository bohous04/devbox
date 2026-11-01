#!/usr/bin/env bash
# Idempotently registers devd agent-event hooks in Codex ($CODEX_HOME/hooks.json on the
# shared codex-home volume). Same contract as seed-devd-hooks.sh for Claude:
# replaces only its OWN entries (recognized by the path suffix /devd-hook.sh, not by the
# /opt/devd-hooks/ directory — on purpose, so a hook is recognized as "own" even after redirection
# via DEVD_HOOK to another directory), foreign ones are left untouched.
#
# Codex expects events nested under the top-level `hooks` key (next to the optional
# `description`), NOT at the top level — otherwise the parser rejects hooks.json with
# `unknown field 'Stop', expected 'description' or 'hooks'`. Shape verified empirically
# against codex-cli 0.145.0 in the real image.
#
# Migration: older runs of this script mistakenly wrote events at the top level. If we
# encounter such a (broken) shape, we move Stop/UserPromptSubmit/PermissionRequest
# (including foreign entries inside) under `.hooks` and delete the top-level keys — after one
# run no old shape remains.
#
# Warp additionally tracks start, completed tools, interruption and session end.
# PreToolUse lets the emitter show waiting for request_user_input; other tools
# the emitter ignores there. Events verified against the Codex CLI 0.153.4 schema.
set -uo pipefail

HOOK="${DEVD_HOOK:-/opt/devd-hooks/devd-hook.sh}"
WARP_HOOK="${WARP_HOOK:-/opt/warp-hooks/warp-hook.sh}"
HOOKS_FILE="${CODEX_HOME:-$HOME/.codex}/hooks.json"

# No-op on an older image without the emitter or without jq — never fatal.
[ -x "$HOOK" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

mkdir -p "$(dirname "$HOOKS_FILE")"
[ -s "$HOOKS_FILE" ] || printf '{}\n' > "$HOOKS_FILE"

# Guard `[ -x … ]`: hooks.json is on a SHARED volume, so a container from an older image
# (without /opt/devd-hooks) must not fail on these hooks.
cmd() { printf '[ -x %s ] && %s %s || true' "$HOOK" "$HOOK" "$1"; }
desired="$(jq -nc \
  --arg pretool "$(cmd tool_start)" \
  --arg complete "$(cmd tool_complete)" \
  --arg interrupted "$(cmd interrupted)" \
  --arg stop "$(cmd stop)" \
  --arg prompt "$(cmd user_prompt_submit)" \
  --arg permission "$(cmd permission_request)" '{
  PreToolUse:        [ { hooks: [ { type: "command", command: $pretool } ] } ],
  PostToolUse:       [ { hooks: [ { type: "command", command: $complete } ] } ],
  SessionEnd:        [ { hooks: [ { type: "command", command: $interrupted, timeout: 10 } ] } ],
  Interrupt:         [ { hooks: [ { type: "command", command: $interrupted, timeout: 10 } ] } ],
  Stop:              [ { hooks: [ { type: "command", command: $stop, timeout: 300 } ] } ],
  UserPromptSubmit:  [ { hooks: [ { type: "command", command: $prompt } ] } ],
  PermissionRequest: [ { hooks: [ { type: "command", command: $permission } ] } ]
}')"
# Interrupt and SessionEnd have a default timeout of only 1 s in Codex. With a remote app-server
# every hook goes through dispatch.py into the container (docker inspect + exec) and the overhead
# alone is ~1.3 s (measured 2026-09-30), so without an explicit limit the hook always failed
# with "hook timed out after 1s". 10 s covers the overhead with margin and does not delay interruption.

# Warp tab status: the hook writes OSC 777 to the pane's tty itself. Pass the identity only to its
# process — Claude/Grok use the same emitter but have their own seeding.
# On an older image without /opt/warp-hooks the entries are not seeded (and any old ones are cleaned up
# below — the filter always deletes by the warp-hook.sh name, even with an empty $w).
warp_events='["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "PreToolUse", "Stop", "Interrupt", "SessionEnd"]'
if [ -x "$WARP_HOOK" ]; then
  wcmd() { printf '[ -x %s ] && DEVD_WARP_AGENT=codex %s --tty %s || true' "$WARP_HOOK" "$WARP_HOOK" "$1"; }
  warp_desired="$(jq -nc \
    --arg start "$(wcmd session_start)" \
    --arg stop "$(wcmd stop)" \
    --arg prompt "$(wcmd prompt_submit)" \
    --arg complete "$(wcmd tool_complete)" \
    --arg pre_tool "$(wcmd pre_tool_use)" \
    --arg permission "$(wcmd permission_request)" '{
    SessionStart:      [ { hooks: [ { type: "command", command: $start } ] } ],
    Stop:              [ { hooks: [ { type: "command", command: $stop } ] } ],
    UserPromptSubmit:  [ { hooks: [ { type: "command", command: $prompt } ] } ],
    PermissionRequest: [ { hooks: [ { type: "command", command: $permission } ] } ],
    PostToolUse:       [ { hooks: [ { type: "command", command: $complete } ] } ],
    PreToolUse:        [ { hooks: [ { type: "command", command: $pre_tool } ] } ],
    Interrupt:         [ { hooks: [ { type: "command", command: $stop, timeout: 10 } ] } ],
    SessionEnd:        [ { hooks: [ { type: "command", command: $stop, timeout: 10 } ] } ]
  }')"
else
  warp_desired='{}'
fi

tmp="$(mktemp "${HOOKS_FILE}.XXXXXX")" || exit 0
if jq --argjson d "$desired" --argjson w "$warp_desired" \
   --argjson warp_events "$warp_events" \
   --arg mark "/devd-hook.sh" --arg wmark "warp-hook.sh" --arg desc "devd agent-event hooks" '
  . as $top
  # Migrating the old shape: merge any top-level Stop/UserPromptSubmit/
  # PermissionRequest (keep foreign entries inside) into the existing .hooks,
  # then delete those top-level keys.
  | ($top.hooks // {}) as $existingHooks
  | (reduce (["Stop", "UserPromptSubmit", "PermissionRequest"][]) as $k
      ($existingHooks;
        if ($top[$k] | type) == "array"
        then .[$k] = (.[$k] // []) + $top[$k]
        else . end)
    ) as $mergedHooks
  | ($top | del(.Stop, .UserPromptSubmit, .PermissionRequest)) as $cleanedTop
  | $cleanedTop
  | (if has("description") then . else . + { description: $desc } end)
  | .hooks = (
      reduce ($warp_events[]) as $ev ($mergedHooks;
        if has($ev) or ($d | has($ev)) or ($w | has($ev)) then .[$ev] = (
          (($mergedHooks[$ev] // [])
            # Keep foreign commands even when they share a group with our hook.
            | map(.hooks = ((.hooks // []) | map(select((.command? // "")
                | (contains($wmark) or (contains($mark) and ($d | has($ev)))) | not)))
                | select(.hooks | length > 0)))
          + ($d[$ev] // []) + ($w[$ev] // [])
        ) else . end
      )
    )
' "$HOOKS_FILE" > "$tmp" 2>/dev/null; then
  mv "$tmp" "$HOOKS_FILE"
else
  rm -f "$tmp"
fi
