#!/usr/bin/env bash
# Idempotently register the vendored Warp cli-agent status hooks into Claude's
# settings.json (which lives in the persistent, shared claude-home volume — so it
# masks anything baked into the image, hence we seed at runtime).
# With these hooks a fresh Claude session emits OSC 777 status events that light
# up the session's state in the Warp tab.
#
# Safe to run on every container start; only ever
# replaces its OWN prior entries (matched by the /opt/warp-hooks/ command path
# or its explicit devd-warp-hook marker),
# never touching other hooks or settings the user added.
set -uo pipefail

HOOK="${WARP_HOOK:-/opt/warp-hooks/warp-hook.sh}"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

# Nothing to seed if the vendored emitter isn't in the image (older build), or jq
# is missing — never fatal to the container boot.
[ -x "$HOOK" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

mkdir -p "$(dirname "$SETTINGS")"
[ -s "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

# One entry per Claude hook event. The command is guarded with `[ -x … ]` so it
# is a clean no-op when the binary is absent — critical because settings.json
# lives in the SHARED claude-home volume, so a container running an OLDER image
# (without /opt/warp-hooks) would otherwise fail every SessionStart hook.
cmd() { printf '[ -x %s ] && %s %s || true # devd-warp-hook' "$HOOK" "$HOOK" "$1"; }
desired="$(jq -nc \
  --arg session_start "$(cmd session_start)" \
  --arg prompt_submit "$(cmd prompt_submit)" \
  --arg tool_complete "$(cmd tool_complete)" \
  --arg pre_tool "$(cmd pre_tool_use)" \
  --arg failure "$(cmd stop_failure)" \
  --arg stop "$(cmd stop)" \
  --arg notification "$(cmd notification)" \
  --arg permission_request "$(cmd permission_request)" '{
  SessionStart:      [ { matcher: "startup|resume", hooks: [ { type: "command", command: $session_start } ] } ],
  UserPromptSubmit:  [ {                            hooks: [ { type: "command", command: $prompt_submit } ] } ],
  PreToolUse:        [ {                            hooks: [ { type: "command", command: $pre_tool } ] } ],
  PostToolUseFailure:[ {                            hooks: [ { type: "command", command: $tool_complete } ] } ],
  StopFailure:       [ {                            hooks: [ { type: "command", command: $failure } ] } ],
  PostToolUse:       [ {                            hooks: [ { type: "command", command: $tool_complete } ] } ],
  Stop:              [ {                            hooks: [ { type: "command", command: $stop } ] } ],
  Notification:      [ { matcher: "idle_prompt",    hooks: [ { type: "command", command: $notification } ] } ],
  PermissionRequest: [ {                            hooks: [ { type: "command", command: $permission_request } ] } ]
}')"

# For each event: drop our prior command (matched by the legacy hook directory
# or explicit marker), then append the current desired one.
# Leaves foreign hooks (other commands) untouched.
tmp="$(mktemp "${SETTINGS}.XXXXXX")" || exit 0
if jq --argjson d "$desired" --arg mark "/opt/warp-hooks/" --arg own "# devd-warp-hook" '
  .hooks = (
    (.hooks // {}) as $h
    | reduce ($d | keys_unsorted[]) as $ev ($h;
        .[$ev] = (
          (($h[$ev] // [])
            | map(.hooks = ((.hooks // []) | map(select((.command? // "") | (contains($mark) or contains($own)) | not)))
                | select(.hooks | length > 0)))
          + $d[$ev]
        )
      )
  )
' "$SETTINGS" > "$tmp" 2>/dev/null; then
  mv "$tmp" "$SETTINGS"
else
  rm -f "$tmp"
fi
