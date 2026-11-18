# Agent runtime v2, step 5: iOS and Mac apps, schedules, settled/snooze/PR watch, images, critic. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rest of the first release: native chat and inbox in the iOS app and in a macOS target of the same app
(the owner's primary desktop client), schedules on the chat runtime, the settled shelf with snooze and PR watch,
images in the composer, and the critic on run completion.

**Architecture:** Clients use step 2's REST + SSE API. Settled/snooze state is small per-session metadata in the main
devd DB (`session_attention`), read by `inbox.ts`. PR watch is a devd poller using `gh` (GitHub) and the Gitea API.
The critic reuses `criticGate.ts`, triggered by `run.started`/`run.completed` instead of hooks.

**Tech Stack:** SwiftUI (iOS 17, macOS 14 target via XcodeGen `ios/project.yml`), SwiftTerm 1.20.0, existing devd
modules (`scheduler.ts`, `criticGate.ts`, `unpushed.ts`, `gitea.ts`, `apns.ts`, `listener/`).

**Spec:** `docs/superpowers/specs/2026-11-18-agent-runtime-v2-design.md` (Goals 6, 10–14; Attention model
Settled/Snoozed/PR watch; Clients). Requires steps 2–4.

## Global Constraints

- Everything in step 2's Global Constraints.
- Settled: manual, or automatic after the PR merges or after 7 days idle. A pending request, an active run,
  holding work or a snooze block auto-settle.
- Snoozed: until a time, or until the account's usage limit resets. Only a new question, approval or failure wakes
  it early. Snoozed completions are silent.
- PR watch: every 2 min while checks are pending (GitHub via the `gh` token, Gitea via its API). A merged PR settles
  the thread. An open PR with pending checks is holding work ("working").
- Schedules: a new session per schedule, skip if the repo has a running session, `autoEnd` on completion; the run
  starts through the bridge instead of the prompt file.
- Images: Claude image blocks, Codex data-URL items, ACP image content, else a path under `/inbox`.
- The critic block becomes an automatic follow-up message (replacing the Stop hook's `{"decision":"block"}`).
- iOS bundle prefix and signing stay as in `ios/project.yml`; nothing personal is committed.

## Review Focus

1. **Snoozed until a usage reset on an account that has no 5-hour meter** (most pool accounts report only weekly
   limits). The snooze uses the limit that is actually active (`limits[].isActive`) and its `resetsAt`; with none,
   the "until reset" choice is disabled with a reason. Test: Task 5 "until-reset uses the active limit".
2. **A PR is merged while the agent is still working on review comments.** Merged settles only when no run is
   active and nothing holds; otherwise it settles at the next idle moment. Test: Task 6 "merge during an active
   run settles after it".
3. **The SSE stream drops on iOS when the app is backgrounded.** On foreground the app refetches thread
   `afterSeq` and inbox, then resubscribes. Test: Task 1 `ThreadStoreTests` "resume after background fetches
   afterSeq".
4. **A schedule fires while the image is updating or the bridge is not yet connected.** The first message waits for
   `connected` (up to 120 s) and fails the schedule visibly if it never connects. Test: Task 4 "schedule waits for
   the bridge, fails visibly on timeout".
5. **A pasted image larger than the agent accepts** (Claude ~5 MB per image). Downscale on the client to ≤ 2048 px
   and ≤ 4 MB JPEG/PNG; reject with a message above 20 MB input. Test: Task 7 "oversized image is downscaled,
   huge one rejected".

---

### Task 1: iOS chat and inbox

**Files:** Create `ios/DevboxApp/Api/EventStream.swift`, `ios/DevboxApp/Stores/ThreadStore.swift`,
`ios/DevboxApp/Stores/InboxStore.swift`, `ios/DevboxApp/Screens/InboxScreen.swift`,
`ios/DevboxApp/Screens/ChatScreen.swift`, `ios/DevboxApp/Screens/Chat/*` (message, tool call, request form,
composer); modify `DevdClient.swift` (thread/inbox calls on both CF and tailnet paths), `Models.swift`,
`AppNavigation.swift` (`devbox://thread/<id>`), root tab view (Inbox first); tests
`ios/DevboxAppTests/{EventStreamTests,ThreadStoreTests,InboxStoreTests}.swift` with JSON fixtures copied from
devd test output.

**Interfaces:** `ThreadStore.apply(_ e: LoggedEvent)` mirrors `dashboard/src/threadView.ts` exactly (same fixture
file drives both test suites); `EventStream` parses SSE (`event:`/`data:`/`id:` lines, reconnect with
`Last-Event-ID`).
- [ ] **Step 1: Tests:** SSE parsing incl. multi-line data and reconnect id; `ThreadStore` deltas/final/duplicate
  seq/request resolved; "resume after background fetches afterSeq"; inbox grouping.
- [ ] **Step 2–4:** FAIL → implement → PASS (`xcodebuild test -scheme DevboxApp -destination 'platform=iOS
  Simulator,name=iPhone 16'` on the Mac).
- [ ] **Step 5:** Live E2E (`DEVBOX_LIVE_TESTS=1`): open a chat session, send a message, answer a question.
- [ ] **Step 6:** Push: a notification for a chat session opens `devbox://thread/<id>`. Commit
  `feat(ios): chat and inbox`.

### Task 2: macOS target

**Files:** Modify `ios/project.yml` (target `DevboxMac`, `platform: macOS`, deployment 14.0, sources `DevboxApp` +
`Shared`, excluding iOS-only files listed explicitly; SwiftTerm macOS view), `#if os(macOS)` only where an API
differs (push registration, `UIApplication` → `NSApplication`, terminal view); create
`ios/DevboxMac/{DevboxMac.entitlements,Info.plist}`; tests run the shared test target against both platforms.

Layout: `NavigationSplitView` (sidebar = inbox sections, detail = chat with a Terminal tab), notifications via
`UNUserNotificationCenter` (APNs for macOS with the same `/api/push/register`, `platform:"macos"`), a click opens the
thread. Menu bar extra with the needs-you count.
- [ ] **Step 1:** Make the shared tests compile and pass for macOS (`xcodebuild test -scheme DevboxMac`).
- [ ] **Step 2:** Implement the target and layout. **Step 3:** Owner signs and runs it once; screenshot evidence.
- [ ] **Step 4:** devd `apns.ts`/`pushChannel.ts` accept `platform:"macos"` (test). Commit `feat(mac): macOS app target`.

### Task 3: Mac notification click opens the thread

**Files:** Modify `listener/src/actions.ts` (for `runtime:"chat"` sessions open `devbox://thread/<id>`, falling back
to the dashboard URL `/#/s/<id>` when the app is not installed — this fallback is approved by the spec, "dashboard as
fallback"), `devd/src/notify.ts` (`NotifyExtra.session` carries `runtime`; Pushover URL `?thread=<id>` for chat
sessions); tests in `listener/` and `devd/test/notify.test.ts`.
- [ ] Tests → implement → PASS. Commit `feat: notification click opens the chat thread`.

### Task 4: Schedules on the chat runtime

**Files:** Modify `devd/src/db.ts` (`schedules.runtime TEXT NOT NULL DEFAULT 'tmux'`), `devd/src/scheduler.ts`
(for chat: `open({...runtime:"chat"})` without a prompt file, then wait for `links.status === "connected"` (≤ 120 s)
and `links.send(startTurn{text: scheduledPrompt(...)})`), `dashboard/src/pages/Schedule.tsx` (runtime select); tests
`devd/test/scheduler.test.ts`.
- [ ] **Step 1: Tests:** chat schedule starts a run through the bridge; "schedule waits for the bridge, fails
  visibly on timeout" (`schedule_error` + notify); skip-if-running unchanged; autoEnd fires on chat completion
  (the `sweep()` done ids come from `ChatHub`'s stop events).
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: schedules on the chat runtime`.

### Task 5: Settled and snooze

**Files:** Modify `devd/src/db.ts` (table `session_attention(session_id PRIMARY KEY, settled_at, settled_reason,
snooze_until, snooze_kind, updated_at)`), `devd/src/attention.ts` (sections `settled`, `snoozed`), `devd/src/inbox.ts`,
`devd/src/chatHub.ts` (snoozed completions silent), `devd/src/threadApi.ts` (`POST /api/sessions/:id/settle`,
`/unsettle`, `/snooze {until?: number, untilReset?: boolean}`); dashboard Inbox (Settled shelf collapsed, row actions)
and iOS/Mac inbox; tests.

Rules: auto-settle after 7 days idle (tick in `index.ts`, 10 min); a pending request, active run, holding work or a
snooze block auto-settle; a new run, request or failure unsettles; snooze woken early only by a request or failure.
- [ ] **Step 1: Tests:** each rule; "until-reset uses the active limit"; "snoozed completion sends no notification";
  tmux sessions can be settled and snoozed too.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: settled shelf and snooze`.

### Task 6: PR watch

**Files:** Create `devd/src/prWatch.ts`; modify `devd/src/index.ts` (2-minute tick), `devd/src/attention.ts`
(holding work `pr-checks`), `devd/src/gitea.ts` (PR + commit status read); tests `devd/test/prWatch.test.ts` with a
fake runner (`gh pr list --head <branch> --json number,state,mergedAt,statusCheckRollup`) and a fake Gitea fetch.

**Interfaces:** `checkPrs(d: { sessions: SessionRow[]; gh: Runner; gitea: GiteaApi; now }): PrState[]` with
`PrState = { sessionId, number, url, state: "open" | "merged" | "closed", checks: "pending" | "success" | "failure" | "none" }`.
Polls only sessions with a pushed branch; stops polling a PR once merged/closed.
- [ ] **Step 1: Tests:** pending checks hold the thread in working; failure → needs-you with reason `ci-failed`;
  merged → settled; "merge during an active run settles after it"; Gitea path.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat(devd): PR watch`.

### Task 7: Images

**Files:** Modify `devd/src/threadApi.ts` (`POST /api/sessions/:id/thread/attachments` multipart → file under
`<root>/_inbox/<sessionId>/<uuid>.<ext>`, returns `{id, path:"/inbox/<sessionId>/<uuid>.<ext>"}`; the
`originGuard` exemption pattern used for `/api/inbox` uploads), `BridgeCommand.startTurn.attachments`, bridge
adapters (Claude image content blocks read from `/inbox`, Codex `image` input items as data URLs, ACP image
content when `caps.images`, else the path appended to the text), dashboard Composer (paste/drop, previews,
client-side downscale), iOS/Mac composer (PhotosPicker / paste); tests on each layer.
- [ ] **Step 1: Tests:** upload limits and types (png, jpeg, webp, gif); "oversized image is downscaled, huge one
  rejected" (dashboard `imageView.ts` pure function); each adapter's image mapping; fallback path for an agent
  without image capability.
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: images in chat`.

### Task 8: Critic on run completion

**Files:** Modify `devd/src/chatHub.ts` (on `run.started` origin `user` call `critic.onPrompt(s, text)`; on
`run.completed` with nothing holding call `critic.onStop(s)`; on `{block:true, reason}` send
`startTurn{text: reason}` with origin `critic` instead of emitting `stop`), `RunOrigin` gains `"critic"`, inbox
shows critic runs as working; tests `devd/test/chatHub.test.ts`.
- [ ] **Step 1: Tests:** block → follow-up run and no done notification; pass → done; rounds cap respected; critic
  error fails open (as today, logged `critic_error`).
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: critic for chat sessions`.

### Task 9: Live verification and report

- [ ] Deploy; scenarios: iOS chat + question answered from the phone; Mac app inbox + notification click; a chat
  schedule end-to-end with autoEnd; snooze until reset; a PR with pending CI (working) then merged (settled); a pasted
  screenshot read by Claude and Codex; a critic block with a follow-up run.
- [ ] Report `docs/superpowers/reports/2026-11-agent-runtime-v2-step5.md`, Plane update, commit.
