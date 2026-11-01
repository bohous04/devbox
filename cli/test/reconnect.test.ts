import { expect, test } from "bun:test";
import { attachLoop, backoffMs, dialFor, retryDecision, TERMINAL_RESET } from "../src/reconnect";

test("cold recovery retries missing Docker/tmux while desired session is running", async () => {
  const codes = [137, 143, 125, 44, 1, 0];
  let retries = 0;
  expect(await attachLoop({ argv: [], label: "exact", retryRemoteErrors: true,
    run: async () => codes.shift()!, health: async () => "running", sleep: async () => { retries++; }, out: () => {} })).toBe(0);
  expect(retries).toBe(5);
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
  for (const mode of ["1000", "1002", "1003", "1006", "2004", "1049"]) expect(TERMINAL_RESET).toContain(`\x1b[?${mode}l`);
  expect(TERMINAL_RESET).toContain("\x1b[?25h");
});
