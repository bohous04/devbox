// Antigravity subscription quota. Endpoints and response shape extracted from the agy
// 1.3.5 binary (protobuf descriptor `v1internal_prediction_service`, see
// the internal design notes) and verified live against
// a real signed-in account (Questions 7–11, the Antigravity research notes,
// section "Quota"). devd DOES NOT REFRESH the token — agy rotates it in the session; two parties
// on one refresh token = silent loss of login (same decision as
// grokPoller.ts).
//
// `cloudcode-pa.googleapis.com` (loadCodeAssist + retrieveUserQuotaSummary) live
// DOES NOT WORK for this subscription type: loadCodeAssist returns only allowedTiers/
// ineligibleTiers without a project and retrieveUserQuotaSummary ends with 403
// SUBSCRIPTION_REQUIRED. The real agy calls `daily-cloudcode-pa…`, with the
// project read from a file (not from loadCodeAssist) and a specific User-Agent —
// hence no loadCodeAssist below and a different host.
const HOST = "https://daily-cloudcode-pa.googleapis.com/v1internal";

export interface AgyToken { accessToken: string; expiresAt: number | null }
export interface AgyQuotaWindow { window: "weekly" | "five_hour"; percentUsed: number; resetsAt: number | null }
export interface AgyQuotaGroup { id: string; label: string; windows: AgyQuotaWindow[] }
export type AgyQuotaResult = { ok: true; groups: AgyQuotaGroup[] } | { ok: false; error: string };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The User-Agent the real agy 1.3.5 sends — without it (or with a different one, e.g.
 *  "jetski/1.3.5") `retrieveUserQuotaSummary` returns 403 (verified live, Questions
 *  7–11). Version "1.3.5" is hardcoded from the measured binary — agy
 *  accepted it, there is no other source of truth for it; a newer CLI may change this. */
export function agyUserAgent(arch: string = process.arch): string {
  return `antigravity/1.3.5 linux/${arch === "x64" ? "amd64" : arch}`;
}

export function parseAgyToken(raw: string): AgyToken | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  // Shape of the real file as measured live (Questions 7–11): Go `oauth2.Token` is
  // NESTED under "token" — {"auth_method":…,"id_token":…,"token":{"access_token",
  // "expiry","refresh_token","token_type"}}. Flat shapes (the earlier assumption,
  // or another CLI version) are still accepted as a fallback path.
  const nested = o.token && typeof o.token === "object" && !Array.isArray(o.token) ? (o.token as Record<string, unknown>) : null;
  const accessToken = str(nested?.access_token) ?? str(nested?.accessToken) ?? str(o.access_token) ?? str(o.accessToken);
  if (!accessToken) return null;
  const exp = str(nested?.expiry) ?? str(nested?.expiresAt) ?? str(o.expiry) ?? str(o.expiresAt) ?? str(o.expiry_date);
  const t = exp ? Date.parse(exp) : NaN;
  return { accessToken, expiresAt: Number.isFinite(t) ? t : null };
}

/** 60 s margin: a token that expires during the request is already expired for us. */
export function agyTokenStale(t: AgyToken, now: number): boolean {
  return t.expiresAt !== null && t.expiresAt - 60_000 <= now;
}

function classify(b: Record<string, unknown>): AgyQuotaWindow["window"] | null {
  const s = `${str(b.window) ?? ""} ${str(b.displayName) ?? ""}`;
  if (/week|7\s*d|604800/i.test(s)) return "weekly";
  if (/5\s*h|five|hour|18000/i.test(s)) return "five_hour";
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";

export function parseQuotaSummary(j: unknown): AgyQuotaGroup[] | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const groups = (j as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const out: AgyQuotaGroup[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const label = str((g as Record<string, unknown>).displayName) ?? "Antigravity";
    const buckets = (g as { buckets?: unknown }).buckets;
    if (!Array.isArray(buckets)) continue;
    const windows: AgyQuotaWindow[] = [];
    for (const b of buckets) {
      if (!b || typeof b !== "object") continue;
      const r = b as Record<string, unknown>;
      if (r.disabled === true || typeof r.remainingFraction !== "number") continue;
      const window = classify(r);
      if (!window || windows.some((w) => w.window === window)) continue;
      const reset = str(r.resetTime) ? Date.parse(r.resetTime as string) : NaN;
      // Clamps to 0..100 — Google could in theory send remainingFraction
      // outside <0,1> (rounding across the boundary); the dashboard card would then
      // show a nonsensical percentage.
      const percentUsed = Math.min(100, Math.max(0, Math.round((1 - r.remainingFraction) * 100)));
      windows.push({ window, percentUsed, resetsAt: Number.isFinite(reset) ? reset : null });
    }
    if (windows.length) out.push({ id: slug(label), label, windows });
  }
  return out;
}

/** `project` is NOT read from loadCodeAssist (it does not return a project for this
 *  subscription type and also sits on a different — non-working — host, see the comment at `HOST` above).
 *  The caller (antigravityPoller.ts) reads it from the file
 *  `~/.gemini/antigravity-cli/cache/default_project_id.txt`, which agy itself
 *  writes. `userAgent` must be `agyUserAgent()` — without the correct UA Google
 *  returns 403 (verified live, Questions 7–11). */
export async function fetchAgyQuota(t: AgyToken, project: string, fetchFn: typeof fetch, userAgent: string): Promise<AgyQuotaResult> {
  const headers = { authorization: `Bearer ${t.accessToken}`, "content-type": "application/json", "user-agent": userAgent };
  try {
    const q = await fetchFn(`${HOST}:retrieveUserQuotaSummary`, { method: "POST", headers, body: JSON.stringify({ project }), signal: AbortSignal.timeout(15_000) });
    if (!q.ok) return { ok: false, error: `retrieveUserQuotaSummary HTTP ${q.status}` };
    const groups = parseQuotaSummary(await q.json());
    return groups ? { ok: true, groups } : { ok: false, error: "unknown quota response shape" };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "TimeoutError" ? "timeout" : "network error" };
  }
}
