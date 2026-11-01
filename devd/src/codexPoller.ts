import { codexWeeklyUsage, recordWeeklyUsage, weeklyUsageFailed } from "./weeklyUsage";
// Codex quota poller. The token is read from the `codex-home` volume via an ephemeral container —
// devd runs on the host and cannot otherwise see into the volume (same pattern as codexAuth.ts).
//
// devd DELIBERATELY DOES NOT REFRESH the token. OpenAI rotates the refresh token on use, and the
// Codex CLI inside containers rotates it too; if both sides rotated it, one would lose the
// login. Exactly this kind of silent failure cost the Anthropic pool eight days of running on
// a single account. An expired token therefore ends up as the `stale-login` state.

import type { Database } from "bun:sqlite";
import { CODEX_VOLUME, readVolumeFile } from "./agentAuth";
import type { CodexCredits, CodexWindow } from "./codexUsage";
import { fetchCodexUsage, parseCodexAuthJson, type CodexAuthTokens } from "./codexUsageFetch";
import { getCodexUsage, upsertCodexUsage, type CodexUsageRow } from "./db";

// The OpenAI refresh token lasts 30 days; 28 is a margin so we do not call with one that is no longer valid.
const REFRESH_MAX_AGE_MS = 28 * 86_400_000;

export interface CodexPollerDeps {
  db: Database;
  accountId?: string;
  accountLabel?: string;
  run: (cmd: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  fetch: typeof fetch;
  now: () => number;
  image?: string;
  volume?: string;
  force?: boolean;
  readAuth?: () => Promise<{ raw: string | null; dockerError: string | null }>;
  // Only for antigravityPoller.ts: a second file read from the same volume (the project
  // next to the token). Generally it would be desirable to have `readAuth` as a list, but for
  // a single caller with one extra file a separate optional field is the
  // most readable (see Question 7–11, section "Quota").
  readProject?: () => Promise<{ raw: string | null; dockerError: string | null }>;
  store?: { get: () => CodexUsageRow | null; put: (row: CodexUsageRow) => void };
}

const stored = (d: CodexPollerDeps) => d.store ? d.store.get() : getCodexUsage(d.db);
const persist = (d: CodexPollerDeps, row: CodexUsageRow) => d.store ? d.store.put(row) : upsertCodexUsage(d.db, row);

export interface CodexView {
  state: "ok" | "signed-out" | "stale-login" | "error";
  planType: string | null;
  windows: CodexWindow[];
  credits: CodexCredits | null;
  limitReached: string | null;
  fetchedAt: number;
  error: string | null;
}

/** `exp` from the JWT, without verifying the signature — only the time is read, not the identity. */
function jwtExpMs(token: string | null): number | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const exp = (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

/** Does calling make sense at all? When there is nothing to decide by, it returns `false` — so it
 *  rather tries and brings back the real error than marks a healthy login as dead.
 *
 *  It asks the ACCESS token, not the id_token. The difference is not a detail: measured on a live
 *  profile on 20 Aug 2026, `id_token` expired at 13:15, whereas `access_token` was valid until
 *  30 Aug — ten days longer. The original version read `id_token` and the poller therefore
 *  refused to call, so for ten days the card advised logging in again over access
 *  that worked. `id_token` is a short-lived identity proof, not a measure of the access
 *  lifetime. It falls back to `id_token` only when the access token is not a JWT and the time
 *  cannot be read from it. */
export function accessTokenStale(t: CodexAuthTokens, now: number): boolean {
  const exp = jwtExpMs(t.accessToken) ?? jwtExpMs(t.idToken);
  if (exp !== null) return exp <= now;
  const last = t.lastRefresh === null ? Number.NaN : Date.parse(t.lastRefresh);
  if (Number.isNaN(last)) return false;
  return now - last > REFRESH_MAX_AGE_MS;
}

// Reading auth.json and distinguishing "docker is broken" vs. "file missing" (invariant I3)
// lives in agentAuth.readVolumeFile — shared with grokPoller so the convention does not drift.

/** A successful measurement is written VERBATIM — otherwise a value that disappeared (say
 *  `plan_type`) would linger from the previous poll like a ghost. */
function writeOk(d: CodexPollerDeps, row: Omit<CodexUsageRow, "singleton" | "state" | "fetched_at" | "error">): void {
  persist(d, { singleton: 1, state: "ok", fetched_at: d.now(), error: null, ...row });
}

/** A failure keeps the last known numbers. Without it the card would go blank on the first 402
 *  and it would be impossible to tell where the account stood when it broke. `endpoint_idx` is inherited
 *  too — the path that worked last time is still the best guess for the next attempt. */
function writeFail(d: CodexPollerDeps, state: CodexView["state"], error: string | null): void {
  weeklyUsageFailed(d.db, "codex", d.accountId ?? "default");
  const prev = stored(d);
  persist(d, {
    singleton: 1,
    state,
    plan_type: prev?.plan_type ?? null,
    windows_json: prev?.windows_json ?? "[]",
    credits_json: prev?.credits_json ?? null,
    limit_reached: prev?.limit_reached ?? null,
    endpoint_idx: prev?.endpoint_idx ?? null,
    fetched_at: d.now(),
    error,
  });
}

// Backoff cap when Codex is unreachable long-term (signed out, or — as
// today — a permanent 402 on a deactivated workspace). Without it devd would start an ephemeral
// container every `idlePollSec` (5 min = 288×/day) and on 402 hammer chatgpt.com
// forever — exactly the kind of load the poller avoids elsewhere (see the comment
// at ERROR_RETRY_BASE_MS in accountPoller.ts).
const ERROR_BACKOFF_MS = 60 * 60_000;

/** Is the source due? A last row `signed-out`/`error` waits an hour regardless of the
 *  calling tick's cadence; `ok`/`stale-login` (and a missing row) are always due —
 *  stale-login does not call the network at all and a fresh poll is cheap. Shared with grokPoller:
 *  backoff is a policy of all singleton usage pollers, not a Codex property. */
export function usagePollDue(
  prev: { state: CodexView["state"]; fetched_at: number } | null, now: number,
): boolean {
  if (prev === null) return true;
  if (prev.state !== "signed-out" && prev.state !== "error") return true;
  return now - prev.fetched_at >= ERROR_BACKOFF_MS;
}
export const codexPollDue = usagePollDue;

export async function pollCodex(d: CodexPollerDeps): Promise<void> {
  if (!d.force && !codexPollDue(stored(d), d.now())) return;

  const { raw, dockerError } = await (d.readAuth ? d.readAuth() : readVolumeFile(d, d.volume ?? CODEX_VOLUME, "/home/dev/.codex/auth.json"));
  if (dockerError !== null) { writeFail(d, "error", dockerError); return; }
  const tokens = raw === null ? null : parseCodexAuthJson(raw);
  // A missing volume and a missing auth.json end the same: "signed out". Distinguishing them
  // would cost another docker run, and the operator does the same in both cases — `codex login`.
  if (tokens === null) { writeFail(d, "signed-out", null); return; }
  if (accessTokenStale(tokens, d.now())) { writeFail(d, "stale-login", null); return; }

  const prev = stored(d);
  const r = await fetchCodexUsage(tokens, d.fetch, prev?.endpoint_idx ?? null);
  if (!r.ok) { writeFail(d, "error", r.error); return; }
  writeOk(d, {
    plan_type: r.usage.planType,
    windows_json: JSON.stringify(r.usage.windows),
    credits_json: r.usage.credits === null ? null : JSON.stringify(r.usage.credits),
    limit_reached: r.usage.limitReached,
    endpoint_idx: r.endpointIdx,
  });
  recordWeeklyUsage(d.db, "codex", d.accountId ?? "default", d.accountLabel ?? "Main account", tokens.accountId, d.now(), codexWeeklyUsage(r.usage.windows));
}

export function buildCodexView(db: Database): CodexView | null {
  return codexUsageView(getCodexUsage(db));
}

export function codexUsageView(r: CodexUsageRow | null): CodexView | null {
  if (r === null) return null;
  return {
    state: r.state,
    planType: r.plan_type,
    windows: JSON.parse(r.windows_json) as CodexWindow[],
    credits: r.credits_json === null ? null : (JSON.parse(r.credits_json) as CodexCredits),
    limitReached: r.limit_reached,
    fetchedAt: r.fetched_at,
    error: r.error,
  };
}
