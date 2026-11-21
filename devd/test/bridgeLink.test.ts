import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { Database, type SQLiteError } from "bun:sqlite";
import { BRIDGE_VERSION } from "../../image/agent-bridge/src/version";
import { ACK_MIN_BRIDGE_VERSION } from "../../shared/bridgeVersion";
import { bridgeProof } from "../../image/agent-bridge/src/binding";
import { AgentDisconnected, BridgeLinks, legacyBridgeStartupLine, CommandFailed, CommandTimeout, FirstTurnPending, POISON_LIMIT, USER_FIRST_PROMPT_TAG } from "../src/bridgeLink";
import { ThreadStore } from "../src/threadStore";
import type { LinkStatus, LoggedEvent } from "../../shared/thread";

const ID = "dev-a-b-1";
const RETRY = 20;
const SECRET = "0f".repeat(32);
/** A session devd created before the binding, while the compat window is open. */
const FAR = Date.UTC(9999, 0, 1);
const LEGACY = { secret: () => null, legacyUntil: FAR, onRefused: () => {} };
const legacyLine = `bridge link ${ID}: legacy bridge without a session secret (its container predates the session binding): only the socket owner is checked, until 9999-01-01`;

const ev = (seq: number): LoggedEvent => ({ seq, ts: 1000 + seq, event: { type: "message.delta", runId: "r1", itemId: `m${seq}`, text: `t${seq}` } });

type CmdReply = { ok: true } | { ok: false; error: string } | "never";

/** A unix socket server speaking the bridge's frame protocol, with knobs the real one has no need for. */
function fakeBridge(path: string, o: { events?: LoggedEvent[]; ignoreAfterSeq?: boolean; ready?: Record<string, unknown>; binding?: { session: string; secret: string }; onHello?: string; replyFor?: (cmd: { kind: string }) => CmdReply | undefined } = {}) {
  const events = [...(o.events ?? [])];
  const hellos: number[] = [];
  const nonces: (string | undefined)[] = [];
  const sessions: (string | undefined)[] = [];
  const acks: number[] = [];
  const cmds: unknown[] = [];
  let reply: CmdReply = { ok: true };
  const clients = new Set<Socket<{ buf: string; hello: boolean }>>();
  const write = (s: Socket<{ buf: string; hello: boolean }>, f: unknown) => s.write(JSON.stringify(f) + "\n");
  const listener = Bun.listen<{ buf: string; hello: boolean }>({
    unix: path,
    socket: {
      open(s) { s.data = { buf: "", hello: false }; clients.add(s); },
      data(s, chunk) {
        s.data.buf += chunk.toString();
        let nl: number;
        while ((nl = s.data.buf.indexOf("\n")) >= 0) {
          const f = JSON.parse(s.data.buf.slice(0, nl));
          s.data.buf = s.data.buf.slice(nl + 1);
          if (f.t === "hello") {
            hellos.push(f.afterSeq);
            nonces.push(f.nonce);
            sessions.push(f.session);
            // "silent": no answer at all; any other string is written instead of the bridge's answer.
            if (o.onHello !== undefined) { if (o.onHello !== "silent") s.write(o.onHello); continue; }
            if (f.nonce !== undefined && o.binding) write(s, { t: "bind", session: o.binding.session, proof: bridgeProof(o.binding.secret, f.nonce, o.binding.session) });
            for (const e of events) if (o.ignoreAfterSeq || e.seq > f.afterSeq) write(s, { t: "event", e });
            s.data.hello = true;
            write(s, { t: "ready", lastSeq: events.length ? events[events.length - 1].seq : 0, version: BRIDGE_VERSION, ...o.ready });
          } else if (f.t === "ack") {
            acks.push(f.seq);
          } else if (f.t === "cmd") {
            cmds.push(f.cmd);
            const r = o.replyFor?.(f.cmd) ?? reply;
            if (r !== "never") write(s, { t: "res", id: f.id, ...r });
          }
        }
      },
      close(s) { clients.delete(s); },
    },
  });
  return {
    hellos, acks, cmds, nonces, sessions,
    setReply(r: CmdReply) { reply = r; },
    publish(e: LoggedEvent) { events.push(e); for (const c of clients) if (c.data.hello) write(c, { t: "event", e }); },
    raw(line: string) { for (const c of clients) c.write(line); },
    clients: () => clients.size,
    close() { listener.stop(true); for (const c of clients) c.end(); clients.clear(); rmSync(path, { force: true }); },
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function setup(prior: LoggedEvent[] = [], o: { ackMs?: number; secret?: string | null; legacyUntil?: number; now?: () => number; bindTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const store = ThreadStore.open(root, ID);
  for (const e of prior) store.apply(e);
  const seen: LoggedEvent[] = [];
  const statuses: LinkStatus[] = [];
  const logs: string[] = [];
  const onEvent: (id: string, e: LoggedEvent) => void = (_id, e) => { seen.push(e); };
  const onStatus: (id: string, s: LinkStatus) => void = (_id, s) => { statuses.push(s); };
  const onBehind: (id: string) => void = () => {};
  const t = { onEvent, onStatus, onBehind };
  const refusals: string[] = [];
  const binding = { secret: () => o.secret ?? null, legacyUntil: o.legacyUntil ?? FAR, onRefused: (_id: string, text: string) => { refusals.push(text); } };
  const links = new BridgeLinks({
    controlDir: (id) => join(root, id),
    store: () => store,
    binding,
    ...(o.now ? { now: o.now } : {}),
    ...(o.bindTimeoutMs ? { bindTimeoutMs: o.bindTimeoutMs } : {}),
    onEvent: (id, e) => t.onEvent(id, e),
    onStatus: (id, s) => t.onStatus(id, s),
    onBehind: (id) => t.onBehind(id),
    retryMs: RETRY,
    ...(o.ackMs === undefined ? {} : { ackMs: o.ackMs }),
    log: (m) => { logs.push(m); },
  });
  const sock = join(root, ID, "agent.sock");
  const servers: ReturnType<typeof fakeBridge>[] = [];
  const serve = (o?: Parameters<typeof fakeBridge>[1]) => { const s = fakeBridge(sock, o); servers.push(s); return s; };
  cleanups.push(() => { links.drop(ID); for (const s of servers) s.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { links, store, seen, statuses, logs, serve, t, root, refusals, binding };
}

test("reconnect replays only events after the stored seq", async () => {
  const { links, seen, serve } = setup([ev(1), ev(2)]);
  const a = serve({ events: [ev(1), ev(2), ev(3), ev(4)] });
  links.ensure(ID);
  await waitFor(() => seen.length === 2, "replay of 3 and 4");
  expect(a.hellos).toEqual([2]);
  expect(seen.map((e) => e.seq)).toEqual([3, 4]);
  a.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  const b = serve({ events: [ev(1), ev(2), ev(3), ev(4), ev(5)] });
  await waitFor(() => seen.length === 3, "replay of 5");
  expect(b.hellos).toEqual([4]);
  expect(seen.map((e) => e.seq)).toEqual([3, 4, 5]);
});

test("an event already stored does not fire onEvent again", async () => {
  const { links, seen, serve, store } = setup([ev(1), ev(2)]);
  serve({ events: [ev(1), ev(2), ev(3)], ignoreAfterSeq: true });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected" && seen.length === 1, "event 3");
  await Bun.sleep(30);
  expect(seen.map((e) => e.seq)).toEqual([3]);
  expect(store.lastSeq()).toBe(3);
});

test("events are stored before onEvent fires", async () => {
  const { links, store, seen, serve, t } = setup();
  const storedAtCallback: number[] = [];
  t.onEvent = (_id, e) => { storedAtCallback.push(store.lastSeq()); seen.push(e); };
  const s = serve({ events: [ev(1)] });
  links.ensure(ID);
  await waitFor(() => seen.length === 1, "replayed event");
  s.publish(ev(2));
  await waitFor(() => seen.length === 2, "live event");
  expect(storedAtCallback).toEqual([1, 2]);
  expect(store.snapshot().items.map((i) => i.text)).toEqual(["t1", "t2"]);
});

test("commands fail with agent-disconnected when no socket", async () => {
  const { links, logs } = setup();
  expect(links.send(ID, { kind: "interrupt" })).rejects.toBeInstanceOf(AgentDisconnected);
  links.ensure(ID);
  await Bun.sleep(RETRY * 5);
  expect(links.status(ID)).toBe("disconnected");
  expect(links.send(ID, { kind: "interrupt" })).rejects.toBeInstanceOf(AgentDisconnected);
  // Several retries happened, the outage is logged once.
  expect(logs.filter((l) => l.includes("disconnected"))).toHaveLength(1);
});

test("a command error comes back as CommandFailed with the bridge's message", async () => {
  const { links, serve } = setup();
  const s = serve();
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  await links.send(ID, { kind: "startTurn", text: "hi" });
  s.setReply({ ok: false, error: "restart refused: a run is active or queued" });
  const err = await links.send(ID, { kind: "restartAgent" }).catch((e) => e);
  expect(err).toBeInstanceOf(CommandFailed);
  expect(err.message).toBe("restart refused: a run is active or queued");
  expect(s.cmds).toEqual([{ kind: "startTurn", text: "hi" }, { kind: "restartAgent" }]);
});

test("a command without a reply times out", async () => {
  const { links, serve } = setup();
  const s = serve();
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  s.setReply("never");
  const err = await links.send(ID, { kind: "interrupt" }, 30).catch((e) => e);
  expect(err).toBeInstanceOf(CommandTimeout);
  expect(err).toBeInstanceOf(AgentDisconnected);
});

test("a command in flight fails with agent-disconnected when the connection closes", async () => {
  const { links, serve } = setup();
  const s = serve();
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  s.setReply("never");
  const p = links.send(ID, { kind: "interrupt" }).catch((e) => e);
  await waitFor(() => s.cmds.length === 1, "command received");
  s.close();
  const err = await p;
  expect(err).toBeInstanceOf(AgentDisconnected);
  expect(err).not.toBeInstanceOf(CommandTimeout);
});

test("status goes connected → disconnected → connected across a server restart", async () => {
  const { links, statuses, serve, logs } = setup();
  const a = serve();
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  a.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  await Bun.sleep(RETRY * 4);
  serve();
  await waitFor(() => links.status(ID) === "connected", "reconnect");
  expect(statuses.filter((s) => s !== "connecting")).toEqual(["connected", "disconnected", "connected"]);
  expect(logs.filter((l) => l.includes("disconnected"))).toHaveLength(1);
});

test("a malformed frame drops the connection, which reconnects with the stored seq", async () => {
  const { links, seen, serve, logs } = setup();
  const s = serve({ events: [ev(1)] });
  links.ensure(ID);
  await waitFor(() => seen.length === 1, "event 1");
  s.raw("{not json\n");
  await waitFor(() => s.hellos.length === 2, "reconnect");
  expect(s.hellos).toEqual([0, 1]);
  expect(logs.filter((l) => l.includes("malformed"))).toHaveLength(1);
  expect(seen.map((e) => e.seq)).toEqual([1]);
});

test("drop stops retrying and closes the socket", async () => {
  const { links, serve } = setup();
  const s = serve();
  links.ensure(ID);
  await waitFor(() => s.clients() === 1, "connect");
  links.drop(ID);
  await waitFor(() => s.clients() === 0, "socket closed");
  expect(links.status(ID)).toBe("disconnected");
  await Bun.sleep(RETRY * 4);
  expect(s.hellos).toEqual([0]);
  expect(links.send(ID, { kind: "interrupt" })).rejects.toBeInstanceOf(AgentDisconnected);
});

test("ensure is idempotent", async () => {
  const { links, serve } = setup();
  const s = serve();
  links.ensure(ID);
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  await Bun.sleep(RETRY * 2);
  expect(s.hellos).toEqual([0]);
});

test("a store write error drops the connection and the reconnect replays the event", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const real = ThreadStore.open(root, ID);
  let failures = 1;
  const store = {
    lastSeq: () => real.lastSeq(),
    apply: (e: LoggedEvent) => { if (failures-- > 0) throw new Error("disk full"); return real.apply(e); },
  } as unknown as ThreadStore;
  const seen: number[] = [];
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: (_id, e) => { seen.push(e.seq); }, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  const s = fakeBridge(join(root, ID, "agent.sock"), { events: [ev(1)] });
  cleanups.push(() => { links.drop(ID); s.close(); real.close(); rmSync(root, { recursive: true, force: true }); });
  links.ensure(ID);
  await waitFor(() => seen.length === 1, "event 1 after reconnect");
  expect(s.hellos).toEqual([0, 0]);
  expect(logs.some((l) => l.includes("disk full"))).toBe(true);
});

test("an unreadable store keeps the link disconnected and retrying, without crashing", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  let broken = true;
  const real = ThreadStore.open(root, ID);
  const store = () => { if (broken) throw new Error("session is ending"); return real; };
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  const s = fakeBridge(join(root, ID, "agent.sock"));
  cleanups.push(() => { links.drop(ID); s.close(); real.close(); rmSync(root, { recursive: true, force: true }); });
  links.ensure(ID);
  await Bun.sleep(RETRY * 4);
  expect(links.status(ID)).toBe("disconnected");
  expect(s.hellos).toEqual([]);
  expect(logs.filter((l) => l.includes("session is ending"))).toHaveLength(1);
  broken = false;
  await waitFor(() => links.status(ID) === "connected", "connect once the store opens");
});

test("a throwing onStatus is logged and the link keeps working", async () => {
  const { links, seen, logs, serve, t } = setup();
  t.onStatus = (_id, st) => { throw new Error(`store unreadable while ${st}`); };
  const s = serve({ events: [ev(1)] });
  links.ensure(ID);
  await waitFor(() => seen.length === 1, "replayed event");
  expect(links.status(ID)).toBe("connected");
  await links.send(ID, { kind: "interrupt" });
  s.publish(ev(2));
  await waitFor(() => seen.length === 2, "live event");
  expect(logs).toContain(`bridge link ${ID}: onStatus failed for connecting: store unreadable while connecting`);
  expect(logs).toContain(`bridge link ${ID}: onStatus failed for connected: store unreadable while connected`);
});

test("a bridge log behind the store is logged, shown as a notice and reported, until a ready catches up", async () => {
  const { links, store, logs, serve, t } = setup([ev(1), ev(2), ev(3), ev(4), ev(5)]);
  const behind: string[] = [];
  t.onBehind = (id) => { behind.push(id); };
  // The unsynced tail of events.jsonl was lost: the bridge restarts at seq 2.
  const a = serve({ events: [ev(1), ev(2)] });
  links.ensure(ID);
  await waitFor(() => links.behind(ID) !== null, "behind detected");
  expect(behind).toEqual([ID]);
  expect(logs.some((l) => l.includes("behind") && l.includes("bridge 2") && l.includes("devd 5"))).toBe(true);
  const notice = store.snapshot().items.filter((i) => i.kind === "notice");
  expect(notice.map((i) => i.text)).toEqual(["bridge log is behind devd's store (bridge 2, devd 5); new events may be missing"]);
  a.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  serve({ events: [ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)] });
  await waitFor(() => store.lastSeq() === 6 && links.behind(ID) === null, "caught up");
  expect(behind).toEqual([ID, ID]);
});

test("devd's first message waits for the connection and is sent once", async () => {
  const { links, serve } = setup();
  links.ensure(ID);
  links.startTurnWhenConnected(ID, "resolve the conflict");
  await waitFor(() => links.status(ID) === "disconnected", "no bridge yet");
  const b = serve();
  await waitFor(() => b.cmds.length === 1, "first turn sent");
  expect(b.cmds).toEqual([{ kind: "startTurn", text: "resolve the conflict" }]);
  b.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  const c = serve();
  await waitFor(() => links.status(ID) === "connected" && c.hellos.length === 1, "reconnect");
  await Bun.sleep(30);
  expect(c.cmds).toEqual([]);
});

test("devd's first message on a connected link goes out at once; a refused one is logged, not resent", async () => {
  const { links, serve, logs } = setup();
  const b = serve();
  b.setReply({ ok: false, error: "attachments are not supported yet" });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connected");
  links.startTurnWhenConnected(ID, "resolve the conflict");
  await waitFor(() => logs.some((l) => l.includes("first message") && l.includes("attachments are not supported yet")), "refusal logged");
  expect(b.cmds).toHaveLength(1);
});

type Saved = { text: string; seq: number; tag: string | null; effort: string | null };
function persistence() {
  const saved = new Map<string, Saved>();
  return { saved, pendingTurns: {
    save: (id: string, text: string, seq: number, tag: string | null, effort: string | null) => { saved.set(id, { text, seq, tag, effort }); },
    load: (id: string) => saved.get(id) ?? null,
    remove: (id: string) => { saved.delete(id); },
  } };
}
const started = (seq: number, runId: string): LoggedEvent => ({ seq, ts: seq, event: { type: "run.started", runId, origin: "user", nativeThreadId: null, model: null } });
const completed = (seq: number, runId: string): LoggedEvent => ({ seq, ts: seq, event: { type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null } });

/** One devd process over `root`: a fresh BridgeLinks and thread store, like after a restart. */
function devdOver(root: string, pendingTurns: ReturnType<typeof persistence>["pendingTurns"], extra: { onRestoredTurnDone?: (id: string, tag: string, err: Error | null) => void } = {}) {
  mkdirSync(join(root, ID), { recursive: true });
  const store = ThreadStore.open(root, ID);
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); }, pendingTurns, ...extra });
  cleanups.push(() => { links.drop(ID); store.close(); });
  return { links, store, logs, sock: join(root, ID, "agent.sock") };
}
function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("devd's first message is persisted, survives a restart and is deleted once the bridge answered", async () => {
  const { saved, pendingTurns } = persistence();
  const root = tmpRoot();
  devdOver(root, pendingTurns).links.startTurnWhenConnected(ID, "scheduled prompt");
  expect(saved.get(ID)).toMatchObject({ text: "scheduled prompt", seq: 0, effort: null });
  const second = devdOver(root, pendingTurns);
  const b = fakeBridge(second.sock);
  cleanups.push(() => b.close());
  second.links.ensure(ID);
  await waitFor(() => b.cmds.length === 1, "persisted first turn sent after the restart");
  expect(b.cmds).toEqual([{ kind: "startTurn", text: "scheduled prompt" }]);
  await waitFor(() => !saved.has(ID), "persisted row deleted after the bridge answered");
});

// A reused session has runs from earlier work: they must not make a not yet delivered first turn look delivered.
test("a reused thread with old runs still gets its persisted first turn after a restart", async () => {
  const { saved, pendingTurns } = persistence();
  const root = tmpRoot();
  const first = devdOver(root, pendingTurns);
  first.store.apply(started(1, "old")); first.store.apply(completed(2, "old"));
  first.links.startTurnWhenConnected(ID, "scheduled prompt");
  expect(saved.get(ID)!.seq).toBe(2);
  first.links.drop(ID); first.store.close();
  saved.set(ID, { text: "scheduled prompt", seq: 2, tag: null, effort: null }); // drop() discards the row, as a real crash would not
  const second = devdOver(root, pendingTurns);
  const b = fakeBridge(second.sock);
  cleanups.push(() => b.close());
  second.links.ensure(ID);
  await waitFor(() => b.cmds.length === 1, "first turn delivered into the reused thread");
});

test("a persisted first turn is dropped on ensure when a run started after it was saved", async () => {
  const { saved, pendingTurns } = persistence();
  const root = tmpRoot();
  const first = devdOver(root, pendingTurns);
  first.store.apply(started(1, "old")); first.store.apply(completed(2, "old"));
  first.store.apply(started(3, "new"));   // the bridge accepted the turn, devd died before deleting the row
  first.links.drop(ID); first.store.close();
  saved.set(ID, { text: "scheduled prompt", seq: 2, tag: null, effort: null });
  const second = devdOver(root, pendingTurns);
  const b = fakeBridge(second.sock);
  cleanups.push(() => b.close());
  second.links.ensure(ID);
  await waitFor(() => second.links.status(ID) === "connected", "connected");
  await Bun.sleep(30);
  expect(b.cmds).toEqual([]);
  expect(saved.has(ID)).toBe(false);
  expect(second.logs.some((l) => l.includes("already has a run"))).toBe(true);
});

test("a restored first turn reports its outcome with the saved tag", async () => {
  const { saved, pendingTurns } = persistence();
  const root = tmpRoot();
  saved.set(ID, { text: "scheduled prompt", seq: 0, tag: "Nightly bump", effort: null });
  const heard: [string, string, Error | null][] = [];
  const second = devdOver(root, pendingTurns, { onRestoredTurnDone: (id, tag, err) => { heard.push([id, tag, err]); } });
  const b = fakeBridge(second.sock);
  cleanups.push(() => b.close());
  second.links.ensure(ID);
  await waitFor(() => heard.length === 1, "outcome");
  expect(heard).toEqual([[ID, "Nightly bump", null]]);
});

test("a second first message is refused while one waits (memory or persisted): never replaced", () => {
  const { saved, pendingTurns } = persistence();
  const root = tmpRoot();
  const { links } = devdOver(root, pendingTurns);
  links.startTurnWhenConnected(ID, "the user's prompt", undefined, USER_FIRST_PROMPT_TAG);
  expect(() => links.startTurnWhenConnected(ID, "scheduled prompt", undefined, "Nightly bump")).toThrow(FirstTurnPending);
  expect(saved.get(ID)).toMatchObject({ text: "the user's prompt", tag: USER_FIRST_PROMPT_TAG });
  // After a restart only the DB row is left; it still counts.
  const second = devdOver(root, pendingTurns);
  expect(() => second.links.startTurnWhenConnected(ID, "scheduled prompt")).toThrow(FirstTurnPending);
});

test("dropping a link (the session is not running) discards a waiting first message and tells its caller", () => {
  const { saved, pendingTurns } = persistence();
  const { links } = devdOver(tmpRoot(), pendingTurns);
  const got: (Error | null)[] = [];
  // Queued for a session that is not running: no link yet, as linkOpenedChat does; syncBridgeLinks then drops it.
  links.startTurnWhenConnected(ID, "the user's prompt", (e) => got.push(e), USER_FIRST_PROMPT_TAG);
  links.drop(ID);
  expect(got).toHaveLength(1);
  expect(got[0]?.message).toContain("discarded");
  expect(saved.has(ID)).toBe(false);
});

test("startTurnWhenConnected reports the bridge's answer to onDone", async () => {
  const { links, serve } = setup();
  const b = serve();
  b.setReply({ ok: false, error: "refused" });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connected");
  const got: (Error | null)[] = [];
  links.startTurnWhenConnected(ID, "x", (e) => got.push(e));
  await waitFor(() => got.length === 1, "answer");
  expect(got[0]?.message).toContain("refused");
  b.setReply({ ok: true });
  links.startTurnWhenConnected(ID, "y", (e) => got.push(e));
  await waitFor(() => got.length === 2, "ok answer");
  expect(got[1]).toBeNull();
});

test("T9: an event that fails the same way on every replay is skipped after POISON_LIMIT tries, with a notice and one log line", async () => {
  const { links, seen, serve, logs, store } = setup();
  // A frame the store cannot take (a newer bridge's shape): message.final without text.
  const poison = { seq: 2, ts: 1002, event: { type: "message.final", runId: "r1", itemId: "m2", role: "assistant" } } as unknown as LoggedEvent;
  const s = serve({ events: [ev(1), poison, ev(3)] });
  links.ensure(ID);
  await waitFor(() => store.lastSeq() === 3, "skip past the poison frame");
  expect(s.hellos).toEqual(Array.from({ length: POISON_LIMIT }, (_, i) => (i === 0 ? 0 : 1)));
  expect(seen.map((e) => e.seq)).toEqual([1, 3]);
  const notices = store.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text);
  expect(notices).toEqual([`devd skipped event 2 from the agent bridge after ${POISON_LIMIT} failed attempts: cannot apply frame: NOT NULL constraint failed: items.text`]);
  // First cycle: disconnected + reconnected; the repeats say nothing; the skip says it once.
  expect(logs).toEqual([
    legacyLine,
    `bridge link ${ID}: disconnected (cannot apply frame: NOT NULL constraint failed: items.text); retrying every ${RETRY} ms`,
    `bridge link ${ID}: reconnected`,
    `bridge link ${ID}: skipped event 2 after ${POISON_LIMIT} failed attempts: cannot apply frame: NOT NULL constraint failed: items.text`,
  ]);
  await Bun.sleep(RETRY * 3);
  expect(s.hellos).toHaveLength(POISON_LIMIT);
});

test("T9: an event whose error message varies on every try is still skipped at POISON_LIMIT (keyed on error class + seq)", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const real = ThreadStore.open(root, ID);
  let tries = 0;
  const store = new Proxy(real, {
    get: (t, k) => k === "apply"
      ? (e: LoggedEvent) => { if (e.seq === 2) throw new Error(`cannot store event at ${Date.now()}.${++tries}`); return t.apply(e); }
      : (t as any)[k].bind(t),
  });
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  const s = fakeBridge(join(root, ID, "agent.sock"), { events: [ev(1), ev(2), ev(3)] });
  cleanups.push(() => { links.drop(ID); s.close(); real.close(); rmSync(root, { recursive: true, force: true }); });
  links.ensure(ID);
  await waitFor(() => real.lastSeq() === 3, "skip past the event");
  expect(tries).toBe(POISON_LIMIT);
  expect(s.hellos).toHaveLength(POISON_LIMIT);
  // The notice names the last attempt's message.
  expect(real.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text)[0]).toContain(`.${POISON_LIMIT}`);
});

test("T9: a store that cannot write at all is never skipped past: the event waits and the link keeps retrying", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const real = ThreadStore.open(root, ID);
  let full = true;
  // A real SQLITE_FULL (bun:sqlite constructs SQLiteErrors only itself): a database capped at two pages.
  const diskFull = () => {
    const scratch = new Database(":memory:");
    scratch.run("CREATE TABLE t (x)");
    scratch.run("PRAGMA max_page_count = 2");
    try { for (;;) scratch.run("INSERT INTO t VALUES (randomblob(1000))"); }
    catch (e) { return e as SQLiteError; }
    finally { scratch.close(); }
  };
  const store = new Proxy(real, {
    get: (t, k) => (k === "apply" || k === "skipEvent")
      ? (...a: unknown[]) => { if (full) throw diskFull(); return (t as any)[k](...a); }
      : (t as any)[k].bind(t),
  });
  const seen: number[] = [];
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: (_id, e) => { seen.push(e.seq); }, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  const s = fakeBridge(join(root, ID, "agent.sock"), { events: [ev(1)] });
  cleanups.push(() => { links.drop(ID); s.close(); real.close(); rmSync(root, { recursive: true, force: true }); });
  links.ensure(ID);
  await waitFor(() => s.hellos.length >= POISON_LIMIT + 2, "retries past the limit");
  expect(real.lastSeq()).toBe(0);
  full = false;
  await waitFor(() => seen.length === 1, "event 1 once the disk has room");
  expect(real.snapshot().items.filter((i) => i.kind === "notice")).toEqual([]);
  expect(logs.filter((l) => l.includes("disk is full"))).toEqual([
    `bridge link ${ID}: disconnected (cannot apply frame: database or disk is full); retrying every ${RETRY} ms`,
    `bridge link ${ID}: the thread store cannot take events (cannot apply frame: database or disk is full); retrying every ${RETRY} ms`,
  ]);
});

test("T9: a frame without a seq that keeps failing is said once in the thread; the link keeps retrying quietly", async () => {
  const { links, serve, logs, store } = setup([ev(1)]);
  const s = serve({ events: [ev(1)] });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  // Every connection gets the same unreadable line right after its replay.
  const raw = setInterval(() => s.raw("{not json\n"), 5);
  cleanups.push(() => clearInterval(raw));
  await waitFor(() => s.hellos.length >= POISON_LIMIT + 3, "repeated failures");
  const notices = store.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text);
  expect(notices).toEqual([`the agent bridge keeps sending a frame devd cannot read (malformed frame: not valid JSON); the link reconnects every ${RETRY} ms`]);
  expect(logs.filter((l) => l.includes("not valid JSON"))).toHaveLength(2);
});

test("M12: a bridge older than this devd's is said once per version in the thread, also across reconnects", async () => {
  const { links, serve, logs, store } = setup();
  const a = serve({ ready: { version: "1.4.0" } });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "connect");
  a.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  const b = serve({ ready: { version: "1.4.0" } });
  await waitFor(() => b.hellos.length === 1 && links.status(ID) === "connected", "reconnect");
  await Bun.sleep(RETRY);
  const text = `this session's agent bridge is 1.4.0, older than the current ${BRIDGE_VERSION}: it lacks the newer fixes until the session's container is recreated`;
  expect(store.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text)).toEqual([text]);
  expect(logs.filter((l) => l.includes("older than the current"))).toEqual([`bridge link ${ID}: ${text}`]);
  b.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  serve({ ready: { version: BRIDGE_VERSION } });
  await waitFor(() => links.status(ID) === "connected", "current bridge");
  await Bun.sleep(RETRY);
  expect(store.snapshot().items.filter((i) => i.kind === "notice")).toHaveLength(1);
});

test("S6-R21: a bridge from 1.5.0 gets a periodic ack with the store's durable seq; older bridges never get one", async () => {
  const { links, serve, store } = setup([ev(1), ev(2)], { ackMs: 15 });
  const a = serve({ events: [ev(1), ev(2), ev(3)], ready: { version: ACK_MIN_BRIDGE_VERSION } });
  links.ensure(ID);
  await waitFor(() => a.acks.length >= 2, "two acks");
  expect(a.acks.every((s) => s === 3)).toBe(true);
  a.publish(ev(4));
  await waitFor(() => a.acks.at(-1) === 4, "ack of the live event");
  expect(store.lastSeq()).toBe(4);
  a.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  const sent = a.acks.length;
  for (const version of ["1.4.0", undefined]) {
    const old = serve({ events: [ev(1), ev(2), ev(3), ev(4)], ready: { version } });
    await waitFor(() => links.status(ID) === "connected", "older bridge");
    await Bun.sleep(60);
    expect(old.acks).toEqual([]);
    expect(old.clients()).toBe(1);
    old.close();
    await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  }
  expect(a.acks).toHaveLength(sent);
});

test("S6-R21: no ack while the store cannot say what is durable; it is logged and the link carries on", async () => {
  const { links, serve, logs, root } = setup([ev(1)], { ackMs: 15 });
  // Another connection holds a read snapshot from before event 2: the checkpoint cannot copy event 2's commit.
  const reader = new Database(ThreadStore.path(root, ID));
  reader.run("BEGIN");
  reader.query("SELECT count(*) FROM items").get();
  const a = serve({ events: [ev(1), ev(2)], ready: { version: ACK_MIN_BRIDGE_VERSION } });
  links.ensure(ID);
  await waitFor(() => logs.some((l) => l.includes("no ack")), "the skipped ack logged");
  await Bun.sleep(100); // several more intervals without an ack
  expect(a.acks).toEqual([]);
  expect(links.status(ID)).toBe("connected");
  // Once per episode, like a bridge log that is behind.
  expect(logs.filter((l) => l.includes("no ack"))).toHaveLength(1);
  reader.run("COMMIT");
  reader.close();
  await waitFor(() => a.acks.length >= 1, "ack once the checkpoint completes");
  expect(a.acks[0]).toBe(2);
  expect(logs.filter((l) => l.includes("acks resumed"))).toEqual([`bridge link ${ID}: acks resumed (seq 2)`]);
});

test("agent.sock that is a symlink (to a host socket) or not a socket is never connected to", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const host = mkdtempSync(join(tmpdir(), "bl-host-"));
  // A socket elsewhere on the host the agent would like devd (root) to talk to.
  const elsewhere = fakeBridge(join(host, "host.sock"));
  symlinkSync(join(host, "host.sock"), join(root, ID, "agent.sock"));
  const store = ThreadStore.open(root, ID);
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  cleanups.push(() => { links.drop(ID); elsewhere.close(); store.close(); rmSync(root, { recursive: true, force: true }); rmSync(host, { recursive: true, force: true }); });
  links.ensure(ID);
  await waitFor(() => logs.some((l) => l.includes("not a socket owned by")), "refusal logged");
  await Bun.sleep(RETRY * 3);
  expect(elsewhere.hellos).toEqual([]);
  expect(elsewhere.clients()).toBe(0);
});

test("agent.sock that is a regular file is refused with a logged error", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  writeFileSync(join(root, ID, "agent.sock"), "x");
  const store = ThreadStore.open(root, ID);
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  cleanups.push(() => { links.drop(ID); store.close(); rmSync(root, { recursive: true, force: true }); });
  links.ensure(ID);
  await waitFor(() => logs.some((l) => l.includes("not a socket owned by")), "refusal of a regular file");
});

test("no agent.sock yet: devd does not connect, it waits for the next retry and connects once a real socket appears", async () => {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const store = ThreadStore.open(root, ID);
  const logs: string[] = [];
  const links = new BridgeLinks({ binding: LEGACY, controlDir: (id) => join(root, id), store: () => store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
  links.ensure(ID);
  await waitFor(() => logs.some((l) => l.includes("no socket yet")), "waiting logged");
  expect(logs.some((l) => l.includes("cannot connect"))).toBe(false);
  const s = fakeBridge(join(root, ID, "agent.sock"));
  cleanups.push(() => { links.drop(ID); s.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await waitFor(() => s.hellos.length === 1, "hello once the socket exists");
});

// DEVBOX-54: devd binds each link to its session. The bridge proves the session with an HMAC under the secret devd
// gave that session's container, before devd applies anything it sends.
const notices = (store: ThreadStore) => store.snapshot().items.filter((i) => i.kind === "notice").map((i) => i.text);

test("binding: a bridge proving this session's secret gets the link; the hello carries a fresh nonce", async () => {
  const { links, seen, serve } = setup([], { secret: SECRET });
  const b = serve({ events: [ev(1)], binding: { session: ID, secret: SECRET } });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected" && seen.length === 1, "bound link");
  await links.send(ID, { kind: "stop" });
  expect(b.cmds).toEqual([{ kind: "stop" }]);
  b.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  const c = serve({ binding: { session: ID, secret: SECRET } });
  await waitFor(() => links.status(ID) === "connected", "rebound");
  expect(b.nonces[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(c.nonces[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(c.nonces[0]).not.toBe(b.nonces[0]);
  // The hello names the session, so another session's bridge drops it before it acks or replays anything (I1).
  expect(c.sessions).toEqual([ID]);
});

for (const [what, binding, says] of [
  ["another session's bridge", { session: "dev-harbor-api", secret: SECRET }, "of another session (dev-harbor-api)"],
  ["a bridge naming a session id that is not one", { session: "x\nforged line " + "y".repeat(80), secret: SECRET }, "of another session:"],
  ["a bridge with another secret", { session: ID, secret: "1f".repeat(32) }, "does not match"],
  ["a bridge that sends no proof (older than the binding)", undefined, "did not prove"],
] as const) {
  test(`binding: ${what} is refused before anything it sends is applied, said once in the thread, the log and to the user`, async () => {
    const { links, store, seen, serve, logs, refusals } = setup([], { secret: SECRET });
    const b = serve({ events: [ev(1), ev(2)], binding });
    links.ensure(ID);
    await waitFor(() => b.hellos.length >= 3, "several refused attempts");
    expect(store.lastSeq()).toBe(0);
    expect(seen).toEqual([]);
    expect(links.status(ID)).not.toBe("connected");
    await expect(links.send(ID, { kind: "stop" })).rejects.toBeInstanceOf(AgentDisconnected);
    expect(b.cmds).toEqual([]);
    expect(notices(store)).toHaveLength(1);
    expect(notices(store)[0]).toContain(says);
    expect(refusals).toEqual(notices(store));
    expect(logs.filter((l) => l.includes("refused"))).toHaveLength(1);
  });
}

test("binding: a refusal episode ends once the right bridge answers; a new one is said again", async () => {
  const { links, store, serve, refusals, binding } = setup([], { secret: SECRET });
  const wrong = serve({ binding: { session: "dev-harbor-api", secret: SECRET } });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1, "first refusal");
  wrong.close();
  serve({ binding: { session: ID, secret: SECRET } });
  await waitFor(() => links.status(ID) === "connected", "bound");
  void binding;
  expect(notices(store)).toHaveLength(1);
});

test("legacy: a session without a secret connects on the owner check alone before the cutoff, logged once", async () => {
  const { links, seen, serve, logs, refusals } = setup([], { secret: null, legacyUntil: Date.now() + 86_400_000 });
  const a = serve({ events: [ev(1)] });
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected" && seen.length === 1, "legacy link");
  expect(a.nonces).toEqual([undefined]);
  a.close();
  await waitFor(() => links.status(ID) === "disconnected", "disconnect");
  serve();
  await waitFor(() => links.status(ID) === "connected", "legacy reconnect");
  expect(logs.filter((l) => l.includes("legacy bridge"))).toHaveLength(1);
  expect(refusals).toEqual([]);
});

test("legacy: after the cutoff devd does not connect; the thread and the user hear once which session and the fix", async () => {
  const { links, store, serve, refusals, logs } = setup([], { secret: null, legacyUntil: Date.now() - 1 });
  const a = serve({ events: [ev(1)] });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1, "refusal");
  await Bun.sleep(RETRY * 4);
  expect(a.hellos).toEqual([]);
  expect(store.lastSeq()).toBe(0);
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain(ID);
  expect(refusals[0]).toContain("end and reopen the session");
  expect(notices(store)).toEqual(refusals);
  expect(logs.filter((l) => l.includes("refused"))).toHaveLength(1);
});

test("legacy: a session recreated during the retries (a secret now stored) binds on the next attempt", async () => {
  let secret: string | null = null;
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const store = ThreadStore.open(root, ID);
  const links = new BridgeLinks({ binding: { secret: () => secret, legacyUntil: Date.now() - 1, onRefused: () => {} }, controlDir: (id) => join(root, id), store: () => store, onEvent: () => {}, onStatus: () => {}, onBehind: () => {}, retryMs: RETRY, log: () => {} });
  const b = fakeBridge(join(root, ID, "agent.sock"), { binding: { session: ID, secret: SECRET } });
  cleanups.push(() => { links.drop(ID); b.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  links.ensure(ID);
  await Bun.sleep(RETRY * 3);
  expect(b.hellos).toEqual([]);
  secret = SECRET;
  await waitFor(() => links.status(ID) === "connected", "bound after the secret appeared");
});

test("legacyBridgeStartupLine lists the sessions that still lack a secret with the cutoff date", () => {
  expect(legacyBridgeStartupLine([], Date.UTC(2026, 11, 4))).toBeNull();
  expect(legacyBridgeStartupLine(["dev-harbor-web", "dev-harbor-api"], Date.UTC(2026, 11, 4))).toBe(
    "bridge binding: 2 chat sessions predate it (no bridge secret) and are connected only until 2026-12-04; end and reopen them before then: dev-harbor-web, dev-harbor-api",
  );
});

test("binding: a session id from the bridge that is not one never reaches the log, the thread or the user", async () => {
  const { links, store, serve, logs, refusals } = setup([], { secret: SECRET });
  serve({ binding: { session: "x\nforged", secret: SECRET } });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1, "refusal");
  for (const t of [...logs, ...notices(store), ...refusals]) expect(t).not.toContain("forged");
});

test("binding: a malformed frame before the bind is a refusal, not a poison frame to count or skip", async () => {
  const { links, store, serve, refusals } = setup([], { secret: SECRET });
  const b = serve({ onHello: '{"t":"event","e":{"seq":1}}\n' });
  links.ensure(ID);
  await waitFor(() => b.hellos.length >= POISON_LIMIT + 1, "attempts past the poison limit");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain("did not prove");
  expect(notices(store)).toEqual(refusals);
  expect(store.lastSeq()).toBe(0);
});

test("binding: a bridge that never answers the hello is refused after the bind timeout, and devd retries", async () => {
  const { links, serve, refusals } = setup([], { secret: SECRET, bindTimeoutMs: 30 });
  const b = serve({ onHello: "silent" });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1 && b.hellos.length >= 2, "timeout refusal and a retry");
  expect(refusals[0]).toContain("did not prove its session within");
  expect(links.status(ID)).not.toBe("connected");
});

test("binding: the user is notified at most once per 30 minutes per session, even with accepted links between", async () => {
  let now = Date.UTC(2026, 10, 20);
  const { links, store, serve, refusals } = setup([], { secret: SECRET, now: () => now });
  let current = serve({ binding: { session: "dev-harbor-api", secret: SECRET } });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1, "first refusal");
  const flip = async (binding: { session: string; secret: string }, cond: () => boolean, what: string) => {
    current.close();
    current = serve({ binding });
    await waitFor(cond, what);
  };
  await flip({ session: ID, secret: SECRET }, () => links.status(ID) === "connected", "accepted");
  await flip({ session: "dev-harbor-api", secret: SECRET }, () => notices(store).length === 2, "second episode in the thread");
  expect(refusals).toHaveLength(1);
  now += 30 * 60_000;
  await flip({ session: ID, secret: SECRET }, () => links.status(ID) === "connected", "accepted again");
  await flip({ session: "dev-harbor-api", secret: SECRET }, () => refusals.length === 2, "notified again after 30 min");
});

test("binding: a forged frame type (with a newline) before the bind never reaches the log, the thread or the user", async () => {
  const { links, store, serve, logs, refusals } = setup([], { secret: SECRET });
  serve({ onHello: JSON.stringify({ t: "x\nforged line" }) + "\n" });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1, "refusal");
  expect(refusals[0]).toContain("its first frame was malformed");
  for (const t of [...logs, ...notices(store), ...refusals]) expect(t).not.toContain("forged");
});

test("a forged frame type on a live link is not repeated in the log or the thread either", async () => {
  const { links, store, serve, logs } = setup();
  const b = serve();
  links.ensure(ID);
  await waitFor(() => links.status(ID) === "connected", "link");
  b.raw(JSON.stringify({ t: "x\nforged line" }) + "\n");
  await waitFor(() => logs.some((l) => l.includes("unknown frame type")), "drop logged");
  for (const t of [...logs, ...notices(store)]) expect(t).not.toContain("forged");
});

test("binding: forget(id) after a session ended lets a session reusing the id be notified at once", async () => {
  const { links, serve, refusals } = setup([], { secret: SECRET });
  const b = serve({ binding: { session: "dev-harbor-api", secret: SECRET } });
  links.ensure(ID);
  await waitFor(() => refusals.length === 1, "first refusal");
  links.drop(ID);
  links.forget(ID);
  b.close();
  serve({ binding: { session: "dev-harbor-api", secret: SECRET } });
  links.ensure(ID);
  await waitFor(() => refusals.length === 2, "notified again for the new session");
});

// --- a first message with an effort (/new) ---

test("a first message with an effort sends setEffort, then the turn, once the handshake names a bridge that takes it", async () => {
  const { links, serve, store } = setup();
  links.ensure(ID);
  links.startTurnWhenConnected(ID, "fix it", undefined, null, "xhigh");
  const b = serve();
  await waitFor(() => b.cmds.length === 2, "effort and turn sent");
  expect(b.cmds).toEqual([{ kind: "setEffort", effort: "xhigh" }, { kind: "startTurn", text: "fix it" }]);
  expect(notices(store)).toEqual([]);
});

test("a first message's effort a bridge older than 1.7.0 cannot take: the message goes, the thread says why the effort did not", async () => {
  const { links, serve, store } = setup();
  links.ensure(ID);
  links.startTurnWhenConnected(ID, "fix it", undefined, null, "high");
  const b = serve({ ready: { version: "1.6.0" } });
  await waitFor(() => b.cmds.length === 1, "turn sent");
  expect(b.cmds).toEqual([{ kind: "startTurn", text: "fix it" }]);
  expect(notices(store)).toContainEqual("Effort high was not set: this session's agent bridge (1.6.0) cannot change the effort; it needs 1.7.0 — recreate the session's container");
});

test("a first message's effort the bridge refuses: the message still goes, with the refusal in the thread", async () => {
  const { links, serve, store } = setup();
  links.ensure(ID);
  links.startTurnWhenConnected(ID, "fix it", undefined, null, "max");
  const b = serve({ replyFor: (c) => (c.kind === "setEffort" ? { ok: false, error: "effort max is not one of low, high" } : undefined) });
  await waitFor(() => b.cmds.length === 2, "effort tried, turn sent");
  expect(b.cmds.at(-1)).toEqual({ kind: "startTurn", text: "fix it" });
  expect(notices(store)).toContainEqual("Effort max was not set: effort max is not one of low, high");
});

test("a first message cut off mid-effort waits for the next connection's handshake, not the last one's version", async () => {
  const { links, serve, store } = setup();
  links.ensure(ID);
  links.startTurnWhenConnected(ID, "fix it", undefined, null, "high");
  const first = serve({ replyFor: (c) => (c.kind === "setEffort" ? "never" : undefined) });
  await waitFor(() => first.cmds.length === 1, "effort sent to the first bridge");
  first.close();
  // The container came back with an older bridge: it must not get setEffort on the strength of the first's version.
  const second = serve({ ready: { version: "1.6.0" } });
  await waitFor(() => second.cmds.some((c) => (c as { kind: string }).kind === "startTurn"), "turn sent to the second bridge");
  expect(second.cmds).toEqual([{ kind: "startTurn", text: "fix it" }]);
  expect(notices(store)).toContainEqual("Effort high was not set: this session's agent bridge (1.6.0) cannot change the effort; it needs 1.7.0 — recreate the session's container");
});

test("a first message whose effort was refused, retried on the next connection, says the refusal once", async () => {
  const { links, serve, store } = setup();
  links.ensure(ID);
  links.startTurnWhenConnected(ID, "fix it", undefined, null, "max");
  const refuse = (c: { kind: string }): CmdReply | undefined => (c.kind === "setEffort" ? { ok: false, error: "effort max is not one of low, high" } : undefined);
  const first = serve({ replyFor: (c) => refuse(c) ?? "never" });
  await waitFor(() => first.cmds.length === 2, "effort refused, turn sent");
  first.close();
  const second = serve({ replyFor: refuse });
  await waitFor(() => second.cmds.some((c) => (c as { kind: string }).kind === "startTurn"), "turn sent again");
  expect(second.cmds).toEqual([{ kind: "startTurn", text: "fix it" }]);
  expect(notices(store).filter((n) => n.startsWith("Effort max was not set"))).toHaveLength(1);
});

test("a first message's effort survives a devd restart with it", async () => {
  const { saved, pendingTurns } = persistence();
  const root = tmpRoot();
  devdOver(root, pendingTurns).links.startTurnWhenConnected(ID, "scheduled prompt", undefined, USER_FIRST_PROMPT_TAG, "low");
  expect(saved.get(ID)).toMatchObject({ effort: "low" });
  const second = devdOver(root, pendingTurns);
  const b = fakeBridge(second.sock);
  cleanups.push(() => b.close());
  second.links.ensure(ID);
  await waitFor(() => b.cmds.length === 2, "effort and turn after the restart");
  expect(b.cmds).toEqual([{ kind: "setEffort", effort: "low" }, { kind: "startTurn", text: "scheduled prompt" }]);
});
