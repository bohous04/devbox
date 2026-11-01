import { expect, test } from "bun:test";
import { ACCOUNT_POOL_DEFAULTS } from "../src/config";
import { allowedAccounts, chooseAccount, isExhausted, type AccountCandidate, type PolicyInput } from "../src/accountPolicy";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function acc(id: string, five: number | null, seven = 0, extra: Partial<AccountCandidate> = {}): AccountCandidate {
  return {
    id, label: `${id}@example.com`, disabled: false, quarantined: false,
    fiveHourPct: five, fiveHourResetsAt: NOW + 60 * MIN,
    sevenDayPct: seven, sevenDayResetsAt: NOW + 6000 * MIN,
    ...extra,
  };
}

function decide(candidates: AccountCandidate[], over: Partial<PolicyInput> = {}) {
  return chooseAccount({
    candidates, current: null, lastSwitchAt: null, now: NOW, force: false, project: null, repo: null,
    settings: ACCOUNT_POOL_DEFAULTS, ...over,
  });
}

test("isExhausted: over the threshold with a future reset yes, after the reset no", () => {
  const t = ACCOUNT_POOL_DEFAULTS.thresholdPct;
  expect(isExhausted(acc("a", 95), NOW, t)).toBe(true);
  expect(isExhausted(acc("a", 89.9), NOW, t)).toBe(false);
  // the reset already happened → old numbers block nothing
  expect(isExhausted(acc("a", 95, 0, { fiveHourResetsAt: NOW - 1 }), NOW, t)).toBe(false);
  // the 7d window exhausts too
  expect(isExhausted(acc("a", 10, 92), NOW, t)).toBe(true);
  // without a known reset we are careful: over the threshold = exhausted
  expect(isExhausted(acc("a", 95, 0, { fiveHourResetsAt: null }), NOW, t)).toBe(true);
  // an unmeasured account is not exhausted
  expect(isExhausted(acc("a", null, 0, { sevenDayPct: null }), NOW, t)).toBe(false);
});

test("picks the lowest 5h, tie-break 7d", () => {
  expect(decide([acc("a", 40), acc("b", 10)]).accountId).toBe("b");
  expect(decide([acc("a", 10, 50), acc("b", 10, 20)]).accountId).toBe("b");
  expect(decide([acc("a", 10)]).label).toBe("a@example.com");
  expect(decide([acc("a", 10)]).reason).toBe("best");
  expect(decide([acc("a", 10)]).exhausted).toBe(false);
});

test("an unmeasured account counts as empty (a freshly added one should get work)", () => {
  const d = decide([acc("a", 30), acc("fresh", null, 0, { sevenDayPct: null })]);
  expect(d.accountId).toBe("fresh");
});

test("disabled and quarantine are skipped", () => {
  expect(decide([acc("a", 5, 0, { disabled: true }), acc("b", 50)]).accountId).toBe("b");
  expect(decide([acc("a", 5, 0, { quarantined: true }), acc("b", 50)]).accountId).toBe("b");
});

test("no usable account → null, no crash", () => {
  const d = decide([acc("a", 5, 0, { disabled: true })]);
  expect(d).toEqual({ accountId: null, label: null, exhausted: true, reason: "none" });
  expect(decide([])).toEqual({ accountId: null, label: null, exhausted: true, reason: "none" });
});

test("all over the threshold → nearest reset + exhausted, the session starts anyway", () => {
  const a = acc("a", 95, 0, { fiveHourResetsAt: NOW + 90 * MIN });
  const b = acc("b", 99, 0, { fiveHourResetsAt: NOW + 10 * MIN });
  const d = decide([a, b]);
  expect(d.accountId).toBe("b");
  expect(d.exhausted).toBe(true);
  expect(d.reason).toBe("all-exhausted");
});

test("the current account stays when it is still the best", () => {
  const d = decide([acc("a", 10), acc("b", 40)], { current: "a" });
  expect(d.accountId).toBe("a");
  expect(d.reason).toBe("current");
});

test("hysteresis: a candidate under the margin does not switch", () => {
  // difference 5 pp < margin 10 → stay
  const stay = decide([acc("a", 30), acc("b", 25)], { current: "a" });
  expect(stay.accountId).toBe("a");
  expect(stay.reason).toBe("hysteresis");
  // difference 20 pp > margin → switch
  const move = decide([acc("a", 30), acc("b", 10)], { current: "a" });
  expect(move.accountId).toBe("b");
  expect(move.reason).toBe("best");
});

test("cooldown: shortly after a switch there is no switch even with a large difference", () => {
  const soon = decide([acc("a", 30), acc("b", 1)], { current: "a", lastSwitchAt: NOW - 2 * MIN });
  expect(soon.accountId).toBe("a");
  expect(soon.reason).toBe("cooldown");
  const later = decide([acc("a", 30), acc("b", 1)], { current: "a", lastSwitchAt: NOW - 10 * MIN });
  expect(later.accountId).toBe("b");
});

test("an exhausted current account overrides cooldown and hysteresis", () => {
  const d = decide([acc("a", 95), acc("b", 92, 0, { fiveHourResetsAt: NOW - 1 })], {
    current: "a", lastSwitchAt: NOW - 1 * MIN,
  });
  expect(d.accountId).toBe("b");   // b has its reset behind it → not exhausted
  expect(d.reason).toBe("best");
});

test("force skips cooldown and hysteresis (manual dev switch)", () => {
  const d = decide([acc("a", 30), acc("b", 25)], { current: "a", lastSwitchAt: NOW - 1 * MIN, force: true });
  expect(d.accountId).toBe("b");
  expect(d.reason).toBe("best");
});

test("the result is deterministic even with a complete tie (sorted by id)", () => {
  expect(decide([acc("zeta", 10), acc("alfa", 10)]).accountId).toBe("alfa");
});

test("an account after its reset sorts as empty, not by the old value", () => {
  // "a" had the 5h window at 100 %, but the reset already happened → real usage ~0.
  // "b" has 5h at 40 % and is still the current candidate with the cooldown long past.
  // Without the fix "a" would sort by the old (100%) value and the pool would needlessly
  // jump to the less loaded "b" — exactly the opposite of reality.
  const a = acc("a", 100, 20, { fiveHourResetsAt: NOW - 1 });
  const b = acc("b", 40, 20);
  const d = decide([a, b], { current: "a", lastSwitchAt: NOW - 30 * MIN });
  expect(d.accountId).toBe("a");
  expect(d.reason).toBe("current");
});

test("all over the threshold: picks the one that frees up AS A WHOLE sooner, not by the first window", () => {
  // "a" is over the threshold on both windows — it frees up when the longer one runs out (3000 min).
  // "b" is over the threshold only on the 5h window — it frees up in 60 min. Even though "a" has a closer
  // SINGLE window (10 min), as a whole it stays blocked much longer than "b".
  const a = acc("a", 95, 95, { fiveHourResetsAt: NOW + 10 * MIN, sevenDayResetsAt: NOW + 3000 * MIN });
  const b = acc("b", 95, 10, { fiveHourResetsAt: NOW + 60 * MIN });
  const d = decide([a, b]);
  expect(d.accountId).toBe("b");
  expect(d.exhausted).toBe(true);
  expect(d.reason).toBe("all-exhausted");
});

test("the empty result (\"none\") is not a shared mutable object", () => {
  const first = decide([]);
  (first as { reason: string }).reason = "corrupted";
  const second = decide([]);
  expect(second.reason).toBe("none");
});

test("isExhausted: the threshold is '>=' — exactly at the boundary it is already exhausted", () => {
  const t = ACCOUNT_POOL_DEFAULTS.thresholdPct;
  expect(isExhausted(acc("a", t), NOW, t)).toBe(true);
});

test("cooldown: the boundary is a strict '<' — exactly when the cooldown has elapsed a switch is allowed", () => {
  const boundary = ACCOUNT_POOL_DEFAULTS.cooldownMinutes * MIN;
  const d = decide([acc("a", 30), acc("b", 1)], { current: "a", lastSwitchAt: NOW - boundary });
  expect(d.accountId).toBe("b");
  expect(d.reason).toBe("best");
});

test("hysteresis: the boundary is a strict '<' — exactly at the margin a switch is allowed", () => {
  const h = ACCOUNT_POOL_DEFAULTS.hysteresisPct;
  const d = decide([acc("a", 30), acc("b", 30 - h)], { current: "a" });
  expect(d.accountId).toBe("b");
  expect(d.reason).toBe("best");
});

test("hysteresis compares effPct, not just the ordering — the current account after a reset does not switch", () => {
  // Both effective percentages are 0 (zeta after the reset, alfa really measures 0), so
  // it is decided only by the tie-break on id → best = "alfa", a DIFFERENT account from current = "zeta".
  // Hysteresis is therefore really evaluated (unlike the test above, where the ordering
  // alone resolves it and hysteresis is never called). With effPct: diff 0 < margin →
  // stay on "zeta". With the old (raw) value the diff would be 100 ≥ margin and the pool would
  // needlessly switch away from the account that has just emptied.
  const zeta = acc("zeta", 100, 20, { fiveHourResetsAt: NOW - 1 });
  const alfa = acc("alfa", 0, 20);
  const d = decide([zeta, alfa], { current: "zeta" });
  expect(d.accountId).toBe("zeta");
  expect(d.reason).toBe("hysteresis");
});

// Review round 5 (operator decision): hysteresis used to compare ONLY the 5-hour
// window — two accounts close on 5h but with a widely diverging difference on the WEEK stayed
// stuck on the current one, exactly where the account pool should have helped most. Now with a
// 5-hour difference UNDER the margin it falls back to the weekly one as the second criterion.
test("hysteresis: 5h difference under the margin, but 7d difference OVER the margin → switches (week fallback)", () => {
  // 5h: 30 vs 25, diff 5 < margin 10 → on its own this would be "stay".
  // 7d: 50 vs 10, diff 40 ≥ margin → the week fallback decides "switch".
  const a = acc("a", 30, 50);
  const b = acc("b", 25, 10);
  const d = decide([a, b], { current: "a" });
  expect(d.accountId).toBe("b");
  expect(d.reason).toBe("best");
});

test("hysteresis: 5h difference under the margin AND 7d difference under the margin → stays (unchanged)", () => {
  // 5h: 30 vs 25, diff 5 < margin. 7d: 15 vs 10, diff 5 < margin too → stay, same
  // as before (the two-step fallback does not change this case at all).
  const a = acc("a", 30, 15);
  const b = acc("b", 25, 10);
  const d = decide([a, b], { current: "a" });
  expect(d.accountId).toBe("a");
  expect(d.reason).toBe("hysteresis");
});

test("hysteresis: 5h difference OVER the margin switches regardless of the 7d numbers (today's path still works)", () => {
  // 5h: 30 vs 1, diff 29 ≥ margin → decided IMMEDIATELY, the week is not touched at all.
  // 7d is deliberately THE SAME on both accounts (50 vs 50, diff 0) — if the code mistakenly
  // required a match on the week too (AND instead of fallback), this test would reveal it.
  const a = acc("a", 30, 50);
  const b = acc("b", 1, 50);
  const d = decide([a, b], { current: "a" });
  expect(d.accountId).toBe("b");
  expect(d.reason).toBe("best");
});

test("isExhausted: the threshold is a percentage of the account's OWN limit, not absolute capacity", () => {
  // An account at 95 % of its limit is exhausted, whether it is 5x or 20x — the plan size
  // plays no role in this question. That is why the threshold is never converted to absolute headroom.
  const t = ACCOUNT_POOL_DEFAULTS.thresholdPct;
  expect(isExhausted(acc("big", 95, 0), NOW, t)).toBe(true);
  expect(isExhausted(acc("big", 89.9, 0), NOW, t)).toBe(false);
});

test("hysteresis: the weekly fallback uses effPct too — an expired reset counts as 0, not by the old value", () => {
  // 5h: 30 vs 25, diff 5 < margin → falls back to the week. The candidate's (b) 7d percentage is
  // an OLD high number (95 %), but its reset already happened (fiveHourResetsAt below is
  // irrelevant, sevenDayResetsAt is in the past) → effectively 0, not 95. With the raw
  // value the diff would be 20 - 95 = -75 < margin → stay (wrong: "b" is actually
  // almost empty). With effPct: diff 20 - 0 = 20 ≥ margin → switch.
  const a = acc("a", 30, 20);
  const b = acc("b", 25, 95, { sevenDayResetsAt: NOW - 1 });
  const d = decide([a, b], { current: "a" });
  expect(d.accountId).toBe("b");
  expect(d.reason).toBe("best");
});

// ---------------------------------------------------------------------------
// Preferred account + overflow (operator brief: "run on 20x and at 60 % add 5x").
// `big` is preferred, `small` is the backup. Note: in all tests `big` has
// DELIBERATELY worse numbers than `small` — otherwise the tests would pass even without the gate, simply
// because the usage ordering would pick it.
// ---------------------------------------------------------------------------

function pref(over: Partial<typeof ACCOUNT_POOL_DEFAULTS> = {}) {
  return { settings: { ...ACCOUNT_POOL_DEFAULTS, preferredAccountId: "big", ...over } };
}

test("preference: under the threshold the preferred account runs even if it is more loaded than the backup", () => {
  const d = decide([acc("big", 50, 50), acc("small", 1, 1)], pref());
  expect(d.accountId).toBe("big");
  expect(d.reason).toBe("preferred");
});

test("preference: reason is 'current' when we already run on the preferred one", () => {
  const d = decide([acc("big", 50, 50), acc("small", 1, 1)], { ...pref(), current: "big" });
  expect(d.accountId).toBe("big");
  expect(d.reason).toBe("current");
});

test("overflow: the 5h window over the threshold opens the offer to the others", () => {
  const spill = ACCOUNT_POOL_DEFAULTS.spilloverPct;
  const d = decide([acc("big", spill, 0), acc("small", 1, 1)], pref());
  expect(d.accountId).toBe("small");
  expect(d.reason).toBe("best");
});

test("overflow: the weekly window ALONE over the threshold is enough (both windows, whichever comes first)", () => {
  // Only the week is over the threshold, the 5h window is far below it — the gate must still
  // open. If the condition were mistakenly written as AND, this test reveals it.
  //
  // `big` deliberately has a WORSE 5h window than `small`: if it had a better one, the normal
  // ordering would pick it after the gate opened and the test would pass even if the gate never
  // opened (verified — exactly that happened in the first version of this test).
  const spill = ACCOUNT_POOL_DEFAULTS.spilloverPct;
  const d = decide([acc("big", 30, spill), acc("small", 1, 1)], pref());
  expect(d.accountId).toBe("small");
  expect(d.reason).toBe("best");
});

test("overflow: the boundary is '>=' — exactly at the threshold it overflows, slightly below it does not", () => {
  const spill = ACCOUNT_POOL_DEFAULTS.spilloverPct;
  expect(decide([acc("big", spill, 0), acc("small", 1, 1)], pref()).accountId).toBe("small");
  expect(decide([acc("big", spill - 0.1, 0), acc("small", 1, 1)], pref()).accountId).toBe("big");
});

test("overflow closes again after the window reset (effPct, not the old value in the DB)", () => {
  // `big` still has 99 % on 5h in the DB, but the reset already happened → it is actually empty.
  // Without effPct the overflow would stay open until the poller's next measurement.
  const big = acc("big", 99, 0, { fiveHourResetsAt: NOW - 1 });
  const d = decide([big, acc("small", 1, 1)], pref());
  expect(d.accountId).toBe("big");
  expect(d.reason).toBe("preferred");
});

test("preference: an exhausted preferred account falls through to the normal selection", () => {
  // Above thresholdPct (the hard threshold) it drops out of `available` entirely — the gate will not find it there.
  const d = decide([acc("big", 95, 0), acc("small", 40, 40)], pref());
  expect(d.accountId).toBe("small");
  expect(d.reason).toBe("best");
});

test("preference: a disabled or quarantined preferred account falls through to the normal selection", () => {
  expect(decide([acc("big", 1, 1, { disabled: true }), acc("small", 40)], pref()).accountId).toBe("small");
  expect(decide([acc("big", 1, 1, { quarantined: true }), acc("small", 40)], pref()).accountId).toBe("small");
});

test("preference: an id that matches no account (typo in the config) does not stop the pool", () => {
  const d = decide([acc("big", 50), acc("small", 1)], pref({ preferredAccountId: "missing" }));
  expect(d.accountId).toBe("small");   // normal selection by usage
  expect(d.reason).toBe("best");
});

test("preference: force (manual dev switch) skips the gate", () => {
  // Without force the gate would return `big`; but the operator wants to switch NOW.
  const d = decide([acc("big", 50, 50), acc("small", 1, 1)], { ...pref(), current: "big", force: true });
  expect(d.accountId).toBe("small");
  expect(d.reason).toBe("best");
});

test("preference: preferredAccountId=null is today's behaviour unchanged", () => {
  const d = decide([acc("big", 50, 50), acc("small", 1, 1)], pref({ preferredAccountId: null }));
  expect(d.accountId).toBe("small");
  expect(d.reason).toBe("best");
});

test("preference: the gate overrides cooldown and hysteresis (return to the preferred one after a reset)", () => {
  // The client moved to `small` during the overflow; `big` meanwhile reset below the threshold.
  // The return must happen immediately — waiting for the cooldown would mean needlessly draining
  // the backup, even though the preferred account is free again.
  const d = decide([acc("big", 10, 10), acc("small", 1, 1)], {
    ...pref(), current: "small", lastSwitchAt: NOW - 1 * MIN,
  });
  expect(d.accountId).toBe("big");
  expect(d.reason).toBe("preferred");
});

// ---------------------------------------------------------------------------
// Pinning projects to accounts. Both rules follow from ONE map: a pinned
// project takes only its own account, an unpinned one must not use someone else's reserved one.
// ---------------------------------------------------------------------------

const PINNED = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max5" } };
const ids = (list: AccountCandidate[]) => list.map((a) => a.id).sort();
const POOL = [acc("max5", 50), acc("max20", 1)];

test("allowedAccounts: a pinned project gets ONLY its own account, even if it is more loaded", () => {
  expect(ids(allowedAccounts(POOL, "games", null, PINNED))).toEqual(["max5"]);
});

test("allowedAccounts: an unpinned project DOES NOT GET someone else's reserved account", () => {
  expect(ids(allowedAccounts(POOL, "apps", null, PINNED))).toEqual(["max20"]);
});

test("allowedAccounts: project=null (mac lease) behaves as unpinned", () => {
  // The shim sends a lease without session_id, so it does not know the project — a deliberate limitation, see the spec.
  expect(ids(allowedAccounts(POOL, null, null, PINNED))).toEqual(["max20"]);
});

test("allowedAccounts: an empty map = today's behaviour, nobody is filtered", () => {
  expect(ids(allowedAccounts(POOL, "games", null, ACCOUNT_POOL_DEFAULTS))).toEqual(["max20", "max5"]);
});

test("allowedAccounts: solo mode overrides pins and preference", () => {
  const solo = { ...PINNED, soloAccountId: "max20" };
  expect(ids(allowedAccounts(POOL, "games", null, solo))).toEqual(["max20"]);
  expect(ids(allowedAccounts(POOL, "apps", null, solo))).toEqual(["max20"]);
});

test("allowedAccounts: solo mode outside the set of accounts returns empty, no crash", () => {
  const solo = { ...PINNED, soloAccountId: "missing" };
  expect(allowedAccounts(POOL, "games", null, solo)).toEqual([]);
});

test("allowedAccounts: a pin to a non-existent account returns empty (typo in the config)", () => {
  // Empty → chooseAccount returns `none` → fail-open. Returning ALL
  // accounts instead would silently send games to max20, exactly what is forbidden.
  const typo = { ...ACCOUNT_POOL_DEFAULTS, projectAccounts: { games: "max55" } };
  expect(allowedAccounts(POOL, "games", null, typo)).toEqual([]);
});

test("chooseAccount: games gets max5 even though max20 is freer", () => {
  const d = decide([acc("max5", 50, 50), acc("max20", 1, 1)], { settings: PINNED, project: "games" });
  expect(d.accountId).toBe("max5");
});

test("chooseAccount: an unpinned project must not use max5 even during overflow", () => {
  // max20 is over the overflow threshold (60 %), so under normal circumstances
  // usage would decide and max5 would win. The reservation must override that.
  const d = decide([acc("max5", 1, 1), acc("max20", 70, 70)], { settings: PINNED, project: "apps" });
  expect(d.accountId).toBe("max20");
});

test("chooseAccount: an EXHAUSTED pinned account falls into all-exhausted, not onto someone else's account", () => {
  // THE MOST IMPORTANT test of the whole feature. The all-exhausted branch sorted over `usable`;
  // if it had stayed, games would get max20 while max5 is exhausted — exactly what is
  // forbidden. The session should start with exhausted:true and wait for the reset.
  //
  // BOTH must be REALLY exhausted, and max20 must free up SOONER than max5
  // (10 min vs. 90 min) — otherwise a non-exhausted max20 would have timeToClear=Infinity and
  // would always lose in the ordering, whether it was in the sorted array or not. The test would
  // then pass even with `usable` instead of `allowed` (verified by mutation), and the trap would guard
  // nothing. With this data: sorting over `usable` = [max5, max20] picks `max20`
  // (closer reset) → wrong; sorting over `allowed` = [max5] (the only one allowed
  // for games) picks `max5`, because max20 is not in the array at all → correct.
  const d = decide([
    acc("max5", 95, 95, { fiveHourResetsAt: NOW + 90 * MIN, sevenDayResetsAt: NOW + 90 * MIN }),
    acc("max20", 95, 95, { fiveHourResetsAt: NOW + 10 * MIN, sevenDayResetsAt: NOW + 10 * MIN }),
  ], { settings: PINNED, project: "games" });
  expect(d.accountId).toBe("max5");
  expect(d.exhausted).toBe(true);
  expect(d.reason).toBe("all-exhausted");
});

test("chooseAccount: force (dev switch) DOES NOT BYPASS the pin", () => {
  const d = decide([acc("max5", 50, 50), acc("max20", 1, 1)], {
    settings: PINNED, project: "games", current: "max5", force: true,
  });
  expect(d.accountId).toBe("max5");
});

test("chooseAccount: a disabled pinned account → none (fail-open), not someone else's account", () => {
  const d = decide([acc("max5", 1, 1, { disabled: true }), acc("max20", 1, 1)], {
    settings: PINNED, project: "games",
  });
  expect(d).toEqual({ accountId: null, label: null, exhausted: true, reason: "none" });
});

// ---------------------------------------------------------------------------
// REPO-level pins: `project/repo` is an exception inside a project.
// Needed for games — the automation should run on max5, but the interactive claudeSolo
// should stay on max20.
//
// Key rule: a repo-level pin DOES NOT RESERVE the account. If it did,
// the pin `games/claudeSolo-1 → max20` would take max20 away from all other projects and they
// would be left without a candidate — a silent fail-open for the whole rest of the devbox.
// ---------------------------------------------------------------------------

const REPO_PINNED = {
  ...ACCOUNT_POOL_DEFAULTS,
  projectAccounts: { games: "max5", "games/claudeSolo-1": "max20" },
};

test("allowedAccounts: a repo-level pin overrides the project one", () => {
  expect(ids(allowedAccounts(POOL, "games", "claudeSolo-1", REPO_PINNED))).toEqual(["max20"]);
});

test("allowedAccounts: another repo of the same project gets the project pin", () => {
  expect(ids(allowedAccounts(POOL, "games", "game_agents", REPO_PINNED))).toEqual(["max5"]);
});

test("allowedAccounts: a repo-level pin DOES NOT RESERVE the account for other projects", () => {
  // The most important test of this change. max20 is the target of a repo-level pin, but the rest
  // of the devbox must still get it — otherwise a pin on one repo would starve everything.
  expect(ids(allowedAccounts(POOL, "apps", "budget-app", REPO_PINNED))).toEqual(["max20"]);
});

test("allowedAccounts: a project pin still reserves", () => {
  // max5 is the target of a PROJECT pin, so another project must not use it.
  expect(ids(allowedAccounts(POOL, "websites", "web", REPO_PINNED))).not.toContain("max5");
});

test("allowedAccounts: a missing repo (mac lease) falls back to the project pin", () => {
  expect(ids(allowedAccounts(POOL, "games", null, REPO_PINNED))).toEqual(["max5"]);
});

test("chooseAccount: games/claudeSolo-1 gets max20, another games repo max5", () => {
  const solo = decide([acc("max5", 1, 1), acc("max20", 50, 50)], {
    settings: REPO_PINNED, project: "games", repo: "claudeSolo-1",
  });
  expect(solo.accountId).toBe("max20");
  const auto = decide([acc("max5", 50, 50), acc("max20", 1, 1)], {
    settings: REPO_PINNED, project: "games", repo: "game_agents",
  });
  expect(auto.accountId).toBe("max5");
});
