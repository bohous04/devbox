// 5-field cron (min hour dom mon dow), local time. The tick runs every minute → no
// library/DST logic is needed. Unknown/invalid expression → never matches.
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1; let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) { step = Number(part.slice(slash + 1)); range = part.slice(0, slash); if (!Number.isInteger(step) || step < 1) return null; }
    let lo: number; let hi: number;
    if (range === "*") { lo = min; hi = max; }
    else if (range.includes("-")) { const [a, b] = range.split("-"); lo = Number(a); hi = Number(b); }
    else { lo = Number(range); hi = lo; }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

export function validCron(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  return f.length === 5 && f.every((field, i) => parseField(field, RANGES[i][0], RANGES[i][1]) !== null);
}

export function cronMatch(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [minS, hoS, domS, moS, dowS] = f.map((field, i) => parseField(field, RANGES[i][0], RANGES[i][1]));
  if (!minS || !hoS || !domS || !moS || !dowS) return false;
  if (!minS.has(d.getMinutes()) || !hoS.has(d.getHours()) || !moS.has(d.getMonth() + 1)) return false;
  const domStar = f[2] === "*"; const dowStar = f[4] === "*";
  const domOk = domS.has(d.getDate()); const dowOk = dowS.has(d.getDay());
  if (domStar && dowStar) return true;
  if (domStar) return dowOk;
  if (dowStar) return domOk;
  return domOk || dowOk; // both restricted → union (standard cron)
}
