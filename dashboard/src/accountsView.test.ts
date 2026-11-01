import { expect, test } from "bun:test";
import {
  accountStatus, identityIssues, leaseSummary, measuredLabel, modelRows, pinnedProjects, poolRole,
  POOL_ROLE_LABEL, resetCountdown, splitTierLabel, usageErrorView, usageSeverity,
} from "./accountsView";
import type { AccountPoolView, AccountView } from "./api";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const acc = (over: Partial<AccountView> = {}): AccountView => ({
  id: "primary", label: "a@x.cz", disabled: false, quarantined: false,
  fiveHourPct: 20, fiveHourResetsAt: NOW + 30 * MIN,
  sevenDayPct: 30, sevenDayResetsAt: NOW + 2000 * MIN,
  limits: [], fetchedAt: NOW - MIN, error: null, errorCount: 0, orgId: null, observedOrgId: null, leases: [], ...over,
});

test("usageSeverity: threshold = danger, 20 pp below it = warn", () => {
  expect(usageSeverity(0)).toBe("ok");
  expect(usageSeverity(69)).toBe("ok");
  expect(usageSeverity(70)).toBe("warn");
  expect(usageSeverity(89.9)).toBe("warn");
  expect(usageSeverity(90)).toBe("danger");
  expect(usageSeverity(100)).toBe("danger");
  // unmeasured is neither "fine" nor "trouble" — it shows as ok, but without a number
  expect(usageSeverity(null)).toBe("ok");
  // a different threshold from config shifts both boundaries
  expect(usageSeverity(80, 80)).toBe("danger");
  expect(usageSeverity(65, 80)).toBe("warn");
});

test("resetCountdown: minutes, hours, days, after reset and with no value", () => {
  expect(resetCountdown(NOW + 45 * MIN, NOW)).toBe("resets in 45m");
  expect(resetCountdown(NOW + 150 * MIN, NOW)).toBe("resets in 2h 30m");
  expect(resetCountdown(NOW + 3000 * MIN, NOW)).toBe("resets in 2d 2h");
  expect(resetCountdown(NOW - MIN, NOW)).toBe("reset due");
  expect(resetCountdown(null, NOW)).toBe("—");
});

test("accountStatus: quarantine and error override everything else", () => {
  expect(accountStatus(acc())).toEqual({ text: "Active", tone: "ok" });
  expect(accountStatus(acc({ disabled: true }))).toEqual({ text: "Disabled", tone: "warn" });
  expect(accountStatus(acc({ quarantined: true }))).toEqual({ text: "Re-login needed", tone: "danger" });
  // quarantine takes precedence even over disabled
  expect(accountStatus(acc({ quarantined: true, disabled: true })).text).toBe("Re-login needed");
  expect(accountStatus(acc({ error: "usage read failed: HTTP 500" }))).toEqual({ text: "Usage unavailable", tone: "warn" });
  expect(accountStatus(acc({ fiveHourPct: 95 }))).toEqual({ text: "Exhausted", tone: "danger" });
  expect(accountStatus(acc({ sevenDayPct: 91 })).text).toBe("Exhausted");
});

// A 429 from /api/oauth/usage is operational noise (several clients from one IP measure the same
// quota; the poller retries in ~30 s) — the card must not switch to "Usage unavailable" and show
// a red message because of it, unless the error persists across several polls in a row.
// The numbers on the card are the last known ones during an error anyway (recordError keeps them).
test("accountStatus: a transient 429 keeps the badge based on the last known numbers", () => {
  expect(accountStatus(acc({ error: "usage read failed: HTTP 429", errorCount: 1 })).text).toBe("Active");
  expect(accountStatus(acc({ error: "usage read failed: HTTP 429", errorCount: 2, fiveHourPct: 95 })).text).toBe("Exhausted");
  // a persistent 429 (≥ 5 polls in a row ≈ over 7 minutes of backoff) IS an outage
  expect(accountStatus(acc({ error: "usage read failed: HTTP 429", errorCount: 5 })).text).toBe("Usage unavailable");
  // any other error is "Usage unavailable" immediately — only rate limits get the transient window
  expect(accountStatus(acc({ error: "usage read failed: HTTP 503", errorCount: 1 })).text).toBe("Usage unavailable");
  // older devd without errorCount → field missing → behave as before (error = unavailable)
  expect(accountStatus(acc({ error: "usage read failed: HTTP 429", errorCount: undefined as unknown as number })).text)
    .toBe("Active");
});

test("usageErrorView: a 429 in the transient window is a quiet sentence, not a raw error", () => {
  expect(usageErrorView(null, 0)).toBeNull();
  const t = usageErrorView("usage read failed: HTTP 429", 1)!;
  expect(t.transient).toBe(true);
  expect(t.text).toContain("retrying");
  // a persistent 429 and any other error: verbatim text, so the problem can be traced
  expect(usageErrorView("usage read failed: HTTP 429", 5))
    .toEqual({ transient: false, text: "usage read failed: HTTP 429" });
  expect(usageErrorView("profile cannot be read", 1))
    .toEqual({ transient: false, text: "profile cannot be read" });
});

test("leaseSummary: what runs on the account, in English", () => {
  expect(leaseSummary(acc())).toBe("idle");
  expect(leaseSummary(acc({ leases: [{ client: "mac", sessionId: null, label: "vpsbetter", createdAt: NOW }] })))
    .toBe("Mac · vpsbetter");
  expect(leaseSummary(acc({ leases: [
    { client: "devbox", sessionId: "dev-x-y", label: "x/y", createdAt: NOW },
    { client: "mac", sessionId: null, label: null, createdAt: NOW },
  ] }))).toBe("Devbox · x/y, Mac");
});

test("modelRows: per-model windows only, sorted from the busiest", () => {
  const a = acc({ limits: [
    { kind: "session", percent: 20, severity: "ok", resetsAt: null, modelName: null, isActive: true },
    { kind: "weekly_scoped", percent: 5, severity: "ok", resetsAt: null, modelName: "Fable", isActive: true },
    { kind: "weekly_scoped", percent: 60, severity: "warn", resetsAt: null, modelName: "Opus", isActive: true },
    { kind: "weekly_scoped", percent: 1, severity: "ok", resetsAt: null, modelName: null, isActive: true },
  ] });
  expect(modelRows(a)).toEqual([{ model: "Opus", percent: 60 }, { model: "Fable", percent: 5 }]);
  expect(modelRows(acc())).toEqual([]);
});

// ---------------------------------------------------------------------------
// Pool settings from the API: the dashboard must not guess them.
// ---------------------------------------------------------------------------

const pool = (over: Partial<AccountPoolView> = {}): AccountPoolView => ({
  thresholdPct: 90, spilloverPct: 60, preferredAccountId: "max20",
  projectAccounts: {}, soloAccountId: null, ...over,
});

test("usageSeverity and accountStatus respect the configured threshold, not a hardcoded 90", () => {
  // With thresholdPct=70, 72 % is already danger, even though against 90 it would only be warn.
  expect(usageSeverity(72, 70)).toBe("danger");
  expect(usageSeverity(72)).toBe("warn");
  expect(accountStatus(acc({ fiveHourPct: 72 }), 70).text).toBe("Exhausted");
  expect(accountStatus(acc({ fiveHourPct: 72 })).text).toBe("Active");
});

test("splitTierLabel: splits the plan from the name, returns the label unchanged without a suffix", () => {
  expect(splitTierLabel("user@example.com (Max 20x)")).toEqual({ name: "user@example.com", tier: "Max 20x" });
  expect(splitTierLabel("team@example.com (Max 5x)")).toEqual({ name: "team@example.com", tier: "Max 5x" });
  // An account the poller has not assigned a plan to yet (or it is unparseable).
  expect(splitTierLabel("team@example.com")).toEqual({ name: "team@example.com", tier: null });
  // A parenthesis that is not a plan must not be cut off.
  expect(splitTierLabel("team@example.com (work)")).toEqual({ name: "team@example.com (work)", tier: null });
});

test("poolRole: without a set preference the role is meaningless", () => {
  expect(poolRole(acc({ id: "max20" }), pool({ preferredAccountId: null }), NOW)).toBe(null);
});

test("poolRole: the preferred account below the threshold is 'preferred', above it 'spilling'", () => {
  expect(poolRole(acc({ id: "max20", fiveHourPct: 10, sevenDayPct: 10 }), pool(), NOW)).toBe("preferred");
  expect(poolRole(acc({ id: "max20", fiveHourPct: 60, sevenDayPct: 10 }), pool(), NOW)).toBe("spilling");
  // ONE window is enough — here only the weekly one (both windows, whichever comes first).
  expect(poolRole(acc({ id: "max20", fiveHourPct: 10, sevenDayPct: 60 }), pool(), NOW)).toBe("spilling");
});

test("poolRole: other accounts are 'backup'", () => {
  expect(poolRole(acc({ id: "max5", fiveHourPct: 0 }), pool(), NOW)).toBe("backup");
});

// M8 (final review): solo mode overrides the preference in chooseAccount (allowedAccounts)
// — the PREFERRED/BACKUP badge would lie at that point.
test("poolRole: with solo mode on, no role is shown even when a preference is set (M8)", () => {
  const solo = pool({ preferredAccountId: "max20", soloAccountId: "max20" });
  expect(poolRole(acc({ id: "max20", fiveHourPct: 10, sevenDayPct: 10 }), solo, NOW)).toBe(null);
  expect(poolRole(acc({ id: "max5", fiveHourPct: 0 }), solo, NOW)).toBe(null);
});

test("poolRole: after the reset passes, 'spilling' closes again (effPct, not the stale value)", () => {
  // 99 % in the DB, but the reset already happened → the window is actually empty. Without effPct
  // the badge would show "spilling" until the poller's next measurement.
  const a = acc({ id: "max20", fiveHourPct: 99, fiveHourResetsAt: NOW - 1, sevenDayPct: 5 });
  expect(poolRole(a, pool(), NOW)).toBe("preferred");
});

test("POOL_ROLE_LABEL covers all roles", () => {
  expect(POOL_ROLE_LABEL.preferred).toBe("PREFERRED");
  expect(POOL_ROLE_LABEL.spilling).toBe("SPILLING OVER");
  expect(POOL_ROLE_LABEL.backup).toBe("BACKUP");
});

test("pinnedProjects: returns projects pinned to the given account, alphabetically", () => {
  const pool = { projectAccounts: { websites: "max20", games: "max5", apps: "max20" } };
  expect(pinnedProjects("max20", pool)).toEqual(["apps", "websites"]);
  expect(pinnedProjects("max5", pool)).toEqual(["games"]);
  expect(pinnedProjects("neexistuje", pool)).toEqual([]);
});

test("measuredLabel: tells a fresh measurement from a frozen one", () => {
  const now = 1_800_000_000_000;
  expect(measuredLabel(null, now)).toBe("never measured");
  expect(measuredLabel(now - 5_000, now)).toBe("measured just now");
  expect(measuredLabel(now - 12 * 60_000, now)).toBe("measured 12 min ago");
  expect(measuredLabel(now - 3 * 3600_000, now)).toBe("measured 3 h ago");
});

/* ---------- account identity ---------- */

const idAcc = (id: string, orgId: string | null, observedOrgId: string | null): AccountView => ({
  id, label: `${id}@x.cz`, disabled: false, quarantined: false,
  fiveHourPct: 10, fiveHourResetsAt: null, sevenDayPct: 10, sevenDayResetsAt: null,
  limits: [], fetchedAt: NOW, error: null, errorCount: 0, orgId, observedOrgId, leases: [],
});

test("identityIssues: a healthy pool reports nothing", () => {
  const m = identityIssues([idAcc("max5", "org-A", "org-A"), idAcc("max20", "org-B", "org-B")]);
  expect(m.size).toBe(0);
});

// Exactly the state from 2026-08-19: both profiles answered as user@example.com, but
// `orgId` was not yet recorded for either (old row), so drift has nothing to rely on —
// the duplicate is the only thing that reveals that state.
test("identityIssues: two accounts on the same organization = the pool runs on one", () => {
  const m = identityIssues([idAcc("max5", null, "org-A"), idAcc("max20", null, "org-A")]);
  expect(m.get("max5")).toMatchObject({ kind: "duplicate", text: "Same account as max20" });
  expect(m.get("max20")).toMatchObject({ kind: "duplicate", text: "Same account as max5" });
});

test("identityIssues: a switched profile is reported as drift, not as a duplicate", () => {
  const m = identityIssues([idAcc("max5", "org-B", "org-A"), idAcc("max20", "org-A", "org-A")]);
  // max5 knows its registered organization → gets a message saying what happened
  expect(m.get("max5")!.kind).toBe("drifted");
  // max20 is innocent, but the pool still effectively has one account
  expect(m.get("max20")!.kind).toBe("duplicate");
});

// "Unmeasured" is NOT a value to group on — otherwise two freshly added accounts
// (both null) would report a duplicate before anyone measured them for the first time.
test("identityIssues: unmeasured accounts are not grouped", () => {
  expect(identityIssues([idAcc("a", null, null), idAcc("b", null, null)]).size).toBe(0);
});

test("identityIssues: a missing registered organization alone is not an error", () => {
  expect(identityIssues([idAcc("a", null, "org-A"), idAcc("b", "org-B", "org-B")]).size).toBe(0);
});
