import { describe, expect, test } from "bun:test";
import type { CanUseTool, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../src/claude.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openClaudeSession, PLAN_UNAVAILABLE } from "../src/claudeSession.ts";
import type { BridgeEvent } from "../src/events.ts";

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

function open(sdk: ReturnType<typeof fakeSdk>, now = () => 0) {
  const events: BridgeEvent[] = [];
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
      emit: (e) => events.push(e),
      now,
      logError: (m) => logs.push(m),
    },
    sdk.queryFn,
  );
  return { session, events, logs };
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
      { type: "thread.native", harness: "claude", nativeThreadId: "sess-1", account: null, model: "claude-sonnet-4-5" },
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
