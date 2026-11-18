import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { AgentDisconnected, BridgeLinks, CommandFailed, CommandTimeout } from "../src/bridgeLink";
import { ThreadStore } from "../src/threadStore";
import type { LinkStatus, LoggedEvent } from "../../shared/thread";

const ID = "dev-a-b-1";
const RETRY = 20;

const ev = (seq: number): LoggedEvent => ({ seq, ts: 1000 + seq, event: { type: "message.delta", runId: "r1", itemId: `m${seq}`, text: `t${seq}` } });

type CmdReply = { ok: true } | { ok: false; error: string } | "never";

/** A unix socket server speaking the bridge's frame protocol, with knobs the real one has no need for. */
function fakeBridge(path: string, o: { events?: LoggedEvent[]; ignoreAfterSeq?: boolean } = {}) {
  const events = [...(o.events ?? [])];
  const hellos: number[] = [];
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
            for (const e of events) if (o.ignoreAfterSeq || e.seq > f.afterSeq) write(s, { t: "event", e });
            s.data.hello = true;
            write(s, { t: "ready", lastSeq: events.length ? events[events.length - 1].seq : 0 });
          } else if (f.t === "cmd") {
            cmds.push(f.cmd);
            if (reply !== "never") write(s, { t: "res", id: f.id, ...reply });
          }
        }
      },
      close(s) { clients.delete(s); },
    },
  });
  return {
    hellos, cmds,
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

function setup(prior: LoggedEvent[] = []) {
  const root = mkdtempSync(join(tmpdir(), "bl-"));
  mkdirSync(join(root, ID));
  const store = ThreadStore.open(root, ID);
  for (const e of prior) store.apply(e);
  const seen: LoggedEvent[] = [];
  const statuses: LinkStatus[] = [];
  const logs: string[] = [];
  const onEvent: (id: string, e: LoggedEvent) => void = (_id, e) => { seen.push(e); };
  const onStatus: (id: string, s: LinkStatus) => void = (_id, s) => { statuses.push(s); };
  const t = { onEvent, onStatus };
  const links = new BridgeLinks({
    controlDir: (id) => join(root, id),
    store: () => store,
    onEvent: (id, e) => t.onEvent(id, e),
    onStatus: (id, s) => t.onStatus(id, s),
    retryMs: RETRY,
    log: (m) => { logs.push(m); },
  });
  const sock = join(root, ID, "agent.sock");
  const servers: ReturnType<typeof fakeBridge>[] = [];
  const serve = (o?: Parameters<typeof fakeBridge>[1]) => { const s = fakeBridge(sock, o); servers.push(s); return s; };
  cleanups.push(() => { links.drop(ID); for (const s of servers) s.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { links, store, seen, statuses, logs, serve, t };
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
  const links = new BridgeLinks({ controlDir: (id) => join(root, id), store: () => store, onEvent: (_id, e) => { seen.push(e.seq); }, onStatus: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
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
  const links = new BridgeLinks({ controlDir: (id) => join(root, id), store, onEvent: () => {}, onStatus: () => {}, retryMs: RETRY, log: (m) => { logs.push(m); } });
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
