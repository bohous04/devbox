export interface CriticReview {
  id: number; session_id: string; turn_id: string; round: number;
  verdict: "ok" | "issues" | "error"; findings: string; evidence: string | null;
  ms: number; at: number;
}
export interface CriticFinding {
  severity: "critical" | "important" | "minor";
  file?: string; line?: number; what: string; why?: string;
}

function parseFindings(raw: string): CriticFinding[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as CriticFinding[]).filter((f) => f && typeof f.what === "string") : [];
  } catch { return []; }        // broken JSON must not crash the card
}

/** Blocking = what the critic considers broken; minor does not count (see blockingFindings). */
function blocking(r: CriticReview): CriticFinding[] {
  return parseFindings(r.findings).filter((f) => f.severity === "critical" || f.severity === "important");
}

export function criticBadge(r: CriticReview | null): { text: string; kind: "ok" | "warn" | "danger" } | null {
  if (!r) return null;
  if (r.verdict === "error") return { text: "Critic failed", kind: "danger" };
  const n = blocking(r).length;
  if (n === 0) return { text: "Review passed", kind: "ok" };
  return { text: `${n} ${n === 1 ? "issue" : "issues"}`, kind: "warn" };
}

export function findingLines(r: CriticReview): string[] {
  return parseFindings(r.findings).map((f) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : "";
    return `${where}${f.what}${f.why ? ` (${f.why})` : ""}`;
  });
}
