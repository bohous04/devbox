# Agent runtime v2, step 4: ACP agents (Mistral Vibe)

Date: 2026-11-19. Merged as PR #63 (`91d9540`), deployed with `devbox-update` the same day (image +535 MB).
Before it, PR #62 removed the `claude-gpt` and `claude-grok` proxy profiles (owner decision: their upstream
models no longer worked through the proxy).

## What shipped

- A generic ACP adapter in the agent bridge (bridge 1.2.0).
- Mistral Vibe 3.1.3 in the image with its login volume `vibe-home` (backed up, copied by InstaBox), enabled in
  chat sessions only.
- Grok and Antigravity are wired with live handshake fixtures but stay disabled: Grok has no login on the
  server, and Google asks to verify the account behind Antigravity. OpenCode was skipped (no account).

## Before the merge

A check image built from the branch, run as throwaway containers with the agents' own login volumes, recorded
the live ACP fixtures: a Vibe turn with a shell tool call, a process restart with `session/load` and a second
turn that remembered the first; Grok's and Antigravity's handshakes.

## Scenarios on the deployed system

One Vibe chat session on this repo, driven through the API and checked in the dashboard (headless, desktop and
390 px).

| # | Scenario | Result |
|---|---|---|
| 1 | New Vibe chat session, a turn with a shell command | PASS: command and output as tool items, answer correct, usage recorded, devbox MCP tools visible to Vibe |
| 2 | Second turn | PASS: remembered the first turn |
| 3 | Model switch Medium 3.5 → Large 4 | PASS: `set-model`, notice, next run on the new model; an id the menu does not offer is refused (`unknown-model`) |
| 4 | Vibe → Claude | PASS: `fresh-with-handoff`, Claude answered from the handed-over context |
| 5 | Claude → Vibe | PASS: `resume-with-delta`, Vibe's own thread reopened and it knew what Claude was asked and answered |
| 6 | `docker restart` | PASS: bridge restarted, Vibe resumed its thread, `check-ready` 0 |
| 7 | Watchdog sees the agent | PASS: `ps` shows `vibe-acp` in the container |

## Found during verification

- After switching back to Vibe, `/thread/target` reports `model: null` until the bridge restarts, so the
  dashboard's model menu marks nothing current for that time. Cosmetic.
- ACP tool items whose kind is `other` (Vibe's tool discovery) show their raw input JSON in the thread.
  Cosmetic.

## Open

- Grok: log in, re-record the turn fixture, enable. Antigravity: verify the account, then detect its
  "Verification Required" reply as a failure before enabling it.
- Image attachments for ACP agents (step 5).
- Recorded in the review ledger: a failed switch whose previous target then fails to resume waits for the next
  handshake; a synchronous launch error during a switch leaves the bad target persisted (pre-existing);
  unpinned transitive dependencies of Vibe; one unidentified flaky bridge test.
