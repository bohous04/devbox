import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  harnessEnv,
  BRIDGE_VERSION,
  LOST_QUEUED_ERROR,
  NO_THREAD_ERROR,
  OPEN_FAILED,
  RESTART_LOOP_ERROR,
  serve,
  resolveTarget,
  serveConfigFromEnv,
  type HarnessOpenOptions,
} from "../src/serve";
import type { ServerFrame, SwitchTarget } from "../src/protocol";
import { ACP_MIN_BRIDGE_VERSION, CRITIC_MIN_BRIDGE_VERSION, IMAGES_MIN_BRIDGE_VERSION, versionAtLeast } from "../../../shared/bridgeVersion";
import { withImagePaths } from "../src/images";
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
// `readyErrors[i]` makes the i-th open fail to become ready (the session then ends, as the adapters do);
// `readyGates[i]` holds the i-th open's readiness until it resolves.
// `openThrows[i]` makes the i-th open throw synchronously (a missing binary or env in harnessOpener).
function fakeHarness(opts: { deferStart?: boolean; caps?: Capabilities | (() => Capabilities); readyErrors?: (Error | undefined)[]; readyGates?: (Promise<void> | undefined)[]; openThrows?: (Error | undefined)[] } = {}) {
  const ends: ((r: { error?: string }) => void)[] = [];
  const f = {
    opens: [] as HarnessOpenOptions[],
    models: [] as string[],
    efforts: [] as (string | null)[],
    /** Fails the next startTurn with this error. */
    failNextStart: null as Error | null,
    injected: [] as unknown[][],
    turns: [] as { runId: string; text: string; origin: RunOrigin; images?: string[] }[],
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
      const thrown = opts.openThrows?.[f.opens.length];
      f.opens.push(o);
      if (thrown) throw thrown;
      let end: (r: { error?: string }) => void = () => {};
      const ended = new Promise<{ error?: string }>((r) => (end = r));
      ends.push(end);
      const readyError = opts.readyErrors?.[f.opens.length - 1];
      const ready = readyError ? Promise.reject(readyError) : (opts.readyGates?.[f.opens.length - 1] ?? Promise.resolve());
      ready.catch(() => {});
      if (readyError) end({ error: readyError.message });
      return {
        ready,
        capabilities: () => (typeof opts.caps === "function" ? opts.caps() : opts.caps ?? CLAUDE_CAPABILITIES),
        async setModel(m) {
          f.models.push(m);
        },
        async setEffort(e) {
          if (e === "nope") throw new Error("effort nope is not one of low, high");
          f.efforts.push(e);
        },
        async injectItems(items) {
          f.injected.push(items);
        },
        async startTurn(runId, text, origin, images) {
          const fail = f.failNextStart;
          f.failNextStart = null;
          if (fail) throw fail;
          f.turns.push({ runId, text, origin, ...(images?.length ? { images } : {}) });
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
  return { harness: "claude", nativeThreadId: null, account: null, model: null, activeRunId: null, queue: [], continuations: [], usageBaseline: null, target: null, pendingHandoff: null, instructionsPending: false, trimSeq: 0, ackCandidate: null, awaitingTarget: false, effort: null, ...over };
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

async function start(f: ReturnType<typeof fakeHarness>, over: { account?: string | null; claudeExecutable?: string | null; acpBins?: string[]; logError?: (msg: string) => void; logCompactMinBytes?: number; now?: () => number; sweepMs?: number } = {}) {
  const bridge = await serve({
    bridgeDir: dir,
    socketPath,
    harness: "claude",
    account: over.account ?? null,
    model: null,
    openHarness: (o) => f.open(o),
    resolveTarget: (t) => resolveTarget(t, {
      codexAccountsRoot: codexRoot(),
      homes: homes(),
      claudeExecutable: over.claudeExecutable === undefined ? "/usr/local/bin/claude" : over.claudeExecutable,
      which: (bin) => ((over.acpBins ?? ["vibe-acp"]).includes(bin) ? `/usr/local/bin/${bin}` : null),
    }),
    now: over.now ?? (() => NOW),
    logError: over.logError ?? (() => {}),
    ...(over.logCompactMinBytes === undefined ? {} : { logCompactMinBytes: over.logCompactMinBytes }),
    ...(over.sweepMs === undefined ? {} : { sweepMs: over.sweepMs }),
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

  test("a critic startTurn runs with origin critic; without an origin it is the user's", async () => {
    const f = fakeHarness();
    await start(f);
    const r = (await cmd({ kind: "startTurn", text: "fix the failing test", origin: "critic" })) as { runId: string };
    expect(f.turns).toEqual([{ runId: r.runId, text: "fix the failing test", origin: "critic" }]);
    expect(events()).toContainEqual({ type: "run.started", runId: r.runId, origin: "critic", nativeThreadId: null, model: null });
    f.complete();
    const u = (await cmd({ kind: "startTurn", text: "thanks" })) as { runId: string };
    expect(f.turns[1]).toEqual({ runId: u.runId, text: "thanks", origin: "user" });
  });

  test("a queued critic turn keeps its origin across a bridge restart", async () => {
    const f = fakeHarness({ deferStart: true });
    const bridge = await start(f);
    const r = (await cmd({ kind: "startTurn", text: "fix it", origin: "critic" })) as { runId: string };
    expect(state().queue).toEqual([{ runId: r.runId, text: "fix it", attachments: [], origin: "critic" }]);
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.turns).toEqual([{ runId: r.runId, text: "fix it", origin: "critic" }]);
  });

  test("a critic startTurn is refused while a run is active or queued", async () => {
    const f = fakeHarness();
    await start(f);
    await cmd({ kind: "startTurn", text: "one" });
    await expect(cmd({ kind: "startTurn", text: "fix it", origin: "critic" })).rejects.toThrow("run-active");
    await cmd({ kind: "startTurn", text: "two" });
    f.complete();
    await expect(cmd({ kind: "startTurn", text: "fix it", origin: "critic" })).rejects.toThrow("run-active");
    expect(f.turns.map((t) => t.origin)).toEqual(["user", "user"]);
    expect(state().queue).toEqual([]);
  });

  test("a critic turn the harness holds is announced as queued with its origin", async () => {
    const f = fakeHarness({ deferStart: true });
    await start(f);
    const r = (await cmd({ kind: "startTurn", text: "fix it", origin: "critic" })) as { runId: string };
    expect(events()).toContainEqual({ type: "run.queued", runId: r.runId, text: "fix it", attachments: [], origin: "critic" });
  });

  test("attachments go to a harness that takes images; the user's message records them", async () => {
    const f = fakeHarness();
    await start(f);
    const r = (await cmd({ kind: "startTurn", text: "look", attachments: ["/inbox/s/a.png"] })) as { runId: string };
    expect(f.turns).toEqual([{ runId: r.runId, text: "look", origin: "user", images: ["/inbox/s/a.png"] }]);
    expect(events()).toContainEqual({ type: "message.final", runId: r.runId, itemId: `user:${r.runId}`, role: "user", text: "look", attachments: ["/inbox/s/a.png"] });
  });

  test("fallback: a harness without images gets the paths appended to its text; the thread keeps the user's text", async () => {
    const f = fakeHarness({ caps: { ...CLAUDE_CAPABILITIES, images: false } });
    await start(f);
    const r = (await cmd({ kind: "startTurn", text: "look", attachments: ["/inbox/s/a.png", "/inbox/s/b.gif"] })) as { runId: string };
    expect(f.turns).toEqual([{ runId: r.runId, text: withImagePaths("look", ["/inbox/s/a.png", "/inbox/s/b.gif"]), origin: "user" }]);
    expect(events()).toContainEqual({ type: "message.final", runId: r.runId, itemId: `user:${r.runId}`, role: "user", text: "look", attachments: ["/inbox/s/a.png", "/inbox/s/b.gif"] });
  });

  test("a queued message keeps its attachments in run.queued, in state and across a bridge restart", async () => {
    const img = join(dir, "a.png");
    writeFileSync(img, "x");
    const f = fakeHarness({ deferStart: true });
    const bridge = await start(f);
    const r = (await cmd({ kind: "startTurn", text: "look", attachments: [img] })) as { runId: string };
    expect(events()).toContainEqual({ type: "run.queued", runId: r.runId, text: "look", attachments: [img] });
    expect(state().queue).toEqual([{ runId: r.runId, text: "look", attachments: [img] }]);
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.turns).toEqual([{ runId: r.runId, text: "look", origin: "user", images: [img] }]);
  });

  test("recovery: a queued message whose image is gone fails visibly and the rest of the queue still runs", async () => {
    const gone = join(dir, "gone.png");
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", queue: [
      { runId: "r-img", text: "look", attachments: [gone] },
      { runId: "r-next", text: "next", attachments: [] },
    ] }));
    const f = fakeHarness({ deferStart: true });
    await start(f);
    expect(f.turns).toEqual([{ runId: "r-next", text: "next", origin: "user" }]);
    expect(events()).toContainEqual({ type: "run.queued", runId: "r-img", text: "look", attachments: [gone] });
    expect(events()).toContainEqual({ type: "run.failed", runId: "r-img", error: `attachment missing: ${gone}` });
    expect(state().queue).toEqual([{ runId: "r-next", text: "next", attachments: [] }]);
  });

  test("an early turn on a harness still negotiating (an ACP agent before initialize) gets the image paths in its text", async () => {
    let negotiated = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeHarness({ caps: () => ({ ...CLAUDE_CAPABILITIES, images: negotiated }), readyGates: [undefined, gate] });
    await start(f);
    negotiated = false; // the restarted harness reports no images until it has negotiated
    await cmd({ kind: "restartAgent" });
    const r = (await cmd({ kind: "startTurn", text: "look", attachments: ["/inbox/s/a.png"] })) as { runId: string };
    expect(f.turns.at(-1)).toEqual({ runId: r.runId, text: withImagePaths("look", ["/inbox/s/a.png"]), origin: "user" });
    negotiated = true;
    release();
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

  test("S6-R20: a switch whose open throws at once answers with the error and exits serve; the old target stays persisted", async () => {
    const f = fakeHarness({ openThrows: [undefined, new Error("CODEX_HOME is not set for the Codex harness")] });
    const bridge = await start(f);
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-a", account: null, model: "m" });
    codexAccount(ACCT);
    await expect(cmd({ kind: "switchTarget", target: { harness: "codex", account: ACCT, model: null, env: {} }, resume: null, handoff: null })).rejects.toThrow("CODEX_HOME is not set");
    expect(await bridge.closed).toBe(EXIT_HARNESS_ENDED);
    expect(state()).toMatchObject({ harness: "claude", nativeThreadId: "thread-a", target: null });
  });

  test("restartAgent whose reopen throws answers with the error and exits serve for a restart", async () => {
    const f = fakeHarness({ openThrows: [undefined, new Error("claude binary not found on PATH")] });
    const bridge = await start(f);
    await expect(cmd({ kind: "restartAgent" })).rejects.toThrow("claude binary not found on PATH");
    expect(await bridge.closed).toBe(EXIT_HARNESS_ENDED);
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

  test("setEffort goes to the harness, is kept in state.json and reaches the next harness opened", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    expect(f.opens[0].effort).toBeNull();
    await cmd({ kind: "setEffort", effort: "high" });
    expect(f.efforts).toEqual(["high"]);
    expect(state().effort).toBe("high");
    // A level the harness refuses is not kept.
    await expect(cmd({ kind: "setEffort", effort: "nope" })).rejects.toThrow("not one of");
    expect(state().effort).toBe("high");
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.opens[0].effort).toBe("high");
  });

  test("an effort.state from the harness is published and its choice kept (a dropped choice too)", async () => {
    const f = fakeHarness();
    await start(f);
    await cmd({ kind: "setEffort", effort: "high" });
    f.emit({ type: "effort.state", model: "m2", supported: ["low"], effective: "low", chosen: null });
    expect(state().effort).toBeNull();
    expect(events().filter((e) => e.type === "effort.state")).toEqual([{ type: "effort.state", model: "m2", supported: ["low"], effective: "low", chosen: null }]);
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

  test("a critic follow-up takes the handoff, labelled as the critic's review", async () => {
    const f = fakeHarness();
    await start(f);
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null, { preamble: "[user] earlier" });
    await cmd({ kind: "startTurn", text: "fix the migration", origin: "critic" });
    expect(f.turns.map((t) => t.text)).toEqual(["[user] earlier\n\nCritic review:\nfix the migration"]);
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

describe("switching: fix round 1", () => {
  test("a proxy target's secret values never reach state.json; after a restart the bridge awaits the target", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    const env = { CLAUDE_CONFIG_DIR: claudeProfile("proxy", ""), ANTHROPIC_BASE_URL: "http://proxy.invalid", ANTHROPIC_AUTH_TOKEN: "tok-secret-value" };
    await switchCmd({ harness: "claude", account: null, model: "proxy-model", env }, null);
    // The live harness got the whole env.
    expect(f.opens[1].target.env).toEqual(env);
    expect(readFileSync(join(dir, "state.json"), "utf8")).not.toContain("tok-secret-value");
    expect(state().target).toEqual({
      harness: "claude",
      account: null,
      model: "proxy-model",
      env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL },
      droppedEnvKeys: ["ANTHROPIC_AUTH_TOKEN"],
    });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "proxy-thread", account: null, model: "proxy-model" });
    await bridge.close();

    const g = fakeHarness();
    await start(g);
    expect(g.opens).toEqual([]);
    expect(events()).toContainEqual({ type: "bridge.started", version: expect.any(String), resumed: true, awaitingTarget: true });
    const queued = (await cmd({ kind: "startTurn", text: "while away" })) as { runId: string };
    expect(events()).toContainEqual({ type: "run.queued", runId: queued.runId, text: "while away", attachments: [] });
    expect(g.turns).toEqual([]);
    await expect(cmd({ kind: "interrupt" })).rejects.toThrow("no harness");
    await expect(cmd({ kind: "setModel", model: "x" })).rejects.toThrow("no harness");
    await expect(cmd({ kind: "restartAgent" })).rejects.toThrow("no harness");

    // devd re-sends the target with its env; the harness opens and the queued message runs.
    await switchCmd({ harness: "claude", account: null, model: "proxy-model", env }, "proxy-thread");
    expect(g.opens.length).toBe(1);
    expect(g.opens[0]).toMatchObject({ resume: "proxy-thread", target: { env } });
    expect(g.turns).toEqual([{ runId: queued.runId, text: "while away", origin: "user" }]);
    expect(readFileSync(join(dir, "state.json"), "utf8")).not.toContain("tok-secret-value");
  });

  test("a restart with a persisted target without secrets opens it at once", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null);
    await bridge.close();
    const g = fakeHarness();
    await start(g);
    expect(g.opens[0].target).toMatchObject({ account: "b" });
    expect(events().filter((e) => e.type === "bridge.started").at(-1)).toEqual({ type: "bridge.started", version: expect.any(String), resumed: false });
  });

  test("an injected handoff is never injected twice, even when its turn fails to start", async () => {
    codexAccount(ACCT);
    const items = [{ type: "message" }];
    const f = fakeHarness({ caps: { ...CLAUDE_CAPABILITIES, injectItems: true } });
    await start(f);
    await switchCmd({ harness: "codex", account: ACCT, model: null, env: {} }, null, { preamble: "P", injectItems: items });
    f.failNextStart = new Error("harness hiccup");
    await expect(cmd({ kind: "startTurn", text: "hi" })).rejects.toThrow("hiccup");
    expect(f.injected).toEqual([items]);
    expect(state().pendingHandoff).toBeNull();
    await cmd({ kind: "startTurn", text: "hi again" });
    expect(f.injected).toEqual([items]);
    expect(f.turns.map((t) => t.text)).toEqual(["hi again"]);
  });

  test("a preamble handoff whose turn fails to start is kept for the next message", async () => {
    const f = fakeHarness();
    await start(f);
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null, { preamble: "P" });
    f.failNextStart = new Error("harness hiccup");
    await expect(cmd({ kind: "startTurn", text: "hi" })).rejects.toThrow("hiccup");
    expect(state().pendingHandoff).toEqual({ preamble: "P" });
    await cmd({ kind: "startTurn", text: "hi" });
    expect(f.turns.map((t) => t.text)).toEqual(["P\n\nUser message:\nhi"]);
  });

  test("switchTarget, setModel and restartAgent are refused while a switch is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeHarness({ readyGates: [undefined, gate] });
    await start(f);
    const target: SwitchTarget = { harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } };
    const first = switchCmd(target, null);
    await Bun.sleep(20);
    expect(f.opens.length).toBe(2);
    await expect(switchCmd(target, null)).rejects.toThrow("in progress");
    await expect(cmd({ kind: "setModel", model: "m" })).rejects.toThrow("in progress");
    await expect(cmd({ kind: "restartAgent" })).rejects.toThrow("in progress");
    release();
    await first;
    expect(f.opens.length).toBe(2);
    await cmd({ kind: "setModel", model: "m" });
    expect(f.models).toEqual(["m"]);
  });

  test("a switch to an ACP agent opens it without an account and hands the context over as a preamble", async () => {
    const f = fakeHarness();
    await start(f, { account: "a" });
    await switchCmd({ harness: "vibe", account: null, model: "mistral-large-4-0", env: {} }, null, { preamble: "[user] earlier" });
    expect(f.opens[1]).toMatchObject({ resume: null, target: { harness: "vibe", account: null, model: "mistral-large-4-0", env: {} } });
    expect(state()).toMatchObject({ harness: "vibe", account: null, model: "mistral-large-4-0", target: { harness: "vibe" } });
    await cmd({ kind: "startTurn", text: "hi" });
    expect(f.turns.map((t) => t.text)).toEqual(["[user] earlier\n\nUser message:\nhi"]);
  });

  test("a session switched to an ACP agent keeps no account across a bridge restart", async () => {
    const f = fakeHarness();
    const bridge = await start(f, { account: "a" });
    await switchCmd({ harness: "vibe", account: null, model: "mistral-large-4-0", env: {} }, null);
    f.emit({ type: "thread.native", harness: "vibe", nativeThreadId: "vibe-thread", account: null, model: "mistral-large-4-0" });
    await bridge.close();
    const g = fakeHarness();
    await start(g, { account: "a" }); // launched as claude with account a
    expect(g.opens[0]).toMatchObject({ resume: "vibe-thread", target: { harness: "vibe", account: null } });
    expect(state()).toMatchObject({ harness: "vibe", account: null, target: { harness: "vibe", account: null } });
    g.emit({ type: "thread.native", harness: "vibe", nativeThreadId: "vibe-thread", account: null, model: "mistral-large-4-0" });
    expect(events().at(-1)).toMatchObject({ type: "thread.native", harness: "vibe", account: null });
  });

  test("S4-P3: a new thread gets the instructions until a prompt got through, also across a bridge restart", async () => {
    const f = fakeHarness();
    const bridge = await start(f, { account: "a" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-a", account: null, model: "m" });
    f.opens[0].onInstructionsDelivered(); // Claude has a system prompt; the flag only matters to ACP agents
    await switchCmd({ harness: "vibe", account: null, model: null, env: {} }, null);
    expect(f.opens[1].instructionsPending).toBe(true);
    f.emit({ type: "thread.native", harness: "vibe", nativeThreadId: "vibe-thread", account: null, model: null });
    await bridge.close();
    // Restarted before any prompt: the reopened thread still owes them.
    const g = fakeHarness();
    const again = await start(g, { account: "a" });
    expect(g.opens[0]).toMatchObject({ resume: "vibe-thread", instructionsPending: true });
    g.opens[0].onInstructionsDelivered();
    expect(state().instructionsPending).toBe(false);
    await again.close();
    const h = fakeHarness();
    await start(h, { account: "a" });
    expect(h.opens[0]).toMatchObject({ resume: "vibe-thread", instructionsPending: false });
  });

  test("a switch to an ACP agent that cannot open goes back to the previous target and fails with the agent's error", async () => {
    const f = fakeHarness({ readyErrors: [undefined, new Error("Authentication required")] });
    const bridge = await start(f, { account: "a" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-a", account: null, model: "m" });
    await expect(switchCmd({ harness: "vibe", account: null, model: null, env: {} }, null, { preamble: "[user] earlier" }))
      .rejects.toThrow("Authentication required");
    // The previous target is open again on its own thread; no crash loop on the target that cannot open.
    expect(f.opens.length).toBe(3);
    expect(f.opens[2]).toMatchObject({ resume: "thread-a", target: { harness: "claude", account: "a" } });
    const status = await Promise.race([bridge.closed, new Promise((r) => setTimeout(() => r("open"), 20))]);
    expect(status).toBe("open");
    expect(state()).toMatchObject({ harness: "claude", account: "a", nativeThreadId: "thread-a", target: null, pendingHandoff: null });
    expect((await handshake()).awaitingTarget).toBe(false);
    await cmd({ kind: "startTurn", text: "hi" });
    expect(f.turns.map((t) => t.text)).toEqual(["hi"]);
  });

  test("a persisted ACP target that cannot open at start awaits devd's target instead of exiting, and says so", async () => {
    saveState(join(dir, "state.json"), baseState({
      harness: "vibe", nativeThreadId: "vibe-thread",
      target: { harness: "vibe", account: null, model: null, env: {}, droppedEnvKeys: [] },
      queue: [{ runId: "r-q", text: "queued", attachments: [] }],
    }));
    const f = fakeHarness({ readyErrors: [new Error("Authentication required")] });
    const bridge = await start(f, { account: "a" });
    const status = await Promise.race([bridge.closed, new Promise((r) => setTimeout(() => r("open"), 20))]);
    expect(status).toBe("open");
    expect((await handshake()).awaitingTarget).toBe(true);
    expect(events().filter((e) => e.type === "run.failed")).toEqual([{ type: "run.failed", runId: expect.any(String), error: OPEN_FAILED }]);
    // The user switches back: the queued message goes to the harness that opens.
    await switchCmd({ harness: "claude", account: "a", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("a") } }, null, { preamble: "P" });
    expect(f.turns.map((t) => t.text)).toEqual(["P\n\nUser message:\nqueued"]);
  });

  test("an ACP target with an account, or without its binary, is refused before the current harness is retired", async () => {
    const f = fakeHarness();
    await start(f, { acpBins: ["vibe-acp"] });
    await expect(switchCmd({ harness: "grok", account: null, model: null, env: {} })).rejects.toThrow("grok (grok) not found");
    await expect(switchCmd({ harness: "vibe", account: "acct-1", model: null, env: {} })).rejects.toThrow("own CLI login");
    // History items alone cannot reach an ACP agent.
    await expect(switchCmd({ harness: "vibe", account: null, model: null, env: {} }, null, { preamble: null, injectItems: [{}] })).rejects.toThrow("cannot inject");
    expect(f.closes).toBe(0);
    expect(f.opens.length).toBe(1);
  });

  test("a missing claude binary refuses the switch before the current harness is retired", async () => {
    const f = fakeHarness();
    await start(f, { claudeExecutable: null });
    await expect(switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } }, null)).rejects.toThrow("claude binary");
    expect(f.closes).toBe(0);
    expect(f.opens.length).toBe(1);
  });

  test("a thread.native without a model keeps the known model", async () => {
    const f = fakeHarness();
    await start(f);
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: null, model: "claude-opus-4-5" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: null, model: null });
    expect(state().model).toBe("claude-opus-4-5");
  });
});

/** The `ready` frame of a new connection's handshake. */
async function handshake(afterSeq = 1_000_000): Promise<Extract<ServerFrame, { t: "ready" }>> {
  let buf = "";
  let done: (f: Extract<ServerFrame, { t: "ready" }>) => void = () => {};
  const ready = new Promise<Extract<ServerFrame, { t: "ready" }>>((r) => (done = r));
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        buf += chunk.toString("utf8");
        for (const line of buf.split("\n").filter(Boolean)) {
          const f = JSON.parse(line) as ServerFrame;
          if (f.t === "ready") done(f);
        }
      },
    },
  });
  socket.write(JSON.stringify({ t: "hello", afterSeq }) + "\n");
  try {
    return await ready;
  } finally {
    socket.end();
  }
}

/** A connection that stays open after its hello (devd's link): `ack` sends a periodic ack and waits until the
 *  bridge has handled it (a command sent after it is answered). */
async function liveLink(afterSeq: number): Promise<{ ack(seq: number): Promise<void>; close(): void }> {
  let buf = "";
  const waiting = new Map<string, () => void>();
  let ready: () => void = () => {};
  const isReady = new Promise<void>((r) => (ready = r));
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const f = JSON.parse(buf.slice(0, nl)) as ServerFrame;
          buf = buf.slice(nl + 1);
          if (f.t === "ready") ready();
          if (f.t === "res") waiting.get(f.id)?.();
        }
      },
    },
  });
  socket.write(JSON.stringify({ t: "hello", afterSeq }) + "\n");
  await isReady;
  let n = 0;
  return {
    async ack(seq) {
      const id = `probe-${++n}`;
      const answered = new Promise<void>((r) => waiting.set(id, r));
      // An unknown request id answers with an error after the ack was handled (frames are handled in order).
      socket.write(JSON.stringify({ t: "ack", seq }) + "\n" + JSON.stringify({ t: "cmd", id, cmd: { kind: "answer", requestId: "none", answer: "" } }) + "\n");
      await answered;
    },
    close: () => socket.end(),
  };
}

describe("final review fixes", () => {
  test("C1: a thread that cannot be resumed at start keeps serve up, reports resume-failed and holds the queue for devd's fresh target", async () => {
    saveState(join(dir, "state.json"), baseState({ harness: "codex", nativeThreadId: "step2-thread", queue: [{ runId: "r-q", text: "queued", attachments: [] }], pendingHandoff: { preamble: "stale delta" } }));
    codexAccount(ACCT);
    const f = fakeHarness({ readyErrors: [new ResumeFailedError("thread/resume step2-thread failed: not found")] });
    const bridge = await serve({
      bridgeDir: dir, socketPath, harness: "codex", account: ACCT, model: null,
      openHarness: (o) => f.open(o),
      resolveTarget: (t) => resolveTarget(t, { codexAccountsRoot: codexRoot(), homes: homes(), claudeExecutable: null }),
      now: () => NOW, logError: () => {},
    });
    closers.push(() => bridge.close());
    expect(f.opens[0].resume).toBe("step2-thread");
    const status = await Promise.race([bridge.closed, new Promise((r) => setTimeout(() => r("open"), 20))]);
    expect(status).toBe("open");
    const failed = events().filter((e) => e.type === "run.failed");
    expect(failed).toEqual([{ type: "run.failed", runId: expect.any(String), error: "resume-failed" }]);
    expect(failed[0].type === "run.failed" && failed[0].runId).not.toBe("r-q");
    expect(state()).toMatchObject({ nativeThreadId: null, pendingHandoff: null, queue: [{ runId: "r-q", text: "queued" }] });
    expect(await handshake()).toMatchObject({ awaitingTarget: true, version: BRIDGE_VERSION });
    // A new message waits with the queued one instead of reaching a harness without a thread.
    const later = (await cmd({ kind: "startTurn", text: "later" })) as { runId: string };
    expect(events()).toContainEqual({ type: "run.queued", runId: later.runId, text: "later", attachments: [] });
    expect(f.turns).toEqual([]);

    // devd's re-plan: the same target, a fresh thread, the full handoff with the first waiting message.
    await switchCmd({ harness: "codex", account: ACCT, model: null, env: {} }, null, { preamble: "full" });
    expect(f.opens[1].resume).toBeNull();
    expect(f.turns.map((t) => [t.runId, t.text])).toEqual([["r-q", "full\n\nUser message:\nqueued"], [later.runId, "later"]]);
    expect((await handshake()).awaitingTarget).toBe(false);
  });

  test("C1: a failed resume during a switch also holds new messages for devd's fresh target", async () => {
    const f = fakeHarness({ readyErrors: [undefined, new ResumeFailedError("no transcript")] });
    await start(f);
    const target: SwitchTarget = { harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } };
    await switchCmd(target, "thread-dead");
    expect((await handshake()).awaitingTarget).toBe(true);
    const r = (await cmd({ kind: "startTurn", text: "hi" })) as { runId: string };
    expect(f.turns).toEqual([]);
    await switchCmd(target, null, { preamble: "full" });
    expect(f.turns).toEqual([{ runId: r.runId, text: "full\n\nUser message:\nhi", origin: "user" }]);
  });

  test("I1: after a VPS reboot, the re-sent target without a handoff keeps the bridge's pending handoff", async () => {
    const f = fakeHarness();
    const bridge = await start(f);
    const env = { CLAUDE_CONFIG_DIR: claudeProfile("proxy", ""), ANTHROPIC_BASE_URL: "http://proxy.invalid", ANTHROPIC_AUTH_TOKEN: "tok" };
    await switchCmd({ harness: "claude", account: null, model: "proxy-model", env }, null, { preamble: "P" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "proxy-thread", account: null, model: "proxy-model" });
    await bridge.close();

    // Reboot: devd lost its memory and rebuilds the target without the handoff.
    const g = fakeHarness();
    const again = await start(g);
    await switchCmd({ harness: "claude", account: null, model: "proxy-model", env }, "proxy-thread", null);
    expect(state().pendingHandoff).toEqual({ preamble: "P" });
    await cmd({ kind: "startTurn", text: "hi" });
    expect(g.turns.map((t) => t.text)).toEqual(["P\n\nUser message:\nhi"]);
    g.complete();
    await again.close();

    const h = fakeHarness();
    await start(h);
    await switchCmd({ harness: "claude", account: null, model: "proxy-model", env }, "proxy-thread", { preamble: "Q" });
    expect(state().pendingHandoff).toEqual({ preamble: "Q" });
    await switchCmd({ harness: "claude", account: null, model: "other-model", env }, "proxy-thread", null);
    expect(state().pendingHandoff).toEqual({ preamble: "Q" });
  });

  test("P23a: a switch without a handoff keeps the pending one on the same thread, whatever the account or model; another or no thread replaces it", async () => {
    const f = fakeHarness();
    await start(f, { account: "a" });
    const b = { harness: "claude" as const, account: "b", model: "claude-sonnet-5-5", env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } };
    await switchCmd(b, null, { preamble: "P" });
    f.emit({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: null, model: "claude-sonnet-5-5" });
    const c = { harness: "claude" as const, account: "c", model: "claude-opus-5-5", env: { CLAUDE_CONFIG_DIR: claudeProfile("c") } };
    await switchCmd(c, "t1", null);
    expect(state().pendingHandoff).toEqual({ preamble: "P" });
    await switchCmd(c, "t-other", null);
    expect(state().pendingHandoff).toBeNull();
    await switchCmd(b, null, { preamble: "R" });
    await switchCmd(c, null, null);
    expect(state().pendingHandoff).toBeNull();
  });

  test("I3: a setModel target keeps only the model; a restart with another leased account runs on it and announces it", async () => {
    const f = fakeHarness();
    const bridge = await start(f, { account: "acct-a" });
    await cmd({ kind: "setModel", model: "claude-sonnet-5-5" });
    await bridge.close();
    const g = fakeHarness();
    await start(g, { account: "acct-b" });
    expect(g.opens[0].target).toMatchObject({ harness: "claude", account: "acct-b", model: "claude-sonnet-5-5" });
    expect(state()).toMatchObject({ account: "acct-b", target: { account: "acct-b", model: "claude-sonnet-5-5" } });
    g.emit({ type: "thread.native", harness: "claude", nativeThreadId: "t1", account: null, model: null });
    expect(events().at(-1)).toMatchObject({ type: "thread.native", account: "acct-b" });
  });

  test("I3: a switched target with its own home keeps its account whatever the launch leased", async () => {
    const f = fakeHarness();
    const bridge = await start(f, { account: "acct-a" });
    await switchCmd({ harness: "claude", account: "b", model: null, env: { CLAUDE_CONFIG_DIR: claudeProfile("b") } });
    await bridge.close();
    const g = fakeHarness();
    await start(g, { account: "acct-c" });
    expect(g.opens[0].target).toMatchObject({ account: "b" });
    expect(state().account).toBe("b");
  });

  test("M1: the handshake names a bridge version newer than the one before switching", async () => {
    await start(fakeHarness());
    expect(BRIDGE_VERSION).not.toBe("1.0.0");
    expect(await handshake()).toMatchObject({ version: BRIDGE_VERSION, awaitingTarget: false });
  });

  test("this bridge knows ACP harnesses: its version is at least the one devd and the dashboard require for them", () => {
    expect(versionAtLeast(BRIDGE_VERSION, ACP_MIN_BRIDGE_VERSION)).toBe(true);
  });

  test("this bridge takes a startTurn origin: its version is at least the one devd requires for critic follow-ups", () => {
    expect(versionAtLeast(BRIDGE_VERSION, CRITIC_MIN_BRIDGE_VERSION)).toBe(true);
  });

  test("this bridge takes startTurn attachments: its version is the one devd requires to send them", () => {
    expect(versionAtLeast(BRIDGE_VERSION, IMAGES_MIN_BRIDGE_VERSION)).toBe(true);
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
    expect(() => serveConfigFromEnv({ ...env, DEVD_AGENT: "gemini" })).toThrow("DEVD_AGENT");
    // An ACP agent runs on its own CLI login: no config home, no account.
    expect(serveConfigFromEnv({ DEVD_RUNTIME: "chat", DEVD_AGENT: "vibe" })).toMatchObject({ harness: "vibe", configHome: null, account: null, model: null });
    expect(() => serveConfigFromEnv({ DEVD_RUNTIME: "chat", DEVD_AGENT: "codex" })).toThrow("CODEX_HOME");
    expect(serveConfigFromEnv({ DEVD_RUNTIME: "chat", DEVD_AGENT: "codex", CODEX_HOME: "/c" })).toMatchObject({
      harness: "codex",
      configHome: "/c",
      bridgeDir: "/run/devd/bridge",
      socketPath: "/run/devd/agent.sock",
    });
  });

  const proxyInputs = { DEVD_UPSTREAM_URL: "http://proxy:8317", DEVD_UPSTREAM_KEY: "k-secret", DEVD_AGENT_MODEL: "gpt-x" };

  test("a proxy profile launches the claude harness with the profile env", () => {
    const env = { DEVD_RUNTIME: "chat", DEVD_AGENT: "claude-gemini", CLAUDE_CONFIG_DIR: "/home/dev/.claude", ...proxyInputs };
    const c = serveConfigFromEnv(env);
    expect(c).toMatchObject({ harness: "claude", model: "gpt-x", account: null });
    expect(c.targetEnv).toMatchObject({ ANTHROPIC_BASE_URL: "http://proxy:8317", ANTHROPIC_AUTH_TOKEN: "k-secret", ANTHROPIC_MODEL: "gpt-x", DEVBOX_PROXY_PROFILE: "1" });
    expect(serveConfigFromEnv({ ...env, DEVD_AGENT: "claude" }).targetEnv).toEqual({});
    // agent-launch.sh refuses a profile without key or model; so does the bridge, as a configuration error.
    expect(() => serveConfigFromEnv({ ...env, DEVD_UPSTREAM_KEY: "" })).toThrow(ConfigError);
    expect(() => serveConfigFromEnv({ ...env, DEVD_AGENT_MODEL: "" })).toThrow("no model");
  });

  test("the launch harness opens with the launch target env", async () => {
    const f = fakeHarness();
    const bridge = await serve({
      bridgeDir: dir, socketPath, harness: "claude", account: null, model: "gpt-x", targetEnv: { ANTHROPIC_MODEL: "gpt-x" },
      openHarness: (o) => f.open(o), resolveTarget: (t) => t, now: () => NOW, logError: () => {},
    });
    closers.push(() => bridge.close());
    expect(f.opens[0].target).toEqual({ harness: "claude", account: null, model: "gpt-x", env: { ANTHROPIC_MODEL: "gpt-x" } });
  });

  test("serveConfigFromEnv binds the bridge to its session when devd gave it a secret", () => {
    const env = { DEVD_RUNTIME: "chat", DEVD_AGENT: "vibe", DEVD_SESSION_ID: "dev-harbor-web" };
    const secret = "0f".repeat(32);
    expect(serveConfigFromEnv({ ...env, DEVD_BRIDGE_SECRET: secret }).binding).toEqual({ session: "dev-harbor-web", secret });
    // A container devd created without a secret (a dev machine, a test) serves unbound; devd decides whether it takes that.
    expect(serveConfigFromEnv(env).binding).toBeNull();
    expect(() => serveConfigFromEnv({ ...env, DEVD_BRIDGE_SECRET: "short" })).toThrow(ConfigError);
    expect(() => serveConfigFromEnv({ ...env, DEVD_BRIDGE_SECRET: "zz".repeat(32) })).toThrow("DEVD_BRIDGE_SECRET");
    expect(() => serveConfigFromEnv({ DEVD_RUNTIME: "chat", DEVD_AGENT: "vibe", DEVD_BRIDGE_SECRET: secret })).toThrow("DEVD_SESSION_ID");
  });

  test("a harness never inherits the bridge's session secret", () => {
    expect(harnessEnv({ PATH: "/bin", DEVD_BRIDGE_SECRET: "0f".repeat(32) }, {})).toEqual({ PATH: "/bin" });
  });

  test("a harness never inherits proxy profile keys or ANTHROPIC_API_KEY from the launch env", () => {
    const launch = { PATH: "/bin", ANTHROPIC_BASE_URL: "http://old", ANTHROPIC_AUTH_TOKEN: "old", ANTHROPIC_API_KEY: "api", DEVBOX_PROXY_PROFILE: "1" };
    expect(harnessEnv(launch, { CLAUDE_CONFIG_DIR: "/a" })).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/a" });
    expect(harnessEnv(launch, { ANTHROPIC_BASE_URL: "http://new" })).toEqual({ PATH: "/bin", ANTHROPIC_BASE_URL: "http://new" });
  });
});

const logPath = () => join(dir, "events.jsonl");
/** Writes events to the log as an earlier bridge did. */
function priorLog(...evs: BridgeEvent[]): void {
  const log = new EventLog(logPath());
  for (const e of evs) log.append(e);
}

describe("step 6 hardening", () => {
  test("M2: a run the log shows started without its end, which state no longer holds, is interrupted at start", async () => {
    priorLog(
      { type: "run.started", runId: "r-lost", origin: "user", nativeThreadId: null, model: null },
      { type: "message.delta", runId: "r-lost", itemId: "a", text: "x" },
    );
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1" }));
    const f = fakeHarness();
    await start(f);
    expect(events().slice(2)).toEqual([...STARTED_IDLE.map((e) => (e.type === "bridge.started" ? { ...e, resumed: true } : e)), { type: "run.interrupted", runId: "r-lost" }]);
    // Its end was lost, not the run: no automatic continuation.
    expect(f.turns).toEqual([]);
  });

  test("M2: a queued run the log announced, which state no longer holds, fails visibly at start", async () => {
    priorLog({ type: "run.queued", runId: "r-q", text: "later", attachments: [] });
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1" }));
    await start(fakeHarness());
    expect(events().at(-1)).toEqual({ type: "run.failed", runId: "r-q", error: LOST_QUEUED_ERROR });
  });

  test("M2: the active and queued runs of state are left to recovery, ended runs are not touched", async () => {
    priorLog(
      { type: "run.started", runId: "r-done", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-done", nativeThreadId: "thread-1", usage: null, costUsd: null },
      { type: "run.started", runId: "r-old", origin: "user", nativeThreadId: null, model: null },
      { type: "run.queued", runId: "r-q", text: "next", attachments: [] },
    );
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", activeRunId: "r-old", queue: [{ runId: "r-q", text: "next", attachments: [] }] }));
    const f = fakeHarness();
    await start(f);
    const ends = events().slice(4).filter((e) => e.type === "run.interrupted" || e.type === "run.failed");
    expect(ends).toEqual([{ type: "run.interrupted", runId: "r-old" }]);
    expect(f.turns.map((t) => t.text)).toEqual([CONTINUATION_TEXT, "next"]);
  });

  test("T2: an empty state.json is rebuilt from the log: the thread resumes, the run continues, the queue runs, and it is said", async () => {
    priorLog(
      { type: "thread.native", harness: "claude", nativeThreadId: "thread-7", account: null, model: "m7" },
      { type: "run.started", runId: "r-a", origin: "user", nativeThreadId: null, model: null },
      { type: "run.queued", runId: "r-q", text: "next", attachments: [] },
    );
    writeFileSync(join(dir, "state.json"), "");
    const logged: string[] = [];
    const f = fakeHarness();
    await start(f, { logError: (m) => logged.push(m) });
    expect(f.opens[0]).toMatchObject({ resume: "thread-7", target: { harness: "claude" } });
    const started = events().find((e, i) => i >= 3 && e.type === "bridge.started") as Extract<BridgeEvent, { type: "bridge.started" }>;
    expect(started.resumed).toBe(true);
    expect(started.notice).toContain("state.json was unusable (the file is empty)");
    expect(started.notice).toContain("resumes thread thread-7");
    expect(logged).toContainEqual(expect.stringContaining("state.json was unusable (the file is empty)"));
    expect(readdirSync(dir)).toContain(`state.json.corrupt-${NOW}`);
    expect(events().filter((e) => e.type === "run.interrupted")).toEqual([{ type: "run.interrupted", runId: "r-a" }]);
    expect(f.turns.map((t) => [t.runId, t.text])).toEqual([[expect.any(String), CONTINUATION_TEXT], ["r-q", "next"]]);
    expect(state()).toMatchObject({ harness: "claude", nativeThreadId: "thread-7", awaitingTarget: false });
  });

  test("T2: a corrupt state.json of a thread on another harness waits for devd's target, also across a restart", async () => {
    codexAccount(ACCT);
    priorLog({ type: "thread.native", harness: "codex", nativeThreadId: "thread-c", account: ACCT, model: "gpt" });
    writeFileSync(join(dir, "state.json"), "{not json");
    const f = fakeHarness();
    const bridge = await start(f);
    expect(f.opens).toEqual([]);
    expect(await handshake(0)).toMatchObject({ awaitingTarget: true });
    expect(state()).toMatchObject({ harness: "codex", nativeThreadId: "thread-c", awaitingTarget: true });
    await bridge.close();

    const g = fakeHarness();
    await start(g);
    expect(g.opens).toEqual([]);
    expect(await handshake(0)).toMatchObject({ awaitingTarget: true });
    await switchCmd({ harness: "codex", account: ACCT, model: "gpt", env: {} }, "thread-c");
    expect(g.opens[0]).toMatchObject({ resume: "thread-c", target: { harness: "codex", account: ACCT } });
    expect(state()).toMatchObject({ awaitingTarget: false });
    expect(await handshake(0)).toMatchObject({ awaitingTarget: false });
  });

  test("T2: a corrupt state.json of a thread on another account waits for devd's target instead of resuming under this home", async () => {
    priorLog({ type: "thread.native", harness: "claude", nativeThreadId: "thread-a", account: "acct-a", model: "m" });
    writeFileSync(join(dir, "state.json"), "");
    const f = fakeHarness();
    await start(f, { account: "acct-b" });
    expect(f.opens).toEqual([]);
    expect(await handshake(0)).toMatchObject({ awaitingTarget: true });
    expect(state()).toMatchObject({ harness: "claude", nativeThreadId: "thread-a", awaitingTarget: true });
    const started = events()[1] as Extract<BridgeEvent, { type: "bridge.started" }>;
    expect(started.notice).toContain("account acct-a");
  });

  test("T2: a malformed state.json with no thread in the log starts fresh and says so", async () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ harness: "claude", queue: "x" }));
    const f = fakeHarness();
    await start(f);
    expect(f.opens[0].resume).toBeNull();
    const started = events()[0] as Extract<BridgeEvent, { type: "bridge.started" }>;
    expect(started).toMatchObject({ type: "bridge.started", resumed: false });
    expect(started.notice).toContain("no thread to resume");
  });

  /** A finished run, then (after start) an open one; returns the last seq. */
  async function finishedThenOpen(over: Parameters<typeof start>[1] = {}): Promise<number> {
    priorLog(
      { type: "thread.native", harness: "claude", nativeThreadId: "thread-1", account: null, model: "m" },
      { type: "run.started", runId: "r-done", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-done", nativeThreadId: "thread-1", usage: null, costUsd: null },
    );
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1" }));
    await start(fakeHarness(), { logCompactMinBytes: 0, ...over });
    await cmd({ kind: "startTurn", text: "open run" });
    return new EventLog(logPath()).lastSeq();
  }
  const keptSeqs = () => new EventLog(logPath()).readFrom(0).map((e) => e.seq);

  test("S6-R19: the current hello's ack is never trimmed to; it becomes a candidate, persisted with its time", async () => {
    const last = await finishedThenOpen();
    await handshake(last - 1);
    expect(state()).toMatchObject({ trimSeq: 0, ackCandidate: { seq: last - 1, at: NOW } });
    expect(keptSeqs()).toEqual(Array.from({ length: last }, (_, i) => i + 1));
  });

  test("S6-R19: an ack at least 10 minutes old is trimmed to on a later hello, the newer one waits", async () => {
    let clock = NOW;
    const last = await finishedThenOpen({ now: () => clock });
    await handshake(3);
    clock += 10 * MIN;
    await handshake(last);
    expect(state()).toMatchObject({ trimSeq: 3, ackCandidate: { seq: last, at: clock } });
    // seq 1 (latest thread.native) is kept, 2-3 (the finished run) dropped, everything after the old ack kept.
    expect(keptSeqs()).toEqual([1, ...Array.from({ length: last - 3 }, (_, i) => i + 4)]);
  });

  test("S6-R19: power loss - devd comes back with a lower afterSeq than its latest ack: nothing it needs was trimmed", async () => {
    let clock = NOW;
    const last = await finishedThenOpen({ now: () => clock });
    // devd acknowledged everything, then lost its unsynced tail and reconnects 11 minutes later from seq 2.
    await handshake(last);
    clock += 11 * MIN;
    await handshake(2);
    expect(state()).toMatchObject({ trimSeq: 0, ackCandidate: { seq: 2, at: clock } });
    expect(keptSeqs().filter((s) => s > 2)).toEqual(Array.from({ length: last - 2 }, (_, i) => i + 3));
    // Even once the lower ack is old enough, the trim stops at it.
    clock += 10 * MIN;
    await handshake(last);
    expect(state().trimSeq).toBe(2);
    expect(keptSeqs().filter((s) => s > 2)).toEqual(Array.from({ length: last - 2 }, (_, i) => i + 3));
  });

  test("the periodic sweep promotes an ack once a later hello confirmed it and it is 10 minutes old", async () => {
    let clock = NOW;
    const last = await finishedThenOpen({ now: () => clock, sweepMs: 5 });
    await handshake(3);
    clock += 10 * MIN;
    await new Promise((r) => setTimeout(r, 30));
    // Old enough, but not confirmed by a later ack in this process: not trimmed to.
    expect(state()).toMatchObject({ trimSeq: 0, ackCandidate: { seq: 3 } });
    clock -= 5 * MIN;
    await handshake(last);
    clock += 5 * MIN;
    await new Promise((r) => setTimeout(r, 30));
    expect(state()).toMatchObject({ trimSeq: 3, ackCandidate: null });
    expect(keptSeqs()).toEqual([1, ...Array.from({ length: last - 3 }, (_, i) => i + 4)]);
  });

  test("power loss with a long downtime: a persisted old candidate is never trimmed to before devd confirms it", async () => {
    priorLog(
      { type: "run.started", runId: "r-1", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-1", nativeThreadId: "thread-1", usage: null, costUsd: null },
      { type: "run.started", runId: "r-2", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-2", nativeThreadId: "thread-1", usage: null, costUsd: null },
    );
    // Acknowledged through 4 just before the power loss; the host was down for an hour.
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", ackCandidate: { seq: 4, at: NOW - 60 * MIN } }));
    await start(fakeHarness(), { logCompactMinBytes: 0, sweepMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(state().trimSeq).toBe(0);
    expect(keptSeqs().slice(0, 4)).toEqual([1, 2, 3, 4]);
    // devd's store came back at 2: everything after it is still there to replay.
    await handshake(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(state()).toMatchObject({ trimSeq: 0, ackCandidate: { seq: 2 } });
    expect(keptSeqs().slice(0, 4)).toEqual([1, 2, 3, 4]);
  });

  test("S6-R21: periodic acks on one long-lived connection trim it one ack behind, like hellos", async () => {
    let clock = NOW;
    const last = await finishedThenOpen({ now: () => clock });
    const link = await liveLink(3);
    // devd's first periodic ack 10 minutes later: the hello's ack is promoted, this one waits.
    clock += 10 * MIN;
    await link.ack(last);
    expect(state()).toMatchObject({ trimSeq: 3, ackCandidate: { seq: last, at: clock } });
    expect(keptSeqs()).toEqual([1, ...Array.from({ length: last - 3 }, (_, i) => i + 4)]);
    // An ack below the candidate (it cannot be, on a live link; a store that went back) replaces it, nothing is trimmed.
    clock += 10 * MIN;
    await link.ack(2);
    expect(state()).toMatchObject({ trimSeq: 3, ackCandidate: { seq: 2, at: clock } });
    link.close();
  });

  test("S6-R19: hellos in quick succession do not reset the candidate's age", async () => {
    let clock = NOW;
    const last = await finishedThenOpen({ now: () => clock });
    await handshake(3);
    clock += 5 * MIN;
    await handshake(last);
    expect(state().ackCandidate).toEqual({ seq: 3, at: NOW });
    clock += 5 * MIN;
    await handshake(last);
    expect(state()).toMatchObject({ trimSeq: 3, ackCandidate: { seq: last, at: clock } });
  });

  test("a start whose log trim fails logs it and runs on the untrimmed log", async () => {
    priorLog(
      { type: "run.started", runId: "r-1", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-1", nativeThreadId: "thread-1", usage: null, costUsd: null },
      { type: "background.changed", work: [] },
    );
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", trimSeq: 3 }));
    // The compaction's temp file cannot be created (a dangling symlink into a missing directory).
    symlinkSync(join(dir, "missing", "x"), join(dir, "events.jsonl.tmp"));
    const logged: string[] = [];
    const f = fakeHarness();
    await start(f, { logCompactMinBytes: 0, logError: (m) => logged.push(m) });
    expect(logged).toContainEqual(expect.stringContaining("trimming events.jsonl at start failed"));
    expect(events().slice(0, 3).map((e) => e.type)).toEqual(["run.started", "run.completed", "background.changed"]);
    expect(f.opens.length).toBe(1);
    expect(() => lstatSync(join(dir, "events.jsonl.tmp"))).toThrow("ENOENT");
  });

  test("a hello below the trim point (devd's store restored from a backup) is logged and said in the thread", async () => {
    priorLog(
      { type: "run.started", runId: "r-1", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-1", nativeThreadId: "thread-1", usage: null, costUsd: null },
    );
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", trimSeq: 2 }));
    const logged: string[] = [];
    await start(fakeHarness(), { logError: (m) => logged.push(m) });
    await handshake(0);
    const notice = { type: "bridge.notice" as const, text: expect.stringContaining("events 1-2") };
    expect(events()).toContainEqual(notice);
    expect(logged).toContainEqual(expect.stringContaining("events 1-2"));
    // Not again for a hello at or above it.
    await handshake(2);
    expect(events().filter((e) => e.type === "bridge.notice")).toHaveLength(1);
  });

  test("I8: the next start trims with the ack persisted earlier and never past it", async () => {
    priorLog(
      { type: "run.started", runId: "r-1", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-1", nativeThreadId: "thread-1", usage: null, costUsd: null },
      { type: "run.started", runId: "r-2", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-2", nativeThreadId: "thread-1", usage: null, costUsd: null },
    );
    saveState(join(dir, "state.json"), baseState({ nativeThreadId: "thread-1", trimSeq: 2 }));
    await start(fakeHarness(), { logCompactMinBytes: 0 });
    expect(events().slice(0, 2)).toEqual([
      { type: "run.started", runId: "r-2", origin: "user", nativeThreadId: null, model: null },
      { type: "run.completed", runId: "r-2", nativeThreadId: "thread-1", usage: null, costUsd: null },
    ]);
  });

  test("a log and state written by bridge 1.4 start unchanged", async () => {
    const fixture = join(import.meta.dir, "fixtures", "state", "state-1.4.json");
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    // The fixture's switched Codex target, as a Claude-launched container would hold it, with its secret dropped.
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...raw, activeRunId: null, queue: [] }));
    priorLog(
      { type: "bridge.started", version: "1.4.0", resumed: true },
      { type: "thread.native", harness: "codex", nativeThreadId: raw.nativeThreadId, account: "acct-1", model: "gpt-5" },
    );
    const f = fakeHarness();
    await start(f);
    expect(f.opens).toEqual([]);
    expect(events().slice(2)).toEqual([{ type: "bridge.started", version: BRIDGE_VERSION, resumed: true, awaitingTarget: true }, { type: "background.changed", work: [] }]);
    expect(state()).toMatchObject({ harness: "codex", nativeThreadId: raw.nativeThreadId, trimSeq: 0, ackCandidate: null, awaitingTarget: false, pendingHandoff: raw.pendingHandoff });
  });
});
