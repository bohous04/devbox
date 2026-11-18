# Agent runtime v2, step 2: Claude and Codex chat, inbox core

Date: 2026-11-18. Merged as PR #57 (`b7919d6`), deployed with `devbox-update` the same evening. Live
verification on the VPS with the owner present (vault unlocked after each devd restart).

## Before the merge: live pass with a separate image tag

The branch image was built as its own tag next to the production image and run as two test containers in chat
runtime with the same mounts as a real session, without devd:

- Claude: a turn with usage and cost, `AskUserQuestion` with `multiSelect` (answer `red, blue` accepted), plan mode
  (`ExitPlanMode` became a `plan` request carrying the plan file's text; Approve let the agent continue),
  `docker stop` during a tool call → on start `run.interrupted` plus one `continuation` run that finished the task.
- Codex: a turn (cost is `null`, as designed) and the same stop → continuation path.
- Found and fixed before the merge (M5): after a container restart, `devbox-recovery check-ready` failed for chat
  containers because their entrypoint never ran a restore step. Chat containers now run
  `devbox-recovery restore-chat` before the bridge starts: inner Docker containers are restored (or parked for the
  monitor), the readiness marker is written and the stop intent is cleared. Verified live: `check-ready` 0 after a
  restart and the thread continued with its context.

## Scenarios on the deployed system

Two chat sessions on this repo (one Claude, one Codex), driven through the API and the dashboard (headless
browser over the SSH tunnel).

| # | Scenario | Result |
|---|---|---|
| 1 | Claude: two turns with tool calls, a question answered from the dashboard, Stop mid-turn | PASS: answer reached the agent, run `interrupted`, no item left streaming, no notification for the stop |
| 2 | Codex: two turns with a command, interrupt | PASS: usage per run, run `interrupted` |
| 3 | `ScheduleWakeup` 120 s | PASS: inbox `working (background)` during the wait, run `agent` at the wakeup time, exactly one `sweep_done sent` after it and none before |
| 4 | `devbox_wait` kind `ci` | PASS: background `declared-wait` holding, inbox `working` until `devbox_wait_done`, then `needs_you completed` |
| 5 | devd restart during a long Claude turn | PASS: the turn kept going through the restart; every step present once, no duplicate item ids |
| 6 | `docker restart` mid-turn | PASS: `Agent bridge restarted` notice, one `continuation` run that re-ran the interrupted command and finished; `check-ready` 0 |
| 7 | Terminal tab | PASS: after Take control, `pwd && git log -1` ran in `/workspace` |
| 8 | Existing tmux sessions | PASS: listed in the inbox with the `tmux` badge in the right sections |

## Found during verification

- Inbox stuck on its loading skeleton for about 25 s: Chrome fires EventSource `open` only on the first body
  bytes, and `/api/stream` without a replay sent nothing until the first ping. Fixed in PR #58: the stream starts
  with an SSE comment.
- A deploy restarts devd and aborts a session end that is running its pre-end backup at that moment; the session
  comes back as running and has to be ended again. Pre-existing, not specific to step 2.
- `notify_log` shows `stop armed unknown-main-id` for chat sessions: chat has no hook main-agent id. Cosmetic.

## Not verified live

- Codex question and plan requests (they need Codex's plan collaboration mode).
- Restoring inner Docker containers of a chat session after a host reboot (unit-tested; the test sessions had none
  running).

## Deferred (before chat becomes the default in step 6)

Trimming `events.jsonl`, fsync and shape checks on bridge state, a poison frame in the bridge log, the MCP call
timeout, the `restartAgent` open failure path and a `user_version` on thread stores, as listed in the step 2
review ledger.
