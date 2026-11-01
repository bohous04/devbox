import { expect, test } from "bun:test";
import {
  ApiErrorRetry,
  CONTINUE_DELAY_MS,
  detectStuck429,
  parsePanes,
  sweep429,
} from "../src/apiErrorRetry";

// Fixtures come from LIVE capture-pane outputs (devbox 2026-08-23, dev-apps-auto-bingo
// and dev-games-game_agents-2), not from assumptions about the cc UI. Key measured facts:
//  - after a 429 abort cc still prints a turn summary ("✻ Baked for 10m 28s") and possibly a recap,
//    so "the error is the last line" would NEVER trigger;
//  - the cc input area = horizontal lines ─── with ❯ (the top line may carry the session title),
//    Grok Build (a cc fork) has a ╭─╮ │ ❯ │ ╰─╯ box;
//  - an unsubmitted draft may be sitting in the input — then continue must NOT be sent
//    (Enter would send it together with the draft).
const RULE = "─".repeat(60);

const STUCK = [
  "  Ran 3 shell commands",
  "",
  "● API Error: Request rejected (429) · Provider returned error",
  "",
  "✻ Baked for 10m 28s",
  "",
  RULE,
  "❯ ",
  RULE,
  "  stealth/ox-alpha [high]  |  404K",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

const STUCK_WITH_RECAP = [
  "● API Error: Request rejected (429) · Provider returned error",
  "",
  "✻ Baked for 10m 28s",
  "",
  "● recap: Auto Bingo got three new features and everything is deployed live. All that is left is your print preview on",
  "  bingo.example.com, to check the cell size fits. (disable recaps in /config)",
  "",
  `${"─".repeat(20)} Ride bingo feedback ${"─".repeat(20)}`,
  "❯ ",
  RULE,
  "  stealth/ox-alpha [high]  |  404K",
].join("\n");

// Real auto-bingo case: the error is OLD — more ❯ continue turns came after it.
const OLD_ERROR_LATER_TURNS = [
  "● API Error: Request rejected (429) · Provider returned error",
  "",
  "✻ Baked for 10m 28s",
  "",
  "❯ continue",
  "",
  "✻ Cooked for 2s",
  "",
  RULE,
  "❯ ",
  RULE,
  "  stealth/ox-alpha [high]  |  404K",
].join("\n");

// Current error, but a draft is sitting in the input → Enter would send it. Hands off.
const STUCK_BUT_DRAFT = [
  "● API Error: Request rejected (429) · Provider returned error",
  "",
  "✻ Baked for 10m 28s",
  "",
  `${"─".repeat(20)} Ride bingo feedback ${"─".repeat(20)}`,
  "❯  1. remove it from there",
  "  2. push",
  "  3. delete them",
  RULE,
  "  stealth/ox-alpha [high]  |  404K",
].join("\n");

// Grok Build box style (╭╮│╰╯) — the parser must handle it; the 429 text is cc format, so
// if grok printed it too (it is a cc fork), continue is still the right way to unblock.
const STUCK_GROK_BOX = [
  "● API Error: Request rejected (429) · Provider returned error",
  "",
  "✻ Worked for 9m7s",
  "",
  `  ╭${"─".repeat(58)}╮`,
  `  │ ❯ ${" ".repeat(54)}│`,
  `  ╰${"─".repeat(30)} Grok 4.6 (high) · always-approve ─╯`,
  "",
  "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
].join("\n");

// A turn is running right now (spinner with "esc to interrupt") → do not intervene.
const STUCK_BUT_RUNNING = [
  "● API Error: Request rejected (429) · Provider returned error",
  "",
  "✻ Baking… (esc to interrupt)",
  "",
  RULE,
  "❯ ",
  RULE,
].join("\n");

const IDLE_NO_ERROR = [
  "● Done, deployed.",
  "",
  "✻ Baked for 3m 2s",
  "",
  RULE,
  "❯ ",
  RULE,
  "  stealth/ox-alpha [high]  |  274K",
].join("\n");

test("detection: 429 + turn summary + empty input = stuck", () => {
  expect(detectStuck429(STUCK)).toBe(true);
});

test("detection: a recap after the error is fine (ends right before the input)", () => {
  expect(detectStuck429(STUCK_WITH_RECAP)).toBe(true);
});

test("detection: old error with more turns after it = NOT stuck (live auto-bingo case)", () => {
  expect(detectStuck429(OLD_ERROR_LATER_TURNS)).toBe(false);
});

test("detection: draft in the input = do not intervene (Enter would send it)", () => {
  expect(detectStuck429(STUCK_BUT_DRAFT)).toBe(false);
});

test("detection: grok box style (╭╮) with empty input passes", () => {
  expect(detectStuck429(STUCK_GROK_BOX)).toBe(true);
});

test("detection: running turn (esc to interrupt) = do not intervene", () => {
  expect(detectStuck429(STUCK_BUT_RUNNING)).toBe(false);
});

test("detection: idle without an error = nothing", () => {
  expect(detectStuck429(IDLE_NO_ERROR)).toBe(false);
});

// ── State machine: 5 minutes of stable stuck state → continue; every change resets the timer ──

test("first tick only records, after 5 min of stable state it fires and clears the state", () => {
  const r = new ApiErrorRetry();
  const t0 = 1_000_000;
  expect(r.tick([{ key: "c1/%0", captured: STUCK }], t0)).toEqual([]);
  // nothing before the limit elapses
  expect(r.tick([{ key: "c1/%0", captured: STUCK }], t0 + CONTINUE_DELAY_MS - 1)).toEqual([]);
  // fire after the limit; the state is cleared, so the very next tick starts over
  expect(r.tick([{ key: "c1/%0", captured: STUCK }], t0 + CONTINUE_DELAY_MS)).toEqual(["c1/%0"]);
  expect(r.tick([{ key: "c1/%0", captured: STUCK }], t0 + CONTINUE_DELAY_MS + 1)).toEqual([]);
  // …and without further change it fires again after another 5 min → "repeat every 5 min"
  expect(r.tick([{ key: "c1/%0", captured: STUCK }], t0 + 2 * CONTINUE_DELAY_MS + 1)).toEqual(["c1/%0"]);
});

test("a change in pane content resets the countdown (someone is typing / something is happening)", () => {
  const r = new ApiErrorRetry();
  const t0 = 1_000_000;
  r.tick([{ key: "c1/%0", captured: STUCK }], t0);
  r.tick([{ key: "c1/%0", captured: STUCK_WITH_RECAP }], t0 + CONTINUE_DELAY_MS - 1);
  // 5 min have not passed since the change → nothing
  expect(r.tick([{ key: "c1/%0", captured: STUCK_WITH_RECAP }], t0 + CONTINUE_DELAY_MS + 1)).toEqual([]);
});

test("error disappears → state is dropped; pane disappears from the tick → state is dropped", () => {
  const r = new ApiErrorRetry();
  const t0 = 1_000_000;
  r.tick([{ key: "c1/%0", captured: STUCK }], t0);
  r.tick([{ key: "c1/%0", captured: IDLE_NO_ERROR }], t0 + 60_000);
  r.tick([{ key: "c1/%0", captured: STUCK }], t0 + 120_000);
  // if the state survived it would fire here already (t0 + 5 min); it must not — counting starts at 120 s
  expect(r.tick([{ key: "c1/%0", captured: STUCK }], t0 + CONTINUE_DELAY_MS + 60_000)).toEqual([]);

  const r2 = new ApiErrorRetry();
  r2.tick([{ key: "c1/%0", captured: STUCK }], t0);
  r2.tick([], t0 + 60_000);   // session/container gone
  r2.tick([{ key: "c1/%0", captured: STUCK }], t0 + 120_000);
  expect(r2.tick([{ key: "c1/%0", captured: STUCK }], t0 + CONTINUE_DELAY_MS + 60_000)).toEqual([]);
});

// ── Parsing the multi-pane output of the probe command ──

test("parsePanes splits the output into sections by ===PANE headers", () => {
  const out = [
    "===PANE main %0",
    "line A",
    "line B",
    "===PANE main-2 %3",
    "line C",
  ].join("\n");
  expect(parsePanes(out)).toEqual([
    { session: "main", pane: "%0", captured: "line A\nline B" },
    { session: "main-2", pane: "%3", captured: "line C" },
  ]);
});

// ── Sweep: orchestration across running containers, sending continue via tmux ──

test("sweep429 sends continue to a stuck pane after 5 minutes", async () => {
  const calls: { container: string; cmd: string[] }[] = [];
  const probeOut = `===PANE main %0\n${STUCK}`;
  const exec = async (container: string, cmd: string[]) => {
    calls.push({ container, cmd });
    return { stdout: cmd[cmd.length - 1]?.includes("===PANE") || cmd.join(" ").includes("capture-pane") ? probeOut : "" };
  };
  const retry = new ApiErrorRetry();
  const deps = { containers: () => ["dev-x"], exec, retry };
  const t0 = 1_000_000;
  expect(await sweep429(deps, t0)).toEqual([]);
  const sent = await sweep429(deps, t0 + CONTINUE_DELAY_MS);
  expect(sent).toEqual([{ container: "dev-x", session: "main", pane: "%0" }]);
  // last two execs: literal "continue" and Enter, targeted at the right pane
  const tail = calls.slice(-2).map((c) => c.cmd.join(" "));
  expect(tail[0]).toContain("send-keys");
  expect(tail[0]).toContain("-l");
  expect(tail[0]).toContain("continue");
  expect(tail[0]).toContain("%0");
  expect(tail[1]).toContain("Enter");
});
