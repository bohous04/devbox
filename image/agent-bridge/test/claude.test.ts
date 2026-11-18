import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/sdk-turn.json";
import { claudeEnv, runClaudeTurn, type ClaudeTurnOptions, type QueryFn } from "../src/claude.ts";
import type { BridgeEvent } from "../src/events.ts";

const opts: ClaudeTurnOptions = {
  runId: "run-1",
  prompt: "list files",
  cwd: "/workspace",
  model: "claude-sonnet-4-5",
  claudeExecutable: "/usr/local/bin/claude",
  configDir: "/home/dev/.claude",
};

function fakeQuery(messages: unknown[], seen: { options?: Record<string, unknown> }, throwAfter?: number): QueryFn {
  return ((params: { options?: Record<string, unknown> }) => {
    seen.options = params.options;
    return (async function* () {
      let i = 0;
      for (const m of messages) {
        if (throwAfter !== undefined && i++ >= throwAfter) throw new Error("boom");
        yield m;
      }
      if (throwAfter !== undefined && i >= throwAfter) throw new Error("boom");
    })();
  }) as unknown as QueryFn;
}

async function collect(it: AsyncIterable<BridgeEvent>): Promise<BridgeEvent[]> {
  const out: BridgeEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("runClaudeTurn", () => {
  test("maps a turn to bridge events", async () => {
    const events = await collect(runClaudeTurn(opts, fakeQuery(fixture, {})));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types.filter((t) => t === "message.delta").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t !== "message.delta")).toEqual([
      "run.started", "tool.started", "tool.finished", "message.final", "run.completed",
    ]);
    expect(events[0]).toMatchObject({ nativeThreadId: "5b1f0c1e-3c52-4d0e-9a57-0f6f2a7d1c11", model: "claude-sonnet-4-5" });
    expect(events.find((e) => e.type === "tool.started")).toMatchObject({ tool: "Bash", itemId: "toolu_01B" });
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ isError: false, output: "package.json\nsrc\n" });
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      // summed over both models in modelUsage, deliberately larger than result.usage (main loop only)
      usage: { input: 140, output: 82, cacheCreation: 1800, cacheRead: 1000 },
      costUsd: 0.0123,
    });
  });

  test("passes the required SDK options", async () => {
    const seen: { options?: Record<string, unknown> } = {};
    await collect(runClaudeTurn(opts, fakeQuery(fixture, seen)));
    expect(seen.options).toMatchObject({
      pathToClaudeCodeExecutable: opts.claudeExecutable,
      permissionMode: "bypassPermissions",
      model: opts.model,
      cwd: opts.cwd,
      includePartialMessages: true,
    });
    expect("resume" in seen.options!).toBe(false);

    await collect(runClaudeTurn({ ...opts, resume: "sess-9" }, fakeQuery(fixture, seen)));
    expect(seen.options!.resume).toBe("sess-9");
  });

  test("an SDK error becomes run.failed", async () => {
    const events = await collect(runClaudeTurn(opts, fakeQuery(fixture, {}, 1)));
    expect(events.at(-1)).toEqual({ type: "run.failed", runId: "run-1", error: "boom" });
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });
});

describe("claudeEnv", () => {
  test("strips host-session variables", () => {
    const env = claudeEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", PATH: "/bin" }, opts);
    expect("CLAUDECODE" in env).toBe(false);
    expect("CLAUDE_CODE_SESSION_ID" in env).toBe(false);
    expect(env.PATH).toBe("/bin");
    expect(env.CLAUDE_CONFIG_DIR).toBe(opts.configDir);
  });

  test("sets the entrypoint only when asked", () => {
    expect("CLAUDE_CODE_ENTRYPOINT" in claudeEnv({}, opts)).toBe(false);
    expect(claudeEnv({}, { ...opts, entrypoint: "cli" }).CLAUDE_CODE_ENTRYPOINT).toBe("cli");
  });
});
