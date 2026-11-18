# Agent runtime v2, step 4: ACP adapter and Grok, Vibe, Antigravity, OpenCode. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One generic ACP adapter in the bridge, so chat sessions can run Grok Build, Mistral Vibe, Antigravity
and OpenCode (and any ACP Registry agent), with each agent verified live. Switching to and from them uses
step 3's handoff.

**Architecture:** `acpSession.ts` implements `HarnessSession` over ACP (stdio JSON-RPC, reusing `JsonRpcPeer` from
step 2). Per-agent differences live in a small table of capability overrides, never in `if (agent === …)`
branches outside it. Inbox and handoff read `capabilities()`, never agent names.

**Tech Stack:** as step 2; Grok (`grok`, image pinned 1.0.13) and Antigravity (`agy`) are already in the image;
Vibe and OpenCode are added, pinned.

**Spec:** `docs/superpowers/specs/2026-11-18-agent-runtime-v2-design.md` (Harness adapters / ACP). Requires
steps 2 and 3. T3 reference (commit `eebb6bcc`): its ACP adapter and per-agent quirks (Grok launch args,
Vibe `-31001`, Antigravity client name and mode limits).

## Global Constraints

- Everything in step 2's Global Constraints.
- ACP methods: `initialize`, `session/new`, `session/load` | `session/resume`, `session/prompt`,
  `session/cancel`, `session/set_model`, `session/request_permission`, `session/update`.
- Negotiate v1/v2 by response shape, not the reported version (Antigravity reports v2 with a v1 shape).
- OpenCode goes through ACP, not its native HTTP server.
- Logins are the agents' own CLI logins in per-agent volumes; devbox never offers a login of its own.
- Antigravity and proxy agents stay blocked on InstaBox (`instaboxAgentBlock`), and chat is VPS-only anyway.

## Review Focus

1. **Agent asks for permission although devbox runs everything approved.** `session/request_permission` is
   answered with the "allow always" option automatically unless the request is a question-like prompt. Test:
   Task 2 "permission requests are auto-allowed".
2. **Rate limit (Vibe `-31001`, others' 429-like errors).** The run fails with reason `rate-limited` and the inbox
   shows it under needs-you; no retry loop. Test: Task 3 "Vibe -31001 is run.failed rate-limited".
3. **Agent has no `session/load`.** Resume capability is false; switching back to it uses a fresh thread with a
   full handoff. Test: Task 2 "no load capability means resume false".
4. **The agent process exits between turns.** The bridge restarts it with load/resume on the next message, or a
   fresh session plus handoff when it cannot. Test: Task 2 "process exit between turns restarts on next message".
5. **Images not supported by an agent.** Capability `images:false` makes the bridge send the `/inbox` path
   fallback (step 5). Test: Task 2 capability table test.

---

### Task 1: Install and log in Vibe and OpenCode

**Files:** Modify `image/Dockerfile` (pinned installs, verified as non-root like grok), `devd/src/index.ts`
`extraMounts` (`vibe-home:/home/dev/.vibe`, `opencode-home:/home/dev/.local/share/opencode`; confirm the real config
paths from each CLI's docs at the pinned version), `docs/` agent docs.

- [ ] **Step 1:** Find the current releases, pin versions in `ARG`s, install, `su … nobody -c '<bin> --version'`.
- [ ] **Step 2:** Confirm each CLI's ACP entry (`vibe-acp` / `vibe acp`, `opencode acp`) prints an `initialize`
  response on stdio. Record the exact argv in the task report.
- [ ] **Step 3:** Owner logs in once in a chat session's Terminal tab (credentials land in the volumes). This needs
  the owner's Mistral/OpenCode provider accounts: if the owner has none for an agent, that agent is skipped and
  reported, not faked.
- [ ] **Step 4: Commit** `feat(image): Mistral Vibe and OpenCode CLIs`.

### Task 2: Generic ACP adapter

**Files:** Create `image/agent-bridge/src/acpSession.ts`, `image/agent-bridge/src/acpAgents.ts`; tests
`image/agent-bridge/test/acpSession.test.ts`, fixtures `test/fixtures/acp-*.jsonl`.

**Interfaces:**
```ts
export interface AcpAgentSpec { id: "grok" | "vibe" | "antigravity" | "opencode" | string; argv: string[]; env?: Record<string, string>;
  clientName?: string; rateLimitCodes?: number[]; modes?: { allowed: string[] }; overrides?: Partial<Capabilities> }
export const ACP_AGENTS: Record<string, AcpAgentSpec>;    // grok: ["grok","agent","--always-approve","stdio"], …
export function openAcpSession(o: { spec: AcpAgentSpec; cwd: string; model: string | null; resume: string | null;
  mcpServers: { name: string; command: string; args: string[] }[]; emit: (e: BridgeEvent) => void }, spawn?: SpawnFn): HarnessSession;
export function negotiate(initResult: unknown): { version: 1 | 2; caps: Capabilities };
```
Mapping: `session/update` agent message chunks → `message.delta`/`message.final`; tool call / tool call update →
`tool.started`/`tool.finished`; plan updates → a `tool` item kind `plan`; `session/prompt` result stop reason →
`run.completed` / `run.interrupted` / `run.failed`; `session/request_permission` → auto-allow (choose the
"allow_always"/"allow_once" option id) and log it as a tool item; devbox MCP server passed in `session/new`
`mcpServers` (stdio).
- [ ] **Step 1: Tests** (fake spawn + fixtures): v1 and v2 negotiation incl. "v2 reported with v1 shape";
  prompt turn with chunks, a tool call and a plan; cancel; "permission requests are auto-allowed"; "no load
  capability means resume false"; "process exit between turns restarts on next message"; capability table per
  agent.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(agent-bridge): generic ACP adapter`.

### Task 3: Per-agent overrides, live, one agent at a time

For each of Grok, Vibe, Antigravity, OpenCode, in that order, as separate commits:
- [ ] Record a live fixture (one turn with a tool call), add the fixture test, adjust `ACP_AGENTS[<id>]` only.
- [ ] Specific tests: Grok launch args; "Vibe -31001 is run.failed rate-limited"; Antigravity client name and the
  mode limit (only allowed modes are requested); OpenCode model listing for `session/set_model`.
- [ ] Enable the agent in `chatRuntimeBlock` (devd) and in the composer harness menu.
- [ ] Live check in a chat session: two turns, switch to Claude and back (delta or full handoff per capability).
- [ ] Commit `feat: <agent> in chat sessions`.

### Task 4: Report

- [ ] `docs/superpowers/reports/2026-11-agent-runtime-v2-step4.md`: per agent what works (resume, model switch,
  questions, images, background visibility), known gaps, versions. Plane update. Commit.
