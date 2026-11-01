#!/usr/bin/env bash
# Idempotently register the devd agent-event hooks into Claude's settings.json
# (persistent shared claude-home volume — seeded at container start like
# seed-warp-hooks, with the same contract: only ever replaces its OWN prior
# entries, matched by the /devd-hook.sh command suffix, never touching other
# hooks or settings).
set -uo pipefail

# In the container the emitter is at a fixed path; tests override it via DEVD_HOOK
# (same convention as seed-codex-hooks.sh — including the safety strategy:
# own entries are recognized by the path SUFFIX /devd-hook.sh, not by the
# directory. A directory prefix would degenerate to "$HOME/" on the $HOME/devd-hook.sh
# fallback and would delete any foreign hook lying directly in $HOME).
HOOK="${DEVD_HOOK:-/opt/devd-hooks/devd-hook.sh}"
[ -x "$HOOK" ] || HOOK="${HOME}/devd-hook.sh"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

# No-op on older images without the emitter, or without jq — never fatal.
[ -x "$HOOK" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

mkdir -p "$(dirname "$SETTINGS")"
[ -s "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"

# `[ -x … ]` guard: settings.json is on the SHARED volume, so a container from
# an OLDER image (without /opt/devd-hooks) must not fail these hooks.
cmd() { printf '[ -x %s ] && %s %s || true' "$HOOK" "$HOOK" "$1"; }
desired="$(jq -nc \
  --arg pretool "$(cmd tool_start)" \
  --arg complete "$(cmd tool_complete)" \
  --arg interrupted "$(cmd interrupted)" \
  --arg failure "$(cmd stop_failure)" \
  --arg stop "$(cmd stop)" \
  --arg prompt "$(cmd user_prompt_submit)" \
  --arg permission "$(cmd permission_request)" \
  --arg notification "$(cmd notification)" \
  --arg substart "$(cmd subagent_start)" \
  --arg substop "$(cmd subagent_stop)" \
  --arg tmidle "$(cmd teammate_idle)" \
  --arg tcreated "$(cmd task_created)" \
  --arg tdone "$(cmd task_completed)" '{
  PreToolUse:        [ { hooks: [ { type: "command", command: $pretool } ] } ],
  PostToolUse:       [ { hooks: [ { type: "command", command: $complete } ] } ],
  SessionEnd:        [ { hooks: [ { type: "command", command: $interrupted } ] } ],
  PostToolUseFailure:[ { hooks: [ { type: "command", command: $complete } ] } ],
  StopFailure:       [ { hooks: [ { type: "command", command: $failure } ] } ],
  Stop:              [ { hooks: [ { type: "command", command: $stop, timeout: 300 } ] } ],
  UserPromptSubmit:  [ { hooks: [ { type: "command", command: $prompt } ] } ],
  PermissionRequest: [ { hooks: [ { type: "command", command: $permission } ] } ],
  Notification:      [ { hooks: [ { type: "command", command: $notification } ] } ],
  SubagentStart:     [ { hooks: [ { type: "command", command: $substart } ] } ],
  SubagentStop:      [ { hooks: [ { type: "command", command: $substop } ] } ],
  TeammateIdle:      [ { hooks: [ { type: "command", command: $tmidle } ] } ],
  TaskCreated:       [ { hooks: [ { type: "command", command: $tcreated } ] } ],
  TaskCompleted:     [ { hooks: [ { type: "command", command: $tdone } ] } ]
}')"
# Stop has a 300 s timeout: devd waits on it synchronously for the critic's verdict (criticGate).
# Without a critic it answers immediately, so the delay never shows.
# Notification deliberately WITHOUT a matcher (all types) — mapping/suppressing types
# is handled by devd (AgentEventHub), not the shell.
# Subagent and team events (SubagentStart/Stop, TeammateIdle, TaskCreated/Completed)
# are fire-and-forget — the in-progress work counter in devd (agentEvents.ts) only counts them,
# returns nothing, so none of them has a timeout.

tmp="$(mktemp "${SETTINGS}.XXXXXX")" || exit 0
if jq --argjson d "$desired" --arg mark "/devd-hook.sh" '
  .hooks = (
    (.hooks // {}) as $h
    | reduce ($d | keys_unsorted[]) as $ev ($h;
        .[$ev] = (
          (($h[$ev] // [])
            | map(select(((.hooks // []) | any((.command? // "") | contains($mark))) | not)))
          + $d[$ev]
        )
      )
  )
' "$SETTINGS" > "$tmp" 2>/dev/null; then
  mv "$tmp" "$SETTINGS"
else
  rm -f "$tmp"
fi
