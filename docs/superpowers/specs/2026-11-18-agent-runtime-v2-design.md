# Agent runtime v2: headless agents, chat, inbox and portable handoffs

Status: design, awaiting approval · 2026-11-18

## Intent

devbox today runs every agent as a TUI inside the session's tmux. devd learns what the agent is
doing from hooks and screen scraping and steers it with `tmux send-keys`. That model has two limits the
owner wants gone, modeled on T3 Code (github.com/pingdotgg/t3code):

1. **Only sessions that need me.** The "needs you" signal fires while the agent is in fact still
   working (it parked the turn on a `ScheduleWakeup`, a workflow, a background command it waits on, or
   CI on an open PR). A list filtered by that signal is useless until the signal is trusted.
2. **Switch model, harness and subscription mid-conversation without losing context.** Switching
   accounts already resumes the conversation. Switching harness (Claude Code ↔ Codex, or to any other) starts
   from scratch (`conversationCarries` in `devd/src/agents.ts:73` is true only for claude→claude).

T3 solves both by driving agents through their structured protocols instead of their TUIs and by owning the
conversation itself. This design does the same for devbox.

## Goals (all in the first release)

1. Chat with the agent in the dashboard: streamed text, tool calls (command + output), stop.
2. Claude Code and Codex through their native protocols, with the existing multi-account support.
3. Inbox: "needs you" on top, a collapsed "working" section, a "settled" shelf.
4. Questions and approvals answered inside the chat.
5. Switch harness, model and account mid-conversation with a portable handoff.
6. Notifications on Mac and iPhone (Pushover/APNs, Live Activity) driven by the new, more accurate state.
7. A Terminal tab: a plain shell in the session's container and worktree (e.g. building and running a
   C++ school project). tmux stays for this.
8. Survive restarts: devd restarts (daily auto-deploy at 14:00), nightly agent updates and container restarts
   do not lose a conversation.
9. ACP harnesses: Grok Build, Mistral Vibe, OpenCode, Antigravity (and any ACP Registry agent).
10. Native chat in the iOS app.
11. Schedules (cron prompts) on the new runtime.
12. Settled: auto-settle after a merged PR or 7 days idle; snooze until a usage limit resets.
13. Images pasted into the chat.
14. A native Mac app: the iOS SwiftUI app built for a macOS target (chat, inbox, terminal via SwiftTerm).
    The owner does not use the CLI for overview (`dev ls`), so the Mac app is the primary desktop client;
    Warp is only for an optional shell.

## Non-goals

- T3 Connect / relay, forks, rollback/checkpoints, merge-back, subagents as separate threads. Subagents show
  inside the parent's run.
- Attaching to the agent's TUI. In a v2 session the agent has no TUI. The CLI `dev` opens the shell.
- Changing the SSH broker (`srv`), prod-db proxy, vault, backups, storage-guard. They run beside the agent and
  are not touched.
- Removing the tmux runtime in this project. See Coexistence.

## Anti-goals (a failure even if it "works")

- A devd restart or deploy kills or forgets a running turn.
- Notifications become less reliable than today, in either direction.
- Existing tmux sessions break during the transition.
- The agent loses the user's request text to make history fit (the request is never shortened).

## Constraints

- **Subscriptions, not API keys.** Agents authenticate with the logins the harness CLIs already hold
  (`CLAUDE_CONFIG_DIR` per Anthropic account, `CODEX_HOME` per Codex account). devbox never offers a login
  of its own. Anthropic's Agent SDK docs forbid third-party products from *offering* claude.ai login. devbox
  uses the CLI's own login, the same position T3 Code takes. The owner accepted this.
- **Usage metering must be measured.** T3's FAQ says Agent SDK usage used to drain the 5h limit ~1.7× faster
  than the CLI, fixed in their v0.1.7 (the change is not visible in their history; likely candidates are
  `CLAUDE_CODE_ENTRYPOINT` and using the user's own `claude` binary). The first milestone must measure
  the same prompt via the TUI and via the v2 runtime on one account before anything else builds on it.
- **devd DB:** `journal_mode=delete`, heavy readers block writers (see memory/ops notes). Conversation
  data is high-volume and must not live in the main devd DB.
- **Public repo** (Apache-2.0, English). No secrets or machine-local paths in it.
- Production is Linux. Match exact file-name casing.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Keep TUIs in tmux, add missing hook signals, a transcript-based handoff and an inbox view | Cheap (days), keeps Warp. Accuracy capped by hook snapshots; Codex has almost no hooks. |
| **B** | **Headless agents over protocols, conversation owned by devbox, chat in dashboard + iOS, shell terminal kept** | **Accurate state, clean handoff, one UI for all harnesses. Rewrites the agent core (weeks).** |
| C | B, plus "take over in terminal" (`claude --resume` in tmux on the same session id) | Most complex; two writers on one conversation must be prevented; does not work as smoothly for Codex. |

**Chosen: B** (owner's choice). The owner wants a shell terminal kept (goal 7), which B provides without C's
agent-in-terminal takeover.

## Architecture

```
dashboard / iOS ──REST + event stream──► devd ──unix socket (/run/devd/agent.sock)──► agent-bridge (in container)
                                          │                                              ├─ claude  (Agent SDK → user's claude binary)
                                          │ threads.sqlite per session                    ├─ codex app-server (stdio JSON-RPC)
                                          ▼                                              └─ ACP agent (stdio JSON-RPC)
                                      AgentEventHub → notify / Live Activity / critic
```

### agent-bridge (new, inside the session container)

A small Bun process started by `image/entrypoint.sh` instead of `agent-launch` for v2 sessions. It owns the
agent processes and translates each protocol into one devbox event stream.

**Why in the container and not in devd:** devd restarts every day (auto-deploy at 14:00) and on every fix.
If devd held the agents' stdio, each restart would kill every running turn (T3 cancels in-flight runs on restart;
that is acceptable for a desktop app, not for a server that deploys daily). The bridge survives devd restarts.
It keeps an append-only event log with sequence numbers in the control dir. devd reconnects and resumes from
its last acknowledged sequence.

Responsibilities:
- Start, resume and stop agent processes per harness adapter (below), with the env that `agent-launch.sh`
  computes today (profile env, proxy profiles, account lease, Codex account home). Port that logic. Don't
  call `agent-launch.sh`: it ends in `exec zsh` and argv prompts.
- Commands from devd: `startTurn(threadId, input, attachments)`, `interrupt`, `answer(requestId, …)`,
  `setModel`, `switchAccount`, `switchHarness` (stop current native thread, start/resume target with handoff),
  `stop`.
- Events to devd: normalized `TurnItem`s (message delta/final, tool call start/output/end, file change,
  plan, error), run status, pending requests (approval/question), pending background work, usage/context
  telemetry, native thread ids.

### Harness adapters

**Claude Code: Agent SDK `query()` with streaming input**, `pathToClaudeCodeExecutable` = the image's
`claude`. Same as T3 (`ClaudeAdapterV2.ts`). The SDK runs exactly `claude -p --input-format stream-json`,
so it is the same process the CLI's headless mode runs. The SDK provides the control protocol (`canUseTool`,
`interrupt`, `setModel`, `resume`) that we would otherwise reimplement.
- `permissionMode: bypassPermissions` (today's sessions skip permissions), but `canUseTool` is always installed
  so `AskUserQuestion` and `ExitPlanMode` become chat questions (T3 `ClaudeAdapterV2.ts`:12197-12339).
- `CLAUDE_CONFIG_DIR` from the account lease. Conversations stay in the per-session overlay
  `/home/dev/.claude/projects/-workspace` (unchanged mount), so an account switch is "close query, reopen with
  `resume` under the new config dir".
- Strip inherited `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`. Set `CLAUDE_CODE_ENTRYPOINT` per the metering
  measurement.
- Background work: track `background_tasks_changed`, `task_started`/`task_notification`, Monitor, and a synthetic
  "scheduled wakeup" task from `ScheduleWakeup` results (T3 `ClaudeAdapterV2.ts`:3697-3780, 6087-6110).
- Hooks: devd's Claude hooks (`seed-devd-hooks.sh`) are not installed for v2 sessions. State comes from the protocol.

**Codex: `codex app-server` over stdio**, one per session container (not the host-wide shared server that was
disabled on 2026-10-14 for memory reasons).
- `thread/start`, `thread/resume`, `turn/start` (per-turn model, effort), `turn/interrupt`, `turn/steer`.
  Approvals and `item/tool/requestUserInput` become chat requests.
- Policy: `approvalPolicy: never`-equivalent full access matching today's sessions (T3's "Full access":
  `granular` + `dangerFullAccess`).
- Accounts: adopt T3's shared-home + shadow-home layout (`CodexHomeLayout.ts`): `sessions/`, `sqlite/` etc.
  symlinked to one shared home, `auth.json` private per account. An account switch is then a restart with
  `thread/resume`, with no transcript copy. This replaces the copy in `codexConversationTransfer.py` for v2 sessions.
- Handoff delivery via `thread/inject_items` when supported, falling back to inline.

**ACP (Grok, Vibe, Antigravity, OpenCode, Registry agents): one generic adapter.**
- Negotiate v1/v2 by response shape (Antigravity reports v2 with a v1 shape). Methods: `session/new`,
  `session/load`|`session/resume`, `session/prompt`, `session/cancel`, `session/set_model`,
  `session/request_permission`, `session/update`.
- Per-agent quirks as small capability overrides, with T3's code as reference: Grok's launch args
  (`grok agent --always-approve stdio`), Vibe's rate-limit code `-31001`, Antigravity's client-name and mode
  limits.
- OpenCode goes through ACP, not its native HTTP server, to keep three protocols, not four.
- Each adapter declares capabilities (resume, history injection, background-task visibility, questions,
  images, live model switch). Inbox and handoff behavior read capabilities, never harness names.

### Conversation store

One SQLite file per session at `/srv/dev/_threads/<sessionId>.sqlite` (WAL), owned by devd, written from the
bridge's event stream.
- **Thread:** one per session in v1. Model `thread_id` anyway so forks can come later.
- **Run:** one per user request. Fields: provider, native thread id, status (preparing, running, waiting,
  completed, interrupted, failed), handoff id.
- **TurnItem**
- **ProviderThread:** native id, harness, account, covered run range.
- **PendingRequest**
- **ContextHandoff**

On session end the file moves with the chat archive (`chatArchive.ts`), like the Claude transcripts do today.

### Live updates

The dashboard polls every 5 s today and has no push channel except the terminal WebSocket.
- Add one event stream per client (SSE, or a WebSocket next to the terminal one). It carries thread deltas for
  the open session and inbox changes for all sessions.
- Notifications keep going through `notify()`.
- iOS uses the same stream.

### Attention model (inbox)

Sections, computed in devd and shared by dashboard, iOS and notifications:

- **Needs you:** a pending approval or question, a failed run, or a completed run with no holding background
  work. A completed run stays here until the user opens the thread, sends a message, or settles it.
- **Working:** an active run, or a settled run with *holding* background work:
  - a subagent,
  - a workflow,
  - a Monitor,
  - a pending scheduled wakeup,
  - a background command the agent declared it waits on,
  - an open PR whose CI checks are pending.

  Not holding: a background command the agent did not declare (a dev server it left running).
- **Settled:** manual, or automatic after the PR merges or after 7 days idle. A pending request, an active run,
  holding work or a snooze block auto-settle.
- **Snoozed:** until a time, or until the account's usage limit resets. Only a new question, approval or failure
  wakes it early.

Rules taken from T3 (`threadInbox.ts`, `orchestrationV2PendingBackgroundWork.ts`):
- 2 s grace before "working" ends.
- Completions are held briefly before notifying, so a run that is about to continue does not alert.
- Snoozed completions are silent.

**Declared waits:** an MCP tool `devbox_wait` (like T3's `t3_background_wait`). The agent is told in the
appended system prompt to call it before ending a turn while it waits on a background command or CI. It marks
that work as holding until it ends or a timeout passes.

**PR watch:** devd polls open PRs of the session's branch every 2 min (GitHub via `gh` token, Gitea via its API)
while checks are pending. A merged PR settles the thread.

**AgentEventHub:** the bridge's events are mapped to the hub's existing `AgentEvent` inputs, so `notify_log`,
Live Activity, stuck detection and `/notifications` keep working.
- The hub's "done" becomes "run completed and no holding work".
- The critic runs on run completion. A block is sent back as an automatic follow-up message, replacing the Stop
  hook's `{"decision":"block"}`.

### Portable handoff (harness / account / model switch)

Follow T3's algorithm (`handoffBudget.ts`, `ContextHandoffService.ts`, `ContextHandoffDelivery.ts`):

- **Transition plan:**
  - The same harness and continuation home can resume or switch the model in session (Claude `setModel`,
    Codex per-turn model).
  - An account switch means restart and resume.
  - A different harness creates a target thread with a handoff.
  - Returning to a harness used earlier resumes its old native thread with a **delta** handoff covering only the
    runs it missed. It starts fresh with a full handoff when resume fails or the old thread is stale.
- **Selection, not summary:** user/assistant messages, command executions, errors, file changes (paths only)
  and plans. Order: the latest user message, the latest assistant message, the first user message, then the rest
  newest-first while it fits. Messages are kept whole.
- **Budget:** `min(cap 16k, 64 KB, window − used − input − reserve)`, charging 1 token per UTF-8 byte.
- **Delivery:** Codex `thread/inject_items`; otherwise a context preamble before `User message:\n<text>`. The
  user's request is never shortened. If it does not fit, retry into a fresh native thread.
- **Omitted history:** an MCP tool `devbox_thread_read` (like `t3_thread_read`) lets the agent page through the
  full stored thread.

The bridge serves the devbox MCP server (`devbox_wait`, `devbox_thread_read`) to every adapter. Claude uses
`setMcpServers`, Codex uses config, and ACP uses the MCP capability it advertises (stdio as the floor).

### Restarts

- **devd restart / deploy:** the bridge and agents keep running, and devd reconnects and replays from the
  bridge's log.
- **Bridge or container restart** (image update, OOM, host reboot):
  - The bridge resumes each native thread.
  - A run that was mid-turn gets one automatic continuation message ("your last turn was cut short; check
    whether its last action took effect"), at most 3 in 5 minutes (T3 `RestartContinuation.ts`).
  - Pending requests expire and are re-asked by the agent on continuation.
- **Nightly agent updates:** binaries update in the image. The bridge restarts an agent process only when its
  thread is idle, and resumes it. This replaces `restartPane` and screen scraping for v2 sessions.

### Clients

- **Dashboard:**
  - A session view with Chat and Terminal tabs.
  - The inbox replaces the flat sessions list as the default view.
  - Questions and approvals render as inline forms.
  - Switchers for model, harness and account sit in the composer.
  - Images go into the composer by paste or drop. The bridge sends them as image blocks (Claude), data-URL items
    (Codex), or ACP image content, falling back to a path under `/inbox`.
- **iOS:**
  - A native SwiftUI chat screen and inbox on the same REST and event stream.
  - Answering a question or approval from the app.
  - Push and Live Activity as today, driven by the new state.
- **Mac app:** a macOS target of the iOS app (SwiftUI multiplatform), with the same screens laid out for a large
  window. It handles notifications natively, and a click opens the thread.
- **Terminal tab / `dev` CLI:** tmux in a v2 container contains shells only. `dev <repo>` attaches a shell (Warp
  stays optional for that). No inbox in the CLI: `dev ls` is not extended.
- **Mac notifications:** for v2 sessions a click opens the thread in the Mac app (dashboard as fallback) instead
  of focusing a Warp tab.
- **Schedules:** start a run through the bridge instead of the prompt file. The rest is unchanged: a new session
  per schedule, skip if the repo has a running session, `autoEnd` on completion.

### Coexistence and migration

- `sessions.runtime` is `tmux | chat`, chosen at session creation; the default stays `tmux` until v2 is
  verified. Then the default flips.
- Running tmux sessions live out their life unchanged; no live migration.
- All tmux-only machinery (`ccUpkeep.restartPane`, `codexConversation`, hooks, `apiErrorRetry`,
  `devbox-recovery`, `devbox-ctrlv`) stays for tmux sessions. Removing it is a separate decision after the
  default flips.

## Delivery order

Each step ships to `main` once verified. tmux remains available throughout.

1. **Spike + metering:** bridge with the Claude adapter, one chat in the dashboard. Measure 5h-limit
   drain against the TUI on the same prompt. Stop and report if it is worse.
2. Core:
   - Claude and Codex adapters
   - the conversation store
   - the event stream
   - chat UI
   - inbox with background-work tracking
   - `devbox_wait`
   - notifications through the hub
   - Terminal tab
   - restart survival
3. Switching: model, account (Claude resume, Codex shadow home), harness with handoff, and `devbox_thread_read`.
4. ACP adapter, then Grok, Vibe, Antigravity and OpenCode, each verified live.
5. Rest of the first release:
   - iOS chat, then the macOS target of the same app
   - schedules
   - settled + PR watch + snooze
   - images
   - critic on run completion
6. Flip the default runtime to `chat`.

## Decisions after the builder check

T3 references: `ClaudeAdapterV2.ts` and every other T3 path are pinned to t3code commit `eebb6bcc`
(2026-11-18).

- **One agent per session (owner).** One chat per container. Parallel agents in other tmux windows are not
  supported in v2. A session has exactly one thread in v1.
- **Metering gate (owner-approved).**
  - Method: on one account, run the same task 5× through the TUI and 5× through the v2 runtime, and compare
    the rise in `fiveHourPct` from the account poller.
  - Gate: if v2 is more than 15 % more expensive on average, stop and report before step 2.
- **InstaBox (owner).** Out of scope: v2 does not support it. The owner plans to remove InstaBox from devbox
  altogether as a separate task. Until then, creating a `chat` session on InstaBox is blocked the same way
  `instaboxAgentBlock` blocks proxy profiles.
- **tmux sessions in the inbox (designer's call).** The inbox lists every session. tmux sessions carry a
  "tmux" badge and are placed by today's hook-derived hub state. The inbox becomes the default view in step 2.
- **Codex homes (designer's call).**
  - Never copy `auth.json`. A v2 session uses the account's own auth file in place (bind mount or symlink),
    so token refresh is seen by tmux and v2 sessions alike.
  - The shared-history layout (`sessions/`, `sqlite/` shared, auth per account) applies only to v2 sessions.
  - Existing per-account volumes used by tmux sessions are not restructured.
  - The builder must confirm that concurrent `codex app-server` processes on one shared home are safe, the way
    concurrent TUIs on one account volume are today. If they are not, keep per-account homes and copy the thread on
    account switch, as `codexConversationTransfer.py` does today.

## Left to the builder

- The exact event schema, table columns and wire format between bridge and devd.
- SSE vs WebSocket for the client event stream.
- UI layout details within the sections above, following the existing dashboard style.
- How capability overrides are expressed per ACP agent.
- Exact wording of the appended system prompt (`devbox_wait`, `devbox_thread_read`) and the continuation message.
