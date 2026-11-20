import { describe, expect, test } from "bun:test";
import { ResumeFailedError } from "../src/claudeSession.ts";
import { CODEX_CAPABILITIES, openCodexSession, spawnCodex, type CodexSpawn } from "../src/codexSession.ts";
import type { BridgeEvent } from "../src/events.ts";
import {
  commandApprovalRequest,
  simpleTurn,
  THREAD_ID,
  threadResumeResponse,
  threadStartResponse,
  turn,
  turnStartResponse,
  userInputRequest,
} from "./fixtures/codexProtocol.ts";

interface Sent {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

// model/list as app-server answers it (v2 Model, the fields the adapter reads).
const MODEL_LIST = {
  data: [
    { id: "gpt-5.5-codex", model: "gpt-5.5-codex", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], defaultReasoningEffort: "medium" },
    { id: "gpt-5.4-mini", model: "gpt-5.4-mini", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], defaultReasoningEffort: "low" },
  ],
  nextCursor: null,
};

// Scripted app-server: answers client requests from `responders`, lets the test push notifications and
// server requests, and records everything the session wrote to stdin.
function fakeCodex() {
  const sent: Sent[] = [];
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let exit: (code: number) => void = () => {};
  let turnSeq = 0;
  const fake = {
    sent,
    argv: [] as string[],
    env: {} as Record<string, string>,
    killed: false,
    responders: {
      initialize: () => ({ userAgent: "codex/0.169.0", codexHome: "/home/dev/.codex", platformFamily: "unix", platformOs: "linux" }),
      "thread/start": () => threadStartResponse(),
      "thread/resume": (p: any) => threadResumeResponse(p.threadId),
      "turn/start": () => turnStartResponse(`turn-${++turnSeq}`),
      "turn/interrupt": () => ({}),
      "model/list": () => MODEL_LIST,
    } as Record<string, ((params: any) => unknown) | undefined>,
    push(...msgs: unknown[]) {
      pending.push(...msgs.map((m) => JSON.stringify(m)));
      wake?.();
    },
    exit(code: number) {
      ended = true;
      wake?.();
      exit(code);
    },
    requests(method: string) {
      return sent.filter((m) => m.method === method && m.id !== undefined);
    },
    responseTo(id: number | string) {
      return sent.find((m) => m.id === id && m.method === undefined);
    },
    spawn: ((argv: string[], env: Record<string, string>) => {
      fake.argv = argv;
      fake.env = env;
      const lines = (async function* () {
        while (true) {
          while (pending.length) yield pending.shift()!;
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      })();
      return {
        stdin: {
          write(s: string) {
            for (const line of s.split("\n").filter(Boolean)) {
              const msg = JSON.parse(line) as Sent;
              sent.push(msg);
              const respond = msg.method !== undefined && msg.id !== undefined ? fake.responders[msg.method] : undefined;
              if (!respond) continue;
              try {
                fake.push({ id: msg.id, result: respond(msg.params) });
              } catch (e) {
                fake.push({ id: msg.id, error: { code: -32600, message: (e as Error).message } });
              }
            }
          },
        },
        lines,
        exited: new Promise<number>((r) => (exit = r)),
        kill() {
          fake.killed = true;
          fake.exit(143);
        },
      };
    }) as CodexSpawn,
  };
  return fake;
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

function open(fake: ReturnType<typeof fakeCodex>, o: { resume?: string | null; model?: string | null; effort?: string | null } = {}) {
  const events: BridgeEvent[] = [];
  const efforts: BridgeEvent[] = [];
  const logs: string[] = [];
  const session = openCodexSession(
    {
      cwd: "/workspace",
      model: o.model === undefined ? "gpt-5.5-codex" : o.model,
      codexHome: "/tmp/codex-home",
      resume: o.resume ?? null,
      mcpConfigArgs: ["-c", 'mcp_servers.devbox.command="agent-bridge"'],
      developerInstructions: "call devbox_wait",
      // effort.state is asserted on its own (the effort tests); the other tests read the thread's events.
      emit: (e) => (e.type === "effort.state" ? efforts : events).push(e),
      logError: (m) => logs.push(m),
      ...(o.effort !== undefined ? { effort: o.effort } : {}),
    },
    fake.spawn,
  );
  return { session, events, logs, efforts };
}

const types = (events: BridgeEvent[]) => events.map((e) => e.type);

describe("openCodexSession", () => {
  test("thread/start then turn/start; deltas, final message, command item, turn completed with usage", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "list files", "user");
    await until(() => fake.requests("turn/start").length === 1);

    expect(fake.argv).toEqual(["codex", "app-server", "-c", 'mcp_servers.devbox.command="agent-bridge"']);
    expect(fake.env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(fake.sent.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start", "model/list", "turn/start"]);
    expect(fake.requests("initialize")[0]!.params).toEqual({
      clientInfo: { name: "devbox-agent-bridge", title: null, version: expect.any(String) },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    expect(fake.requests("thread/start")[0]!.params).toEqual({
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "call devbox_wait",
    });
    expect(fake.requests("turn/start")[0]!.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "list files", text_elements: [] }],
      model: "gpt-5.5-codex",
    });

    fake.push(...simpleTurn("turn-1"));
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(events).toEqual([
      { type: "thread.native", harness: "codex", nativeThreadId: THREAD_ID, account: null, model: "gpt-5.5-codex", caps: CODEX_CAPABILITIES },
      { type: "run.started", runId: "run-1", origin: "user", nativeThreadId: THREAD_ID, model: "gpt-5.5-codex" },
      { type: "message.delta", runId: "run-1", itemId: "msg_1", text: "Lis" },
      { type: "message.delta", runId: "run-1", itemId: "msg_1", text: "ting" },
      { type: "message.final", runId: "run-1", itemId: "msg_1", role: "assistant", text: "Listing" },
      { type: "tool.started", runId: "run-1", itemId: "call_1", tool: "command", input: "ls -la" },
      { type: "tool.finished", runId: "run-1", itemId: "call_1", isError: false, output: "a\nb\n" },
      { type: "message.final", runId: "run-1", itemId: "msg_2", role: "assistant", text: "Two files." },
      {
        type: "run.completed",
        runId: "run-1",
        nativeThreadId: THREAD_ID,
        // Turn usage = last total minus the total before the turn's first response (total - last of the
        // first update): input 1400-1000, cached 250-100, output 90-50. Codex input tokens include cached
        // ones; TokenUsage keeps them apart like the harvester does.
        usage: { input: 400 - 150, output: 40, cacheCreation: 0, cacheRead: 150 },
        costUsd: null,
      },
    ]);
  });

  test("resume uses thread/resume with the stored id", async () => {
    const fake = fakeCodex();
    const resumed = "019a0000-0000-7000-8000-0000000000aa";
    const { session, events } = open(fake, { resume: resumed });
    await session.startTurn("run-1", "go on", "continuation");
    await until(() => fake.requests("turn/start").length === 1);
    expect(fake.requests("thread/start")).toEqual([]);
    expect(fake.requests("thread/resume")[0]!.params).toEqual({
      threadId: resumed,
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "call devbox_wait",
    });
    expect(fake.requests("turn/start")[0]!.params.threadId).toBe(resumed);
    expect(events[0]).toEqual({ type: "thread.native", harness: "codex", nativeThreadId: resumed, account: null, model: "gpt-5.5-codex", caps: CODEX_CAPABILITIES });
    expect(events[1]).toMatchObject({ type: "run.started", runId: "run-1", origin: "continuation", nativeThreadId: resumed });
  });

  test("images go to turn/start as localImage items after the text", async () => {
    const fake = fakeCodex();
    const { session } = open(fake);
    await session.startTurn("run-1", "what is this?", "user", ["/inbox/s/a.png", "/inbox/s/b.webp"]);
    await until(() => fake.requests("turn/start").length === 1);
    expect(fake.requests("turn/start")[0]!.params.input).toEqual([
      { type: "text", text: "what is this?", text_elements: [] },
      { type: "localImage", path: "/inbox/s/a.png" },
      { type: "localImage", path: "/inbox/s/b.webp" },
    ]);
  });

  test("a model of null is not sent with turn/start", async () => {
    const fake = fakeCodex();
    const { session } = open(fake, { model: null });
    await session.startTurn("run-1", "hi", "user");
    await until(() => fake.requests("turn/start").length === 1);
    expect("model" in fake.requests("turn/start")[0]!.params).toBe(false);
  });

  test("requestUserInput becomes request.opened and the answer is the response", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "set up a db", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ method: "turn/started", params: { threadId: THREAD_ID, turn: turn("turn-1", "inProgress") } });
    fake.push({ id: 0, method: "item/tool/requestUserInput", params: userInputRequest("turn-1") });
    await until(() => events.some((e) => e.type === "request.opened"));
    const opened = events.find((e) => e.type === "request.opened") as Extract<BridgeEvent, { type: "request.opened" }>;
    expect(opened).toEqual({
      type: "request.opened",
      runId: "run-1",
      requestId: opened.requestId,
      kind: "question",
      prompt: "Which database?",
      options: [
        { label: "Postgres", description: "server" },
        { label: "SQLite", description: "file" },
      ],
    });
    expect(fake.responseTo(0)).toBeUndefined();

    await session.answer(opened.requestId, "SQLite");
    await until(() => fake.responseTo(0) !== undefined);
    expect(fake.responseTo(0)).toEqual({ id: 0, result: { answers: { db: { answers: ["SQLite"] } } } });
    expect(events.at(-1)).toEqual({ type: "request.resolved", requestId: opened.requestId, answer: "SQLite", by: "user" });
  });

  test("a question without text is refused with an error and logged, never opened", async () => {
    const fake = fakeCodex();
    const { session, events, logs } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    const params = userInputRequest("turn-1");
    params.questions[0]!.question = "";
    fake.push({ id: 0, method: "item/tool/requestUserInput", params });
    await until(() => fake.responseTo(0) !== undefined);
    expect(fake.responseTo(0)!.error!.message).toContain("no question text");
    expect(events.some((e) => e.type === "request.opened")).toBe(false);
    expect(logs.some((l) => l.includes("requestUserInput"))).toBe(true);
  });

  test("a command approval becomes an approval request; Accept accepts, other text declines", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "clean", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ id: 0, method: "item/commandExecution/requestApproval", params: commandApprovalRequest("turn-1") });
    fake.push({ id: 1, method: "item/commandExecution/requestApproval", params: commandApprovalRequest("turn-1") });
    await until(() => events.filter((e) => e.type === "request.opened").length === 2);
    const [a, b] = events.filter((e) => e.type === "request.opened") as Extract<BridgeEvent, { type: "request.opened" }>[];
    expect(a).toMatchObject({ kind: "approval", prompt: "needs to delete build output\n\nrm -rf dist", options: [{ label: "Accept" }, { label: "Decline" }] });
    await session.answer(a!.requestId, "Accept");
    await session.answer(b!.requestId, "no, keep it");
    await until(() => fake.responseTo(1) !== undefined);
    expect(fake.responseTo(0)).toEqual({ id: 0, result: { decision: "accept" } });
    expect(fake.responseTo(1)).toEqual({ id: 1, result: { decision: "decline" } });
  });

  test("message during an active run starts the next turn after turn/completed", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "first", "user");
    await until(() => fake.requests("turn/start").length === 1);
    await session.startTurn("run-2", "second", "user");
    fake.push({ method: "turn/started", params: { threadId: THREAD_ID, turn: turn("turn-1", "inProgress") } });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.requests("turn/start")).toHaveLength(1);
    expect(types(events)).toEqual(["thread.native", "run.started"]);

    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "completed") } });
    await until(() => fake.requests("turn/start").length === 2);
    expect(fake.requests("turn/start")[1]!.params.input).toEqual([{ type: "text", text: "second", text_elements: [] }]);
    expect(types(events)).toEqual(["thread.native", "run.started", "run.completed", "run.started"]);
    expect(events.at(-1)).toMatchObject({ runId: "run-2" });
  });

  test("a turn started before the thread is ready waits for it", async () => {
    const fake = fakeCodex();
    fake.responders["thread/start"] = undefined;
    const { session } = open(fake);
    await session.startTurn("run-1", "early", "user");
    await until(() => fake.requests("thread/start").length === 1);
    expect(fake.requests("turn/start")).toHaveLength(0);
    fake.push({ id: fake.requests("thread/start")[0]!.id, result: threadStartResponse() });
    await until(() => fake.requests("turn/start").length === 1);
  });

  test("interrupt sends turn/interrupt; run.interrupted comes before the next run.started", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "long", "user");
    await until(() => fake.requests("turn/start").length === 1);
    await session.startTurn("run-2", "next", "user");
    await session.interrupt();
    expect(fake.requests("turn/interrupt")[0]!.params).toEqual({ threadId: THREAD_ID, turnId: "turn-1" });
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "interrupted") } });
    await until(() => fake.requests("turn/start").length === 2);
    expect(types(events)).toEqual(["thread.native", "run.started", "run.interrupted", "run.started"]);
  });

  test("notifications without params or of other threads are ignored", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ method: "skills/changed" });
    fake.push({ method: "item/agentMessage/delta", params: { threadId: "other-thread", turnId: "t9", itemId: "m9", delta: "sub" } });
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "completed") } });
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(types(events)).toEqual(["thread.native", "run.started", "run.completed"]);
  });

  test("a completed turn without a usage update has usage null and is logged", async () => {
    const fake = fakeCodex();
    const { session, events, logs } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "completed") } });
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(events.at(-1)).toEqual({ type: "run.completed", runId: "run-1", nativeThreadId: THREAD_ID, usage: null, costUsd: null });
    expect(logs).toContain("codex turn turn-1 completed without a token usage update; usage is null");
  });

  test("a straggler of the previous turn does not bind the next run to it", async () => {
    const fake = fakeCodex();
    const { session, events, logs } = open(fake);
    await session.startTurn("run-1", "first", "user");
    await until(() => fake.requests("turn/start").length === 1);
    await session.startTurn("run-2", "second", "user");
    fake.responders["turn/start"] = undefined;
    const late = simpleTurn("turn-1").find((n) => n.method === "thread/tokenUsage/updated")!;
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "completed") } }, late);
    await until(() => fake.requests("turn/start").length === 2);
    await until(() => logs.some((l) => l.includes("completed turn turn-1 dropped")));
    fake.push({ id: fake.requests("turn/start")[1]!.id, result: turnStartResponse("turn-2") });
    fake.push(...simpleTurn("turn-2"));
    await until(() => events.filter((e) => e.type === "run.completed").length === 2);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: "run-2", usage: { input: 250, output: 40, cacheCreation: 0, cacheRead: 150 } });
  });

  test("an open request expires when its turn completes", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ id: 4, method: "item/tool/requestUserInput", params: userInputRequest("turn-1") });
    await until(() => events.some((e) => e.type === "request.opened"));
    const opened = events.find((e) => e.type === "request.opened") as Extract<BridgeEvent, { type: "request.opened" }>;
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "completed") } });
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(types(events).slice(-2)).toEqual(["request.resolved", "run.completed"]);
    expect(events.at(-2)).toEqual({ type: "request.resolved", requestId: opened.requestId, answer: null, by: "expired" });
    await until(() => fake.responseTo(4) !== undefined);
    expect(fake.responseTo(4)!.error).toBeDefined();
  });

  test("a secret question is refused, logged and never opened", async () => {
    const fake = fakeCodex();
    const { session, events, logs } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    const params = userInputRequest("turn-1");
    params.questions[0]!.isSecret = true;
    fake.push({ id: 0, method: "item/tool/requestUserInput", params });
    await until(() => fake.responseTo(0) !== undefined);
    expect(fake.responseTo(0)!.error!.message).toBe("secret input requested; not supported in chat sessions");
    expect(types(events)).toEqual(["thread.native", "run.started"]);
    expect(logs.some((l) => l.includes("secret input requested; not supported in chat sessions"))).toBe(true);
  });

  test("turn/completed before the turn/interrupt response reports the interrupt once", async () => {
    const fake = fakeCodex();
    fake.responders["turn/interrupt"] = undefined;
    const { session, events } = open(fake);
    await session.startTurn("run-1", "long", "user");
    await until(() => fake.requests("turn/start").length === 1);
    const interrupted = session.interrupt();
    await until(() => fake.requests("turn/interrupt").length === 1);
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "interrupted") } });
    await until(() => events.some((e) => e.type === "run.interrupted"));
    fake.push({ id: fake.requests("turn/interrupt")[0]!.id, result: {} });
    await interrupted;
    expect(types(events)).toEqual(["thread.native", "run.started", "run.interrupted"]);
  });

  test("host Claude session variables are not passed to codex", async () => {
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION_ID = "host";
    try {
      const fake = fakeCodex();
      open(fake);
      expect("CLAUDECODE" in fake.env).toBe(false);
      expect("CLAUDE_CODE_SESSION_ID" in fake.env).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("file change diffs and output are capped", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    const huge = "+".repeat(100 * 1024);
    const item = { type: "fileChange" as const, id: "patch_1", status: "completed" as const, changes: [{ path: "a.txt", kind: { type: "add" as const }, diff: huge }] };
    fake.push({ method: "item/completed", params: { threadId: THREAD_ID, turnId: "turn-1", item, completedAtMs: 1 } });
    await until(() => events.some((e) => e.type === "tool.finished"));
    const started = events.find((e) => e.type === "tool.started") as Extract<BridgeEvent, { type: "tool.started" }>;
    expect((started.input as { diff: string }[])[0]!.diff.length).toBe(64 * 1024);
    expect(events.at(-1)).toEqual({ type: "tool.finished", runId: "run-1", itemId: "patch_1", isError: false, output: "add a.txt" });
  });

  test("a failed turn is run.failed with the turn error", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ method: "turn/completed", params: { threadId: THREAD_ID, turn: turn("turn-1", "failed", "usage limit reached") } });
    await until(() => events.some((e) => e.type === "run.failed"));
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "usage limit reached" });
  });

  test("process exit mid-run is run.failed; open requests expire and queued runs fail", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    await session.startTurn("run-2", "y", "user");
    fake.push({ id: 0, method: "item/tool/requestUserInput", params: userInputRequest("turn-1") });
    await until(() => events.some((e) => e.type === "request.opened"));
    const opened = events.find((e) => e.type === "request.opened") as Extract<BridgeEvent, { type: "request.opened" }>;
    fake.exit(137);
    await until(() => events.filter((e) => e.type === "run.failed").length === 2);
    expect(events.slice(-3)).toEqual([
      { type: "request.resolved", requestId: opened.requestId, answer: null, by: "expired" },
      { type: "run.failed", runId: "run-1", error: "codex app-server exited with code 137" },
      { type: "run.failed", runId: "run-2", error: "codex app-server exited with code 137" },
    ]);
    expect(await session.startTurn("run-3", "z", "user").catch((e) => e.message)).toBe("codex app-server exited with code 137");
    expect(await session.ended).toEqual({ error: "codex app-server exited with code 137" });
  });

  test("a request the server resolves itself expires", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("turn/start").length === 1);
    fake.push({ id: 5, method: "item/tool/requestUserInput", params: userInputRequest("turn-1") });
    await until(() => events.some((e) => e.type === "request.opened"));
    const opened = events.find((e) => e.type === "request.opened") as Extract<BridgeEvent, { type: "request.opened" }>;
    fake.push({ method: "serverRequest/resolved", params: { threadId: THREAD_ID, requestId: 5 } });
    await until(() => events.some((e) => e.type === "request.resolved"));
    expect(events.at(-1)).toEqual({ type: "request.resolved", requestId: opened.requestId, answer: null, by: "expired" });
    expect(await session.answer(opened.requestId, "late").catch((e) => e.message)).toBe(`no open request ${opened.requestId}`);
  });

  test("a failing thread/start ends the session and fails waiting runs", async () => {
    const fake = fakeCodex();
    fake.responders["thread/start"] = undefined;
    const { session, events } = open(fake);
    await session.startTurn("run-1", "x", "user");
    await until(() => fake.requests("thread/start").length === 1);
    fake.push({ id: fake.requests("thread/start")[0]!.id, error: { code: -32600, message: "not logged in" } });
    await until(() => events.some((e) => e.type === "run.failed"));
    expect(events).toEqual([{ type: "run.failed", runId: "run-1", error: "thread/start: not logged in" }]);
  });

  test("close kills the process", async () => {
    const fake = fakeCodex();
    const { session } = open(fake);
    await until(() => fake.requests("thread/start").length === 1);
    await session.close();
    expect(fake.killed).toBe(true);
  });
});

describe("spawnCodex", () => {
  test("yields stdout lines across chunk boundaries and the exit code", async () => {
    const proc = spawnCodex(["sh", "-c", "printf 'a\\nb'; sleep 0.05; printf 'c\\n\\nd\\n'; exit 3"], { PATH: process.env.PATH ?? "" });
    const lines: string[] = [];
    for await (const l of proc.lines) lines.push(l);
    expect(lines).toEqual(["a", "bc", "d"]);
    expect(await proc.exited).toBe(3);
  });
});

describe("Codex switching", () => {
  test("setModel on Codex applies to the next turn/start", async () => {
    const fake = fakeCodex();
    const { session, events } = open(fake);
    await session.ready;
    await session.setModel("gpt-5.5-mini");
    // Nothing is sent to the app-server: the model is a turn/start parameter (model/list is the effort catalog).
    expect(fake.sent.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start", "model/list"]);
    await session.startTurn("run-1", "hi", "user");
    await until(() => fake.requests("turn/start").length === 1);
    expect(fake.requests("turn/start")[0]!.params.model).toBe("gpt-5.5-mini");
    expect(events.find((e) => e.type === "run.started")).toMatchObject({ runId: "run-1", model: "gpt-5.5-mini" });
  });

  test("capabilities: item injection from the protocol, live model switch per turn, no background visibility", () => {
    const { session } = open(fakeCodex());
    expect(session.capabilities()).toEqual({ resume: true, injectItems: true, liveModelSwitch: true, questions: true, images: true, backgroundVisibility: false });
  });

  test("injectItems sends thread/inject_items for the open thread", async () => {
    const fake = fakeCodex();
    fake.responders["thread/inject_items"] = () => ({});
    const { session } = open(fake);
    const items = [{ type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] }];
    await session.injectItems(items);
    expect(fake.requests("thread/inject_items")[0]!.params).toEqual({ threadId: THREAD_ID, items });
  });

  test("resume failure: a failed thread/resume rejects ready with ResumeFailedError and starts no turn", async () => {
    const fake = fakeCodex();
    fake.responders["thread/resume"] = () => {
      throw new Error("thread not found");
    };
    const { session, events } = open(fake, { resume: "gone" });
    await expect(session.ready).rejects.toBeInstanceOf(ResumeFailedError);
    await session.ended;
    expect(fake.requests("turn/start")).toEqual([]);
    expect(events.filter((e) => e.type === "thread.native")).toEqual([]);
  });

  test("a failed thread/start is not a resume failure", async () => {
    const fake = fakeCodex();
    fake.responders["thread/start"] = () => {
      throw new Error("not signed in");
    };
    const { session } = open(fake);
    const err = await session.ready.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ResumeFailedError);
  });
});

describe("Codex effort (1.7.0)", () => {
  test("levels and the default come from model/list; the thread's configured effort wins over the model default", async () => {
    const fake = fakeCodex();
    const { session, efforts } = open(fake);
    await session.ready;
    await until(() => efforts.length === 1);
    expect(efforts[0]).toEqual({ type: "effort.state", model: "gpt-5.5-codex", supported: ["low", "medium", "high"], effective: "medium", chosen: null });
    const configured = fakeCodex();
    configured.responders["thread/start"] = () => ({ ...threadStartResponse(), reasoningEffort: "high" });
    const second = open(configured);
    await until(() => second.efforts.length === 1);
    expect(second.efforts[0]).toMatchObject({ effective: "high" });
  });

  test("a choice goes with every turn/start; back to the default sends the default once, then nothing", async () => {
    const fake = fakeCodex();
    const { session, efforts } = open(fake, { effort: "high" });
    await until(() => efforts.length === 1);
    expect(efforts[0]).toMatchObject({ chosen: "high", effective: "high" });
    const turn = async (runId: string, turnId: string) => {
      await session.startTurn(runId, "go", "user");
      await until(() => fake.requests("turn/start").length === Number(turnId.slice(5)));
      fake.push(...simpleTurn(turnId));
    };
    await turn("run-1", "turn-1");
    expect(fake.requests("turn/start")[0]!.params).toMatchObject({ effort: "high" });
    await session.setEffort(null);
    expect(efforts.at(-1)).toMatchObject({ chosen: null, effective: "medium" });
    await turn("run-2", "turn-2");
    expect(fake.requests("turn/start")[1]!.params).toMatchObject({ effort: "medium" });
    await turn("run-3", "turn-3");
    expect("effort" in (fake.requests("turn/start")[2]!.params as object)).toBe(false);
  });

  test("setEffort refuses a level the model lacks; a model switch drops a choice the new model lacks", async () => {
    const fake = fakeCodex();
    const { session, efforts, events } = open(fake);
    await until(() => efforts.length === 1);
    await expect(session.setEffort("xhigh")).rejects.toThrow("not one of low, medium, high");
    await session.setEffort("high");
    await session.setModel("gpt-5.4-mini");
    expect(efforts.at(-1)).toEqual({ type: "effort.state", model: "gpt-5.4-mini", supported: ["low", "medium"], effective: "low", chosen: null });
    expect(events).toContainEqual({ type: "bridge.notice", text: "Effort high is not available on gpt-5.4-mini; back to its default." });
  });

  test("a failing model/list leaves the levels unknown, logged, and turns still run", async () => {
    const fake = fakeCodex();
    fake.responders["model/list"] = undefined;
    const { session, logs, efforts } = open(fake);
    await session.ready;
    await until(() => fake.requests("model/list").length === 1);
    fake.push({ id: fake.requests("model/list")[0]!.id, error: { code: -32601, message: "unknown method" } });
    await until(() => logs.some((l) => l.includes("model/list failed")));
    expect(efforts).toEqual([{ type: "effort.state", model: "gpt-5.5-codex", supported: null, effective: null, chosen: null }]);
    await session.startTurn("run-1", "go", "user");
    await until(() => fake.requests("turn/start").length === 1);
  });

  test("a failing model/list with a choice says that the level goes unchecked, also after a model switch", async () => {
    const fake = fakeCodex();
    fake.responders["model/list"] = undefined;
    const { session, events } = open(fake, { effort: "high" });
    await session.ready;
    await until(() => fake.requests("model/list").length === 1);
    fake.push({ id: fake.requests("model/list")[0]!.id, error: { code: -32601, message: "unknown method" } });
    const unchecked = (m: string): BridgeEvent => ({ type: "bridge.notice", text: `Codex's model list could not be read, so effort high is sent without checking that ${m} takes it.` });
    await until(() => events.some((e) => e.type === "bridge.notice"));
    expect(events).toContainEqual(unchecked("gpt-5.5-codex"));
    await session.setModel("gpt-5.4-mini");
    expect(events).toContainEqual(unchecked("gpt-5.4-mini"));
  });

  test("model/list paging stops after 20 pages: the levels stay unknown, logged", async () => {
    const fake = fakeCodex();
    let pages = 0;
    fake.responders["model/list"] = () => ({ data: [], nextCursor: `page-${++pages}` });
    const { logs, efforts } = open(fake);
    await until(() => logs.some((l) => l.includes("model/list failed")));
    expect(pages).toBe(20);
    expect(logs.find((l) => l.includes("model/list failed"))).toContain("more than 20 pages");
    expect(efforts.at(-1)).toMatchObject({ supported: null });
  });

  test("a resumed thread's first turn says the level: an earlier bridge may have left an override on it", async () => {
    const fake = fakeCodex();
    const { session, efforts } = open(fake, { resume: "thread-old" });
    await until(() => efforts.length === 1);
    await session.startTurn("run-1", "go", "user");
    await until(() => fake.requests("turn/start").length === 1);
    expect(fake.requests("turn/start")[0]!.params).toMatchObject({ effort: "medium" });
    fake.push(...simpleTurn("turn-1", "thread-old"));
    await session.startTurn("run-2", "go", "user");
    await until(() => fake.requests("turn/start").length === 2);
    expect("effort" in (fake.requests("turn/start")[1]!.params as object)).toBe(false);
  });
});
