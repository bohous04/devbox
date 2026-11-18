import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type Bridge, type HarnessOpenOptions } from "../../image/agent-bridge/src/serve";
import { CLAUDE_CAPABILITIES, type HarnessSession } from "../../image/agent-bridge/src/claudeSession";
import type { BridgeEvent } from "../../image/agent-bridge/src/events";
import { applyThreadEvent, emptyThread } from "../../dashboard/src/threadView";
import type { ThreadSnapshot } from "../../shared/thread";
import { BridgeLinks } from "../src/bridgeLink";
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
  await links.send(ID, { kind: "startTurn", text: "fix the failing test" });
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
  expect(stored.runs).toEqual([expect.objectContaining({ runId, origin: "user", status: "completed", harness: "claude" })]);
});
