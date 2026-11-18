import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventLog";
import type { BridgeEvent } from "../src/events";
import { encodeFrame, type ClientFrame, type ServerFrame } from "../src/protocol";
import { startServer, type CommandHandler } from "../src/server";

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
  send(f: ClientFrame | string): void;
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
    send: (f) => void socket.write(typeof f === "string" ? f : encodeFrame(f)),
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

function start(onCommand: CommandHandler = async () => {}, log = new EventLog(logPath)) {
  const server = startServer({ socketPath, log, onCommand });
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

test("an event published during replay is delivered once, after the replay", async () => {
  const log = new EventLog(logPath);
  log.append(ev("a"));
  const real = log.readFrom.bind(log);
  let server!: ReturnType<typeof start>;
  let injected = false;
  // Publishing from inside the replay read is the worst-case interleaving.
  log.readFrom = (after) => {
    if (!injected) {
      injected = true;
      server.publish(ev("during"));
    }
    return real(after);
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
