import { expect, test } from "bun:test";
import { alertNotifyExtra, pinAlerts, switchAlerts } from "../src/accountAlerts";
import type { AccountView } from "../src/accounts";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const S = ACCOUNT_POOL_DEFAULTS;

const acc = (id: string, five: number, over: Partial<AccountView> = {}): AccountView => ({
  id, label: `${id}@x.cz`, disabled: false, quarantined: false,
  fiveHourPct: five, fiveHourResetsAt: NOW + HOUR,
  sevenDayPct: 10, sevenDayResetsAt: NOW + 10 * HOUR,
  limits: [], fetchedAt: NOW, error: null, errorCount: 0, orgId: null, observedOrgId: null, leases: [], ...over,
});

test("devbox session on an exhausted account → message with the dev switch command", () => {
  const spent = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: "x/y", createdAt: NOW }] });
  const a = switchAlerts([spent, acc("backup", 20)], S);
  expect(a.length).toBe(1);
  expect(a[0].accountId).toBe("primary");
  expect(a[0].sessionId).toBe("dev-x-y");
  expect(a[0].key).toBe("devbox:dev-x-y:primary");
  expect(a[0].message).toContain("dev switch dev-x-y");
  expect(a[0].message).toContain("backup@x.cz");
  expect(a[0].message).toContain("95");
});

test("a mac lease gets a DIFFERENT message — on the mac you switch by launching claude again", () => {
  const spent = acc("primary", 99, { leases: [{ client: "mac", sessionId: null, label: "vpsbetter", createdAt: NOW }] });
  const a = switchAlerts([spent, acc("backup", 5)], S);
  expect(a.length).toBe(1);
  expect(a[0].sessionId).toBe(null);
  expect(a[0].key).toBe("mac::primary");
  expect(a[0].message).not.toContain("dev switch");
  expect(a[0].message).toContain("claude");
});

test("no free account → no message (nowhere to send it)", () => {
  const spent = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: null, createdAt: NOW }] });
  expect(switchAlerts([spent, acc("backup", 92)], S)).toEqual([]);
});

test("an account under the threshold sends nothing; a lease without an account neither", () => {
  const ok = acc("primary", 50, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: null, createdAt: NOW }] });
  expect(switchAlerts([ok, acc("backup", 5)], S)).toEqual([]);
  expect(switchAlerts([acc("primary", 95), acc("backup", 5)], S)).toEqual([]);   // exhausted, but nobody runs on it
});

test("neither a disabled nor a quarantined account is a switch target", () => {
  const spent = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: null, createdAt: NOW }] });
  expect(switchAlerts([spent, acc("backup", 5, { disabled: true })], S)).toEqual([]);
  expect(switchAlerts([spent, acc("backup", 5, { quarantined: true })], S)).toEqual([]);
});

// I6 (review round 4): `permanentlyUnmeasured` (accounts.ts) must exclude here
// EXACTLY what `toCandidates` excludes — otherwise "backup" (error set, both
// percentages NEVER measured) sorts as `fiveHourPct ?? 0` = 0, i.e. as
// "the freest", and gets a recommendation that `chooseAccount`/`dev switch` never
// fulfil: the operator runs `dev switch` and gets "Already on primary — nothing
// to do." Without a target (primary is exhausted, backup permanently unmeasured)
// there is nowhere to switch, so no message goes out.
test("a permanently failing account (error + never measured anything) is never offered as a switch target", () => {
  const spent = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: null, createdAt: NOW }] });
  const broken = acc("backup", 0, { fiveHourPct: null, sevenDayPct: null, error: "profile cannot be read (volume deleted)" });
  expect(switchAlerts([spent, broken], S)).toEqual([]);
});

test("several leases on one account → a message for each, each with its own key", () => {
  const spent = acc("primary", 95, { leases: [
    { client: "devbox", sessionId: "dev-a-b", label: "a/b", createdAt: NOW },
    { client: "devbox", sessionId: "dev-c-d", label: "c/d", createdAt: NOW },
  ] });
  const a = switchAlerts([spent, acc("backup", 5)], S);
  expect(a.map((x) => x.key)).toEqual(["devbox:dev-a-b:primary", "devbox:dev-c-d:primary"]);
});

// Review round 1 (I6): notify() sends { session: { id, project, repo } } and the listener
// (parseSession) drops a session whose project/repo is an empty string — without this
// the exhausted-account notification would have no working "click to attach".
test("devbox alert carries project/repo from the lease label (for a clickable notification)", () => {
  const spent = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: "shop/cms", createdAt: NOW }] });
  const a = switchAlerts([spent, acc("backup", 20)], S);
  expect(a[0].project).toBe("shop");
  expect(a[0].repo).toBe("cms");
});

test("devbox alert without a label (or without a slash) → project/repo null, no crash", () => {
  const noLabel = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: null, createdAt: NOW }] });
  expect(switchAlerts([noLabel, acc("backup", 20)], S)[0]).toMatchObject({ project: null, repo: null });
  const noSlash = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: "solo", createdAt: NOW }] });
  expect(switchAlerts([noSlash, acc("backup", 20)], S)[0]).toMatchObject({ project: null, repo: null });
});

test("mac alert has no project/repo (a mac lease has no devd session, nothing to attach to)", () => {
  const spent = acc("primary", 99, { leases: [{ client: "mac", sessionId: null, label: "vpsbetter", createdAt: NOW }] });
  const a = switchAlerts([spent, acc("backup", 5)], S);
  expect(a[0]).toMatchObject({ project: null, repo: null });
});

// Review round 1 (I7): stop() does not release the lease (only end() does), so a stopped
// session would without the filter get a message with `dev switch`, which would only answer
// "isn't running." runningSessionIds is optional — without it (old call) nothing is
// filtered at all, so tests that do not exercise this parameter do not break.
test("a devbox lease on a NON-RUNNING session (running set without it) is not reported — dev switch would fail anyway", () => {
  const spent = acc("primary", 95, { leases: [{ client: "devbox", sessionId: "dev-x-y", label: "shop/cms", createdAt: NOW }] });
  expect(switchAlerts([spent, acc("backup", 20)], S, new Set())).toEqual([]);
  expect(switchAlerts([spent, acc("backup", 20)], S, new Set(["dev-x-y"]))[0]?.sessionId).toBe("dev-x-y");
});

test("a mac lease is not governed by the running filter (sessionId is always null, no devd session to check)", () => {
  const spent = acc("primary", 99, { leases: [{ client: "mac", sessionId: null, label: "vpsbetter", createdAt: NOW }] });
  expect(switchAlerts([spent, acc("backup", 5)], S, new Set()).length).toBe(1);
});

test("pinAlerts: a pin to a non-existent account reports a problem", () => {
  const views = [acc("max20", 5, { disabled: false })];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  const out = pinAlerts(views, s);
  expect(out.length).toBe(1);
  expect(out[0]!.message).toContain("games");
  expect(out[0]!.message).toContain("max5");
});

test("pinAlerts: a pin to a DISABLED account reports a problem too", () => {
  // A disabled account drops out of the candidates earlier, so the session ends up on fail-open
  // just like with a typo — for the operator it is the same trouble.
  const views = [acc("max5", 5, { disabled: true }), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s).length).toBe(1);
});

test("pinAlerts: a healthy pin reports nothing", () => {
  const views = [acc("max5", 5), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s)).toEqual([]);
});

test("pinAlerts: an EXHAUSTED pinned account is NOT a problem — the session waits for the reset", () => {
  // Exhaustion is a normal operating state (the all-exhausted branch), not a broken configuration.
  const views = [acc("max5", 99), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s)).toEqual([]);
});

test("pinAlerts: the key is stable so the message is not sent over and over", () => {
  const views = [acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s)[0]!.key).toBe(pinAlerts(views, s)[0]!.key);
  expect(pinAlerts(views, s)[0]!.key).toContain("games");
});

// M4 (final review): the pinAlerts text used to differ in language from switchAlerts;
// it must use the same language as the rest of the module.
test("pinAlerts: message text uses the same language as switchAlerts (M4)", () => {
  const views = [acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  const msg = pinAlerts(views, s)[0]!.message;
  expect(msg).toContain("is pinned to");
  expect(msg).toContain("shared profile");
});

// I2 (final review): the spec (table "Error handling") asks, for `soloAccountId` pointing
// to a non-existent/disabled account, the same as for a broken pin — fail-open +
// notification. Solo mode is WORSE: it leaves EVERY session without an account, not just one.
test("pinAlerts: a broken soloAccountId reports a problem (I2)", () => {
  const views = [acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, soloAccountId: "max5" };   // max5 does not exist at all
  const out = pinAlerts(views, s);
  expect(out.length).toBe(1);
  expect(out[0]!.message).toContain("max5");
  expect(out[0]!.key).toBe("solo-broken:max5");
});

test("pinAlerts: soloAccountId pointing to a DISABLED account reports a problem too (I2)", () => {
  const views = [acc("max5", 5, { disabled: true }), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, soloAccountId: "max5" };
  expect(pinAlerts(views, s).length).toBe(1);
});

test("pinAlerts: a healthy soloAccountId reports nothing", () => {
  const views = [acc("max5", 5), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, soloAccountId: "max5" };
  expect(pinAlerts(views, s)).toEqual([]);
});

// M2 (final review): with solo mode on, pins are ignored
// (allowedAccounts), so reporting broken pins would be a false alarm — solo
// health is reported instead of them (test above), not in addition to them.
test("pinAlerts: solo mode suppresses broken-pin messages (M2)", () => {
  const views = [acc("max20", 5)];   // max5 (the pin target) does not exist
  const s = { ...ACCOUNT_POOL_DEFAULTS, soloAccountId: "max20", projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s)).toEqual([]);   // soloAccountId (max20) is healthy → no message
});

// I3 (final review): exclusivity + a disabled account OUTSIDE the pin = silent fail-open for
// UNPINNED projects — a regression against the state before pins (previously
// the same sessions would have got the reserved account with a proper lease).
test("pinAlerts: no account is left for unpinned projects because the only unreserved one is disabled (I3)", () => {
  const views = [acc("max5", 5), acc("max20", 5, { disabled: true })];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  const out = pinAlerts(views, s);
  expect(out.length).toBe(1);   // the pin itself is fine (max5 healthy), this is EXTRA
  expect(out[0]!.key).toBe("pin-exclusive-exhausted");
  expect(out[0]!.message).toContain("unpinned projects");
});

test("pinAlerts: I3 is not reported when the unreserved account is healthy", () => {
  const views = [acc("max5", 5), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s)).toEqual([]);
});

test("pinAlerts: I3 is not reported without any pin (no exclusivity to examine)", () => {
  const views = [acc("max20", 5, { disabled: true })];
  expect(pinAlerts(views, ACCOUNT_POOL_DEFAULTS)).toEqual([]);
});

// Quarantine has the same effect as disabled — allowedAccounts filters out both.
test("pinAlerts: I3 also fires for a quarantined (not just disabled) unreserved account", () => {
  const views = [acc("max5", 5), acc("max20", 5, { quarantined: true })];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
  expect(pinAlerts(views, s).some((a) => a.key === "pin-exclusive-exhausted")).toBe(true);
});

// Live false alarm from 18 Aug 2026: the user had `{games: max5, games/claudeSolo-1: max20}`
// and a two-account pool, so `pinnedIds` was filled with BOTH accounts, `leftover` came out empty
// and `[].some(...)` = false → alert. Yet `allowedAccounts` reserves only PROJECT
// pins (key without a slash), so max20 was free for unpinned projects the whole time.
// The watchdog believed something different about the policy than the policy does; it fired on every
// devd restart, because the list of sent alerts lives only in the process memory.
test("pinAlerts: a repo-level pin DOES NOT RESERVE the account, so I3 is not reported (live case 18 Aug)", () => {
  const views = [acc("max5", 5), acc("max20", 5)];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5", "games/claudeSolo-1": "max20" } };
  expect(pinAlerts(views, s)).toEqual([]);
});

// The other side of the same thing: a repo-level pin must not hide the alert either. max20 is not reserved,
// but it is disabled — unpinned projects then really have nothing left.
test("pinAlerts: I3 is reported even with a repo-level pin when the unreserved account is disabled", () => {
  const views = [acc("max5", 5), acc("max20", 5, { disabled: true })];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5", "games/claudeSolo-1": "max20" } };
  // Next to I3 there is legitimately also `pin-broken` — the repo-level pin itself points to a disabled
  // account. That is a different defect and is reported independently.
  const out = pinAlerts(views, s);
  const i3 = out.filter((a) => a.key === "pin-exclusive-exhausted");
  expect(i3.length).toBe(1);
  // The listed accounts are the RESERVED ones, not all pin targets — otherwise the message tempts
  // you to look for the problem in an account nobody claims.
  expect(i3[0]!.accountId).toBe("max5");
  expect(out.some((a) => a.key === "pin-broken:games/claudeSolo-1:max20")).toBe(true);
});

// A repo-level pin by itself reserves nothing, so there is no exclusivity to examine —
// the broken pin is reported, I3 is not.
test("pinAlerts: only a repo-level pin → I3 is not considered at all", () => {
  const views = [acc("max20", 5, { disabled: true })];
  const s = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { "games/claudeSolo-1": "max20" } };
  const out = pinAlerts(views, s);
  expect(out.some((a) => a.key === "pin-exclusive-exhausted")).toBe(false);
  expect(out.map((a) => a.key)).toEqual(["pin-broken:games/claudeSolo-1:max20"]);
});

test("alertNotifyExtra: with a session → session (click = attach), without a session → subscriptions target", () => {
  const base = { key: "k", accountId: "a", title: "t", message: "m" };
  expect(alertNotifyExtra({ ...base, sessionId: "dev-x-y", project: "x", repo: "y" }))
    .toEqual({ session: { id: "dev-x-y", project: "x", repo: "y" } });
  expect(alertNotifyExtra({ ...base, sessionId: null, project: null, repo: null }))
    .toEqual({ target: { kind: "subscriptions" } });
});
