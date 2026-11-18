import { expect, test } from "bun:test";
import type { RunRow, ThreadItem } from "../../shared/thread";
import { buildHandoff, deliverInline, handoffBudget } from "../src/handoff";

let seq = 0;
const item = (o: Partial<ThreadItem> & Pick<ThreadItem, "kind">): ThreadItem => ({ seq: ++seq, runId: "r1", itemId: null, text: "", ts: 0, ...o });
const user = (text: string, runId = "r1") => item({ kind: "user", text, runId });
const asst = (text: string, runId = "r1") => item({ kind: "assistant", text, runId });
const run = (o: Partial<RunRow> = {}): RunRow => ({
  runId: "r1", origin: "user", status: "completed", harness: null, nativeThreadId: null, model: null,
  queuedAt: null, startedAt: null, endedAt: null, endedSeq: null, usage: null, error: null, ...o,
});
const WRAPPER_BYTES = 16; // "\n\nUser message:\n"
const base = { runs: [run()], request: "next", window: 200_000, used: 0, reserve: 0 };

test("budget: each of the three bounds wins", () => {
  expect(handoffBudget(1_000_000, 0, 10, 0)).toBe(16_000);
  expect(handoffBudget(40_000, 0, 10, 0)).toBe(16_000);
  expect(handoffBudget(10_000, 2_000, 500, 1_500)).toBe(6_000);
  expect(handoffBudget(100, 90, 50, 0)).toBe(0);
});

test("everything is included, oldest first, when it fits", () => {
  const items = [user("U1"), asst("A1"), user("U2"), asst("A2")];
  const h = buildHandoff({ ...base, items });
  expect(h.includedItemSeqs).toEqual(items.map((i) => i.seq));
  expect(h.omitted).toBe(0);
});

test("selection order: latest user, latest assistant, first user, then newest first", () => {
  const items = [user("U1"), asst("A1"), user("U2"), asst("A2"), user("U3"), asst("A3")];
  const full = buildHandoff({ ...base, items });
  const header = full.preamble!.split("\n")[0].length + 1;
  const note = "(6 earlier items omitted; read the full history with devbox_thread_read)".length;
  // header + worst-case note + three entries ("[user] U1\n" = 10, "[assistant] A3\n" = 15 ...)
  const window = header + note + 1 + WRAPPER_BYTES + 10 + 10 + 15;
  const h = buildHandoff({ ...base, items, window, request: "" });
  expect(h.includedItemSeqs).toEqual([items[0].seq, items[4].seq, items[5].seq]);
  expect(h.omitted).toBe(3);
  // One more entry of room goes to the newest remaining item (A2), not an older one.
  const more = buildHandoff({ ...base, items, window: window + 15, request: "" });
  expect(more.includedItemSeqs).toEqual([items[0].seq, items[3].seq, items[4].seq, items[5].seq]);
});

test("a message that does not fit is skipped whole, never cut", () => {
  const big = "x".repeat(5_000);
  const items = [user("first"), asst(big), user("latest"), asst("tiny")];
  const h = buildHandoff({ ...base, items, window: 1_000, request: "" });
  expect(h.includedItemSeqs).toEqual([items[0].seq, items[2].seq, items[3].seq]);
  expect(h.preamble).not.toContain("xxx");
  expect(h.omitted).toBe(1);
});

test("file changes appear as paths only", () => {
  const items = [
    user("go"),
    item({ kind: "tool", tool: "Write", input: { file_path: "/w/a.ts", content: "SECRET BODY" } }),
    item({ kind: "tool", tool: "fileChange", input: [{ path: "b.ts", kind: { type: "update" }, diff: "SECRET DIFF" }, { path: "c.ts", kind: { type: "add" }, diff: "x" }] }),
  ];
  const h = buildHandoff({ ...base, items });
  expect(h.preamble).toContain("[file change] /w/a.ts");
  expect(h.preamble).toContain("[file change] b.ts, c.ts");
  expect(h.preamble).not.toContain("SECRET");
});

test("commands, errors and plans are carried; other tool calls and notices are not", () => {
  const items = [
    user("go"),
    item({ kind: "tool", tool: "Bash", input: { command: "ls -la" }, output: "big listing", isError: false }),
    item({ kind: "tool", tool: "command", input: "false", output: "exit 1", isError: true }),
    item({ kind: "tool", tool: "ExitPlanMode", input: { plan: "1. do it" } }),
    item({ kind: "tool", tool: "Read", input: { file_path: "/w/r" }, output: "contents", isError: false }),
    item({ kind: "notice", text: "Agent bridge restarted" }),
    item({ kind: "notice", text: "boom", runId: "r2" }),
  ];
  const h = buildHandoff({ ...base, items, runs: [run(), run({ runId: "r2", status: "failed", error: "boom" })] });
  expect(h.preamble).toContain("[command] ls -la");
  expect(h.preamble).not.toContain("big listing");
  expect(h.preamble).toContain("[command failed] exit 1");
  expect(h.preamble).toContain("[plan] 1. do it");
  expect(h.preamble).toContain("[error] boom");
  expect(h.preamble).not.toContain("contents");
  expect(h.preamble).not.toContain("restarted");
});

test("delta skips items of covered runs", () => {
  const items = [user("stale", "r1"), asst("stale answer", "r1"), user("new", "r2")];
  const h = buildHandoff({ ...base, items, runs: [run(), run({ runId: "r2" })], coveredRunIds: new Set(["r1"]) });
  expect(h.includedItemSeqs).toEqual([items[2].seq]);
  expect(h.preamble).not.toContain("stale");
});

test("oversized request keeps the request and drops history", () => {
  const request = "y".repeat(20_000);
  const items = [user("hi"), asst("hello")];
  const h = buildHandoff({ ...base, items, request, window: 20_100, reserve: 0 });
  expect(h.preamble).toBeNull();
  expect(h.includedItemSeqs).toEqual([]);
  expect(h.omitted).toBe(2);
  expect(deliverInline(h, request)).toBe(request);

  // The request alone exceeds the window: the budget clamps to 0.
  const over = buildHandoff({ ...base, items, request, window: 10_000 });
  expect(over.budget).toBe(0);
  expect(over.preamble).toBeNull();
  expect(over.includedItemSeqs).toEqual([]);
  expect(deliverInline(over, request)).toBe(request);
});

test("preamble plus the deliverInline wrapper never exceed the budget, exact at the boundary", () => {
  const items = [user("hello")];
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const fitsAt = (window: number) => buildHandoff({ ...base, items, request: "", window });
  let smallest: number | undefined;
  for (let w = 0; w < 400; w++) {
    const h = fitsAt(w);
    if (h.preamble !== null) {
      smallest ??= w;
      expect(bytes(deliverInline(h, ""))).toBeLessThanOrEqual(h.budget);
    }
  }
  if (smallest === undefined) throw new Error("never fits");
  expect(fitsAt(smallest - 1).preamble).toBeNull();
  expect(bytes(deliverInline(fitsAt(smallest), ""))).toBeLessThanOrEqual(smallest);
  // Without charging the wrapper the entry would already fit WRAPPER_BYTES earlier.
  expect(smallest).toBeGreaterThanOrEqual(bytes(fitsAt(smallest).preamble!) + WRAPPER_BYTES);
});

test("bytes are counted as UTF-8, not characters", () => {
  const msg = "ž".repeat(100); // 100 chars, 200 bytes
  const items = [user(msg)];
  const fits = buildHandoff({ ...base, items, request: "", window: 100_000 });
  expect(fits.includedItemSeqs).toHaveLength(1);
  const header = fits.preamble!.split("\n")[0].length + 1;
  const note = "(1 earlier items omitted; read the full history with devbox_thread_read)".length;
  const chars = header + note + 1 + WRAPPER_BYTES + "[user] ".length + 100 + 1; // enough if (wrongly) counted in chars
  expect(buildHandoff({ ...base, items, request: "", window: chars }).includedItemSeqs).toEqual([]);
  expect(handoffBudget(1_000, 0, new TextEncoder().encode("žž").length, 0)).toBe(996);
});

test("deliverInline prepends the preamble and leaves the request untouched", () => {
  const h = buildHandoff({ ...base, items: [user("a")] });
  const req = "  keep   exact\n text ";
  expect(deliverInline(h, req)).toBe(`${h.preamble}\n\nUser message:\n${req}`);
});
