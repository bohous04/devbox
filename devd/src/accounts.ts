// The bridge between the ledger and the API: DB rows → candidates for the policy and views for
// the dashboard. Tokens never get here — the DB has none and the profile is not read here.

import type { Database } from "bun:sqlite";
import type { AccountCandidate } from "./accountPolicy";
import type { UsageLimit } from "./accountUsage";
import {
  activeLeases, listAccountUsage, listAccounts, type AccountUsageRow, type LeaseClient,
} from "./db";

export interface AccountLeaseView {
  client: LeaseClient; sessionId: string | null; label: string | null; createdAt: number;
}

export interface AccountView {
  id: string; label: string;
  disabled: boolean; quarantined: boolean;
  fiveHourPct: number | null; fiveHourResetsAt: number | null;
  sevenDayPct: number | null; sevenDayResetsAt: number | null;
  limits: UsageLimit[];
  fetchedAt: number | null; error: string | null;
  // How many polls IN A ROW ended with an error (0 = the last measurement succeeded). The UI uses
  // it to tell a transient hiccup (429 under concurrent clients — clears on its own in a few
  // attempts) from an outage that deserves a red message. `error` alone does not carry that: it is
  // the same for the first and the fiftieth error.
  errorCount: number;
  // The account identity in TWO forms, deliberately side by side: `orgId` is the organization
  // recorded when the account was set up (or when credentials were replaced), `observedOrgId` the
  // one the API admitted on the last successful measurement. Deciding whether they
  // diverged belongs to the view layer (accountsView.identityIssues) — devd only provides
  // both values, because "two accounts point to the same organization" can only be detected over
  // the WHOLE list, not over one row.
  orgId: string | null; observedOrgId: string | null;
  leases: AccountLeaseView[];
}

function parseLimits(json: string | null): UsageLimit[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v as UsageLimit[] : [];
  } catch { return []; }
}

function usageMap(db: Database): Map<string, AccountUsageRow> {
  return new Map(listAccountUsage(db).map((u) => [u.account_id, u]));
}

/** A permanently failing account: it HAS a row in `account_usage`, that row carries `error`,
 *  and yet it never recorded a single measured window (both percentages null). Typically a deleted
 *  or unavailable volume (`docker volume rm`, or a crash between `removeProfile` and
 *  `deleteAccount`) — accountPoller.ts deliberately does NOT quarantine it (it cannot tell
 *  "the volume is gone" from "docker hiccuped just now"), so the state never fixes itself.
 *
 *  Without this distinction `AccountCandidate.fiveHourPct: null` would end up in
 *  chooseAccount as `effPct` 0 — "the freest" of all — and the broken account would
 *  win EVERY lease forever, while healthy accounts stayed unused. That is NOT
 *  the same as a freshly added account that has no row in `account_usage` yet
 *  (`u === undefined`) — that one stays a candidate, that is the deliberate bootstrap contract
 *  of Task 5 (accountPolicy.test.ts: "an unmeasured account counts as empty (a freshly
 *  added one should get work)"). Nor is it a transient error on an account that has
 *  measured something BEFORE (`error` set, but some percentage remained from the
 *  last success) — that one keeps being sorted by the last known numbers, not by
 *  zero, exactly as a transient error should work.
 *
 *  Exported and on CAMEL CASE fields (not on the raw `AccountUsageRow`), so it can
 *  also be called over `AccountView` (accountAlerts.ts, review round 4, I6) without changing
 *  the shape — otherwise a permanently failing account could also win a switch recommendation,
 *  even though `toCandidates` (and hence `chooseAccount`) excludes it in principle and
 *  `dev switch` would never go to it. `AccountCandidate` (accountPolicy.ts) has no
 *  `error` field — so filtering MUST happen here, before the candidate is built, not in
 *  the pure policy of Task 5. */
export function permanentlyUnmeasured(
  u: { error: string | null; fiveHourPct: number | null; sevenDayPct: number | null } | undefined,
): boolean {
  return u !== undefined && u.error !== null && u.fiveHourPct === null && u.sevenDayPct === null;
}

function unmeasuredCheck(u: AccountUsageRow | undefined) {
  return u && { error: u.error, fiveHourPct: u.five_hour_pct, sevenDayPct: u.seven_day_pct };
}

/** Candidates for the policy. Permanently failing accounts (see `permanentlyUnmeasured`)
 *  never make it into the returned array; the operator still sees them in AccountView
 *  (`error`, `fetchedAt`) and can remove them by hand via POST /api/accounts/:id/disable
 *  — this function only prevents the policy from preferring them by mistake. */
export function toCandidates(db: Database): AccountCandidate[] {
  const usage = usageMap(db);
  return listAccounts(db)
    .filter((a) => !permanentlyUnmeasured(unmeasuredCheck(usage.get(a.id))))
    .map((a) => {
      const u = usage.get(a.id);
      return {
        id: a.id, label: a.label,
        disabled: a.disabled === 1,
        quarantined: a.quarantined_at !== null,
        fiveHourPct: u?.five_hour_pct ?? null, fiveHourResetsAt: u?.five_hour_resets_at ?? null,
        sevenDayPct: u?.seven_day_pct ?? null, sevenDayResetsAt: u?.seven_day_resets_at ?? null,
      };
    });
}

/** Account state for the dashboard, including which sessions are currently running on each account. */
export function buildAccountViews(db: Database, now: number, leaseMaxAgeMs: number): AccountView[] {
  const usage = usageMap(db);
  const byAccount = new Map<string, AccountLeaseView[]>();
  for (const l of activeLeases(db, now, leaseMaxAgeMs)) {
    const arr = byAccount.get(l.account_id) ?? [];
    arr.push({ client: l.client, sessionId: l.session_id, label: l.label, createdAt: l.created_at });
    byAccount.set(l.account_id, arr);
  }
  return listAccounts(db).map((a) => {
    const u = usage.get(a.id);
    return {
      id: a.id, label: a.label,
      disabled: a.disabled === 1,
      quarantined: a.quarantined_at !== null,
      fiveHourPct: u?.five_hour_pct ?? null, fiveHourResetsAt: u?.five_hour_resets_at ?? null,
      sevenDayPct: u?.seven_day_pct ?? null, sevenDayResetsAt: u?.seven_day_resets_at ?? null,
      limits: parseLimits(u?.limits_json ?? null),
      fetchedAt: u?.fetched_at ?? null, error: u?.error ?? null,
      errorCount: u?.error_count ?? 0,
      orgId: a.org_id ?? null, observedOrgId: u?.org_id ?? null,
      leases: byAccount.get(a.id) ?? [],
    };
  });
}
