import { claudeWeeklyUsage, recordWeeklyUsage, weeklyUsageFailed } from "./weeklyUsage";
// Quota poller. It takes the access token FROM THE PROFILE of the given account (via an
// ephemeral container over the corresponding volume) — quota is a property of the account,
// not the machine, so devd only needs to read the profiles it has; the mac need not be asked.
//
// The decision part (pollDue) has no I/O, so it can be tested without docker or network.

import type { Database } from "bun:sqlite";
import {
  accessTokenExpired, parseCredentials, parseTierWeight, refreshAccessToken, refreshTokenDead, withTierLabel,
} from "./accountTokens";
import { isExhausted } from "./accountPolicy";
import { readProfileCredentials, writeProfileCredentials, type ProfileDeps } from "./accountProfiles";
import { fetchUsage } from "./accountUsage";
import type { AccountPoolSettings } from "./config";
import {
  activeLeases, getAccount, listAccounts, getAccountUsage, setAccountLabel, setAccountOrgId,
  setAccountQuarantined, setAccountWeight, upsertAccountUsage, type AccountUsageRow,
} from "./db";

export interface PollerDeps {
  db: Database;
  profiles: ProfileDeps;
  fetch: typeof fetch;
  now: () => number;
  settings: () => AccountPoolSettings;
  leaseMaxAgeMs: number;   // after this time an unreleased lease counts as abandoned
}

// Backoff cap after an error: 4× the idle cadence (with the default 300 s, i.e. 20 minutes).
const ERROR_BACKOFF = 4;
// Where the backoff STARTS. A fixed 4× idle was too much for the first error:
// `/api/oauth/usage` returns 429 when several clients from one IP measure quota at once
// (devd + every running session), which is transient and clears on its own within a
// minute — but the dashboard then showed "Usage unavailable" for twenty minutes over
// numbers that were long stale. So the first failure is retried almost immediately and
// only repeated ones are throttled.
const ERROR_RETRY_BASE_MS = 30_000;

/** How long to wait after an error before measuring the account again. `errorCount` is the
 *  number of errors IN A ROW (0 or 1 = the first one). It doubles: 30 s, 1, 2, 4, 8, 16 min …
 *  up to the cap `ERROR_BACKOFF × idlePollSec`, where it stays. A transient 429 thus disappears
 *  from the dashboard within half a minute, while a permanently broken account is asked as
 *  rarely as before — the endpoint that just refused us does not get flooded. */
export function errorBackoffMs(errorCount: number, s: AccountPoolSettings): number {
  const cap = ERROR_BACKOFF * s.idlePollSec * 1000;
  const n = Math.max(0, Math.min(errorCount, 30) - 1);   // clamp: 2**n must not overflow
  return Math.min(ERROR_RETRY_BASE_MS * 2 ** n, cap);
}

/** Is the account due? An exhausted one is not polled until reset — the numbers will not
 *  change anyway and it saves calls. */
export function pollDue(
  usage: AccountUsageRow | null, hasActiveLease: boolean, now: number, s: AccountPoolSettings,
): boolean {
  if (usage === null) return true;
  if (usage.error !== null) return now - usage.fetched_at >= errorBackoffMs(usage.error_count ?? 0, s);

  const spent = isExhausted({
    id: usage.account_id, label: "", disabled: false, quarantined: false,
    fiveHourPct: usage.five_hour_pct, fiveHourResetsAt: usage.five_hour_resets_at,
    sevenDayPct: usage.seven_day_pct, sevenDayResetsAt: usage.seven_day_resets_at,
  }, now, s.thresholdPct);
  if (spent) {
    const resets = [usage.five_hour_resets_at, usage.seven_day_resets_at].filter((t): t is number => t !== null);
    // An unknown reset (the API omitted/mangled resets_at → parseUsage gives null) MUST
    // NOT be read as "never" — the only thing that can bring such an account back into
    // play is a new measurement. Without this branch the row would freeze in
    // `account_usage` forever and could only be fixed by editing SQLite by hand.
    if (resets.length === 0) return now - usage.fetched_at >= s.idlePollSec * 1000;
    return now >= Math.min(...resets);
  }

  const interval = (hasActiveLease ? s.activePollSec : s.idlePollSec) * 1000;
  return now - usage.fetched_at >= interval;
}

// Error: KEEP the last known numbers (only fetched_at and error get overwritten). Zero
// values would look in the UI like "the account is empty" and the policy would send all work
// to it. `now` is taken as a parameter, not via `d.now()` — the caller has already read it
// once and a second read of the real clock might not match the first.
function recordError(d: PollerDeps, id: string, now: number, message: string): void {
  weeklyUsageFailed(d.db, "claude", id);
  const prev = getAccountUsage(d.db, id);
  upsertAccountUsage(d.db, {
    account_id: id,
    five_hour_pct: prev?.five_hour_pct ?? null, five_hour_resets_at: prev?.five_hour_resets_at ?? null,
    seven_day_pct: prev?.seven_day_pct ?? null, seven_day_resets_at: prev?.seven_day_resets_at ?? null,
    limits_json: prev?.limits_json ?? null,
    // The observed organization is kept just like the percentages above. If an error reset
    // it, the "two accounts run on one" warning would vanish from the card on every outage —
    // and precisely then one has the least reason to trust what is left there.
    org_id: prev?.org_id ?? null,
    fetched_at: now, error: message.slice(0, 300),
    // Errors IN A ROW, not in total: a successful measurement below writes 0, so the counter
    // carries the length of the ongoing outage and the backoff grows only while it lasts.
    error_count: (prev?.error_count ?? 0) + 1,
  });
}

/** One account: read credentials from the profile → refresh the token if expired → measure quota. */
export async function pollAccount(d: PollerDeps, id: string): Promise<void> {
  const now = d.now();

  // Reading the profile (both an exception thrown from `d.run` and a `null` return) does
  // NOT DISTINGUISH a missing profile from a temporarily unavailable docker (restart,
  // missing image, failed mount) — both look the same. In the second case quarantine would
  // remove a healthy account, possibly both at once; docker does not care whose profile
  // fails to read. So this only records the error and retries next cycle — a permanently
  // missing profile is recognized by the error not going away, not by a single failure.
  let raw: string | null;
  try { raw = await readProfileCredentials(d.profiles, id); }
  catch (e) { recordError(d, id, now, `profile cannot be read: ${(e as Error).message}`); return; }

  if (raw === null) {
    recordError(d, id, now, "profile cannot be read (missing, or docker/volume temporarily unavailable)");
    return;
  }

  // Here the profile WAS READ — docker/volume worked. The content simply is not a valid
  // credentials blob. That is a permanent state (no further poll fixes it on its own), so
  // only here does quarantine happen.
  const creds = parseCredentials(raw);
  if (!creds) {
    recordError(d, id, now, "profile is corrupted — credentials cannot be parsed");
    setAccountQuarantined(d.db, id, now);
    return;
  }

  // Weight/label are refreshed from EVERY successfully read blob, not only on token
  // refresh — `rateLimitTier` is always in it, whether the token expired or not.
  // A plan upgrade/downgrade (a new `rateLimitTier` after Claude Code itself logs in) thus
  // shows up without manually re-adding the account (see accountsApi.test.ts for the
  // registration path, where the same thing is computed for the first time).
  const row = getAccount(d.db, id);
  if (row) {
    const weight = parseTierWeight(creds.claudeAiOauth.rateLimitTier);
    setAccountWeight(d.db, id, weight);
    const label = withTierLabel(row.label, weight);
    if (label !== row.label) setAccountLabel(d.db, id, label);
  }

  let blob = creds;
  // Writing the refreshed token to the profile can fail independently of the refresh
  // itself (docker unavailable right now). The in-memory `blob` stays valid for THIS cycle
  // (which is why it continues on to fetchUsage), but the profile still carries the old —
  // possibly already server-rotated — refresh token. Without recording this error the next
  // cycle would end in a confusing quarantine with a message about the token endpoint, with
  // nothing pointing at the write that actually caused it a cycle earlier.
  let writeError: string | null = null;
  if (accessTokenExpired(blob, now)) {
    if (refreshTokenDead(blob, now)) {
      recordError(d, id, now, "refresh token expired — the account must log in again");
      setAccountQuarantined(d.db, id, now);
      return;
    }
    const r = await refreshAccessToken(blob, d.fetch, now);
    if (!r.ok) {
      recordError(d, id, now, `token refresh failed: ${r.error}`);
      if (r.dead) setAccountQuarantined(d.db, id, now);
      return;
    }
    blob = r.blob;
    try { await writeProfileCredentials(d.profiles, id, JSON.stringify(blob)); }
    catch (e) {
      writeError = `writing refreshed credentials failed: ${(e as Error).message}`;
      console.error(`writing refreshed credentials for ${id} failed:`, (e as Error).message);
    }
  }

  let u;
  try { u = await fetchUsage(blob.claudeAiOauth.accessToken, d.fetch); }
  catch (e) {
    const msg = `reading quota failed: ${(e as Error).message}`;
    recordError(d, id, now, writeError ? `${writeError}; ${msg}` : msg);
    return;
  }

  // The identity the API ADMITTED for this measurement. When the account does not have it
  // recorded yet (a row from before this column), it is filled in — otherwise there would be
  // nothing to compare against. The poller MUST NOT overwrite it: if every measurement
  // overwrote the registered value with the observed one, a swapped profile would
  // "legalize" itself and the mismatch would never surface (exactly what happened from
  // 11 Aug 2026 with the max5 profile).
  if (u.orgId !== null && (row === null || (row.org_id ?? null) === null)) {
    setAccountOrgId(d.db, id, u.orgId);
  }

  upsertAccountUsage(d.db, {
    account_id: id,
    five_hour_pct: u.fiveHourPct, five_hour_resets_at: u.fiveHourResetsAt,
    seven_day_pct: u.sevenDayPct, seven_day_resets_at: u.sevenDayResetsAt,
    limits_json: JSON.stringify(u.limits),
    fetched_at: now, error: writeError, org_id: u.orgId,
    // The counter counts polls that ended with a RECORDED error — not failed measurements.
    // The difference shows here: the quota was read fresh, but `writeError` (an unwritten
    // rotated token) is a permanent problem that does not fix itself. If it were not
    // counted, `pollDue` would hit the account every 30 s forever because `error` is set.
    error_count: writeError === null ? 0 : (getAccountUsage(d.db, id)?.error_count ?? 0) + 1,
  });
  if (u.orgId && (!row?.org_id || row.org_id === u.orgId)) {
    recordWeeklyUsage(d.db, "claude", id, row?.label ?? id, u.orgId, now, claudeWeeklyUsage(u));
  } else weeklyUsageFailed(d.db, "claude", id);
  // The profile could be read and the quota arrived → the account is healthy, let it climb
  // out of quarantine on its own. (Writing the rotated token may have failed — that does
  // not justify quarantine, only the warning in `error` above remains.)
  setAccountQuarantined(d.db, id, null);
}

/** Walks the accounts that are due. Disabled ones are skipped (nobody gets them anyway),
 *  QUARANTINED accounts keep being tried — otherwise they would never revive after a new login. */
export async function pollAllDue(d: PollerDeps): Promise<string[]> {
  const now = d.now();
  const s = d.settings();
  const busy = new Set(activeLeases(d.db, now, d.leaseMaxAgeMs).map((l) => l.account_id));
  const polled: string[] = [];
  for (const a of listAccounts(d.db)) {
    if (a.disabled === 1) continue;
    if (!pollDue(getAccountUsage(d.db, a.id), busy.has(a.id), now, s)) continue;
    try { await pollAccount(d, a.id); polled.push(a.id); }
    catch (e) { console.error(`polling account ${a.id} failed:`, (e as Error).message); }
  }
  return polled;
}
