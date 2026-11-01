// Notification "the running session's account is exhausted, another one is free". A pure
// function over views from buildAccountViews — no automation: a human triggers the switch,
// because restarting the agent in the middle of a running turn throws that turn away.

import { isExhausted } from "./accountPolicy";
import { permanentlyUnmeasured, type AccountView } from "./accounts";
import type { NotifyExtra } from "./agentEvents";
import type { AccountPoolSettings } from "./config";

export interface SwitchAlert {
  key: string;          // stable key against sending the same alert repeatedly
  accountId: string;    // the exhausted account
  title: string;
  message: string;
  sessionId: string | null;
  // project/repo for a notification with a working "click to attach" (see the listener's
  // parseSession — an empty string in project/repo drops the notification entirely).
  // Devbox only: a mac lease has no devd session, there is nothing to attach to.
  project: string | null;
  repo: string | null;
}

const toCandidate = (a: AccountView) => ({
  id: a.id, label: a.label, disabled: a.disabled, quarantined: a.quarantined,
  fiveHourPct: a.fiveHourPct, fiveHourResetsAt: a.fiveHourResetsAt,
  sevenDayPct: a.sevenDayPct, sevenDayResetsAt: a.sevenDayResetsAt,
});

// On a devbox the lease label is always `project/repo` (account-lease.sh and dev switch
// both build it that way) — splitting on the first slash is enough, no DB needed.
function projectRepo(label: string | null): { project: string | null; repo: string | null } {
  if (!label) return { project: null, repo: null };
  const i = label.indexOf("/");
  return i < 0 ? { project: null, repo: null } : { project: label.slice(0, i), repo: label.slice(i + 1) };
}

// `runningSessionIds`: optional (default = no filtering, so old calls pass unchanged).
// `stop()` does not release the lease (only `end()` does — sessions.ts), so without this
// check a stopped session would get an alert with `dev switch`, which would only answer
// "isn't running." — a mac lease (sessionId null) is not affected, it is never
// filtered.
export function switchAlerts(views: AccountView[], s: AccountPoolSettings, runningSessionIds?: Set<string>): SwitchAlert[] {
  const now = Date.now();
  const spent = (a: AccountView) => isExhausted(toCandidate(a), now, s.thresholdPct);

  // Switch target: usable, not quarantined and under the threshold. Without a target the
  // alert has nothing to offer, so it is not sent at all.
  //
  // `permanentlyUnmeasured` (accounts.ts) MUST exclude here exactly what `toCandidates`
  // excludes — otherwise a permanently failing account (error set, both percentages
  // NEVER measured) would sort as `fiveHourPct ?? 0` = 0, i.e. "the freest", and get a
  // recommendation that `chooseAccount`/`dev switch` never fulfil: the operator would
  // get the advice "switch to backup", run `dev switch` and get "Already on
  // primary — nothing to do." (review round 4, I6).
  const target = views
    .filter((a) => !a.disabled && !a.quarantined && !spent(a) && !permanentlyUnmeasured(a))
    .sort((x, y) => (x.fiveHourPct ?? 0) - (y.fiveHourPct ?? 0))[0];
  if (!target) return [];

  const out: SwitchAlert[] = [];
  for (const a of views) {
    if (a.id === target.id || !spent(a)) continue;
    const pct = Math.round(a.fiveHourPct ?? a.sevenDayPct ?? 100);
    for (const l of a.leases) {
      if (l.client === "devbox" && l.sessionId && runningSessionIds && !runningSessionIds.has(l.sessionId)) continue;
      const where = l.label ?? l.sessionId ?? l.client;
      const { project, repo } = l.client === "devbox" ? projectRepo(l.label) : { project: null, repo: null };
      out.push({
        key: `${l.client}:${l.sessionId ?? ""}:${a.id}`,
        accountId: a.id,
        title: `Account ${a.label} at ${pct}%`,
        message: l.client === "devbox" && l.sessionId
          // The session restarts with --continue, so the conversation continues; the
          // in-progress turn is discarded though — that is why it must be in the alert. The
          // percentage is repeated (even though the title carries it) — phone/mac
          // notifications often show only the body.
          ? `Session ${where}: account ${a.label} is at ${pct}% — dev switch ${l.sessionId} switches to ${target.label} and continues (the in-progress turn is discarded).`
          : `Mac (${where}): account ${a.label} is at ${pct}% — the next claude launch picks ${target.label} on its own, the current session keeps running on the old account.`,
        sessionId: l.sessionId,
        project, repo,
      });
    }
  }
  return out;
}

/** A pin that has nowhere to point: the account does not exist, is disabled or
 *  quarantined. A session of such a project gets NO account and fails open to the
 *  shared `claude-home` — and that one is logged in with a specific identity, so the work
 *  will flow to an account OUTSIDE the pool's records. That must not happen silently.
 *
 *  An exhausted account does NOT count here: that is a normal operating state (the
 *  all-exhausted branch lets the session through and it waits for the reset), not a
 *  broken configuration.
 *
 *  Notifications use the same language and style as switchAlerts above (M4, final
 *  review: this text used to differ in language from the rest of the module). */
export function pinAlerts(views: AccountView[], s: AccountPoolSettings): SwitchAlert[] {
  const healthy = new Set(views.filter((a) => !a.disabled && !a.quarantined).map((a) => a.id));

  // Solo mode (`soloAccountId`) overrides pins entirely — `allowedAccounts` does not read
  // pins at all in this mode (see accountPolicy.ts). Reporting broken pins here would be
  // a false alarm (M2, final review): nothing from projectAccounts gets used anyway.
  // A broken SOLO account is a WORSE state than a broken pin, though — the pin leaves one
  // session without an account, this one leaves EVERY session (I2, final review) — so
  // this is reported instead of the pins.
  if (s.soloAccountId !== null) {
    if (healthy.has(s.soloAccountId)) return [];
    return [{
      key: `solo-broken:${s.soloAccountId}`,
      accountId: s.soloAccountId,
      title: "Account pool",
      message: `Single-account mode points to ${s.soloAccountId}, which is missing or disabled — ALL sessions fall back to the shared profile outside the pool's records.`,
      sessionId: null, project: null, repo: null,
    }];
  }

  const out: SwitchAlert[] = Object.entries(s.projectAccounts)
    .filter(([, accountId]) => !healthy.has(accountId))
    .map(([project, accountId]) => ({
      key: `pin-broken:${project}:${accountId}`,
      accountId,
      title: "Account pool",
      message: `Project ${project} is pinned to ${accountId}, which is missing or disabled — its sessions fall back to the shared profile.`,
      sessionId: null, project: null, repo: null,
    }));

  // I3 (final review): exclusivity + a disabled/quarantined account OUTSIDE the pin is
  // also a silent fail-open, just from the other side. `allowedAccounts` removes for
  // unpinned projects every account that is the target of someone's pin (accountPolicy.ts)
  // — when what REMAINS contains not a single healthy account, unpinned projects have
  // nothing to reach for, even though no INDIVIDUAL pin is broken on its own (which is
  // why the loop above does not catch it). A regression against the state before pins:
  // previously the same sessions would have got that reserved account with a proper
  // lease, now they flow onto it unrecorded.
  // The reserved set must be computed EXACTLY like `allowedAccounts` (accountPolicy.ts),
  // i.e. only from project pins (key without a slash). A repo-level pin is an exception
  // inside a project, not a claim on the whole account, so it takes nothing from unpinned
  // projects. This used to take `Object.values(projectAccounts)` including repo-level pins:
  // with the configuration `{games: max5, games/claudeSolo-1: max20}` over a two-account
  // pool `leftover` came out empty, `[].some(...)` = false, and the alert fired forever —
  // last seen live on 18 Aug 2026, even though both accounts were healthy and max20 free.
  const reserved = new Set(
    Object.entries(s.projectAccounts)
      .filter(([key]) => !key.includes("/"))
      .map(([, accountId]) => accountId),
  );
  if (reserved.size > 0) {
    const leftover = views.filter((a) => !reserved.has(a.id));
    // An empty `leftover` means the reservation swallowed the whole pool — that is still a
    // reason for an alert, it just must not be reached through repo-level pins.
    const leftoverHealthy = leftover.some((a) => !a.disabled && !a.quarantined);
    if (!leftoverHealthy) {
      out.push({
        key: "pin-exclusive-exhausted",
        accountId: [...reserved].sort().join(","),
        title: "Account pool",
        message: "No account is left for unpinned projects — all unreserved accounts are disabled or quarantined, their sessions fall back to the shared profile.",
        sessionId: null, project: null, repo: null,
      });
    }
  }

  return out;
}

/** Extra for `notify()`: alert with a devbox session → session (click = attach);
 *  without a session (mac lease) → target "subscriptions", so a tap opens AI limits.
 *  project/repo from the alert (derived from the lease label), not an empty string —
 *  listener.parseSession drops an empty project/repo and the notification would arrive
 *  without a working "click to attach" (review round 1, I6). */
export function alertNotifyExtra(a: SwitchAlert): NotifyExtra {
  return a.sessionId
    ? { session: { id: a.sessionId, project: a.project ?? "", repo: a.repo ?? "" } }
    : { target: { kind: "subscriptions" } };
}
