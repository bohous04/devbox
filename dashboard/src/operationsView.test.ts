import { expect, test } from "bun:test";
import { operationReview, operationStatus, opSummary, pendingFirst, type OpRow } from "./operationsView";

const row = (over: Partial<OpRow> = {}): OpRow => ({
  id: 1, ts: 0, session_id: null, op: "deploy", params: '{"project":"shop"}',
  status: "pending", decided_at: null, result: null, error: null, ...over,
});

test("pending proposals are on top", () => {
  const rows = [row({ id: 1, status: "executed" }), row({ id: 2, status: "pending" })];
  expect(pendingFirst(rows).map((r) => r.id)).toEqual([2, 1]);
});

test("among equal states the newest is first", () => {
  const rows = [row({ id: 1, status: "pending" }), row({ id: 3, status: "pending" })];
  expect(pendingFirst(rows).map((r) => r.id)).toEqual([3, 1]);
});

test("the summary shows the operation and parameters readably", () => {
  expect(opSummary(row())).toBe("deploy · project=shop");
});

test("an operation without parameters is not shown with an empty dot", () => {
  expect(opSummary(row({ params: "{}" }))).toBe("deploy");
});

test("broken params do not break the summary", () => {
  expect(opSummary(row({ params: "{this is not json" }))).toBe("deploy · (unreadable parameters)");
});

test("sorting does not modify the original array", () => {
  const rows = [row({ id: 1, status: "executed" }), row({ id: 2, status: "pending" })];
  pendingFirst(rows);
  expect(rows.map((r) => r.id)).toEqual([1, 2]);
});


test("deployment review exposes exact changes and the SQL dependency separately", () => {
  const r = row({ params: JSON.stringify({ application: "billing", afterWrite: "12", changes: JSON.stringify(["Deploy commit abc to production"]) }), status: "approved" });
  expect(operationReview(r)).toEqual({ changes: ["Deploy commit abc to production"], afterWrite: 12, requestId: null, problem: null });
  expect(opSummary(r)).not.toContain("changes=");
  expect(operationStatus(r)).toBe("Approved · waiting for SQL #12");
  expect(operationStatus({ ...r, status: "running" })).toBe("Running");
});

test("invalid review details block approval rather than disappearing", () => {
  const r = row({ params: JSON.stringify({ changes: "invalid json" }) });
  expect(operationReview(r).problem).toContain("could not be read");
});
