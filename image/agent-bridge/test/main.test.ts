import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./fixtures/sdk-turn.json";
import { parseArgs, runOnce } from "../src/main.ts";
import type { QueryFn } from "../src/claude.ts";
import type { LoggedEvent } from "../src/events.ts";

const required = { "--prompt-file": "p.txt", "--cwd": "/w", "--model": "m", "--log": "l.jsonl" };

function argv(omit?: string): string[] {
  return ["once", ...Object.entries(required).filter(([k]) => k !== omit).flat()];
}

function fakeQuery(messages: unknown[]): QueryFn {
  return (() =>
    (async function* () {
      for (const m of messages) yield m;
    })()) as unknown as QueryFn;
}

describe("parseArgs", () => {
  test("requires prompt-file, cwd, model and log", () => {
    for (const flag of Object.keys(required)) {
      expect(() => parseArgs(argv(flag))).toThrow(flag);
    }
  });

  test("reads optional flags and defaults config-dir to CLAUDE_CONFIG_DIR", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/cfg";
    try {
      const a = parseArgs([...argv(), "--entrypoint", "devbox"]);
      expect(a).toMatchObject({ promptFile: "p.txt", cwd: "/w", model: "m", log: "l.jsonl", entrypoint: "devbox", configDir: "/cfg" });
      expect(parseArgs([...argv(), "--config-dir", "/x"]).configDir).toBe("/x");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe("runOnce", () => {
  test("writes every event and returns the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-once-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "list files");
    const log = join(dir, "events.jsonl");
    const summary = await runOnce(
      { promptFile, cwd: dir, model: "claude-sonnet-4-5", log, configDir: "/cfg", claudeExecutable: "/usr/local/bin/claude" },
      fakeQuery(fixture),
    );
    const logged = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LoggedEvent);
    expect(logged.map((e) => e.event.type).filter((t) => t !== "message.delta")).toEqual([
      "run.started", "tool.started", "tool.finished", "message.final", "run.completed",
    ]);
    expect(logged.map((e) => e.seq)).toEqual(logged.map((_, i) => i + 1));
    const completed = logged.at(-1)!.event;
    expect(summary).toEqual({
      status: "completed",
      nativeThreadId: "5b1f0c1e-3c52-4d0e-9a57-0f6f2a7d1c11",
      model: "claude-sonnet-4-5",
      usage: completed.type === "run.completed" ? completed.usage : null,
    });
    expect(summary.usage).toEqual({ input: 140, output: 82, cacheCreation: 1800, cacheRead: 1000 });
  });
});

const claudePath = Bun.which("claude");
const live = process.env.AGENT_BRIDGE_LIVE === "1" && !!claudePath && !!process.env.CLAUDE_CONFIG_DIR && existsSync(process.env.CLAUDE_CONFIG_DIR);

describe("live smoke", () => {
  // Reason string is part of the contract: "no claude binary / CLAUDE_CONFIG_DIR"
  test.skipIf(!live)("claude answers pong", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-live-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "Reply with the single word: pong");
    const log = join(dir, "events.jsonl");
    const summary = await runOnce({
      promptFile, cwd: dir, model: process.env.AGENT_BRIDGE_MODEL ?? "claude-sonnet-5-5", log,
      configDir: process.env.CLAUDE_CONFIG_DIR!, claudeExecutable: claudePath!,
    });
    expect(summary.status).toBe("completed");
    const finals = readFileSync(log, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as LoggedEvent).event)
      .filter((e) => e.type === "message.final");
    expect(finals.some((e) => e.type === "message.final" && e.text.toLowerCase().includes("pong"))).toBe(true);
  }, 120_000);
});

describe("codex-home argv", () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "main.ts"), "codex-home", ...args], { stderr: "pipe" });

  test("requires exactly one account id", () => {
    for (const args of [[], ["a", "b"]]) {
      const r = run(...args);
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("usage: agent-bridge codex-home <accountId>");
    }
  });

  test("rejects an invalid account id", () => {
    const r = run("../x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("invalid Codex account id");
  });
});
