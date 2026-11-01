// Pure logic of the Auth page for the account pool. JSX stays in pages/, here only things
// that can be tested without React (same pattern as sessionsView / ccUpkeepView).
//
// Note: `usageSeverity` is deliberately here, not in components/Gauge.tsx next to
// `diskSeverity` — Gauge is TSX with framer-motion and has no test. The Severity type is
// imported type-only, so no runtime cycle is created.

import type { Severity } from "./components/Gauge";
import type { AccountPoolView, AccountView } from "./api";
import { agoLabel } from "./format";

const DEFAULT_THRESHOLD = 90;   // fallback until `pool` arrives from the API; devd is the source of truth
const WARN_BAND = 20;           // how many pct points below the threshold orange starts

/** Gauge color by quota usage. `null` (not measured) is not a problem — the number is
 *  not shown next to the gauge anyway, so at least it should not glow red. */
export function usageSeverity(pct: number | null, thresholdPct = DEFAULT_THRESHOLD): Severity {
  if (pct === null) return "ok";
  if (pct >= thresholdPct) return "danger";
  if (pct >= thresholdPct - WARN_BAND) return "warn";
  return "ok";
}

/** Countdown to the window reset. Short windows in minutes, long ones in days — in the UI
 *  "resets in 2d 2h" is more readable than 3000 minutes. */
export function resetCountdown(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "—";
  const ms = resetsAt - now;
  if (ms <= 0) return "reset due";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `resets in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `resets in ${h}h ${min % 60}m`;
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Age of the last quota measurement. The numbers on the card SURVIVE an error — the poller
 *  deliberately does not overwrite them with zeros (see accountPoller.recordError), so without this
 *  value you cannot tell "the account is at 60 %" from "it was at 60 % before measuring stopped".
 *  Under a minute it says "just now": the exact second is useless here and the number would just tick. */
export function measuredLabel(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return "never measured";
  const ms = now - fetchedAt;
  return ms < 60_000 ? "measured just now" : `measured ${agoLabel(ms)}`;
}

// How many errors IN A ROW the UI still reads as a transient rate-limit hiccup. The poller backoff
// (30 s → 1 → 2 → 4 min) means 5 attempts cover roughly the first 7 minutes
// of continuous 429 — shorter hiccups are normal contention of clients on the same quota and
// are not worth a red message; longer ones the user SHOULD see.
const TRANSIENT_429_POLLS = 5;

// `errorCount ?? 0`: older devd does not send the field and a missing value must not be read
// as a "persistent error" — that would disable the softening exactly where a newer
// dashboard is deployed against an older devd.
function transientRateLimit(error: string | null, errorCount: number | undefined): boolean {
  return error !== null && error.includes("HTTP 429") && (errorCount ?? 0) < TRANSIENT_429_POLLS;
}

/** Presentation of a measurement error below the card. A transient 429 (see transientRateLimit) gets
 *  a quiet explanatory sentence instead of the raw error — the numbers on the card are the last known
 *  ones during an error anyway (the poller keeps them), so there is nothing to dramatize. Everything else
 *  stays verbatim, so the problem can be traced and reported. */
export interface UsageErrorView { text: string; transient: boolean }
export function usageErrorView(error: string | null, errorCount: number | undefined): UsageErrorView | null {
  if (error === null) return null;
  if (transientRateLimit(error, errorCount)) {
    return { transient: true, text: "Rate-limited by Anthropic — retrying automatically; showing last known usage." };
  }
  return { transient: false, text: error };
}

/** Account state for the badge. The order is deliberate: quarantine is an action item ("sign
 *  in again"), so it must override even a manually disabled account. A transient rate limit does not
 *  count as an error — the badge keeps the last known numbers (see usageErrorView). */
export function accountStatus(a: AccountView, thresholdPct = DEFAULT_THRESHOLD): { text: string; tone: "ok" | "warn" | "danger" } {
  if (a.quarantined) return { text: "Re-login needed", tone: "danger" };
  if (a.disabled) return { text: "Disabled", tone: "warn" };
  if (a.error !== null && !transientRateLimit(a.error, a.errorCount)) return { text: "Usage unavailable", tone: "warn" };
  const spent = (a.fiveHourPct ?? 0) >= thresholdPct || (a.sevenDayPct ?? 0) >= thresholdPct;
  if (spent) return { text: "Exhausted", tone: "danger" };
  return { text: "Active", tone: "ok" };
}

/** Splits the label "user@example.com (Max 20x)" into name and tier. The suffix is added by
 *  devd (accountTokens.withTierLabel) from `rateLimitTier` and it is the ONLY source of truth
 *  about which account is the big one — it cannot be told from the id. */
export function splitTierLabel(label: string): { name: string; tier: string | null } {
  const m = /^(.*\S)\s+\((Max \d+x)\)$/.exec(label);
  return m ? { name: m[1]!, tier: m[2]! } : { name: label, tier: null };
}

/** Mirrors `effPct` from devd/accountPolicy: after the reset expires the stored number is
 *  invalid, the window started again from zero. Without this the badge would show "spilling"
 *  long after the reset, until the poller measured the account again. */
function effPct(pct: number | null, resetsAt: number | null, now: number): number {
  return pct === null || (resetsAt !== null && resetsAt <= now) ? 0 : pct;
}

export type PoolRole = "preferred" | "spilling" | "backup";

/** Role of the account in the pool for the badge, or `null` when no preference is set
 *  (then the pool runs purely by usage and a role would lie).
 *
 *  `spilling` = preferred account that exceeded the spillover threshold, so the others
 *  were added to it. Mirrors `spilledOver` in devd: ONE window over the threshold is enough.
 *
 *  M8 (final review): with solo mode on (`soloAccountId`) `chooseAccount`
 *  does not read the preference at all (allowedAccounts overrides it, see devd/accountPolicy.ts)
 *  — PREFERRED/BACKUP would then show a role that does not apply at that moment. */
export function poolRole(a: AccountView, pool: AccountPoolView, now: number): PoolRole | null {
  if (pool.soloAccountId !== null) return null;
  if (pool.preferredAccountId === null) return null;
  if (a.id !== pool.preferredAccountId) return "backup";
  const over = effPct(a.fiveHourPct, a.fiveHourResetsAt, now) >= pool.spilloverPct
    || effPct(a.sevenDayPct, a.sevenDayResetsAt, now) >= pool.spilloverPct;
  return over ? "spilling" : "preferred";
}

/** Role label for the UI (in English, like the rest of the dashboard). */
export const POOL_ROLE_LABEL: Record<PoolRole, string> = {
  preferred: "PREFERRED",
  spilling: "SPILLING OVER",
  backup: "BACKUP",
};

type AccountLeaseClient = AccountView["leases"][number]["client"];
const CLIENT_LABEL: Record<AccountLeaseClient, string> = { mac: "Mac", devbox: "Devbox" };

/** Which sessions are currently running on the account. */
export function leaseSummary(a: AccountView): string {
  if (a.leases.length === 0) return "idle";
  return a.leases
    .map((l) => (l.label ? `${CLIENT_LABEL[l.client]} · ${l.label}` : CLIENT_LABEL[l.client]))
    .join(", ");
}

/** Per-model windows from limits[] (today "Fable"). Windows without a model are 5h/7d summaries
 *  that already have their own gauge — in this table they would only confuse. */
export function modelRows(a: AccountView): { model: string; percent: number | null }[] {
  return a.limits
    .filter((l) => l.modelName !== null)
    .map((l) => ({ model: l.modelName as string, percent: l.percent }))
    .sort((x, y) => (y.percent ?? 0) - (x.percent ?? 0));
}

/** Projects pinned to the given account. Alphabetical, so the badge on the card does not jump
 *  between loads (object key order is not guaranteed). */
export function pinnedProjects(accountId: string, pool: { projectAccounts: Record<string, string> }): string[] {
  return Object.entries(pool.projectAccounts)
    .filter(([, id]) => id === accountId)
    .map(([project]) => project)
    .sort();
}

/* ===================== account identity (drifted profile / duplicate) ===================== */

export type IdentityIssue = { kind: "drifted" | "duplicate"; text: string; detail: string };

/** Account identity problems, keyed by `id`. Computed over the WHOLE list,
 *  because "two accounts point to the same organization" cannot be seen from one row.
 *
 *  Why this exists at all: profile `max5` (added as team@example.com) on 11 Aug 2026
 *  signed in inside the container as user@example.com. The poller rewrote the label
 *  from the `rateLimitTier` of that new blob, so the card faithfully reported "Max 20x" —
 *  and the pool ran for eight days on a SINGLE account, measured twice. Nothing in the UI said so.
 *
 *  `drifted` beats `duplicate`: it names the CAUSE (the profile jumped elsewhere), whereas
 *  the duplicate is only its consequence. Without this a drifted account would show
 *  a message saying "something is wrong" instead of the one saying "what to do about it". */
export function identityIssues(accounts: AccountView[]): Map<string, IdentityIssue> {
  const out = new Map<string, IdentityIssue>();

  const byOrg = new Map<string, AccountView[]>();
  for (const a of accounts) {
    if (a.observedOrgId === null) continue;   // not measured ≠ equal; null is never grouped
    byOrg.set(a.observedOrgId, [...(byOrg.get(a.observedOrgId) ?? []), a]);
  }

  for (const a of accounts) {
    if (a.orgId !== null && a.observedOrgId !== null && a.orgId !== a.observedOrgId) {
      out.set(a.id, {
        kind: "drifted",
        text: "Profile switched accounts",
        detail: "This profile now answers as a different Anthropic organization than the one it was added"
          + " under — someone logged into it with the wrong account. Log in as the right account on your Mac"
          + " and use Replace credentials below.",
      });
      continue;
    }
    const twins = (a.observedOrgId === null ? [] : byOrg.get(a.observedOrgId) ?? []).filter((x) => x.id !== a.id);
    if (twins.length > 0) {
      out.set(a.id, {
        kind: "duplicate",
        text: "Same account as " + twins.map((x) => x.id).join(", "),
        detail: "These entries resolve to one Anthropic organization, so the pool has fewer accounts than it"
          + " looks — the quota below is that single account counted twice. Replace this profile's credentials"
          + " with the account it is supposed to be.",
      });
    }
  }
  return out;
}
