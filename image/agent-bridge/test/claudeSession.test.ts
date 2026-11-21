import { describe, expect, test } from "bun:test";
import type { CanUseTool, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../src/claude.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { CLAUDE_EFFORT_LEVELS as SHARED_CLAUDE_EFFORT_LEVELS } from "../../../shared/effort";
import { CLAUDE_CAPABILITIES, CLAUDE_EFFORT_LEVELS, openClaudeSession, PLAN_UNAVAILABLE, ResumeFailedError, type ClaudeSessionOptions } from "../src/claudeSession.ts";
import type { BridgeEvent, UsageBaseline } from "../src/events.ts";

// Scripted SDK: the test pushes output messages and reads what the session wrote to the input stream.
function fakeSdk() {
  const inputs: SDKUserMessage[] = [];
  const pending: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const sdk = {
    inputs,
    options: undefined as Record<string, unknown> | undefined,
    interrupts: 0,
    models: [] as (string | undefined)[],
    // The CLI's model list (supportedModels) and the flag settings the session applied (applyFlagSettings).
    modelInfo: [
      { value: "claude-sonnet-4-5", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
      { value: "claude-opus-4-5", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ] as Record<string, unknown>[],
    flagSettings: [] as Record<string, unknown>[],
    // While set, applyFlagSettings waits on it (after recording the setting): what the CLI does meanwhile can race it.
    flagGate: undefined as Promise<void> | undefined,
    onInterrupt: undefined as (() => Promise<void>) | undefined,
    push(...ms: Record<string, unknown>[]) {
      pending.push(...(ms as unknown as SDKMessage[]));
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    canUseTool(): CanUseTool {
      return sdk.options!.canUseTool as CanUseTool;
    },
    queryFn: ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
      sdk.options = params.options;
      void (async () => {
        for await (const m of params.prompt) inputs.push(m);
      })();
      const gen = (async function* () {
        while (true) {
          while (pending.length) yield pending.shift()!;
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          sdk.interrupts++;
          await sdk.onInterrupt?.();
        },
        close: () => sdk.end(),
        setModel: async (m?: string) => {
          sdk.models.push(m);
        },
        supportedModels: async () => sdk.modelInfo,
        applyFlagSettings: async (f: Record<string, unknown>) => {
          sdk.flagSettings.push(f);
          await sdk.flagGate;
        },
      });
    }) as unknown as QueryFn,
  };
  return sdk;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

function open(sdk: ReturnType<typeof fakeSdk>, now = () => 0, extra: Partial<ClaudeSessionOptions> = {}) {
  const events: BridgeEvent[] = [];
  const efforts: BridgeEvent[] = [];
  const logs: string[] = [];
  const session = openClaudeSession(
    {
      cwd: "/workspace",
      model: "claude-sonnet-4-5",
      claudeExecutable: "/usr/local/bin/claude",
      configDir: "/home/dev/.claude",
      resume: null,
      mcpServers: { devbox: { type: "stdio", command: "agent-bridge", args: ["mcp"] } },
      appendSystemPrompt: "call devbox_wait",
      // effort.state is asserted on its own (the effort tests); the other tests read the thread's events.
      emit: (e) => (e.type === "effort.state" ? efforts : events).push(e),
      now,
      logError: (m) => logs.push(m),
      ...extra,
    },
    sdk.queryFn,
  );
  return { session, events, logs, efforts };
}

/** A config dir whose project dir for /workspace holds the transcripts of `sessions`. */
function configDirWith(...sessions: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  mkdirSync(join(dir, "projects", "-workspace"), { recursive: true });
  for (const s of sessions) writeFileSync(join(dir, "projects", "-workspace", `${s}.jsonl`), "{}\n");
  return dir;
}

const init = (sessionId = "sess-1") => ({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-4-5" });
const usage = (input: number, output: number, cacheCreation = 0, cacheRead = 0) => ({
  "claude-sonnet-4-5": { inputTokens: input, outputTokens: output, cacheCreationInputTokens: cacheCreation, cacheReadInputTokens: cacheRead },
});
const result = (modelUsage: unknown, cost: number, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "sess-1",
  total_cost_usd: cost,
  modelUsage,
  ...extra,
});
const assistantText = (id: string, text: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { id, content: [{ type: "text", text }] },
});

describe("openClaudeSession", () => {
  test("passes the session SDK options", async () => {
    const sdk = fakeSdk();
    open(sdk);
    await flush();
    expect(sdk.options).toMatchObject({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      permissionMode: "bypassPermissions",
      model: "claude-sonnet-4-5",
      cwd: "/workspace",
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "call devbox_wait" },
      mcpServers: { devbox: { type: "stdio", command: "agent-bridge", args: ["mcp"] } },
    });
    expect(typeof sdk.options!.canUseTool).toBe("function");
    expect("resume" in sdk.options!).toBe(false);
    expect("settingSources" in sdk.options!).toBe(false);
  });

  test("streams deltas, finals and tool items of one run, then run.completed with per-run usage", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "list files", "user");
    await flush();
    expect(sdk.inputs).toEqual([
      { type: "user", message: { role: "user", content: "list files" }, parent_tool_use_id: null },
    ]);
    sdk.push(
      init(),
      { type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Lis" } } },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg_1", content: [{ type: "text", text: "Listing" }, { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
      },
      {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb\n", is_error: false }] },
      },
      result(usage(100, 50, 10, 20), 0.01),
    );
    await flush();
    expect(events).toEqual([
      { type: "run.started", runId: "run-1", origin: "user", nativeThreadId: null, model: "claude-sonnet-4-5" },
      { type: "thread.native", harness: "claude", nativeThreadId: "sess-1", account: null, model: "claude-sonnet-4-5", caps: CLAUDE_CAPABILITIES },
      { type: "message.delta", runId: "run-1", itemId: "msg_1", text: "Lis" },
      { type: "message.final", runId: "run-1", itemId: "msg_1", role: "assistant", text: "Listing" },
      { type: "tool.started", runId: "run-1", itemId: "toolu_1", tool: "Bash", input: { command: "ls" } },
      { type: "tool.finished", runId: "run-1", itemId: "toolu_1", isError: false, output: "a\nb\n" },
      {
        type: "run.completed",
        runId: "run-1",
        nativeThreadId: "sess-1",
        usage: { input: 100, output: 50, cacheCreation: 10, cacheRead: 20 },
        costUsd: 0.01,
      },
    ]);
  });

  test("second turn reports only its own usage, not the cumulative modelUsage", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "one", "user");
    sdk.push(init(), assistantText("m1", "a"), result(usage(100, 50, 10, 20), 0.01));
    await flush();
    await session.startTurn("run-2", "two", "user");
    sdk.push(init(), assistantText("m2", "b"), result(usage(130, 70, 10, 50), 0.015));
    await flush();
    const done = events.filter((e) => e.type === "run.completed");
    expect(done.map((e) => e.type === "run.completed" && e.runId)).toEqual(["run-1", "run-2"]);
    expect(done[1]).toMatchObject({ usage: { input: 30, output: 20, cacheCreation: 0, cacheRead: 30 } });
    expect((done[1] as { costUsd: number }).costUsd).toBeCloseTo(0.005, 10);
  });

  test("a resumed session subtracts the persisted baseline and reports each new baseline", async () => {
    const sdk = fakeSdk();
    const baselines: UsageBaseline[] = [];
    const baseline: UsageBaseline = { usage: { input: 100, output: 50, cacheCreation: 10, cacheRead: 20 }, costUsd: 0.01 };
    const { session, events } = open(sdk, () => 0, { resume: "sess-1", configDir: configDirWith("sess-1"), usageBaseline: baseline, onUsageBaseline: (b) => baselines.push(b) });
    await session.startTurn("run-1", "again", "user");
    sdk.push(init(), assistantText("m1", "a"), result(usage(130, 70, 10, 50), 0.015));
    await flush();
    const done = events.find((e) => e.type === "run.completed") as Extract<BridgeEvent, { type: "run.completed" }>;
    expect(done.usage).toEqual({ input: 30, output: 20, cacheCreation: 0, cacheRead: 30 });
    expect(done.costUsd).toBeCloseTo(0.005, 10);
    expect(baselines).toEqual([{ usage: { input: 130, output: 70, cacheCreation: 10, cacheRead: 50 }, costUsd: 0.015 }]);
  });

  test("AskUserQuestion becomes request.opened and the answer is passed back as updatedInput.answers", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "ask me", "user");
    sdk.push(init());
    await flush();
    const input = {
      questions: [
        {
          question: "Which library?",
          header: "Library",
          options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "zones" }],
          multiSelect: false,
        },
      ],
    };
    const decision = sdk.canUseTool()("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "toolu_q", requestId: "req-toolu_q" });
    await flush();
    const opened = events.find((e) => e.type === "request.opened");
    expect(opened).toEqual({
      type: "request.opened",
      runId: "run-1",
      requestId: "toolu_q:0",
      kind: "question",
      prompt: "Which library?",
      options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "zones" }],
      multiSelect: false,
    });
    await session.answer("toolu_q:0", "luxon");
    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which library?": "luxon" } },
    } satisfies PermissionResult);
    expect(events.at(-1)).toEqual({ type: "request.resolved", requestId: "toolu_q:0", answer: "luxon", by: "user" });
    await expect(session.answer("toolu_q:0", "again")).rejects.toThrow("no open request toolu_q:0");
  });

  test("ExitPlanMode rejected by the user denies with the user's text", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "plan it", "user");
    sdk.push(init());
    await flush();
    const decision = sdk.canUseTool()("ExitPlanMode", { plan: "1. do X" }, { signal: new AbortController().signal, toolUseID: "toolu_p", requestId: "req-toolu_p" });
    await flush();
    expect(events.find((e) => e.type === "request.opened")).toEqual({
      type: "request.opened",
      runId: "run-1",
      requestId: "toolu_p",
      kind: "plan",
      prompt: "1. do X",
      options: [{ label: "Approve" }],
    });
    await session.answer("toolu_p", "No, use Y instead");
    expect(await decision).toEqual({ behavior: "deny", message: "No, use Y instead" });
  });

  test("ExitPlanMode approved by the user is allowed", async () => {
    const sdk = fakeSdk();
    const { session } = open(sdk);
    await session.startTurn("run-1", "plan it", "user");
    sdk.push(init());
    await flush();
    const decision = sdk.canUseTool()("ExitPlanMode", { plan: "1. do X" }, { signal: new AbortController().signal, toolUseID: "toolu_p", requestId: "req-toolu_p" });
    await flush();
    await session.answer("toolu_p", "Approve");
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { plan: "1. do X" } });
  });

  test("other tools are allowed immediately with their input", async () => {
    const sdk = fakeSdk();
    open(sdk);
    await flush();
    expect(await sdk.canUseTool()("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "req-t" })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
  });

  test("an aborted question expires", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "ask me", "user");
    sdk.push(init());
    await flush();
    const abort = new AbortController();
    const decision = sdk.canUseTool()(
      "AskUserQuestion",
      { questions: [{ question: "Q?", header: "Q", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] },
      { signal: abort.signal, toolUseID: "toolu_q", requestId: "req-toolu_q" },
    );
    await flush();
    abort.abort();
    expect(await decision).toMatchObject({ behavior: "deny" });
    expect(events.at(-1)).toEqual({ type: "request.resolved", requestId: "toolu_q:0", answer: null, by: "expired" });
  });

  test("a result without a user message is an agent-origin run", async () => {
    const sdk = fakeSdk();
    const { events } = open(sdk);
    sdk.push(init(), assistantText("m1", "woke up"), result(usage(5, 5), 0.001));
    await flush();
    const started = events.find((e) => e.type === "run.started");
    expect(started).toMatchObject({ origin: "agent", nativeThreadId: "sess-1", model: "claude-sonnet-4-5" });
    const runId = (started as { runId: string }).runId;
    expect(runId).toBeTruthy();
    expect(events.filter((e) => e.type !== "thread.native").map((e) => e.type)).toEqual(["run.started", "message.final", "run.completed"]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId });
    expect(sdk.inputs).toEqual([]);
  });

  test("message during an active run starts the next run", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "first", "user");
    sdk.push(init(), assistantText("m1", "working"));
    await flush();
    await session.startTurn("run-2", "second", "user");
    await session.startTurn("run-3", "third", "continuation");
    await flush();
    expect(sdk.inputs.map((m) => m.message.content)).toEqual(["first"]);
    expect(events.filter((e) => e.type === "run.started").map((e) => (e as { runId: string }).runId)).toEqual(["run-1"]);

    sdk.push(result(usage(1, 1), 0.001));
    await flush();
    expect(sdk.inputs.map((m) => m.message.content)).toEqual(["first", "second"]);
    sdk.push(init(), result(usage(2, 2), 0.002));
    await flush();
    expect(sdk.inputs.map((m) => m.message.content)).toEqual(["first", "second", "third"]);
    expect(
      events.filter((e) => e.type === "run.started" || e.type === "run.completed").map((e) => `${e.type}:${(e as { runId: string }).runId}`),
    ).toEqual(["run.started:run-1", "run.completed:run-1", "run.started:run-2", "run.completed:run-2", "run.started:run-3"]);
    expect(events.find((e) => e.type === "run.started" && e.runId === "run-3")).toMatchObject({ origin: "continuation" });
  });

  test("images go to the CLI as base64 image blocks read from their files, before the text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-images-"));
    writeFileSync(join(dir, "a.png"), new Uint8Array([1, 2, 3]));
    writeFileSync(join(dir, "b.jpg"), new Uint8Array([4, 5]));
    const sdk = fakeSdk();
    const { session } = open(sdk);
    await session.startTurn("run-1", "what is this?", "user", [join(dir, "a.png"), join(dir, "b.jpg")]);
    await flush();
    expect(sdk.inputs[0]!.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BAU=" } },
      { type: "text", text: "what is this?" },
    ]);
  });

  test("an image that cannot be read refuses the turn; nothing is written", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await expect(session.startTurn("run-1", "see", "user", ["/nonexistent/gone.png"])).rejects.toThrow();
    await flush();
    expect(sdk.inputs).toEqual([]);
    expect(events).toEqual([]);
  });

  test("interrupt calls query.interrupt and emits run.interrupted", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "long task", "user");
    sdk.push(init());
    await flush();
    await session.interrupt();
    expect(sdk.interrupts).toBe(1);
    expect(events.at(-1)).toEqual({ type: "run.interrupted", runId: "run-1" });
    // the interrupted run's own result closes it without a second terminal event
    sdk.push(result(usage(3, 3), 0.003, { subtype: "error_during_execution", is_error: true, errors: [] }));
    await flush();
    expect(events.filter((e) => e.type === "run.failed" || e.type === "run.completed")).toEqual([]);
    await expect(session.interrupt()).rejects.toThrow("no active run");
  });

  test("an error result fails the run", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "x", "user");
    sdk.push(init(), result(usage(1, 1), 0.001, { subtype: "error_max_turns", is_error: true, errors: ["too many turns"] }));
    await flush();
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "too many turns" });
  });

  test("an error reported as a success result fails the run with its result text", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "x", "user");
    sdk.push(init(), result(usage(1, 1), 0, { is_error: true, result: "You've hit your weekly limit" }));
    await flush();
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "You've hit your weekly limit" });
  });

  test("the SDK stream ending fails the active and queued runs and refuses new turns", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "x", "user");
    await session.startTurn("run-2", "y", "user");
    sdk.push(init());
    sdk.end();
    await flush();
    expect(events.filter((e) => e.type === "run.failed")).toEqual([
      { type: "run.failed", runId: "run-1", error: "Claude session ended" },
      { type: "run.failed", runId: "run-2", error: "Claude session ended" },
    ]);
    await expect(session.startTurn("run-3", "z", "user")).rejects.toThrow("Claude session ended");
    expect(await session.ended).toEqual({});
  });

  test("ended carries the error when the SDK stream throws", async () => {
    const queryFn = (() =>
      Object.assign(
        (async function* () {
          throw new Error("claude exited with code 1");
        })(),
        { interrupt: async () => {}, close: () => {} },
      )) as unknown as QueryFn;
    const session = openClaudeSession(
      { cwd: "/w", model: null, claudeExecutable: "/c", configDir: "/d", resume: null, mcpServers: {}, appendSystemPrompt: "", emit: () => {}, logError: () => {} },
      queryFn,
    );
    expect(await session.ended).toEqual({ error: "claude exited with code 1" });
  });

  test("ExitPlanMode without plan text reads the plan file", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    const dir = await mkdtemp(join(tmpdir(), "plan-"));
    const file = join(dir, "plan.md");
    await writeFile(file, "# Plan\n1. from file");
    await session.startTurn("run-1", "plan it", "user");
    sdk.push(init());
    await flush();
    void sdk.canUseTool()("ExitPlanMode", { planFilePath: file }, { signal: new AbortController().signal, toolUseID: "toolu_p", requestId: "r" });
    await until(() => events.some((e) => e.type === "request.opened"));
    expect(events.find((e) => e.type === "request.opened")).toMatchObject({ kind: "plan", prompt: "# Plan\n1. from file" });
  });

  test("ExitPlanMode with neither plan text nor file says so explicitly and logs it", async () => {
    const sdk = fakeSdk();
    const { session, events, logs } = open(sdk);
    await session.startTurn("run-1", "plan it", "user");
    sdk.push(init());
    await flush();
    void sdk.canUseTool()("ExitPlanMode", {}, { signal: new AbortController().signal, toolUseID: "toolu_p", requestId: "r" });
    await until(() => events.some((e) => e.type === "request.opened"));
    expect(events.find((e) => e.type === "request.opened")).toMatchObject({ kind: "plan", prompt: PLAN_UNAVAILABLE });
    expect(logs).toHaveLength(1);
  });

  test("AskUserQuestion with missing or malformed questions is denied, not auto-answered", async () => {
    const sdk = fakeSdk();
    const { session, events, logs } = open(sdk);
    await session.startTurn("run-1", "ask", "user");
    sdk.push(init());
    await flush();
    for (const input of [{}, { questions: [] }, { questions: [{ header: "x", options: [] }] }]) {
      expect(await sdk.canUseTool()("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "toolu_q", requestId: "r" })).toEqual({
        behavior: "deny",
        message: "AskUserQuestion input had no questions",
      });
    }
    expect(events.some((e) => e.type === "request.opened")).toBe(false);
    expect(logs).toHaveLength(3);
  });

  test("close expires open requests and settles their tool calls", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "ask", "user");
    sdk.push(init());
    await flush();
    const decision = sdk.canUseTool()(
      "AskUserQuestion",
      { questions: [{ question: "Q?", header: "Q", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false }] },
      { signal: new AbortController().signal, toolUseID: "toolu_q", requestId: "r" },
    );
    await flush();
    await session.close();
    expect(await decision).toMatchObject({ behavior: "deny" });
    expect(events).toContainEqual({ type: "request.resolved", requestId: "toolu_q:0", answer: null, by: "expired" });
    await expect(session.answer("toolu_q:0", "a")).rejects.toThrow("no open request");
  });

  test("run.interrupted precedes the next run when the result beats interrupt()", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.startTurn("run-1", "long", "user");
    sdk.push(init());
    await flush();
    await session.startTurn("run-2", "next", "user");
    sdk.onInterrupt = async () => {
      sdk.push(result(usage(1, 1), 0.001, { subtype: "error_during_execution", is_error: true, errors: [] }));
      await flush();
    };
    await session.interrupt();
    expect(
      events.filter((e) => e.type === "run.interrupted" || e.type === "run.started").map((e) => `${e.type}:${(e as { runId: string }).runId}`),
    ).toEqual(["run.started:run-1", "run.interrupted:run-1", "run.started:run-2"]);
  });

  test("background work is emitted and a wakeup clears when the agent wakes at its time", async () => {
    const sdk = fakeSdk();
    let clock = 1_000;
    const { session, events } = open(sdk, () => clock);
    await session.startTurn("run-1", "loop", "user");
    sdk.push(
      init(),
      { type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "toolu_w", name: "ScheduleWakeup", input: { delaySeconds: 600, reason: "poll" } }] } },
      {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "scheduled" }] },
        tool_use_result: { scheduledFor: 601_000 },
      },
      result(usage(1, 1), 0.001),
    );
    await flush();
    expect(events.filter((e) => e.type === "background.changed")).toEqual([
      { type: "background.changed", work: [{ id: "wakeup", kind: "wakeup", label: "poll", holding: true, until: 601_000 }] },
    ]);
    clock = 601_500;
    sdk.push(init(), result(usage(2, 2), 0.002));
    await flush();
    expect(events.filter((e) => e.type === "background.changed").at(-1)).toEqual({ type: "background.changed", work: [] });
    expect(events.filter((e) => e.type === "run.started").at(-1)).toMatchObject({ origin: "agent" });
  });
});

describe("Claude switching", () => {
  test("setModel on Claude calls query.setModel", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk);
    await session.setModel("claude-opus-4-5");
    expect(sdk.models).toEqual(["claude-opus-4-5"]);
    await session.startTurn("run-1", "hi", "user");
    expect(events.find((e) => e.type === "run.started")).toMatchObject({ runId: "run-1", model: "claude-opus-4-5" });
  });

  test("capabilities are all true except injectItems", () => {
    const { session } = open(fakeSdk());
    expect(session.capabilities()).toEqual({ resume: true, injectItems: false, liveModelSwitch: true, questions: true, images: true, backgroundVisibility: true });
  });

  test("a resume announces the resumed thread with its capabilities once it is ready", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk, () => 0, { resume: "sess-1", configDir: configDirWith("sess-1") });
    await session.ready;
    expect(events).toEqual([{ type: "thread.native", harness: "claude", nativeThreadId: "sess-1", account: null, model: "claude-sonnet-4-5", caps: CLAUDE_CAPABILITIES }]);
    await session.startTurn("run-1", "again", "user");
    sdk.push(init("sess-1"));
    await flush();
    // The CLI's init for the same session is not a second announcement.
    expect(events.filter((e) => e.type === "thread.native").length).toBe(1);
  });

  test("resume failure: a missing transcript rejects ready with ResumeFailedError and never starts the CLI", async () => {
    const sdk = fakeSdk();
    const { session, events } = open(sdk, () => 0, { resume: "gone", configDir: configDirWith() });
    await expect(session.ready).rejects.toBeInstanceOf(ResumeFailedError);
    expect(await session.ended).toEqual({ error: expect.stringContaining("gone") });
    expect(sdk.options).toBeUndefined();
    await expect(session.startTurn("run-1", "hi", "user")).rejects.toThrow();
    expect(events).toEqual([]);
  });

  test("the CLI starts from the given base env, not the bridge's", () => {
    const sdk = fakeSdk();
    open(sdk, () => 0, { baseEnv: { SWITCHED_ONLY: "1", PATH: "/bin" } });
    const env = sdk.options!.env as Record<string, string>;
    expect(env).toMatchObject({ SWITCHED_ONLY: "1", PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/dev/.claude" });
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CONFIG_DIR", "PATH", "SWITCHED_ONLY"]);
  });

  test("injectItems is refused: Claude has no item injection", async () => {
    const { session } = open(fakeSdk());
    await expect(session.injectItems([{}])).rejects.toThrow("injectItems");
  });
});

describe("Claude effort (1.7.0)", () => {
  const levelsKnown = (efforts: BridgeEvent[]) => until(() => efforts.some((e) => e.type === "effort.state" && e.supported !== null));
  const stopHook = (sdk: ReturnType<typeof fakeSdk>) => (sdk.options!.hooks as { Stop: { hooks: ((i: unknown, id: undefined, o: { signal: AbortSignal }) => Promise<unknown>)[] }[] }).Stop[0]!.hooks[0]!;

  test("levels come from the CLI's model list; the effective level only from a turn's Stop hook", async () => {
    const sdk = fakeSdk();
    const { efforts } = open(sdk);
    await levelsKnown(efforts);
    expect(efforts).toEqual([
      // At open: an explicit model's levels come from the CLI's list (as before 1.8.0): nothing unchecked on offer.
      { type: "effort.state", model: "claude-sonnet-4-5", supported: null, effective: null, chosen: null },
      { type: "effort.state", model: "claude-sonnet-4-5", supported: ["low", "medium", "high"], effective: null, chosen: null },
    ]);
    expect(await stopHook(sdk)({ hook_event_name: "Stop", effort: { level: "medium" } }, undefined, { signal: new AbortController().signal })).toEqual({ continue: true });
    expect(efforts.at(-1)).toMatchObject({ effective: "medium", chosen: null });
  });

  test("a model the CLI does not list leaves the levels unknown, logged", async () => {
    const sdk = fakeSdk();
    sdk.modelInfo = [];
    const { efforts, logs } = open(sdk);
    await until(() => logs.some((l) => l.includes("not in the CLI's model list")));
    expect(efforts.every((e) => e.type === "effort.state" && e.supported === null)).toBe(true);
  });

  test("a choice starts the CLI with it; setEffort applies it as a flag setting from the next message, and null resets", async () => {
    const sdk = fakeSdk();
    const { session, efforts } = open(sdk, () => 0, { effort: "high" });
    expect(sdk.options!.effort).toBe("high");
    await levelsKnown(efforts);
    await session.setEffort("low");
    expect(sdk.flagSettings).toEqual([{ effortLevel: "low" }]);
    expect(efforts.at(-1)).toMatchObject({ chosen: "low", effective: null });
    await session.setEffort(null);
    expect(sdk.flagSettings.at(-1)).toEqual({ effortLevel: null });
    expect(efforts.at(-1)).toMatchObject({ chosen: null });
  });

  test("setEffort refuses a level the model lacks and sends nothing", async () => {
    const sdk = fakeSdk();
    const { session, efforts } = open(sdk);
    await levelsKnown(efforts);
    await expect(session.setEffort("max")).rejects.toThrow("effort max is not one of low, medium, high");
    expect(sdk.flagSettings).toEqual([]);
  });

  test("switching to a model without the chosen level drops it with a notice and resets the CLI's level", async () => {
    const sdk = fakeSdk();
    const { session, events, efforts } = open(sdk, () => 0, { model: "claude-opus-4-5", effort: "max" });
    await levelsKnown(efforts);
    expect(efforts.at(-1)).toMatchObject({ chosen: "max", supported: ["low", "medium", "high", "xhigh", "max"] });
    await session.setModel("claude-sonnet-4-5");
    await until(() => sdk.flagSettings.length === 1);
    expect(sdk.flagSettings).toEqual([{ effortLevel: null }]);
    expect(efforts.at(-1)).toMatchObject({ model: "claude-sonnet-4-5", chosen: null });
    expect(events).toContainEqual({ type: "bridge.notice", text: "Effort max is not available on claude-sonnet-4-5; back to its default." });
  });

  test("a run going when the effort changed reports its old level: the chip keeps the choice until a later run reports", async () => {
    const sdk = fakeSdk();
    const { session, efforts } = open(sdk, () => 0, { model: "claude-opus-4-5" });
    await levelsKnown(efforts);
    const signal = new AbortController().signal;
    await session.startTurn("run-1", "go", "user");
    await session.setEffort("max");
    await stopHook(sdk)({ hook_event_name: "Stop", effort: { level: "high" } }, undefined, { signal });
    expect(efforts.at(-1)).toMatchObject({ chosen: "max", effective: null });
    sdk.push(result(usage(1, 1), 0.01));
    await session.startTurn("run-2", "again", "user");
    await until(() => sdk.inputs.length === 2);
    await stopHook(sdk)({ hook_event_name: "Stop", effort: { level: "max" } }, undefined, { signal });
    expect(efforts.at(-1)).toMatchObject({ chosen: "max", effective: "max" });
  });

  test("a switch to a model the CLI does not list forgets the previous model's levels and level", async () => {
    const sdk = fakeSdk();
    const { session, efforts, logs } = open(sdk, () => 0, { model: "claude-opus-4-5" });
    await levelsKnown(efforts);
    await stopHook(sdk)({ hook_event_name: "Stop", effort: { level: "high" } }, undefined, { signal: new AbortController().signal });
    await session.setModel("claude-haiku-9");
    await until(() => logs.some((l) => l.includes("claude-haiku-9 is not in the CLI's model list")));
    // Its levels stay unknown, and a switched-to model is explicit: nothing unchecked on offer.
    expect(efforts.at(-1)).toEqual({ type: "effort.state", model: "claude-haiku-9", supported: null, effective: null, chosen: null });
  });

  test("launched on the CLI's default model, the levels follow the model its init names", async () => {
    const sdk = fakeSdk();
    const { session, efforts } = open(sdk, () => 0, { model: null });
    await session.startTurn("run-1", "hi", "user");
    sdk.push(init());
    await levelsKnown(efforts);
    expect(efforts.at(-1)).toMatchObject({ model: "claude-sonnet-4-5", supported: ["low", "medium", "high"] });
  });

  test("a switch away from the CLI's default model makes it explicit: no unchecked levels on offer after it", async () => {
    const sdk = fakeSdk();
    const { session, efforts, logs } = open(sdk, () => 0, { model: null });
    expect(efforts.at(-1)).toMatchObject({ unchecked: ["low", "medium", "high", "xhigh", "max"] });
    await session.setModel("claude-haiku-9");
    await until(() => logs.some((l) => l.includes("claude-haiku-9 is not in the CLI's model list")));
    expect(efforts.at(-1)).toEqual({ type: "effort.state", model: "claude-haiku-9", supported: null, effective: null, chosen: null });
    await expect(session.setEffort("high")).rejects.toThrow("the agent has not reported its effort levels yet");
  });

  test("on an explicit model, a level is refused until the CLI's list names its levels", async () => {
    const sdk = fakeSdk();
    const { session } = open(sdk, () => 0, { model: "claude-opus-4-5" });
    await expect(session.setEffort("high")).rejects.toThrow("the agent has not reported its effort levels yet");
    expect(sdk.flagSettings).toEqual([]);
  });

  test("on the CLI's default model, a level is taken before the first reply and checked once init names the model", async () => {
    const sdk = fakeSdk();
    const { session, events, efforts } = open(sdk, () => 0, { model: null });
    expect(efforts).toEqual([{ type: "effort.state", model: null, supported: null, effective: null, chosen: null, unchecked: ["low", "medium", "high", "xhigh", "max"] }]);
    await expect(session.setEffort("minimal")).rejects.toThrow("effort minimal is not one of low, medium, high, xhigh, max");
    await session.setEffort("xhigh");
    expect(sdk.flagSettings).toEqual([{ effortLevel: "xhigh" }]);
    expect(efforts.at(-1)).toMatchObject({ chosen: "xhigh", supported: null });
    await session.startTurn("run-1", "hi", "user");
    // claude-sonnet-4-5 takes low, medium, high: the choice goes. The CLI ran the message at its nearest level
    // (it downgrades silently), which the notice says rather than hides.
    sdk.push(init());
    await levelsKnown(efforts);
    expect(events).toContainEqual({ type: "bridge.notice", text: "Effort xhigh is not available on claude-sonnet-4-5: the message sent with it ran at the model's nearest level. Back to its default from now on." });
    await until(() => sdk.flagSettings.length === 2);
    expect(sdk.flagSettings.at(-1)).toEqual({ effortLevel: null });
    expect(efforts.at(-1)).toMatchObject({ model: "claude-sonnet-4-5", chosen: null });
    // That run's Stop reports the downgraded level: not the default's level from now on.
    await stopHook(sdk)({ hook_event_name: "Stop", effort: { level: "high" } }, undefined, { signal: new AbortController().signal });
    expect(efforts.at(-1)).toMatchObject({ chosen: null, effective: null });
  });

  test("a level taken unchecked while init names a model without it is dropped, not kept unseen", async () => {
    const sdk = fakeSdk();
    let release!: () => void;
    const { session, events, efforts } = open(sdk, () => 0, { model: null });
    await session.startTurn("run-1", "hi", "user");
    sdk.flagGate = new Promise((r) => { release = r; });
    const picking = session.setEffort("max");
    // The CLI names its model while the flag is being applied: the levels arrive between check and commit.
    sdk.push(init());
    await levelsKnown(efforts);
    sdk.flagGate = undefined;
    release();
    await picking;
    expect(efforts.at(-1)).toMatchObject({ supported: ["low", "medium", "high"], chosen: null });
    // It applied from the next message only: no message ran with it.
    expect(events).toContainEqual({ type: "bridge.notice", text: "Effort max is not available on claude-sonnet-4-5; back to its default." });
    expect(sdk.flagSettings.at(-1)).toEqual({ effortLevel: null });
  });

  test("an unchecked level is kept when the CLI's model list cannot be read, and the thread says so", async () => {
    const sdk = fakeSdk();
    Object.defineProperty(sdk, "modelInfo", { get: () => { throw new Error("control request failed"); } });
    const { session, events, logs, efforts } = open(sdk, () => 0, { model: null });
    await session.setEffort("max");
    await session.startTurn("run-1", "hi", "user");
    sdk.push(init());
    await until(() => logs.some((l) => l.includes("reading the model list for effort levels failed")));
    expect(events).toContainEqual({ type: "bridge.notice", text: "Effort max could not be checked: Claude's model list could not be read, so it is sent as is." });
    // The model is named with its levels still unknown: the apps stop promising a check.
    expect(efforts.at(-1)).toMatchObject({ model: "claude-sonnet-4-5", supported: null, chosen: "max" });
  });

  test("an unchecked level the model's list cannot check is kept, and the thread says so", async () => {
    const sdk = fakeSdk();
    sdk.modelInfo = [];
    const { session, events, logs } = open(sdk, () => 0, { model: null });
    await session.setEffort("high");
    await session.startTurn("run-1", "hi", "user");
    sdk.push(init());
    await until(() => logs.some((l) => l.includes("not in the CLI's model list")));
    expect(events).toContainEqual({ type: "bridge.notice", text: "Effort high could not be checked: claude-sonnet-4-5 is not in Claude's model list, so it is sent as is." });
  });
});

test("the bridge's unchecked Claude levels are shared/effort.ts's, all of them known levels", () => {
  expect([...CLAUDE_EFFORT_LEVELS] as string[]).toEqual([...SHARED_CLAUDE_EFFORT_LEVELS]);
});
