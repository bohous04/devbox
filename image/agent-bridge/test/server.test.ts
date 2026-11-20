import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventLog";
import type { BridgeEvent } from "../src/events";
import { encodeFrame, type ClientFrame, type ServerFrame } from "../src/protocol";
import { startServer, type CommandHandler } from "../src/server";
import { bridgeProof } from "../src/binding";

let dir: string;
let socketPath: string;
let logPath: string;
const closers: (() => unknown)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "server-"));
  socketPath = join(dir, "bridge.sock");
  logPath = join(dir, "events.jsonl");
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  rmSync(dir, { recursive: true, force: true });
});

const ev = (text: string): BridgeEvent => ({ type: "message.delta", runId: "r1", itemId: "i1", text });

interface TestClient {
  frames: ServerFrame[];
  closed: Promise<void>;
  send(f: ClientFrame | string | Uint8Array): void;
  waitFor(n: number): Promise<ServerFrame[]>;
}

async function connect(): Promise<TestClient> {
  const frames: ServerFrame[] = [];
  let buf = "";
  let notify: () => void = () => {};
  let onClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (onClosed = r));
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          frames.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
        notify();
      },
      close() {
        onClosed();
      },
    },
  });
  closers.push(() => socket.end());
  return {
    frames,
    closed,
    send: (f) => void socket.write(typeof f === "string" || f instanceof Uint8Array ? f : encodeFrame(f)),
    async waitFor(n) {
      const deadline = Date.now() + 3000;
      while (frames.length < n) {
        if (Date.now() > deadline) throw new Error(`timeout: got ${frames.length}/${n} frames`);
        await new Promise<void>((r) => {
          notify = r;
          setTimeout(r, 20);
        });
      }
      return frames;
    },
  };
}

let errors: string[] = [];
let acks: number[] = [];
let periodicAcks: number[] = [];
function start(onCommand: CommandHandler = async () => {}, log = new EventLog(logPath)) {
  errors = [];
  acks = [];
  periodicAcks = [];
  const server = startServer({ socketPath, log, onCommand, handshake: () => ({ version: "9.9.9", awaitingTarget: false }), onHello: (s) => acks.push(s), onAck: (s) => periodicAcks.push(s), logError: (m) => errors.push(m) });
  closers.push(() => server.close());
  return server;
}

const seqs = (fs: ServerFrame[]) => fs.map((f) => (f.t === "event" ? f.e.seq : f.t === "ready" ? `ready${f.lastSeq}` : f.t));

test("hello replays only events after afterSeq, then ready, then live events in order", async () => {
  const server = start();
  for (const t of ["a", "b", "c"]) server.publish(ev(t));
  const c = await connect();
  c.send({ t: "hello", afterSeq: 1 });
  expect(seqs(await c.waitFor(3))).toEqual([2, 3, "ready3"]);
  server.publish(ev("d"));
  expect(seqs(await c.waitFor(4))).toEqual([2, 3, "ready3", 4]);
});

test("every handshake's ready frame carries the bridge's version and whether it awaits a target", async () => {
  let awaitingTarget = true;
  const server = startServer({ socketPath, log: new EventLog(logPath), onCommand: async () => {}, handshake: () => ({ version: "1.2.3", awaitingTarget }) });
  closers.push(() => server.close());
  const a = await connect();
  a.send({ t: "hello", afterSeq: 0 });
  expect((await a.waitFor(1))[0]).toEqual({ t: "ready", lastSeq: 0, version: "1.2.3", awaitingTarget: true });
  awaitingTarget = false;
  const b = await connect();
  b.send({ t: "hello", afterSeq: 0 });
  expect((await b.waitFor(1))[0]).toEqual({ t: "ready", lastSeq: 0, version: "1.2.3", awaitingTarget: false });
});

test("a bound bridge answers a hello's nonce with its session and proof before the replay", async () => {
  const secret = "0f".repeat(32);
  const server = startServer({ socketPath, log: new EventLog(logPath), onCommand: async () => {}, handshake: () => ({ version: "1.6.0", awaitingTarget: false }), binding: { session: "dev-harbor-web", secret } });
  closers.push(() => server.close());
  server.publish(ev("a"));
  const c = await connect();
  const nonce = "ab".repeat(16);
  c.send({ t: "hello", afterSeq: 0, nonce });
  const [bind, event, ready] = await c.waitFor(3);
  // First, so devd applies nothing from a bridge that has not proven its session.
  expect(bind).toEqual({ t: "bind", session: "dev-harbor-web", proof: bridgeProof(secret, nonce, "dev-harbor-web") });
  expect(event.t).toBe("event");
  expect(ready.t).toBe("ready");
});

test("no bind frame for a hello without a nonce (an older devd) or on a bridge without a secret", async () => {
  const bound = startServer({ socketPath, log: new EventLog(logPath), onCommand: async () => {}, handshake: () => ({ version: "1.6.0", awaitingTarget: false }), binding: { session: "dev-harbor-web", secret: "0f".repeat(32) } });
  closers.push(() => bound.close());
  const a = await connect();
  a.send({ t: "hello", afterSeq: 0 });
  expect(seqs(await a.waitFor(1))).toEqual(["ready0"]);
  await bound.close();
  const unbound = start();
  const b = await connect();
  b.send({ t: "hello", afterSeq: 0, nonce: "ab".repeat(16) });
  expect(seqs(await b.waitFor(1))).toEqual(["ready0"]);
  void unbound;
});

test("a bound bridge drops a hello meant for another session: no ack of its afterSeq, no replay", async () => {
  const secret = "0f".repeat(32);
  const hellos: number[] = [];
  const errs: string[] = [];
  const server = startServer({ socketPath, log: new EventLog(logPath), onCommand: async () => {}, handshake: () => ({ version: "1.6.0", awaitingTarget: false }), binding: { session: "dev-harbor-web", secret }, onHello: (s) => hellos.push(s), logError: (m) => errs.push(m) });
  closers.push(() => server.close());
  server.publish(ev("a"));
  const c = await connect();
  const nonce = "ab".repeat(16);
  c.send({ t: "hello", afterSeq: 0, nonce, session: "dev-harbor-api" });
  await c.closed;
  // Only the bind, so devd can say whose bridge it reached.
  expect(c.frames).toEqual([{ t: "bind", session: "dev-harbor-web", proof: bridgeProof(secret, nonce, "dev-harbor-web") }]);
  expect(hellos).toEqual([]);
  expect(errs).toHaveLength(1);
  const ok = await connect();
  ok.send({ t: "hello", afterSeq: 0, nonce, session: "dev-harbor-web" });
  expect(seqs(await ok.waitFor(3))).toEqual(["bind", 1, "ready1"]);
  expect(hellos).toEqual([0]);
});

test("bridgeProof depends on the secret, the nonce and the session", () => {
  const s1 = "0f".repeat(32), s2 = "1f".repeat(32), n1 = "ab".repeat(16), n2 = "cd".repeat(16);
  const p = bridgeProof(s1, n1, "dev-harbor-web");
  expect(p).toMatch(/^[0-9a-f]{64}$/);
  expect(bridgeProof(s2, n1, "dev-harbor-web")).not.toBe(p);
  expect(bridgeProof(s1, n2, "dev-harbor-web")).not.toBe(p);
  expect(bridgeProof(s1, n1, "dev-harbor-api")).not.toBe(p);
});

test("an event published during replay is delivered once, after the replay", async () => {
  const log = new EventLog(logPath);
  log.append(ev("a"));
  const real = log.stream.bind(log);
  let server!: ReturnType<typeof start>;
  let injected = false;
  // Publishing from inside the replay read is the worst-case interleaving.
  log.stream = function* (after) {
    const it = real(after);
    for (const e of it) {
      if (!injected) {
        injected = true;
        server.publish(ev("during"));
      }
      yield e;
    }
  };
  server = start(undefined, log);
  const c = await connect();
  c.send({ t: "hello", afterSeq: 0 });
  await c.waitFor(3);
  await new Promise((r) => setTimeout(r, 100));
  expect(seqs(c.frames)).toEqual([1, 2, "ready2"]);
});

test("a command handler error is returned as res ok:false with the message", async () => {
  start(async (cmd) => {
    if (cmd.kind === "stop") throw new Error("boom");
  });
  const c = await connect();
  c.send({ t: "cmd", id: "1", cmd: { kind: "stop" } });
  c.send({ t: "cmd", id: "2", cmd: { kind: "interrupt" } });
  const fs = await c.waitFor(2);
  expect(fs).toEqual([
    { t: "res", id: "1", ok: false, error: "boom" },
    { t: "res", id: "2", ok: true },
  ]);
});

test("two clients each get every live event", async () => {
  const server = start();
  const a = await connect();
  const b = await connect();
  a.send({ t: "hello", afterSeq: 0 });
  b.send({ t: "hello", afterSeq: 0 });
  await a.waitFor(1);
  await b.waitFor(1);
  server.publish(ev("x"));
  server.publish(ev("y"));
  expect(seqs(await a.waitFor(3))).toEqual(["ready0", 1, 2]);
  expect(seqs(await b.waitFor(3))).toEqual(["ready0", 1, 2]);
});

test("a malformed line closes only that client", async () => {
  const server = start();
  const bad = await connect();
  const good = await connect();
  good.send({ t: "hello", afterSeq: 0 });
  await good.waitFor(1);
  bad.send("not json\n");
  await bad.closed;
  expect(errors).toEqual(["agent-bridge: closing client: frame is not valid JSON"]);
  server.publish(ev("x"));
  expect(seqs(await good.waitFor(2))).toEqual(["ready0", 1]);
});

test("replay after a torn last log line skips it", async () => {
  const first = new EventLog(logPath);
  first.append(ev("a"));
  appendFileSync(logPath, '{"seq":2,"ts":1,"event":{"type":"mess');
  const server = start();
  const c = await connect();
  c.send({ t: "hello", afterSeq: 0 });
  expect(seqs(await c.waitFor(2))).toEqual([1, "ready1"]);
  expect(server.publish(ev("b")).seq).toBe(2);
});

test("a second hello closes that client", async () => {
  start();
  const c = await connect();
  c.send({ t: "hello", afterSeq: 0 });
  await c.waitFor(1);
  c.send({ t: "hello", afterSeq: 0 });
  await c.closed;
  expect(errors).toEqual(["agent-bridge: closing client: duplicate hello"]);
});

test("multibyte text split across socket writes reaches the handler intact", async () => {
  const text = "Příliš žluťoučký kůň 🐎";
  const got: string[] = [];
  start(async (cmd) => {
    if (cmd.kind === "startTurn") got.push(cmd.text);
  });
  const c = await connect();
  const bytes = Buffer.from(encodeFrame({ t: "cmd", id: "1", cmd: { kind: "startTurn", text } }));
  // Cut inside the 4-byte horse emoji.
  const cut = bytes.indexOf(Buffer.from("🐎")) + 2;
  c.send(bytes.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 50));
  c.send(bytes.subarray(cut));
  await c.waitFor(1);
  expect(got).toEqual([text]);
});

test("a large replay completes in order", async () => {
  const log = new EventLog(logPath);
  const N = 20000;
  for (let i = 0; i < N; i++) log.append(ev("x".repeat(100)));
  start(undefined, log);
  const c = await connect();
  c.send({ t: "hello", afterSeq: 0 });
  await c.waitFor(N + 1);
  const s = seqs(c.frames);
  expect(s.slice(0, N)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect(s[N]).toBe(`ready${N}`);
});

test("a hello reports devd's acknowledged seq before its replay; a command sent with it is answered after ready", async () => {
  const server = start();
  for (const t of ["a", "b", "c"]) server.publish(ev(t));
  const c = await connect();
  c.send({ t: "hello", afterSeq: 2 });
  c.send({ t: "cmd", id: "1", cmd: { kind: "interrupt" } });
  expect(seqs(await c.waitFor(3))).toEqual([3, "ready3", "res"]);
  expect(acks).toEqual([2]);
});

test("a replay larger than the socket buffer waits for drain and arrives whole, followed by live events", async () => {
  const log = new EventLog(logPath);
  const N = 3000;
  for (let i = 0; i < N; i++) log.append(ev("y".repeat(10_000)));
  const server = start(undefined, log);
  const c = await connect();
  c.send({ t: "hello", afterSeq: 0 });
  await c.waitFor(1);
  // Published while the replay is under way: it waits in pending and follows the replay.
  server.publish(ev("live"));
  await c.waitFor(N + 2);
  const s = seqs(c.frames);
  expect(s.slice(0, N)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect(s.slice(N)).toEqual([N + 1, `ready${N + 1}`]);
});

test("S6-R21: an ack on a live connection reports devd's durable seq and keeps the connection", async () => {
  const server = start();
  server.publish(ev("a"));
  const c = await connect();
  c.send({ t: "hello", afterSeq: 0 });
  await c.waitFor(2);
  c.send({ t: "ack", seq: 1 });
  c.send({ t: "cmd", id: "1", cmd: { kind: "interrupt" } });
  await c.waitFor(3);
  server.publish(ev("b"));
  expect(seqs(await c.waitFor(4))).toEqual([1, "ready1", "res", 2]);
  expect(acks).toEqual([0]);
  expect(periodicAcks).toEqual([1]);
  expect(errors).toEqual([]);
});

test("S6-R21: an ack before the hello closes that client", async () => {
  start();
  const c = await connect();
  c.send({ t: "ack", seq: 1 });
  await c.closed;
  expect(periodicAcks).toEqual([]);
  expect(errors).toEqual(["agent-bridge: closing client: ack before hello"]);
});
