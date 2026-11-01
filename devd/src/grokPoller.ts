import { recordWeeklyUsage, weeklyUsageFailed } from "./weeklyUsage";
// Grok quota poller. Reads the bearer from the `grok-home` volume via an ephemeral container
// (shared readVolumeFile in agentAuth.ts, same pattern as codexPoller.ts).
//
// devd DELIBERATELY DOES NOT REFRESH the token: the grok CLI in the containers rotates the refresh token
// and two parties over one value mean a silent loss of login (the same
// incident that kept the Anthropic pool on a single account for eight days). An expired token
// therefore ends as the `stale-login` state.

import type { Database } from "bun:sqlite";
import { GROK_VOLUME, readVolumeFile } from "./agentAuth";
import { usagePollDue, type CodexPollerDeps } from "./codexPoller";
import { fetchGrokUsage, grokTokenStale, parseGrokAuthJson } from "./grokUsageFetch";
import { getGrokUsage, upsertGrokUsage, type GrokUsageRow } from "./db";

// Docker plumbing is identical to Codex — the deps differ only in name.
export type GrokPollerDeps = CodexPollerDeps;

export interface GrokView {
  state: "ok" | "signed-out" | "stale-login" | "error";
  tier: string | null;
  usedPct: number | null;   // null = the API does not expose a percentage (SuperGrok) — the card draws a dash
  resetsAt: number | null;
  fetchedAt: number;
  error: string | null;
}

/** A failure keeps the last known numbers — otherwise the card would go blank on the first error
 *  and it would be impossible to tell where the account stood when it broke. */
function writeFail(d: GrokPollerDeps, state: GrokView["state"], error: string | null): void {
  weeklyUsageFailed(d.db, "grok", "default");
  const prev = getGrokUsage(d.db);
  upsertGrokUsage(d.db, {
    singleton: 1,
    state,
    tier: prev?.tier ?? null,
    used_pct: prev?.used_pct ?? null,
    resets_at: prev?.resets_at ?? null,
    fetched_at: d.now(),
    error,
  });
}

/** The backoff policy (1 h after `signed-out`/`error`) is shared with Codex — see
 *  usagePollDue in codexPoller.ts. */
export const grokPollDue = (prev: GrokUsageRow | null, now: number): boolean => usagePollDue(prev, now);

export async function pollGrok(d: GrokPollerDeps): Promise<void> {
  if (!grokPollDue(getGrokUsage(d.db), d.now())) return;

  const { raw, dockerError } = await readVolumeFile(d, GROK_VOLUME, "/home/dev/.grok/auth.json");
  if (dockerError !== null) { writeFail(d, "error", dockerError); return; }
  const tokens = raw === null ? null : parseGrokAuthJson(raw);
  // A missing volume and a missing auth.json end the same way: "signed out" — the operator
  // does the same thing in both cases (Log in with Grok in Settings).
  if (tokens === null) { writeFail(d, "signed-out", null); return; }
  if (grokTokenStale(tokens, d.now())) { writeFail(d, "stale-login", null); return; }

  const r = await fetchGrokUsage(tokens, d.fetch);
  if (!r.ok) { writeFail(d, "error", r.error); return; }
  // Success is written VERBATIM — otherwise a value that disappeared would linger like a ghost.
  upsertGrokUsage(d.db, {
    singleton: 1,
    state: "ok",
    tier: r.usage.tier,
    used_pct: r.usage.usedPct,
    resets_at: r.usage.resetsAt,
    fetched_at: d.now(),
    error: null,
  });
  // A login replacement must start a distinct series. Never use the bearer as identity.
  const identity = tokens.email ? JSON.stringify([tokens.email, tokens.teamId]) : null;
  recordWeeklyUsage(d.db, "grok", "default", "Grok Build", identity, d.now(), r.usage.weekly ? [{ window: "weekly", percentUsed: r.usage.weekly.usedPct, resetsAt: r.usage.weekly.resetsAt }] : []);
}

export function buildGrokView(db: Database): GrokView | null {
  const r = getGrokUsage(db);
  if (r === null) return null;
  return {
    state: r.state,
    tier: r.tier,
    usedPct: r.used_pct,
    resetsAt: r.resets_at,
    fetchedAt: r.fetched_at,
    error: r.error,
  };
}
