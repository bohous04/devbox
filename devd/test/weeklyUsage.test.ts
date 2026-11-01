import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, insertAccount, upsertAccountUsage, upsertGrokUsage } from "../src/db";
import { buildWeeklyUsage, claudeWeeklyUsage, codexWeeklyUsage, migrateWeeklyUsage, recordWeeklyUsage, weeklyUsageFailed, weeklyUsageRange } from "../src/weeklyUsage";
import { parseGrokBilling } from "../src/grokUsageFetch";

const NOW = 1800000000000;
const DAY_MS = 86_400_000;
const weekly = (percentUsed: number, resetsAt = NOW + 86400_000) => [{ window: "weekly", percentUsed, resetsAt }];

test("weekly-only extraction excludes 5h, monthly and Grok pay-as-you-go", () => {
  expect(claudeWeeklyUsage({ fiveHourPct: 95, fiveHourResetsAt: NOW, sevenDayPct: 30, sevenDayResetsAt: NOW + 10, limits: [{kind:"session",percent:95,severity:null,resetsAt:NOW,modelName:null,isActive:true},{kind:"weekly_scoped",percent:40,severity:null,resetsAt:NOW + 10,modelName:"Opus",isActive:true}] })).toEqual([{window:"weekly_scoped:Opus",percentUsed:40,resetsAt:NOW+10},{window:"weekly_all",percentUsed:30,resetsAt:NOW+10}]);
  expect(codexWeeklyUsage([{kind:"primary",usedPct:90,windowMinutes:300,resetsAt:NOW},{kind:"secondary",usedPct:20,windowMinutes:10080,resetsAt:NOW+10}])).toEqual([{window:"secondary",percentUsed:20,resetsAt:NOW+10}]);
  const billing = (type: string, pct?: number) => parseGrokBilling({config:{currentPeriod:{type,end:new Date(NOW+10).toISOString()},creditUsagePercent:pct,onDemandCap:{val:100},onDemandUsed:{val:80}}});
  expect(billing("USAGE_PERIOD_TYPE_WEEKLY",35)?.weekly).toEqual({usedPct:35,resetsAt:NOW+10});
  expect(billing("USAGE_PERIOD_TYPE_MONTHLY",35)?.weekly).toBeUndefined();
  expect(billing("USAGE_PERIOD_TYPE_WEEKLY")?.weekly).toBeUndefined();
  expect(billing("USAGE_PERIOD_TYPE_WEEKLY",150)?.weekly).toBeUndefined();
});

test("accounts and replaced auth identities never merge; failed reads never create samples", () => {
  const db = openDb(":memory:");
  recordWeeklyUsage(db,"codex","a","First","org-a",NOW,weekly(90));
  recordWeeklyUsage(db,"codex","b","Second","org-b",NOW,weekly(20));
  recordWeeklyUsage(db,"codex","a","Replacement","org-c",NOW+1,weekly(2));
  recordWeeklyUsage(db,"codex","a","Replacement","org-c",NOW+1,weekly(2));
  weeklyUsageFailed(db,"codex","b");
  const accounts = buildWeeklyUsage(db,NOW-1,NOW+2,NOW+2).accounts.filter(a=>a.identityKey!=="unmeasured");
  expect(accounts).toHaveLength(3);
  expect(accounts.find(a=>a.accountLabel.startsWith("First"))?.state).toBe("stale");
  expect(accounts.find(a=>a.accountLabel==="Replacement")?.history.map(p=>p.percentUsed)).toEqual([2]);
  expect(accounts.find(a=>a.accountId==="b")?.state).toBe("error");
  expect(accounts.find(a=>a.accountId==="b")?.history).toHaveLength(1);
  expect(JSON.stringify(accounts)).not.toContain("org-");
});

test("history includes boundary reset marker from earlier observation, not fabricated reading", () => {
  const db = openDb(":memory:");
  recordWeeklyUsage(db,"grok","default","GR","identity",NOW-1000,weekly(100,NOW+100));
  const a = buildWeeklyUsage(db,NOW,NOW+200,NOW+200).accounts.find(a=>a.provider==="grok")!;
  expect(a.history).toEqual([]);
  expect(a.resets).toEqual([{window:"weekly",resetsAt:NOW+100}]);
  expect(a.state).toBe("stale");
  expect(a.latest[0]!.percentUsed).toBe(100);
});

test("additive migration preserves account pool data and seeds only trusted successful identity", () => {
  const db = openDb(":memory:");
  db.exec("DROP TABLE weekly_usage_samples; DROP TABLE weekly_usage_accounts;");
  for (const [id, observed, error] of [["good","org-good",null],["wrong","other-org",null],["failed","org-failed","offline"]] as const) {
    insertAccount(db,{id,label:id,disabled:0,quarantined_at:null,added_at:NOW-100,org_id:`org-${id}`});
    upsertAccountUsage(db,{account_id:id,five_hour_pct:99,five_hour_resets_at:NOW,seven_day_pct:20,seven_day_resets_at:NOW+1000,limits_json:null,fetched_at:NOW,error,org_id:observed});
  }
  const before = db.query("SELECT * FROM account_usage ORDER BY account_id").all();
  migrateWeeklyUsage(db); migrateWeeklyUsage(db);
  expect(db.query("SELECT * FROM account_usage ORDER BY account_id").all()).toEqual(before);
  expect(db.query("SELECT * FROM anthropic_accounts").all()).toHaveLength(3);
  const sampled = buildWeeklyUsage(db,NOW-1,NOW+1,NOW).accounts.filter(a=>a.history.length);
  expect(sampled.map(a=>a.accountId)).toEqual(["good"]);
  expect(sampled[0]!.history).toHaveLength(1);
});

test("unknown identity and invalid percentages never become chart readings", () => {
  const db = openDb(":memory:");
  recordWeeklyUsage(db,"claude","a","A",null,NOW,weekly(20));
  recordWeeklyUsage(db,"claude","a","A","org",NOW,[...weekly(-1),...weekly(101)]);
  expect(db.query("SELECT * FROM weekly_usage_samples").all()).toEqual([]);
});

test("query supports 7/30/90d and bounded explicit dates", () => {
  for (const days of [7,30,90]) expect(weeklyUsageRange({days:String(days)},NOW)).toEqual({from:NOW-days*86400_000,to:NOW});
  expect(weeklyUsageRange({from:String(NOW-1000),to:String(NOW)},NOW)).toEqual({from:NOW-1000,to:NOW});
  for (const query of [{days:"91"},{days:"0"},{from:"bad"},{from:String(NOW),to:String(NOW-1)},{to:String(NOW+86400_000)}]) expect(weeklyUsageRange(query,NOW)).toBeNull();
});


test("empty CO registry still exposes main account; deleted account history is archived", () => {
  const db = openDb(":memory:");
  db.exec("CREATE TABLE codex_accounts(id TEXT PRIMARY KEY,label TEXT,identity TEXT)");
  recordWeeklyUsage(db,"codex","deleted","Removed","org-deleted",NOW,weekly(12));
  const accounts = buildWeeklyUsage(db,NOW-1,NOW+1,NOW).accounts;
  expect(accounts.find(a=>a.provider==="codex" && a.accountId==="default")?.state).toBe("unavailable");
  const old = accounts.find(a=>a.accountId==="deleted")!;
  expect(old.archived).toBe(true);
  expect(old.state).toBe("stale");
  expect(old.accountLabel).toContain("removed account");
});

test("registered identity replacement archives history before the next quota poll", () => {
  const db = openDb(":memory:");
  insertAccount(db,{id:"pool",label:"New account",disabled:0,quarantined_at:null,added_at:NOW,org_id:"new-org"});
  recordWeeklyUsage(db,"claude","pool","Old account","old-org",NOW,weekly(80));
  const accounts = buildWeeklyUsage(db,NOW-1,NOW+1,NOW).accounts.filter(a=>a.accountId==="pool");
  expect(accounts).toHaveLength(2);
  expect(accounts.find(a=>a.archived)?.accountLabel).toContain("previous login");
  expect(accounts.find(a=>!a.archived)?.state).toBe("unavailable");
});

test("an expired Grok login has the fix in the detail, not a generic collection error", () => {
  const db = openDb(":memory:");
  const NOW = 1_790_000_000_000;
  recordWeeklyUsage(db,"grok","default","Grok Build","identity",NOW-1000,[{window:"weekly",percentUsed:10,resetsAt:NOW+86_400_000}]);
  weeklyUsageFailed(db,"grok","default");
  const grok = () => buildWeeklyUsage(db,NOW-86_400_000,NOW,NOW).accounts.find(a=>a.provider==="grok")!;
  expect(grok().detail).toBe("The account collector could not refresh usage");
  upsertGrokUsage(db,{singleton:1,state:"stale-login",tier:null,used_pct:null,resets_at:null,fetched_at:NOW,error:null});
  expect(grok().state).toBe("error");
  expect(grok().detail).toContain("run gr");
});

test("a reset with millisecond jitter (Claude: now + remaining seconds) is one reset, not hundreds", () => {
  const db = openDb(":memory:");
  const R1 = NOW + 3 * DAY_MS, R2 = NOW + 10 * DAY_MS;
  // the same reset reported a few hundred ms differently each time, then a real next reset
  for (let i = 0; i < 50; i++) recordWeeklyUsage(db,"claude","acc","Personal","org-a",NOW + i * 60_000,[{window:"weekly_all",percentUsed:i,resetsAt:R1 + (i * 37) % 1900}]);
  recordWeeklyUsage(db,"claude","acc","Personal","org-a",NOW + 4 * DAY_MS,[{window:"weekly_all",percentUsed:1,resetsAt:R2 + 300}]);
  const a = buildWeeklyUsage(db,NOW,NOW + 11 * DAY_MS,NOW + 4 * DAY_MS).accounts.find(a=>a.accountId==="acc")!;
  expect(a.resets).toEqual([{window:"weekly_all",resetsAt:R1},{window:"weekly_all",resetsAt:R2 + 300}]);
  expect(new Set(a.history.map(p=>p.resetsAt))).toEqual(new Set([R1, R2 + 300]));
  expect(a.latest[0]!.resetsAt).toBe(R2 + 300);
});
