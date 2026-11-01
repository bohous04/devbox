// Codex subscription quota. The response shape is NOT documented — it is derived from
// structures read out of the codex-cli 0.148.0 binary:
//
//   RateLimitWindow    { used_percent, window_minutes | window_duration_mins }
//   RateLimitSnapshot  { limit_name, primary, secondary, credits, plan_type,
//                        spend_control_reached, rate_limit_reached_type }
//   CreditsSnapshot    { has_credits, unlimited, balance }
//
// That is why everything is optional and nothing is computed. When the first live response arrives,
// mainly this file and its test fixture change.

export interface CodexWindow {
  kind: "primary" | "secondary";
  usedPct: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexCredits { balance: number | null; unlimited: boolean; hasCredits: boolean }

export interface CodexUsage {
  planType: string | null;
  windows: CodexWindow[];
  credits: CodexCredits | null;
  limitReached: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** `resets_at` arrives sometimes in seconds, sometimes in milliseconds. The 10^11 boundary is
 *  safe: in milliseconds it is the year 1973, in seconds the year 5138 — no real date lies
 *  in between, so the unit cannot be confused. */
export function normalizeResetsAt(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function window(kind: "primary" | "secondary", raw: unknown): CodexWindow | null {
  const o = obj(raw);
  if (!o) return null;
  // The live response sends the window length in SECONDS (`limit_window_seconds`, 604 800 = 7 days).
  // The names from the binary (`window_minutes` / `window_duration_mins`) stay as fallbacks —
  // they cost us one `??` and nobody promised the shape will not change again.
  const sec = num(o.limit_window_seconds);
  return {
    kind,
    usedPct: num(o.used_percent),
    windowMinutes: sec === null ? (num(o.window_minutes) ?? num(o.window_duration_mins)) : Math.round(sec / 60),
    resetsAt: normalizeResetsAt(o.reset_at ?? o.resets_at),
  };
}

/** `balance` arrives live as a STRING ("0"), not a number — so numbers are accepted in both
 *  forms. An empty string and nonsense stay `null`, not 0: zero is a balance, "don't know"
 *  is not. */
function numOrNumericString(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return num(v);
}

function credits(raw: unknown): CodexCredits | null {
  const o = obj(raw);
  if (!o) return null;
  return { balance: numOrNumericString(o.balance), unlimited: o.unlimited === true, hasCredits: o.has_credits === true };
}

/** `null` = this is not a Codex quota. The caller reports it as `unknown-shape` and logs
 *  the raw response — without it a new shape could only be tuned by more guessing. */
export function parseCodexUsage(json: unknown): CodexUsage | null {
  const root = obj(json);
  if (!root) return null;
  // The payload may come bare or wrapped. The first shape that has at least
  // one window wins — otherwise `{}` would pass as a valid response with zero windows.
  for (const cand of [root, obj(root.rate_limit), obj(root.rate_limits)]) {
    if (!cand) continue;
    // The live names are `primary_window`/`secondary_window`; `primary`/`secondary` was a guess
    // from the binary and stays as a fallback.
    const windows = [
      window("primary", cand.primary_window ?? cand.primary),
      window("secondary", cand.secondary_window ?? cand.secondary),
    ]
      .filter((w): w is CodexWindow => w !== null);
    if (windows.length === 0) continue;
    // Scalars (plan_type, credits, rate_limit_reached_type) sit, per
    // `RateLimitStatusPayload`, at the ROOT, even when the window won in the wrapped
    // `rate_limit`/`rate_limits`. Fallback to `root`, so that in this shape they are not
    // read as null forever (see the fixture below).
    return {
      planType: str(cand.plan_type) ?? str(root.plan_type),
      windows,
      credits: credits(cand.credits) ?? credits(root.credits),
      // Two independent signals, each elsewhere: `rate_limit_reached_type` is a string at the root,
      // `limit_reached` a boolean inside `rate_limit`. In the live response the type was `null`, so
      // watching only it would mean an exhausted quota passes as "Active" — exactly the
      // sentence the card must avoid. A boolean without a type gets a generic reason.
      limitReached: str(cand.rate_limit_reached_type) ?? str(root.rate_limit_reached_type)
        ?? (cand.limit_reached === true || root.limit_reached === true ? "limit_reached" : null),
    };
  }
  return null;
}
