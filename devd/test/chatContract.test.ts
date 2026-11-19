import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type Bridge, type HarnessOpenOptions } from "../../image/agent-bridge/src/serve";
import { CLAUDE_CAPABILITIES, ResumeFailedError, type HarnessSession } from "../../image/agent-bridge/src/claudeSession";
import type { BridgeEvent } from "../../image/agent-bridge/src/events";
import type { SwitchTarget } from "../../image/agent-bridge/src/protocol";
import { applyThreadEvent, emptyThread } from "../../dashboard/src/threadView";
import type { ThreadSnapshot } from "../../shared/thread";
import { BridgeLinks, type BridgeHandshake } from "../src/bridgeLink";
import { ChatSwitch } from "../src/chatSwitch";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";
import { insertSession, openDb } from "../src/db";
import { ThreadStore } from "../src/threadStore";

// The seam no per-package test crosses: the real bridge (`serve`, with a scripted harness) → its unix socket →
// devd's BridgeLinks → ThreadStore, and the same events through the dashboard's applyThreadEvent. The store's
// snapshot (what a reload shows) must equal the client's live copy.

const ID = "dev-a-b-1";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function waitFor(cond: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A harness the test drives: startTurn starts the run at once, answer resolves the request. */
function scriptedHarness() {
  const h = {
    emit: (_e: BridgeEvent) => {},
    runId: null as string | null,
    open(o: HarnessOpenOptions): HarnessSession {
      h.emit = o.emit;
      let end: (r: { error?: string }) => void = () => {};
      const ended = new Promise<{ error?: string }>((r) => (end = r));
      return {
        async startTurn(runId, _text, origin) {
          h.runId = runId;
          o.emit({ type: "run.started", runId, origin, nativeThreadId: "thread-1", model: "m" });
        },
        async interrupt() {},
        async answer(requestId, answer) {
          o.emit({ type: "request.resolved", requestId, answer, by: "user" });
        },
        async setModel() {},
        async injectItems() {},
        capabilities: () => CLAUDE_CAPABILITIES,
        async close() { end({}); },
        ready: Promise.resolve(),
        ended,
      };
    },
  };
  return h;
}

test("a normal exchange: devd's store and the dashboard's copy agree, user message included", async () => {
  const root = mkdtempSync(join(tmpdir(), "contract-"));
  const ctl = join(root, "ctl", ID);
  mkdirSync(ctl, { recursive: true });
  const h = scriptedHarness();
  const bridge: Bridge = await serve({
    bridgeDir: join(root, "bridge"), socketPath: join(ctl, "agent.sock"), harness: "claude", account: null, model: null,
    openHarness: (o) => h.open(o), resolveTarget: (t) => t, logError: () => {},
  });
  const store = ThreadStore.open(root, ID);
  let client: ThreadSnapshot = emptyThread();
  const links = new BridgeLinks({
    controlDir: () => ctl, store: () => store,
    onEvent: (_id, e) => { client = applyThreadEvent(client, e); },
    onStatus: () => {}, onBehind: () => {}, retryMs: 20, log: () => {},
  });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => bridge.close(), () => store.close(), () => links.drop(ID));

  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "link");
  h.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-1", account: null, model: "m" });
  await links.send(ID, { kind: "startTurn", text: "fix the failing test", attachments: ["/inbox/dev-a-b-1/shot.png"] });
  const runId = h.runId!;
  h.emit({ type: "message.delta", runId, itemId: "m1", text: "Look" });
  h.emit({ type: "message.delta", runId, itemId: "m1", text: "ing" });
  h.emit({ type: "message.final", runId, itemId: "m1", role: "assistant", text: "Looking at it." });
  h.emit({ type: "tool.started", runId, itemId: "t1", tool: "Bash", input: { command: "bun test" } });
  h.emit({ type: "tool.finished", runId, itemId: "t1", isError: false, output: "1 fail" });
  h.emit({ type: "request.opened", runId, requestId: "q1", kind: "question", prompt: "Fix the test or the code?", options: [{ label: "code" }, { label: "test" }], multiSelect: false });
  await waitFor(() => store.snapshot().pending.length === 1, "open request");
  await links.send(ID, { kind: "answer", requestId: "q1", answer: "code" });
  h.emit({ type: "message.final", runId, itemId: "m2", role: "assistant", text: "Fixed the code." });
  h.emit({ type: "run.completed", runId, nativeThreadId: "thread-1", usage: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0 }, costUsd: 0.01 });
  await waitFor(() => store.snapshot().runs[0]?.status === "completed" && client.lastSeq === store.lastSeq(), "completion");

  const stored = store.snapshot();
  expect(client.items).toEqual(stored.items);
  expect(client.runs).toEqual(stored.runs);
  expect(client.pending).toEqual(stored.pending);
  expect(client.background).toEqual(stored.background);
  expect(client.native).toEqual(stored.native);
  expect(stored.items.map((i) => [i.kind, i.text, i.status ?? null])).toEqual([
    ["user", "fix the failing test", "done"],
    ["assistant", "Looking at it.", "done"],
    ["tool", "", "done"],
    ["request", "Fix the test or the code?", "answered"],
    ["assistant", "Fixed the code.", "done"],
  ]);
  expect(stored.items[0]!.attachments).toEqual(["/inbox/dev-a-b-1/shot.png"]);
  expect(stored.runs).toEqual([expect.objectContaining({ runId, origin: "user", status: "completed", harness: "claude" })]);
});

/** A harness whose resume of `deadThread` fails, as Codex does for a thread outside the shared home. */
function resumeFailingHarness(deadThread: string) {
  const h = {
    opens: [] as (string | null)[],
    turns: [] as string[],
    open(o: HarnessOpenOptions): HarnessSession {
      h.opens.push(o.resume);
      let end: (r: { error?: string }) => void = () => {};
      const ended = new Promise<{ error?: string }>((r) => (end = r));
      const dead = o.resume === deadThread;
      const ready = dead ? Promise.reject(new ResumeFailedError(`thread/resume ${deadThread} failed`)) : Promise.resolve();
      ready.catch(() => {});
      if (dead) end({ error: "resume failed" });
      return {
        async startTurn(runId, text, origin) {
          h.turns.push(text);
          o.emit({ type: "run.started", runId, origin, nativeThreadId: null, model: null });
          o.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-fresh", account: null, model: "claude-opus-5-5", caps: CLAUDE_CAPABILITIES });
          o.emit({ type: "run.completed", runId, nativeThreadId: "thread-fresh", usage: null, costUsd: null });
        },
        async interrupt() {},
        async answer() {},
        async setModel() {},
        async injectItems() {},
        capabilities: () => CLAUDE_CAPABILITIES,
        async close() { end({}); },
        ready,
        ended,
      };
    },
  };
  return h;
}

test("C1 end to end: a thread the restarted bridge cannot resume becomes a fresh thread with the conversation handed over", async () => {
  const root = mkdtempSync(join(tmpdir(), "contract-"));
  const ctl = join(root, "ctl", ID);
  mkdirSync(ctl, { recursive: true });
  const bridgeDir = join(root, "bridge");
  const db = openDb(":memory:");
  insertSession(db, {
    id: ID, folder: "acme", project: "a", repo: "b", container: ID, port_base: 40100, status: "running", solo: 0,
    created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat",
  });
  const store = ThreadStore.open(root, ID);
  const handshakes: BridgeHandshake[] = [];
  let sw!: ChatSwitch;
  const links = new BridgeLinks({
    controlDir: () => ctl, store: () => store,
    onEvent: (id, e) => sw.onEvent(id, e),
    onStatus: () => {}, onBehind: () => {},
    onHandshake: (id, h) => { handshakes.push(h); sw.onHandshake(id, h); },
    retryMs: 20, log: () => {},
  });
  sw = new ChatSwitch({
    db, links, threads: () => store, claudePool: () => ACCOUNT_POOL_DEFAULTS,
    codexAccounts: { list: () => ({ accounts: [] }), select: () => { throw new Error("no Codex here"); } },
    proxyInputs: async () => { throw new Error("no proxy here"); },
    now: () => Date.now(), log: () => {}, resendDelaysMs: [20],
  });
  const opts = { bridgeDir, socketPath: join(ctl, "agent.sock"), harness: "claude" as const, account: null, model: null, resolveTarget: (t: SwitchTarget) => t, logError: () => {} };
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => links.drop(ID), () => sw.drop(ID));

  // The first bridge has a conversation on thread-1.
  const first = scriptedHarness();
  const b1: Bridge = await serve({ ...opts, openHarness: (o) => first.open(o) });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "link");
  first.emit({ type: "thread.native", harness: "claude", nativeThreadId: "thread-1", account: null, model: "claude-opus-5-5", caps: CLAUDE_CAPABILITIES });
  await links.send(ID, { kind: "startTurn", text: "remember the number 42" });
  first.emit({ type: "message.final", runId: first.runId!, itemId: "m1", role: "assistant", text: "Noted: 42." });
  first.emit({ type: "run.completed", runId: first.runId!, nativeThreadId: "thread-1", usage: null, costUsd: null });
  await waitFor(() => store.snapshot().runs[0]?.status === "completed", "first run");
  await b1.close();

  // The restarted bridge cannot resume thread-1: it stays up, devd re-plans and sends the fresh target with the handoff.
  const second = resumeFailingHarness("thread-1");
  const b2: Bridge = await serve({ ...opts, openHarness: (o) => second.open(o) });
  cleanups.push(() => b2.close());
  await waitFor(() => second.opens.length === 2, "the fresh thread devd asked for", 3000);
  expect(second.opens).toEqual(["thread-1", null]);
  expect(handshakes.at(-1)).toEqual({ version: expect.any(String), awaitingTarget: expect.any(Boolean) });
  expect(handshakes.every((h) => h.version !== null)).toBe(true);
  expect(store.providerThread("claude")).toMatchObject({ nativeThreadId: "thread-1", resumeFailed: true });

  await links.send(ID, { kind: "startTurn", text: "which number?" });
  await waitFor(() => second.turns.length === 1, "the handed-over turn");
  expect(second.turns[0]).toContain("[user] remember the number 42");
  expect(second.turns[0]).toContain("[assistant] Noted: 42.");
  expect(second.turns[0].endsWith("User message:\nwhich number?")).toBe(true);
  const notices = store.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text);
  expect(notices.filter((t) => t.includes("resume"))).toEqual(["Could not resume the earlier claude thread; started a fresh one · context handed over (2 items)"]);
  const status = await Promise.race([b2.closed, Bun.sleep(20).then(() => "open")]);
  expect(status).toBe("open");
});
