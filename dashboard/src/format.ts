export function bytes(n: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}
export function czCurrency(usd: number): string { return `$${usd.toFixed(2)}`; }
export function stateBadge(s: "working" | "waiting" | "idle"): string {
  return s === "working" ? "working" : s === "waiting" ? "waiting" : "idle";
}
export function daysLeftLabel(d: number | null): string {
  return d === null ? "plenty of space" : `~${Math.round(d)} days`;
}

/** State label without the emoji (the UI renders its own LED). */
export function stateLabel(s: "working" | "waiting" | "idle"): string {
  return s === "working" ? "working" : s === "waiting" ? "waiting" : "idle";
}

/** Clamped percentage 0–100 of part/total; 0 when total is 0. */
export function pctOf(part: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}

/** "42 %" (rounded). */
export function czPercent(p: number): string {
  return `${Math.round(p)} %`;
}

/** Integer with thousands separators (commas): 1,234,567. */
export function czInt(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.round(Math.abs(n)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    out += digits[i];
    const fromEnd = digits.length - 1 - i;
    if (fromEnd > 0 && fromEnd % 3 === 0) out += ",";
  }
  return sign + out;
}

function trimmed(v: number): string {
  const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Compact number: 534 · 12.5 k · 1.2 M · 2.4 B. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return sign + String(Math.round(abs));
  if (abs < 1_000_000) return `${sign}${trimmed(abs / 1000)} k`;
  if (abs < 1_000_000_000) return `${sign}${trimmed(abs / 1_000_000)} M`;
  return `${sign}${trimmed(abs / 1_000_000_000)} B`;
}

/** Duration in ms → "45 s" · "12 min" · "2 h 14 min" · "26 h" · "3 d 4 h". */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const rem = min % 60;
    return rem && h < 10 ? `${h} h ${rem} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d} d ${remH} h` : `${d} d`;
}

/** Elapsed ms → "3 s ago" · "12 min ago" · "2 h ago" · "3 d ago". */
export function agoLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Hours as decimal → "6.4 h". */
export function czHours(h: number): string {
  return `${h.toFixed(1)} h`;
}
