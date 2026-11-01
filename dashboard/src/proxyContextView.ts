// Logic of the "Model context windows" section, separate from the component — the dashboard has no
// component tests, the pure function is tested instead (same as openrouterView and co.).

export interface ProxyContextRow {
  key: string;
  label: string;
  override: number | null;
  effective: number | null;
  source: "manual" | "default" | "catalog" | "unknown";
}

/** Field input: an integer, or a k/M shorthand as cc writes it in its docs (`950k`, `1M`).
 *  Garbage → null; Save is then not offered at all, instead of saving something other
 *  than what the person typed. */
export function parseTokens(input: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(input);
  if (!m) return null;
  const mult = m[2] === "" ? 1 : m[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
  const v = Math.round(Number(m[1]) * mult);
  return v > 0 ? v : null;
}

export function formatTokens(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

/** Where the value comes from — manual/default/catalog are fixed in different places and ways. "unknown"
 *  has to reveal the consequence (cc assumes 200k), not just state that it is unknown. */
export function sourceHint(row: ProxyContextRow): string {
  switch (row.source) {
    case "manual": return "manual override";
    case "default": return "1M default — real window unknown";
    case "catalog": return "auto from the OpenRouter catalog";
    case "unknown": return "unknown — Claude Code assumes 200k";
  }
}
