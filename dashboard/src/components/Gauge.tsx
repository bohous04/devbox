import { motion, useReducedMotion } from "framer-motion";
import { czPercent } from "../format";

export type Severity = "ok" | "warn" | "danger";

export function diskSeverity(pct: number, warnPct = 80): Severity {
  if (pct >= 92) return "danger";
  if (pct >= warnPct) return "warn";
  return "ok";
}

const SWEEP = 270; // degrees
const START = -135;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [sx, sy] = polar(cx, cy, r, a0);
  const [ex, ey] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

const SEV_TEXT: Record<Severity, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

/** 270° instrument arc with tick marks. `pct` 0–100. */
export function Gauge({ pct, size = 220, severity = "ok", children }: {
  pct: number;
  size?: number;
  severity?: Severity;
  children?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const frac = Math.min(100, Math.max(0, pct)) / 100;
  const cx = 100, cy = 100, r = 78;
  const track = arcPath(cx, cy, r, START, START + SWEEP);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const deg = START + SWEEP * t;
    const [x1, y1] = polar(cx, cy, r - 13, deg);
    const [x2, y2] = polar(cx, cy, r - 18, deg);
    return { x1, y1, x2, y2, key: t };
  });

  return (
    <div className="flex flex-col items-center gap-1" style={{ position: "relative", width: size }}>
      <svg viewBox="0 0 200 168" width={size} height={size * 0.84} role="img" aria-label={`Filled ${czPercent(pct)}`}>
        <path d={track} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={11} strokeLinecap="round" className={SEV_TEXT[severity]} />
        {frac > 0 && (
          <motion.path
            d={track}
            fill="none"
            stroke="currentColor"
            strokeWidth={11}
            strokeLinecap="round"
            className={SEV_TEXT[severity]}
            initial={reduced ? false : { pathLength: 0.001 }}
            animate={{ pathLength: frac }}
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 60, damping: 18 }}
          />
        )}
        {ticks.map((t) => (
          <line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke="var(--border)" strokeWidth={1.5} />
        ))}
      </svg>
      <div style={{
        position: "absolute", left: "13%", right: "13%", top: "47%",
        transform: "translateY(-50%)", textAlign: "center",
      }}>
        {children}
      </div>
    </div>
  );
}
