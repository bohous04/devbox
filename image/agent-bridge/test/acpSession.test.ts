import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACP_AGENTS, type AcpAgentSpec } from "../src/acpAgents.ts";
import { negotiate, openAcpSession, type SpawnFn } from "../src/acpSession.ts";
import { ResumeFailedError } from "../src/claudeSession.ts";
import type { BridgeEvent } from "../src/events.ts";
import { acpMcpServers } from "../src/prompts.ts";

// Fixtures are synthetic (first line says so); Task 3 replaces them with live recordings.
function fixture(name: string): any[] {
  const [marker, ...lines] = readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(marker.synthetic).toBeString();
  return lines;
}
const INIT = Object.fromEntries(fixture("acp-initialize.jsonl").map((l) => [l.name, l.result])) as Record<string, any>;

// Live recordings of the real agents (step 4 Task 3); the first line says what was recorded, how and what was scrubbed.
function recording(name: string): any[] {
  const [marker, ...lines] = readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(marker.recorded).toStartWith("Live,");
  return lines;
}

interface Sent {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

type Responder = (params: any, id: number | string) => unknown;

// Scripted ACP agent: answers client requests from `responders` (a responder returning undefined leaves the request
// open), lets the test push agent messages, records everything the session wrote, and can exit and be spawned again.
function fakeAgent(init: unknown = INIT.v1) {
  const sent: Sent[] = [];
  let current: { push(line: string): void; exit(code: number): void } | null = null;
  const fake = {
    sent,
    spawns: [] as { argv: string[]; env: Record<string, string>; cwd: string }[],
    killed: 0,
    responders: {
      initialize: () => init,
      "session/new": () => ({ sessionId: "sess-1" }),
      "session/load": () => ({}),
      "session/resume": () => ({}),
      "session/set_model": () => ({}),
      "session/set_mode": () => ({}),
      "session/set_config_option": () => ({ configOptions: [] }),
      "session/prompt": () => ({ stopReason: "end_turn" }),
    } as Record<string, Responder | undefined>,
    push(...msgs: unknown[]) {
      for (const m of msgs) current!.push(JSON.stringify(m));
    },
    respond(id: number | string, result: unknown) {
      fake.push({ jsonrpc: "2.0", id, result });
    },
    exit(code: number) {
      current!.exit(code);
    },
    requests(method: string) {
      return sent.filter((m) => m.method === method && m.id !== undefined);
    },
    notifications(method: string) {
      return sent.filter((m) => m.method === method && m.id === undefined);
    },
    responseTo(id: number | string) {
      return sent.find((m) => m.id === id && m.method === undefined);
    },
    spawn: ((argv, env, cwd) => {
      fake.spawns.push({ argv, env, cwd });
      const pending: string[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      let exit: (code: number) => void = () => {};
      const proc = {
        push(line: string) {
          pending.push(line);
          wake?.();
        },
        exit(code: number) {
          if (ended) return;
          ended = true;
          wake?.();
          exit(code);
        },
      };
      current = proc;
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
            if (ended) throw new Error("stdin closed");
            for (const line of s.split("\n").filter(Boolean)) {
              const msg = JSON.parse(line) as Sent;
              sent.push(msg);
              const respond = msg.method !== undefined && msg.id !== undefined ? fake.responders[msg.method] : undefined;
              if (!respond) continue;
              try {
                const result = respond(msg.params, msg.id!);
                if (result !== undefined) proc.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
              } catch (e) {
                const err = e as Error & { code?: number };
                proc.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } }));
              }
            }
          },
        },
        lines,
        exited: new Promise<number>((r) => (exit = r)),
        kill() {
          fake.killed++;
          proc.exit(143);
        },
      };
    }) as SpawnFn,
  };
  return fake;
}

// Plays a turn fixture when the prompt arrives: `send` lines are pushed, `promptResult` answers the prompt there.
function playTurn(fake: ReturnType<typeof fakeAgent>, name: string) {
  const lines = fixture(name);
  fake.responders["session/prompt"] = (_p, id) => {
    queueMicrotask(() => {
      for (const l of lines) {
        if (l.send) fake.push(l.send);
        else fake.respond(id, l.promptResult);
      }
    });
    return undefined;
  };
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

const SPEC: AcpAgentSpec = { id: "example", argv: ["example-agent", "acp"] };
const MCP = [{ name: "devbox", command: "agent-bridge", args: ["mcp"], env: { DEVD_URL: "http://devd.test" } }];

function open(fake: ReturnType<typeof fakeAgent>, o: { spec?: AcpAgentSpec; resume?: string | null; model?: string | null; instructions?: string } = {}) {
  const events: BridgeEvent[] = [];
  const logs: string[] = [];
  const session = openAcpSession(
    {
      spec: o.spec ?? SPEC,
      cwd: "/workspace",
      model: o.model ?? null,
      resume: o.resume ?? null,
      mcpServers: MCP,
      ...(o.instructions === undefined ? {} : { instructions: o.instructions }),
      emit: (e) => events.push(e),
      logError: (m) => logs.push(m),
    },
    fake.spawn,
  );
  return { session, events, logs };
}

const types = (events: BridgeEvent[]) => events.map((e) => e.type);

describe("negotiate", () => {
  test("v1 shape is version 1 with the capabilities it reports", () => {
    expect(negotiate(INIT.v1)).toEqual({
      version: 1,
      caps: { resume: true, injectItems: false, liveModelSwitch: false, questions: false, images: false, backgroundVisibility: false },
    });
  });

  test("v2 shape is version 2", () => {
    const r = negotiate(INIT.v2);
    expect(r.version).toBe(2);
    expect(r.caps).toMatchObject({ resume: true, images: true });
  });

  test("v2 reported with v1 shape is version 1", () => {
    expect(INIT["v2-reported-v1-shape"].protocolVersion).toBe(2);
    const r = negotiate(INIT["v2-reported-v1-shape"]);
    expect(r.version).toBe(1);
    expect(r.caps).toMatchObject({ resume: true, images: true });
  });

  test("an agent without load or resume cannot resume", () => {
    expect(negotiate(INIT["v1-no-load"]).caps.resume).toBe(false);
  });

  test("v2 session capabilities without resume or load cannot resume", () => {
    expect(negotiate(INIT["v2-no-resume"])).toMatchObject({ version: 2, caps: { resume: false } });
  });

  test("a result that is no ACP initialize response is refused", () => {
    expect(() => negotiate(null)).toThrow(/initialize/);
    expect(() => negotiate({ agentCapabilities: {} })).toThrow(/protocolVersion/);
  });
});

describe("ACP_AGENTS", () => {
  test("capability table per agent", () => {
    expect(Object.keys(ACP_AGENTS).sort()).toEqual(["antigravity", "grok", "opencode", "vibe"]);
    expect(ACP_AGENTS.grok!.argv).toEqual(["grok", "agent", "--always-approve", "stdio"]);
    expect(ACP_AGENTS.opencode!.argv).toEqual(["opencode", "acp"]);
    expect(ACP_AGENTS.vibe!.rateLimitCodes).toEqual([-31001]);
    expect(ACP_AGENTS.antigravity!.clientName).toBe("zed");
    expect(ACP_AGENTS.antigravity!.modes).toEqual({ allowed: ["default"] });
    for (const [id, spec] of Object.entries(ACP_AGENTS)) expect(spec.id).toBe(id);
  });

  test("capabilities come from the agent's initialize result, then the spec's overrides", async () => {
    const plain = open(fakeAgent(INIT.v1));
    await plain.session.ready;
    // images:false makes the bridge send attachments as /inbox paths (step 5).
    expect(plain.session.capabilities()).toMatchObject({ images: false, resume: true });

    const overridden = open(fakeAgent(INIT.v1), { spec: { ...SPEC, overrides: { resume: false, images: true } } });
    await overridden.session.ready;
    expect(overridden.session.capabilities()).toMatchObject({ images: true, resume: false });
    expect(overridden.events.find((e) => e.type === "thread.native")).toMatchObject({ caps: { images: true, resume: false } });
  });
});

describe("openAcpSession", () => {
  test("starts the agent, opens a session with the devbox MCP server and announces the thread", async () => {
    const fake = fakeAgent();
    const { session, events } = open(fake, { spec: { ...SPEC, env: { AGENT_FLAG: "1" } } });
    await session.ready;
    expect(fake.spawns[0]!.argv).toEqual(["example-agent", "acp"]);
    expect(fake.spawns[0]!.cwd).toBe("/workspace");
    expect(fake.spawns[0]!.env.AGENT_FLAG).toBe("1");
    expect(fake.sent.every((m) => m.jsonrpc === "2.0")).toBe(true);
    const init = fake.requests("initialize")[0]!.params;
    expect(init.protocolVersion).toBe(2);
    expect(init.clientInfo.name).toBe("devbox-agent-bridge");
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(fake.requests("session/new")[0]!.params).toEqual({
      cwd: "/workspace",
      mcpServers: [{ name: "devbox", command: "agent-bridge", args: ["mcp"], env: [{ name: "DEVD_URL", value: "http://devd.test" }] }],
    });
    expect(events).toEqual([
      {
        type: "thread.native",
        harness: "example",
        nativeThreadId: "sess-1",
        account: null,
        model: null,
        caps: { resume: true, injectItems: false, liveModelSwitch: false, questions: false, images: false, backgroundVisibility: false },
      },
    ]);
  });

  test("a v2 agent gets typed stdio MCP servers", async () => {
    const fake = fakeAgent(INIT.v2);
    const { session } = open(fake);
    await session.ready;
    expect(fake.requests("session/new")[0]!.params.mcpServers).toEqual([
      { type: "stdio", name: "devbox", command: "agent-bridge", args: ["mcp"], env: [{ name: "DEVD_URL", value: "http://devd.test" }] },
    ]);
  });

  test("the spec's client name replaces devbox's", async () => {
    const fake = fakeAgent(INIT["v2-reported-v1-shape"]);
    const { session } = open(fake, { spec: ACP_AGENTS.antigravity });
    await session.ready;
    expect(fake.requests("initialize")[0]!.params.clientInfo.name).toBe("zed");
    expect(fake.spawns[0]!.argv).toEqual(ACP_AGENTS.antigravity!.argv);
  });

  test("a v1 prompt turn maps chunks, a plan, a tool call and the stop reason", async () => {
    const fake = fakeAgent();
    playTurn(fake, "acp-v1-turn.jsonl");
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "Summarize the README", "user");
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(fake.requests("session/prompt")[0]!.params).toEqual({ sessionId: "sess-1", prompt: [{ type: "text", text: "Summarize the README" }] });
    const run = events.slice(1);
    expect(types(run)).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "message.final",
      "tool.started", // plan
      "tool.started", // call-1
      "tool.started", // permission
      "tool.finished",
      "tool.finished", // call-1
      "message.delta",
      "message.final",
      "tool.finished", // plan
      "run.completed",
    ]);
    expect(run[0]).toEqual({ type: "run.started", runId: "run-1", origin: "user", nativeThreadId: "sess-1", model: null });
    const [m1, m2] = run.filter((e) => e.type === "message.final") as Extract<BridgeEvent, { type: "message.final" }>[];
    expect(m1!.text).toBe("Let me read the README.");
    expect(m2!.text).toBe("It is a demo project.");
    expect(m1!.itemId).not.toBe(m2!.itemId);
    expect(run.find((e) => e.type === "tool.started" && e.itemId === "call-1")).toMatchObject({
      tool: "read",
      input: { title: "Read README.md", rawInput: { path: "/workspace/README.md" }, locations: [{ path: "/workspace/README.md" }] },
    });
    expect(run.find((e) => e.type === "tool.finished" && e.itemId === "call-1")).toMatchObject({ isError: false, output: "# Demo\nA demo project." });
    const plan = run.filter((e) => (e.type === "tool.started" || e.type === "tool.finished") && e.itemId.startsWith("plan"));
    expect(plan[0]).toMatchObject({ type: "tool.started", tool: "plan" });
    expect(plan[1]).toMatchObject({ type: "tool.finished", isError: false, output: "[x] Read the README\n[x] Summarize it" });
    // "Always allow" wins over "Allow" when both are offered.
    expect(fake.responseTo("perm-1")!.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(run.at(-1)).toEqual({ type: "run.completed", runId: "run-1", nativeThreadId: "sess-1", usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 20 }, costUsd: null });
  });

  test("a v2 prompt turn completes on the idle state update", async () => {
    const fake = fakeAgent(INIT.v2);
    playTurn(fake, "acp-v2-turn.jsonl");
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "Summarize the README", "user");
    await until(() => events.some((e) => e.type === "run.completed"));
    const finals = events.filter((e) => e.type === "message.final") as Extract<BridgeEvent, { type: "message.final" }>[];
    expect(finals.map((m) => [m.itemId, m.text])).toEqual([
      ["msg-1", "Let me read the README."],
      ["msg-2", "It is a demo project."],
    ]);
    expect(events.find((e) => e.type === "tool.started" && e.itemId === "call-1")).toMatchObject({ tool: "read" });
    expect(events.find((e) => e.type === "tool.finished" && e.itemId === "call-1")).toMatchObject({ isError: false });
    expect(fake.responseTo("perm-1")!.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", runId: "run-1", usage: { input: 100, output: 50 } });
  });

  test("permission requests are auto-allowed", async () => {
    const fake = fakeAgent();
    fake.responders["session/prompt"] = () => undefined;
    const { session, events, logs } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "go", "user");
    fake.push(
      { jsonrpc: "2.0", id: "p1", method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "c1", title: "Run tests" }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Reject", kind: "reject_once" }] } },
      { jsonrpc: "2.0", id: "p2", method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { toolCallId: "c2", title: "Pick one" }, options: [{ optionId: "x", name: "Red", kind: "_choice" }] } },
    );
    await until(() => fake.responseTo("p2") !== undefined);
    expect(fake.responseTo("p1")!.result).toEqual({ outcome: { outcome: "selected", optionId: "a" } });
    // No allow option: devbox cannot answer it for the user, so it refuses instead of picking one.
    expect(fake.responseTo("p2")!.error!.message).toMatch(/no allow option/);
    expect(logs.some((l) => l.includes("no allow option"))).toBe(true);
    expect(events.filter((e) => e.type === "tool.finished")).toEqual([{ type: "tool.finished", runId: "run-1", itemId: "permission-p1", isError: false, output: "Auto-allowed: Allow" }]);
    expect(events.find((e) => e.type === "tool.started" && e.itemId === "permission-p1")).toMatchObject({ tool: "permission", input: { title: "Run tests", toolCallId: "c1" } });
  });

  test("cancel sends session/cancel and reports the run interrupted", async () => {
    const fake = fakeAgent();
    let promptId: number | string = -1;
    fake.responders["session/prompt"] = (_p, id) => {
      promptId = id;
      return undefined;
    };
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "long task", "user");
    await until(() => promptId !== -1);
    await session.interrupt();
    expect(fake.notifications("session/cancel")).toEqual([{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "sess-1" } }]);
    fake.respond(promptId, { stopReason: "cancelled" });
    await until(() => events.some((e) => e.type === "run.interrupted"));
    expect(events.at(-1)).toEqual({ type: "run.interrupted", runId: "run-1" });
    await expect(session.interrupt()).rejects.toThrow("no active run");
  });

  test("other stop reasons fail the run with the reason", async () => {
    const fake = fakeAgent();
    fake.responders["session/prompt"] = () => ({ stopReason: "max_tokens" });
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "go", "user");
    await until(() => events.some((e) => e.type === "run.failed"));
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "agent stopped: max_tokens" });
  });

  test("an agent's rate-limit error code fails the run as rate-limited", async () => {
    const fake = fakeAgent();
    fake.responders["session/prompt"] = () => {
      throw Object.assign(new Error("Rate limit exceeded"), { code: -31001 });
    };
    const { session, events } = open(fake, { spec: ACP_AGENTS.vibe });
    await session.ready;
    await session.startTurn("run-1", "go", "user");
    await until(() => events.some((e) => e.type === "run.failed"));
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "rate-limited: session/prompt: Rate limit exceeded", reason: "rate-limited" });
  });

  test("the instructions go ahead of the first message of a new session only", async () => {
    const fake = fakeAgent();
    const { session, events } = open(fake, { instructions: "<devbox-instructions>x</devbox-instructions>" });
    await session.ready;
    await session.startTurn("run-1", "one", "user");
    await session.startTurn("run-2", "two", "user");
    await until(() => events.filter((e) => e.type === "run.completed").length === 2);
    expect(fake.requests("session/prompt").map((r) => r.params.prompt[0].text)).toEqual(["<devbox-instructions>x</devbox-instructions>\n\none", "two"]);

    const reopened = fakeAgent();
    const r = open(reopened, { resume: "sess-old", instructions: "<devbox-instructions>x</devbox-instructions>" });
    await r.session.ready;
    await r.session.startTurn("run-3", "three", "user");
    await until(() => r.events.some((e) => e.type === "run.completed"));
    expect(reopened.requests("session/prompt")[0]!.params.prompt[0].text).toBe("three");
  });

  test("an interrupt while the model is being applied never sends the prompt", async () => {
    const fake = fakeAgent();
    fake.responders["session/new"] = () => ({ sessionId: "sess-1", models: { currentModelId: "m1", availableModels: [] } });
    let setModelId: number | string = -1;
    fake.responders["session/set_model"] = (_p, id) => {
      setModelId = id;
      return undefined;
    };
    const { session, events } = open(fake);
    await session.ready;
    await session.setModel("m2");
    await session.startTurn("run-1", "go", "user");
    await until(() => setModelId !== -1);
    await session.interrupt();
    fake.respond(setModelId, {});
    await until(() => events.some((e) => e.type === "run.interrupted"));
    expect(fake.requests("session/prompt")).toHaveLength(0);
    expect(fake.notifications("session/cancel")).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: "run.interrupted", runId: "run-1" });
  });

  test("a v2 whole message without a content list keeps the streamed text", async () => {
    const fake = fakeAgent(INIT.v2);
    fake.responders["session/prompt"] = () => {
      queueMicrotask(() => {
        const update = (u: unknown) => fake.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: u } });
        update({ sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "streamed" } });
        update({ sessionUpdate: "agent_message", messageId: "msg-1", content: "not a list" });
        update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
      });
      return {};
    };
    const { session, events, logs } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "go", "user");
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(events.filter((e) => e.type === "message.final")).toEqual([{ type: "message.final", runId: "run-1", itemId: "msg-1", role: "assistant", text: "streamed" }]);
    expect(logs.some((l) => l.includes("no content list"))).toBe(true);
  });

  test("turns sent during a run wait for it", async () => {
    const fake = fakeAgent();
    const ids: (number | string)[] = [];
    fake.responders["session/prompt"] = (_p, id) => {
      ids.push(id);
      return undefined;
    };
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "one", "user");
    await session.startTurn("run-2", "two", "user");
    await until(() => ids.length === 1);
    expect(fake.requests("session/prompt")).toHaveLength(1);
    fake.respond(ids[0]!, { stopReason: "end_turn" });
    await until(() => ids.length === 2);
    expect(fake.requests("session/prompt")[1]!.params.prompt).toEqual([{ type: "text", text: "two" }]);
    expect(events.filter((e) => e.type === "run.started").map((e) => (e as { runId: string }).runId)).toEqual(["run-1", "run-2"]);
  });

  test("no load capability means resume false", async () => {
    const fake = fakeAgent(INIT["v1-no-load"]);
    const fresh = open(fake);
    await fresh.session.ready;
    expect(fresh.session.capabilities().resume).toBe(false);

    const fake2 = fakeAgent(INIT["v1-no-load"]);
    const resumed = open(fake2, { resume: "sess-old" });
    const err = await resumed.session.ready.catch((e) => e);
    expect(err).toBeInstanceOf(ResumeFailedError);
    expect(fake2.requests("session/load")).toHaveLength(0);
    expect(fake2.requests("session/new")).toHaveLength(0);
    expect(await resumed.session.ended).toMatchObject({ error: expect.stringContaining("cannot resume") });
  });

  test("resume prefers session/resume and falls back to session/load only by capability", async () => {
    const withResume = fakeAgent(INIT.v1);
    const a = open(withResume, { resume: "sess-old" });
    await a.session.ready;
    expect(withResume.requests("session/resume")[0]!.params).toMatchObject({ sessionId: "sess-old", cwd: "/workspace" });
    expect(a.events[0]).toMatchObject({ type: "thread.native", nativeThreadId: "sess-old" });

    const loadOnly = fakeAgent(INIT["v1-load-only"]);
    // session/load replays the history as updates before it returns; they belong to no run.
    loadOnly.responders["session/load"] = (_p, id) => {
      queueMicrotask(() => {
        loadOnly.push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-old", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } } });
        loadOnly.respond(id, {});
      });
      return undefined;
    };
    const b = open(loadOnly, { resume: "sess-old" });
    await b.session.ready;
    expect(loadOnly.requests("session/load")).toHaveLength(1);
    expect(loadOnly.requests("session/resume")).toHaveLength(0);
    expect(types(b.events)).toEqual(["thread.native"]);
    expect(b.logs).toEqual([]);
  });

  test("a resume the agent refuses is a ResumeFailedError", async () => {
    const fake = fakeAgent(INIT.v1);
    fake.responders["session/resume"] = () => {
      throw new Error("Session not found");
    };
    const { session } = open(fake, { resume: "sess-gone" });
    const err = await session.ready.catch((e) => e);
    expect(err).toBeInstanceOf(ResumeFailedError);
    expect(err.message).toContain("Session not found");
  });

  test("process exit between turns restarts on next message", async () => {
    const fake = fakeAgent(INIT.v1);
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "one", "user");
    await until(() => events.some((e) => e.type === "run.completed"));
    let ended = false;
    void session.ended.then(() => (ended = true));
    fake.exit(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toBe(false);
    expect(fake.spawns).toHaveLength(1);

    await session.startTurn("run-2", "two", "user");
    await until(() => events.filter((e) => e.type === "run.completed").length === 2);
    expect(fake.spawns).toHaveLength(2);
    expect(fake.requests("session/resume")[0]!.params).toMatchObject({ sessionId: "sess-1" });
    expect(fake.requests("session/new")).toHaveLength(1);
    expect(fake.requests("session/prompt")[1]!.params).toMatchObject({ sessionId: "sess-1", prompt: [{ type: "text", text: "two" }] });
    expect(ended).toBe(false);
  });

  test("process exit when the agent cannot resume ends the session", async () => {
    const fake = fakeAgent(INIT["v1-no-load"]);
    const { session } = open(fake);
    await session.ready;
    fake.exit(1);
    expect(await session.ended).toEqual({ error: "example-agent exited with code 1" });
    await expect(session.startTurn("run-1", "go", "user")).rejects.toThrow("exited with code 1");
  });

  test("process exit during a run fails the run and the next message restarts the agent", async () => {
    const fake = fakeAgent(INIT.v1);
    fake.responders["session/prompt"] = () => undefined;
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "one", "user");
    await until(() => fake.requests("session/prompt").length === 1);
    fake.exit(137);
    await until(() => events.some((e) => e.type === "run.failed"));
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "example-agent exited with code 137" });
    fake.responders["session/prompt"] = () => ({ stopReason: "end_turn" });
    await session.startTurn("run-2", "two", "user");
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(fake.spawns).toHaveLength(2);
  });

  test("the model is set through the session's model config option, or session/set_model", async () => {
    const viaConfig = fakeAgent(INIT.v1);
    viaConfig.responders["session/new"] = () => ({
      sessionId: "sess-1",
      configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }] }],
    });
    const a = open(viaConfig, { model: "smart" });
    await a.session.ready;
    expect(viaConfig.requests("session/set_config_option")[0]!.params).toEqual({ sessionId: "sess-1", configId: "model", value: "smart" });
    expect(a.session.capabilities().liveModelSwitch).toBe(true);
    expect(a.events[0]).toMatchObject({ type: "thread.native", model: "smart" });
    await a.session.setModel("fast");
    await a.session.startTurn("run-1", "go", "user");
    await until(() => a.events.some((e) => e.type === "run.completed"));
    expect(viaConfig.requests("session/set_config_option")[1]!.params).toEqual({ sessionId: "sess-1", configId: "model", value: "fast" });
    expect(a.events.find((e) => e.type === "run.started")).toMatchObject({ model: "fast" });

    const viaModels = fakeAgent(INIT.v1);
    viaModels.responders["session/new"] = () => ({ sessionId: "sess-1", models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }, { modelId: "m2", name: "M2" }] } });
    const b = open(viaModels, { model: "m2" });
    await b.session.ready;
    expect(viaModels.requests("session/set_model")[0]!.params).toEqual({ sessionId: "sess-1", modelId: "m2" });
  });

  test("the session's reported model is announced when none is requested", async () => {
    const fake = fakeAgent(INIT.v1);
    fake.responders["session/new"] = () => ({ sessionId: "sess-1", models: { currentModelId: "m1", availableModels: [] } });
    const { session, events } = open(fake);
    await session.ready;
    expect(fake.requests("session/set_model")).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "thread.native", model: "m1" });
  });

  test("a requested model the agent offers no way to select fails the start", async () => {
    const fake = fakeAgent(INIT.v1);
    const { session } = open(fake, { model: "m2" });
    await expect(session.ready).rejects.toThrow(/cannot select model m2/);
    expect(fake.killed).toBe(1);
  });

  test("a session mode outside the spec's allowed modes is switched to the first allowed one", async () => {
    const fake = fakeAgent(INIT["v2-reported-v1-shape"]);
    fake.responders["session/new"] = () => ({ sessionId: "sess-1", modes: { currentModeId: "yolo", availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] } });
    const { session } = open(fake, { spec: ACP_AGENTS.antigravity });
    await session.ready;
    expect(fake.requests("session/set_mode")[0]!.params).toEqual({ sessionId: "sess-1", modeId: "default" });

    const ok = fakeAgent(INIT["v2-reported-v1-shape"]);
    ok.responders["session/new"] = () => ({ sessionId: "sess-1", modes: { currentModeId: "default", availableModes: [] } });
    const second = open(ok, { spec: ACP_AGENTS.antigravity });
    await second.session.ready;
    expect(ok.requests("session/set_mode")).toHaveLength(0);
  });

  test("updates for another session and unknown update kinds are logged, not applied", async () => {
    const fake = fakeAgent();
    fake.responders["session/prompt"] = () => undefined;
    const { session, events, logs } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "go", "user");
    fake.push(
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "brand_new_kind" } } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } },
    );
    await until(() => logs.length === 2);
    expect(logs[0]).toContain("sess-other");
    expect(logs[1]).toContain("brand_new_kind");
    expect(types(events)).toEqual(["thread.native", "run.started"]);
  });

  test("close ends the session and fails queued turns", async () => {
    const fake = fakeAgent();
    fake.responders["session/prompt"] = () => undefined;
    const { session, events } = open(fake);
    await session.ready;
    await session.startTurn("run-1", "one", "user");
    await session.startTurn("run-2", "two", "user");
    await session.close();
    expect(await session.ended).toEqual({});
    expect(fake.killed).toBe(1);
    expect(events.filter((e) => e.type === "run.failed").map((e) => (e as { runId: string }).runId)).toEqual(["run-1", "run-2"]);
  });

  test("questions and history injection are not offered", async () => {
    const fake = fakeAgent();
    const { session } = open(fake);
    await session.ready;
    await expect(session.answer("r1", "yes")).rejects.toThrow(/no open request/);
    await expect(session.injectItems([{}])).rejects.toThrow(/not supported/);
  });
});

describe("acpMcpServers", () => {
  test("is the devbox MCP server with the devd variables that are set", () => {
    const saved = { url: process.env.DEVD_URL, sock: process.env.DEVD_AGENT_SOCK, id: process.env.DEVD_SESSION_ID };
    process.env.DEVD_URL = "http://devd.test";
    delete process.env.DEVD_AGENT_SOCK;
    delete process.env.DEVD_SESSION_ID;
    try {
      expect(acpMcpServers("/usr/local/bin/agent-bridge")).toEqual([{ name: "devbox", command: "/usr/local/bin/agent-bridge", args: ["mcp"], env: { DEVD_URL: "http://devd.test" } }]);
      expect(() => acpMcpServers("agent-bridge")).toThrow(/absolute/);
    } finally {
      for (const [k, v] of [["DEVD_URL", saved.url], ["DEVD_AGENT_SOCK", saved.sock], ["DEVD_SESSION_ID", saved.id]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("Grok (live)", () => {
  const [init, mcpUpdate, authError] = recording("acp-grok-live.jsonl").map((l) => l.recv);

  test("Grok launch args: the ACP agent over stdio with every tool call approved", async () => {
    expect(ACP_AGENTS.grok.argv).toEqual(["grok", "agent", "--always-approve", "stdio"]);
    const fake = fakeAgent(init.result);
    const { session } = open(fake, { spec: ACP_AGENTS.grok });
    await session.ready;
    expect(fake.spawns[0]!.argv).toEqual(["grok", "agent", "--always-approve", "stdio"]);
    expect(fake.requests("initialize")[0]!.params.clientInfo.name).toBe("devbox-agent-bridge");
  });

  test("grok 1.0.13 speaks ACP v1, resumes with session/resume and takes no images", async () => {
    expect(negotiate(init.result)).toEqual({
      version: 1,
      caps: { resume: true, injectItems: false, liveModelSwitch: false, questions: false, images: false, backgroundVisibility: false },
    });
    const fake = fakeAgent(init.result);
    const { session } = open(fake, { spec: ACP_AGENTS.grok, resume: "sess-old" });
    await session.ready;
    expect(fake.requests("session/resume")[0]!.params).toMatchObject({ sessionId: "sess-old", cwd: "/workspace" });
    expect(fake.requests("session/load")).toHaveLength(0);
  });

  test("without a Grok login session/new is refused and the start fails with the agent's error", async () => {
    const fake = fakeAgent(init.result);
    fake.responders["session/new"] = () => {
      fake.push(mcpUpdate);
      throw Object.assign(new Error(authError.error.message), { code: authError.error.code });
    };
    const { session, logs } = open(fake, { spec: ACP_AGENTS.grok });
    await expect(session.ready).rejects.toThrow("Authentication required");
    expect(await session.ended).toMatchObject({ error: expect.stringContaining("Authentication required") });
    // Grok's own extension notification is logged, not applied.
    expect(logs.some((l) => l.includes("_x.ai/mcp/servers_updated"))).toBe(true);
  });
});

/** Answers each request the session sends from a live recording: per method, in recorded order, it pushes what the
 *  agent sent between that request and the next one (its response renumbered to the session's request id). */
function replay(fake: ReturnType<typeof fakeAgent>, lines: any[]) {
  const segments = new Map<string, any[][]>();
  let current: any[] | null = null;
  let recordedId: unknown = null;
  for (const l of lines) {
    if (l.out?.method !== undefined && l.out.id !== undefined) {
      current = [];
      recordedId = l.out.id;
      const q = segments.get(l.out.method) ?? [];
      q.push(current);
      segments.set(l.out.method, q);
    } else if (l.in !== undefined && current !== null) current.push(l.in.id === recordedId && l.in.method === undefined ? { ...l.in, id: "@response" } : l.in);
  }
  for (const [method, queue] of segments) {
    fake.responders[method] = (_p, id) => {
      const msgs = queue.shift();
      if (msgs === undefined) throw new Error(`recording has no further ${method}`);
      queueMicrotask(() => fake.push(...msgs.map((m) => (m.id === "@response" ? { ...m, id } : m))));
      return undefined;
    };
  }
}

describe("Mistral Vibe (live)", () => {
  const lines = recording("acp-vibe-live.jsonl");

  test("a turn with a shell tool call, then a reload with session/load and a second turn", async () => {
    const fake = fakeAgent();
    replay(fake, lines);
    const { session, events, logs } = open(fake, { spec: ACP_AGENTS.vibe, model: "mistral-medium-3.5", instructions: "<devbox-instructions>x</devbox-instructions>" });
    await session.ready;
    expect(fake.spawns[0]!.argv).toEqual(["vibe-acp"]);
    // Vibe opens in accept-edits; devbox runs it with everything approved.
    expect(fake.requests("session/set_mode")[0]!.params).toEqual({ sessionId: "sess-1", modeId: "auto-approve" });
    expect(fake.requests("session/set_config_option")[0]!.params).toEqual({ sessionId: "sess-1", configId: "model", value: "mistral-medium-3.5" });
    expect(events[0]).toEqual({
      type: "thread.native", harness: "vibe", nativeThreadId: "sess-1", account: null, model: "mistral-medium-3.5",
      caps: { resume: true, injectItems: false, liveModelSwitch: true, questions: false, images: true, backgroundVisibility: false },
    });

    await session.startTurn("run-1", "list the files", "user");
    await until(() => events.some((e) => e.type === "run.completed"));
    expect(fake.requests("session/prompt")[0]!.params.prompt[0].text).toStartWith("<devbox-instructions>");
    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ itemId: "effect-1", tool: "execute", input: { title: "bash: echo hi > note.txt && ls", rawInput: { command: "echo hi > note.txt && ls" } } });
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ itemId: "effect-1", isError: false, output: "README.md\nnote.txt\n" });
    expect(events.filter((e) => e.type === "message.final")).toEqual([{ type: "message.final", runId: "run-1", itemId: "assistant-1", role: "assistant", text: "Files: README.md, note.txt" }]);
    expect(events.at(-1)).toEqual({ type: "run.completed", runId: "run-1", nativeThreadId: "sess-1", usage: { input: 14950, output: 261, cacheCreation: 0, cacheRead: 8448 }, costUsd: null });

    // The process dies between turns: the next message reloads the session; the replayed history is not shown again.
    fake.exit(137);
    await until(() => logs.some((l) => l.includes("restarting it with the next message")));
    // The reloaded session reports Medium 3.5 as "mistral-medium-latest" (not recorded after the load): the
    // adapter selects the requested id again.
    fake.responders["session/set_config_option"] = () => ({ configOptions: [] });
    const before = events.length;
    await session.startTurn("run-2", "which file?", "user");
    await until(() => events.filter((e) => e.type === "run.completed").length === 2);
    expect(fake.requests("session/load")[0]!.params).toMatchObject({ sessionId: "sess-1", cwd: "/workspace" });
    expect(fake.requests("session/set_config_option")[1]!.params).toEqual({ sessionId: "sess-1", configId: "model", value: "mistral-medium-3.5" });
    expect(fake.requests("session/prompt")[1]!.params.prompt[0].text).toBe("which file?");
    const second = events.slice(before);
    expect(second.filter((e) => e.type === "tool.started")).toEqual([]);
    expect(second.filter((e) => e.type === "message.final").map((e) => (e as { text: string }).text)).toEqual(["note.txt"]);
    // Nothing of what Vibe sent was left unhandled.
    expect(logs.filter((l) => !l.includes("restarting it with the next message"))).toEqual([]);
  });

  test("Vibe -31001 is run.failed rate-limited", async () => {
    const fake = fakeAgent();
    fake.responders["session/prompt"] = () => {
      throw Object.assign(new Error("Rate limit exceeded"), { code: -31001 });
    };
    const { session, events } = open(fake, { spec: ACP_AGENTS.vibe });
    await session.ready;
    await session.startTurn("run-1", "go", "user");
    await until(() => events.some((e) => e.type === "run.failed"));
    expect(events.at(-1)).toMatchObject({ type: "run.failed", runId: "run-1", reason: "rate-limited" });
    // No retry loop: the prompt was sent once.
    expect(fake.requests("session/prompt")).toHaveLength(1);
  });
});
