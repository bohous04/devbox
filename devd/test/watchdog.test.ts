import { expect, test } from "bun:test";
import { insertSession, listSessions, openDb } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";
import { AGENTS } from "../src/agents";
import { PROBE_CMD, probeActive, sweepIdleSessions } from "../src/watchdog";

const HOUR = 3600_000;
let nextPortBase = 40100;
const row = (id: string, last: number) => ({
  id, folder: "apps", project: "apps", repo: id, container: id, port_base: nextPortBase++,
  status: "running" as const, solo: 0 as const, created_at: 0, last_active_at: last, important: 0 as const,
});

// Regression: `PROBE_CMD` hard-coded only `claude|codex`, so after adding a profile
// with the `grok` runtime the watchdog would not count a session running Grok as active.
test("probe counts processes of ALL runtimes from the profile table", () => {
  for (const spec of Object.values(AGENTS)) expect(PROBE_CMD).toContain(spec.runtime);
});

// Regression: the probe used to treat as "alive" only an attached tmux client or claude
// above 3 % CPU. But `ps -eo %cpu` is an AVERAGE over the process lifetime — measured live at
// 1.2 % even for a session that was working right then. So that branch never fired and it was enough
// to put the mac to sleep (the client detaches) for the watchdog to kill a container with a running agent after 4 h.
test("probeActive: a detached session with a running agent is active", () => {
  expect(probeActive("0\n1\n")).toBe(true);   // nobody attached, but claude is alive inside
  expect(probeActive("3\n3\n")).toBe(true);   // attached client
  expect(probeActive("1\n0\n")).toBe(true);   // client without an agent (user at the shell)
  expect(probeActive("0\n0\n")).toBe(false);  // nobody and nothing → clean up
  expect(probeActive("")).toBe(false);        // unreadable output → do not block cleanup
});

test("auto-stop passes a reason so it can be told apart from a manual stop in the log", async () => {
  const db = openDb(":memory:");
  const now = 10 * HOUR;
  insertSession(db, row("idle-old", now - 5 * HOUR));
  const calls: [string, string | undefined][] = [];
  const fakeMgr = { stop: async (id: string, reason?: string) => { calls.push([id, reason]); } };
  await sweepIdleSessions(fakeMgr as never, db, DEFAULT_CONFIG.settings, async () => false, now);
  expect(calls).toEqual([["idle-old", "idle"]]);
});

test("a failing stop is logged and does not abort the sweep", async () => {
  const db = openDb(":memory:");
  const now = 10 * HOUR;
  insertSession(db, row("idle-a", now - 5 * HOUR)); // stop throws
  insertSession(db, row("idle-b", now - 5 * HOUR)); // stop succeeds
  const stopped: string[] = [];
  const fakeMgr = {
    stop: async (id: string) => {
      if (id === "idle-a") throw new Error("docker stop failed");
      stopped.push(id);
    },
  };
  const origError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const out = await sweepIdleSessions(fakeMgr as never, db, DEFAULT_CONFIG.settings, async () => false, now);
    expect(out).toEqual(["idle-b"]);
    expect(stopped).toEqual(["idle-b"]);
    expect(errors.length).toBe(1);
    expect(String(errors[0]![0])).toContain("idle-a");
  } finally {
    console.error = origError;
  }
});

test("stops only inactive sessions past the idle limit; active is a stop-veto, not activity", async () => {
  const db = openDb(":memory:");
  const now = 10 * HOUR;
  insertSession(db, row("idle-old", now - 5 * HOUR));   // idle > 4h → stop
  insertSession(db, row("idle-new", now - 1 * HOUR));   // idle < 4h → keep
  insertSession(db, row("busy-old", now - 5 * HOUR));   // active → keep, but do NOT bump
  const stopped: string[] = [];
  const fakeMgr = { stop: async (id: string) => { stopped.push(id); } };
  const out = await sweepIdleSessions(
    fakeMgr as never, db, DEFAULT_CONFIG.settings,
    async (s) => s.id === "busy-old", now
  );
  expect(out).toEqual(["idle-old"]);
  expect(stopped).toEqual(["idle-old"]);
  // An attached tmux client / running claude keeps the session alive (no auto-stop),
  // but it is NOT real activity — `last_active_at` must stay at the last use
  // (otherwise a forgotten attach would reset "active X ago" to "now" every 5 min).
  const busy = listSessions(db).find((s) => s.id === "busy-old")!;
  expect(busy.last_active_at).toBe(now - 5 * HOUR);
});
