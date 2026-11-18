# Agent runtime v2, step 6: make `chat` the default runtime. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New sessions start as `chat` by default once v2 is verified; tmux stays selectable and existing tmux
sessions live out their life unchanged.

**Architecture:** A setting `defaultRuntime` (`tmux` | `chat`) read by session creation, schedules, the dashboard,
the apps and the `dev` CLI. Removing tmux-only machinery is a separate, later decision (spec "Coexistence").

**Spec:** `docs/superpowers/specs/2026-11-18-agent-runtime-v2-design.md` (Delivery order step 6; Coexistence and
migration; Clients / `dev` CLI). Requires steps 2–5 verified (their reports).

## Global Constraints

- Running tmux sessions are not migrated or restarted.
- tmux-only machinery (`ccUpkeep.restartPane`, `codexConversation`, hooks, `apiErrorRetry`, `devbox-recovery`,
  `devbox-ctrlv`) stays.
- `dev ls` is not extended. `dev <repo>` attaches a shell (Warp optional).

## Review Focus

1. **A repo whose remembered agent is not available in chat** (none after step 4, but a future profile could be).
   Creation falls back to tmux only with an explicit notice in the response and UI, never silently. Test: Task 1.
2. **`dev <repo>` on a chat session** attaches the shell in tmux `main`, not an agent. Test: Task 2.
3. **Schedules created before the flip** keep their stored runtime. Test: Task 1.

---

### Task 1: `defaultRuntime` setting

**Files:** Modify `devd/src/settings.ts` (or the settings module that holds `critic`/`ccUpkeep`; field
`defaultRuntime`, default `tmux` until the owner flips it), `devd/src/api.ts` (`POST /api/sessions` uses it when
`runtime` is omitted; response carries `runtime` and `runtimeNotice` when it had to use tmux),
`dashboard` settings page + NewSession default, iOS/Mac new-session default; tests.
- [ ] Tests: omitted runtime follows the setting; explicit runtime wins; an agent not allowed in chat yields tmux
  with `runtimeNotice`; schedules keep their stored runtime. FAIL → implement → PASS. Commit.

### Task 2: `dev` CLI on chat sessions

**Files:** Modify `cli/src/main.ts` / `cli/src/attach.ts` (`dev <repo>` and `dev attach` on a chat session attach to
tmux `main` = shell; print one line with the dashboard/app link to the chat), tests in `cli/test/`.
- [ ] Tests → implement → PASS. Commit.

### Task 3: Flip and docs

- [ ] Owner flips `defaultRuntime` to `chat` in the dashboard settings (an owner action, not a code default change),
  after reading the step 2–5 reports.
- [ ] Update `docs/` (sessions, mac, ios) and `AGENTS.md` notes on the two runtimes; note in AGENTS.md that tmux-only
  machinery is kept only for tmux sessions.
- [ ] Plane: close DEVBOX-24 after a week of chat-default use without regressions; file the follow-up "remove tmux
  agent runtime?" as an owner decision item. Commit `docs: chat is the default runtime`.
