#!/usr/bin/env bash
# agy-hook.sh <SessionStart|PreInvocation|Stop> — adapter from Antigravity CLI hooks to
# devd-hook.sh (the neighboring file). The agy contract (built-in documentation + measurements,
# the Antigravity research notes, Question 6.5): JSON on stdin (camelCase), JSON on
# stdout. So this script ALWAYS prints one line of JSON and exits 0 — whether devd is running
# or not, whether the emitter is on this image or not (hooks.json is on a shared volume).
#
# Mapping:
#   SessionStart                 → session_start
#   PreInvocation invocationNum 0 → user_prompt_submit (agy resets it with every prompt)
#                                   + session_start (current modelName, see below)
#   PreInvocation invocationNum>0 → tool_complete — heartbeat: PreInvocation runs before
#                                   every model call, so stuck detection in devd
#                                   (20 min of hook silence) does not falsely flag a long turn
#   Stop                         → stop (synchronous); critic `block` → agy `continue`
# Warp gets every event too (warp-hook.sh --tty, DEVD_WARP_AGENT=agy): tab state
# + checkpoint for devbox-recovery (restore via `--conversation=<conversationId>`).
# PreToolUse is deliberately NOT USED: agy reads a reply without `decision` as a tool denial.
ev="${1:-}"
input="$(cat 2>/dev/null)"
HOOK="${DEVD_HOOK:-$(dirname "$0")/devd-hook.sh}"
out='{}'
emit() { [ -x "$HOOK" ] && printf '%s' "$input" | "$HOOK" "$1" 2>/dev/null; }
# PreInvocation runs before EVERY model call — devd-hook.sh does have its own
# curl -m 2, but even those 2 s (lost packets to devd) would otherwise add up in the latency
# of every turn. session_start/user_prompt_submit/tool_complete therefore run in the
# background, fully detached from the adapter's stdout/stderr. Stop stays synchronous:
# it needs the critic's verdict in `resp` below.
#
# The redirect MUST apply to the whole backgrounded group `( … )`, not just the last
# part of the pipe: `cmd | hook >/dev/null &` redirects only `hook`, but the process that drives
# the `&&`/pipe here (and waits for $HOOK) keeps the inherited fd 1/2 pointing to
# the ADAPTER's stdout/stderr for the full 3 s (sleep) — verified live, a test failed on it.
# `( … ) >/dev/null 2>&1 &` redirects fd 1/2 already in the fork of that group, so
# the adapter's stdout gets EOF immediately, not only after the hook finishes.
emit_bg() { ( [ -x "$HOOK" ] && printf '%s' "$input" | "$HOOK" "$1" ) >/dev/null 2>&1 & }
# Warp tab state + checkpoint for devbox-recovery. warp-title.py reads `session_id`,
# agy sends `conversationId` — we fill it in. Same rule as emit_bg: the whole
# group in the background with fd 1/2 to /dev/null (stdout belongs to the verdict, agy waits for it
# before every model call). For Stop too: the Warp state need not finish before
# the verdict, so a slow/failing Warp hook cannot affect it.
WARP_HOOK="${WARP_HOOK:-/opt/warp-hooks/warp-hook.sh}"
warp_bg() {
  ( [ -x "$WARP_HOOK" ] \
      && printf '%s' "$input" | jq -c '. + {session_id: (.conversationId // .session_id // "")}' \
      | DEVD_WARP_AGENT=agy "$WARP_HOOK" --tty "$1" ) >/dev/null 2>&1 &
}
case "$ev" in
  SessionStart)
    # SessionStart arrives only from a conversation, i.e. AFTER agy onboarding (colors, consent to
    # data collection, trust). The marker tells agent-launch that the first prompt will no longer land in the menu.
    # But hooks.json is on the shared antigravity-home volume — the LOGIN container
    # (devbox-agy-login) also runs on it, and it never gets DEVD_SESSION_ID (no
    # conversation). Without this condition its agy would create the marker before the user
    # even saw onboarding, and a scheduled prompt would run through the menu including the consent.
    if [ -n "${DEVD_SESSION_ID:-}" ]; then
      mkdir -p "${AGY_HOME:-$HOME/.gemini/antigravity-cli}" 2>/dev/null && : > "${AGY_HOME:-$HOME/.gemini/antigravity-cli}/.devbox-onboarded" 2>/dev/null
    fi
    emit_bg session_start; warp_bg session_start ;;
  PreInvocation)
    n="$(printf '%s' "$input" | jq -r '.invocationNum // empty' 2>/dev/null)"
    # A new prompt announces the conversation again (session_start) — PreInvocation carries the current
    # `modelName` and the user switches it between prompts with `/model`; devd keeps a history
    # of models for usage pricing (api.ts, antigravityHarvester.modelAt). Within a prompt
    # the model does not change, hence only for invocationNum 0.
    if [ "$n" = 0 ]; then emit_bg user_prompt_submit; emit_bg session_start; warp_bg prompt_submit
    else emit_bg tool_complete; warp_bg tool_complete; fi ;;
  Stop)
    resp="$(emit stop)"
    reason="$(printf '%s' "$resp" | jq -r 'select(.decision == "block") | .reason // empty' 2>/dev/null)"
    # Warp `stop` only at a real end. After `continue` agy keeps working, but the next
    # PreInvocation has invocationNum > 0 (only a new prompt resets it) → tool_complete,
    # which warp-title.py discards after `stop`: the tab would show "done" and the checkpoint would stay
    # inactive, so recovery after a crash would not pick up the continuation.
    if [ -n "$reason" ]; then out="$(jq -nc --arg r "$reason" '{decision: "continue", reason: $r}' 2>/dev/null || echo '{}')"
    else warp_bg stop; fi ;;
esac
printf '%s\n' "$out"
exit 0
