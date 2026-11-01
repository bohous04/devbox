import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createProposal, listProposals, getProposal, setStatus, summarizeMariaDbResult } from "../src/prodWrites";

test("proposal lifecycle: pending → executed", () => {
  const db = openDb(":memory:");
  const id = createProposal(db, { session: "dev-shop-Ledger-App", db: "ledger_app", sql: "update x set y=1" });
  expect(getProposal(db, id)?.status).toBe("pending");
  expect(getProposal(db, id)?.sql).toBe("update x set y=1");
  expect(listProposals(db, { status: "pending" }).length).toBe(1);
  setStatus(db, id, "executed", { result: "1 row" });
  expect(getProposal(db, id)?.status).toBe("executed");
  expect(getProposal(db, id)?.result).toBe("1 row");
  expect(listProposals(db, { status: "pending" }).length).toBe(0);
});

test("reject: pending → rejected, drops out of pending", () => {
  const db = openDb(":memory:");
  const id = createProposal(db, { session: null, db: "ledger_app", sql: "delete from x" });
  setStatus(db, id, "rejected");
  expect(getProposal(db, id)?.status).toBe("rejected");
  expect(listProposals(db, { status: "pending" })).toHaveLength(0);
});

test("approved MariaDB SELECT output survives the existing stored result note", () => {
  const output = summarizeMariaDbResult([{ principal: "fixture@host", visible_triggers: "115" }], [{ name: "principal" }, { name: "visible_triggers" }]);
  const db = openDb(":memory:");
  const id = createProposal(db, { session: "fixture", db: "fixture", sql: "SELECT metadata", scope: "migration" });
  setStatus(db, id, "executed", { result: output.note });
  expect(output.rows).toBe(0);
  expect(getProposal(db, id)?.result).toContain('"visible_triggers":"115"');
  expect(output.note).toContain('"truncated":false');
});

test("driver fields distinguish SELECT affectedRows from command acknowledgements", () => {
  const selected = summarizeMariaDbResult([{ affectedRows: 17 }], [{ name: "affectedRows" }]);
  expect(selected.rows).toBe(0);
  expect(selected.note).toContain('"affectedRows":17');
  const written = summarizeMariaDbResult({ affectedRows: 3 });
  expect(written).toEqual({ rows: 3, note: "3 affected rows; MariaDB statements completed" });
});

test("multiple MariaDB statements retain rowsets and command affected counts separately", () => {
  const output = summarizeMariaDbResult([{ affectedRows: 2 }, [{ count: "7" }], []], [undefined, [{ name: "count" }], [{ name: "empty" }]]);
  expect(output.rows).toBe(2);
  expect(output.note).toContain('"statement":2');
  expect(output.note).toContain('"count":"7"');
  expect(output.note).toContain('"statement":3');
  expect(output.note).toContain('"returnedRows":0');
});

test("persisted MariaDB output marks row and byte limits instead of claiming complete metadata", () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: i }));
  const output = summarizeMariaDbResult(rows, [{ name: "id" }]);
  expect(output.note).toContain('"returnedRows":101');
  expect(output.note).toContain('"truncated":true');
  expect(output.note).not.toContain('"id":100');
  const large = summarizeMariaDbResult([{ body: "x".repeat(100_000) }], [{ name: "body" }]);
  expect(Buffer.byteLength(large.note)).toBeLessThan(65_536);
  expect(large.note).toContain('"truncated":true');
  expect(large.note).toContain('"returnedRows":1');
});

test("diagnostic output preserves big integers and bounds the number of result sets", () => {
  const large = summarizeMariaDbResult([{ id: 9007199254740993n }], [{ name: "id" }]);
  expect(large.note).toContain('"id":"9007199254740993"');
  const output = summarizeMariaDbResult(Array.from({ length: 9 }, () => [{ value: 1 }]), Array.from({ length: 9 }, () => [{ name: "value" }]));
  expect(output.note).toContain('"truncated":true');
  expect(output.note).not.toContain('"statement":9');
});
