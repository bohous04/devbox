#!/usr/bin/env bash
# Vendored Warp cli-agent status emitter for devbox containers.
#
# Emits an OSC 777 `warp://cli-agent` structured event on each Claude Code
# lifecycle hook so the session state (working / waiting / blocked / done) shows
# up in the Warp tab — even though Claude runs remotely (ssh + docker) inside tmux.
#
# Mechanism: a Claude hook runs with NO controlling terminal (its stdin/stdout are
# pipes to Claude, /dev/tty can't be opened), so it cannot write to the terminal
# itself. Instead Claude Code (>= 2.1.141) writes a hook's `terminalSequence`
# stdout field to the pane for us — and, verified empirically via `pipe-pane`, it
# wraps that sequence in the tmux passthrough envelope when inside tmux. So we
# hand Claude the RAW sequence (no /dev/tty, no manual tmux wrap) and let it do
# both the writing and the wrapping. tmux still needs `allow-passthrough on`
# (set in image/tmux.conf) for the wrapped bytes to reach the outer terminal (Warp).
#
# The protocol version defaults to 1, so this does NOT depend on Warp's client env
# vars being forwarded into the container — the whole devbox is Warp-targeted.
#
# Usage (from settings.json hooks): warp-hook.sh <event>
#   events: session_start | prompt_submit | tool_complete | stop
#           | permission_request | notification
# Reads Claude's hook JSON on stdin; only session_id/cwd matter for the status.
# Writes nothing but the terminalSequence JSON on stdout; always exits 0.
#
# Second mode: warp-hook.sh --tty <event>  (Codex, Grok Build)
#   These do not have Claude Code's terminalSequence contract (Codex not measured, Grok neither),
#   so we write the sequence to the pane's tty OURSELVES: from $TMUX_PANE (the hook inherits it from the agent
#   running in tmux) we find #{pane_tty} and send OSC 777 there, manually wrapped in the tmux
#   passthrough envelope (ESC P tmux; …inner ESC doubled… ESC \). Thanks to
#   `allow-passthrough on` (image/tmux.conf) tmux unwraps it and sends it out to Warp.
#   Stdout stays EMPTY — Codex/Grok read the Stop hook's stdout as the critic's verdict
#   ({"decision":"block"} contract), any output would get in the way there.
#
#   DEVD_WARP_AGENT selects the native codex/grok identity. The Python helper
#   filters child/stale lifecycle events
#   and serializes each pane's state and terminal writes.

mode=claude
if [ "${1:-}" = "--tty" ]; then
  mode="tty"
  shift
fi
event="${1:-unknown}"
input="$(cat 2>/dev/null)"

# Grok imports Claude settings too. Its native --tty hooks own status; imported
# Claude hooks must not emit a competing CC identity or verdict-channel JSON.
if [ "$mode" = "claude" ] && printf '%s' "$input" | jq -e 'has("sessionId") or (.agent_id // "") != ""' >/dev/null 2>&1; then
  exit 0
fi

if [ "$mode" = "tty" ]; then
  [ -n "${TMUX_PANE:-}" ] || exit 0
  helper="$(dirname -- "${BASH_SOURCE[0]}")/warp-title.py"
  [ -f "$helper" ] || exit 0
  printf '%s' "$input" | timeout 3s python3 "$helper" --status "$event" >/dev/null 2>&1 || true
  exit 0
fi

# Note: `stop` (done) IS emitted — Warp draws the "done" badge in the agent list from it
# (left panel). The annoying auto-switch of focus to a finished tab is not handled here (the badge
# and the switch come from the same state, protocol v1 cannot separate them), but by Warp settings
# (see docs/mac.md) + by sessions running as independent tmux sessions (no
# shared window, so they do not shuffle each other).

jqr() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

session_id="$(jqr '.session_id // .sessionId // empty')"
cwd="$(jqr '.cwd // empty')"
[ -n "$cwd" ] || cwd="$PWD"
project="$(basename -- "$cwd" 2>/dev/null)"
[ -n "$project" ] || project="workspace"

v="${WARP_CLI_AGENT_PROTOCOL_VERSION:-1}"
case "$v" in ''|*[!0-9]*) v=1 ;; esac

# The Notification hook carries the concrete kind (e.g. idle_prompt) on stdin.
if [ "$event" = "notification" ]; then
  nt="$(jqr '.notification_type // empty')"
  [ -n "$nt" ] && event="$nt" || event="idle_prompt"
fi

# In tmux, share foreground ownership with Codex/Grok while retaining Claude's
# native terminalSequence transport. Outside tmux keep the original emitter.
helper="$(dirname -- "${BASH_SOURCE[0]}")/warp-title.py"
if [ -n "${TMUX_PANE:-}" ] && [ -f "$helper" ]; then
  printf '%s' "$input" | timeout 3s python3 "$helper" --claude-status "$event" 2>/dev/null || true
  exit 0
fi

# Non-tmux Claude still uses the existing native output contract.
if [ "$event" = "pre_tool_use" ]; then
  [ "$(jqr '.tool_name // empty')" = "AskUserQuestion" ] || exit 0
  event=permission_request
fi

payload="$(jq -nc \
  --argjson v "$v" \
  --arg event "$event" \
  --arg session_id "$session_id" \
  --arg cwd "$cwd" \
  --arg project "$project" \
  '{v:$v, agent:"claude", event:$event, session_id:$session_id, cwd:$cwd, project:$project}' 2>/dev/null)"
[ -n "$payload" ] || exit 0

esc=$(printf '\033')
bel=$(printf '\007')
seq="${esc}]777;notify;warp://cli-agent;${payload}${bel}"

# Hand Claude the raw sequence; it writes it to the pane and tmux-wraps it itself.
jq -nc --arg seq "$seq" '{terminalSequence: $seq}' 2>/dev/null || true

exit 0
