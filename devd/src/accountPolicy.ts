// Account selection policy. A PURE function over ready-made numbers — no DB, no network,
// so table tests cover every edge (threshold, hysteresis, cooldown, resets_at expiry,
// disabled, quarantine, everything exhausted).

import type { AccountPoolSettings } from "./config";

export interface AccountCandidate {
  id: string; label: string;
  disabled: boolean; quarantined: boolean;
  fiveHourPct: number | null; fiveHourResetsAt: number | null;
  sevenDayPct: number | null; sevenDayResetsAt: number | null;
}

export interface PolicyInput {
  candidates: AccountCandidate[];
  current: string | null;        // the account the client runs on (from lease history)
  lastSwitchAt: number | null;   // when the client moved to the current account
  now: number;
  force: boolean;                // manual `dev switch` — skip both cooldown and hysteresis
  // The session's project, for pinning (allowedAccounts). `null` = unknown —
  // a mac lease has no session_id, so the project is unknown; behaves as unpinned.
  project: string | null;
  // The session's repo — for pinning at the `project/repo` level (allowedAccounts).
  // `null` = unknown (a mac lease has no session), then the project rule applies.
  repo: string | null;
  settings: AccountPoolSettings;
}

export type PolicyReason = "current" | "preferred" | "best" | "cooldown" | "hysteresis" | "all-exhausted" | "none";

export interface PolicyDecision {
  accountId: string | null; label: string | null;
  exhausted: boolean; reason: PolicyReason;
}

// A fresh literal on every call — NONE must never be a shared mutable object.
// Callers typically touch the result (log it, enrich it with extra fields); if it were
// a single constant object returned by reference, a mutation by one caller would
// poison the result of every later chooseAccount call for the rest of the process.
function noneDecision(): PolicyDecision {
  return { accountId: null, label: null, exhausted: true, reason: "none" };
}

/** Is the given window over the threshold on its own, with its reset not yet passed? The
 *  shared core for isExhausted and for estimating when an account frees up (timeToClear) —
 *  both questions ask the same thing, just from a different angle. */
function windowOver(pct: number | null, resetsAt: number | null, now: number, thresholdPct: number): boolean {
  return pct !== null && pct >= thresholdPct && (resetsAt === null || resetsAt > now);
}

/** An account is exhausted when some window exceeded the threshold and has NOT reset YET.
 *  An unknown `resetsAt` is treated cautiously as "the reset has not come yet" — otherwise
 *  an old ninety-percent value without a reset time would look like free capacity. */
export function isExhausted(a: AccountCandidate, now: number, thresholdPct: number): boolean {
  return windowOver(a.fiveHourPct, a.fiveHourResetsAt, now, thresholdPct)
    || windowOver(a.sevenDayPct, a.sevenDayResetsAt, now, thresholdPct);
}

/** Effective percentage for sorting and comparison: after the reset passes, the stored
 *  number is invalid — the window started again from zero. Without this correction a freshly
 *  reset account would keep looking (and sorting) as full until someone measured it again. */
function effPct(pct: number | null, resetsAt: number | null, now: number): number {
  return pct === null || (resetsAt !== null && resetsAt <= now) ? 0 : pct;
}

/** Has spillover to the other accounts opened? The threshold is tested on BOTH windows
 *  separately and one is enough — whichever touches it first decides (operator's spec).
 *
 *  effPct, not raw `pct`: a window after reset is empty, even though the DB still holds the
 *  old high value from before it. Without that, spillover after the weekly reset would stay
 *  open until the next measurement.
 *
 *  Mind the relation to `isExhausted`: this is a SOFT threshold (the preferred account stays
 *  on offer, it just gets company), whereas `thresholdPct` is HARD (the account drops out
 *  of the offer completely). That is why `windowOver` is not used here — for exhaustion an
 *  unknown `resetsAt` is cautiously "not reset yet", here it is more natural to read the
 *  same number the accounts are sorted by. */
function spilledOver(a: AccountCandidate, now: number, spilloverPct: number): boolean {
  return effPct(a.fiveHourPct, a.fiveHourResetsAt, now) >= spilloverPct
    || effPct(a.sevenDayPct, a.sevenDayResetsAt, now) >= spilloverPct;
}

/** When the account will be usable, IF it is exhausted right now: MAX over the windows that
 *  keep it over the threshold (not MIN over all windows) — the account frees up when the
 *  LONGEST-running of the exhausted limits ends, not the first one that happens to land in
 *  the ordering. Unknown reset on an exhausted window = never (Infinity); better put it at
 *  the end than let it look like "right away". */
function timeToClear(a: AccountCandidate, now: number, thresholdPct: number): number {
  const resets: number[] = [];
  if (windowOver(a.fiveHourPct, a.fiveHourResetsAt, now, thresholdPct))
    resets.push(a.fiveHourResetsAt ?? Number.POSITIVE_INFINITY);
  if (windowOver(a.sevenDayPct, a.sevenDayResetsAt, now, thresholdPct))
    resets.push(a.sevenDayResetsAt ?? Number.POSITIVE_INFINITY);
  return resets.length ? Math.max(...resets) : Number.POSITIVE_INFINITY;
}

const decision = (a: AccountCandidate, reason: PolicyReason, exhausted = false): PolicyDecision =>
  ({ accountId: a.id, label: a.label, exhausted, reason });

/** Which accounts the given session may get at all. The filter runs BEFORE the exhaustion
 *  threshold and hysteresis, so the rest of the policy only decides within the allowed set.
 *
 *  Both rules follow from ONE map `projectAccounts`, so no second list of "reserved"
 *  accounts is needed:
 *    - project in the map → only its account,
 *    - project not in the map → everything EXCEPT accounts that are the target of a pin.
 *
 *  `soloAccountId` (manual single-account mode from the dashboard) overrides pins
 *  deliberately — the UI shows a banner for it, so it is not a hidden exception.
 *
 *  An empty result is a LEGITIMATE answer (disabled/nonexistent pinned account):
 *  the caller then returns `none` and the client fails open to the shared profile.
 *  Returning the whole set instead would silently let the pinned project onto another
 *  account — exactly what the pin is meant to forbid. */
export function allowedAccounts(
  usable: AccountCandidate[],
  project: string | null,
  repo: string | null,
  settings: AccountPoolSettings,
): AccountCandidate[] {
  if (settings.soloAccountId !== null) {
    return usable.filter((a) => a.id === settings.soloAccountId);
  }
  // The more specific `project/repo` key first, then `project`. One repo can thus be
  // exempted from the project rule (games runs on the small account, but the interactive
  // claudeSolo should stay on the big one).
  const exact = project !== null && repo !== null ? settings.projectAccounts[`${project}/${repo}`] : undefined;
  const pinned = exact ?? (project === null ? undefined : settings.projectAccounts[project]);
  if (pinned !== undefined) return usable.filter((a) => a.id === pinned);

  // ONLY project pins reserve (key without a slash). A repo-level pin is an exception
  // inside a project, not a claim on the whole account — if it reserved, the pin
  // `games/claudeSolo-1 → max20` would take max20 away from every other project and they
  // would be left without a single candidate, i.e. in a silent fail-open.
  const reserved = new Set(
    Object.entries(settings.projectAccounts)
      .filter(([key]) => !key.includes("/"))
      .map(([, accountId]) => accountId),
  );
  return usable.filter((a) => !reserved.has(a.id));
}

export function chooseAccount(input: PolicyInput): PolicyDecision {
  const { candidates, current, lastSwitchAt, now, force, project, repo, settings } = input;

  const usable = candidates.filter((a) => !a.disabled && !a.quarantined);
  // Pinning applies BEFORE the exhaustion threshold and hysteresis — the rest of the
  // policy then decides within the allowed set and cannot fall out of it. Empty is
  // legitimate (see allowedAccounts) and ends in a fail-open.
  const allowed = allowedAccounts(usable, project, repo, settings);
  if (allowed.length === 0) return noneDecision();

  // Sorted ASCENDING by effPct — the least loaded wins. Shared functions, so that sorting
  // and the hysteresis below always read the SAME number; that is exactly where previous
  // rounds of this feature kept failing (sorting used one indicator, hysteresis decided
  // by another).
  const score5h = (a: AccountCandidate) => effPct(a.fiveHourPct, a.fiveHourResetsAt, now);
  const score7d = (a: AccountCandidate) => effPct(a.sevenDayPct, a.sevenDayResetsAt, now);

  const available = allowed
    .filter((a) => !isExhausted(a, now, settings.thresholdPct))
    .sort((x, y) => score5h(x) - score5h(y)
      || score7d(x) - score7d(y)
      || x.id.localeCompare(y.id));   // determinism on a complete tie

  // Everything over the threshold → the one that frees up as a whole first (see
  // timeToClear). The session STILL starts: the limit may not bite yet and blocking the
  // start would be worse than warning. An account over ITS OWN threshold is exhausted
  // regardless of its size — the percentages are relative to its own limit.
  if (available.length === 0) {
    const soonest = [...allowed]
      .sort((x, y) => timeToClear(x, now, settings.thresholdPct) - timeToClear(y, now, settings.thresholdPct)
        || x.id.localeCompare(y.id))[0]!;
    return decision(soonest, "all-exhausted", true);
  }

  // Preferred account: as long as neither of its windows has touched `spilloverPct`, work
  // runs EXCLUSIVELY on it — the load of the others does not matter. Only past the
  // threshold does the gate open and the choice is made among all by load, which starts
  // spreading the work.
  //
  // Why not weighted capacity instead of preference: (100−60)×20 = 800 vs (100−0)×5 = 500,
  // so weighted selection would stick to the 20× account up to 75 % and spillover at 60 %
  // would NEVER happen. Preference and weighting are two competing answers to the same
  // question; the pool may only have one (see the history of this feature — sort and
  // hysteresis by two different numbers were a recurring cause of bugs).
  //
  // `force` (manual `dev switch`) skips the gate: the operator wants to switch NOW, not
  // hear that the preferred account still has room.
  //
  // When the preferred account is NOT in `available` (exhausted, disabled, quarantined, or
  // the id from the config matches no account), the gate silently falls through to normal
  // selection — a typo in the config must not stop the pool.
  if (!force && settings.preferredAccountId !== null) {
    const pref = available.find((a) => a.id === settings.preferredAccountId);
    if (pref && !spilledOver(pref, now, settings.spilloverPct)) {
      return decision(pref, current === pref.id ? "current" : "preferred");
    }
  }

  const best = available[0]!;
  const cur = current === null ? undefined : available.find((a) => a.id === current);
  // The client has not been anywhere, or its account has meanwhile dropped out of the offer
  // (exhausted, disabled, quarantine) → take the best, regardless of cooldown and hysteresis.
  if (!cur) return decision(best, "best");
  if (best.id === cur.id) return decision(cur, "current");
  if (force) return decision(best, "best");

  // Cooldown: prevents a series of consecutive switches when the numbers hover around the threshold.
  if (lastSwitchAt !== null && now - lastSwitchAt < settings.cooldownMinutes * 60_000) {
    return decision(cur, "cooldown");
  }

  // Hysteresis: the candidate must be better by a margin, otherwise the current one stays.
  // Without it the pool would ping-pong between two almost equally loaded accounts. effPct,
  // not raw pct — otherwise a freshly reset current account would get the margin against
  // itself (applies to BOTH windows below, not only the 5h one).
  //
  // Primarily the 5-hour window is compared — the SAME indicator by which `available` has
  // already sorted the candidates above (see sort), so hysteresis decides by the same
  // number, not by another one. Only when the 5-hour difference is BELOW the margin (the
  // sorting itself gives no clear answer — the accounts are close on 5h) does it fall back
  // to the WEEKLY window as a SECOND, fallback criterion — not an equal partner. Without
  // this fallback the pool would stay stuck on an account that is close to the current one
  // on 5h but whose weekly limit is running out — exactly the case the account pool exists
  // for (review round 5, operator decision). `max(5h, 7d)` on both sides would solve this
  // too, but it would also change behaviour where the 5h window ALONE decides today — so
  // the two-stage form stays, even at the cost of two rules instead of one.
  // DO NOT SIMPLIFY this back into a single comparison.
  const fiveHourDelta = effPct(cur.fiveHourPct, cur.fiveHourResetsAt, now) - effPct(best.fiveHourPct, best.fiveHourResetsAt, now);
  if (fiveHourDelta < settings.hysteresisPct) {
    const sevenDayDelta = effPct(cur.sevenDayPct, cur.sevenDayResetsAt, now) - effPct(best.sevenDayPct, best.sevenDayResetsAt, now);
    if (sevenDayDelta < settings.hysteresisPct) return decision(cur, "hysteresis");
  }
  return decision(best, "best");
}
