# Agent runtime v2, step 2: core (Claude + Codex chat, store, stream, inbox, terminal, restarts). Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `chat` session runtime. The agent (Claude Code or Codex) runs headless under an in-container
`agent-bridge`. devd stores the conversation, streams it to the dashboard, and computes an accurate
"needs you / working" inbox that drives the existing notifications. A Terminal tab gives a plain shell. A running
turn survives a devd restart, and a container restart resumes the conversation.

**Architecture:** `agent-bridge serve` runs in the session container. It owns one agent process through a
harness adapter (Claude: Agent SDK streaming `query()`; Codex: `codex app-server` stdio JSON-RPC). It appends
normalized events to a sequenced log in `/run/devd/bridge/`. It serves a unix socket at `/run/devd/agent.sock`
(host side: `<controlDir>/agent.sock`). devd connects to that socket per chat session, replays from its last
stored sequence, writes the events into `<root>/_threads/<sessionId>.sqlite`, derives attention, and feeds the
`AgentEventHub` and an SSE stream for clients.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.327 (already pinned), `codex
app-server` from the image's `codex`, `bun:sqlite` (WAL), Hono SSE (`hono/streaming`), React 19 + Tailwind v4
dashboard, `@modelcontextprotocol/sdk` for the devbox MCP server.

**Spec:** `docs/superpowers/specs/2026-11-18-agent-runtime-v2-design.md` (Delivery order step 2; Architecture,
Harness adapters, Conversation store, Live updates, Attention model, Restarts, Clients, Coexistence).
Step 1 result: `docs/superpowers/reports/2026-11-agent-runtime-v2-metering.md` (PASS 0.826).

**T3 references** are pinned to t3code commit `eebb6bcc`
(`https://github.com/pingdotgg/t3code/blob/eebb6bcc/<path>`). Read them for behavior, don't copy code wholesale.

## Decisions this plan makes (the spec leaves them to the builder)

- **Bridge ↔ devd wire:** the bridge is the server on `/run/devd/agent.sock` (the control dir is already
  bind-mounted at `/run/devd`, `sessions.ts:705`). Newline-delimited JSON. devd connects, sends
  `{"t":"hello","afterSeq":N}`, receives every logged event with `seq > N`, then live events. Commands are
  `{"t":"cmd","id":<uuid>,"cmd":{...}}`, answered by `{"t":"res","id":...,"ok":bool,"error"?}`.
  The bridge survives devd; devd never holds the agent's stdio.
- **Client stream:** SSE, `GET /api/stream?session=<id>` (works through Cloudflare Access and `fetch`, and iOS
  can read it with `URLSession.bytes`). Not `/api/events`: that path is the existing JSON event log (dashboard,
  CLI) and stays unchanged (ruling R11.1).
- **Event log location:** `/run/devd/bridge/events.jsonl` + `/run/devd/bridge/state.json`. The control dir
  survives container restarts and is removed on session end, after the thread store has everything.
- **Thread store:** `<root>/_threads/<sessionId>.sqlite` (root = `/srv/dev` in production), WAL, one writer
  (devd). On session end it moves to `<root>/_chat-archive/<id>-<stamp>/threads.sqlite` with the transcripts.
- **Runtime choice:** `sessions.runtime TEXT NOT NULL DEFAULT 'tmux'`. `chat` accepts agents `claude` and
  `codex` only in step 2. Proxy profiles (`claude-gpt`, …) come in step 3, ACP agents in step 4. Any other agent
  with `runtime: "chat"` is a 400 with a message naming the step, not a silent switch to tmux.
- **Messages sent while a run is active** are queued in the bridge and start the next run when the current one
  ends. Steering a running turn (Codex `turn/steer`) is out of step 2.
- **Codex account in step 2:** the account chosen by the existing `codex_account_prepare` logic, used in place
  as `CODEX_HOME` (its `auth.json` is never copied). Shadow homes for switching are step 3.

## Global Constraints

- Subscriptions, not API keys: Claude uses `CLAUDE_CONFIG_DIR` from the account lease
  (`/usr/local/bin/account-lease`), Codex uses `CODEX_HOME` of a Codex account. devbox never logs in.
- `pathToClaudeCodeExecutable` = the image's `claude`. Keep `systemPrompt: {type:"preset", preset:"claude_code"}`
  and leave `settingSources` unset (step 1 measured exactly this configuration).
- Strip `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID` from the agent env (`claudeEnv` in
  `image/agent-bridge/src/claude.ts`).
- Claude: `permissionMode: "bypassPermissions"` with `canUseTool` always installed. Codex: full access
  (`approvalPolicy: "never"`, sandbox `danger-full-access`).
- Conversation data never goes into the main devd DB (`journal_mode=delete`). Only `sessions.runtime` is added
  there.
- Existing tmux sessions, hooks, `ccUpkeep`, `accountSwitch`, `agentSwitch`, `codexSessionAccounts` keep working
  unchanged for `runtime='tmux'`. For `runtime='chat'` they refuse with an explicit status, never act.
- Anti-goals: a devd restart never kills or forgets a running turn. Notifications are not less reliable than
  today in either direction. The user's request text is never shortened.
- Public repo (Apache-2.0, English): no account ids, tokens, hostnames or machine paths in code, tests or docs.
- Tests needing Docker, a `claude`/`codex` binary or network are skipped with a reason when unavailable
  (`test.skipIf`), never failed. Live checks run on the VPS as root.
- No silent fallbacks (global instructions): a missing socket, an unknown event type, a store write error are
  surfaced (logged + visible state), never replaced by a default.
- Commits use the repository's configured identity; PRs are merged locally (`git merge --no-ff`), never `gh pr merge`.

## Review Focus

1. **devd restarts mid-turn.** After reconnect, the thread has every item exactly once and the run keeps
   streaming. Test: Task 9 "reconnect replays only events after the stored seq" + Task 8 "applying the same
   seq twice is a no-op".
2. **The container is killed while the bridge writes** (torn last log line, `state.json` says a run was active).
   The bridge starts, ignores the torn line, resumes the native thread and sends exactly one continuation
   message, at most 3 in 5 minutes. Test: Task 6 "continuation guard".
3. **The agent ends its turn while a `ScheduleWakeup`, Monitor, subagent or declared wait is pending.** Inbox says
   "working", no "done" notification. When the work ends, the next completion notifies. Test: Task 10
   "completed run with holding work is working, not needs-you" and "done is sent once holding work clears".
4. **A message is sent while a run is active.** It is queued, shown as queued, and starts the next run; it is never
   dropped or merged into the running turn. Test: Task 3 "message during an active run starts the next run" and
   Task 4 for Codex.
5. **The bridge is not reachable** (container stopped, bridge crashed). API commands return 409 with
   `agent-disconnected`; the inbox shows the session under "needs you" with reason `disconnected`; devd keeps
   retrying. Test: Task 9 "commands fail with agent-disconnected when no socket" + Task 10 "disconnected is
   needs-you".

---

### Task 1: Bridge event and command protocol

**Files:**
- Modify: `image/agent-bridge/src/events.ts`
- Create: `image/agent-bridge/src/protocol.ts`
- Test: `image/agent-bridge/test/protocol.test.ts`

**Interfaces:**
- Produces (every later task uses these exact names):

```ts
// events.ts
export type RunOrigin = "user" | "agent" | "continuation";
export type RequestKind = "question" | "plan" | "approval";
export interface BackgroundWork { id: string; kind: "subagent" | "workflow" | "monitor" | "wakeup" | "declared-wait" | "command"; label: string; holding: boolean; until?: number }
export type BridgeEvent =
  | { type: "thread.native"; harness: "claude" | "codex"; nativeThreadId: string; account: string | null; model: string | null }
  | { type: "run.queued"; runId: string; text: string; attachments: string[] }
  | { type: "run.started"; runId: string; origin: RunOrigin; nativeThreadId: string | null; model: string | null }
  | { type: "message.delta"; runId: string; itemId: string; text: string }
  | { type: "message.final"; runId: string; itemId: string; role: "assistant" | "user"; text: string }
  | { type: "tool.started"; runId: string; itemId: string; tool: string; input: unknown }
  | { type: "tool.finished"; runId: string; itemId: string; isError: boolean; output: string }
  | { type: "request.opened"; runId: string; requestId: string; kind: RequestKind; prompt: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }
  | { type: "request.resolved"; requestId: string; answer: string | null; by: "user" | "expired" }
  | { type: "background.changed"; work: BackgroundWork[] }
  | { type: "run.completed"; runId: string; nativeThreadId: string; usage: TokenUsage; costUsd: number | null }
  | { type: "run.interrupted"; runId: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "bridge.started"; version: string; resumed: boolean };
// protocol.ts
export type BridgeCommand =
  | { kind: "startTurn"; text: string; attachments?: string[] }
  | { kind: "interrupt" }
  | { kind: "answer"; requestId: string; answer: string }
  | { kind: "restartAgent" }   // nightly binary update: close and reopen the harness with resume; refused while a run is active
  | { kind: "stop" };
export type ClientFrame = { t: "hello"; afterSeq: number } | { t: "cmd"; id: string; cmd: BridgeCommand };
export type ServerFrame = { t: "event"; e: LoggedEvent } | { t: "res"; id: string; ok: boolean; error?: string } | { t: "ready"; lastSeq: number };
export function parseClientFrame(line: string): ClientFrame;   // throws ProtocolError on anything else
export function encodeFrame(f: ServerFrame | ClientFrame): string; // JSON + "\n"
export class ProtocolError extends Error {}
```

- [ ] **Step 1: Write the failing tests** in `protocol.test.ts`: `parseClientFrame` accepts `{"t":"hello","afterSeq":0}`
  and a `startTurn` cmd; rejects unknown `t`, a cmd with unknown `kind`, a negative or non-integer `afterSeq`,
  a `startTurn` with empty `text` (all `ProtocolError`); `encodeFrame` output ends with exactly one `\n` and
  round-trips through `JSON.parse`.
- [ ] **Step 2:** `bun test image/agent-bridge/test/protocol.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Extend `events.ts` as above (keep `TokenUsage`, `LoggedEvent`). Update `claude.ts` /
  `main.ts` so the existing `once` path still compiles: `run.started` gains `origin: "user"`.
- [ ] **Step 4:** `bun test image/agent-bridge` → all pass; `bunx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(agent-bridge): event and command protocol for serve mode`.

### Task 2: Socket server, log replay and bridge state

**Files:**
- Create: `image/agent-bridge/src/server.ts`, `image/agent-bridge/src/state.ts`
- Modify: `image/agent-bridge/src/eventLog.ts` (add `lastSeq(): number`)
- Test: `image/agent-bridge/test/server.test.ts`, `image/agent-bridge/test/state.test.ts`

**Interfaces:**
- Consumes: Task 1 frames; `EventLog` (`append`, `readFrom`).
- Produces:

```ts
export interface BridgeState { harness: "claude" | "codex"; nativeThreadId: string | null; account: string | null;
  model: string | null; activeRunId: string | null; queue: { runId: string; text: string; attachments: string[] }[];
  continuations: number[] /* epoch ms of automatic continuations */ }
export function loadState(path: string): BridgeState | null;          // null when missing; throws on corrupt JSON
export function saveState(path: string, s: BridgeState): void;        // write tmp + rename (atomic)
export interface CommandHandler { (cmd: BridgeCommand): Promise<void> }  // throws → res ok:false, error=message
export function startServer(o: { socketPath: string; log: EventLog; onCommand: CommandHandler }): { publish(e: BridgeEvent): LoggedEvent; close(): Promise<void> };
```

`publish` appends to the log and writes the frame to every connected client that has finished its replay.
A client that connects gets `ready{lastSeq}` after the replay of `seq > afterSeq`. The socket file is
removed and recreated on start, and `chmod 0666` (devd on the host is root, the bridge runs as `dev`).

- [ ] **Step 1: Write the failing tests:**
  - "hello replays only events after afterSeq, then ready, then live events in order" (publish 3, connect with
    afterSeq 1, expect seq 2,3, ready{lastSeq:3}, then publish 4 → seq 4).
  - "an event published during replay is delivered once, after the replay" (no gap, no duplicate).
  - "a command handler error is returned as res ok:false with the message".
  - "two clients each get every live event".
  - "a malformed line closes only that client" (others keep receiving).
  - "replay after a torn last log line skips it" (write a partial JSON line to the log file before start).
  - state: "saveState then loadState round-trips", "loadState returns null when missing", "corrupt state throws".
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement with `Bun.listen({ unix })`. Line buffering per connection. Keep replay and live
  ordering with a per-client "replaying" flag and a pending queue.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(agent-bridge): unix socket server with sequenced replay`.

### Task 3: Claude adapter as a long-lived session

**Files:**
- Create: `image/agent-bridge/src/claudeSession.ts`, `image/agent-bridge/src/background.ts`
- Modify: `image/agent-bridge/src/claude.ts` (keep `claudeEnv`, `capText`, `toolResultText`; `runClaudeTurn`
  stays for `once`)
- Test: `image/agent-bridge/test/claudeSession.test.ts`, `image/agent-bridge/test/background.test.ts`,
  fixtures `test/fixtures/claude-*.json` (recorded live, Step 6)

**Interfaces:**
- Consumes: `claudeEnv`, Task 1 events.
- Produces:

```ts
export interface HarnessSession {                 // implemented by Claude (here) and Codex (Task 4)
  startTurn(runId: string, text: string, origin: RunOrigin): Promise<void>; // resolves when the turn is accepted
  interrupt(): Promise<void>;
  answer(requestId: string, answer: string): Promise<void>;
  close(): Promise<void>;
}
export function openClaudeSession(o: { cwd: string; model: string | null; claudeExecutable: string; configDir: string;
  entrypoint?: string; resume: string | null; mcpServers: Record<string, unknown>; appendSystemPrompt: string;
  emit: (e: BridgeEvent) => void }, queryFn?: QueryFn): HarnessSession;
// background.ts — pure tracker
export class BackgroundTracker { apply(msg: SDKMessage): BackgroundWork[] | null; /* null = unchanged */ declare(w: BackgroundWork): BackgroundWork[]; clear(id: string): BackgroundWork[] }
```

Behavior:
- One `query()` with streaming input (an async queue of `SDKUserMessage`) for the life of the session, options as
  in `runClaudeTurn` plus `resume`, `mcpServers`, `appendSystemPrompt` via `systemPrompt: {type:"preset",
  preset:"claude_code", append}`, and `canUseTool`.
- `canUseTool("AskUserQuestion" | "ExitPlanMode", input)` emits `request.opened` (`question` / `plan`) and awaits
  `answer()`. The answer is returned as `{behavior:"allow", updatedInput:{...input, answers}}` for questions and
  `deny` with the user's text for a rejected plan (T3 `ClaudeAdapterV2.ts`:12197-12339). Every other tool:
  `{behavior:"allow", updatedInput: input}` immediately.
- A run is the span from a user message to its `result`. A `result` that arrives with no run started by the user
  (the agent woke up from `ScheduleWakeup`/task notification) is wrapped in `run.started{origin:"agent"}` …
  `run.completed`.
- `usage` per run = the delta of cumulative `modelUsage` against the previous `result` (step 1 found it is
  cumulative with `resume`).
- Background work (T3 `ClaudeAdapterV2.ts`:3697-3780, 6087-6110): `system/task_started` and
  `task_notification` (subagents, workflows, Monitor), `background_tasks_changed`, and a synthetic `wakeup`
  item from a `ScheduleWakeup` tool result with its `until` time, cleared when the wakeup fires. Background
  shell commands without a declaration are `holding:false`.
- Messages queued while a run is active are written to the input queue only after the active run's `result`.

- [ ] **Step 1: Write the failing tests** with a fake `QueryFn` that yields scripted `SDKMessage`s and records the
  input queue:
  - "streams deltas, finals and tool items of one run, then run.completed with per-run usage".
  - "second turn reports only its own usage, not the cumulative modelUsage".
  - "AskUserQuestion becomes request.opened and the answer is passed back as updatedInput.answers".
  - "ExitPlanMode rejected by the user denies with the user's text".
  - "a result without a user message is an agent-origin run".
  - "message during an active run starts the next run" (queue order kept, nothing written to the SDK input until
    the first result).
  - "interrupt calls query.interrupt and emits run.interrupted".
  - background: "ScheduleWakeup result adds a holding wakeup until its time", "task_notification completed
    removes the subagent", "undeclared background command is not holding".
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement. Map SDK messages with the same code paths as `runClaudeTurn` (extract a shared
  `mapSdkMessage` to keep one translation).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(agent-bridge): long-lived Claude session with questions and background work`.
- [ ] **Step 6 (VPS, live):** record real message streams for a question, a `ScheduleWakeup` and a subagent turn
  into `test/fixtures/claude-*.json` (redact ids, paths, account labels) and add one test per fixture asserting
  the event sequence types. Commit `test(agent-bridge): recorded Claude fixtures`.

### Task 4: Codex adapter over app-server

**Files:**
- Create: `image/agent-bridge/src/jsonRpc.ts`, `image/agent-bridge/src/codexSession.ts`,
  `image/agent-bridge/src/codex-protocol/` (generated types, committed)
- Test: `image/agent-bridge/test/jsonRpc.test.ts`, `image/agent-bridge/test/codexSession.test.ts`,
  fixtures `test/fixtures/codex-*.jsonl` (recorded live)

**Interfaces:**
- Consumes: `HarnessSession` (Task 3).
- Produces:

```ts
export class JsonRpcPeer { constructor(io: { write(line: string): void; onLine(cb: (line: string) => void): void });
  request<T>(method: string, params: unknown): Promise<T>; notify(method: string, params: unknown): void;
  onNotification(cb: (method: string, params: any) => void): void;
  onRequest(cb: (method: string, params: any) => Promise<unknown>): void; }
export function openCodexSession(o: { cwd: string; model: string | null; codexHome: string; resume: string | null;
  mcpConfigArgs: string[]; developerInstructions: string; emit: (e: BridgeEvent) => void },
  spawn?: (argv: string[], env: Record<string, string>) => { stdin: { write(s: string): void }; lines: AsyncIterable<string>; exited: Promise<number> }): HarnessSession;
```

Behavior (T3 `apps/server/src/provider/Layers/CodexAdapter.ts` and the generated protocol):
- Spawn `codex app-server` (plus `mcpConfigArgs`) with `CODEX_HOME`; `initialize`, then `thread/resume` when
  `resume` is set, else `thread/start` with `cwd`, `approvalPolicy: "never"`, `sandbox: "danger-full-access"`,
  `developerInstructions`. Emit `thread.native`.
- `startTurn` → `turn/start` with the text input and `model` when set. Notifications map to events:
  `item/agentMessage/delta` → `message.delta`; `item/completed` agentMessage → `message.final`;
  commandExecution/fileChange/mcpToolCall start/complete → `tool.started`/`tool.finished` (command text as input,
  aggregated output capped like Claude); `turn/completed` → `run.completed` (usage from `thread/tokenUsage/updated`
  last values for that turn); turn failed → `run.failed`.
- Server requests (`item/tool/requestUserInput`, any approval request) → `request.opened` and await `answer()`.
- `interrupt` → `turn/interrupt`. Process exit while a run is active → `run.failed` with the exit code; the
  bridge (Task 6) restarts the session with `resume`.

- [ ] **Step 1:** Generate the protocol types from the image's codex: `docker run --rm --entrypoint codex
  devbox:latest app-server generate-ts --out /tmp/p` (copy out into `codex-protocol/`, add a README line with
  the codex version). If the subcommand does not exist in that version, stop and report (do not hand-write the
  protocol).
- [ ] **Step 2: Write the failing tests:** JSON-RPC: "request resolves with the matching id", "error response
  rejects with code and message", "server request gets the handler's result", "notification reaches
  onNotification". Codex session with a fake spawn fed from a fixture: "thread/start then turn/start; deltas,
  final message, command item, turn completed with usage", "resume uses thread/resume with the stored id",
  "requestUserInput becomes request.opened and the answer is the response", "message during an active run
  starts the next turn after turn/completed", "process exit mid-run is run.failed".
- [ ] **Step 3:** run → FAIL. **Step 4:** implement. **Step 5:** run → PASS.
- [ ] **Step 6 (VPS, live):** record a simple turn, a command turn and a `requestUserInput` turn into fixtures
  (redacted), add fixture tests. Commit `feat(agent-bridge): Codex app-server adapter`.

### Task 5: devbox MCP server and `devbox_wait`

**Files:**
- Create: `image/agent-bridge/src/mcp.ts`, `image/agent-bridge/src/prompts.ts`
- Modify: `image/agent-bridge/package.json` (add `@modelcontextprotocol/sdk`, exact version)
- Test: `image/agent-bridge/test/mcp.test.ts`

**Interfaces:**
- Produces:
  - Command `agent-bridge mcp` (stdio MCP server). It connects to `/run/devd/agent.sock` and sends
    `{t:"cmd", cmd:{kind:"declareWait", ...}}` (add `declareWait` and `endWait` to `BridgeCommand`).
  - Tool `devbox_wait` with input `{ reason: string; kind: "command" | "ci"; timeoutMinutes?: number }`
    (default 60, max 240). The bridge adds `BackgroundWork{kind:"declared-wait", holding:true, until}` and
    returns `{ok:true, until}`. Tool `devbox_wait_done` `{}` clears it. Expiry clears it.
  - `prompts.ts`: `export const APPENDED_SYSTEM_PROMPT: string` telling the agent to call `devbox_wait` before
    ending a turn while it waits for a background command or CI, and `devbox_wait_done` when it stops waiting.
  - `export function claudeMcpServers(): Record<string, unknown>` → `{ devbox: { type: "stdio", command:
    "agent-bridge", args: ["mcp"] } }`; `export function codexMcpArgs(): string[]` → the `-c
    mcp_servers.devbox.command="agent-bridge"` / `args=["mcp"]` pair.
- [ ] **Step 1: Write the failing tests:** "devbox_wait declares holding work with until = now + timeout",
  "timeout above 240 is rejected with a tool error", "devbox_wait_done clears it", "expired declared wait is
  removed and background.changed emitted" (bridge-side handler with an injected clock).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(agent-bridge): devbox MCP server with devbox_wait`.

### Task 6: `agent-bridge serve`, launch env, container wiring, restart continuation

**Files:**
- Create: `image/agent-bridge/src/serve.ts`, `image/agent-bridge/src/continuation.ts`,
  `image/agent-bridge-launch.sh`
- Modify: `image/agent-bridge/src/main.ts` (subcommands `serve`, `mcp`), `image/entrypoint.sh`,
  `image/Dockerfile` (install `agent-bridge-launch` to `/usr/local/bin`)
- Test: `image/agent-bridge/test/serve.test.ts`, `image/agent-bridge/test/continuation.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `serve` reads `DEVD_AGENT` (`claude`|`codex`), `DEVD_RUNTIME=chat`, `CLAUDE_CONFIG_DIR` / `CODEX_HOME`,
    optional `DEVD_AGENT_MODEL`. It loads `state.json`, opens the harness session with `resume =
    state.nativeThreadId`, emits `bridge.started{resumed}`, and serves the socket.
  - `export function mayContinue(history: number[], now: number): boolean` — true when fewer than 3 entries are
    within the last 5 minutes (T3 `RestartContinuation.ts`).
  - `export const CONTINUATION_TEXT = "Your previous turn was cut short by a restart. Check whether its last
    action took effect, then continue."`
  - If `state.activeRunId` was set at start: emit `run.interrupted` for it; if `mayContinue`, start a run with
    `origin:"continuation"` and that text; else emit `run.failed{error:"restart loop: no automatic continuation"}`.
  - Pending requests found in the log without `request.resolved` are resolved with `by:"expired"` at start.
  - `agent-bridge-launch.sh`: for `claude` runs `/usr/local/bin/account-lease` and exports `CLAUDE_CONFIG_DIR`
    when it prints a dir (same as `agent-launch.sh`); for `codex` sources `codex-account-env.sh` and calls
    `codex_account_prepare` to get `CODEX_HOME`; unknown agent → message on stderr and exit 2. Then runs
    `agent-bridge serve` in a loop with a 2 s pause (it must outlive crashes; the loop is the supervisor).
  - `entrypoint.sh`: when `DEVD_RUNTIME=chat`, skip the hook seeds and `devbox-recovery`, start
    `agent-bridge-launch &` and `tmux new-session -d -s main -c /workspace zsh`; the tmux path is unchanged
    otherwise.
- [ ] **Step 1: Write the failing tests:** `mayContinue`: "allows the 3rd within 5 min, refuses the 4th", "an entry
  older than 5 min does not count". `serve` with a fake harness: "start with activeRunId emits run.interrupted then a
  continuation run", "4th restart in 5 min fails the run instead", "unresolved request in the log is expired at
  start", "startTurn during an active run is queued and persisted in state.queue".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Build the image locally or on the VPS (`docker build image`), run a container with
  `DEVD_RUNTIME=chat DEVD_AGENT=claude` and a mounted account, connect with `socat -
  UNIX-CONNECT:<controlDir>/agent.sock`, send hello + `startTurn "Reply with pong"`, expect events through
  `run.completed`. Record the transcript in the task report.
- [ ] **Step 6: Commit** `feat(agent-bridge): serve mode, launcher and restart continuation`.

### Task 7: `sessions.runtime` in devd

**Files:**
- Modify: `devd/src/db.ts` (column + `SessionRow.runtime`), `devd/src/sessions.ts` (`runOpts` env
  `DEVD_RUNTIME`), `devd/src/api.ts` (`POST /api/sessions` body `runtime?`), `devd/src/agents.ts`
  (`chatRuntimeBlock(agent, host): string | null`), `devd/src/accountSwitch.ts`, `devd/src/agentSwitch.ts`,
  `devd/src/codexSessionAccounts.ts`, `devd/src/ccUpkeep.ts` (chat sessions: no pane restarts; instead
  `links.send(id, {kind:"restartAgent"})` when the session's attention is not `working`, otherwise skipped with
  `cc_skipped reason busy` as for busy panes)
- Test: `devd/test/chatRuntime.test.ts` and the existing test files of each modified module

**Interfaces:**
- Produces: `type SessionRuntime = "tmux" | "chat"`; `SessionRow.runtime: SessionRuntime`;
  `chatRuntimeBlock(agent: AgentName, host: "vps" | "instabox"): string | null` returning
  `"Chat sessions run only on the VPS"` for instabox and `"<label> is not available in chat sessions yet"`
  for any agent other than `claude`/`codex`; switch modules return status `"wrong-runtime"` for chat sessions.
- [ ] **Step 1: Write the failing tests:** migration adds `runtime` with default `tmux` to an existing DB;
  `POST /api/sessions {runtime:"chat", agent:"claude"}` → 201 and the docker env has `DEVD_RUNTIME=chat`
  (assert on `runArgs` output); `{runtime:"chat", agent:"claude-gpt"}` → 400 with the message;
  `{runtime:"chat", host:"instabox"}` → 400; `{runtime:"bogus"}` → 400; `switchAccount`, `switchAgent`,
  `CodexSessionAccounts.switch` on a chat session → `wrong-runtime`; `ccUpkeep` never restarts a pane of a chat
  session, sends `restartAgent` to an idle one and skips a working one. Bridge side (Task 6 tests):
  "restartAgent while a run is active is refused", "restartAgent when idle reopens with resume".
- [ ] **Step 2–4:** FAIL → implement (follow the `sessionCols()` ALTER pattern, `db.ts:155-185`) → PASS.
- [ ] **Step 5: Commit** `feat(devd): chat session runtime column and guards`.

### Task 8: Thread store

**Files:**
- Create: `devd/src/threadStore.ts`
- Modify: `devd/src/sessions.ts` (`end()` moves the store next to the chat archive), `devd/src/chatArchive.ts`
  (accept an extra file to move)
- Test: `devd/test/threadStore.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ThreadItem { seq: number; runId: string | null; itemId: string | null; kind: "user" | "assistant" | "tool" | "request" | "notice";
  text: string; tool?: string; input?: unknown; output?: string; isError?: boolean; status?: "streaming" | "done" | "open" | "answered" | "expired"; ts: number }
export interface RunRow { runId: string; origin: RunOrigin; status: "queued" | "running" | "completed" | "interrupted" | "failed"; harness: string; nativeThreadId: string | null;
  model: string | null; startedAt: number | null; endedAt: number | null; usage: TokenUsage | null; error: string | null }
export interface ThreadSnapshot { lastSeq: number; seenSeq: number; runs: RunRow[]; items: ThreadItem[]; pending: PendingRequest[]; background: BackgroundWork[]; native: { harness: string; nativeThreadId: string; account: string | null; model: string | null } | null }
export class ThreadStore {
  static open(root: string, sessionId: string): ThreadStore;  // <root>/_threads/<id>.sqlite, WAL, creates schema
  apply(e: LoggedEvent): boolean;                 // false when e.seq <= lastSeq (idempotent)
  lastSeq(): number;
  snapshot(opts?: { afterSeq?: number; limit?: number }): ThreadSnapshot;
  markSeen(seq: number): void;                    // monotonic
  close(): void;
}
```

Tables: `meta(key PRIMARY KEY, value)` (`last_seq`, `seen_seq`), `runs`, `items`, `requests`, `background`
(one row, JSON), `native`. `message.delta` appends to the item's text with `status:"streaming"`;
`message.final` replaces the text and sets `done`. The bridge event types are imported from
`image/agent-bridge/src/events.ts` (type-only import, as `tools/metering` does).
- [ ] **Step 1: Write the failing tests:** "deltas then final produce one assistant item with the final text",
  "applying the same seq twice is a no-op", "seq gap is accepted (log was trimmed) but lastSeq is the max",
  "run lifecycle queued→running→completed with usage", "request opened then resolved by expired",
  "background.changed replaces the set", "markSeen never moves backwards", "snapshot afterSeq returns only newer
  items", "end() moves the store into the chat archive dir".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(devd): per-session thread store`.

### Task 9: Bridge links in devd

**Files:**
- Create: `devd/src/bridgeLink.ts`
- Modify: `devd/src/index.ts` (start links for running chat sessions at boot and after `open`, stop on
  `end`/`stop`)
- Test: `devd/test/bridgeLink.test.ts`

**Interfaces:**
- Consumes: `ThreadStore`, protocol frames (type-only import from the bridge package).
- Produces:

```ts
export type LinkStatus = "connecting" | "connected" | "disconnected";
export class BridgeLinks {
  constructor(d: { controlDir: (id: string) => string; store: (id: string) => ThreadStore; onEvent: (sessionId: string, e: LoggedEvent) => void;
    onStatus: (sessionId: string, s: LinkStatus) => void; now?: () => number; retryMs?: number });
  ensure(sessionId: string): void; drop(sessionId: string): void; status(sessionId: string): LinkStatus;
  send(sessionId: string, cmd: BridgeCommand, timeoutMs?: number): Promise<void>; // throws AgentDisconnected / CommandFailed(message)
}
export class AgentDisconnected extends Error {}
```

Connect to `<controlDir(id)>/agent.sock`, send `hello{afterSeq: store.lastSeq()}`, apply every event to the store
before calling `onEvent`, retry every `retryMs` (default 2000) while the session is running, log each
disconnect once (not every retry).
- [ ] **Step 1: Write the failing tests** with a real unix socket server in a temp dir speaking the frame
  protocol: "reconnect replays only events after the stored seq", "events are stored before onEvent fires",
  "commands fail with agent-disconnected when no socket", "a command error comes back as CommandFailed with the
  bridge's message", "status goes connected → disconnected → connected across a server restart".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(devd): bridge links with replay and reconnect`.

### Task 10: Attention and the hub adapter

**Files:**
- Create: `devd/src/attention.ts`, `devd/src/chatHub.ts`
- Modify: `devd/src/index.ts` (wire `chatHub` into `BridgeLinks.onEvent` / `onStatus`)
- Test: `devd/test/attention.test.ts`, `devd/test/chatHub.test.ts`

**Interfaces:**
- Produces:

```ts
export type InboxSection = "needs_you" | "working" | "idle";
export interface Attention { section: InboxSection; reason: "request" | "failed" | "completed" | "disconnected" | "running" | "background" | "queued" | null; since: number }
export function chatAttention(t: ThreadSnapshot, link: LinkStatus, now: number): Attention;
export function tmuxAttention(live: AgentLiveSnapshot | null, now: number): Attention; // from today's hub state: waiting/failed → needs_you, working/stalled → working, done → needs_you until seen, else idle
export const WORKING_GRACE_MS = 2000;
export class ChatHub { constructor(d: { hub: AgentEventHub; session: (id: string) => SessionRow | null; now?: () => number; holdMs?: number }); onEvent(sessionId: string, e: LoggedEvent, t: ThreadSnapshot): void }
```

Rules (spec "Attention model"):
- needs_you: an open request; the last run failed; the last run completed, no holding background work, and
  `seenSeq < seq of that completion`; link `disconnected` while the session is running.
- working: a running or queued run; or holding background work; or a run ended less than `WORKING_GRACE_MS` ago.
- idle: otherwise (completed and seen).
- `ChatHub` maps to `hub.handle` with the same `AgentEvent` names the hooks use: `run.started` →
  `user_prompt_submit` (with `promptId = runId`); `tool.started`/`tool.finished` → `tool_start`/`tool_complete`;
  `request.opened` → `permission_request` for approvals and `tool_start` of `AskUserQuestion` for questions/plans
  (so `QUESTION_TOOLS` handling applies unchanged); `run.completed` → `stop` with
  `meta.backgroundTasks = count(holding)`; `background.changed` that drops holding to 0 after a completed run →
  `stop` again; `run.failed` → `stop_failure`; `run.interrupted` → `interrupted`.
- [ ] **Step 1: Write the failing tests:** attention: "completed run with holding work is working, not
  needs-you", "completed and unseen is needs-you; after markSeen it is idle", "open request is needs-you even
  with holding work", "disconnected is needs-you", "a run that ended 1 s ago is still working". ChatHub with a
  real `AgentEventHub` over `openDb(":memory:")` and a recording `notify`: "done is sent once holding work clears",
  "no done while a wakeup is pending", "question notifies as blocked input", "failed run sends the failure path".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(devd): chat attention and hub adapter`.

### Task 11: Thread API, inbox API and SSE

**Files:**
- Create: `devd/src/eventBus.ts`, `devd/src/threadApi.ts` (route registration function called from
  `createApp`), `devd/src/inbox.ts`
- Modify: `devd/src/api.ts` (`ApiDeps` gains `links`, `threads`, `bus`; call `registerThreadRoutes(app, d)`)
- Test: `devd/test/threadApi.test.ts`, `devd/test/inbox.test.ts`

**Interfaces:**
- Produces routes (all JSON, behind the existing middleware):
  - `GET /api/sessions/:id/thread?afterSeq=N&limit=M` → `ThreadSnapshot` (404 unknown session, 409 for a tmux
    session).
  - `POST /api/sessions/:id/thread/messages {text}` → 202 `{queued:true}`; empty text 400; 409
    `{error:"agent-disconnected"}`.
  - `POST /api/sessions/:id/thread/interrupt` → 202.
  - `POST /api/sessions/:id/thread/requests/:requestId {answer}` → 202; unknown or resolved request 409.
  - `POST /api/sessions/:id/thread/seen {seq}` → 204.
  - `GET /api/inbox` → `{ items: InboxItem[] }` where `InboxItem = { sessionId, runtime, title, project, repo,
    agent, attention: Attention, lastText: string | null }`, sorted needs_you (oldest `since` first), working,
    idle (newest first). tmux sessions use `tmuxAttention` and carry `runtime:"tmux"`.
  - `GET /api/stream?session=<id>[&afterSeq=N]` → SSE (R11.1; `/api/events` stays the JSON event log). Events: `inbox` (full `InboxItem` on change, coalesced to at most one per
    session per 250 ms), `thread` (`LoggedEvent` for the subscribed session only), `ping` every 25 s.
  - `eventBus.ts`: `class EventBus { publish(topic: "inbox" | `thread:${string}`, data: unknown): void; subscribe(topics, cb): () => void }`.
- [ ] **Step 1: Write the failing tests** (pattern of `devd/test/agentEventApi.test.ts`: `createApp({...} as never)`
  with `openDb(":memory:")`, a fake `links` and a temp-dir `ThreadStore`): every route's success and error codes
  above; "inbox orders needs_you oldest first"; "SSE delivers a thread event for the subscribed session and not for
  others" (read the first chunks of the response body); "inbox events are coalesced".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(devd): thread and inbox API with SSE`.

### Task 12: Dashboard: inbox, chat, terminal tab

**Files:**
- Create: `dashboard/src/threadView.ts`, `dashboard/src/inboxView.ts`, `dashboard/src/useEventStream.ts`,
  `dashboard/src/pages/Inbox.tsx`, `dashboard/src/pages/SessionPage.tsx`,
  `dashboard/src/components/chat/{MessageList,ToolCall,RequestForm,Composer}.tsx`
- Modify: `dashboard/src/api.ts` (thread/inbox calls and types), `dashboard/src/App.tsx` (routes: `/inbox` → Inbox
  with a nav entry, `/` stays Overview until the default flips in step 6 (ruling R12.1), `/s/:id` → SessionPage;
  `/sessions` stays), `dashboard/src/pages/Sessions.tsx` (`NewSession`: runtime toggle,
  default `tmux`), `dashboard/src/terminalRoute.ts` (`?thread=<id>` deep link → `/#/s/<id>`)
- Test: `dashboard/src/threadView.test.ts`, `dashboard/src/inboxView.test.ts`, `dashboard/src/terminalRoute.test.ts`

**Interfaces:**
- Produces: `applyThreadEvent(t: ThreadSnapshot, e: LoggedEvent): ThreadSnapshot` (pure; same semantics as
  `ThreadStore.apply`, ignores `seq <= lastSeq`); `groupInbox(items: InboxItem[]): { needsYou; working; idle }`;
  `useEventStream(sessionId?: string)` (EventSource on `api/stream`, reconnects with `Last-Event-ID` = last seq,
  falls back to a 5 s poll of `/api/inbox` only while the stream is down and shows "live updates paused").
- UI (existing style: Tailwind v4, shadcn components, IBM Plex):
  - Inbox: three sections, "Working" collapsed by default, each row shows title, agent badge, `tmux` badge for tmux
    sessions, reason, relative time. Clicking a chat row opens `/s/:id`; a tmux row opens `/terminal/:id`.
  - SessionPage: tabs Chat | Terminal. Chat: message list (markdown for assistant text, collapsible tool calls with
    command and output), inline RequestForm (options as buttons, free-text field, multi-select when set), Composer
    (textarea, Enter sends, Shift+Enter newline, Stop button while a run is active, queued messages shown as
    queued). Opening the page posts `thread/seen` with the last seq. Terminal: the existing `Terminal`
    component on tmux target `main`.
- [ ] **Step 1: Write the failing tests:** `applyThreadEvent` "deltas then final", "duplicate seq ignored",
  "request resolved updates the item"; `groupInbox` ordering; deep link `?thread=x` → `/s/x`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`bun test dashboard`, `bun run typecheck`).
- [ ] **Step 5:** Visual check headless (Playwright in a container) against a
  devd with a fake thread: Inbox, SessionPage chat with a tool call and an open question, mobile width 390 px.
  Attach screenshots to the task report.
- [ ] **Step 6: Commit** `feat(dashboard): inbox, chat view and terminal tab`.

### Task 13: Live verification on the VPS and the step report

**Files:**
- Create: `docs/superpowers/reports/2026-11-agent-runtime-v2-step2.md`

This task needs a merged + deployed `main` and the owner, because a deploy that changes `devd/` restarts devd and
locks the vault.

- [ ] **Step 1:** PR, CI green, local merge as LNRT, deploy with `devbox-update`; tell the owner to unlock the vault.
- [ ] **Step 2: Scenarios** (each with evidence: API responses, inbox snapshots, notify_log rows):
  1. Claude chat: two turns, a tool call, a question answered from the dashboard, Stop mid-turn.
  2. Codex chat: two turns with a command, interrupt.
  3. Claude turn ending with `ScheduleWakeup` 2 min: inbox "working" during the wait, one "done" notification
     after the woken run, none before.
  4. `devbox_wait` with `kind:"ci"`: holding until `devbox_wait_done`.
  5. devd restart during a long Claude turn (owner present to unlock the vault): the turn keeps streaming, the
     thread has no duplicates or gaps.
  6. `docker restart` of the container mid-turn: one continuation run, conversation resumed.
  7. Terminal tab: run a shell command in the worktree.
  8. An existing tmux session: unchanged behavior, listed in the inbox with the `tmux` badge.
- [ ] **Step 3:** Write the report, link it in Plane DEVBOX-24, commit `docs: step 2 verification report`.
