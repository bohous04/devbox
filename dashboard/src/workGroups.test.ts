import { expect, test } from "bun:test";
import type { RunRow, ThreadItem } from "../../shared/thread";
import { shortDuration, threadRows, toolLabel, workLabel, workSummary } from "./workGroups";

let seq = 0;
const item = (runId: string | null, kind: ThreadItem["kind"], extra: Partial<ThreadItem> = {}): ThreadItem =>
  ({ seq: ++seq, runId, itemId: `i${seq}`, kind, text: kind === "tool" ? "" : `${kind} ${seq}`, status: "done", ts: seq, ...extra });
const run = (runId: string, status: RunRow["status"], startedAt: number | null = 1_000, endedAt: number | null = 135_000): RunRow =>
  ({ runId, origin: "user", status, harness: "claude", nativeThreadId: null, model: null, queuedAt: null, startedAt, endedAt, endedSeq: null, usage: null, error: null });
const shape = (rows: ReturnType<typeof threadRows>) =>
  rows.map((r) => (r.type === "item" ? r.item.kind : `work[${r.items.map((i) => i.kind).join(",")}]`));

test("threadRows: a finished run folds its tools and interim prose; the answer, user message and notices stay", () => {
  const items = [
    item("a", "user"), item("a", "assistant"), item("a", "tool"), item(null, "notice"), item("a", "tool"),
    item("a", "assistant"), item("a", "tool"), item("a", "assistant"),
  ];
  const rows = threadRows(items, [run("a", "completed")]);
  expect(shape(rows)).toEqual(["user", "work[assistant,tool,tool,assistant,tool]", "notice", "assistant"]);
  expect(rows[3]).toEqual({ type: "item", item: items[7], answer: true });
  expect(rows[1]).toMatchObject({ status: "completed", durationMs: 134_000 });
});

test("threadRows: a running run, a run without tools and requests do not fold", () => {
  const items = [
    item("a", "user"), item("a", "tool"), item("a", "assistant"),
    item("b", "user"), item("b", "assistant"), item("b", "assistant"),
    item("c", "user"), item("c", "tool"), item("c", "request"), item("c", "assistant"),
  ];
  const rows = threadRows(items, [run("a", "running", 1, null), run("b", "completed"), run("c", "completed")]);
  expect(shape(rows)).toEqual(["user", "tool", "assistant", "user", "assistant", "assistant", "user", "work[tool]", "request", "assistant"]);
  // Only a finished run's last message is its answer.
  expect(rows.map((r) => r.type === "item" && r.answer === true)).toEqual([false, false, false, false, false, true, false, false, false, true]);
});

test("threadRows: a run with tools and no answer folds everything; unknown duration is null", () => {
  const rows = threadRows([item("a", "user"), item("a", "tool")], [run("a", "interrupted", null, null)]);
  expect(shape(rows)).toEqual(["user", "work[tool]"]);
  expect(rows[1]).toMatchObject({ status: "interrupted", durationMs: null });
});

test("workLabel and shortDuration", () => {
  expect(shortDuration(44_600)).toBe("45s");
  expect(shortDuration(134_000)).toBe("2m 14s");
  expect(shortDuration(3_900_000)).toBe("1h 5m");
  expect(workLabel("completed", 134_000)).toBe("Worked for 2m 14s");
  expect(workLabel("interrupted", 5_000)).toBe("Stopped after 5s");
  expect(workLabel("failed", null)).toBe("Failed");
});

test("toolLabel: Claude, Codex, ACP and MCP tools", () => {
  expect(toolLabel("Bash", { command: "bun test\necho done", description: "x" })).toEqual({ kind: "command", verb: "Ran", target: "bun test", code: true });
  expect(toolLabel("Edit", { file_path: "/w/src/queue.ts" })).toEqual({ kind: "edit", verb: "Edited", target: "queue.ts", code: false });
  expect(toolLabel("Read", { file_path: "/w/a.md" })).toMatchObject({ verb: "Read", target: "a.md" });
  expect(toolLabel("Grep", { pattern: "TODO" })).toMatchObject({ kind: "search", target: "TODO", code: true });
  expect(toolLabel("WebFetch", { url: "https://example.com/x" })).toMatchObject({ verb: "Fetched", target: "example.com" });
  expect(toolLabel("command", "ls -la")).toMatchObject({ kind: "command", target: "ls -la" });
  expect(toolLabel("fileChange", [{ path: "a/b.ts" }, { path: "c.ts" }])).toMatchObject({ kind: "edit", target: "2 files" });
  expect(toolLabel("execute", { title: "npm test", rawInput: {} })).toMatchObject({ kind: "command", target: "npm test" });
  expect(toolLabel("mcp__plane__list_projects", { limit: 5 })).toEqual({ kind: "other", verb: "plane · list_projects", target: '{"limit":5}', code: true });
  expect(toolLabel(undefined, undefined)).toEqual({ kind: "other", verb: "(unknown)", target: "", code: true });
});

test("workSummary counts tool kinds", () => {
  const items = [
    item("a", "tool", { tool: "Bash", input: { command: "a" } }), item("a", "tool", { tool: "Bash", input: { command: "b" }, isError: true }),
    item("a", "tool", { tool: "Edit", input: { file_path: "x" } }), item("a", "assistant"), item("a", "tool", { tool: "TodoWrite", input: {} }),
  ];
  expect(workSummary(items)).toBe("2 commands · 1 edit · 1 other tool");
});
