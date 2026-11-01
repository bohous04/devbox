#!/usr/bin/env bash
# Idempotently writes devd agent-event hooks into Grok, into its OWN file on the shared
# grok-home volume: ${GROK_HOME:-$HOME/.grok}/hooks/devd.json.
#
# MIND THE PATH: grok NEVER reads `~/.grok/hooks.json` and stays silent about it even under --debug
# (measured in Task 7, the Grok research notes (2026-08-20), question 3). In reality
# grok scans the whole `~/.grok/hooks/` DIRECTORY, any arbitrarily named *.json files inside.
# Thanks to that we have our own file (devd.json) instead of a shared hooks.json like Codex — foreign
# hooks live in other files of the same directory, so they cannot be overwritten by mistake, and the
# jq merge logic from seed-codex-hooks.sh goes away too (it exists only because of SHARING one file).
#
# Events nested under the top-level `hooks` key, same as Claude/Codex — a flat shape
# ({"Stop": [...]} without the envelope) grok SILENTLY discards, with no error message, even under --debug.
#
# Global hooks (~/.grok/hooks/) are "always trusted" according to the built-in documentation —
# the project trust gate (`projectTrusted`) does not concern us, we do not use the project level.
#
# Grok normalizes CamelCase event names. SessionStart, UserPromptSubmit,
# PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, StopCancelled,
# SessionEnd and Notification verified via `grok inspect --json` with an isolated
# HOME/GROK_HOME on 1.0.5 and 1.0.25 (2026-09-10). PermissionRequest stays for
# compatibility, but these versions ignore it; Warp therefore catches waiting via
# Notification, and blocking questions also via PreToolUse (the emitter filters toolName).
#
# SessionStart is additional (Task 9, measured 2026-08-25): it works under the `SessionStart` key
# the same as `session_start`, grok normalizes it internally. It does not serve notifications,
# only grok usage attribution — it maps the sid (grokHarvester reads unified.jsonl) to the devbox
# session, see api.ts /api/agent-event.
set -uo pipefail

HOOK="${DEVD_HOOK:-/opt/devd-hooks/devd-hook.sh}"
WARP_HOOK="${WARP_HOOK:-/opt/warp-hooks/warp-hook.sh}"
HOOKS_DIR="${GROK_HOME:-$HOME/.grok}/hooks"
HOOKS_FILE="$HOOKS_DIR/devd.json"
WARP_FILE="$HOOKS_DIR/warp.json"

# No-op on an older image without the emitter or without jq — never fatal.
[ -x "$HOOK" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# We only get here when both the emitter and jq exist — so any mkdir failure is
# a REAL error, not a legitimate no-op on an older image (the two guards above handle that).
# In practice it is EACCES on a shared grok-home volume that was created root:root (the image
# before the fix did not create /home/dev/.grok, so docker made the new volume for
# root). A silent `exit 0` here meant a Grok session WITHOUT devd hooks — i.e. no
# "done"/"⏸ waiting" notifications — and not a word about why anywhere. It still must not be fatal,
# the session has to start; one sentence naming the cause and the consequence is enough.
if ! mkdir -p "$HOOKS_DIR" 2>/dev/null; then
  echo "seed-grok-hooks: cannot write to $HOOKS_DIR (permissions?) — the Grok session will run WITHOUT devd hooks." >&2
  exit 0
fi

# Guard `[ -x … ]`: the file is on a SHARED volume, so a container from an older image
# (without /opt/devd-hooks) must not fail on these hooks.
cmd() { printf '[ -x %s ] && %s %s || true' "$HOOK" "$HOOK" "$1"; }

# The file is purely ours (the name devd.json distinguishes it from foreign *.json in the directory), so
# unlike Claude/Codex we do not merge it with previous content — we just rewrite it whole,
# deterministically and atomically.
tmp="$(mktemp "${HOOKS_FILE}.XXXXXX")" || exit 0
if jq -n \
  --arg sstart "$(cmd session_start)" \
  --arg pretool "$(cmd tool_start)" \
  --arg complete "$(cmd tool_complete)" \
  --arg interrupted "$(cmd interrupted)" \
  --arg failure "$(cmd stop_failure)" \
  --arg notification "$(cmd notification)" \
  --arg stop "$(cmd stop)" \
  --arg prompt "$(cmd user_prompt_submit)" \
  --arg permission "$(cmd permission_request)" \
  --arg desc "devd agent-event hooks" '{
  description: $desc,
  hooks: {
    SessionStart:      [ { hooks: [ { type: "command", command: $sstart } ] } ],
    PreToolUse:        [ { hooks: [ { type: "command", command: $pretool } ] } ],
  PostToolUse:       [ { hooks: [ { type: "command", command: $complete } ] } ],
  SessionEnd:        [ { hooks: [ { type: "command", command: $interrupted } ] } ],
  PostToolUseFailure:[ { hooks: [ { type: "command", command: $complete } ] } ],
  StopFailure:       [ { hooks: [ { type: "command", command: $failure } ] } ],
  Notification:      [ { hooks: [ { type: "command", command: $notification } ] } ],
  StopCancelled:     [ { hooks: [ { type: "command", command: $interrupted } ] } ],
  Stop:              [ { hooks: [ { type: "command", command: $stop, timeout: 300 } ] } ],
    UserPromptSubmit:  [ { hooks: [ { type: "command", command: $prompt } ] } ],
    PermissionRequest: [ { hooks: [ { type: "command", command: $permission } ] } ]
  }
}' > "$tmp" 2>/dev/null; then
  mv "$tmp" "$HOOKS_FILE"
else
  rm -f "$tmp"
fi

# Warp tab status: a second own file (warp.json) in the same scanned directory.
# Grok does not have Claude Code's measured terminalSequence contract, so warp-hook.sh runs
# in --tty mode and writes OSC 777 to the pane's tty itself (see vendor/warp-hooks).
# Guard for older images without /opt/warp-hooks: the seed is skipped (the file is not created) and
# the commands inside are additionally `[ -x … ] || true`, so even an existing warp.json
# on an old image breaks nothing.
[ -x "$WARP_HOOK" ] || exit 0
wcmd() { printf '[ -x %s ] && DEVD_WARP_AGENT=grok %s --tty %s || true' "$WARP_HOOK" "$WARP_HOOK" "$1"; }
tmp="$(mktemp "${WARP_FILE}.XXXXXX")" || exit 0
if jq -n \
  --arg start "$(wcmd session_start)" \
  --arg stop "$(wcmd stop)" \
  --arg failure "$(wcmd stop_failure)" \
  --arg prompt "$(wcmd prompt_submit)" \
  --arg permission "$(wcmd permission_request)" \
  --arg idle "$(wcmd idle_prompt)" \
  --arg pretool "$(wcmd pre_tool_use)" \
  --arg complete "$(wcmd tool_complete)" \
  --arg desc "Warp cli-agent status hooks" '{
  description: $desc,
  hooks: {
    SessionStart:       [ { hooks: [ { type: "command", command: $start } ] } ],
    Stop:               [ { hooks: [ { type: "command", command: $stop } ] } ],
    StopFailure:        [ { hooks: [ { type: "command", command: $failure } ] } ],
    StopCancelled:      [ { hooks: [ { type: "command", command: $stop } ] } ],
    SessionEnd:         [ { hooks: [ { type: "command", command: $stop } ] } ],
    UserPromptSubmit:   [ { hooks: [ { type: "command", command: $prompt } ] } ],
    PermissionRequest:  [ { hooks: [ { type: "command", command: $permission } ] } ],
    PreToolUse:         [ { hooks: [ { type: "command", command: $pretool } ] } ],
    PostToolUse:        [ { hooks: [ { type: "command", command: $complete } ] } ],
    PostToolUseFailure: [ { hooks: [ { type: "command", command: $complete } ] } ],
    Notification: [
      { matcher: "idle_prompt", hooks: [ { type: "command", command: $idle } ] },
      { matcher: "permission_prompt|elicitation_dialog", hooks: [ { type: "command", command: $permission } ] }
    ]
  }
}' > "$tmp" 2>/dev/null; then
  mv "$tmp" "$WARP_FILE"
else
  rm -f "$tmp"
fi
