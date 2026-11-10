import { expect, test } from "bun:test";
import { attachLoop, backoffMs, countdownBar, createStatusPanel, renderRetryPanel, dialFor, isConnectFailure, MAX_MISSING_SESSION, prettyError, renderRetryStatus, retryDecision, type RetryStatus, TERMINAL_RESET } from "../src/reconnect";
import { lastErrorLine } from "../src/attach";

test("cold recovery retries missing Docker/tmux while desired session is running", async () => {
  const codes = [137, 143, 125, 44, 1, 0];
  let retries = 0;
  expect(await attachLoop({ argv: [], label: "exact", retryRemoteErrors: true,
    run: async () => codes.shift()!, health: async () => "running", sleep: async () => { retries++; }, out: () => {} })).toBe(0);
  expect(retries).toBe(5);
});

test("a tmux session that never comes back (exit 44) ends the loop instead of retrying forever", async () => {
  let calls = 0;
  const lines: string[] = [];
  expect(await attachLoop({ argv: [], label: "exact", retryRemoteErrors: true,
    run: async () => { calls++; return 44; }, health: async () => "running", sleep: async () => {}, out: (l) => lines.push(l) })).toBe(44);
  expect(calls).toBe(MAX_MISSING_SESSION);
  expect(lines.at(-1)).toContain("giving up");
});

test("cold recovery does not resurrect deliberately stopped container", async () => {
  let calls = 0;
  expect(await attachLoop({ argv: [], label: "exact", retryRemoteErrors: true,
    run: async () => { calls++; return 125; }, health: async () => "gone", sleep: async () => {}, out: () => {} })).toBe(0);
  expect(calls).toBe(1);
});

test("retryDecision: 0 = silent detach, 42 = exit menu, 255 = retry, other = error", () => {
  expect(retryDecision(0)).toBe("done");
  expect(retryDecision(42)).toBe("exit-menu");
  expect(retryDecision(255)).toBe("retry");
  expect(retryDecision(125)).toBe("error"); // docker exec: container gone
  expect(retryDecision(1)).toBe("error");
});

test("backoffMs: 1→2→4→8→15s with a cap", () => {
  expect(backoffMs(1)).toBe(1000);
  expect(backoffMs(2)).toBe(2000);
  expect(backoffMs(3)).toBe(4000);
  expect(backoffMs(4)).toBe(8000);
  expect(backoffMs(5)).toBe(15000);
  expect(backoffMs(6)).toBe(15000);
  expect(backoffMs(99)).toBe(15000);
});

function fakeDeps(codes: number[], health: ("running" | "gone" | "unknown")[] = []) {
  const lines: string[] = [];
  let ri = 0, hi = 0;
  return {
    lines,
    deps: {
      argv: ["ssh", "x"],
      label: "shop/Ledger-App · main-2",
      run: async () => codes[ri++] ?? 0,
      sleep: async () => {},
      health: async () => health[hi++] ?? "running",
      out: (l: string) => lines.push(l),
    },
  };
}

test("attachLoop: 255,255,0 → two retries, then silent detach (0)", async () => {
  const { deps, lines } = fakeDeps([255, 255, 0], ["running", "running"]);
  expect(await attachLoop(deps)).toBe(0);
  expect(lines.length).toBe(2); // two "retrying" messages
  expect(lines[0]).toContain("shop/Ledger-App · main-2");
  expect(lines[1]).toContain("attempt 2");
});

test("attachLoop: F9 (42) → returns 42 for the exit menu", async () => {
  const { deps } = fakeDeps([42]);
  expect(await attachLoop(deps)).toBe(42);
});

test("attachLoop: 255 then health=gone → gives up (0), no further retry", async () => {
  const { deps, lines } = fakeDeps([255, 0], ["gone"]);
  expect(await attachLoop(deps)).toBe(0);
  expect(lines.some((l) => l.includes("no longer running"))).toBe(true);
});

test("attachLoop: unexpected code (125) → error, returns the code", async () => {
  const { deps } = fakeDeps([125]);
  expect(await attachLoop(deps)).toBe(125);
});

test("attachLoop: reconnect succeeds (255 then 42) → returns 42", async () => {
  const { deps } = fakeDeps([255, 42], ["running"]);
  expect(await attachLoop(deps)).toBe(42);
});

test("dialFor: without a backup path everything goes primary, otherwise paths alternate (0=primary)", () => {
  const a = ["ssh", "vps"], b = ["ssh", "vps-ts"];
  expect(dialFor(0, a)).toBe(a);
  expect(dialFor(1, a)).toBe(a); // without argvAlt there is nothing to switch to
  expect(dialFor(0, a, b)).toBe(a);
  expect(dialFor(1, a, b)).toBe(b);
  expect(dialFor(2, a, b)).toBe(a);
  expect(dialFor(3, a, b)).toBe(b);
});

// Regression: on 2026-07-25 the IPv4 path to the VPS went down (the tailnet over IPv6 stayed up)
// and the loop kept dialing the dead public IP forever. Retry must try the other path too.
test("attachLoop: on retry alternates to the backup path and back; message says which", async () => {
  const dials: string[][] = [];
  const lines: string[] = [];
  const codes = [255, 255, 255, 0];
  let ri = 0;
  const code = await attachLoop({
    argv: ["ssh", "vps"],
    argvAlt: ["ssh", "vps-ts"],
    pathNames: ["vps", "vps-ts"],
    label: "apps/budget-app · main",
    run: async (argv) => { dials.push(argv); return codes[ri++] ?? 0; },
    sleep: async () => {},
    health: async () => "running",
    out: (l) => lines.push(l),
  });
  expect(code).toBe(0);
  expect(dials).toEqual([["ssh", "vps"], ["ssh", "vps-ts"], ["ssh", "vps"], ["ssh", "vps-ts"]]);
  expect(lines[0]).toContain("via vps-ts"); // the message announces the path of the NEXT attempt
  expect(lines[1]).toContain("via vps");
});

test("attachLoop: without a backup path the message stays unchanged (no \"via\")", async () => {
  const { deps, lines } = fakeDeps([255, 0], ["running"]);
  expect(await attachLoop(deps)).toBe(0);
  expect(lines[0]).not.toContain("via");
});

// fakeDeps with a scripted `now`: `times` is an array of [start, end] pairs, one per
// run() call (including the last, even though its attachedMs is unused) — it controls
// the measured run length exactly without real waiting.
function fakeDepsWithClock(codes: number[], health: ("running" | "gone" | "unknown")[], times: number[][]) {
  const lines: string[] = [];
  let ri = 0, hi = 0;
  const flat = times.flat();
  let ci = 0;
  return {
    lines,
    deps: {
      argv: ["ssh", "x"],
      label: "shop/Ledger-App · main-2",
      run: async () => codes[ri++] ?? 0,
      sleep: async () => {},
      health: async () => health[hi++] ?? "running",
      out: (l: string) => lines.push(l),
      now: () => flat[ci++] ?? 0,
    },
  };
}

test("attachLoop: two quick drops (255,255,0) → attempt 1, then attempt 2 (no reset)", async () => {
  const { deps, lines } = fakeDepsWithClock(
    [255, 255, 0],
    ["running", "running"],
    [
      [0, 100],     // run 1: short (100 ms) — the connection dropped right away
      [200, 400],   // run 2: short (200 ms)
      [1000, 1000], // run 3: straight 0 (done), measurement unused
    ],
  );
  expect(await attachLoop(deps)).toBe(0);
  expect(lines[0]).toContain("attempt 1");
  expect(lines[1]).toContain("attempt 2");
});

test("attachLoop: a long run (≥30s) before a drop resets the counter — the next attempt is attempt 1 again (spec §1)", async () => {
  const { deps, lines } = fakeDepsWithClock(
    [255, 255, 255, 0],
    ["running", "running", "running"],
    [
      [0, 100],       // run 1: short → attempt 1
      [200, 400],     // run 2: short → attempt 2
      [1000, 32000],  // run 3: LONG (31 s ≥ ATTACHED_RESET_MS) → reset → attempt 1 again
      [32000, 32000], // run 4: 0 (done)
    ],
  );
  expect(await attachLoop(deps)).toBe(0);
  expect(lines[0]).toContain("attempt 1");
  expect(lines[1]).toContain("attempt 2");
  expect(lines[2]).toContain("attempt 1"); // reset after a long attach, not "attempt 3"
});

// 1 Nov 2026: after a network drop every mouse move printed `^[[<35;44;50M` over the retry
// message — tmux's mouse reporting stayed on in the local terminal because ssh died first.
test("attachLoop: a dropped connection resets the terminal before the retry message, a clean detach does not", async () => {
  const events: string[] = [];
  const { deps } = fakeDeps([255, 0], ["running"]);
  await attachLoop({ ...deps, out: (l) => events.push(`out:${l.slice(0, 14)}`), resetTerminal: () => events.push("reset") });
  expect(events).toEqual(["reset", "out:⏳ Disconnected"]);
});

test("TERMINAL_RESET turns off every mouse mode and shows the cursor", () => {
  for (const mode of ["1000", "1002", "1003", "1004", "1006", "2004", "1049"]) expect(TERMINAL_RESET).toContain(`\x1b[?${mode}l`);
  expect(TERMINAL_RESET).toContain("\x1b[?25h");
});

// 9 Nov 2026 (screenshot): an outage printed two lines per attempt ("⏳ Disconnected…" in red on
// stderr + ssh's own "connect to host … timed out"), forever. With a status sink the loop
// updates one panel instead and prints nothing.
test("attachLoop with status: no lines printed, countdown ticks per second, panel removed on reconnect", async () => {
  const lines: string[] = [];
  const states: (RetryStatus | null)[] = [];
  const sleeps: number[] = [];
  const codes = [{ code: 255, error: "ssh: connect to host 1.2.3.4 port 2222: Operation timed out" }, { code: 255 }, 0];
  let ri = 0;
  expect(await attachLoop({
    argv: ["ssh", "a"], argvAlt: ["ssh", "b"], pathNames: ["a", "b"], label: "x/y · main",
    run: async () => codes[ri++]!, health: async () => "running",
    sleep: async (ms) => { sleeps.push(ms); }, out: (l) => lines.push(l), status: (s) => states.push(s),
  })).toBe(0);
  expect(lines).toEqual([]);
  expect(sleeps).toEqual([1000, 1000, 1000]); // attempt 1 = 1 s, attempt 2 = 2 s, ticked per second
  const waiting = states.filter((s) => s?.phase === "waiting") as RetryStatus[];
  expect(waiting.map((s) => s.secondsLeft)).toEqual([1, 2, 1]);
  expect(waiting[0]!.via).toBe("b");
  // the last error survives an attempt that failed without stderr
  expect(waiting.at(-1)!.lastError).toContain("Operation timed out");
  expect(states.some((s) => s?.phase === "connecting")).toBe(true);
  expect(states.at(-1)).toBeNull();
});

test("attachLoop: a long attempt that never connected does not reset the counter", async () => {
  const states: (RetryStatus | null)[] = [];
  const times = [0, 80_000, 80_000, 160_000, 160_000, 160_000];
  let ti = 0;
  const codes = [{ code: 255, error: "ssh: connect to host 1.2.3.4 port 2222: Operation timed out" }, { code: 255, error: "ssh: connect to host 1.2.3.4 port 2222: Operation timed out" }, 0];
  let ri = 0;
  await attachLoop({ argv: [], label: "l", run: async () => codes[ri++]!, health: async () => "running",
    sleep: async () => {}, now: () => times[ti++] ?? 160_000, status: (s) => states.push(s) });
  const attempts = states.filter((s) => s?.phase === "waiting").map((s) => s!.attempt);
  expect(attempts.at(-1)).toBe(2);
});

test("attachLoop: final failure message carries the captured error", async () => {
  const lines: string[] = [];
  await attachLoop({ argv: [], label: "l", run: async () => ({ code: 125, error: "Error: No such container: dev-x" }),
    health: async () => "running", sleep: async () => {}, out: (l) => lines.push(l) });
  expect(lines[0]).toContain("No such container");
});

test("isConnectFailure / prettyError / lastErrorLine", () => {
  expect(isConnectFailure("ssh: connect to host 1.2.3.4 port 2222: Operation timed out")).toBe(true);
  expect(isConnectFailure("Connection closed by 100.64.0.9 port 2222")).toBe(true);
  expect(isConnectFailure("Timeout, server vps not responding.")).toBe(false);
  expect(isConnectFailure(undefined)).toBe(false);
  expect(prettyError("ssh: connect to host 1.2.3.4 port 2222: Operation timed out")).toBe("1.2.3.4:2222 — operation timed out");
  expect(lastErrorLine("Warning: x\r\nssh: connect to host h port 1: No route to host\r\n\n")).toBe("ssh: connect to host h port 1: No route to host");
  expect(lastErrorLine("")).toBeUndefined();
});

test("renderRetryStatus: short, truncated to width, shows path, error and offline time", () => {
  const s: RetryStatus = { label: "shop/ledger", phase: "waiting", attempt: 7, secondsLeft: 12, via: "devbox-ts",
    lastError: "ssh: connect to host 203.0.113.7 port 2222: Operation timed out", offlineSince: 0 };
  const lines = renderRetryStatus(s, 192_000, 0, 200);
  expect(lines.length).toBe(4);
  expect(lines[0]).toContain("Offline · shop/ledger");
  expect(lines[1]).toContain("reconnecting in 12s via devbox-ts");
  expect(lines[2]).toContain("203.0.113.7:2222");
  expect(lines[3]).toContain("3m 12s");
  for (const l of renderRetryStatus(s, 0, 0, 30)) expect([...l].length).toBeLessThanOrEqual(29);
});

test("createStatusPanel redraws in place and clears", () => {
  const out: string[] = [];
  const panel = createStatusPanel((t) => out.push(t), { color: false, now: () => 0, width: () => 40 }); // narrow → compact 3 lines
  const s: RetryStatus = { label: "l", phase: "waiting", attempt: 1, secondsLeft: 1, offlineSince: 0 };
  panel(s); panel(s); panel(null); panel(null);
  expect(out[0]).not.toContain("\x1b[3A");
  expect(out[1]).toStartWith("\r\x1b[3A\x1b[J");
  expect(out[2]).toBe("\r\x1b[3A\x1b[J\x1b[?25h");
  expect(out.length).toBe(3);
});

test("renderRetryPanel: boxed ASCII panel with equal-width rows, glyph, countdown and error", () => {
  const s: RetryStatus = { label: "shop/ledger", phase: "waiting", attempt: 7, secondsLeft: 6, totalSeconds: 15, via: "devbox-ts",
    lastError: "ssh: connect to host 203.0.113.7 port 2222: Operation timed out", offlineSince: 0 };
  const rows = renderRetryPanel(s, 192_000, 0, 120)!.map((l) => l.map(([t]) => t).join(""));
  expect(rows.length).toBe(7);
  expect(new Set(rows.map((r) => [...r].length)).size).toBe(1); // every row exactly as wide as the frame
  expect(rows[0]).toStartWith("╭");
  expect(rows.at(-1)).toStartWith("╰");
  expect(rows[1]).toContain("Offline  ·  shop/ledger");
  expect(rows[2]).toContain("reconnecting in 6s  ▰▰▰▰▰▰▱▱▱▱");
  expect(rows[3]).toContain("via devbox-ts · attempt 7");
  expect(rows[4]).toContain("●");
  expect(rows[4]).toContain("203.0.113.7:2222 — operation timed out");
  // a very long label is truncated inside the frame instead of breaking it
  const long = renderRetryPanel({ ...s, label: "x".repeat(200) }, 0, 0, 120)!.map((l) => l.map(([t]) => t).join(""));
  expect(new Set(long.map((r) => [...r].length)).size).toBe(1);
  expect(renderRetryPanel(s, 0, 0, 40)).toBeNull(); // too narrow → caller falls back to compact lines
});

test("renderRetryPanel: arcs light up frame by frame while waiting, all lit while connecting", () => {
  const s: RetryStatus = { label: "l", phase: "waiting", attempt: 1, secondsLeft: 1, offlineSince: 0 };
  const lit = (f: number, st = s) => renderRetryPanel(st, 0, f, 100)!.flat().filter(([, k]) => k === "lit").length;
  expect(lit(0)).toBe(0);
  expect(lit(1)).toBeLessThan(lit(2));
  expect(lit(2)).toBeLessThan(lit(3));
  expect(lit(0, { ...s, phase: "connecting" })).toBe(lit(3));
});

test("countdownBar fills towards the next attempt", () => {
  const txt = (l: number, t: number) => countdownBar(l, t).map(([x]) => x).join("");
  expect(txt(15, 15)).toBe("▱".repeat(10));
  expect(txt(0, 15)).toBe("▰".repeat(10));
  expect(txt(5, 0)).toBe("▱".repeat(10));
});
