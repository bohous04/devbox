// Reading account quotas from Claude Code's first-party endpoint. Verified live on
// 2026-07-28 against claude 2.1.220 — the endpoint is also inside the binary (next to
// /api/oauth/profile), so this is not scraping. Works for EVERY account we hold
// valid credentials for, including the one not being worked on right now.

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA = "oauth-2025-04-20";

/** API time to epoch ms. Accepts both an ISO string and a number; a number under 1e12 is clearly
 *  in seconds (1e12 ms = year 2001, 1e12 s = year 33658 — they cannot be confused). */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export interface UsageLimit {
  kind: string; percent: number | null; severity: string | null;
  resetsAt: number | null; modelName: string | null; isActive: boolean;
}

export interface AccountUsage {
  fiveHourPct: number | null; fiveHourResetsAt: number | null;
  sevenDayPct: number | null; sevenDayResetsAt: number | null;
  limits: UsageLimit[];
}

const EMPTY: AccountUsage = {
  fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null, limits: [],
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** `/api/oauth/usage` response → our numbers. Never throws — a corrupted response
 *  gives all nulls and the poller stores it as "not measured", not as zero.
 *
 *  Percentages are taken preferentially from `limits[]`; `utilization` is the fallback. BOTH are
 *  a percentage 0–100 — verified live on 2026-07-28, when the same response carried both
 *  `five_hour.utilization: 3.0` and `limits[0].percent: 3`. Nothing is recalculated. */
export function parseUsage(raw: unknown): AccountUsage {
  const r = obj(raw);
  if (!r) return { ...EMPTY, limits: [] };

  const limits: UsageLimit[] = Array.isArray(r.limits)
    ? r.limits.flatMap((x) => {
        const l = obj(x);
        if (!l) return [];
        return [{
          kind: str(l.kind) ?? "",
          percent: num(l.percent),
          severity: str(l.severity),
          resetsAt: toEpochMs(l.resets_at),
          modelName: str(obj(obj(l.scope)?.model)?.display_name),
          isActive: l.is_active === true,
        }];
      })
    : [];

  const byKind = (kind: string) => limits.find((l) => l.kind === kind) ?? null;
  const session = byKind("session");
  const weekly = byKind("weekly_all");
  const fh = obj(r.five_hour);
  const sd = obj(r.seven_day);

  return {
    fiveHourPct: session?.percent ?? num(fh?.utilization),
    fiveHourResetsAt: session?.resetsAt ?? toEpochMs(fh?.resets_at),
    sevenDayPct: weekly?.percent ?? num(sd?.utilization),
    sevenDayResetsAt: weekly?.resetsAt ?? toEpochMs(sd?.resets_at),
    limits,
  };
}

// A header the API returns on EVERY response: which organization the token belongs to.
// It is the only account identifier that can be read for free — /api/oauth/profile
// would be one more request (and `/usage` on 429 is sensitive precisely to the number of calls).
export const ORG_ID_HEADER = "anthropic-organization-id";

/** Quota + the identity it belongs to. `orgId` is null when the header is missing —
 *  "don't know" MUST NOT be confused with "a different organization", otherwise a missing
 *  header would look like a swapped profile. */
export interface FetchedUsage extends AccountUsage { orgId: string | null }

/** `fetch` is a parameter, not a global — the poller is tested without a network. */
export async function fetchUsage(accessToken: string, f: typeof fetch): Promise<FetchedUsage> {
  const res = await f(USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": OAUTH_BETA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const orgId = res.headers.get(ORG_ID_HEADER);
  return { ...parseUsage(await res.json()), orgId: orgId === "" ? null : orgId };
}
