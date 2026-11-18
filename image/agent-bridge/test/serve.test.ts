import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CAPABILITIES, ResumeFailedError, type HarnessSession } from "../src/claudeSession";
import type { Capabilities } from "../src/events";
import { CONTINUATION_TEXT } from "../src/continuation";
import type { BridgeEvent, RunOrigin } from "../src/events";
import { EventLog } from "../src/eventLog";
import { sendCommand } from "../src/mcp";
import {
  accountFromEnv,
  codexAccountArgs,
  ConfigError,
  EXIT_HARNESS_ENDED,
  EXIT_STOPPED,
  NO_THREAD_ERROR,
  RESTART_LOOP_ERROR,
  serve,
  resolveTarget,
  serveConfigFromEnv,
  type HarnessOpenOptions,
} from "../src/serve";
import type { SwitchTarget } from "../src/protocol";
import { loadState, saveState, type BridgeState } from "../src/state";

const MIN = 60_000;
const NOW = 100 * MIN;

let dir: string;
let socketPath: string;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "serve-"));
  socketPath = join(dir, "agent.sock");
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  rmSync(dir, { recursive: true, force: true });
});

// A harness that behaves like the adapters: one active run, later turns wait for it.
// `deferStart` holds every turn, as Codex does before its thread is ready.
// `readyErrors[i]` makes the i-th open fail to become ready (the session then ends, as the adapters do).
function fakeHarness(opts: { deferStart?: boolean; caps?: Capabilities; readyErrors?: (Error | undefined)[] } = {}) {
  const ends: ((r: { error?: string }) => void)[] = [];
  const f = {
    opens: [] as HarnessOpenOptions[],
    models: [] as string[],
    injected: [] as unknown[][],
    turns: [] as { runId: string; text: string; origin: RunOrigin }[],
    closes: 0,
    active: null as string | null,
    waiting: [] as { runId: string; origin: RunOrigin }[],
    emit(e: BridgeEvent) {
      f.opens[f.opens.length - 1].emit(e);
    },
    start(runId: string, origin: RunOrigin) {
      f.active = runId;
      f.emit({ type: "run.started", runId, origin, nativeThreadId: null, model: null });
    },
    /** The harness process went away by itself. */
    end(error: string) {
      ends[ends.length - 1]({ error });
    },
    complete() {
      const runId = f.active!;
      f.active = null;
      f.emit({ type: "run.completed", runId, nativeThreadId: "thread-1", usage: null, costUsd: null });
      const next = f.waiting.shift();
      if (next) f.start(next.runId, next.origin);
    },
    open(o: HarnessOpenOptions): HarnessSession {
      f.opens.push(o);
      let end: (r: { error?: string }) => void = () => {};
      const ended = new Promise<{ error?: string }>((r) => (end = r));
      ends.push(end);
      const readyError = opts.readyErrors?.[f.opens.length - 1];
      const ready = readyError ? Promise.reject(readyError) : Promise.resolve();
      ready.catch(() => {});
      if (readyError) end({ error: readyError.message });
      return {
        ready,
        capabilities: () => opts.caps ?? CLAUDE_CAPABILITIES,
        async setModel(m) {
          f.models.push(m);
        },
        async injectItems(items) {
          f.injected.push(items);
        },
        async startTurn(runId, text, origin) {
          f.turns.push({ runId, text, origin });
          if (f.active === null && !opts.deferStart) f.start(runId, origin);
          else f.waiting.push({ runId, origin });
        },
        async interrupt() {},
        async answer() {},
        async close() {
          f.closes++;
          end({});
        },
        ended,
      };
    },
  };
  return f;
}

function baseState(over: Partial<BridgeState> = {}): BridgeState {
  return { harness: "claude", nativeThreadId: null, account: null, model: null, activeRunId: null, queue: [], continuations: [], usageBaseline: null, target: null, pendingHandoff: null, ...over };
}

// Account homes for switch targets, under the test dir.
const codexRoot = () => join(dir, "codex-accounts");
const homes = () => ({ sharedHome: join(dir, "codex-v2", "shared"), shadowRoot: join(dir, "codex-v2", "shadow") });

/** A Claude profile dir; with `credentials` it is signed in. */
function claudeProfile(name: string, credentials = '{"claudeAiOauth":{}}'): string {
  const p = join(dir, "claude-accounts", name);
  mkdirSync(p, { recursive: true });
  if (credentials) writeFileSync(join(p, ".credentials.json"), credentials);
  return p;
}

/** A signed-in Codex account; the shared config is pre-seeded so preparing a shadow home needs no python. */
function codexAccount(id: string, auth = '{"tokens":{}}'): void {
  mkdirSync(join(codexRoot(), id), { recursive: true });
  writeFileSync(join(codexRoot(), id, "auth.json"), auth);
  mkdirSync(homes().sharedHome, { recursive: true });
  writeFileSync(join(homes().sharedHome, "config.toml"), 'model = "x"\n');
}

async function start(f: ReturnType<typeof fakeHarness>, over: { account?: string | null } = {}) {
  const bridge = await serve({
    bridgeDir: dir,
    socketPath,
    harness: "claude",
    account: over.account ?? null,
    model: null,
    openHarness: (o) => f.open(o),
    resolveTarget: (t) => resolveTarget(t, codexRoot(), homes()),
    now: () => NOW,
    logError: () => {},
  });
  closers.push(() => bridge.close());
  return bridge;
}

const STARTED_IDLE: BridgeEvent[] = [
  { type: "bridge.started", version: expect.any(String), resumed: false },
  { type: "background.changed", work: [] },
];
const events = () => new EventLog(join(dir, "events.jsonl")).readFrom(0).map((l) => l.event);
const state = () => loadState(join(dir, "state.json"))!;
const cmd = (c: Parameters<typeof sendCommand>[1]) => sendCommand(socketPath, c);

describe("serve", () => {
  test("a fresh start opens the harness without resume and announces itself", async () => {
    const f = fakeHarness();
    await start(f);
    expect(f.opens[0].resume).toBeNull();
    expect(events()).toEqual(STARTED_IDLE);
    expect(state()).toMatchObject({ harness: "claude", activeRunId: null, queue: [] });
  });

  test("start with activeRunId emits run.interrupted then a continuation run", async () => {
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", activeRunId: "r-old", continuations: [NOW - 10 * MIN] }));
    const f = fakeHarness();
    await start(f);
    expect(f.opens[0].resume).toBe("thread-1");
    expect(f.turns).toEqual([{ runId: expect.any(String), text: CONTINUATION_TEXT, origin: "continuation" }]);
    expect(events()).toEqual([
      { type: "bridge.started", version: expect.any(String), resumed: true },
      { type: "background.changed", work: [] },
      { type: "run.interrupted", runId: "r-old" },
      { type: "run.started", runId: f.turns[0].runId, origin: "continuation", nativeThreadId: null, model: null },
    ]);
    // The expired entry is pruned; this continuation is recorded.
    expect(state()).toMatchObject({ activeRunId: f.turns[0].runId, continuations: [NOW] });
  });

  test("4th restart in 5 min fails the run instead", async () => {
    const recent = [NOW - 3 * MIN, NOW - 2 * MIN, NOW - MIN];
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", activeRunId: "r-old", continuations: recent }));
    const f = fakeHarness();
    await start(f);
    expect(f.turns).toEqual([]);
    expect(events().slice(2)).toEqual([{ type: "run.failed", runId: "r-old", error: RESTART_LOOP_ERROR }]);
    expect(state()).toMatchObject({ activeRunId: null, continuations: recent });
  });

  test("queued messages from before the restart are resubmitted after the continuation", async () => {
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", activeRunId: "r-old", queue: [{ runId: "r-q", text: "next", attachments: [] }] }));
    const f = fakeHarness();
    await start(f);
    expect(f.turns.map((t) => [t.text, t.origin])).toEqual([
      [CONTINUATION_TEXT, "continuation"],
      ["next", "user"],
    ]);
    expect(f.turns[1].runId).toBe("r-q");
    f.complete();
    expect(state()).toMatchObject({ activeRunId: "r-q", queue: [] });
  });

  test("unresolved request in the log is expired at start", async () => {
    const log = new EventLog(join(dir, "events.jsonl"));
    log.append({ type: "request.opened", runId: "r1", requestId: "q1", kind: "question", prompt: "a?" });
    log.append({ type: "request.opened", runId: "r1", requestId: "q2", kind: "question", prompt: "b?" });
    log.append({ type: "request.resolved", requestId: "q2", answer: "yes", by: "user" });
    // A crash mid-append leaves a torn last line.
    appendFileSync(join(dir, "events.jsonl"), '{"seq":4,"ts":1,"event":{"type":"request.res');
    const f = fakeHarness();
    await start(f);
    expect(events().slice(3)).toEqual([
      ...STARTED_IDLE,
      { type: "request.resolved", requestId: "q1", answer: null, by: "expired" },
    ]);
  });

  test("startTurn during an active run is queued and persisted in state.queue", async () => {
    const f = fakeHarness();
    await start(f);
    const first = (await cmd({ kind: "startTurn", text: "one" })) as { runId: string };
    expect(state()).toMatchObject({ activeRunId: first.runId, queue: [] });
    const second = (await cmd({ kind: "startTurn", text: "two" })) as { runId: string };
    expect(state()).toMatchObject({ activeRunId: first.runId, queue: [{ runId: second.runId, text: "two", attachments: [] }] });
    expect(events()).toContainEqual({ type: "run.queued", runId: second.runId, text: "two", attachments: [] });
    f.complete();
    expect(state()).toMatchObject({ activeRunId: second.runId, queue: [] });
    f.complete();
    expect(state()).toMatchObject({ activeRunId: null, queue: [] });
  });

  test("startTurn with attachments is refused explicitly", async () => {
    const f = fakeHarness();
    await start(f);
    await expect(cmd({ kind: "startTurn", text: "look", attachments: ["a.png"] })).rejects.toThrow("attachments");
    expect(f.turns).toEqual([]);
  });

  test("restartAgent while a run is active is refused", async () => {
    const f = fakeHarness();
    await start(f);
    await cmd({ kind: "startTurn", text: "one" });
    await expect(cmd({ kind: "restartAgent" })).rejects.toThrow("active");
    expect(f.closes).toBe(0);
    expect(f.opens.length).toBe(1);
  });

  test("restartAgent when idle reopens with resume", async () => {
    const f = fakeHarness();
    await start(f);
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-9", account: null, model: "m" });
    f.opens[0].onUsageBaseline({ usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }, costUsd: 0.1 });
    await cmd({ kind: "restartAgent" });
    expect(f.closes).toBe(1);
    expect(f.opens.length).toBe(2);
    expect(f.opens[1].resume).toBe("thread-9");
    expect(f.opens[1].usageBaseline).toEqual({ usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 }, costUsd: 0.1 });
  });

  test("usage baseline and native thread are persisted and passed on the next start", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-9", account: null, model: "m" });
    f.opens[0].onUsageBaseline({ usage: { input: 5, output: 6, cacheCreation: 7, cacheRead: 8 }, costUsd: 0.2 });
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.opens[0]).toMatchObject({ resume: "thread-9", usageBaseline: { usage: { input: 5, output: 6, cacheCreation: 7, cacheRead: 8 }, costUsd: 0.2 } });
    expect(events().find((e) => e.type === "bridge.started" && e.resumed)).toBeDefined();
  });

  test("thread.native carries the launch account", async () => {
    const f = fakeHarness();
    await start(f, { account: "acct-1" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-1", account: null, model: "m" });
    expect(events()).toContainEqual({ type: "thread.native", harness: "claude", nativeThreadId: "thread-1", account: "acct-1", model: "m" });
    expect(state()).toMatchObject({ account: "acct-1", nativeThreadId: "thread-1", model: "m" });
  });

  test("background.changed merges the adapter's work with the declared wait", async () => {
    const f = fakeHarness();
    await start(f);
    const wakeup = { id: "wakeup", kind: "wakeup" as const, label: "wakeup", holding: true, until: NOW + MIN };
    f.emit({ type: "background.changed", work: [wakeup] });
    const r = (await cmd({ kind: "declareWait", reason: "CI", waitKind: "ci", timeoutMinutes: 10 })) as { until: number };
    expect(r).toEqual({ until: NOW + 10 * MIN });
    await cmd({ kind: "endWait" });
    f.emit({ type: "background.changed", work: [] });
    const bg = events().filter((e) => e.type === "background.changed");
    expect(bg).toEqual([
      { type: "background.changed", work: [] },
      { type: "background.changed", work: [wakeup] },
      { type: "background.changed", work: [wakeup, { id: "declared-wait", kind: "declared-wait", label: "ci: CI", holding: true, until: NOW + 10 * MIN }] },
      { type: "background.changed", work: [wakeup] },
      { type: "background.changed", work: [] },
    ]);
  });

  test("a wakeup past its time stops holding", async () => {
    // The wakeup fired while a user run was active, so the agent never started a turn of its own that clears it.
    let t = NOW;
    const f = fakeHarness();
    const bridge = await serve({ bridgeDir: dir, socketPath, harness: "claude", account: null, model: null, openHarness: (o) => f.open(o), resolveTarget: (x) => x, now: () => t, logError: () => {}, sweepMs: 5 });
    closers.push(() => bridge.close());
    const wakeup = { id: "wakeup", kind: "wakeup" as const, label: "check CI", holding: true, until: NOW + MIN };
    const sub = { id: "t1", kind: "subagent" as const, label: "review", holding: true };
    f.emit({ type: "background.changed", work: [wakeup, sub] });
    t = NOW + MIN + 30_000; // inside the margin: still holding
    await Bun.sleep(20);
    expect(events().filter((e) => e.type === "background.changed").at(-1)).toEqual({ type: "background.changed", work: [wakeup, sub] });
    t = NOW + 2 * MIN + 1;
    await Bun.sleep(20);
    const bg = events().filter((e) => e.type === "background.changed");
    expect(bg.at(-1)).toEqual({ type: "background.changed", work: [sub] });
    // Published once, not on every sweep.
    expect(bg.filter((e) => e.work.length === 1)).toHaveLength(1);
    // The adapter re-reporting its stale wakeup does not bring it back.
    f.emit({ type: "background.changed", work: [wakeup] });
    expect(events().filter((e) => e.type === "background.changed").at(-1)).toEqual({ type: "background.changed", work: [] });
  });

  test("state.json of another harness is refused", async () => {
    saveState(join(dir, "state.json"), baseState({ harness: "codex" }));
    const err = await start(fakeHarness()).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("codex");
  });

  test("stop closes the harness and ends serve", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    await cmd({ kind: "stop" });
    expect(await bridge.closed).toBe(EXIT_STOPPED);
    expect(f.closes).toBe(1);
  });

  test("start with activeRunId but no native thread fails the run instead of continuing in a new conversation", async () => {
    saveState(join(dir, "state.json"), baseState({ activeRunId: "r-old" }));
    const f = fakeHarness();
    await start(f);
    expect(f.turns).toEqual([]);
    expect(events().slice(2)).toEqual([{ type: "run.failed", runId: "r-old", error: NO_THREAD_ERROR }]);
    expect(state()).toMatchObject({ activeRunId: null, continuations: [] });
  });

  test("a turn the harness holds is queued and persisted; a restart in that window still runs it", async () => {
    const f = fakeHarness({ deferStart: true });
    const bridge = await start(f);
    const r = (await cmd({ kind: "startTurn", text: "hello" })) as { runId: string };
    expect(state().queue).toEqual([{ runId: r.runId, text: "hello", attachments: [] }]);
    expect(events()).toContainEqual({ type: "run.queued", runId: r.runId, text: "hello", attachments: [] });
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.turns).toEqual([{ runId: r.runId, text: "hello", origin: "user" }]);
    expect(state()).toMatchObject({ activeRunId: r.runId, queue: [] });
  });

  test("a turn that starts at once is not announced as queued but stores the user's message", async () => {
    const f = fakeHarness();
    await start(f);
    const r = (await cmd({ kind: "startTurn", text: "one" })) as { runId: string };
    expect(events().some((e) => e.type === "run.queued")).toBe(false);
    expect(events().slice(2)).toEqual([
      { type: "run.started", runId: r.runId, origin: "user", nativeThreadId: null, model: null },
      { type: "message.final", runId: r.runId, itemId: `user:${r.runId}`, role: "user", text: "one" },
    ]);
  });

  test("a queued turn's user message comes once, with run.queued", async () => {
    const f = fakeHarness();
    await start(f);
    await cmd({ kind: "startTurn", text: "one" });
    const second = (await cmd({ kind: "startTurn", text: "two" })) as { runId: string };
    f.complete();
    const user = events().filter((e) => (e.type === "message.final" && e.role === "user") || e.type === "run.queued");
    expect(user.filter((e) => "runId" in e && e.runId === second.runId)).toEqual([
      { type: "run.queued", runId: second.runId, text: "two", attachments: [] },
    ]);
  });

  test("a re-sent queued entry never announced before gets its user message", async () => {
    // Crash between persist() and the run.queued publish: the log has no trace of the message.
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", queue: [{ runId: "r-q", text: "lost?", attachments: [] }] }));
    const f = fakeHarness();
    await start(f);
    expect(events()).toContainEqual({ type: "message.final", runId: "r-q", itemId: "user:r-q", role: "user", text: "lost?" });
  });

  test("a re-sent queued entry that stays queued is announced once, then not repeated at start", async () => {
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", activeRunId: "r-old", queue: [{ runId: "r-q", text: "next", attachments: [] }] }));
    const f = fakeHarness();
    await start(f);
    f.complete();
    const user = events().filter((e) => (e.type === "message.final" && e.role === "user") || e.type === "run.queued");
    expect(user).toEqual([{ type: "run.queued", runId: "r-q", text: "next", attachments: [] }]);
  });

  test("a re-sent queued entry already announced in the log is not announced again", async () => {
    const log = new EventLog(join(dir, "events.jsonl"));
    log.append({ type: "run.queued", runId: "r-q", text: "next", attachments: [] });
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", queue: [{ runId: "r-q", text: "next", attachments: [] }] }));
    const f = fakeHarness();
    await start(f);
    const user = events().filter((e) => (e.type === "message.final" && e.role === "user") || e.type === "run.queued");
    expect(user).toEqual([{ type: "run.queued", runId: "r-q", text: "next", attachments: [] }]);
  });

  test("the harness ending by itself saves state and ends serve with the restart status", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-1", account: null, model: "m" });
    f.end("claude exited with code 1");
    expect(await bridge.closed).toBe(EXIT_HARNESS_ENDED);
    expect(state()).toMatchObject({ nativeThreadId: "thread-1" });
  });

  test("restartAgent's own close of the old harness does not end serve", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    await cmd({ kind: "restartAgent" });
    const status = await Promise.race([bridge.closed, new Promise((r) => setTimeout(() => r("open"), 20))]);
    expect(status).toBe("open");
    await cmd({ kind: "startTurn", text: "still here" });
    expect(f.turns.map((t) => t.text)).toEqual(["still here"]);
  });

  test("a corrupt state.json is a configuration error", async () => {
    writeFileSync(join(dir, "state.json"), "{not json");
    await expect(start(fakeHarness())).rejects.toBeInstanceOf(ConfigError);
  });
});

const ACCT = "11111111-2222-3333-4444-555555555555";
const switchCmd = (target: SwitchTarget, resume: string | null = null, handoff: { preamble: string | null; injectItems?: unknown[] } | null = null) =>
  cmd({ kind: "switchTarget", target, resume, handoff });

describe("switching", () => {
  test("setModel is applied by the harness and kept for the next start", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    await cmd({ kind: "setModel", model: "claude-opus-4-5" });
    expect(f.models).toEqual(["claude-opus-4-5"]);
    expect(state()).toMatchObject({ model: "claude-opus-4-5", target: { harness: "claude", model: "claude-opus-4-5", env: {} } });
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.opens[0].target).toMatchObject({ harness: "claude", model: "claude-opus-4-5" });
  });

  test("setModel and switchTarget during an active run are refused", async () => {
    const f = fakeHarness();
    await start(f);
    await cmd({ kind: "startTurn", text: "one" });
    await expect(cmd({ kind: "setModel", model: "m2" })).rejects.toThrow("active");
    await expect(switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } })).rejects.toThrow("active");
    expect(f.models).toEqual([]);
    expect(f.closes).toBe(0);
    expect(f.opens.length).toBe(1);
  });

  test("switchTarget with resume reopens with the stored id", async () => {
    const f = fakeHarness();
    await start(f, { account: "a" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-a", account: null, model: "m" });
    const env = { CLAUDE_CONFIG_DIR: claudeProfile("b") };
    await switchCmd({ harness: "claude", account: "b", model: "claude-opus-4-5", env }, "thread-old");
    expect(f.closes).toBe(1);
    expect(f.opens.length).toBe(2);
    expect(f.opens[1]).toMatchObject({ resume: "thread-old", target: { harness: "claude", account: "b", model: "claude-opus-4-5", env } });
    expect(state()).toMatchObject({ harness: "claude", account: "b", model: "claude-opus-4-5", nativeThreadId: "thread-old", target: { account: "b" } });
    // The new harness announces its thread with the switched account.
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-old", account: null, model: "claude-opus-4-5", caps: CLAUDE_CAPABILITIES });
    expect(events().at(-1)).toEqual({ type: "thread.native", harness: "claude", nativeThreadId: "thread-old", account: "b", model: "claude-opus-4-5", caps: CLAUDE_CAPABILITIES });
  });

  test("a switch to Codex prepares the account's shadow home for that harness only", async () => {
    codexAccount(ACCT);
    const f = fakeHarness();
    await start(f);
    await switchCmd({ harness: "codex", account: ACCT, model: "gpt-5.5", env: {} }, null);
    const shadow = join(homes().shadowRoot, ACCT);
    expect(f.opens[1]).toMatchObject({ resume: null, target: { harness: "codex", account: ACCT, env: { CODEX_HOME: shadow, CODEX_SQLITE_HOME: join(shadow, "sqlite"), DEVD_CODEX_ACCOUNT_ID: ACCT } } });
    expect(process.env.CODEX_HOME).not.toBe(shadow);
    expect(state()).toMatchObject({ harness: "codex", account: ACCT, nativeThreadId: null, usageBaseline: null });
  });

  test("a bridge restart after a switch reopens the switched target, not the launch one", async () => {
    codexAccount(ACCT);
    const f = fakeHarness();
    const bridge = await start(f);
    await switchCmd({ harness: "codex", account: ACCT, model: null, env: {} }, null);
    f.emit({ type: "thread.native", harness: "codex", nativeThreadId: "codex-thread", account: null, model: "gpt" });
    await bridge.close();
    const g = fakeHarness();
    await start(g); // launched as claude
    expect(g.opens[0]).toMatchObject({ resume: "codex-thread", target: { harness: "codex", account: ACCT } });
  });

  test("unusable target account is refused without touching the session", async () => {
    codexAccount(ACCT, "");
    const f = fakeHarness();
    await start(f, { account: "a" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-a", account: null, model: "m" });
    const before = state();
    const unusable: SwitchTarget[] = [
      { harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b", "") } },
      { harness: "claude", account: "c", model: null, env: { CLAUDE_CONFIG_DIR: join(dir, "claude-accounts", "missing") } },
      { harness: "claude", account: "d", model: null, env: {} },
      { harness: "codex", account: ACCT, model: null, env: {} },
      { harness: "codex", account: null, model: null, env: {} },
    ];
    for (const t of unusable) await expect(switchCmd(t, null)).rejects.toThrow();
    expect(f.closes).toBe(0);
    expect(f.opens.length).toBe(1);
    expect(state()).toEqual(before);
    await cmd({ kind: "startTurn", text: "still on a" });
    expect(f.turns.map((t) => t.text)).toEqual(["still on a"]);
  });

  test("handoff preamble is prepended to the next user message only", async () => {
    const f = fakeHarness();
    await start(f);
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null, { preamble: "[user] earlier" });
    expect(state().pendingHandoff).toEqual({ preamble: "[user] earlier" });
    const first = (await cmd({ kind: "startTurn", text: "hi" })) as { runId: string };
    f.complete();
    await cmd({ kind: "startTurn", text: "again" });
    expect(f.turns.map((t) => t.text)).toEqual(["[user] earlier\n\nUser message:\nhi", "again"]);
    // The thread shows what the user wrote, not the handoff.
    expect(events()).toContainEqual({ type: "message.final", runId: first.runId, itemId: `user:${first.runId}`, role: "user", text: "hi" });
    expect(state().pendingHandoff).toBeNull();
  });

  test("a queued handed-over message survives a restart with its preamble", async () => {
    const f = fakeHarness({ deferStart: true });
    const bridge = await start(f);
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null, { preamble: "P" });
    await cmd({ kind: "startTurn", text: "hi" });
    expect(state().queue).toEqual([{ runId: expect.any(String), text: "hi", attachments: [], harnessText: "P\n\nUser message:\nhi" }]);
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.turns.map((t) => t.text)).toEqual(["P\n\nUser message:\nhi"]);
  });

  test("Codex handoff items are injected, not inlined", async () => {
    codexAccount(ACCT);
    const items = [{ type: "message", role: "user", content: [] }];
    const f = fakeHarness({ caps: { ...CLAUDE_CAPABILITIES, injectItems: true } });
    await start(f);
    await switchCmd({ harness: "codex", account: ACCT, model: null, env: {} }, null, { preamble: "P", injectItems: items });
    await cmd({ kind: "startTurn", text: "hi" });
    expect(f.injected).toEqual([items]);
    expect(f.turns.map((t) => t.text)).toEqual(["hi"]);
  });

  test("handoff items for a harness that cannot inject them and no preamble are refused before closing", async () => {
    const f = fakeHarness();
    await start(f);
    await expect(
      switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null, { preamble: null, injectItems: [{}] }),
    ).rejects.toThrow("inject");
    expect(f.closes).toBe(0);
  });

  test("resume failure emits resume-failed", async () => {
    const f = fakeHarness({ readyErrors: [undefined, new ResumeFailedError("no transcript")] });
    const bridge = await start(f);
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, "thread-dead", { preamble: "P" });
    const failed = events().filter((e) => e.type === "run.failed");
    expect(failed).toEqual([{ type: "run.failed", runId: expect.any(String), error: "resume-failed" }]);
    const started = events().filter((e) => e.type === "run.started").map((e) => e.type === "run.started" && e.runId);
    expect(started).not.toContain(failed[0].runId);
    expect(f.turns).toEqual([]);
    // devd follows with a fresh switch; until then the bridge stays up on the switched target without a thread.
    const status = await Promise.race([bridge.closed, new Promise((r) => setTimeout(() => r("open"), 20))]);
    expect(status).toBe("open");
    expect(state()).toMatchObject({ account: "b", nativeThreadId: null, pendingHandoff: null });
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null, { preamble: "full" });
    expect(f.opens.length).toBe(3);
    expect(f.opens[2].resume).toBeNull();
  });
});

describe("launch env", () => {
  test("claude account is the profile directory name under the accounts root", () => {
    expect(accountFromEnv("claude", { CLAUDE_CONFIG_DIR: "/home/dev/.claude-accounts/acct-1" })).toBe("acct-1");
    expect(accountFromEnv("claude", { CLAUDE_CONFIG_DIR: "/home/dev/.claude" })).toBeNull();
    expect(accountFromEnv("claude", { CLAUDE_CONFIG_DIR: "/home/dev/.claude-accounts/a/b" })).toBeNull();
  });

  test("codex account is DEVD_CODEX_ACCOUNT_ID when set", () => {
    expect(accountFromEnv("codex", { DEVD_CODEX_ACCOUNT_ID: "acct-2", CODEX_HOME: "/home/dev/.codex-accounts/acct-3" })).toBe("acct-2");
    expect(accountFromEnv("codex", {})).toBeNull();
  });

  test("an automatically selected codex account is the account home's directory name", () => {
    expect(accountFromEnv("codex", { CODEX_HOME: "/home/dev/.codex-accounts/acct-3" })).toBe("acct-3");
    expect(accountFromEnv("codex", { CODEX_HOME: "/home/dev/.codex" })).toBeNull();
  });

  test("codex app-server gets co's account overrides", () => {
    expect(codexAccountArgs({})).toEqual(["-c", 'cli_auth_credentials_store="file"']);
    expect(codexAccountArgs({ CODEX_SQLITE_HOME: "/home/dev/.codex-accounts/a" })).toEqual([
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      'sqlite_home="/home/dev/.codex-accounts/a"',
    ]);
  });

  test("serveConfigFromEnv reads the launch env and refuses bad values", () => {
    const env = { DEVD_RUNTIME: "chat", DEVD_AGENT: "claude", CLAUDE_CONFIG_DIR: "/home/dev/.claude", DEVD_BRIDGE_DIR: "/tmp/b", DEVD_AGENT_SOCK: "/tmp/s" };
    expect(serveConfigFromEnv(env)).toMatchObject({ harness: "claude", configHome: "/home/dev/.claude", model: null, bridgeDir: "/tmp/b", socketPath: "/tmp/s", account: null });
    expect(serveConfigFromEnv({ ...env, DEVD_AGENT_MODEL: "opus" }).model).toBe("opus");
    expect(() => serveConfigFromEnv({ ...env, DEVD_RUNTIME: "tmux" })).toThrow(ConfigError);
    expect(() => serveConfigFromEnv({ ...env, DEVD_RUNTIME: "tmux" })).toThrow("DEVD_RUNTIME");
    expect(() => serveConfigFromEnv({ ...env, DEVD_AGENT: "grok" })).toThrow("DEVD_AGENT");
    expect(() => serveConfigFromEnv({ DEVD_RUNTIME: "chat", DEVD_AGENT: "codex" })).toThrow("CODEX_HOME");
    expect(serveConfigFromEnv({ DEVD_RUNTIME: "chat", DEVD_AGENT: "codex", CODEX_HOME: "/c" })).toMatchObject({
      harness: "codex",
      configHome: "/c",
      bridgeDir: "/run/devd/bridge",
      socketPath: "/run/devd/agent.sock",
    });
  });
});
