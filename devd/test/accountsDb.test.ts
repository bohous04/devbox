import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteAccount, getAccount, getAccountUsage, insertAccount, listAccountUsage,
  listAccounts, openDb, setAccountDisabled, setAccountQuarantined, setAccountLabel,
  setAccountWeight, upsertAccountUsage,
} from "../src/db";

function db() {
  const d = openDb(":memory:");
  insertAccount(d, { id: "primary", label: "a@example.com", disabled: 0, quarantined_at: null, added_at: 1000 });
  insertAccount(d, { id: "backup", label: "b@example.com", disabled: 0, quarantined_at: null, added_at: 2000 });
  return d;
}

test("accounts: insert + list in the order added", () => {
  const d = db();
  expect(listAccounts(d).map((a) => a.id)).toEqual(["primary", "backup"]);
  expect(getAccount(d, "primary")!.label).toBe("a@example.com");
  expect(getAccount(d, "nobody")).toBe(null);
});

test("accounts: disable and quarantine are independent toggles", () => {
  const d = db();
  setAccountDisabled(d, "backup", 1);
  expect(getAccount(d, "backup")!.disabled).toBe(1);
  expect(getAccount(d, "backup")!.quarantined_at).toBe(null);
  setAccountQuarantined(d, "backup", 5000);
  expect(getAccount(d, "backup")!.quarantined_at).toBe(5000);
  setAccountQuarantined(d, "backup", null);   // return from quarantine after a re-login
  expect(getAccount(d, "backup")!.quarantined_at).toBe(null);
  setAccountDisabled(d, "backup", 0);
  expect(getAccount(d, "backup")!.disabled).toBe(0);
});

test("usage: upsert overwrites the row, does not add a second one", () => {
  const d = db();
  upsertAccountUsage(d, {
    account_id: "primary", five_hour_pct: 12.5, five_hour_resets_at: 9000,
    seven_day_pct: 40, seven_day_resets_at: 99000, limits_json: '[{"kind":"session"}]',
    fetched_at: 1234, error: null,
  });
  upsertAccountUsage(d, {
    account_id: "primary", five_hour_pct: 91, five_hour_resets_at: 9500,
    seven_day_pct: 41, seven_day_resets_at: 99000, limits_json: "[]",
    fetched_at: 5678, error: null,
  });
  expect(listAccountUsage(d).length).toBe(1);
  const u = getAccountUsage(d, "primary")!;
  expect(u.five_hour_pct).toBe(91);
  expect(u.fetched_at).toBe(5678);
  expect(u.limits_json).toBe("[]");
});

test("usage: an error value is stored and the numbers may be NULL", () => {
  const d = db();
  upsertAccountUsage(d, {
    account_id: "backup", five_hour_pct: null, five_hour_resets_at: null,
    seven_day_pct: null, seven_day_resets_at: null, limits_json: null,
    fetched_at: 10, error: "HTTP 401",
  });
  const u = getAccountUsage(d, "backup")!;
  expect(u.error).toBe("HTTP 401");
  expect(u.five_hour_pct).toBe(null);
  expect(getAccountUsage(d, "primary")).toBe(null);
});

test("deleteAccount also deletes the measured data (no orphans)", () => {
  const d = db();
  upsertAccountUsage(d, {
    account_id: "backup", five_hour_pct: 1, five_hour_resets_at: null,
    seven_day_pct: 1, seven_day_resets_at: null, limits_json: null, fetched_at: 1, error: null,
  });
  deleteAccount(d, "backup");
  expect(listAccounts(d).map((a) => a.id)).toEqual(["primary"]);
  expect(getAccountUsage(d, "backup")).toBe(null);
});

test("weight: missing on insert → NULL; setAccountWeight sets and overwrites it", () => {
  const d = db();
  expect(getAccount(d, "primary")!.weight).toBe(null);
  setAccountWeight(d, "primary", 5);
  expect(getAccount(d, "primary")!.weight).toBe(5);
  setAccountWeight(d, "primary", 20);   // plan upgrade
  expect(getAccount(d, "primary")!.weight).toBe(20);
  setAccountWeight(d, "primary", null);   // the tier stopped being parseable
  expect(getAccount(d, "primary")!.weight).toBe(null);
  // the other account stays untouched
  expect(getAccount(d, "backup")!.weight).toBe(null);
});

test("weight: insertAccount stores it right away when given", () => {
  const d = openDb(":memory:");
  insertAccount(d, { id: "third", label: "c@example.com", disabled: 0, quarantined_at: null, added_at: 1, weight: 20 });
  expect(getAccount(d, "third")!.weight).toBe(20);
});

test("setAccountLabel overwrites the label independently of the other fields", () => {
  const d = db();
  setAccountLabel(d, "primary", "team@example.com (Max 5x)");
  expect(getAccount(d, "primary")!.label).toBe("team@example.com (Max 5x)");
  expect(getAccount(d, "primary")!.disabled).toBe(0);
});

// The live DB already HAS the `anthropic_accounts` table (without the `weight` column) — the migration must
// be purely additive (ALTER TABLE ADD COLUMN), not a re-create, otherwise the deployment
// would delete both live accounts. A simulation of exactly the schema BEFORE this feature.
test("migration: existing anthropic_accounts without the weight column → it is added, rows survive", () => {
  const path = join(tmpdir(), `devd-account-weight-migration-${process.pid}.sqlite`);
  rmSync(path, { force: true });
  const old = new Database(path);
  old.run(`CREATE TABLE anthropic_accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    quarantined_at INTEGER,
    added_at INTEGER NOT NULL)`);
  old.run(`INSERT INTO anthropic_accounts VALUES ('primary','team@example.com',0,NULL,1000)`);
  old.run(`INSERT INTO anthropic_accounts VALUES ('backup','user@example.com',0,NULL,2000)`);
  old.close();

  const migrated = openDb(path);   // the migration happens here
  const cols = (migrated.query("PRAGMA table_info(anthropic_accounts)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("weight");
  // the old data survived unchanged, the new weight is NULL (unknown until the poller runs)
  expect(listAccounts(migrated).map((a) => a.id)).toEqual(["primary", "backup"]);
  expect(getAccount(migrated, "primary")!.label).toBe("team@example.com");
  expect(getAccount(migrated, "primary")!.weight).toBe(null);
  setAccountWeight(migrated, "primary", 5);
  expect(getAccount(migrated, "primary")!.weight).toBe(5);
  migrated.close();
  rmSync(path, { force: true });
});
