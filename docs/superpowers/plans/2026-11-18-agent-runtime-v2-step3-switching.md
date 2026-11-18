# Agent runtime v2, step 3: switching model, account and harness with handoff. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a chat session the user switches model, account (Claude and Codex) and harness (Claude ↔ Codex, and
proxy profiles) mid-conversation. The target continues with the conversation's context, and the agent can page
through older history with `devbox_thread_read`.

**Architecture:** devd owns the decision and the handoff text (it owns the thread store). It computes a
transition plan, builds a budgeted handoff from the store, and sends one bridge command. The bridge closes the
current harness session and opens the target, resumed or fresh, then delivers the handoff with the user's next
message. Codex accounts share history through a shared home with per-account shadow homes, so an account switch is
a restart with `thread/resume`.

**Tech Stack:** as step 2.

**Spec:** `docs/superpowers/specs/2026-11-18-agent-runtime-v2-design.md` (Portable handoff; Harness adapters /
Codex accounts; Decisions "Codex homes"). Requires step 2 merged (`HarnessSession`, `BridgeCommand`,
`ThreadStore`, `BridgeLinks`, thread API).

**T3 references (commit `eebb6bcc`):** `handoffBudget.ts`, `ContextHandoffService.ts`,
`ContextHandoffDelivery.ts`, `CodexHomeLayout.ts`, `t3_thread_read`.

## Global Constraints

- Everything in step 2's Global Constraints.
- Handoff is selection, not summary: user/assistant messages, command executions, errors, file changes (paths only)
  and plans. Order: latest user message, latest assistant message, first user message, then the rest
  newest-first while it fits. Messages are kept whole.
- Budget: `min(16_000, 64 * 1024, window − used − input − reserve)` tokens, charging 1 token per UTF-8 byte.
- The user's request is never shortened. If it does not fit, retry into a fresh native thread.
- Never copy `auth.json`. A v2 Codex shadow home links the account's own `auth.json` in place.
- Existing per-account Codex volumes used by tmux sessions are not restructured.

## Review Focus

1. **Switch requested while a run is active.** Refused with 409 `run-active` (the user stops first); never applied
   mid-turn. Test: Task 6 "switch during an active run is 409".
2. **Resume of the old native thread fails on return** (deleted, stale, other account without access). Falls back
   to a fresh thread with a full handoff and says so in a notice item. Test: Task 4 "resume failure falls back to
   a full handoff".
3. **The user's next message alone exceeds the budget.** The message is sent whole, the history part is dropped,
   and a notice says the history was omitted (the agent can use `devbox_thread_read`). Test: Task 3 "oversized
   request keeps the request and drops history".
4. **Two Codex app-servers on one shared home** (two sessions on the same account). Must not corrupt the shared
   sqlite. Test: Task 1 concurrency probe; the decision is recorded.
5. **Account switch to an account whose token is expired or quarantined.** Refused before closing the current
   session. Test: Task 5 "unusable target account is refused without touching the session".

---

### Task 1: Codex shared-home concurrency probe (decision task)

**Files:** Create `docs/superpowers/reports/2026-11-codex-shared-home-probe.md`.

- [ ] **Step 1:** On the VPS, in two containers sharing one test home (a throwaway Codex account or `default` with a
  copied *test* login, never a production `auth.json` copy), run two `codex app-server` processes, each doing 20
  turns concurrently on different threads plus `thread/list`. Check `PRAGMA integrity_check` of every sqlite file
  in the home and that both threads resume afterwards.
- [ ] **Step 2:** Write the result. If any check fails, the decision is "per-account homes + copy on switch" (reuse
  `codexConversationTransfer.py transfer`), and Task 2 implements that variant instead. Commit
  `docs: Codex shared-home concurrency probe`.

### Task 2: Codex homes for chat sessions

**Files:** Create `image/agent-bridge/src/codexHomes.ts`; modify `image/agent-bridge-launch.sh`,
`devd/src/sessions.ts` (mount volume `codex-v2-shared` at `/home/dev/.codex-v2` for chat sessions);
test `image/agent-bridge/test/codexHomes.test.ts`.

**Interfaces:**
```ts
export const SHARED_HOME = "/home/dev/.codex-v2/shared";
export function shadowHome(accountId: string): string;   // /home/dev/.codex-v2/shadow/<id>
export function prepareShadowHome(accountId: string, accountsRoot: string): string;
// creates the shadow dir; symlinks sessions/, sqlite/, archived_sessions/, history.jsonl, config.toml to SHARED_HOME;
// symlinks auth.json → <accountsRoot>/<id>/auth.json (throws when that file is missing or empty); returns the path
```
- [ ] **Step 1: Tests:** "shadow home links shared dirs and the account auth in place", "missing auth.json throws
  naming the account", "re-running is idempotent", "auth.json is a symlink, never a regular file".
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(agent-bridge): Codex shadow homes for chat sessions`.

### Task 3: Handoff selection and budget (pure)

**Files:** Create `devd/src/handoff.ts`; test `devd/test/handoff.test.ts`.

**Interfaces:**
```ts
export interface HandoffInput { items: ThreadItem[]; runs: RunRow[]; coveredRunIds?: Set<string> /* delta: skip */; request: string;
  window: number; used: number; reserve: number }
export interface Handoff { preamble: string | null; includedItemSeqs: number[]; omitted: number; budget: number }
export function handoffBudget(window: number, used: number, inputBytes: number, reserve: number): number;
export function buildHandoff(i: HandoffInput): Handoff;
export function deliverInline(h: Handoff, request: string): string; // preamble + "\n\nUser message:\n" + request; request untouched
```
- [ ] **Step 1: Tests:** budget formula with each of the three bounds winning; selection order (latest user,
  latest assistant, first user, then newest-first); a message that does not fit is skipped whole, never cut;
  file changes appear as paths only; delta skips covered runs; "oversized request keeps the request and drops
  history"; byte counting with multi-byte UTF-8.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(devd): budgeted context handoff`.

### Task 4: Transition plan and provider threads

**Files:** Create `devd/src/transition.ts`; modify `devd/src/threadStore.ts` (table `provider_threads(harness,
account, native_thread_id, covered_through_run, last_used_at)`); test `devd/test/transition.test.ts`.

**Interfaces:**
```ts
export type Target = { harness: "claude" | "codex" | string; account: string | null; model: string | null };
export type Transition =
  | { kind: "set-model"; model: string }
  | { kind: "restart-resume"; target: Target; nativeThreadId: string }
  | { kind: "resume-with-delta"; target: Target; nativeThreadId: string; handoff: Handoff }
  | { kind: "fresh-with-handoff"; target: Target; handoff: Handoff };
export function planTransition(current: Target & { nativeThreadId: string | null }, target: Target, store: ThreadStore, request: string, caps: Capabilities): Transition;
```
Rules (spec): same harness + same continuation home → `set-model` (or no-op); account change on the same harness
→ `restart-resume`; another harness used before and not stale (< 7 days, `covered_through_run` known) →
`resume-with-delta` over runs it missed; otherwise `fresh-with-handoff`. `Capabilities` come from the target
adapter (`resume`, `injectItems`, `liveModelSwitch`).
- [ ] **Step 1: Tests** for each branch plus "resume failure falls back to a full handoff" (the bridge reports
  `resume-failed`, devd re-plans with `fresh-with-handoff` and stores a notice item).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(devd): transition planning`.

### Task 5: Bridge commands for switching

**Files:** Modify `image/agent-bridge/src/protocol.ts`, `serve.ts`, `claudeSession.ts`, `codexSession.ts`;
tests in `serve.test.ts`, `claudeSession.test.ts`, `codexSession.test.ts`.

**Interfaces:** new `BridgeCommand` kinds:
`{kind:"setModel"; model}`; `{kind:"switchTarget"; target: {harness, account, model, env: Record<string,string>};
resume: string | null; handoff: {preamble: string | null; injectItems?: unknown[]} | null}`. The bridge closes the
current session only after the target account's env is validated (config dir exists and has credentials, or
shadow home prepared), opens the target, emits `thread.native`, and holds `handoff` until the next `startTurn`
(Codex: `thread/inject_items` when the capability is present, else inline). On resume failure it emits
`run.failed{error:"resume-failed"}` without starting a turn. `HarnessSession` gains `setModel(model)` and
`capabilities(): Capabilities`, defined in `image/agent-bridge/src/events.ts`:
`interface Capabilities { resume: boolean; injectItems: boolean; liveModelSwitch: boolean; questions: boolean;
images: boolean; backgroundVisibility: boolean }` (Claude: all true except injectItems; Codex: per the generated
protocol, `injectItems` true when `thread/inject_items` exists). The bridge reports them in `thread.native`
(new field `caps`), and devd stores them with the native thread.
- [ ] **Step 1: Tests:** "setModel on Claude calls query.setModel", "setModel on Codex applies to the next
  turn/start", "switchTarget with resume reopens with the stored id", "handoff preamble is prepended to the next
  user message only", "unusable target account is refused without touching the session", "resume failure emits
  resume-failed".
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(agent-bridge): model, account and harness switching`.

### Task 6: Switch API, account choice and proxy profiles

**Files:** Create `devd/src/chatSwitch.ts`; modify `devd/src/threadApi.ts`, `devd/src/agents.ts`
(`chatRuntimeBlock` allows proxy profiles), `image/agent-bridge/src/serve.ts` (proxy env);
test `devd/test/chatSwitch.test.ts`.

**Interfaces:** routes `POST /api/sessions/:id/thread/model {model}`, `POST .../thread/account {accountId?}`
(omitted = pool choice through `chooseAccount`, same as `/api/accounts/lease`), `POST .../thread/harness
{agent}`. All return 202 with the planned `Transition.kind`, 409 `run-active` while a run is active, 409
`agent-disconnected`, 400 for an unknown agent. On success: leases are updated exactly as `accountSwitch.ts` does
(release + insert after the bridge confirms), `sessions.agent` and `repo_prefs` updated after confirmation.
Proxy profiles: devd computes the profile env with the same inputs as `proxyEnv` (`sessions.ts:215`) and the
`agent-launch.sh` rules (ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL, CLAUDE_CODE_SUBAGENT_MODEL, …) in a pure function
`proxyProfileEnv(agent, settings): Record<string,string>`, passed in `switchTarget.target.env`.
- [ ] **Step 1: Tests:** each route's codes; "switch during an active run is 409"; lease rows after a confirmed
  account switch; `proxyProfileEnv` matches `agent-launch.sh --print-env` for each proxy profile (fixture taken
  from the script with masked token).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(devd): chat switching API`.

### Task 7: `devbox_thread_read`

**Files:** Modify `image/agent-bridge/src/mcp.ts`, `devd/src/threadApi.ts`, `devd/src/containerIdentity.ts`
(allow `GET /api/sessions/:id/thread` from the session's own container with `session: "required"`); tests.

**Interfaces:** tool `devbox_thread_read {beforeSeq?: number; limit?: number (≤ 50, default 20); query?: string}`
→ items rendered as `[seq] role: text` (tool items: command + first 2 KB of output), newest-first, plus
`nextBeforeSeq`. Data via `GET $DEVD_URL/api/sessions/$DEVD_SESSION_ID/thread`. The appended system prompt
(step 2 `prompts.ts`) gets one sentence: older history is available through `devbox_thread_read`.
- [ ] **Step 1: Tests:** paging, `query` filter (case-insensitive substring), limit cap, a container asking for
  another session's thread is 403.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat: devbox_thread_read`.

### Task 8: Composer switchers (dashboard)

**Files:** Create `dashboard/src/components/chat/Switchers.tsx`, `dashboard/src/switchView.ts` (+ test); modify
`Composer.tsx`, `api.ts`.

Model menu (models of the current harness from `GET /api/agents` / settings), account menu (accounts with usage %
from `/api/accounts`, disabled + reason when quarantined or exhausted), harness menu (agents allowed in chat).
Disabled while a run is active, with the reason as a tooltip. A switch shows a notice item in the thread
("Switched to Codex · context handed over (12 messages, 3 omitted)").
- [ ] **Step 1: Test** `switchView.ts`: which options are enabled and why. **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Visual check (desktop + 390 px). **Step 6: Commit** `feat(dashboard): model, account and harness switchers`.

### Task 9: Live verification and report

- [ ] Deploy (owner unlocks the vault). Scenarios: Claude model switch mid-conversation; Claude account switch
  (the next answer remembers the earlier turns); Claude → Codex with a handoff (Codex answers a question about an
  earlier turn); back to Claude (delta handoff, resumed native thread); Codex account switch with `thread/resume`;
  a proxy profile; `devbox_thread_read` used by the agent for an omitted early turn.
- [ ] Report `docs/superpowers/reports/2026-11-agent-runtime-v2-step3.md`, Plane update, commit.
