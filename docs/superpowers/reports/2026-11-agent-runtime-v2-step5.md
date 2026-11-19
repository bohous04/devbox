# Agent runtime v2, step 5: release (schedules, inbox shelves, PR watch, critic, images, apps)

Date: 2026-11-19. Merged as PR #65 (`fe27904`) and deployed with `devbox-update` the same evening. Live
verification found two PR watch bugs, fixed in PR #67 (`74649bc`) and PR #69 (`6249bc2`). PR #68 removed the
unused "Proxy · ChatGPT/xAI" account rows (owner decision), and PR #70 (`06b161b`) made Grok Build a live chat
agent after the owner logged it in.

## What shipped

- Schedules on the chat runtime: runtime and agent per schedule, the first turn survives a devd restart, a failed
  start ends the session but keeps a dirty worktree.
- Inbox shelves: settled (manual, or after 7 idle days) and snoozed (1 hour, tomorrow 9:00, until the active usage
  limit resets). Snoozed completions are silent. Settle and snooze are refused while a request is open (owner
  confirmed).
- PR watch for GitHub and Gitea: pending checks keep the thread in working and delay "finished"; a failure moves it
  to needs you with `ci-failed`; a merge settles it. Holds survive devd restarts and always end (60 min deadline,
  read errors, timeouts).
- The critic for chat sessions: a blocking verdict becomes an automatic follow-up turn (`origin: "critic"`,
  bridge 1.3.0) and the run counts as done only after the verdict.
- Images in chat: paste, drop or attach; Claude image blocks, Codex `localImage`, ACP image content, a visible path
  for agents without image input (bridge 1.4.0). Cleaned up when the session ends.
- The Mac listener opens a chat notification's thread in the Mac app (dashboard when the app is not installed).
- iOS: chat and inbox (SSE with replay, fixtures shared with the dashboard). New macOS app: inbox and chat split
  view, Terminal tab, menu bar count, `devbox://` links, windows restored after quit or restart, launch at login.

Containers created before the deploy keep bridge 1.2.0 until recreated: no critic there (logged), and images
answer 409 `bridge-too-old`.

## Live verification

On the deployed system, with a throwaway chat session on this repo, driven through the API.

| # | Scenario | Result |
|---|---|---|
| 1 | Pasted screenshot, read by Claude, then by Codex after a switch | PASS: both described it correctly |
| 2 | Settle, unsettle, snooze 90 s, snooze until reset without an active limit | PASS: sections as expected, snooze expired on time, until-reset refused with a clear message |
| 3 | Critic on a deliberately wrong change (`add` returned `a - b`, no test) | PASS: blocked in round 1, the follow-up turn fixed the code and added the test, one "finished" after the verdict |
| 4 | Critic on a turn without changes | PASS: not reviewed (nothing to review), finished normally |
| 5 | Chat schedule run now, `auto_end` | PASS: one "finished", the session ended on its own |
| 6 | PR watch: agent pushes to its PR, CI fails | FAIL at first (two bugs, below); PASS after #69: working · `pr-checks` while CI ran, then needs you · `ci-failed` |
| 7 | Grok Build in chat: tool turn, memory across agents, handoff back to Claude | PASS |

## Found during verification

- PR watch read `sessions.branch`, fixed at creation. A session registered on main whose agent pushed its own
  branch was never watched. Fixed in #67: the watch reads the worktree's current branch (detached HEAD skips the
  poll, shared checkouts keep their registered branch, the migration re-arms the silent seed).
- PR watch did not store the PR head: a new push on a PR that was already failing kept the old verdict and its
  time, so neither the hold nor `ci-failed` showed. Fixed in #69 (`head_sha`, a new head is a new verdict, a
  bounded 5 min grace while a new head has no check runs yet).
- A `sqlite3 .backup` of the live devd database hung for minutes while devd was writing. It was killed; devd
  logged no lock errors. Use the API for small reads.

## Design review (deployed dashboard, app code)

Findings for a follow-up, most important first: "needs you" mixes finished sessions with open questions; the
Overview page still uses the old state words; settled vs snoozed is unexplained; bare URLs are not links; a thread
does not open at its last message when images load late; tool items show raw JSON and shell wrappers; iOS ignores
Dynamic Type; the Mac app lacks keyboard shortcuts (send, Chat/Terminal, settle/snooze).

## Not verified live yet

- iOS on a device (chat, answering a question from the phone) and the Mac app (inbox, notification click, windows
  after a Mac restart): the Mac app is signed and installed, waiting for the owner to connect it.
- VPS reboot with sessions coming back: waiting for the owner's chosen time.
- Antigravity: logged in, but Google still asks to verify the account.
- A PR merge settling the thread (the test PR was closed, not merged).
