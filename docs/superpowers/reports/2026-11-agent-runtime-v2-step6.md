# Agent runtime v2, step 6: default runtime setting and chat-runtime hardening

Date: 2026-11-19. Merged as PR #72 (`4dedb91`) and deployed with `devbox-update` the same night (image rebuilt,
agent bridge 1.5.0). The code default stays `tmux`: flipping `Settings → Default runtime` to `chat` is the owner's
action, after the checks under "Before the flip".

## What shipped

- `defaultRuntime` setting in the config repo, read per request. With no runtime named, sessions and new schedules
  use it. When the agent can't run in that runtime the other one is used and the response carries `runtimeNotice`,
  which the dashboard, iOS and the `dev` CLI show. InstaBox stays tmux with a notice, solo stays tmux. Stored
  schedule runtimes are never rewritten.
- A request without a runtime joins a running session of either runtime first, so no second container starts next
  to a live session.
- Dashboard: the Inbox is the home page, Overview moved to `/overview`; New session and New schedule start from the
  default and list the repo's sessions of both runtimes.
- `dev <repo>` on a chat session attaches the shell and shows the chat links (before attaching and as a tmux
  message).
- Hardening deferred from step 2: the bridge's event log is read from the tail, replayed as a stream and trimmed one
  acknowledgement behind (at least 10 minutes old, confirmed by devd, which acks only what its store has
  checkpointed to disk); `state.json` is written durably and rebuilt with a visible notice when damaged; runs left
  open by a crash are ended; MCP calls time out; a frame devd cannot apply three times in the same way is skipped
  with a notice; thread stores carry a schema version.

## Live verification (default left on tmux)

| # | Scenario | Result |
|---|---|---|
| 1 | New chat session reports bridge 1.5.0; older sessions show one "older bridge" notice | PASS |
| 2 | `docker restart` mid-command on bridge 1.5.0 | PASS: "Agent bridge restarted (v1.5.0)", run `interrupted`, one continuation that ran the command to the end |
| 3 | Request without a runtime on a repo with a running chat session (default tmux) | PASS: joined it, no second container |
| 4 | Vibe with no runtime named (default tmux) | PASS: chat, with "Mistral Vibe runs only in chat sessions, so this session runs in chat" |
| 5 | Dashboard home | PASS: `/` is the Inbox, `/inbox` redirects to `/`, Overview at `/overview` |
| 6 | Periodic ack from devd to a 1.5.0 bridge | PASS: about 10 minutes later the bridge's trim point reached the thread's last seq (36) on the same link, with no reconnect |

## Before the flip

- Mac app connected and checked (inbox, notification click, windows after a Mac restart), iOS on a device: the
  owner's part.
- A VPS reboot with chat sessions running, at a time the owner picks.
- `dev <repo>` on a chat session in a real terminal: the link line and the tmux message.
- The proxy profiles (`claude-gemini`, `claude-openrouter`) are allowed in chat but no live chat turn is recorded
  with them.
- A scheduled chat run on a repo that has a running tmux session starts its own container (schedules name their
  runtime, so they do not join across runtimes). After the flip, new schedules store `chat`.
- After the flip, `dev <repo>` on a repo with only a stopped tmux session resumes that tmux session (it joins an
  existing session before creating one).

Close DEVBOX-24 after a week of chat-default use without regressions.
