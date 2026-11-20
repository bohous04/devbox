import type { ThreadEffort } from "./thread";

/** Every reasoning effort level devd and the apps accept: Claude Code's EffortLevel (low … max) and the levels the
 *  Codex app-server's model/list names (also none, minimal, ultra). A level outside this list never reaches the
 *  bridge, the thread store or the UI: a new one is added here first. */
export const KNOWN_EFFORT_LEVELS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export const isKnownEffort = (v: unknown): v is string => typeof v === "string" && KNOWN_EFFORT_LEVELS.includes(v);

const MAX_MODEL_LENGTH = 128;

/** A bridge's effort.state (or what devd stored of one) as devd keeps and serves it, whatever its shape: a model id
 *  of at most 128 characters, only known levels (each once), anything else as not known. `dropped` says what went,
 *  shortened, for the caller to log. */
export function parseEffortState(raw: unknown): { effort: ThreadEffort; dropped: string[] } {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const dropped: string[] = [];
  const shown = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : Array.isArray(v) ? "an array" : typeof v);
  const level = (field: string, v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (isKnownEffort(v)) return v;
    dropped.push(`${field} ${shown(v)}`);
    return null;
  };
  let model: string | null = null;
  if (typeof r.model === "string" && r.model.length <= MAX_MODEL_LENGTH) model = r.model;
  else if (r.model !== null && r.model !== undefined) dropped.push(`model ${shown(r.model)}`);
  let supported: string[] | null = null;
  if (Array.isArray(r.supported)) {
    supported = [];
    for (const v of r.supported) {
      const l = level("supported", v);
      if (l !== null && !supported.includes(l)) supported.push(l);
    }
  } else if (r.supported !== null && r.supported !== undefined) dropped.push(`supported ${shown(r.supported)}`);
  return { effort: { model, supported, effective: level("effective", r.effective), chosen: level("chosen", r.chosen) }, dropped };
}
