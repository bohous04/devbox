import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { getOperation, listOperations, proposeOperation, setOperationStatus } from "../src/operationStore";

test("a proposal is stored as pending together with its parameters", () => {
  const db = openDb(":memory:");
  const id = proposeOperation(db, { session: "dev-a-b", op: "deploy", params: { project: "shop" } });
  const row = getOperation(db, id)!;
  expect(row.status).toBe("pending");
  expect(JSON.parse(row.params)).toEqual({ project: "shop" });
  expect(row.session_id).toBe("dev-a-b");
});

test("status and result can be written", () => {
  const db = openDb(":memory:");
  const id = proposeOperation(db, { session: null, op: "deploy", params: { project: "shop" } });
  setOperationStatus(db, id, "executed", { result: "deployed" });
  const row = getOperation(db, id)!;
  expect(row.status).toBe("executed");
  expect(row.result).toBe("deployed");
  expect(row.decided_at).toBeGreaterThan(0);
});

test("the status filter returns only matching rows", () => {
  const db = openDb(":memory:");
  const a = proposeOperation(db, { session: null, op: "deploy", params: { project: "shop" } });
  proposeOperation(db, { session: null, op: "deploy", params: { project: "metro" } });
  setOperationStatus(db, a, "rejected");
  expect(listOperations(db, { status: "pending" }).length).toBe(1);
});

test("an unknown id returns undefined instead of crashing", () => {
  expect(getOperation(openDb(":memory:"), 999)).toBeUndefined();
});
