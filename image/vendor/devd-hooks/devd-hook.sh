#!/usr/bin/env bash
# Devbox agent-event emitter: POSTs Claude Code lifecycle hook events to devd,
# which turns them into precise Mac/phone notifications (done vs blocked) —
# see devd/src/agentEvents.ts.
#
# Usage (from settings.json hooks): devd-hook.sh <event>
#   events: stop | user_prompt_submit | permission_request | notification |
#           subagent_start | subagent_stop | teammate_idle | task_created | task_completed
# Reads Claude's hook JSON on stdin (fields differ per event, see the case below).
# Fire-and-forget: 2s timeout, always exits 0, never blocks Claude —
# EXCEPT `stop`, which is synchronous and waits up to ~290s for a critic verdict.
event="${1:-unknown}"
input="$(cat 2>/dev/null)"
[ -n "${DEVD_SESSION_ID:-}" ] && [ -n "${DEVD_URL:-}" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

jqr() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

# session_id is the session of THE agent loop that fired the hook — devd uses it to tell
# a teammate/subagent from the main agent (see agentEvents.ts, the foreign-session condition).
# Grok sends the same field in camelCase (`sessionId`), not `session_id` (measured 2026-08-25,
# Task 1/9) — cc sends `session_id`. The fallback covers both.
# agy (Antigravity CLI) sends the conversation id as `conversationId` (Question 6.5).
sid="$(jqr '.session_id // .sessionId // .conversationId')"
call_id="$(jqr '.tool_use_id // .tool_call_id // .toolUseId // .toolCallId')"
prompt_id="$(jqr '.prompt_id // .promptId')"
tool=""; question=""; nt=""; prompt=""; agent_type=""; task_id=""; task_subject=""; teammate=""; team=""; bg="null"; model=""
case "$event" in
  notification) nt="$(jqr '.notification_type // .notificationType')" ;;
  tool_start|tool_complete|permission_request) tool="$(jqr '.tool_name // .toolName // .tool.name')" ;;
  # agy sends the model in `modelName` (Question 6.5, Task 1 phase 5b) — devd stores it in
  # agy-sids for usage attribution via antigravityHarvester.
  session_start) model="$(jqr '.modelName // .model')" ;;
  # The critic (criticGate) needs the turn's prompt as a reference for "what the agent was asked to do".
  user_prompt_submit) prompt="$(jqr '.prompt // .user_prompt // .input')" ;;
  subagent_start|subagent_stop) agent_type="$(jqr '.agent_type')" ;;
  task_created|task_completed)
    task_id="$(jqr '.task_id')"; task_subject="$(jqr '.task_subject')"
    teammate="$(jqr '.teammate_name')"; team="$(jqr '.team_name')" ;;
  # background_tasks on Stop carries ALL kinds of in-progress work, not just the one the
  # user is waiting for — without a filter a running `bun dev &` (type "shell") would silence notifications
  # forever. We count subagent/cloud session/monitor, verified by grepping the CLI binary (type
  # map: subagent, workflow, shell, monitor, MCP task, teammate, dream, auto-mode scan,
  # cloud session).
  #
  # `monitor` was added on 2026-08-18: originally it was bundled with `shell`, but that
  # reasoning does not fit it. A monitor only PARKS the turn and is guaranteed to wake the agent
  # (it delivers a `<task-notification>` prompt) and is bounded by a timeout, so the silencing is
  # temporary — unlike `bun dev &`, which runs forever and where the agent really is
  # done. Measured live on websites/claudeSolo-2: Stop with backgroundTasks 0 while
  # a monitor was running → after 20 s "agent finished" was sent → 18 s later the
  # task-notification arrived and the agent kept working.
  #
  # `workflow` NOT ADDED YET: it most likely behaves like monitor, but it is not verified live
  # whether its entries disappear (like subagent) or stay forever (like teammate) —
  # and the latter would silence notifications permanently. Must be measured, not guessed.
  #
  # `teammate` is DELIBERATELY OMITTED from this list — on a live session with 23
  # teammates, Stop arrived with 23 entries of type teammate/running, including one finished
  # 4.5 h earlier; they never disappear (see spec, "Verified by experiment"). With teammate in the allowlist
  # a session that ever used one would never get the "finished" notification again. Teammates
  # are tracked by the `inflight` counter (SubagentStart/SubagentStop) — that is why agentEvents.ts MERGES both
  # signals (busy = backgroundTasks>0 OR inflight>0), rather than one taking precedence over the other.
  # A missing key OR a key whose value is not an array (older Claude Code, or just
  # an odd payload) we leave as null, so devd can tell "we don't know" from "nothing is running"
  # (0) — hence `type == "array"`, not just `has(...)`, which would silently count a `null`/string/object in
  # place of background_tasks as 0.
  # `first(inputs)` takes ONLY the first JSON document from stdin: several documents in a row would otherwise
  # produce multi-line output, which would break --argjson below and the whole POST (including the critic's
  # verdict) would be silently dropped.
  stop)
    bg="$(printf '%s' "$input" | jq -n -c '
      (first(inputs) // {}) as $d |
      if ($d.background_tasks | type) == "array" then
        ([$d.background_tasks[] | select(
            (.type == "subagent" or .type == "cloud session" or .type == "monitor")
            and (.status == "running" or .status == "pending")
          )] | length)
      else null end' 2>/dev/null)"
    [ -n "$bg" ] || bg="null"
    ;;
esac

# The question text goes to the Live Activity as the reason for waiting (agentEvents.ts, `reason`). Only for
# question tools and only on tool_start — the input of other tools (commands, files)
# does not belong in devd. Truncated to 300 characters; the hub trims it further to 140.
if [ "$event" = "tool_start" ]; then
  case "$tool" in
    AskUserQuestion|*[_.:/]AskUserQuestion|request_user_input|*[_.:/]request_user_input|request_user_input_async|*[_.:/]request_user_input_async|\
    ask_user|*[_.:/]ask_user|ask_user_question|*[_.:/]ask_user_question|askUser|*[_.:/]askUser)
      question="$(printf '%s' "$input" | jq -r '
        (.tool_input // .toolInput // .input // {}) | objects
        | ((.questions | arrays | .[0] | objects | .question) // .question) | strings | .[0:300]' 2>/dev/null | head -c 1200)" ;;
  esac
fi

# Adapt asynchronous questions to the existing hub's input-wait contract. Their
# PostToolUse acknowledges display, not an answer; a user prompt (or the agent's next
# tool call, see agentEvents.ts) resolves it.
# This also works with older running devd processes, without a vault-locking restart.
case "$tool" in
  request_user_input_async|*.request_user_input_async|*__request_user_input_async|*/request_user_input_async|*:request_user_input_async)
    [ "$event" != "tool_complete" ] || exit 0
    [ "$event" != "tool_start" ] || tool="request_user_input"
    ;;
esac

payload="$(jq -nc \
  --arg s "$DEVD_SESSION_ID" --arg e "$event" --arg sid "$sid" --arg nt "$nt" --arg p "$prompt" \
  --arg at "$agent_type" --arg ti "$task_id" --arg ts "$task_subject" --arg tm "$teammate" --arg tn "$team" \
  --arg call_id "$call_id" --arg prompt_id "$prompt_id" --arg tool "$tool" --arg q "$question" --argjson bg "$bg" --arg model "$model" \
  '{sessionId: $s, event: $e}
   + (if $call_id == "" then {} else {toolCallId: $call_id} end)
   + (if $prompt_id == "" then {} else {promptId: $prompt_id} end)
   + (if $tool == "" then {} else {toolName: $tool} end)
   + (if $q == "" then {} else {question: $q} end)
   + (if $sid == "" then {} else {agentSessionId: $sid} end)
   + (if $nt  == "" then {} else {notificationType: $nt} end)
   + (if $p   == "" then {} else {prompt: $p} end)
   + (if $at  == "" then {} else {agentType: $at} end)
   + (if $ti  == "" then {} else {taskId: $ti} end)
   + (if $ts  == "" then {} else {taskSubject: $ts} end)
   + (if $tm  == "" then {} else {teammateName: $tm} end)
   + (if $tn  == "" then {} else {teamName: $tn} end)
   + (if $bg  == null then {} else {backgroundTasks: $bg} end)
   + (if $model == "" then {} else {agentModel: $model} end)' 2>/dev/null)"
[ -n "$payload" ] || exit 0

# `stop` is SYNCHRONOUS: devd may return {"decision":"block","reason":…}, which Claude
# reads from stdout and continues with a fix instead of stopping (see criticGate). Other
# events remain fire-and-forget. The timeout is below the `timeout` value in settings.json.
# A separate `--connect-timeout`: 290 s is the wait for the verdict, not for the handshake — when
# a firewall silently drops SYN (2026-09-05, a session on a dind-net-* network), without it the hook hung
# for the full 290 s and the agent looked busy after finishing. An overloaded devd does not trip this,
# the kernel completes the handshake from the backlog even without the application.
if [ "$event" = "stop" ]; then
  resp="$(curl -sS --connect-timeout 3 -m 290 -X POST -H 'content-type: application/json' \
    -d "$payload" "${DEVD_URL%/}/api/agent-event" 2>/dev/null)" || exit 0
  # We print ONLY a blocking decision — neither {"ok":true} nor an error body belongs on stdout.
  printf '%s' "$resp" | jq -ce 'select(.decision == "block")' 2>/dev/null || true
  exit 0
fi

curl -sS -m 2 -X POST -H 'content-type: application/json' \
  -d "$payload" "${DEVD_URL%/}/api/agent-event" >/dev/null 2>&1 || true
exit 0
