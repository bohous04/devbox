import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventLog";
import type { BridgeEvent } from "../src/events";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eventlog-"));
  path = join(dir, "events.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (text: string): BridgeEvent => ({ type: "message.delta", runId: "r1", itemId: "i1", text });

test("append assigns increasing seq starting at 1", () => {
  const log = new EventLog(path);
  expect([ev("a"), ev("b"), ev("c")].map((e) => log.append(e).seq)).toEqual([1, 2, 3]);
});

test("readFrom returns only newer events", () => {
  const log = new EventLog(path);
  for (const t of ["a", "b", "c"]) log.append(ev(t));
  expect(log.readFrom(1).map((e) => e.seq)).toEqual([2, 3]);
});

test("reopening continues the sequence", () => {
  const first = new EventLog(path);
  for (const t of ["a", "b", "c"]) first.append(ev(t));
  expect(new EventLog(path).append(ev("d")).seq).toBe(4);
});

test("a torn last line is ignored", () => {
  const first = new EventLog(path);
  first.append(ev("a"));
  first.append(ev("b"));
  appendFileSync(path, '{"seq":3,"ts":1,"event":{"type":"mess');
  const log = new EventLog(path);
  expect(log.readFrom(0).map((e) => e.seq)).toEqual([1, 2]);
  expect(log.append(ev("c")).seq).toBe(3);
  expect(log.readFrom(0).map((e) => e.seq)).toEqual([1, 2, 3]);
});

const L = (seq: number, event: BridgeEvent) => JSON.stringify({ seq, ts: 1000 + seq, event });

/** A log as bridge 1.4 writes it: one finished run, an open run with an open request, a resolved request. */
function writeLog14(): void {
  writeFileSync(path, [
    L(1, { type: "bridge.started", version: "1.4.0", resumed: false }),
    L(2, { type: "background.changed", work: [] }),
    L(3, { type: "thread.native", harness: "claude", nativeThreadId: "t-old", account: null, model: "m" }),
    L(4, { type: "run.started", runId: "done", origin: "user", nativeThreadId: null, model: null }),
    L(5, { type: "message.delta", runId: "done", itemId: "a", text: "x" }),
    L(6, { type: "request.opened", runId: "done", requestId: "q-done", kind: "question", prompt: "?" }),
    L(7, { type: "request.resolved", requestId: "q-done", answer: "y", by: "user" }),
    L(8, { type: "run.completed", runId: "done", nativeThreadId: "t-old", usage: null, costUsd: null }),
    L(9, { type: "thread.native", harness: "claude", nativeThreadId: "t-new", account: null, model: "m2" }),
    L(10, { type: "run.queued", runId: "open", text: "hi", attachments: ["/inbox/s/a.png"] }),
    L(11, { type: "run.started", runId: "open", origin: "user", nativeThreadId: null, model: null }),
    L(12, { type: "request.opened", runId: "open", requestId: "q-open", kind: "plan", prompt: "plan?" }),
    L(13, { type: "message.final", runId: "open", itemId: "b", role: "assistant", text: "y" }),
    L(14, { type: "background.changed", work: [] }),
  ].join("\n") + "\n");
}

test("a log written by bridge 1.4 opens: last seq from the tail, open runs and requests from a scan", () => {
  writeLog14();
  const log = new EventLog(path);
  expect(log.lastSeq()).toBe(14);
  const s = log.scan();
  expect([...s.openRuns]).toEqual([["open", { started: true, queued: { text: "hi", attachments: ["/inbox/s/a.png"] } }]]);
  expect([...s.openRequests]).toEqual(["q-open"]);
  expect(s.lastNative?.event.nativeThreadId).toBe("t-new");
  expect(log.append(ev("z")).seq).toBe(15);
});

test("compact drops only what devd acknowledged and nothing still open", () => {
  writeLog14();
  const log = new EventLog(path, { compactMinBytes: 0 });
  expect(log.compact(13)).toBe(8);
  // Kept: the latest thread.native, every event of the open run (its request too), and seq 14 (> ack).
  expect(log.readFrom(0).map((e) => e.seq)).toEqual([9, 10, 11, 12, 13, 14]);
  expect(new EventLog(path).lastSeq()).toBe(14);
  expect(log.append(ev("z")).seq).toBe(15);
});

test("compact keeps the last event, so the seq continues after everything was acknowledged", () => {
  const log = new EventLog(path, { compactMinBytes: 0 });
  for (let i = 0; i < 3; i++) log.append({ type: "background.changed", work: [] });
  log.compact(3);
  expect(log.readFrom(0).map((e) => e.seq)).toEqual([3]);
  expect(new EventLog(path).append(ev("d")).seq).toBe(4);
});

test("compact leaves a log below the size threshold alone, and waits for it to double after a compaction", () => {
  writeLog14();
  const size = statSync(path).size;
  expect(new EventLog(path, { compactMinBytes: size + 1 }).compact(13)).toBeNull();
  expect(statSync(path).size).toBe(size);
  const log = new EventLog(path, { compactMinBytes: 0 });
  expect(log.compact(10)).not.toBeNull();
  const after = statSync(path).size;
  expect(log.compact(13)).toBeNull();
  while (statSync(path).size < 2 * after) log.append(ev("x".repeat(100)));
  expect(log.compact(13)).not.toBeNull();
});

test("compact drops torn lines and says so", () => {
  const log = new EventLog(path, { compactMinBytes: 0, logError: (m) => logged.push(m) });
  const logged: string[] = [];
  log.append(ev("a"));
  appendFileSync(path, '{"seq":2,"ts":1,"event":{"type":"mess');
  const again = new EventLog(path, { compactMinBytes: 0, logError: (m) => logged.push(m) });
  again.append(ev("b"));
  again.compact(1);
  expect(again.readFrom(0).map((e) => e.seq)).toEqual([2]);
  expect(logged).toEqual([expect.stringContaining("1 unparseable line")]);
});

test("the last seq is found behind a last line longer than the tail read", () => {
  const log = new EventLog(path);
  log.append(ev("a"));
  log.append(ev("x".repeat(300_000)));
  appendFileSync(path, '{"seq":3,"ts":1,"event":{"type":"mess');
  expect(new EventLog(path).lastSeq()).toBe(2);
});

test("a large log opens from its tail, streams without loading it whole, and compacts to what is open", () => {
  // ~64 MB of deltas from finished runs, as a session that lived for weeks writes them.
  const big = "x".repeat(600);
  const fd = openSync(path, "w");
  let seq = 0;
  let batch: string[] = [];
  for (let run = 0; run < 1000; run++) {
    batch.push(L(++seq, { type: "run.started", runId: `r${run}`, origin: "user", nativeThreadId: null, model: null }));
    for (let i = 0; i < 100; i++) batch.push(L(++seq, { type: "message.delta", runId: `r${run}`, itemId: "i", text: big }));
    batch.push(L(++seq, { type: "run.completed", runId: `r${run}`, nativeThreadId: "t", usage: null, costUsd: null }));
    if (batch.length > 5000) {
      writeSync(fd, batch.join("\n") + "\n");
      batch = [];
    }
  }
  writeSync(fd, batch.join("\n") + "\n");
  closeSync(fd);
  expect(statSync(path).size).toBeGreaterThan(60 << 20);

  let t = performance.now();
  const log = new EventLog(path);
  expect(log.lastSeq()).toBe(seq);
  // Sanity bounds only (CI machines vary): opening reads the tail, not 60+ MB.
  expect(performance.now() - t).toBeLessThan(2000);

  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  let n = 0;
  let peak = rss0;
  for (const e of log.stream(0)) {
    n++;
    if (e.seq % 10_000 === 0) peak = Math.max(peak, process.memoryUsage().rss);
  }
  expect(n).toBe(seq);
  // Sanity bound: streaming holds a chunk, not the 60+ MB file and its parsed events (which would be several times it).
  expect(peak - rss0).toBeLessThan(150 << 20);

  t = performance.now();
  const compacting = new EventLog(path);
  compacting.append(ev("tail"));
  expect(compacting.compact(seq)).toBe(seq);
  expect(compacting.readFrom(0).map((e) => e.seq)).toEqual([seq + 1]);
  expect(performance.now() - t).toBeLessThan(60_000);
});
