import { expect, test } from "bun:test";
import { getCodexUsage, openDb, upsertCodexUsage, type CodexUsageRow } from "../src/db";

const row = (over: Partial<CodexUsageRow> = {}): CodexUsageRow => ({
  singleton: 1, state: "ok", plan_type: "plus",
  windows_json: '[{"kind":"primary","usedPct":5,"windowMinutes":300,"resetsAt":null}]',
  credits_json: null, limit_reached: null, endpoint_idx: 2, fetched_at: 1_787_224_361_140, error: null,
  ...over,
});

test("codex_usage: an empty DB returns null", () => {
  expect(getCodexUsage(openDb(":memory:"))).toBe(null);
});

test("codex_usage: write and overwrite keep ONE row", () => {
  const db = openDb(":memory:");
  upsertCodexUsage(db, row());
  upsertCodexUsage(db, row({ plan_type: "pro", fetched_at: 2 }));
  expect(getCodexUsage(db)!.plan_type).toBe("pro");
  expect((db.query("SELECT COUNT(*) AS n FROM codex_usage").get() as { n: number }).n).toBe(1);
});

test("codex_usage: an error state is stored together with the last numbers", () => {
  const db = openDb(":memory:");
  upsertCodexUsage(db, row({ state: "error", error: "deactivated_workspace (HTTP 402)" }));
  const r = getCodexUsage(db)!;
  expect(r.state).toBe("error");
  expect(r.error).toBe("deactivated_workspace (HTTP 402)");
  expect(r.windows_json).toContain("primary");
});
