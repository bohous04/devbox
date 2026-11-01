// Uptime Kuma via Prometheus `/metrics` (Basic auth, empty user name + API key as the
// password). Kuma has no REST API for reading monitor state — `/metrics` is the only way
// to get at it without a websocket into the UI. The parser is pure; networking is separate.

export interface Monitor {
  id: string;
  name: string;
  type: string;              // http | port | dns | push | …
  url: string | null;
  hostname: string | null;
  tag: string | null;        // Kuma exports tags as a label WITHOUT a value (PROD="")
  up: boolean;
  uptime1d: number | null;   // 0–1
  uptime30d: number | null;
  uptime365d: number | null;
  responseMs: number | null;
  certDaysLeft: number | null;
}

// Labels Kuma puts on every metric. Anything extra is a user tag.
const KNOWN_LABELS = new Set(["monitor_id", "monitor_name", "monitor_type", "monitor_url", "monitor_hostname", "monitor_port", "window"]);
const LABEL_RE = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
const LINE_RE = /^([a-z_]+)\{(.*)\}\s+(\S+)\s*$/;

/** Sample value. Kuma sends "Nan" (also "NaN"/"+Inf") where it has not measured the metric yet. */
function sampleValue(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Response time: Kuma gives -1 for monitors that have none (push, group). That is not "−1 ms". */
const responseValue = (v: number | null): number | null => (v !== null && v >= 0 ? v : null);

function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(raw)) !== null) out[m[1]] = m[2].replace(/\\(.)/g, "$1");
  return out;
}

/** Kuma writes "null" as a string, not empty — for url/hostname it means "don't have one". */
const orNull = (v: string | undefined): string | null => (v && v !== "null" && v !== "https://" ? v : null);

/**
 * Parses Kuma's Prometheus exposition format into one record per monitor.
 *
 * Groups (`monitor_type="group"`) are discarded — they are just a wrapper over other monitors
 * and in the list of websites they would look like another website.
 */
export function parseKumaMetrics(text: string): Monitor[] {
  const byId = new Map<string, Monitor>();
  const touch = (labels: Record<string, string>): Monitor | null => {
    const id = labels.monitor_id;
    if (!id || labels.monitor_type === "group") return null;
    let m = byId.get(id);
    if (!m) {
      const tag = Object.keys(labels).find((k) => !KNOWN_LABELS.has(k)) ?? null;
      m = {
        id, name: labels.monitor_name ?? id, type: labels.monitor_type ?? "unknown",
        url: orNull(labels.monitor_url), hostname: orNull(labels.monitor_hostname), tag,
        up: false, uptime1d: null, uptime30d: null, uptime365d: null, responseMs: null, certDaysLeft: null,
      };
      byId.set(id, m);
    }
    return m;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const parsed = LINE_RE.exec(line);
    if (!parsed) continue;
    const [, metric, labelBlob, rawValue] = parsed;
    if (!metric.startsWith("monitor_")) continue;              // nodejs_*/app_version are not of interest
    const labels = parseLabels(labelBlob);
    const m = touch(labels);
    if (!m) continue;
    const value = sampleValue(rawValue);
    switch (metric) {
      case "monitor_status": m.up = value === 1; break;
      case "monitor_uptime_ratio":
        if (labels.window === "1d") m.uptime1d = value;
        else if (labels.window === "30d") m.uptime30d = value;
        else if (labels.window === "365d") m.uptime365d = value;
        break;
      // Kuma exposes both: `_seconds` (newer) and the bare `monitor_response_time` in ms.
      // We take the 1d seconds window so the numbers do not mix units; the bare one only as a fallback.
      case "monitor_response_time_seconds": {
        const ms = responseValue(value);
        if (labels.window === "1d" && ms !== null) m.responseMs = Math.round(ms * 1000);
        break;
      }
      case "monitor_response_time": {
        const ms = responseValue(value);
        if (m.responseMs === null && ms !== null) m.responseMs = Math.round(ms);
        break;
      }
      case "monitor_cert_days_remaining": m.certDaysLeft = value; break;
    }
  }
  // Stable order: down monitors on top, then by tag and name — so the list does not
  // reshuffle on every poll.
  return [...byId.values()].sort((a, b) =>
    Number(a.up) - Number(b.up) || (a.tag ?? "").localeCompare(b.tag ?? "") || a.name.localeCompare(b.name));
}

export interface KumaConfig { url: string; apiKey: string }

/** Fetches and parses monitors. `fetchImpl` for tests. */
export async function fetchMonitors(cfg: KumaConfig, fetchImpl: typeof fetch = fetch): Promise<Monitor[]> {
  const auth = Buffer.from(`:${cfg.apiKey}`).toString("base64");
  const res = await fetchImpl(`${cfg.url.replace(/\/$/, "")}/metrics`, { headers: { authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`kuma /metrics returned ${res.status}`);
  return parseKumaMetrics(await res.text());
}
