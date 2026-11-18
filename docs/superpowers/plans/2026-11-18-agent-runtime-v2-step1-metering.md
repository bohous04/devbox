# Agent runtime v2, step 1: Claude bridge + metering gate. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first piece of the in-container `agent-bridge` (Claude adapter + event log) and use it to
measure whether driving Claude Code through the Agent SDK drains the 5-hour limit more than the interactive TUI.
This is the go/no-go gate for the whole v2 project.

**Architecture:** `image/agent-bridge/` is a Bun package baked into the session image. In this step it only has
a one-shot command (`agent-bridge once`) that runs one Claude turn through `@anthropic-ai/claude-agent-sdk`
`query()` using the image's own `claude` binary. It writes normalized events to a JSONL log. A host-side
harness in `tools/metering/` runs the same task alternately through the TUI and through the bridge on one
dedicated account. It reads that account's 5h usage before and after each run and applies the gate.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (exact version pin), Docker, tmux,
existing `devd/src/accountUsage.ts` (`fetchUsage`) and `devd/src/accountTokens.ts` (`parseCredentials`).

**Spec:** `docs/superpowers/specs/2026-11-18-agent-runtime-v2-design.md` (Delivery order step 1, Constraints
"Usage metering must be measured", Decisions "Metering gate").

**Scope note:** the spec's step 1 also mentions "one chat in the dashboard". That is moved to the step 2 plan:
the gate does not need it, and if the gate fails, the chat UI would be wasted work.

## Global Constraints

- Subscriptions, not API keys: the bridge uses `CLAUDE_CONFIG_DIR` of an existing account and never logs in.
- `pathToClaudeCodeExecutable` = the image's `claude` (`/usr/bin/env which claude` at runtime), never the SDK's
  bundled binary.
- The bridge strips the inherited `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` from the agent env.
- Gate: on one account, the same task 5× through the TUI and 5× through v2. If v2 costs more than 15 % more,
  stop and report before step 2. Ratio threshold: `1.15`.
- Public repo (Apache-2.0, English): no account ids, tokens or machine paths committed. The measurement report
  uses the account's label only if the owner agrees; otherwise `account A`.
- Tests that need Docker, a `claude` binary or network are skipped with a reason when unavailable, not failed.
- The existing tmux runtime and all existing sessions are untouched by this step.

## Review Focus

1. **The 5h window resets during a run.** The harness must detect `fiveHourResetsAt` changing between the
   before and after reads, discard that run and repeat it. It must not record a negative or tiny delta.
   Test in Task 4.
2. **Someone else uses the measurement account during a run.** The pool still leasing it would inflate one
   path. The harness refuses to start unless the account is `disabled` in the pool. It re-checks before every
   run. Test in Task 4.
3. **The TUI run never "finishes"** (a question dialog, a permission prompt, a crash). Completion detection
   needs a hard timeout (30 min). After it, the run is recorded as failed and excluded, never counted as a short
   run. Test in Task 4.
4. **Usage granularity:** the API reports whole percents (`utilization: 3.0`). A run that moves usage by 0–1 %
   says nothing. The gate is computed on per-token normalized cost, and the harness warns if any path's total
   delta is below 10 points. Test in Task 4.
5. **The SDK silently uses a different model or effort than the TUI.** Both paths take the model explicitly
   from one harness argument, and the run record stores the model the transcript reports. A mismatch fails the
   run. Test in Task 4.

---

### Task 1: agent-bridge package, event types and event log

**Files:**
- Create: `image/agent-bridge/package.json` (name `agent-bridge`, `type: module`, dependency
  `@anthropic-ai/claude-agent-sdk` pinned to the exact latest version at implementation time)
- Create: `image/agent-bridge/src/events.ts`
- Create: `image/agent-bridge/src/eventLog.ts`
- Create: `image/agent-bridge/test/eventLog.test.ts`
- Modify: `package.json` (root): add `"image/agent-bridge"` to `workspaces`

**Interfaces:**
- Produces:
  ```ts
  // events.ts
  export type BridgeEvent =
    | { type: "run.started"; runId: string; nativeThreadId: string | null; model: string | null }
    | { type: "message.delta"; runId: string; itemId: string; text: string }
    | { type: "message.final"; runId: string; itemId: string; role: "assistant"; text: string }
    | { type: "tool.started"; runId: string; itemId: string; tool: string; input: unknown }
    | { type: "tool.finished"; runId: string; itemId: string; isError: boolean; output: string }
    | { type: "run.completed"; runId: string; nativeThreadId: string; usage: TokenUsage; costUsd: number | null }
    | { type: "run.failed"; runId: string; error: string };
  export interface TokenUsage { input: number; output: number; cacheCreation: number; cacheRead: number }
  export interface LoggedEvent { seq: number; ts: number; event: BridgeEvent }
  // eventLog.ts
  export class EventLog {
    constructor(path: string);
    append(event: BridgeEvent): LoggedEvent;      // seq = previous max + 1, starting at 1
    readFrom(afterSeq: number): LoggedEvent[];    // events with seq > afterSeq, in order
  }
  ```

- [ ] **Step 1: Write the failing tests** in `test/eventLog.test.ts`:
  - `append assigns increasing seq starting at 1`: three appends → seqs `[1,2,3]`.
  - `readFrom returns only newer events`: after 3 appends, `readFrom(1)` → seqs `[2,3]`.
  - `reopening continues the sequence`: new `EventLog` on the same file, `append` → seq `4`.
  - `a torn last line is ignored`: file ends with a partial JSON line → `readFrom(0)` returns the complete
    events, and the next `append` gets seq = last complete + 1.
- [ ] **Step 2: Run** `bun test image/agent-bridge/test/eventLog.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `events.ts` and `eventLog.ts`. Use synchronous `appendFileSync` of one JSON line per
  event. On open, scan the file once for the last complete line to recover `seq`.
- [ ] **Step 4: Run** `bun install && bun test image/agent-bridge/test/eventLog.test.ts`. Expected: PASS.
  Then `bun run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit**: `feat(agent-bridge): event types and append-only event log`

### Task 2: Claude adapter

**Files:**
- Create: `image/agent-bridge/src/claude.ts`
- Create: `image/agent-bridge/test/claude.test.ts`
- Create: `image/agent-bridge/test/fixtures/sdk-turn.json`: a recorded list of SDK messages for one turn with
  one Bash tool call. Record it once from a real run (Task 3 smoke). Until then, hand-write it from the SDK's
  `SDKMessage` types: `system/init`, `stream_event` text deltas, `assistant` with `tool_use`, `user` with
  `tool_result`, `assistant` text, `result`.

**Interfaces:**
- Consumes: `BridgeEvent`, `TokenUsage` (Task 1).
- Produces:
  ```ts
  export interface ClaudeTurnOptions {
    runId: string; prompt: string; cwd: string; model: string;
    claudeExecutable: string; configDir: string; entrypoint?: string; // sets CLAUDE_CODE_ENTRYPOINT when given
    resume?: string;                                                   // native session id
  }
  export type QueryFn = typeof import("@anthropic-ai/claude-agent-sdk").query;
  export function claudeEnv(base: Record<string, string | undefined>, o: ClaudeTurnOptions): Record<string, string>;
  export function runClaudeTurn(o: ClaudeTurnOptions, queryFn?: QueryFn): AsyncIterable<BridgeEvent>;
  ```

- [ ] **Step 1: Write the failing tests** in `test/claude.test.ts`, using a fake `queryFn` that yields the fixture
  messages and records the options it got:
  - `maps a turn to bridge events`: the event types are, in order, `run.started` (with `nativeThreadId` =
    fixture `session_id`, `model` = fixture init model), ≥1 `message.delta`, `tool.started` (`tool: "Bash"`),
    `tool.finished` (`isError: false`), `message.final`, `run.completed`. `usage` equals the fixture `result`
    usage mapped to `TokenUsage`.
  - `passes the required SDK options`: `pathToClaudeCodeExecutable === o.claudeExecutable`,
    `permissionMode === "bypassPermissions"`, `model === o.model`, `cwd === o.cwd`, `includePartialMessages ===
    true`. `resume` is set only when `o.resume` is given.
  - `claudeEnv strips host-session variables`: base containing `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID=x` →
    neither key is in the result. `CLAUDE_CONFIG_DIR === o.configDir`.
  - `claudeEnv sets the entrypoint only when asked`: without `entrypoint`, no `CLAUDE_CODE_ENTRYPOINT` key is
    added by us. With `entrypoint: "cli"` → `CLAUDE_CODE_ENTRYPOINT === "cli"`.
  - `an SDK error becomes run.failed`: the fake throws after `system/init` → the last event is `run.failed` with
    the error message, and no `run.completed`.
- [ ] **Step 2: Run** `bun test image/agent-bridge/test/claude.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `claude.ts`.
  - Single-turn streaming input: an async iterable that yields one `SDKUserMessage` and then ends. Later steps
    replace it with a queue.
  - `itemId`: the SDK's message/tool_use id.
  - `message.final` comes from `assistant` text blocks. `tool.finished.output`: `tool_result` content joined as
    text and capped at 64 KB.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `bun run typecheck`. Expected: clean.
- [ ] **Step 5: Commit**: `feat(agent-bridge): Claude adapter over the Agent SDK`

### Task 3: `agent-bridge once` CLI and image integration

**Files:**
- Create: `image/agent-bridge/src/main.ts`
- Create: `image/agent-bridge/test/main.test.ts`
- Modify: `image/Dockerfile`:
  - after the Claude Code layer (`image/Dockerfile:109`): `COPY agent-bridge /opt/agent-bridge` +
    `RUN cd /opt/agent-bridge && bun install --production --frozen-lockfile`;
  - a wrapper `/usr/local/bin/agent-bridge` that runs `exec bun /opt/agent-bridge/src/main.ts "$@"`, created in
    the same chmod block as the other wrappers (`image/Dockerfile:132`).

**Interfaces:**
- Consumes: `runClaudeTurn`, `EventLog`.
- Produces: CLI
  `agent-bridge once --prompt-file <path> --cwd <dir> --model <m> --log <path> [--entrypoint <v>] [--config-dir <dir>]`.
  - `--config-dir` defaults to `$CLAUDE_CONFIG_DIR`.
  - Exit 0 on `run.completed`, 1 on `run.failed`.
  - Last stdout line is one JSON object
    `{ "status": "completed"|"failed", "nativeThreadId": string|null, "model": string|null, "usage": TokenUsage|null }`.
  - `export function parseArgs(argv: string[]): OnceArgs` (throws on a missing required flag).

- [ ] **Step 1: Write the failing tests** in `test/main.test.ts`:
  - `parseArgs requires prompt-file, cwd, model and log`: each missing → throws, and the message names the flag.
  - `once writes every event and prints the summary`: run `main` with an injected fake `queryFn` (export
    `runOnce(args, queryFn)` for this). The log has the same events as Task 2's mapping test. The returned summary
    equals `{status:"completed", nativeThreadId:<fixture>, model:<fixture>, usage:<fixture usage>}`.
  - `live smoke` (skipped with reason `"no claude binary / CLAUDE_CONFIG_DIR"` unless both exist and
    `AGENT_BRIDGE_LIVE=1`): prompt `Reply with the single word: pong` → status `completed`, and a
    `message.final` contains `pong`.
- [ ] **Step 2: Run** `bun test image/agent-bridge/test/main.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `main.ts` (`parseArgs`, `runOnce`, entry that resolves `claudeExecutable` via `which claude`).
- [ ] **Step 4: Run** the tests. Expected: PASS (live smoke skipped).
- [ ] **Step 5: Build the image and smoke it** on the VPS:
  - `docker build -t devbox:bridge-test image/`
  - Then, with one account volume mounted:
    `docker run --rm -u dev -v claude-home:/home/dev/.claude -v claude-acct-<id>:/home/dev/.claude-accounts/<id> -e CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/<id> -e AGENT_BRIDGE_LIVE=1 devbox:bridge-test bash -lc 'cd /opt/agent-bridge && bun test test/main.test.ts'`
  - Expected: live smoke PASS.
  - Save the SDK messages of that run as the real `test/fixtures/sdk-turn.json`. Re-run the Task 2 tests and
    expect PASS.
- [ ] **Step 6: Commit**: `feat(agent-bridge): one-shot CLI baked into the session image`

### Task 4: Metering harness

**Files:**
- Create: `tools/metering/compare.ts`: CLI entry
- Create: `tools/metering/meter.ts`: pure logic
- Create: `tools/metering/runners.ts`: TUI and bridge runners (docker/tmux side effects behind an injected `exec`)
- Create: `tools/metering/meter.test.ts`
- Create: `tools/metering/fixtures/transcript-end-turn.jsonl`, `transcript-in-progress.jsonl`
- Create: `tools/metering/task.md`: the fixed task prompt
  - Use the devbox repo at a pinned commit; the agent works in a scratch clone.
  - Prompt: *"Read devd/src/accountPolicy.ts and devd/test/accountPolicy.test.ts. Write /tmp/out.md explaining
    every exported function, each with one example derived from the tests. Do not modify any repository file."*

**Interfaces:**
- Consumes: `fetchUsage` (`devd/src/accountUsage.ts:96`), `parseCredentials` (`devd/src/accountTokens.ts:24`),
  `TokenUsage`, the `agent-bridge once` summary line (Task 3).
- Produces (`meter.ts`):
  ```ts
  export interface UsageRead { pct: number; resetsAt: number | null }
  export interface RunRecord {
    path: "tui" | "bridge"; ok: boolean; reason?: string;
    before: UsageRead; after: UsageRead; usage: TokenUsage | null; model: string | null;
  }
  export function weightedTokens(u: TokenUsage): number;        // input*1 + cacheCreation*1.25 + cacheRead*0.1 + output*5
  export function validateRun(r: RunRecord, expectedModel: string): RunRecord; // sets ok=false + reason on: window reset, model mismatch, missing usage
  export function transcriptUsage(jsonl: string): { done: boolean; usage: TokenUsage; model: string | null };
  export function gate(runs: RunRecord[]): {
    tuiPctPerMTok: number; bridgePctPerMTok: number; ratio: number; pass: boolean; // pass = ratio <= 1.15
    tuiDeltaPct: number; bridgeDeltaPct: number; lowSignal: boolean;              // lowSignal = either delta < 10
  };
  ```
- CLI: `bun tools/metering/compare.ts --account <id> --model <m> --runs 5 [--entrypoint <v>]`.
  - Runs `tui, bridge, tui, bridge…` (alternating, 2×runs), each in a fresh container from `devbox:latest`
    with only that account's volume and `claude-home`, and a fresh scratch clone.
  - Prints a JSON report and a one-line verdict.

- [ ] **Step 1: Write the failing tests** in `meter.test.ts`:
  - `weightedTokens`: `{input:1000,output:100,cacheCreation:400,cacheRead:10000}` → `1000+500+500+1000 = 3000`.
  - `validateRun rejects a window reset`: `before.resetsAt !== after.resetsAt` → `ok:false, reason:"window-reset"`.
  - `validateRun rejects a model mismatch`: `model:"claude-sonnet-x"`, expected `"claude-opus-5-5"` →
    `ok:false, reason:"model-mismatch"`.
  - `transcriptUsage detects completion`:
    - The end-turn fixture → `done:true`, with summed usage across all assistant entries and the model from the
      entries.
    - The in-progress fixture → `done:false`.
  - `gate passes at equal cost`: 5 tui + 5 bridge runs, each Δ3 % at 1M weighted tokens → `ratio === 1`,
    `pass:true`.
  - `gate fails above 15 %`: bridge runs Δ3.5 % per 1M vs tui Δ3 % per 1M → `ratio ≈ 1.1667`, `pass:false`.
  - `gate ignores failed runs`: one `ok:false` run with a huge delta → no effect on `ratio`.
  - `gate flags low signal`: total tui delta 6 → `lowSignal:true`.
- [ ] **Step 2: Run** `bun test tools/metering/meter.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `meter.ts`.
  - `PctPerMTok` = sum of Δpct of ok runs ÷ (sum of weighted tokens ÷ 1e6).
  - `ratio` = bridge ÷ tui.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Implement `runners.ts` and `compare.ts`.** Usage reads go through `docker run --rm -u 0 -v
  claude-acct-<id>:/a devbox:latest cat /a/.credentials.json` → `parseCredentials` → `fetchUsage`. Write a
  `fakeExec` test for each:
  - `refuses to start when the account is not disabled`: `/api/accounts` (on `$DEVD_URL`) shows `disabled:false`
    → exit with a message telling the owner to disable it in the pool.
  - `tui runner`:
    - Starts `tmux new-session -d -s m 'claude --model <m> "$(cat /task.md)"'` in the run container.
    - Polls the transcript under `$CLAUDE_CONFIG_DIR/projects/` every 10 s, and the run counts as done when
      `transcriptUsage(...).done` holds and the file has had no new lines for 30 s.
    - A hard timeout of 30 min → `ok:false, reason:"timeout"`.
    - The test feeds the two fixtures in sequence and expects `done` on the second.
  - `bridge runner`:
    - Runs `agent-bridge once --prompt-file /task.md --cwd /work --model <m> --log /tmp/ev.jsonl
      [--entrypoint v]`.
    - Takes `usage` and `model` from the summary line.
- [ ] **Step 6: Run** `bun test tools/metering/`, then `bun run ci`. Expected: all PASS.
- [ ] **Step 7: Commit**: `feat(metering): TUI vs agent-bridge 5h-usage comparison harness`

### Task 5: Run the gate and report

**Files:**
- Create: `docs/superpowers/reports/2026-11-agent-runtime-v2-metering.md`

- [ ] **Step 1: Owner action.** Ask the owner which Claude account to dedicate. They disable it in the pool
  (Subscriptions page) for the duration. Do not proceed without this.
- [ ] **Step 2: Deploy the image.** Merge Tasks 1–4 to `main` per the repo's flow, then wait for auto-deploy.
  Alternatively build `devbox:latest` on the VPS per the existing image runbook.
- [ ] **Step 3: Run** `bun tools/metering/compare.ts --account <id> --model <current default model> --runs 5`.
  Expected: 10 ok runs.
  - Any `window-reset`, `timeout` or `model-mismatch` run is repeated automatically.
  - If `lowSignal` is reported, re-run with `--runs 10`.
- [ ] **Step 4: If `pass:false`**, run once more with `--entrypoint cli` before concluding. T3's fix likely
  touched the entrypoint.
- [ ] **Step 5: Write the report.** Include:
  - the numbers: per-path Δ%, weighted tokens, ratio;
  - the SDK and Claude Code versions;
  - the entrypoint variant;
  - the verdict.

  Re-enable the account in the pool.
- [ ] **Step 6: Commit and push** the report: `docs: agent runtime v2 metering gate result`.
- [ ] **Step 7: Gate.** If `pass:true` (ratio ≤ 1.15), write the step 2 plan. If `pass:false` in both variants,
  stop and bring the report to the owner. Do not start step 2.
