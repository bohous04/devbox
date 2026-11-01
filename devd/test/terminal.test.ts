import { expect, test } from "bun:test";
import { openDb, insertSession } from "../src/db";
import { createBridge, terminalGuard, terminalTarget, type PtyLike } from "../src/terminal";
import { isValidTmuxName } from "../src/tmux";

function fakePty() {
  const w: string[] = []; const sizes: [number, number][] = [];
  let killed = false; let onData: (d: string) => void = () => {}; let onExit: () => void = () => {};
  const pty: PtyLike = {
    onData: (cb) => { onData = cb; }, onExit: (cb) => { onExit = cb; },
    write: (d) => w.push(d), resize: (c, r) => sizes.push([c, r]), kill: () => { killed = true; },
  };
  return { pty, get written() { return w; }, get sizes() { return sizes; }, get killed() { return killed; }, emit: (d: string) => onData(d), exit: () => onExit() };
}
function row(over: Partial<import("../src/db").SessionRow> = {}) {
  return { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms", port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, ...over } as import("../src/db").SessionRow;
}

test("guard: stopped/unknown session → not ok, 1008", () => {
  expect(terminalGuard(null)).toEqual({ ok: false, code: 1008, reason: "unknown session" });
  expect(terminalGuard(row({ status: "stopped" }))).toEqual({ ok: false, code: 1008, reason: "session is not running" });
  expect(terminalGuard(row())).toEqual({ ok: true });
});

test("read-only: input is dropped until unlock arrives", () => {
  const db = openDb(":memory:"); insertSession(db, row());
  const f = fakePty(); const out: string[] = [];
  const b = createBridge({ db, sessionId: "dev-shop-cms", container: "dev-shop-cms", target: "main", spawn: () => f.pty, cols: 80, rows: 24, sink: { send: (d) => out.push(d), close: () => {} } });
  b.onClientMessage(JSON.stringify({ t: "i", d: "rm -rf\r" }));
  expect(f.written).toEqual([]);                       // read-only: nothing
  b.onClientMessage(JSON.stringify({ t: "unlock" }));
  b.onClientMessage(JSON.stringify({ t: "i", d: "y\r" }));
  expect(f.written).toEqual(["y\r"]);                  // passes after unlock
  f.emit("hello"); expect(out).toEqual(["hello"]);     // pty → sink
});

test("resize passes in read-only too; dispose kills the pty; audit to events", () => {
  const db = openDb(":memory:"); insertSession(db, row());
  const f = fakePty();
  const b = createBridge({ db, sessionId: "dev-shop-cms", container: "dev-shop-cms", target: "main", spawn: () => f.pty, cols: 80, rows: 24, sink: { send: () => {}, close: () => {} } });
  b.onClientMessage(JSON.stringify({ t: "r", cols: 120, rows: 40 }));
  expect(f.sizes).toEqual([[120, 40]]);
  b.onClientMessage(JSON.stringify({ t: "unlock" }));
  b.dispose(); expect(f.killed).toBe(true);
  const types = (db.query("SELECT type FROM events ORDER BY id").all() as { type: string }[]).map((e) => e.type);
  expect(types).toEqual(["terminal_open", "terminal_control"]);
});

test("invalid JSON is ignored (does not crash)", () => {
  const db = openDb(":memory:"); insertSession(db, row());
  const f = fakePty();
  const b = createBridge({ db, sessionId: "dev-shop-cms", container: "dev-shop-cms", target: "main", spawn: () => f.pty, cols: 80, rows: 24, sink: { send: () => {}, close: () => {} } });
  b.onClientMessage("nonsense{"); expect(f.written).toEqual([]);
});

test("terminalTarget: valid → itself, otherwise main", () => {
  expect(terminalTarget("main-2", isValidTmuxName)).toBe("main-2");
  expect(terminalTarget("foo", isValidTmuxName)).toBe("main");
  expect(terminalTarget(undefined, isValidTmuxName)).toBe("main");
});

test("createBridge passes target to spawn", () => {
  const db = openDb(":memory:"); insertSession(db, row());
  let got = "";
  createBridge({ db, sessionId: "dev-shop-cms", container: "c", target: "main-2", spawn: (_c, _n, t) => { got = t; return fakePty().pty; }, cols: 80, rows: 24, sink: { send() {}, close() {} } });
  expect(got).toBe("main-2");
});

// History scroll: tmux keeps the history itself (mouse on), so {t:"s"} translates to an SGR
// wheel event in the middle of the window. Allowed in read-only too — it only reads, writes nothing to the shell.
function scrollBridge(over: { exitCopyMode?: (name: string) => Promise<void> } = {}) {
  const db = openDb(":memory:"); insertSession(db, row());
  const f = fakePty();
  const b = createBridge({ db, sessionId: "dev-shop-cms", container: "dev-shop-cms", target: "main", spawn: () => f.pty, cols: 80, rows: 24, sink: { send: () => {}, close: () => {} }, ...over });
  return { db, f, b };
}

test("scroll: read-only {t:s,up,3} → 3× SGR wheel-up in the middle of 80×24", () => {
  const { f, b } = scrollBridge();
  b.onClientMessage(JSON.stringify({ t: "s", d: "up", n: 3 }));
  expect(f.written.join("")).toBe("\x1b[<64;40;12M".repeat(3));
});

test("scroll: coordinates from the last resize; n is clamped to 20", () => {
  const { f, b } = scrollBridge();
  b.onClientMessage(JSON.stringify({ t: "r", cols: 100, rows: 30 }));
  b.onClientMessage(JSON.stringify({ t: "s", d: "up", n: 1 }));
  expect(f.written.join("")).toBe("\x1b[<64;50;15M");
  f.written.length = 0;
  b.onClientMessage(JSON.stringify({ t: "s", d: "down", n: 99 }));
  expect(f.written.join("")).toBe("\x1b[<65;50;15M".repeat(20));
});

test("scroll: invalid messages are ignored; {t:i} still dropped in read-only; no events", () => {
  const { db, f, b } = scrollBridge();
  for (const m of [{ t: "s", d: "left", n: 3 }, { t: "s", d: "up", n: "x" }, { t: "s", d: "up", n: 0 }, { t: "s", d: "up", n: 2.5 }, { t: "s", d: "up" }, { t: "i", d: "ls\r" }]) {
    b.onClientMessage(JSON.stringify(m));
  }
  expect(f.written).toEqual([]);
  b.onClientMessage(JSON.stringify({ t: "s", d: "down", n: 1 }));
  const types = (db.query("SELECT type FROM events ORDER BY id").all() as { type: string }[]).map((e) => e.type);
  expect(types).toEqual(["terminal_open"]); // scroll does not log
});

test("bottom: {t:b} in read-only calls exitCopyMode with the grouped session, nothing to pty", async () => {
  const names: string[] = [];
  const { f, b } = scrollBridge({ exitCopyMode: async (n) => { names.push(n); } });
  b.onClientMessage(JSON.stringify({ t: "b" }));
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^web-dev-shop-cms-\d+$/);
  expect(f.written).toEqual([]);
});

test("bottom: an exitCopyMode error (not in copy-mode) is swallowed; without the dep nothing", async () => {
  const { b } = scrollBridge({ exitCopyMode: () => Promise.reject(new Error("not in a mode")) });
  b.onClientMessage(JSON.stringify({ t: "b" }));
  await new Promise((r) => setTimeout(r, 0)); // unhandled rejection by test shodil
  const { b: b2 } = scrollBridge({ exitCopyMode: () => { throw new Error("sync"); } });
  expect(() => b2.onClientMessage(JSON.stringify({ t: "b" }))).not.toThrow();
  const { b: b3 } = scrollBridge();
  expect(() => b3.onClientMessage(JSON.stringify({ t: "b" }))).not.toThrow();
});

test("scroll: a huge resize from a read-only client is clamped — SGR coordinates stay digits", () => {
  const { f, b } = scrollBridge();
  b.onClientMessage(JSON.stringify({ t: "r", cols: 1e22, rows: -5 }));
  expect(f.sizes).toEqual([[1000, 1]]);
  b.onClientMessage(JSON.stringify({ t: "s", d: "up", n: 2 }));
  expect(f.written.join("")).toMatch(/^(\x1b\[<6[45];\d{1,4};\d{1,4}M)+$/);
});

test("scroll works after unlock too", () => {
  const { f, b } = scrollBridge();
  b.onClientMessage(JSON.stringify({ t: "unlock" }));
  b.onClientMessage(JSON.stringify({ t: "s", d: "down", n: 2 }));
  expect(f.written.join("")).toBe("\x1b[<65;40;12M".repeat(2));
});

test("bottom: while the previous cancel runs, another {t:b} does not start a new exec", async () => {
  let calls = 0; let release: () => void = () => {};
  const { b } = scrollBridge({ exitCopyMode: () => { calls++; return new Promise<void>((r) => { release = r; }); } });
  b.onClientMessage(JSON.stringify({ t: "b" }));
  b.onClientMessage(JSON.stringify({ t: "b" }));
  expect(calls).toBe(1);
  release(); await new Promise((r) => setTimeout(r, 0));
  b.onClientMessage(JSON.stringify({ t: "b" }));
  expect(calls).toBe(2); // works again once it finishes
});

test("bottom: the guard is released after an exitCopyMode error", async () => {
  let calls = 0;
  const { b } = scrollBridge({ exitCopyMode: () => { calls++; return Promise.reject(new Error("x")); } });
  b.onClientMessage(JSON.stringify({ t: "b" }));
  await new Promise((r) => setTimeout(r, 0));
  b.onClientMessage(JSON.stringify({ t: "b" }));
  expect(calls).toBe(2);
});

test("granted: true — the share host has control from the start, without unlock", () => {
  const db = openDb(":memory:"); insertSession(db, row());
  const f = fakePty();
  const b = createBridge({ db, sessionId: "dev-shop-cms", container: "dev-shop-cms", target: "main", spawn: () => f.pty, cols: 80, rows: 24, granted: true, sink: { send: () => {}, close: () => {} } });
  b.onClientMessage(JSON.stringify({ t: "i", d: "ls\r" }));
  expect(f.written).toEqual(["ls\r"]);
});
