import { expect, test } from "bun:test";
import { toCandidates } from "../src/accounts";
import { insertAccount, openDb, upsertAccountUsage, type AccountUsageRow } from "../src/db";

const NOW = 1_800_000_000_000;

function acct(db: ReturnType<typeof openDb>, id: string): void {
  insertAccount(db, { id, label: `${id}@x.cz`, disabled: 0, quarantined_at: null, added_at: 1 });
}

const row = (over: Partial<AccountUsageRow> & { account_id: string }): AccountUsageRow => ({
  five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null,
  limits_json: null, fetched_at: NOW, error: null, ...over,
});

test("toCandidates: a freshly added account (no row in account_usage) stays a candidate", () => {
  const db = openDb(":memory:");
  acct(db, "fresh");
  const cands = toCandidates(db);
  expect(cands.map((c) => c.id)).toEqual(["fresh"]);
  expect(cands[0]!.fiveHourPct).toBeNull();
});

test("toCandidates: a permanently failing account (error + NEVER any measured percentage) is excluded", () => {
  const db = openDb(":memory:");
  acct(db, "healthy");
  acct(db, "broken");
  upsertAccountUsage(db, row({ account_id: "healthy", five_hour_pct: 30, seven_day_pct: 5 }));
  upsertAccountUsage(db, row({ account_id: "broken", error: "profile cannot be read (volume deleted)" }));
  expect(toCandidates(db).map((c) => c.id)).toEqual(["healthy"]);
});

test("toCandidates: a transient error AFTER a successful measurement does not exclude the account", () => {
  const db = openDb(":memory:");
  acct(db, "flaky");
  upsertAccountUsage(db, row({
    account_id: "flaky", five_hour_pct: 42, seven_day_pct: 5,
    error: "reading quota failed: HTTP 503",
  }));
  const cands = toCandidates(db);
  expect(cands.map((c) => c.id)).toEqual(["flaky"]);
  expect(cands[0]!.fiveHourPct).toBe(42);
});

