import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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
