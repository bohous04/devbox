// Beszel (own hub, URL in secrets.beszel) via the PocketBase API. Provides live state
// and CPU/RAM/disk/network history for every machine running an agent.
//
// Beszel stores metrics under single-letter keys (`mp`, `dp`, `la`, `ni`…). Translation
// into named fields is a pure function — the dashboard never sees the raw abbreviations.

export interface BeszelConfig { url: string; email: string; password: string }

/** Raw record from `system_stats.stats` — only what we use. */
interface RawStats {
  cpu?: number;
  m?: number; mu?: number; mp?: number;        // memory: total / used / percent (GB)
  s?: number; su?: number;                      // swap: total / used (GB)
  d?: number; du?: number; dp?: number;         // disk: total / used / percent (GB)
  dr?: number; dw?: number;                     // disk I/O (MB/s)
  b?: [number, number];                         // network [sent, received] bytes/s
  la?: [number, number, number];                // load average
}

export interface MachineSample {
  at: number;
  cpu: number;
  memPct: number; memUsedGb: number; memTotalGb: number;
  swapPct: number; swapUsedGb: number; swapTotalGb: number;
  diskPct: number; diskUsedGb: number; diskTotalGb: number;
  diskReadMbs: number; diskWriteMbs: number;
  netUpKbs: number; netDownKbs: number;
  load1: number; load5: number; load15: number;
}

export interface BeszelSystem {
  id: string;
  name: string;
  status: string;                 // up | down | paused | pending
  agentVersion: string | null;
  uptimeSec: number | null;
  cpu: number; memPct: number; diskPct: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pct = (used: number, total: number): number => (total > 0 ? (used / total) * 100 : 0);

/** PocketBase returns `created` as "2026-07-27 09:21:19.831Z" — a space instead of T. */
export function pbTime(s: string): number {
  const t = new Date(s.replace(" ", "T")).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function toSample(created: string, raw: RawStats): MachineSample {
  const b = Array.isArray(raw.b) ? raw.b : [0, 0];
  const la = Array.isArray(raw.la) ? raw.la : [0, 0, 0];
  return {
    at: pbTime(created),
    cpu: num(raw.cpu),
    memPct: num(raw.mp), memUsedGb: num(raw.mu), memTotalGb: num(raw.m),
    swapPct: pct(num(raw.su), num(raw.s)), swapUsedGb: num(raw.su), swapTotalGb: num(raw.s),
    diskPct: num(raw.dp), diskUsedGb: num(raw.du), diskTotalGb: num(raw.d),
    diskReadMbs: num(raw.dr), diskWriteMbs: num(raw.dw),
    netUpKbs: num(b[0]) / 1024, netDownKbs: num(b[1]) / 1024,
    load1: num(la[0]), load5: num(la[1]), load15: num(la[2]),
  };
}

export function toSystem(rec: { id: string; name: string; status: string; info?: Record<string, unknown> }): BeszelSystem {
  const info = rec.info ?? {};
  return {
    id: rec.id, name: rec.name, status: rec.status,
    agentVersion: typeof info.v === "string" ? info.v : null,
    uptimeSec: typeof info.u === "number" ? info.u : null,
    cpu: num(info.cpu), memPct: num(info.mp), diskPct: num(info.dp),
  };
}

/**
 * Beszel keeps several aggregations under `type`. Based on the requested window we pick the one that
 * covers it with a reasonable number of points — 1m data for 7 days would be 10,000 rows.
 *
 * `finer` is a fallback for when the coarser aggregation does not exist yet: a freshly added
 * agent has ONLY `1m` rows for the first few hours (verified live on the devbox) and the chart would otherwise
 * stay empty even though data exists.
 */
export const RANGES = {
  "1h": { type: "1m", minutes: 60, finer: [] },
  "6h": { type: "10m", minutes: 6 * 60, finer: ["1m"] },
  "24h": { type: "20m", minutes: 24 * 60, finer: ["10m", "1m"] },
  "7d": { type: "120m", minutes: 7 * 24 * 60, finer: ["20m", "10m"] },
} as const;
export type RangeKey = keyof typeof RANGES;
export const isRangeKey = (v: string): v is RangeKey => v in RANGES;

export interface Beszel {
  systems: () => Promise<BeszelSystem[]>;
  samples: (systemId: string, range: RangeKey) => Promise<MachineSample[]>;
}

/**
 * Client with a cached token. A PocketBase token lives on the order of hours; on 401
 * we sign in again once and repeat the request (`retry` prevents a loop).
 */
export function createBeszel(cfg: BeszelConfig, fetchImpl: typeof fetch = fetch): Beszel {
  const base = cfg.url.replace(/\/$/, "");
  let token: string | null = null;

  const login = async (): Promise<string> => {
    const res = await fetchImpl(`${base}/api/collections/users/auth-with-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: cfg.email, password: cfg.password }),
    });
    if (!res.ok) throw new Error(`beszel login failed: ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error("beszel login returned no token");
    token = body.token;
    return body.token;
  };

  const get = async (path: string, retry = true): Promise<unknown> => {
    const t = token ?? (await login());
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: t } });
    if (res.status === 401 && retry) { token = null; return get(path, false); }
    if (!res.ok) throw new Error(`beszel ${path} returned ${res.status}`);
    return res.json();
  };

  return {
    async systems() {
      const body = (await get("/api/collections/systems/records?perPage=50&sort=name")) as { items?: Parameters<typeof toSystem>[0][] };
      return (body.items ?? []).map(toSystem);
    },
    async samples(systemId, range) {
      const { type, minutes, finer } = RANGES[range];
      const fetchType = async (t: string): Promise<MachineSample[]> => {
        // perPage is derived from the window and granularity + a margin; without a limit PocketBase
        // would return the default 30 points and the chart would be cut off.
        const step = Number(t.replace("m", "")) || 1;
        const perPage = Math.min(500, Math.ceil(minutes / step) + 10);
        const filter = encodeURIComponent(`system="${systemId}" && type="${t}"`);
        const body = (await get(`/api/collections/system_stats/records?perPage=${perPage}&sort=-created&filter=${filter}`)) as {
          items?: { created: string; stats: RawStats }[];
        };
        // The API returns newest first (because of the limit), the chart wants chronological order.
        return (body.items ?? []).map((r) => toSample(r.created, r.stats ?? {})).reverse();
      };
      for (const t of [type, ...finer]) {
        const rows = await fetchType(t);
        if (rows.length > 0) return rows;
      }
      return [];
    },
  };
}
