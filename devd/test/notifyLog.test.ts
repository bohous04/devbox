import { expect, test } from "bun:test";
import { insertNotifyLog, listNotifyLog, openDb, pruneNotifyLog, setNotifyVerdict, type NotifyLogInput } from "../src/db";

function row(over: Partial<NotifyLogInput> = {}): NotifyLogInput {
  return {
    ts: 1_000, session_id: "dev-shop-cms", event: "stop", decision: "armed",
    reason: null, inflight: 0, teammates: 0, agent_session_id: "main-1", detail: null, ...over,
  };
}

test("insert and list: newest first, filter by session", () => {
  const db = openDb(":memory:");
  insertNotifyLog(db, row({ ts: 1_000 }));
  insertNotifyLog(db, row({ ts: 2_000, session_id: "dev-other-repo" }));
  insertNotifyLog(db, row({ ts: 3_000, decision: "deferred", reason: "busy-subagents", inflight: 2 }));

  const all = listNotifyLog(db);
  expect(all).toHaveLength(3);
  expect(all[0].ts).toBe(3_000);            // descending by id
  expect(all[0].reason).toBe("busy-subagents");
  expect(all[0].inflight).toBe(2);

  const mine = listNotifyLog(db, { session: "dev-shop-cms" });
  expect(mine.map((r) => r.ts)).toEqual([3_000, 1_000]);
});

test("a fresh row has no verdict", () => {
  const db = openDb(":memory:");
  insertNotifyLog(db, row());
  const [r] = listNotifyLog(db);
  expect(r.verdict).toBeNull();
  expect(r.verdict_note).toBeNull();
  expect(r.verdict_at).toBeNull();
});

test("setNotifyVerdict writes the verdict, note and time; null clears it", () => {
  const db = openDb(":memory:");
  insertNotifyLog(db, row({ decision: "sent" }));
  const id = listNotifyLog(db)[0].id;

  expect(setNotifyVerdict(db, id, "false_positive", "a background agent was running", 5_000)).toBe(true);
  let r = listNotifyLog(db)[0];
  expect(r.verdict).toBe("false_positive");
  expect(r.verdict_note).toBe("a background agent was running");
  expect(r.verdict_at).toBe(5_000);

  expect(setNotifyVerdict(db, id, null, null, 6_000)).toBe(true);
  r = listNotifyLog(db)[0];
  expect(r.verdict).toBeNull();
  expect(r.verdict_at).toBeNull();
});

test("setNotifyVerdict on a nonexistent id returns false", () => {
  const db = openDb(":memory:");
  expect(setNotifyVerdict(db, 999, "ok", null, 1)).toBe(false);
});

test('the "flagged" filter returns only flagged rows', () => {
  const db = openDb(":memory:");
  insertNotifyLog(db, row({ ts: 1_000, decision: "sent" }));
  insertNotifyLog(db, row({ ts: 2_000, decision: "deferred" }));
  const ids = listNotifyLog(db).map((r) => r.id);
  setNotifyVerdict(db, ids[1], "ok", null, 3_000);   // the older one (ts 1000)

  const flagged = listNotifyLog(db, { verdict: "flagged" });
  expect(flagged).toHaveLength(1);
  expect(flagged[0].ts).toBe(1_000);

  expect(listNotifyLog(db, { verdict: "ok" })).toHaveLength(1);
  expect(listNotifyLog(db, { verdict: "missing" })).toHaveLength(0);
});

test('the "decision" filter returns only rows with that decision', () => {
  const db = openDb(":memory:");
  insertNotifyLog(db, row({ ts: 1_000, decision: "armed" }));
  insertNotifyLog(db, row({ ts: 2_000, decision: "sent" }));
  insertNotifyLog(db, row({ ts: 3_000, decision: "deferred" }));
  insertNotifyLog(db, row({ ts: 4_000, decision: "sent" }));

  const sent = listNotifyLog(db, { decision: "sent" });
  expect(sent).toHaveLength(2);
  expect(sent.map((r) => r.ts)).toEqual([4_000, 2_000]);

  expect(listNotifyLog(db, { decision: "suppressed" })).toHaveLength(0);
});

test('the "decision" filter can be combined with session and verdict', () => {
  const db = openDb(":memory:");
  insertNotifyLog(db, row({ ts: 1_000, session_id: "dev-a", decision: "sent" }));
  insertNotifyLog(db, row({ ts: 2_000, session_id: "dev-b", decision: "sent" }));
  const combined = listNotifyLog(db, { session: "dev-a", decision: "sent" });
  expect(combined).toHaveLength(1);
  expect(combined[0].session_id).toBe("dev-a");
});

test("limit is clamped to the range 1..500", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 5; i++) insertNotifyLog(db, row({ ts: i }));
  expect(listNotifyLog(db, { limit: 2 })).toHaveLength(2);
  expect(listNotifyLog(db, { limit: 0 })).toHaveLength(1);
  expect(listNotifyLog(db, { limit: 9_999 })).toHaveLength(5);
});

test("pruneNotifyLog deletes rows older than the retention", () => {
  const db = openDb(":memory:");
  const now = Date.now();
  insertNotifyLog(db, row({ ts: now - 20 * 86_400_000 }));
  insertNotifyLog(db, row({ ts: now - 1_000 }));
  pruneNotifyLog(db, 14 * 86_400_000);
  expect(listNotifyLog(db)).toHaveLength(1);
});
